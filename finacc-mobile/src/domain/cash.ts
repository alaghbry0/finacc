/**
 * cash.ts — سندات النقدية وحركات الصندوق (FR-04-01..10 / قرارات 8 و9 / DDL §5.3).
 *
 * المسؤوليات:
 *  - recordVoucher: سند قبض (تحصيل من عميل) / سند صرف (دفع لمورّد) بتخصيص FIFO عبر
 *    payment_allocation (FR-04-03) والباقي «قبض/دفع على الحساب» ref_type='on_account'.
 *  - فروق الصرف المحققة (FR-08-10 / قرار 8): عند تخصيص السند لفاتورة بعملة مختلفة
 *    عن عملة السند تُثمَّن التسوية بسعر يوم الدفع (settlement_rate الصارم بلا fallback)
 *    ويُخزَّن الفرق مقابل السعر الأصلي للفاتورة في fx_gain_loss — موجب = ربح محقق،
 *    سالب = خسارة (من منظور المنشأة). يظهر بنداً مستقلاً في تقرير الأرباح (لا يُدفن).
 *  - recordExpense (FR-04-05: فئة مصروف إلزامية) / recordOwnerTx (مسحوبات/إيداع مالك)
 *    / recordBoxTransfer (FR-04-07: تحويل بين صندوقين بلقطة سعر لحظة التحويل).
 *  - voidCashTx (FR-04-08): لا حذف ولا تعديل — الأصل is_voided=1 + حركة معاكسة
 *    reversal_of=الأصل (نفس نمط voidInvoice في invoicing.ts) + قيد audit.
 *    تخصيصات السند الملغى لا تُنسخ للحركة المعاكسة؛ استعلامات الأرصدة تستبعد
 *    الصفوف الملغاة (is_voided=1) والمعاكسة (reversal_of NOT NULL) فيُفك التخصيص.
 *  - ensureVoucherNo (FR-04-10): RVT-YYYY-NNNNN / PMT-YYYY-NNNNN عبر docseq؛
 *    يُستهلك عند أول طباعة (تخصيص كسول) للصفوف القديمة (مثل نقدية الفواتير).
 *  - واجهة تركيب الوحدات (FR-14): recordVoucherTx / recordExpenseTx تنفّذان
 *    المنطق نفسه داخل معاملة مفتوحة أصلاً (تستدعيهما وحدة الشيكات داخل
 *    معاملتها الذرّية)، مع تصدير مساعدات القراءة (loadOpenInvoices /
 *    remainingOnInvoice / fifoAllocate / normalizeVoucherRate) — إضافات فقط،
 *    السلوك العام للدوال القائمة لم يتغير.
 *
 * قواعد صارمة:
 *  - كل الحساب بDecimal (لا Float أبداً — 5.2-3): f4 للمال، f6 للأسعار.
 *  - كل كتابة بتاريخ → assertPeriodOpen (5.4-11) داخل نفس المعاملة.
 *  - amount > 0 دائماً (CHECK في DDL) — الاتجاه من tx_type.
 *  - سعر الصرف إدخال إلزامي (قرار 3: لا DEFAULT 1)؛ العملة الأساسية سعرها 1 حصراً.
 *  - سند القبض يخص العملاء (customerId) وسند الصرف يخص الموردين (supplierId).
 *  - الترقيم الذري: nextDocNo داخل معاملة الحفظ (5.4-4) — الرقم لا يُعاد أبداً بعد الإلغاء.
 *
 * نموذج اتجاه الحركة المعاكسة عند الإلغاء (نفس منطق voidInvoice):
 *  receipt↔payment (قلب) · expense→receipt (استرداد) · owner_draw↔capital_in ·
 *  bank_deposit↔bank_withdraw · opening→payment · box_transfer = إلغاء الشطرين معاً.
 *  fx_gain_loss للحركة المعاكسة = سالب الأصل (يُلغى أثر فرق الصرف في الأرباح).
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { cmp, d, f4, f6, isDecimalString, roundTo, sumD, Decimal } from '../utils/money';
import { DomainRuleError, ValidationError } from './errors';
import { assertPeriodOpen } from './fiscal';
import { getRate, resolveRate } from './currency';
import { nextDocNo } from './docseq';

/* ============================ المخططات (زود) ============================ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** نص رقم أكبر من الصفر */
const DecPos = (msg: string) =>
  z.string().refine((s) => isDecimalString(s) && d(s).gt(0), { message: msg });

/** بند تخصيص صريح: المبلغ بعملة الفاتورة نفسها */
export const VoucherAllocationSchema = z.object({
  invoiceId: z.number().int().positive(),
  amount: DecPos('مبلغ التخصيص يجب أن يكون رقماً أكبر من الصفر'),
});
export type VoucherAllocationInput = z.infer<typeof VoucherAllocationSchema>;

export const RecordVoucherInputSchema = z.object({
  txType: z.enum(['receipt', 'payment']),
  cashboxId: z.number().int().positive(),
  currencyId: z.number().int().positive(),
  amount: DecPos('مبلغ السند يجب أن يكون رقماً أكبر من الصفر (DDL: amount > 0)'),
  /** سعر صرف عملة السند Snapshot لحظة الحفظ (قرار 3 — إلزامي، لا افتراضي) */
  exchangeRate: DecPos('سعر صرف عملة السند إلزامي ويجب أن يكون رقماً أكبر من الصفر'),
  txDate: z.string().regex(ISO_DATE, 'تاريخ غير صالح (المتوقع YYYY-MM-DD)'),
  customerId: z.number().int().positive().optional(),
  supplierId: z.number().int().positive().optional(),
  description: z.string().optional(),
  allocations: z.array(VoucherAllocationSchema).optional(),
});
export type RecordVoucherInput = z.input<typeof RecordVoucherInputSchema>;

