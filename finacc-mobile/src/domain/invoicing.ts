/**
 * invoicing.ts — آلة حالات الفاتورة الكاملة (SRS 5.4-2 / قرار 2 + §4 الوحدة 02).
 *
 * الملزم المنفَّذ هنا:
 *  - الذرّية (5.4-4): كل مسار كتابة داخل adapter.transaction واحدة — المستند + البنود +
 *    حركات المخزون + حركات الصندوق + استهلاك docseq — فشل أي خطوة يرجع الكل.
 *  - docseq (5.4-1): الرقم يُستهلك داخل نفس المعاملة؛ المسودة لا تستهلك رقماً (قرار 2)
 *    ويُستهلك عند التحويل فقط.
 *  - آلة الحالات (5.4-2): completed/cash→رقم+حركة صندوق+خصم؛ credit→دين؛ mixed→جزء جزء؛
 *    draft→بلا رقم/بلا أثر؛ convert→رقم الآن+تحقق الرصيد وقت التحويل؛ void→حركات معاكسة.
 *  - الحسابات كلها Decimal بدقة 4dp (مبالغ) / 3dp (كميات) / 6dp (أسعار) — لا Float (5.2-3).
 *  - **اصطلاح العملات (موثق)**: حقول الفاتورة (subtotal/discount/tax/total/paid/due) بعملة
 *    الفاتورة؛ total_base = total × rate بالعملة الأساسية؛ وكل حقول التكاليف
 *    (invoice_item.line_cost وinvoice.cost_total وstock_movement.unit_cost وproduct.cost_price/WAC)
 *    **بالعملة الأساسية** (تعليق DDL) — فاتورة شراء بعملة أجنبية تُحوَّل تكلفتها الفعّالة
 *    إلى الأساس بسعر يوم الشراء قبل خلط WAC (AC-03: «التكلفة سُجّلت بسعر يوم الشراء»).
 *  - WAC (5.4-3): خصم رأس الشراء يوزَّع على البنود نسبةً لقيمتها قبل تحديث WAC.
 *  - منع السالب المخزوني (قرار 9) عبر applyMovement برسالة تسمّي الصنف والنقص (FR-02-18).
 *  - السعر Snapshot على المستند (FR-08-05) مع rate_is_fallback (قرار 3 / FR-02-20).
 *  - الحرس الزمني: assertPeriodOpen + حد التأريخ الرجعي (5.4-11 / FR-02-19) + قيد audit.
 *
 * نقاء الوحدة: adapter + decimal.js + zod + وحدات domain شقيقة (NFR-09/11).
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { cmp, d, f3, f4, isDecimalString, roundTo, sumD } from '../utils/money';
import { Decimal } from '../utils/money';
import {
  BackdateConfirmationRequiredError,
  DomainRuleError,
  InvoiceStateError,
  ValidationError,
} from './errors';
import { nextDocNo } from './docseq';
import { assertPeriodOpen, isBackdateBeyondLimit } from './fiscal';
import { getDatingPolicy, getInvoicingSettings } from './settings';
import { resolveRate } from './currency';
import { applyMovement, computeWac, getStockLevel, updateProductCost } from './inventory';
import type { MovementType } from './inventory';

/* ============================ المخططات (زود) ============================ */

/** نص رقم أكبر من صفر */
const DecPos = (msg: string) =>
  z
    .string()
    .refine((s) => isDecimalString(s) && d(s).gt(0), { message: msg });

/** نص رقم غير سالب */
const DecNonNeg = (msg: string) =>
  z
    .string()
    .refine((s) => isDecimalString(s) && d(s).gte(0), { message: msg });

const Pct = (msg: string) =>
  z
    .string()
    .refine((s) => isDecimalString(s) && d(s).gte(0) && cmp(s, '100') <= 0, { message: msg });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** بند فاتورة: صنف أو سطر خدمة حرة (قرار 5 — productId NULLable مع وصف) */
export const LineInputSchema = z
  .object({
    productId: z.number().int().positive().nullable(),
    lineDesc: z.string().trim().min(1, 'وصف سطر الخدمة الحرة مطلوب').optional(),
    qty: DecPos('الكمية يجب أن تكون رقماً أكبر من الصفر'),
    unitPrice: DecNonNeg('سعر الوحدة يجب أن يكون رقماً غير سالب'),
    discountPercent: Pct('نسبة الخصم يجب أن تكون بين 0 و100').optional(),
    discountAmount: DecNonNeg('مبلغ الخصم يجب أن يكون رقماً غير سالب').optional(),
    taxPercent: Pct('نسبة الضريبة يجب أن تكون بين 0 و100').optional(),
  })
  .superRefine((l, ctx) => {
    if (l.productId === null && !l.lineDesc) {
      ctx.addIssue({
        code: 'custom',
        message: 'سطر بلا صنف يتطلب وصفاً (lineDesc) — قرار 5 للخدمات الحرة',
      });
    }
  });

export type LineInput = z.infer<typeof LineInputSchema>;

/** مدخل حفظ فاتورة (بيع/شراء + مسودة) — المرتجعات عبر createLinkedReturn */
export const SaveInvoiceInputSchema = z
  .object({
    docType: z.enum(['sale', 'purchase', 'sale_return', 'purchase_return']),
    payStatus: z.enum(['cash', 'credit', 'mixed']),
    status: z.enum(['draft', 'completed']).default('completed'),
    issuedAt: z.string().regex(ISO_DATE, 'تاريخ غير صالح (المتوقع YYYY-MM-DD)'),
    customerId: z.number().int().positive().optional(),
    supplierId: z.number().int().positive().optional(),
    originalInvoiceId: z.number().int().positive().optional(),
    dueDate: z.string().regex(ISO_DATE, 'تاريخ استحقاق غير صالح (YYYY-MM-DD)').optional(),
    cashboxId: z.number().int().positive().optional(),
    warehouseId: z.number().int().positive(),
    currencyId: z.number().int().positive(),
    lines: z.array(LineInputSchema).min(1, 'الفاتورة تتطلب بنداً واحداً على الأقل'),
    discountAmount: DecNonNeg('خصم الفاتورة يجب أن يكون رقماً غير سالب').optional(),
    taxRate: Pct('نسبة الضريبة يجب أن تكون بين 0 و100').optional(),
    paidAmount: DecPos('المبلغ المدفوع يجب أن يكون رقماً أكبر من الصفر').optional(),
    notesInternal: z.string().optional(),
    notesPrinted: z.string().optional(),
  })
  .superRefine((inv, ctx) => {
    if (inv.payStatus === 'mixed' && inv.paidAmount === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'الدفع المختلط يتطلب تحديد المبلغ المدفوع (paidAmount)',
      });
    }
    if (
      (inv.docType === 'sale_return' || inv.docType === 'purchase_return') &&
      inv.originalInvoiceId === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'المرتجع يتطلب فاتورة أصلية (originalInvoiceId) — FR-02-07',
      });
    }
  });

/**
 * نوع المدخل (قبل الافتراضيات) — status اختياري عند النداء (الافتراضي 'completed')
 * بينما الناتج بعد parse يحمله دائماً.
 */
export type SaveInvoiceInput = z.input<typeof SaveInvoiceInputSchema>;

/** اتجاه إرجاع المبلغ في المرتجع المرتبط (FR-02-07) */
export type ReturnPayDirection = 'cash' | 'account';

export interface LinkedReturnInput {
  docType: 'sale_return' | 'purchase_return';
  originalInvoiceId: number;
  issuedAt: string;
  /** نقدي من الصندوق أو على حساب الطرف */
  returnPayDirection: ReturnPayDirection;
  warehouseId: number;
  /** يجب أن تطابق عملة الفاتورة الأصلية */
  currencyId: number;
  lines: LineInput[];
  cashboxId?: number;
  discountAmount?: string;
  taxRate?: string;
  dueDate?: string;
  notesInternal?: string;
  notesPrinted?: string;
}

/* ==================== الحساب الخالص (يُختبر مباشرة §10.2) ==================== */