export const RecordExpenseInputSchema = z.object({
  cashboxId: z.number().int().positive(),
  currencyId: z.number().int().positive(),
  amount: DecPos('مبلغ المصروف يجب أن يكون رقماً أكبر من الصفر'),
  exchangeRate: DecPos('سعر صرف عملة المصروف إلزامي ويجب أن يكون رقماً أكبر من الصفر'),
  txDate: z.string().regex(ISO_DATE, 'تاريخ غير صالح (المتوقع YYYY-MM-DD)'),
  expenseCategoryId: z.number().int().positive(),
  description: z.string().optional(),
});
export type RecordExpenseInput = z.input<typeof RecordExpenseInputSchema>;

export const RecordOwnerTxInputSchema = z.object({
  txKind: z.enum(['owner_draw', 'capital_in']),
  cashboxId: z.number().int().positive(),
  currencyId: z.number().int().positive(),
  amount: DecPos('مبلغ حركة المالك يجب أن يكون رقماً أكبر من الصفر'),
  exchangeRate: DecPos('سعر صرف عملة الحركة إلزامي ويجب أن يكون رقماً أكبر من الصفر'),
  txDate: z.string().regex(ISO_DATE, 'تاريخ غير صالح (المتوقع YYYY-MM-DD)'),
  description: z.string().optional(),
});
export type RecordOwnerTxInput = z.input<typeof RecordOwnerTxInputSchema>;

export const RecordBoxTransferInputSchema = z.object({
  fromCashboxId: z.number().int().positive(),
  toCashboxId: z.number().int().positive(),
  /** المبلغ بعملة صندوق المصدر */
  amount: DecPos('مبلغ التحويل يجب أن يكون رقماً أكبر من الصفر'),
  /** سعر صرف عملة الصندوق المصدر (Snapshot) — إن غاب يُحل بسياسة resolveRate */
  exchangeRate: DecPos('سعر صرف عملة الصندوق المصدر يجب أن يكون رقماً أكبر من الصفر').optional(),
  /** المبلغ الواصل فعلاً بعملة صندوق الوجهة (عملات مختلفة) — إن غاب يُشتق بالسعر */
  toAmount: DecPos('مبلغ الوارد بعملة صندوق الوجهة يجب أن يكون رقماً أكبر من الصفر').optional(),
  txDate: z.string().regex(ISO_DATE, 'تاريخ غير صالح (المتوقع YYYY-MM-DD)'),
  description: z.string().optional(),
});
export type RecordBoxTransferInput = z.input<typeof RecordBoxTransferInputSchema>;

/* ============================ الأنواع ============================ */

/** تخصيص مسجَّل فعلياً في payment_allocation */
export interface RecordedAllocation {
  invoiceId: number;
  invoiceNo: string | null;
  /** بعملة الفاتورة (4dp) */
  allocatedAmount: string;
}

export interface RecordVoucherResult {
  cashTxId: number;
  /** RVT-YYYY-NNNNN / PMT-YYYY-NNNNN — استُهلك لحظة الحفظ (السند نفسه مستند) */
  voucherNo: string;
  allocations: RecordedAllocation[];
  /** الباقي «على الحساب» بعملة السند (4dp) — رصيد دائن للطرف إن تجاوز المستحق */
  onAccountAmount: string;
  /** سعر يوم الدفع لعملة الفاتورة عند التسوية بعملة مختلفة (قرار 8) — وإلا NULL */
  settlementRate: string | null;
  /** فرق الصرف المحقق بالعملة الأساسية (4dp): + ربح / − خسارة */
  fxGainLoss: string;
}

export interface RecordCashTxResult {
  cashTxId: number;
}

export interface RecordBoxTransferResult {
  /** صف الصادر (صندوق المصدر) */
  outCashTxId: number;
  /** صف الوارد (صندوق الوجهة) — ref_type='transfer' + ref_id=الصادر */
  inCashTxId: number;
  /** المبلغ الواصل بعملة صندوق الوجهة (4dp) */
  toAmount: string;
  /** فرق التحويل بالعملة الأساسية (FR-04-07): + ربح / − خسارة */
  fxGainLoss: string;
}

/* ============================ مساعدات داخلية ============================ */

/** صف cash_tx كما يُقرأ من القاعدة (snake_case حرفياً) */
interface CashTxRow {
  id: number;
  tx_type: string;
  cashbox_id: number;
  to_cashbox_id: number | null;
  currency_id: number;
  amount: string;
  exchange_rate: string;
  settlement_rate: string | null;
  fx_gain_loss: string;
  voucher_no: string | null;
  tx_date: string;
  ref_type: string | null;
  ref_id: number | null;
  expense_category_id: number | null;
  customer_id: number | null;
  supplier_id: number | null;
  is_voided: number;
  reversal_of: number | null;
  description: string | null;
}

async function loadCashTx(adapter: SqliteAdapter, id: number): Promise<CashTxRow> {
  const rows = await adapter.all<CashTxRow>('SELECT * FROM cash_tx WHERE id = ?', [id]);
  const row = rows[0];
  if (!row) {
    throw new DomainRuleError('CASH_TX_NOT_FOUND', `حركة الصندوق غير موجودة (معرّف ${id})`);
  }
  return row;
}

async function assertCashboxExists(adapter: SqliteAdapter, id: number): Promise<void> {
  const rows = await adapter.all<{ id: number }>('SELECT id FROM cashbox WHERE id = ?', [id]);
  if (!rows[0]) {
    throw new DomainRuleError('CASHBOX_NOT_FOUND', `الصندوق غير موجود (معرّف ${id}) — تحقق من اختيار الصندوق`);
  }
}

async function assertCurrencyExists(adapter: SqliteAdapter, id: number): Promise<void> {
  const rows = await adapter.all<{ id: number }>('SELECT id FROM currency WHERE id = ?', [id]);
  if (!rows[0]) {
    throw new DomainRuleError('CURRENCY_NOT_FOUND', `العملة غير موجودة (معرّف ${id})`);
  }
}

async function assertPartyExists(
  adapter: SqliteAdapter,
  table: 'customer' | 'supplier',
  id: number,
): Promise<void> {
  const rows = await adapter.all<{ id: number }>(`SELECT id FROM ${table} WHERE id = ?`, [id]);
  if (!rows[0]) {
    throw new DomainRuleError(
      'PARTY_NOT_FOUND',
      `${table === 'customer' ? 'العميل' : 'المورّد'} غير موجود (معرّف ${id})`,
    );
  }
}