export type TaxMode = 'per_item' | 'on_total';

/** البنود المحسوبة — تُخزَّن قيمها في invoice_item */
export interface ComputedLine {
  index: number;
  productId: number | null;
  lineDesc: string | null;
  qty: Decimal;
  unitPrice: Decimal;
  discountPercent: Decimal;
  discountAmount: Decimal;
  taxPercent: Decimal;
  /** qty × unitPrice مقربة 4dp */
  lineGross: Decimal;
  /** خصم البند (نسبة + مبلغ، مجموعهما مقيداً بقيمة البند) */
  lineDiscount: Decimal;
  /** lineGross − lineDiscount */
  lineNet: Decimal;
  /** ضريبة البند (وضع per_item فقط) */
  lineTax: Decimal;
  /** lineNet + lineTax (per_item) أو lineNet (on_total) */
  lineTotal: Decimal;
}

export interface InvoiceTotals {
  lines: ComputedLine[];
  /** Σ lineGross */
  subtotal: Decimal;
  /** Σ خصومات البنود */
  linesDiscount: Decimal;
  /** خصم رأس الفاتورة (المدخل) */
  invoiceDiscount: Decimal;
  /** Σ lineNet − invoiceDiscount */
  taxableBase: Decimal;
  taxRate: Decimal;
  taxAmount: Decimal;
  /** taxableBase + taxAmount */
  total: Decimal;
}

function computeLine(l: LineInput, index: number, taxMode: TaxMode): ComputedLine {
  const qty = d(l.qty);
  const unitPrice = d(l.unitPrice);
  const gross = roundTo(qty.times(unitPrice), 4);
  const pct = d(l.discountPercent ?? '0');
  const amt = d(l.discountAmount ?? '0');
  const pctAmt = roundTo(gross.times(pct).div(100), 4);
  const raw = pctAmt.plus(amt);
  const lineDiscount = raw.gt(gross) ? gross : raw;
  const lineNet = gross.minus(lineDiscount);
  const taxPct = d(l.taxPercent ?? '0');
  const lineTax = taxMode === 'per_item' ? roundTo(lineNet.times(taxPct).div(100), 4) : new Decimal(0);
  return {
    index,
    productId: l.productId,
    lineDesc: l.lineDesc ?? null,
    qty,
    unitPrice,
    discountPercent: pct,
    discountAmount: amt,
    taxPercent: taxPct,
    lineGross: gross,
    lineDiscount,
    lineNet,
    lineTax,
    lineTotal: lineNet.plus(lineTax),
  };
}

/**
 * يحسب مجاميع الفاتورة (دالة نقية — FR-02-04/05):
 *  - خصم البند: نسبة + مبلغ، مجموعهما مقيداً بقيمة البند.
 *  - taxableBase = Σ lineNet − خصم الفاتورة — **منع صافي ≤ 0** (FR-02-05).
 *  - الضريبة: on_total على القاعدة الصافية بنسبة (taxRate ?? نسبة الشركة)؛
 *    per_item على صافي كل بند بنسبته.
 * المتطابقة المحفوظة: total = subtotal − (linesDiscount + invoiceDiscount) + taxAmount.
 */
export function computeInvoiceTotals(
  input: { lines: LineInput[]; discountAmount?: string; taxRate?: string },
  taxMode: TaxMode,
  companyTaxRate: string,
): InvoiceTotals {
  const lines = input.lines.map((l, i) => computeLine(l, i, taxMode));
  const subtotal = roundTo(sumD(lines.map((l) => l.lineGross)), 4);
  const linesDiscount = roundTo(sumD(lines.map((l) => l.lineDiscount)), 4);
  const invoiceDiscount = roundTo(input.discountAmount ?? '0', 4);
  const sumNet = sumD(lines.map((l) => l.lineNet));
  const taxableBase = sumNet.minus(invoiceDiscount);
  if (taxableBase.lte(0)) {
    throw new ValidationError(
      'صافي الفاتورة بعد الخصم لا يمكن أن يكون صفراً أو أقل — خفّض الخصم أو احذف البنود المجانية',
    );
  }
  const taxRate = input.taxRate !== undefined ? d(input.taxRate) : d(companyTaxRate);
  const taxAmount =
    taxMode === 'on_total'
      ? roundTo(taxableBase.times(taxRate).div(100), 4)
      : roundTo(sumD(lines.map((l) => l.lineTax)), 4);
  const total = taxableBase.plus(taxAmount);
  if (total.lte(0)) {
    throw new ValidationError('إجمالي الفاتورة يجب أن يكون أكبر من الصفر');
  }
  return { lines, subtotal, linesDiscount, invoiceDiscount, taxableBase, taxRate, taxAmount, total };
}

/**
 * يوزّع خصم رأس الفاتورة على البنود نسبةً لقيمتها الصافية (SRS 5.4-3 — قبل تحديث WAC).
 * البند الأخير يحمل فروق التقريب حتى يكون مجموع الأسهم = الخصم بالضبط.
 */
export function distributeInvoiceDiscount(
  lines: ComputedLine[],
  invoiceDiscount: string | number | Decimal,
): Decimal[] {
  const invDisc = d(invoiceDiscount);
  const n = lines.length;
  if (n === 0 || invDisc.lte(0)) return lines.map(() => new Decimal(0));
  const sumNet = sumD(lines.map((l) => l.lineNet));
  if (sumNet.lte(0)) return lines.map(() => new Decimal(0));
  const shares: Decimal[] = [];
  let allocated = new Decimal(0);
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      const lastShare = invDisc.minus(allocated);
      shares.push(lastShare.lt(0) ? new Decimal(0) : lastShare);
    } else {
      const share = roundTo(lines[i]!.lineNet.times(invDisc).div(sumNet), 4);
      shares.push(share);
      allocated = allocated.plus(share);
    }
  }
  return shares;
}

/* ============================ صفوف القاعدة ============================ */

export interface CompanyRow {
  id: number;
  currency_id: number;
  tax_rate: string;
  invoice_prefix: string | null;
}

export interface ProductRow {
  id: number;
  name: string;
  cost_price: string;
  is_service: number;
}

export interface InvoiceRow {
  id: number;
  invoice_no: string | null;
  doc_type: string;
  pay_status: string;
  status: string;
  issued_at: string;
  converted_at: string | null;
  original_invoice_id: number | null;
  due_date: string | null;
  customer_id: number | null;
  supplier_id: number | null;
  cashbox_id: number | null;
  warehouse_id: number;
  currency_id: number;
  exchange_rate: string;
  rate_is_fallback: number;
  subtotal: string;
  discount_amount: string;
  tax_rate: string;
  tax_amount: string;
  total: string;
  total_base: string;
  paid_amount: string;
  due_amount: string;
  cost_total: string;
  notes_internal: string | null;
  notes_printed: string | null;
}

export interface InvoiceItemRow {
  id: number;
  invoice_id: number;
  product_id: number | null;
  line_desc: string | null;
  qty: string;
  unit_factor: string;
  unit_price: string;
  discount_percent: string;
  discount_amount: string;
  tax_percent: string;
  line_total: string;
  line_cost: string;
}

async function getCompany(adapter: SqliteAdapter): Promise<CompanyRow> {
  const rows = await adapter.all<CompanyRow>(
    'SELECT id, currency_id, tax_rate, invoice_prefix FROM company ORDER BY id LIMIT 1',
  );
  if (!rows[0]) {
    throw new DomainRuleError(
      'COMPANY_NOT_SETUP',
      'بيانات المخزن غير مهيأة — أكمل الإعداد الأول (الشركة والعملة الأساسية) قبل حفظ المستندات',
    );
  }
  return rows[0];
}

async function fetchProducts(
  adapter: SqliteAdapter,
  lines: LineInput[],
): Promise<Map<number, ProductRow>> {
  const ids = Array.from(
    new Set(lines.map((l) => l.productId).filter((id): id is number => id !== null)),
  );
  const map = new Map<number, ProductRow>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await adapter.all<ProductRow>(
    `SELECT id, name, cost_price, is_service FROM product WHERE id IN (${placeholders})`,
    ids,
  );
  for (const r of rows) map.set(Number(r.id), r);
  return map;
}

async function assertProductExists(lines: LineInput[], products: Map<number, ProductRow>): Promise<void> {
  for (const l of lines) {
    if (l.productId !== null && !products.get(l.productId)) {
      throw new DomainRuleError('PRODUCT_NOT_FOUND', `صنف غير موجود (معرّف ${l.productId})`);
    }
  }
}

async function assertPartyExists(
  adapter: SqliteAdapter,
  table: 'customer' | 'supplier',
  id: number | undefined,
): Promise<void> {
  if (id === undefined) return;
  const rows = await adapter.all<{ id: number }>(`SELECT id FROM ${table} WHERE id = ?`, [id]);
  if (!rows[0]) {
    throw new DomainRuleError(
      'PARTY_NOT_FOUND',
      `${table === 'customer' ? 'العميل' : 'المورّد'} غير موجود (معرّف ${id})`,
    );
  }
}

async function assertCashboxExists(adapter: SqliteAdapter, id: number | undefined): Promise<void> {
  if (id === undefined) return;
  const rows = await adapter.all<{ id: number }>('SELECT id FROM cashbox WHERE id = ?', [id]);
  if (!rows[0]) {
    throw new DomainRuleError('CASHBOX_NOT_FOUND', `الصندوق غير موجود (معرّف ${id})`);
  }
}

async function audit(
  adapter: SqliteAdapter,
  action: string,
  entity: string,
  entityId: number,
  details: Record<string, unknown>,
  userId?: number,
): Promise<void> {
  // دفاعي: user_id له FK إلى app_user — لا نُدخله إلا لصرْف موجود
  let uid: number | null = null;
  if (userId !== undefined && userId !== null) {
    const rows = await adapter.all<{ id: number }>('SELECT id FROM app_user WHERE id = ?', [userId]);
    uid = rows[0] ? Number(rows[0].id) : null;
  }
  await adapter.run(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details, at) VALUES (?, ?, ?, ?, ?, ?)',
    [uid, action, entity, entityId, JSON.stringify(details), new Date().toISOString()],
  );
}

/* ==================== تكلفة البنود (بالعملة الأساسية) ==================== */

/**
 * تكلفة سطر مخزني للبيع: qty × WAC الحالي (Snapshot لحظة البيع — 5.4-3)
 * + حارس هامش الربح عند تفعيل discount_below_margin=block (FR-02-05).
 */
function saleLineCost(
  line: ComputedLine,
  product: ProductRow,
  rate: Decimal,
  marginBlock: boolean,
): Decimal {
  const qtyCost = roundTo(line.qty.times(d(product.cost_price)), 4);
  if (marginBlock) {
    // التكلفة بعملة الفاتورة: cost_base / rate
    const unitCostCcy = d(product.cost_price).div(rate);
    if (line.lineNet.lt(roundTo(line.qty.times(unitCostCcy), 4))) {
      throw new DomainRuleError(
        'DISCOUNT_BELOW_MARGIN',
        `الخصم في الصنف «${product.name}» ينزل تحت تكلفته — خفّض الخصم أو راجع إعداد منع الخصم تحت الهامش`,
      );
    }
  }
  return qtyCost;
}

/** تكلفة سطر شراء فعّالة بعد توزيع خصم الرأس pro-rata (5.4-3) — بالعملة الأساسية */
function purchaseLineCost(
  line: ComputedLine,
  invDiscShare: Decimal,
  rate: Decimal,
): { lineCostBase: Decimal; unitCostBase: Decimal } {
  const effectiveCcy = line.lineNet.minus(invDiscShare);
  const lineCostBase = roundTo(effectiveCcy.times(rate), 4);
  const unitCostBase = roundTo(effectiveCcy.div(line.qty).times(rate), 4);
  return { lineCostBase, unitCostBase };
}

/* ============================ الحفظ ============================ */

export interface SaveInvoiceOpts {
  /** تأكيد المدير للتأريخ الرجعي > الحد (يُسجَّل قيد audit دائماً عند التأكيد) */
  confirmBackdate?: boolean;
  createdBy?: number;
}

export interface SaveInvoiceResult {
  invoiceId: number;
  /** NULL للمسودة (لا رقم — قرار 2) */
  invoiceNo: string | null;
}

/**
 * يحفظ فاتورة بيع/شراء (completed أو draft) داخل Transaction ذرّية واحدة (5.4-4).
 * المرتجعات المرتبطة تُنشأ حصراً عبر createLinkedReturn (FR-02-07).
 */