/**
 * سعر عملة السند: العملة الأساسية = 1 حصراً (سياسة currency.ts).
 * مُصدَّرة للتركيب بين الوحدات — الشيكات (FR-14) تستخدمها لسعر الشيك.
 */
export async function normalizeVoucherRate(
  adapter: SqliteAdapter,
  currencyId: number,
  exchangeRate: string,
): Promise<Decimal> {
  const baseRows = await adapter.all<{ id: number }>('SELECT id FROM currency WHERE is_base = 1');
  if (baseRows[0] && Number(baseRows[0].id) === currencyId) {
    if (cmp(exchangeRate, '1') !== 0) {
      throw new DomainRuleError(
        'BASE_CURRENCY_RATE_IS_ONE',
        'عملة السند هي العملة الأساسية — سعر صرفها 1 دائماً (لا تُدخل سعراً آخر)',
      );
    }
    return d('1.000000');
  }
  return d(f6(exchangeRate));
}

async function audit(
  adapter: SqliteAdapter,
  action: string,
  entity: string,
  entityId: number,
  details: Record<string, unknown>,
  userId?: number,
): Promise<void> {
  // دفاعي: user_id له FK — لا يُدخل إلا لصرْف موجود
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

/** إدخال cash_tx عام بمعاملات موضعية — is_voided=0 و reversal_of=NULL */
async function insertCashTx(
  adapter: SqliteAdapter,
  fields: {
    txType: string;
    cashboxId: number;
    toCashboxId?: number | null;
    currencyId: number;
    amount: string;
    exchangeRate: string;
    settlementRate?: string | null;
    fxGainLoss?: string;
    voucherNo?: string | null;
    txDate: string;
    refType?: string | null;
    refId?: number | null;
    expenseCategoryId?: number | null;
    customerId?: number | null;
    supplierId?: number | null;
    description?: string | null;
    createdBy?: number;
  },
): Promise<number> {
  const rows = await adapter.all<{ id: number }>(
    `INSERT INTO cash_tx
       (tx_type, cashbox_id, to_cashbox_id, currency_id, amount, exchange_rate,
        settlement_rate, fx_gain_loss, voucher_no, tx_date, ref_type, ref_id,
        expense_category_id, customer_id, supplier_id, is_voided, reversal_of,
        description, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
     RETURNING id`,
    [
      fields.txType,
      fields.cashboxId,
      fields.toCashboxId ?? null,
      fields.currencyId,
      f4(fields.amount),
      f6(fields.exchangeRate),
      fields.settlementRate ?? null,
      fields.fxGainLoss !== undefined ? f4(fields.fxGainLoss) : '0.0000',
      fields.voucherNo ?? null,
      fields.txDate,
      fields.refType ?? null,
      fields.refId ?? null,
      fields.expenseCategoryId ?? null,
      fields.customerId ?? null,
      fields.supplierId ?? null,
      fields.description ?? null,
      new Date().toISOString(),
      fields.createdBy ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

/* ==================== تخصيص المدفوعات (FIFO — FR-04-03) ==================== */

/** فاتورة قابلة للتخصيص */
/** فاتورة قابلة للتخصيص (مُصدَّرة لتركيب الوحدات — FR-14) */
export interface OpenInvoiceRow {
  id: number;
  invoice_no: string | null;
  doc_type: string;
  pay_status: string;
  status: string;
  issued_at: string;
  currency_id: number;
  exchange_rate: string;
  total: string;
  paid_amount: string;
  due_amount: string;
  customer_id: number | null;
  supplier_id: number | null;
}

/** فواتير الطرف المفتوحة الأقدم أولاً (مُصدَّرة للتركيب — FR-14) */
export async function loadOpenInvoices(
  adapter: SqliteAdapter,
  family: 'sale' | 'purchase',
  partyId: number,
): Promise<OpenInvoiceRow[]> {
  const partyCol = family === 'sale' ? 'customer_id' : 'supplier_id';
  return adapter.all<OpenInvoiceRow>(
    `SELECT id, invoice_no, doc_type, pay_status, status, issued_at, currency_id,
            exchange_rate, total, paid_amount, due_amount, customer_id, supplier_id
     FROM invoice
     WHERE doc_type = ? AND status = 'completed' AND ${partyCol} = ?
     ORDER BY issued_at ASC, id ASC`,
    [family, partyId],
  );
}

/** المتبقي القابل للتخصيص = due_amount − Σ تخصيصات سندات حية على الفاتورة (مشتق، لا أعمدة تُحدّث) */
/** المتبقي القابل للتخصيص (مشتق) — مُصدَّر للتركيب (FR-14) */
export async function remainingOnInvoice(
  adapter: SqliteAdapter,
  invoice: OpenInvoiceRow,
  allocationTxType: 'receipt' | 'payment',
): Promise<Decimal> {
  const rows = await adapter.all<{ allocated_amount: string }>(
    `SELECT pa.allocated_amount
     FROM payment_allocation pa
     JOIN cash_tx ct ON ct.id = pa.cash_tx_id
     WHERE pa.invoice_id = ? AND ct.is_voided = 0 AND ct.reversal_of IS NULL
       AND ct.tx_type = ?`,
    [invoice.id, allocationTxType],
  );
  const allocated = sumD(rows.map((r) => r.allocated_amount));
  return d(invoice.due_amount).minus(allocated);
}

/** تخصيص FIFO تلقائي: الأقدم أولاً عبر الفواتير المفتوحة بنفس عملة السند (FR-04-03) */
/** تخصيص FIFO تلقائي: الأقدم أولاً (مُصدَّر للتركيب — FR-14) */
export async function fifoAllocate(
  adapter: SqliteAdapter,
  invoices: OpenInvoiceRow[],
  amount: Decimal,
  allocationTxType: 'receipt' | 'payment',
): Promise<{ invoice: OpenInvoiceRow; amount: Decimal }[]> {
  const out: { invoice: OpenInvoiceRow; amount: Decimal }[] = [];
  let left = amount;
  for (const inv of invoices) {
    if (left.lte(0)) break;
    const remaining = await remainingOnInvoice(adapter, inv, allocationTxType);
    if (remaining.lte(0)) continue;
    const alloc = Decimal.min(left, remaining);
    out.push({ invoice: inv, amount: roundTo(alloc, 4) });
    left = left.minus(alloc);
  }
  return out;
}

/* ==================== سند القبض/الصرف (recordVoucher) ==================== */

/**
 * يسجل سند قبض (تحصيل من عميل) أو سند صرف (دفع لمورّد) داخل Transaction ذرّية:
 *  1) حرس الفترة + التحقق زود + وجود الصندوق/العملة/الطرف.
 *  2) سعر السند: إدخال إلزامي (قرار 3)؛ الأساس = 1 حصراً.
 *  3) التخصيص: صريح إن قُدّم، وإلا FIFO الأقدم أولاً بنفس العملة (FR-04-03).
 *  4) التسوية بعملة مختلفة: settlement_rate = سعر يوم الدفع الصارم (قرار 8)
 *     وfx_gain_loss = فرق السعر الأصلي للفاتورة (موجب ربح/سالب خسارة).
 *  5) الرقم RVT-/PMT- يُستهلك ذرّياً داخل نفس المعاملة (FR-04-10).
 *  6) الباقي بعد الفواتير المفتوحة يبقى «على الحساب» (ref_type='on_account') —
 *     سند واحد يغطي عدة فواتير + قبض حر (إصلاح v1.2).
 */
export async function recordVoucher(
  adapter: SqliteAdapter,
  input: RecordVoucherInput,
  opts: { createdBy?: number } = {},
): Promise<RecordVoucherResult> {
  // الحد العام: المعاملة تُفتح هنا فقط — النواة أدناه قابلة للتركيب (FR-14-03)
  return adapter.transaction(async () => recordVoucherTx(adapter, input, opts));
}

/**
 * نواة recordVoucher داخل معاملة مفتوحة أصلاً (تركيب الوحدات — FR-14-03):
 * وحدة الشيكات (FR-14) تستدعيها داخل معاملتها الذرّية نفسها فيكتمل أثرها
 * وقيد audit معاً أو يرجع الكل رجوعاً واحداً. السلوك العام لم يتغير قط.
 */
export async function recordVoucherTx(
  adapter: SqliteAdapter,
  input: RecordVoucherInput,
  opts: { createdBy?: number } = {},
): Promise<RecordVoucherResult> {
  const parsed = RecordVoucherInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `بيانات السند غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
      parsed.error.issues,
    );
  }
  const inp = parsed.data;

  // سند القبض للعملاء وسند الصرف للموردين (FR-04-02/03)
  if (inp.txType === 'receipt') {
    if (inp.customerId === undefined) {
      throw new DomainRuleError(
        'VOUCHER_PARTY_REQUIRED',
        'سند القبض (التحصيل) يتطلب اختيار العميل (customerId)',
      );
    }
    if (inp.supplierId !== undefined) {
      throw new DomainRuleError(
        'VOUCHER_PARTY_MISMATCH',
        'سند القبض يخص العملاء — استخدم supplierId في سند الصرف للمورّد',
      );
    }
  } else {
    if (inp.supplierId === undefined) {
      throw new DomainRuleError(
        'VOUCHER_PARTY_REQUIRED',
        'سند الصرف (الدفع للمورّد) يتطلب اختيار المورّد (supplierId)',
      );
    }
    if (inp.customerId !== undefined) {
      throw new DomainRuleError(
        'VOUCHER_PARTY_MISMATCH',
        'سند الصرف يخص الموردين — استخدم customerId في سند القبض للعميل',
      );
    }
  }
  const partyId = inp.customerId ?? inp.supplierId!;
  const family: 'sale' | 'purchase' = inp.txType === 'receipt' ? 'sale' : 'purchase';
  const partyTable: 'customer' | 'supplier' =
    inp.txType === 'receipt' ? 'customer' : 'supplier';

  // حرس الفترة (5.4-11) + الأركان
  await assertPeriodOpen(adapter, inp.txDate);
  await assertCashboxExists(adapter, inp.cashboxId);
  await assertCurrencyExists(adapter, inp.currencyId);
  await assertPartyExists(adapter, partyTable, partyId);

  const amount = d(inp.amount);
  const voucherRate = await normalizeVoucherRate(adapter, inp.currencyId, inp.exchangeRate);
  const voucherBase = amount.times(voucherRate); // قيمة السند بالعملة الأساسية

  /* ---------- 3) بناء التخصيصات: صريحة أو FIFO ---------- */
  const chosen: { invoice: OpenInvoiceRow; amount: Decimal }[] = [];
  if (inp.allocations !== undefined && inp.allocations.length > 0) {
    const seen = new Set<number>();
    for (const a of inp.allocations) {
      if (seen.has(a.invoiceId)) {
        throw new DomainRuleError(
          'ALLOCATION_DUPLICATE',
          `تكرار تخصيص لنفس الفاتورة (معرّف ${a.invoiceId}) — دمجهما في بند واحد`,
        );
      }
      seen.add(a.invoiceId);
      const invRows = await adapter.all<OpenInvoiceRow>(
        `SELECT id, invoice_no, doc_type, pay_status, status, issued_at, currency_id,
                exchange_rate, total, paid_amount, due_amount, customer_id, supplier_id
         FROM invoice WHERE id = ?`,
        [a.invoiceId],
      );
      const inv = invRows[0];
      if (!inv) {
        throw new DomainRuleError(
          'INVOICE_NOT_FOUND',
          `الفاتورة غير موجودة (معرّف ${a.invoiceId})`,
        );
      }
      if (inv.doc_type !== family) {
        throw new DomainRuleError(
          'ALLOCATION_FAMILY_MISMATCH',
          inp.txType === 'receipt'
            ? 'لا يُخصص سند القبض إلا لفواتير البيع المفتوحة'
            : 'لا يُخصص سند الصرف إلا لفواتير الشراء المفتوحة',
        );
      }
      const partyCol = family === 'sale' ? inv.customer_id : inv.supplier_id;
      if (Number(partyCol) !== partyId) {
        throw new DomainRuleError(
          'ALLOCATION_PARTY_MISMATCH',
          `الفاتورة ${inv.invoice_no ?? inv.id} تخص طرفاً آخر — اختر فواتير هذا الطرف`,
        );
      }
      if (inv.status !== 'completed') {
        throw new DomainRuleError(
          'ALLOCATION_NOT_OPEN',
          `الفاتورة ${inv.invoice_no ?? inv.id} ليست مفتوحة للتخصيص (مسودة أو ملغاة)`,
        );
      }
      const remaining = await remainingOnInvoice(adapter, inv, inp.txType);
      const alloc = d(a.amount);
      if (alloc.gt(remaining)) {
        throw new DomainRuleError(
          'ALLOCATION_EXCEEDS_REMAINING',
          `مبلغ التخصيص للفاتورة ${inv.invoice_no ?? inv.id} يتجاوز المتبقي (${f4(remaining)}) — خفّض المبلغ أو خصّص المتبقي فقط`,
        );
      }
      chosen.push({ invoice: inv, amount: roundTo(alloc, 4) });
    }
  } else {
    // FIFO: الأقدم أولاً — فواتير الطرف المفتوحة بنفس عملة السند فقط
    const open = await loadOpenInvoices(adapter, family, partyId);
    const sameCcy = open.filter((i) => Number(i.currency_id) === inp.currencyId);
    chosen.push(...(await fifoAllocate(adapter, sameCcy, amount, inp.txType)));
  }

  /* ---------- 4) التسوية بعملة مختلفة + فروق الصرف (قرار 8) ---------- */
  let allocBase = new Decimal(0); // قيمة التخصيصات بالأساس
  let fx = new Decimal(0);
  let settlementRate: Decimal | null = null;
  let settlementCurrency: number | null = null; // عملة فاتورة أجنبية واحدة فقط (عمود واحد)
  for (const { invoice, amount: alloc } of chosen) {
    if (Number(invoice.currency_id) === inp.currencyId) {
      allocBase = allocBase.plus(alloc.times(voucherRate));
      continue; // نفس العملة: لا فرق صرف ولا settlement
    }
    // سعر يوم الدفع لعملة الفاتورة — صارم بلا fallback (قرار 8 / FR-08-10)
    const settle = d(await getRate(adapter, Number(invoice.currency_id), inp.txDate));
    if (settlementRate === null) {
      settlementRate = settle;
      settlementCurrency = Number(invoice.currency_id);
    } else if (settlementCurrency !== Number(invoice.currency_id)) {
      throw new DomainRuleError(
        'ALLOCATION_CURRENCY_MIX',
        'تخصيص السند لفواتير بعملات أجنبية متعددة غير مدعوم في V1 — خصّص بعملة فاتورة واحدة أجنبية',
      );
    } else if (settle.minus(settlementRate).abs().gt(0)) {
      // نظرياً محال: getRate لنفس العملة/التاريخ يعيد نفس السعر
      throw new DomainRuleError(
        'ALLOCATION_SETTLE_MISMATCH',
        'تعارض في سعر يوم الدفع بين بنود التخصيص — راجع التخصيص',
      );
    }
    allocBase = allocBase.plus(alloc.times(settle));
    // الفرق المحقق: التحصيل (+ربح إذا ارتفع السعر) / الدفع (+خسارة إذا ارتفع)
    const diff = alloc.times(settle.minus(d(invoice.exchange_rate)));
    fx = inp.txType === 'receipt' ? fx.plus(diff) : fx.minus(diff);
  }
  if (allocBase.gt(voucherBase)) {
    throw new DomainRuleError(
      'ALLOCATION_EXCEEDS_VOUCHER',
      `مجموع التخصيصات (${f4(allocBase.div(voucherRate))} بعملة السند) يتجاوز مبلغ السند (${f4(amount)}) — زد مبلغ السند أو خفّض التخصيص`,
    );
  }
  const fxGainLoss = roundTo(fx, 4);

  /* ---------- 5) الرقم + الإدخال ---------- */
  const docType = inp.txType === 'receipt' ? 'RVT' : 'PMT';
  const voucherNo = await nextDocNo(adapter, docType, inp.txDate, docType);
  const nowIso = new Date().toISOString();
  const cashTxId = await insertCashTx(adapter, {
    txType: inp.txType,
    cashboxId: inp.cashboxId,
    currencyId: inp.currencyId,
    amount: f4(amount),
    exchangeRate: f6(voucherRate),
    settlementRate: settlementRate !== null ? f6(settlementRate) : null,
    fxGainLoss: f4(fxGainLoss),
    voucherNo,
    txDate: inp.txDate,
    refType: 'on_account', // السند مستند حر؛ الربط بالفواتير في payment_allocation
    description: inp.description ?? (inp.txType === 'receipt' ? 'سند قبض' : 'سند صرف'),
    customerId: inp.customerId ?? null,
    supplierId: inp.supplierId ?? null,
    createdBy: opts.createdBy,
  });

  // بنود التخصيص (payment_allocation) — سند واحد يغطي عدة فواتير
  for (const { invoice, amount: alloc } of chosen) {
    await adapter.run(
      `INSERT INTO payment_allocation (cash_tx_id, invoice_id, allocated_amount, allocated_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [cashTxId, invoice.id, f4(alloc), nowIso, opts.createdBy ?? null],
    );
  }

  return {
    cashTxId,
    voucherNo,
    allocations: chosen.map(({ invoice, amount: alloc }) => ({
      invoiceId: invoice.id,
      invoiceNo: invoice.invoice_no,
      allocatedAmount: f4(alloc),
    })),
    onAccountAmount: f4(roundTo(voucherBase.minus(allocBase).div(voucherRate), 4)),
    settlementRate: settlementRate !== null ? f6(settlementRate) : null,
    fxGainLoss: f4(fxGainLoss),
  };
}

/* ==================== المصروف (FR-04-05) ==================== */

/** يسجل مصروفاً بفئة إلزامية من الصندوق — بديل وحدة الموظفين المؤجلة (ملحق ح) */
export async function recordExpense(
  adapter: SqliteAdapter,
  input: RecordExpenseInput,
  opts: { createdBy?: number } = {},
): Promise<RecordCashTxResult> {
  // الحد العام: المعاملة تُفتح هنا فقط — النواة أدناه قابلة للتركيب (FR-14-04)
  return adapter.transaction(async () => recordExpenseTx(adapter, input, opts));
}

/**
 * نواة recordExpense داخل معاملة مفتوحة أصلاً (تركيب الوحدات — FR-14-04):
 * وحدة الشيكات (FR-14) تستدعيها داخل معاملتها الذرّية نفسها فيكتمل أثرها
 * وقيد audit معاً أو يرجع الكل رجوعاً واحداً. السلوك العام لم يتغير قط.
 */
export async function recordExpenseTx(
  adapter: SqliteAdapter,
  input: RecordExpenseInput,
  opts: { createdBy?: number } = {},
): Promise<RecordCashTxResult> {
  const parsed = RecordExpenseInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `بيانات المصروف غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
      parsed.error.issues,
    );
  }
  const inp = parsed.data;
  await assertPeriodOpen(adapter, inp.txDate);
  await assertCashboxExists(adapter, inp.cashboxId);
  await assertCurrencyExists(adapter, inp.currencyId);

  const catRows = await adapter.all<{ id: number; is_archived: number }>(
    'SELECT id, is_archived FROM expense_category WHERE id = ?',
    [inp.expenseCategoryId],
  );
  const cat = catRows[0];
  if (!cat) {
    throw new DomainRuleError(
      'EXPENSE_CATEGORY_NOT_FOUND',
      `فئة المصروف غير موجودة (معرّف ${inp.expenseCategoryId}) — أنشئ الفئة أولاً`,
    );
  }
  if (Number(cat.is_archived) === 1) {
    throw new DomainRuleError(
      'EXPENSE_CATEGORY_ARCHIVED',
      'فئة المصروف مؤرشفة — اختر فئة نشطة أو أنشئ فئة جديدة',
    );
  }

  const rate = await normalizeVoucherRate(adapter, inp.currencyId, inp.exchangeRate);
  const cashTxId = await insertCashTx(adapter, {
    txType: 'expense',
    cashboxId: inp.cashboxId,
    currencyId: inp.currencyId,
    amount: f4(inp.amount),
    exchangeRate: f6(rate),
    txDate: inp.txDate,
    refType: null, // المرجع في expense_category_id (FR-04-03: مصروف ← فئة مصروف)
    expenseCategoryId: inp.expenseCategoryId,
    description: inp.description ?? 'مصروف',
    createdBy: opts.createdBy,
  });
  return { cashTxId };
}

/* ==================== مسحوبات/إيداع المالك (FR-04-02) ==================== */

/** يسجل حركة مالك: مسحوبات (خارج) أو إيداع رأس مال (وارد) — ليست مصروفاً (AC-19) */
export async function recordOwnerTx(
  adapter: SqliteAdapter,
  input: RecordOwnerTxInput,
  opts: { createdBy?: number } = {},
): Promise<RecordCashTxResult> {
  return adapter.transaction(async () => {
    const parsed = RecordOwnerTxInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات حركة المالك غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inp = parsed.data;
    await assertPeriodOpen(adapter, inp.txDate);
    await assertCashboxExists(adapter, inp.cashboxId);
    await assertCurrencyExists(adapter, inp.currencyId);
    const rate = await normalizeVoucherRate(adapter, inp.currencyId, inp.exchangeRate);
    const cashTxId = await insertCashTx(adapter, {
      txType: inp.txKind,
      cashboxId: inp.cashboxId,
      currencyId: inp.currencyId,
      amount: f4(inp.amount),
      exchangeRate: f6(rate),
      txDate: inp.txDate,
      refType: null,
      description:
        inp.description ?? (inp.txKind === 'owner_draw' ? 'مسحوبات مالك' : 'إيداع مالك'),
      createdBy: opts.createdBy,
    });
    return { cashTxId };
  });
}

/* ==================== التحويل بين صندوقين (FR-04-07) ==================== */

/**
 * تحويل بين صندوقين — صفّان مترابطان (صادر من المصدر + وارد إلى الوجهة عبر
 * ref_type='transfer' + ref_id) لأن لكل صندوق عملته وحركته بعملته:
 *  - نفس العملة: وارد = صادر (fx = 0).
 *  - عملتان مختلفتان: لقطة سعرَي لحظة التحويل لكل عملة؛ المبلغ الوارد إدخال فعلي
 *    (أو مشتق) وfx_gain_loss = قيمة الوارد − قيمة الصادر بالأساس (قرار 8).
 *    يُخزَّن على صف الصادر مع settlement_rate = سعر عملة الوجهة.
 */
export async function recordBoxTransfer(
  adapter: SqliteAdapter,
  input: RecordBoxTransferInput,
  opts: { createdBy?: number } = {},
): Promise<RecordBoxTransferResult> {
  return adapter.transaction(async () => {
    const parsed = RecordBoxTransferInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات التحويل غير صالطة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inp = parsed.data;
    if (inp.fromCashboxId === inp.toCashboxId) {
      throw new DomainRuleError(
        'TRANSFER_SAME_BOX',
        'التحويل داخل نفس الصندوق غير جائز — اختر صندوقين مختلفين',
      );
    }
    await assertPeriodOpen(adapter, inp.txDate);

    const boxes = await adapter.all<{ id: number; currency_id: number; name: string }>(
      'SELECT id, currency_id, name FROM cashbox WHERE id IN (?, ?)',
      [inp.fromCashboxId, inp.toCashboxId],
    );
    const fromBox = boxes.find((b) => Number(b.id) === inp.fromCashboxId);
    const toBox = boxes.find((b) => Number(b.id) === inp.toCashboxId);
    if (!fromBox) {
      throw new DomainRuleError(
        'CASHBOX_NOT_FOUND',
        `صندوق المصدر غير موجود (معرّف ${inp.fromCashboxId})`,
      );
    }
    if (!toBox) {
      throw new DomainRuleError(
        'CASHBOX_NOT_FOUND',
        `صندوق الوجهة غير موجود (معرّف ${inp.toCashboxId})`,
      );
    }

    const amount = d(inp.amount);
    // سعر عملة الصادر: إدخال أو حل بسياسة resolveRate (الأساس = 1، سياسة fallback)
    const fromRate =
      inp.exchangeRate !== undefined
        ? await normalizeVoucherRate(adapter, Number(fromBox.currency_id), inp.exchangeRate)
        : d((await resolveRate(adapter, Number(fromBox.currency_id), inp.txDate)).rate);
    const toRate =
      Number(toBox.currency_id) === Number(fromBox.currency_id)
        ? fromRate
        : d((await resolveRate(adapter, Number(toBox.currency_id), inp.txDate)).rate);

    const cross = Number(toBox.currency_id) !== Number(fromBox.currency_id);
    let toAmount: Decimal;
    let fx = new Decimal(0);
    if (!cross) {
      if (inp.toAmount !== undefined && cmp(inp.toAmount, f4(amount)) !== 0) {
        throw new DomainRuleError(
          'TRANSFER_AMOUNT_MISMATCH',
          'صندوقان بنفس العملة: مبلغ الوارد يجب أن يساوي مبلغ الصادر',
        );
      }
      toAmount = amount;
    } else if (inp.toAmount !== undefined) {
      // المبلغ الواصل فعلاً بعملة الوجهة — الفرق فرق صرف محقق (FR-04-07)
      toAmount = d(inp.toAmount);
      fx = roundTo(toAmount.times(toRate).minus(amount.times(fromRate)), 4);
    } else {
      // مشتق: تحويل دفتري بالقيمة — لا فرق
      toAmount = roundTo(amount.times(fromRate).div(toRate), 4);
    }

    const desc =
      inp.description ?? `تحويل من «${fromBox.name}» إلى «${toBox.name}»`;
    const outCashTxId = await insertCashTx(adapter, {
      txType: 'box_transfer',
      cashboxId: inp.fromCashboxId,
      toCashboxId: inp.toCashboxId,
      currencyId: Number(fromBox.currency_id),
      amount: f4(amount),
      exchangeRate: f6(fromRate),
      settlementRate: cross ? f6(toRate) : null,
      fxGainLoss: f4(fx),
      txDate: inp.txDate,
      refType: 'transfer',
      refId: null,
      description: desc,
      createdBy: opts.createdBy,
    });
    const inCashTxId = await insertCashTx(adapter, {
      txType: 'box_transfer',
      cashboxId: inp.toCashboxId,
      toCashboxId: null,
      currencyId: Number(toBox.currency_id),
      amount: f4(toAmount),
      exchangeRate: f6(toRate),
      txDate: inp.txDate,
      refType: 'transfer',
      refId: outCashTxId,
      description: desc,
      createdBy: opts.createdBy,
    });
    return { outCashTxId, inCashTxId, toAmount: f4(toAmount), fxGainLoss: f4(fx) };
  });
}

/* ==================== الإلغاء بحركة معاكسة (FR-04-08) ==================== */

/** اتجاه الحركة المعاكسة (نفس منطق voidInvoice: قلب الاتجاه) */
const REVERSAL_TX_TYPE: Record<string, string> = {
  receipt: 'payment',
  payment: 'receipt',
  expense: 'receipt', // استرداد المصروف = وارد
  owner_draw: 'capital_in',
  capital_in: 'owner_draw',
  bank_deposit: 'bank_withdraw',
  bank_withdraw: 'bank_deposit',
  opening: 'payment',
  employee_advance: 'receipt',
  commission_payout: 'receipt',
  salary_batch: 'receipt',
};

/**
 * يلغي حركة صندوق: الأصل is_voided=1 + حركة معاكسة reversal_of=الأصل + قيد audit
 * (لا حذف ولا تعديل — FR-04-08). تخصيصات السند لا تُنسخ للمعاكسة؛ الاستعلامات
 * تستبعدها (is_voided=1 على الأصل) فيُفك التخصيص ويُعاد الرصيد. الرقم لا يُعاد.
 * التحويل بين صندوقين يُلغى بشطريه (الصادر والوارد).
 */
export async function voidCashTx(
  adapter: SqliteAdapter,
  id: number,
  opts: { createdBy?: number } = {},
): Promise<void> {
  return adapter.transaction(async () => {
    const tx = await loadCashTx(adapter, id);

    if (Number(tx.is_voided) === 1) {
      throw new DomainRuleError('CASH_TX_ALREADY_VOIDED', 'هذه الحركة ملغاة سابقاً');
    }
    if (tx.reversal_of !== null && tx.reversal_of !== undefined) {
      throw new DomainRuleError(
        'CANNOT_VOID_REVERSAL',
        'هذه حركة معاكسة لا تُلغى — ألغِ الحركة الأصلية التي عكستها',
      );
    }
    if (tx.ref_type === 'invoice' || tx.ref_type === 'invoice_void') {
      throw new DomainRuleError(
        'VOID_SOURCE_DOCUMENT',
        'هذه الحركة تابعة لمستند (فاتورة/مرتجع) — الإلغاء يتم من المستند نفسه لا من الصندوق',
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    await assertPeriodOpen(adapter, today); // الحركة المعاكسة تاريخها اليوم

    // التحويل بين صندوقين: إلغاء الشطرين معاً
    if (tx.tx_type === 'box_transfer') {
      const partner = await findTransferPartner(adapter, tx);
      await voidOne(adapter, tx, today, opts.createdBy);
      if (partner) {
        await voidOne(adapter, partner, today, opts.createdBy);
      }
      await audit(adapter, 'void_cash_tx', 'cash_tx', id, {
        txType: tx.tx_type,
        amount: f4(tx.amount),
        voucherNo: tx.voucher_no,
        pairTxId: partner ? Number(partner.id) : null,
      }, opts.createdBy);
      return;
    }

    await voidOne(adapter, tx, today, opts.createdBy);
    await audit(adapter, 'void_cash_tx', 'cash_tx', id, {
      txType: tx.tx_type,
      amount: f4(tx.amount),
      voucherNo: tx.voucher_no,
      fxGainLoss: f4(tx.fx_gain_loss),
    }, opts.createdBy);
  });
}

/** الشقر الآخر من تحويل: الوارد (ref_id) أو الصادر (من يربط به) — حياً فقط */
async function findTransferPartner(
  adapter: SqliteAdapter,
  tx: CashTxRow,
): Promise<CashTxRow | null> {
  if (tx.ref_type === 'transfer' && tx.ref_id !== null) {
    const rows = await adapter.all<CashTxRow>('SELECT * FROM cash_tx WHERE id = ?', [
      tx.ref_id,
    ]);
    const partner = rows[0];
    if (partner && Number(partner.is_voided) === 1) {
      throw new DomainRuleError(
        'CASH_TX_ALREADY_VOIDED',
        'الشقر الآخر من هذا التحويل ملغى سابقاً — راجع سجل الحركات',
      );
    }
    return partner ?? null;
  }
  if (tx.to_cashbox_id !== null) {
    const rows = await adapter.all<CashTxRow>(
      `SELECT * FROM cash_tx
       WHERE ref_type = 'transfer' AND ref_id = ? AND is_voided = 0 AND reversal_of IS NULL`,
      [tx.id],
    );
    return rows[0] ?? null;
  }
  return null;
}

/** يبطل صفاً واحداً: الأصل is_voided=1 + معاكسة بنفس الأعمدة واتجاه معكوس */
async function voidOne(
  adapter: SqliteAdapter,
  tx: CashTxRow,
  today: string,
  createdBy?: number,
): Promise<void> {
  await adapter.run('UPDATE cash_tx SET is_voided = 1 WHERE id = ?', [tx.id]);
  const reversalType =
    tx.tx_type === 'box_transfer' ? 'box_transfer' : REVERSAL_TX_TYPE[tx.tx_type] ?? 'payment';
  const fxNeg = roundTo(d(tx.fx_gain_loss).neg(), 4);
  const desc =
    tx.voucher_no !== null && tx.voucher_no !== undefined
      ? `إلغاء ${tx.tx_type === 'receipt' ? 'سند قبض' : tx.tx_type === 'payment' ? 'سند صرف' : 'حركة'} ${tx.voucher_no}`
      : `إلغاء حركة صندوق #${tx.id}`;
  await adapter.run(
    `INSERT INTO cash_tx
       (tx_type, cashbox_id, to_cashbox_id, currency_id, amount, exchange_rate,
        settlement_rate, fx_gain_loss, voucher_no, tx_date, ref_type, ref_id,
        expense_category_id, customer_id, supplier_id, is_voided, reversal_of,
        description, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      reversalType,
      tx.cashbox_id,
      tx.to_cashbox_id,
      tx.currency_id,
      f4(tx.amount),
      tx.exchange_rate,
      tx.settlement_rate,
      f4(fxNeg),
      today,
      tx.tx_type === 'box_transfer' ? 'transfer_void' : 'cash_void',
      tx.id,
      tx.expense_category_id,
      tx.customer_id,
      tx.supplier_id,
      tx.id,
      desc,
      new Date().toISOString(),
      createdBy ?? null,
    ],
  );
}

/* ==================== ترقيم السند عند أول طباعة (FR-04-10) ==================== */

/**
 * يعيد رقم السند (RVT-/PMT-) لحركة قبض/صرف — يستهلكه ذرّياً عند أول نداء
 * (أول طباعة) إذا كان voucher_no فارغاً، وإلا يعيد المخزن كما هو (خامل).
 * مخصص للصفوف القديمة (مثل نقدية الفواتير المحفوظة بلا رقم).
 */
export async function ensureVoucherNo(
  adapter: SqliteAdapter,
  cashTxId: number,
  opts: { createdBy?: number } = {},
): Promise<string> {
  return adapter.transaction(async () => {
    const tx = await loadCashTx(adapter, cashTxId);
    if (tx.voucher_no !== null && tx.voucher_no !== undefined) {
      return tx.voucher_no; // خامل: الرقم موجود — لا استهلاك جديد
    }
    if (tx.tx_type !== 'receipt' && tx.tx_type !== 'payment') {
      throw new DomainRuleError(
        'VOUCHER_NO_RECEIPT_PAYMENT_ONLY',
        'ترقيم السندات المطبوعة للقبض والصرف فقط — هذه الحركة من نوع آخر',
      );
    }
    if (Number(tx.is_voided) === 1) {
      throw new DomainRuleError(
        'VOIDED_TX_NO_VOUCHER',
        'حركة ملغاة لا تُمنح رقم سند مطبوع',
      );
    }
    if (tx.reversal_of !== null && tx.reversal_of !== undefined) {
      throw new DomainRuleError(
        'VOIDED_TX_NO_VOUCHER',
        'الحركة المعاكسة لا تحمل رقم سند — الرقم للأصل',
      );
    }
    const docType = tx.tx_type === 'receipt' ? 'RVT' : 'PMT';
    // سنة الرقم من تاريخ الحركة نفسها (تجميع العدّاد على سنة المستند)
    const voucherNo = await nextDocNo(adapter, docType, tx.tx_date, docType);
    await adapter.run('UPDATE cash_tx SET voucher_no = ? WHERE id = ? AND voucher_no IS NULL', [
      voucherNo,
      cashTxId,
    ]);
    await audit(adapter, 'voucher_no_assign', 'cash_tx', cashTxId, { voucherNo, txDate: tx.tx_date }, opts.createdBy);
    return voucherNo;
  });
}

/**
 * الاسم البديل القديم لنفس السلوك (يمنح رقم السند للصفوف التي تخلو منه) —
 * مرادف ensureVoucherNo لراحة مستهلكي الواجهة.
 */
export const assignVoucherNoIfMissing = ensureVoucherNo;