export async function saveInvoice(
  adapter: SqliteAdapter,
  input: SaveInvoiceInput,
  opts: SaveInvoiceOpts = {},
): Promise<SaveInvoiceResult> {
  return adapter.transaction(async () => {
    // 1) التحقق زود → ValidationError عربية
    const parsed = SaveInvoiceInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات الفاتورة غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inv = parsed.data;
    if (inv.docType === 'sale_return' || inv.docType === 'purchase_return') {
      throw new DomainRuleError(
        'RETURNS_NEED_LINK',
        'مرتجعات البيع/الشراء تُنشأ عبر createLinkedReturn المرتبطة بفاتورة أصلية (FR-02-07)',
      );
    }

    // 2) + 3) الحرس الزمني: الفترات المقفلة + التأريخ الرجعي
    const backdated = await applyDateGuards(adapter, inv.issuedAt, opts.confirmBackdate);

    // 4) سعر الصرف Snapshot (قرار 3) — حتى للمسودة
    const { rate: rateStr, rateIsFallback } = await resolveRate(adapter, inv.currencyId, inv.issuedAt);
    const rate = d(rateStr);

    // 5) الشركة + الإعدادات + الأصناف
    const company = await getCompany(adapter);
    const { taxMode, discountBelowMargin } = await getInvoicingSettings(adapter);
    const products = await fetchProducts(adapter, inv.lines);
    await assertProductExists(inv.lines, products);
    await assertPartyExists(adapter, inv.docType === 'sale' ? 'customer' : 'supplier', inv.docType === 'sale' ? inv.customerId : inv.supplierId);
    await assertCashboxExists(adapter, inv.cashboxId);

    // 6) المجاميع + تكلفة البنود
    const totals = computeInvoiceTotals(inv, taxMode, company.tax_rate);
    const invDiscShares = distributeInvoiceDiscount(totals.lines, totals.invoiceDiscount);

    const lineCosts = new Map<number, Decimal>(); // index → lineCost (أساس)
    const unitCosts = new Map<number, Decimal>(); // index → unitCost (أساس) للشراء
    for (const l of totals.lines) {
      if (l.productId === null) continue;
      const p = products.get(l.productId)!;
      if (Number(p.is_service) === 1) continue;
      if (inv.docType === 'sale') {
        lineCosts.set(l.index, saleLineCost(l, p, rate, discountBelowMargin === 'block'));
      } else {
        const { lineCostBase, unitCostBase } = purchaseLineCost(l, invDiscShares[l.index] ?? new Decimal(0), rate);
        lineCosts.set(l.index, lineCostBase);
        unitCosts.set(l.index, unitCostBase);
      }
    }
    const costTotal = roundTo(sumD([...lineCosts.values()]), 4);

    // الدفع: نقدي كامل / آجل صفر / مختلط جزء (تحقق الحدود)
    let paidAmount = new Decimal(0);
    if (inv.status === 'completed') {
      if ((inv.payStatus === 'cash' || inv.payStatus === 'mixed') && inv.cashboxId === undefined) {
        throw new ValidationError('الحفظ النقدي/المختلط يتطلب اختيار الصندوق (cashboxId)');
      }
      if (inv.payStatus === 'cash') {
        paidAmount = totals.total;
      } else if (inv.payStatus === 'mixed') {
        const p = d(inv.paidAmount!);
        if (p.lte(0) || p.gte(totals.total)) {
          throw new ValidationError(
            `المبلغ المدفوع يجب أن يكون أكبر من الصفر وأقل من إجمالي الفاتورة (${f4(totals.total)})`,
          );
        }
        paidAmount = roundTo(p, 4);
      }
    }
    const dueAmount = inv.status === 'completed' ? totals.total.minus(paidAmount) : new Decimal(0);

    // ============ مسار المسودة (draft): بلا رقم/بلا أثر (قرار 2) ============
    const nowIso = new Date().toISOString();
    if (inv.status === 'draft') {
      const rows = await adapter.all<{ id: number }>(
        `INSERT INTO invoice
           (invoice_no, doc_type, pay_status, status, issued_at, due_date, customer_id, supplier_id,
            cashbox_id, warehouse_id, currency_id, exchange_rate, rate_is_fallback,
            subtotal, discount_amount, tax_rate, tax_amount, total, total_base,
            paid_amount, due_amount, cost_total, notes_internal, notes_printed, created_at, updated_at, created_by)
         VALUES (NULL, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        [
          inv.docType,
          inv.payStatus,
          inv.issuedAt,
          inv.dueDate ?? null,
          inv.docType === 'sale' ? inv.customerId ?? null : null,
          inv.docType === 'purchase' ? inv.supplierId ?? null : null,
          inv.cashboxId ?? null,
          inv.warehouseId,
          inv.currencyId,
          rateStr,
          rateIsFallback,
          f4(totals.subtotal),
          f4(totals.linesDiscount.plus(totals.invoiceDiscount)),
          f4(totals.taxRate),
          f4(totals.taxAmount),
          f4(totals.total),
          f4(roundTo(totals.total.times(rate), 4)),
          f4(costTotal),
          inv.notesInternal ?? null,
          inv.notesPrinted ?? null,
          nowIso,
          nowIso,
          opts.createdBy ?? null,
        ],
      );
      const invoiceId = Number(rows[0]!.id);
      await insertItems(adapter, invoiceId, totals.lines, lineCosts, nowIso);
      return { invoiceId, invoiceNo: null };
    }

    // ============ المسار المكتمل: docseq + المستند + البنود + المخزون + الصندوق ============
    // 7) الرقم — استهلاك داخل نفس المعاملة (5.4-1)
    const prefix =
      inv.docType === 'sale' ? (company.invoice_prefix ?? 'INV') : inv.docType === 'purchase' ? 'PUR' : '';
    const invoiceNo = await nextDocNo(adapter, inv.docType === 'sale' ? 'INV' : 'PUR', inv.issuedAt, prefix);

    const rows = await adapter.all<{ id: number }>(
      `INSERT INTO invoice
         (invoice_no, doc_type, pay_status, status, issued_at, due_date, customer_id, supplier_id,
          cashbox_id, warehouse_id, currency_id, exchange_rate, rate_is_fallback,
          subtotal, discount_amount, tax_rate, tax_amount, total, total_base,
          paid_amount, due_amount, cost_total, notes_internal, notes_printed, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [
        invoiceNo,
        inv.docType,
        inv.payStatus,
        inv.issuedAt,
        inv.dueDate ?? null,
        inv.docType === 'sale' ? inv.customerId ?? null : null,
        inv.docType === 'purchase' ? inv.supplierId ?? null : null,
        inv.cashboxId ?? null,
        inv.warehouseId,
        inv.currencyId,
        rateStr,
        rateIsFallback,
        f4(totals.subtotal),
        f4(totals.linesDiscount.plus(totals.invoiceDiscount)),
        f4(totals.taxRate),
        f4(totals.taxAmount),
        f4(totals.total),
        f4(roundTo(totals.total.times(rate), 4)),
        f4(paidAmount),
        f4(dueAmount),
        f4(costTotal),
        inv.notesInternal ?? null,
        inv.notesPrinted ?? null,
        nowIso,
        nowIso,
        opts.createdBy ?? null,
      ],
    );
    const invoiceId = Number(rows[0]!.id);

    // البنود
    await insertItems(adapter, invoiceId, totals.lines, lineCosts, nowIso);

    // أثر المخزون (لا شيء للمسودة — هنا مكتمل فقط) — 5.4-3/5.4-5
    await applyStockEffects({
      adapter,
      docType: inv.docType,
      lines: totals.lines,
      products,
      warehouseId: inv.warehouseId,
      issuedAt: inv.issuedAt,
      refType: 'invoice',
      refId: invoiceId,
      createdBy: opts.createdBy,
      unitCosts,
    });

    // أثر الصندوق (completed فقط) — 5.4-2
    await applyCashEffects({
      adapter,
      docType: inv.docType,
      payStatus: inv.payStatus,
      cashboxId: inv.cashboxId,
      currencyId: inv.currencyId,
      rateStr,
      txDate: inv.issuedAt,
      refId: invoiceId,
      amount: inv.payStatus === 'cash' ? totals.total : paidAmount,
      invoiceNo,
      customerId: inv.docType === 'sale' ? inv.customerId ?? null : null,
      supplierId: inv.docType === 'purchase' ? inv.supplierId ?? null : null,
      createdBy: opts.createdBy,
    });

    // قيد audit للتأريخ الرجعي المؤكد (FR-02-19) — دائماً عند الحفظ المؤكد
    if (backdated) {
      await audit(adapter, 'backdate', 'invoice', invoiceId, { invoiceNo, issuedAt: inv.issuedAt }, opts.createdBy);
    }

    return { invoiceId, invoiceNo };
  });
}

/** الحرس الزمني المشترك: فترة مقفلة → رفض قاطع؛ رجعي > الحد بلا تأكيد → طلب تأكيد */
async function applyDateGuards(
  adapter: SqliteAdapter,
  issuedAt: string,
  confirmBackdate: boolean | undefined,
): Promise<boolean> {
  await assertPeriodOpen(adapter, issuedAt);
  const { maxBackdateDays } = await getDatingPolicy(adapter);
  const beyond = await isBackdateBeyondLimit(adapter, issuedAt, maxBackdateDays);
  if (beyond && !confirmBackdate) {
    throw new BackdateConfirmationRequiredError(issuedAt, maxBackdateDays);
  }
  return beyond;
}

async function insertItems(
  adapter: SqliteAdapter,
  invoiceId: number,
  lines: ComputedLine[],
  lineCosts: Map<number, Decimal>,
  nowIso: string,
): Promise<void> {
  for (const l of lines) {
    await adapter.run(
      `INSERT INTO invoice_item
         (invoice_id, product_id, line_desc, qty, unit_id, unit_factor, unit_price,
          discount_percent, discount_amount, tax_percent, line_total, line_cost, created_at)
       VALUES (?, ?, ?, ?, NULL, '1', ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId,
        l.productId,
        l.lineDesc,
        f3(l.qty),
        f4(l.unitPrice),
        f4(l.discountPercent),
        f4(l.discountAmount),
        f4(l.taxPercent),
        f4(l.lineTotal),
        f4(lineCosts.get(l.index) ?? new Decimal(0)),
        nowIso,
      ],
    );
  }
}

/* ==================== آثار المخزون والصندوق (مشتركة) ==================== */

interface StockEffectsArgs {
  adapter: SqliteAdapter;
  docType: 'sale' | 'purchase' | 'sale_return' | 'purchase_return';
  lines: ComputedLine[];
  products: Map<number, ProductRow>;
  warehouseId: number;
  issuedAt: string;
  refType: string;
  refId: number;
  createdBy?: number;
  unitCosts: Map<number, Decimal>;
}

/**
 * آثار المخزون للمستند المكتمل:
 *  - بيع: صادر بالتكلفة الحالية (WAC) — لا تغيير للتكلفة (5.4-3).
 *  - شراء: وارد بتكلفة فعّالة (بعد توزيع خصم الرأس) بالعملة الأساسية + مزج WAC.
 */
async function applyStockEffects(args: StockEffectsArgs): Promise<void> {
  const { adapter, docType, lines, products, warehouseId, issuedAt, refType, refId, createdBy, unitCosts } = args;
  if (docType === 'sale') {
    for (const l of lines) {
      if (l.productId === null) continue;
      const p = products.get(l.productId)!;
      if (Number(p.is_service) === 1) continue; // الخدمي بلا أثر مخزوني (قرار 5)
      await applyMovement(adapter, {
        productId: l.productId,
        warehouseId,
        movementType: 'sale',
        qty: l.qty.neg(),
        unitCost: d(p.cost_price),
        refType,
        refId,
        movedAt: issuedAt,
        createdBy,
      });
    }
  } else if (docType === 'purchase') {
    for (const l of lines) {
      if (l.productId === null) continue;
      const p = products.get(l.productId)!;
      if (Number(p.is_service) === 1) continue;
      const unitCostBase = unitCosts.get(l.index)!;
      // مزج WAC فوق الرصيد والتكلفة الحاليين (بنود متتابعة لنفس الصنف تُخلط تباعاً)
      const oldQty = await getStockLevel(adapter, l.productId, warehouseId);
      const oldCost = d(products.get(l.productId)!.cost_price);
      await applyMovement(adapter, {
        productId: l.productId,
        warehouseId,
        movementType: 'purchase',
        qty: l.qty,
        unitCost: unitCostBase,
        refType,
        refId,
        movedAt: issuedAt,
        createdBy,
      });
      const newWac = computeWac(oldQty, oldCost, l.qty, unitCostBase);
      await updateProductCost(adapter, l.productId, newWac);
      // تحديث الخريطة المحلية حتى تمزج البنود التالية لنفس الصنف على الجديد
      products.set(l.productId, { ...p, cost_price: f4(newWac) });
    }
  }
}

interface CashEffectsArgs {
  adapter: SqliteAdapter;
  docType: 'sale' | 'purchase';
  payStatus: 'cash' | 'credit' | 'mixed';
  cashboxId?: number;
  currencyId: number;
  rateStr: string;
  txDate: string;
  refType?: string;
  refId: number;
  amount: Decimal;
  invoiceNo: string;
  customerId?: number | null;
  supplierId?: number | null;
  createdBy?: number;
}

/** آثار الصندوق: نقدي/مختلط فقط — آجل بلا حركة (5.4-2) */
async function applyCashEffects(args: CashEffectsArgs): Promise<void> {
  const { adapter, docType, payStatus, cashboxId, currencyId, rateStr, txDate, refType, refId, amount, invoiceNo, customerId, supplierId, createdBy } = args;
  if (payStatus === 'credit') return;
  if (amount.lte(0)) return; // جزء نقدي صفري (نظرياً محال بعد التحقق)
  const isSale = docType === 'sale';
  const desc = isSale
    ? payStatus === 'mixed'
      ? `تحصيل جزئي لفاتورة ${invoiceNo}`
      : `تحصيل فاتورة ${invoiceNo}`
    : payStatus === 'mixed'
      ? `دفع جزئي لفاتورة شراء ${invoiceNo}`
      : `دفع فاتورة شراء ${invoiceNo}`;
  await adapter.run(
    `INSERT INTO cash_tx
       (tx_type, cashbox_id, currency_id, amount, exchange_rate, tx_date,
        ref_type, ref_id, customer_id, supplier_id, is_voided, reversal_of, description, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
    [
      isSale ? 'receipt' : 'payment',
      cashboxId!,
      currencyId,
      f4(amount),
      rateStr,
      txDate,
      refType ?? 'invoice',
      refId,
      customerId ?? null,
      supplierId ?? null,
      desc,
      new Date().toISOString(),
      createdBy ?? null,
    ],
  );
}

/* ==================== تحويل المسودة (FR-02-18) ==================== */

export interface ConvertDraftOpts {
  confirmBackdate?: boolean;
  /** افتراضياً اليوم — issued_at عند التحويل = تاريخ التحويل (قرار 2) */
  issuedAt?: string;
  payStatus?: 'cash' | 'credit' | 'mixed';
  paidAmount?: string;
  cashboxId?: number;
  createdBy?: number;
}

/**
 * يحوّل مسودة إلى فاتورة مكتملة داخل Transaction ذرّية واحدة:
 * استهلاك الرقم الآن + إعادة حساب المجاميع والتكاليف بالتكلفة الحالية +
 * التحقق من الرصيد المتاح **وقت التحويل** (رفض بتسمية الصنف والكمية الناقصة)
 * + آثار المخزون والصندوق (FR-02-18 / قرار 2).
 */
export async function convertDraft(
  adapter: SqliteAdapter,
  draftId: number,
  opts: ConvertDraftOpts = {},
): Promise<SaveInvoiceResult> {
  return adapter.transaction(async () => {
    const invoice = await loadInvoice(adapter, draftId);
    if (invoice.status !== 'draft') {
      throw new InvoiceStateError('هذه الفاتورة ليست مسودة — لا يمكن تحويلها');
    }
    if (invoice.doc_type !== 'sale' && invoice.doc_type !== 'purchase') {
      throw new InvoiceStateError('تحويل المسودة متاح لفواتير البيع والشراء فقط');
    }

    const issuedAt = opts.issuedAt ?? new Date().toISOString().slice(0, 10);
    const backdated = await applyDateGuards(adapter, issuedAt, opts.confirmBackdate);

    // السعر يُحل من جديد بتاريخ التحويل (التحويل = إصدار جديد — قرار 2)
    const { rate: rateStr, rateIsFallback } = await resolveRate(adapter, invoice.currency_id, issuedAt);
    const rate = d(rateStr);

    const company = await getCompany(adapter);
    const { taxMode } = await getInvoicingSettings(adapter);

    // إعادة بناء البنود من المخزنة
    const items = await loadItems(adapter, draftId);
    const lines: LineInput[] = items.map((it) => ({
      productId: it.product_id,
      lineDesc: it.line_desc ?? undefined,
      qty: it.qty,
      unitPrice: it.unit_price,
      discountPercent: it.discount_percent,
      discountAmount: it.discount_amount,
      taxPercent: it.tax_percent,
    }));
    const products = await fetchProducts(adapter, lines);
    await assertProductExists(lines, products);

    // خصم الرأس المخزّن = إجمالي الخصم − خصومات البنود المحسوبة من مدخلاتها
    const recomputed = computeInvoiceTotals({ lines }, taxMode, company.tax_rate);
    const storedDisc = d(invoice.discount_amount);
    const headerDisc = storedDisc.minus(recomputed.linesDiscount);
    const invInput = {
      ...invoice,
      lines,
      discountAmount: headerDisc.gt(0) ? headerDisc.toFixed(4) : '0',
      // نسبة ضريبة الرأس محفوظة من زمن المسودة (Snapshot) — تُحافظ عند التحويل
      taxRate: invoice.tax_rate,
    };
    const totals = computeInvoiceTotals(invInput, taxMode, company.tax_rate);
    const invDiscShares = distributeInvoiceDiscount(totals.lines, totals.invoiceDiscount);

    const payStatus = opts.payStatus ?? (invoice.pay_status as 'cash' | 'credit' | 'mixed');
    const cashboxId = opts.cashboxId ?? invoice.cashbox_id ?? undefined;
    if ((payStatus === 'cash' || payStatus === 'mixed') && cashboxId === undefined) {
      throw new ValidationError('الحفظ النقدي/المختلط يتطلب اختيار الصندوق (cashboxId)');
    }
    await assertCashboxExists(adapter, cashboxId);

    let paidAmount = new Decimal(0);
    if (payStatus === 'cash') {
      paidAmount = totals.total;
    } else if (payStatus === 'mixed') {
      if (opts.paidAmount === undefined) {
        throw new ValidationError('الدفع المختلط يتطلب تحديد المبلغ المدفوع (paidAmount)');
      }
      const p = d(opts.paidAmount);
      if (p.lte(0) || p.gte(totals.total)) {
        throw new ValidationError(
          `المبلغ المدفوع يجب أن يكون أكبر من الصفر وأقل من إجمالي الفاتورة (${f4(totals.total)})`,
        );
      }
      paidAmount = roundTo(p, 4);
    }
    const dueAmount = totals.total.minus(paidAmount);

    // التكاليف بالتكلفة الحالية (قد تغيّرت منذ الإنشاء)
    const lineCosts = new Map<number, Decimal>();
    const unitCosts = new Map<number, Decimal>();
    for (const l of totals.lines) {
      if (l.productId === null) continue;
      const p = products.get(l.productId)!;
      if (Number(p.is_service) === 1) continue;
      if (invoice.doc_type === 'sale') {
        lineCosts.set(l.index, roundTo(l.qty.times(d(p.cost_price)), 4));
      } else {
        const { lineCostBase, unitCostBase } = purchaseLineCost(
          l,
          invDiscShares[l.index] ?? new Decimal(0),
          rate,
        );
        lineCosts.set(l.index, lineCostBase);
        unitCosts.set(l.index, unitCostBase);
      }
    }
    const costTotal = roundTo(sumD([...lineCosts.values()]), 4);

    // الرقم يُستهلك الآن (قرار 2)
    const prefix =
      invoice.doc_type === 'sale'
        ? (company.invoice_prefix ?? 'INV')
        : 'PUR';
    const invoiceNo = await nextDocNo(adapter, invoice.doc_type === 'sale' ? 'INV' : 'PUR', issuedAt, prefix);

    const nowIso = new Date().toISOString();
    await adapter.run(
      `UPDATE invoice SET
         status = 'completed', invoice_no = ?, issued_at = ?, converted_at = ?, pay_status = ?,
         cashbox_id = ?, exchange_rate = ?, rate_is_fallback = ?,
         subtotal = ?, discount_amount = ?, tax_rate = ?, tax_amount = ?, total = ?, total_base = ?,
         paid_amount = ?, due_amount = ?, cost_total = ?, updated_at = ?
       WHERE id = ?`,
      [
        invoiceNo,
        issuedAt,
        nowIso,
        payStatus,
        cashboxId ?? null,
        rateStr,
        rateIsFallback,
        f4(totals.subtotal),
        f4(totals.linesDiscount.plus(totals.invoiceDiscount)),
        f4(totals.taxRate),
        f4(totals.taxAmount),
        f4(totals.total),
        f4(roundTo(totals.total.times(rate), 4)),
        f4(paidAmount),
        f4(dueAmount),
        f4(costTotal),
        nowIso,
        draftId,
      ],
    );

    // تحديث البنود: line_total وline_cost بالقيم المحسوبة الآن
    for (const l of totals.lines) {
      const it = items[l.index]!;
      await adapter.run(
        'UPDATE invoice_item SET line_total = ?, line_cost = ? WHERE id = ?',
        [f4(l.lineTotal), f4(lineCosts.get(l.index) ?? new Decimal(0)), it.id],
      );
    }

    // التحقق من الرصيد وقت التحويل + الخصم + آثار الصندوق (ذرات معاملة واحدة)
    await applyStockEffects({
      adapter,
      docType: invoice.doc_type,
      lines: totals.lines,
      products,
      warehouseId: invoice.warehouse_id,
      issuedAt,
      refType: 'invoice',
      refId: draftId,
      createdBy: opts.createdBy,
      unitCosts,
    });
    await applyCashEffects({
      adapter,
      docType: invoice.doc_type,
      payStatus,
      cashboxId,
      currencyId: invoice.currency_id,
      rateStr,
      txDate: issuedAt,
      refId: draftId,
      amount: payStatus === 'cash' ? totals.total : paidAmount,
      invoiceNo,
      customerId: invoice.doc_type === 'sale' ? invoice.customer_id : null,
      supplierId: invoice.doc_type === 'purchase' ? invoice.supplier_id : null,
      createdBy: opts.createdBy,
    });

    if (backdated) {
      await audit(adapter, 'backdate', 'invoice', draftId, { invoiceNo, issuedAt }, opts.createdBy);
    }

    return { invoiceId: draftId, invoiceNo };
  });
}

/* ==================== الإلغاء (FR-02-15) ==================== */

/**
 * يلغي فاتورة مكتملة: بصلاحية المدير، حركات معاكسة كاملة (لا حذف فيزيائي) +
 * قيد audit. الفاتورة تبقى بحالة void ورقمها لا يُعاد. ممنوع إلغاء فاتورة لها
 * مرتجعات مرتبطة غير ملغاة (تُلغى المرتجعات أولاً).
 */
export async function voidInvoice(
  adapter: SqliteAdapter,
  invoiceId: number,
  opts: { createdBy?: number } = {},
): Promise<void> {
  return adapter.transaction(async () => {
    const invoice = await loadInvoice(adapter, invoiceId);
    if (invoice.status === 'draft') {
      throw new InvoiceStateError('هذه الفاتورة مسودة — حوّلها إلى مكتملة أو احذفها بدل الإلغاء');
    }
    if (invoice.status === 'void') {
      throw new InvoiceStateError('هذه الفاتورة ملغاة سابقاً');
    }

    // لا إلغاء لفاتورة لها مرتجع مرتبط حي (FR-02-15)
    const linked = await adapter.all<{ id: number; invoice_no: string | null }>(
      "SELECT id, invoice_no FROM invoice WHERE original_invoice_id = ? AND status <> 'void'",
      [invoiceId],
    );
    if (linked.length > 0) {
      throw new InvoiceStateError('يوجد مرتجع مرتبط بهذه الفاتورة — ألغِ المرتجع أولاً');
    }

    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);

    await adapter.run("UPDATE invoice SET status = 'void', updated_at = ? WHERE id = ?", [
      nowIso,
      invoiceId,
    ]);

    // حركات مخزون معاكسة: نفس النوع، الكمية معكوسة، نفس التكلفة، مرجع invoice_void
    const movements = await adapter.all<{
      id: number;
      product_id: number;
      warehouse_id: number;
      movement_type: string;
      qty: string;
      unit_cost: string;
    }>(
      "SELECT id, product_id, warehouse_id, movement_type, qty, unit_cost FROM stock_movement WHERE ref_type = 'invoice' AND ref_id = ?",
      [invoiceId],
    );
    for (const m of movements) {
      await applyMovement(adapter, {
        productId: Number(m.product_id),
        warehouseId: Number(m.warehouse_id),
        movementType: m.movement_type as MovementType,
        qty: d(m.qty).neg(),
        unitCost: d(m.unit_cost),
        refType: 'invoice_void',
        refId: invoiceId,
        movedAt: today,
        notes: `إلغاء حركة ${m.id}`,
        createdBy: opts.createdBy,
      });
    }

    // حركات صندوق معاكسة: الأصل is_voided=1 + حركة بنوع معكوس ومبلغ موجب (CHECK > 0)
    // وreversal_of = الأصل (قرار 8 / FR-04-08)
    const cashTxs = await adapter.all<{
      id: number;
      tx_type: string;
      cashbox_id: number;
      currency_id: number;
      amount: string;
      exchange_rate: string;
      customer_id: number | null;
      supplier_id: number | null;
    }>(
      "SELECT id, tx_type, cashbox_id, currency_id, amount, exchange_rate, customer_id, supplier_id FROM cash_tx WHERE ref_type = 'invoice' AND ref_id = ? AND is_voided = 0 AND reversal_of IS NULL",
      [invoiceId],
    );
    for (const tx of cashTxs) {
      await adapter.run('UPDATE cash_tx SET is_voided = 1 WHERE id = ?', [tx.id]);
      await adapter.run(
        `INSERT INTO cash_tx
           (tx_type, cashbox_id, currency_id, amount, exchange_rate, tx_date,
            ref_type, ref_id, customer_id, supplier_id, is_voided, reversal_of, description, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'invoice_void', ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          tx.tx_type === 'receipt' ? 'payment' : 'receipt',
          tx.cashbox_id,
          tx.currency_id,
          f4(tx.amount),
          tx.exchange_rate,
          today,
          invoiceId,
          tx.customer_id,
          tx.supplier_id,
          tx.id,
          `إلغاء فاتورة ${invoice.invoice_no}`,
          nowIso,
          opts.createdBy ?? null,
        ],
      );
    }

    await audit(adapter, 'void_invoice', 'invoice', invoiceId, { invoiceNo: invoice.invoice_no }, opts.createdBy);
  });
}

/* ==================== المرتجع المرتبط (FR-02-07/08 + AC-21) ==================== */

export interface CreateReturnOpts {
  confirmBackdate?: boolean;
  createdBy?: number;
}

/**
 * ينشئ مرتجعاً مرتبطاً بفاتورة أصلية مكتملة (بيع→مرتجع بيع / شراء→مرتجع شراء).
 *  - القيد: مجموع مرتجعات الفاتورة ≤ المباع لكل بند (AC-21).
 *  - مرتجع البيع: يعيد الكمية بتكلفة line_cost الأصلية (لا WAC الجاري — 5.4-3).
 *  - مرتجع الشراء: يخرج بسعر حركة الشراء الأصلية (Snapshot) ويُعاد حساب WAC على المتبقي:
 *    newWac = (oldQty×oldWac − returnQty×origUnitCost) / (oldQty − returnQty) للمتبقي > 0.
 *  - الاتجاه: نقدي من الصندوق (payment للعميل / receipt من المورّد) أو على الحساب.
 */
export async function createLinkedReturn(
  adapter: SqliteAdapter,
  input: LinkedReturnInput,
  opts: CreateReturnOpts = {},
): Promise<SaveInvoiceResult> {
  return adapter.transaction(async () => {
    const parsed = SaveInvoiceInputSchema.safeParse({
      ...input,
      status: 'completed' as const,
      payStatus: input.returnPayDirection === 'cash' ? ('cash' as const) : ('credit' as const),
    });
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات المرتجع غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inv = parsed.data;

    const original = await loadInvoice(adapter, inv.originalInvoiceId!);
    if (original.status !== 'completed') {
      throw new InvoiceStateError('لا يمكن المرتجع لفاتورة ملغاة أو مسودة');
    }
    const isSaleReturn = inv.docType === 'sale_return';
    if (isSaleReturn && original.doc_type !== 'sale') {
      throw new DomainRuleError('RETURN_TYPE_MISMATCH', 'مرتجع البيع يتطلب فاتورة بيع أصلية');
    }
    if (!isSaleReturn && original.doc_type !== 'purchase') {
      throw new DomainRuleError('RETURN_TYPE_MISMATCH', 'مرتجع الشراء يتطلب فاتورة شراء أصلية');
    }
    if (inv.currencyId !== original.currency_id) {
      throw new DomainRuleError(
        'RETURN_CURRENCY_MISMATCH',
        'عملة المرتجع يجب أن تطابق عملة الفاتورة الأصلية (الرصيد لكل عملة على حدة — قرار 8)',
      );
    }

    const backdated = await applyDateGuards(adapter, inv.issuedAt, opts.confirmBackdate);
    const { rate: rateStr, rateIsFallback } = await resolveRate(adapter, inv.currencyId, inv.issuedAt);
    const company = await getCompany(adapter);
    const { taxMode } = await getInvoicingSettings(adapter);

    // بنود الأصل والمرتجعات السابقة غير الملغاة (AC-21)
    const origItems = await loadItems(adapter, original.id);
    const prevReturnRows = await adapter.all<{ product_id: number; qty: string }>(
      `SELECT ii.product_id, ii.qty FROM invoice_item ii
       JOIN invoice i ON i.id = ii.invoice_id
       WHERE i.original_invoice_id = ? AND i.status <> 'void' AND ii.product_id IS NOT NULL`,
      [original.id],
    );
    const returnedByProduct = new Map<number, Decimal>();
    for (const r of prevReturnRows) {
      const pid = Number(r.product_id);
      returnedByProduct.set(pid, (returnedByProduct.get(pid) ?? new Decimal(0)).plus(d(r.qty)));
    }

    const products = await fetchProducts(adapter, inv.lines);
    await assertProductExists(inv.lines, products);

    // التحقق لكل بند: productId مطلوب + ≤ المتبقي القابل للإرجاع (AC-21)
    const origByProduct = new Map<number, { qty: Decimal; cost: Decimal }>();
    for (const it of origItems) {
      if (it.product_id === null) continue;
      const pid = Number(it.product_id);
      const agg = origByProduct.get(pid) ?? { qty: new Decimal(0), cost: new Decimal(0) };
      agg.qty = agg.qty.plus(d(it.qty));
      agg.cost = agg.cost.plus(d(it.line_cost));
      origByProduct.set(pid, agg);
    }
    for (const l of inv.lines) {
      if (l.productId === null) {
        throw new DomainRuleError(
          'RETURN_LINE_NEEDS_PRODUCT',
          'سطر المرتجع يتطلب صنفاً (productId) مطابقاً لفاتورة أصلية',
        );
      }
      const orig = origByProduct.get(l.productId);
      if (!orig || orig.qty.lte(0)) {
        throw new DomainRuleError(
          'RETURN_PRODUCT_NOT_IN_ORIGINAL',
          `الصنف غير موجود في الفاتورة الأصلية (معرّف ${l.productId})`,
        );
      }
      const returned = returnedByProduct.get(l.productId) ?? new Decimal(0);
      const returnable = orig.qty.minus(returned);
      if (d(l.qty).gt(returnable)) {
        const name = products.get(l.productId)?.name ?? `#${l.productId}`;
        throw new DomainRuleError(
          'RETURN_EXCEEDS_REMAINING',
          `كمية المرتجع تتجاوز المتبقي القابل للإرجاع (${f3(returnable)}) للصنف «${name}»`,
        );
      }
    }

    // المجاميع والتكاليف من الأصل
    const totals = computeInvoiceTotals(inv, taxMode, company.tax_rate);

    // تكلفة الوحدة الأصلية لكل صنف:
    //  - مرتجع بيع: متوسط line_cost الأصلي للوحدة (Σ line_cost / Σ qty) — Snapshot 5.4-3
    //  - مرتجع شراء: متوسط موزون لسعر حركة الشراء الأصلية (Snapshot)
    const origUnitCost = new Map<number, Decimal>();
    if (isSaleReturn) {
      for (const [pid, agg] of origByProduct) {
        origUnitCost.set(pid, agg.qty.gt(0) ? agg.cost.div(agg.qty) : new Decimal(0));
      }
    } else {
      const mvRows = await adapter.all<{ product_id: number; qty: string; unit_cost: string }>(
        "SELECT product_id, qty, unit_cost FROM stock_movement WHERE ref_type = 'invoice' AND ref_id = ? AND movement_type = 'purchase'",
        [original.id],
      );
      const aggBy = new Map<number, { qty: Decimal; cost: Decimal }>();
      for (const m of mvRows) {
        const pid = Number(m.product_id);
        const agg = aggBy.get(pid) ?? { qty: new Decimal(0), cost: new Decimal(0) };
        agg.qty = agg.qty.plus(d(m.qty).abs());
        agg.cost = agg.cost.plus(d(m.qty).abs().times(d(m.unit_cost)));
        aggBy.set(pid, agg);
      }
      for (const [pid, agg] of aggBy) {
        origUnitCost.set(pid, agg.qty.gt(0) ? agg.cost.div(agg.qty) : new Decimal(0));
      }
    }

    const lineCosts = new Map<number, Decimal>();
    for (const l of totals.lines) {
      const pid = l.productId!;
      lineCosts.set(l.index, roundTo(l.qty.times(origUnitCost.get(pid) ?? new Decimal(0)), 4));
    }
    const costTotal = roundTo(sumD([...lineCosts.values()]), 4);

    // الرقم SRN/PRN (ملحق د)
    const invoiceNo = await nextDocNo(adapter, isSaleReturn ? 'SRN' : 'PRN', inv.issuedAt, isSaleReturn ? 'SRN' : 'PRN');

    const nowIso = new Date().toISOString();
    // الحساب: المرتجع الآجل يحمل paid=0/due=0 — أثره على رصيد الطرف تستخرجه معادلة
    // كشف الحساب (FR-03-02) من مجموع مرتجعات البيع/الشراء الآجلة، لا من هذا العمود.
    const paidAmount = inv.payStatus === 'cash' ? totals.total : new Decimal(0);
    const dueAmount = new Decimal(0);
    const rows = await adapter.all<{ id: number }>(
      `INSERT INTO invoice
         (invoice_no, doc_type, pay_status, status, issued_at, original_invoice_id, due_date,
          customer_id, supplier_id, cashbox_id, warehouse_id, currency_id, exchange_rate, rate_is_fallback,
          subtotal, discount_amount, tax_rate, tax_amount, total, total_base,
          paid_amount, due_amount, cost_total, notes_internal, notes_printed, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [
        invoiceNo,
        inv.docType,
        inv.payStatus,
        inv.issuedAt,
        original.id,
        inv.dueDate ?? null,
        isSaleReturn ? original.customer_id : null,
        !isSaleReturn ? original.supplier_id : null,
        inv.payStatus === 'cash' ? inv.cashboxId ?? null : null,
        inv.warehouseId,
        inv.currencyId,
        rateStr,
        rateIsFallback,
        f4(totals.subtotal),
        f4(totals.linesDiscount.plus(totals.invoiceDiscount)),
        f4(totals.taxRate),
        f4(totals.taxAmount),
        f4(totals.total),
        f4(roundTo(totals.total.times(d(rateStr)), 4)),
        f4(paidAmount),
        f4(dueAmount),
        f4(costTotal),
        inv.notesInternal ?? null,
        inv.notesPrinted ?? null,
        nowIso,
        nowIso,
        opts.createdBy ?? null,
      ],
    );
    const returnId = Number(rows[0]!.id);
    await insertItems(adapter, returnId, totals.lines, lineCosts, nowIso);

    // أثر المخزون
    for (const l of totals.lines) {
      const pid = l.productId!;
      const p = products.get(pid);
      if (p && Number(p.is_service) === 1) continue; // خدمي: بلا حركة
      const unit = origUnitCost.get(pid) ?? new Decimal(0);
      if (isSaleReturn) {
        // إعادة الكمية بتكلفة line_cost الأصلية — WAC لا يتغير (5.4-3)
        await applyMovement(adapter, {
          productId: pid,
          warehouseId: inv.warehouseId,
          movementType: 'sale_return',
          qty: l.qty,
          unitCost: unit,
          refType: 'invoice',
          refId: returnId,
          movedAt: inv.issuedAt,
          createdBy: opts.createdBy,
        });
      } else {
        // إخراج بسعر حركة الشراء الأصلية + إعادة حساب WAC على المتبقي (5.4-3)
        const oldQty = await getStockLevel(adapter, pid, inv.warehouseId);
        const oldWac = d(products.get(pid)!.cost_price);
        await applyMovement(adapter, {
          productId: pid,
          warehouseId: inv.warehouseId,
          movementType: 'purchase_return',
          qty: l.qty.neg(),
          unitCost: unit,
          refType: 'invoice',
          refId: returnId,
          movedAt: inv.issuedAt,
          createdBy: opts.createdBy,
        });
        const remaining = oldQty.minus(l.qty);
        // الصيغة الموثقة: newWac = (oldQty×oldWac − returnQty×origUnitCost) / (oldQty − returnQty)
        let newWac = oldWac;
        if (remaining.gt(0)) {
          newWac = roundTo(oldQty.times(oldWac).minus(l.qty.times(unit)).div(remaining), 4);
        }
        await updateProductCost(adapter, pid, newWac);
      }
    }

    // اتجاه النقدية: مرتجع بيع نقدي = صرف للعميل؛ مرتجع شراء نقدي = قبض من المورّد
    if (inv.payStatus === 'cash') {
      if (inv.cashboxId === undefined) {
        throw new ValidationError('إرجاع المبلغ نقدياً يتطلب اختيار الصندوق (cashboxId)');
      }
      await adapter.run(
        `INSERT INTO cash_tx
           (tx_type, cashbox_id, currency_id, amount, exchange_rate, tx_date,
            ref_type, ref_id, customer_id, supplier_id, is_voided, reversal_of, description, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'invoice', ?, ?, ?, 0, NULL, ?, ?, ?)`,
        [
          isSaleReturn ? 'payment' : 'receipt',
          inv.cashboxId,
          inv.currencyId,
          f4(totals.total),
          rateStr,
          inv.issuedAt,
          returnId,
          isSaleReturn ? original.customer_id : null,
          !isSaleReturn ? original.supplier_id : null,
          isSaleReturn
            ? `إرجاع نقدي لفاتورة ${original.invoice_no} (مرتجع ${invoiceNo})`
            : `استرداد نقدي لفاتورة شراء ${original.invoice_no} (مرتجع ${invoiceNo})`,
          nowIso,
          opts.createdBy ?? null,
        ],
      );
    }

    await audit(adapter, 'return_create', 'invoice', returnId, { invoiceNo, originalInvoiceNo: original.invoice_no, docType: inv.docType }, opts.createdBy);
    if (backdated) {
      await audit(adapter, 'backdate', 'invoice', returnId, { invoiceNo, issuedAt: inv.issuedAt }, opts.createdBy);
    }

    return { invoiceId: returnId, invoiceNo };
  });
}

/* ==================== حذف المسودة ==================== */

/**
 * يحذف مسودة (المسودة ليست مستنداً — بلا رقم ولا أثر — قرار 2، فحذفها الفيزيائي جائز).
 * المكتملة/الملغاة لا تُحذف — تُلغى void (لا حذف فيزيائي 5.2-2).
 */
export async function deleteDraft(adapter: SqliteAdapter, draftId: number): Promise<void> {
  return adapter.transaction(async () => {
    const invoice = await loadInvoice(adapter, draftId);
    if (invoice.status !== 'draft') {
      throw new InvoiceStateError(
        'يمكن حذف المسودات فقط — الفواتير المكتملة تُلغى (void) ولا تُحذف فيزيائياً',
      );
    }
    await adapter.run('DELETE FROM invoice_item WHERE invoice_id = ?', [draftId]);
    await adapter.run('DELETE FROM invoice WHERE id = ?', [draftId]);
  });
}

/* ==================== قراءة ==================== */

async function loadInvoice(adapter: SqliteAdapter, invoiceId: number): Promise<InvoiceRow> {
  const rows = await adapter.all<InvoiceRow>(
    `SELECT id, invoice_no, doc_type, pay_status, status, issued_at, converted_at,
            original_invoice_id, due_date, customer_id, supplier_id, cashbox_id,
            warehouse_id, currency_id, exchange_rate, rate_is_fallback,
            subtotal, discount_amount, tax_rate, tax_amount, total, total_base,
            paid_amount, due_amount, cost_total, notes_internal, notes_printed
     FROM invoice WHERE id = ?`,
    [invoiceId],
  );
  if (!rows[0]) {
    throw new InvoiceStateError(`فاتورة غير موجودة (معرّف ${invoiceId})`);
  }
  return rows[0];
}

async function loadItems(adapter: SqliteAdapter, invoiceId: number): Promise<InvoiceItemRow[]> {
  return adapter.all<InvoiceItemRow>(
    `SELECT id, invoice_id, product_id, line_desc, qty, unit_factor, unit_price,
            discount_percent, discount_amount, tax_percent, line_total, line_cost
     FROM invoice_item WHERE invoice_id = ? ORDER BY id`,
    [invoiceId],
  );
}

/** قارئ فاتورة ببنودها (للشاشات لاحقاً) */
export async function getInvoiceWithItems(
  adapter: SqliteAdapter,
  invoiceId: number,
): Promise<{ invoice: InvoiceRow; items: InvoiceItemRow[] }> {
  const invoice = await loadInvoice(adapter, invoiceId);
  const items = await loadItems(adapter, invoiceId);
  return { invoice, items };
}
