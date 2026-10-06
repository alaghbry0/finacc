/**
 * cheques.ts — دورة حياة الشيكات (FR-14-01..06 + خريطة الترحيل ملحق و).
 *
 * النموذج المحاسبي (خريطة الترحيل — ملحق و ملزم):
 *  - استلام شيك وارد  : AR → CHQ (إعادة تبويب مذكّري — **لا** يمس الصندوق
 *    ولا معادلة كشف الطرف: بقاء الدين ظاهراً في كشف العميل حتى التحصيل).
 *  - إصدار شيك صادر   : CHQ → AP (الالتزام للمورّد يبقى في كشفه حتى الصرف).
 *  - تحصيل/صرف (cleared): CHQ → CASH (+FX إن لزم) — هنا فقط تُنشأ حركة
 *    الصندوق (قبض للوارد / صرف للصادر) عبر أنوية النقدية نفسها
 *    (recordVoucherTx) بتخصيصها FIFO وفروق صرفها (قرار 8).
 *  - ارتداد (bounced) : CHQ → AR + CASH → EXP للرسم فقط — الدين يرتد
 *    طبيعياً (لم يحدث أي تخصيص قط أثناء pending — انظر أدناه)، والرسم
 *    مصروف اختياري عبر recordExpenseTx.
 *
 * FR-14-02 (جوهر الوحدة): الشيك في pending/deposited **لا يمس رصيد الصندوق
 * ولا رصيد كشف الطرف** — لا cash_tx ولا payment_allocation؛ كشف الحساب
 * بمعادلة FR-03-02 يبقى كما هو (الدين ظاهر) حتى لحظة cleared.
 *
 * الإلغاء (FR-14-06): void بصلاحية المدير (V1 مستخدم واحد = مدير) + قيد
 * audit — لا حذف فيزيائي أبداً. الشيك المحصّل لا يُلغى من هنا: تُلغى حركة
 * الصندوق التي أنشأها التحصيل (voidCashTx) فترجع كل آثاره (نفس حارس
 * «أُنشئت من فاتورة» في FR-04-08).
 *
 * قواعد صارمة (موروثة من cash.ts):
 *  - Decimal نصي فقط: f4 للمال، f6 للأسعار (5.2-3).
 *  - سعر الشيك Snapshot لحظة التسجيل (قرار 3: الأساس = 1 حصراً)؛ التحصيل
 *    يُثمَّن بسعر يوم التحصيل الصارم (getRate — MissingRateError إن غاب).
 *  - كل كتابة داخل adapter.transaction ذرّية واحدة + assertPeriodOpen.
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { d, f4, f6, isDecimalString, roundTo, Decimal } from '../utils/money';
import { DomainRuleError, ValidationError } from './errors';
import { assertPeriodOpen } from './fiscal';
import { getRate, resolveRate } from './currency';
import {
  fifoAllocate,
  loadOpenInvoices,
  normalizeVoucherRate,
  recordExpenseTx,
  recordVoucherTx,
  remainingOnInvoice,
  type OpenInvoiceRow,
  type RecordVoucherResult,
} from './cash';

/* ============================ المخططات (زود) ============================ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** نص رقم أكبر من الصفر */
const DecPos = (msg: string) =>
  z.string().refine((s) => isDecimalString(s) && d(s).gt(0), { message: msg });

export const RecordChequeInputSchema = z.object({
  /** in = وارد من عميل · out = صادر لمورّد */
  direction: z.enum(['in', 'out']),
  /** إن قُدّم يجب أن يطابق الاتجاه (in→customer / out→supplier) — وإلا يُشتق */
  partyType: z.enum(['customer', 'supplier']).optional(),
  partyId: z.number().int().positive(),
  chequeNo: z.string().min(1, 'رقم الشيك مطلوب — انظر أعلى الشيك'),
  bankName: z.string().optional(),
  amount: DecPos('مبلغ الشيك يجب أن يكون رقماً أكبر من الصفر'),
  currencyId: z.number().int().positive(),
  /** سعر Snapshot لحظة التسجيل — إن غاب يُحل بسياسة resolveRate بتاريخ الإصدار */
  exchangeRate: DecPos('سعر صرف الشيك يجب أن يكون رقماً أكبر من الصفر').optional(),
  issueDate: z.string().regex(ISO_DATE, 'تاريخ غير صالح (المتوقع YYYY-MM-DD)'),
  dueDate: z.string().regex(ISO_DATE, 'تاريخ غير صالح (المتوقع YYYY-MM-DD)'),
  /** فاتورة مرجعية اختيارية (بيع للوارد / شراء للصادر) — مفتوحة وذات متبقٍ */
  refInvoiceId: z.number().int().positive().optional(),
  notes: z.string().optional(),
});
export type RecordChequeInput = z.input<typeof RecordChequeInputSchema>;

export const ClearChequeInputSchema = z.object({
  /** الصندوق الذي يستلم/يدفع قيمة الشيك عند التحصيل/الصرف */
  cashboxId: z.number().int().positive(),
});
export type ClearChequeInput = z.input<typeof ClearChequeInputSchema>;

export const BounceChequeInputSchema = z.object({
  /** رسم الارتداد (اختياري — 0 افتراضياً) */
  fee: z
    .string()
    .refine((s) => isDecimalString(s) && d(s).gte(0), {
      message: 'رسم الارتداد يجب أن يكون رقماً غير سالب',
    })
    .optional(),
  /** فئة مصروف الرسم — إلزامية عند fee > 0 (CASH → EXP للرسم فقط) */
  categoryId: z.number().int().positive().optional(),
  /** الصندوق الذي يُسحب منه الرسم — إلزامي عند fee > 0 */
  cashboxId: z.number().int().positive().optional(),
});
export type BounceChequeInput = z.input<typeof BounceChequeInputSchema>;

/* ============================ الأنواع ============================ */

export type ChequeDirection = 'in' | 'out';
export type ChequeStatus = 'pending' | 'deposited' | 'cleared' | 'bounced' | 'void';

/** صف cheque كما يُقرأ من القاعدة (snake_case حرفياً) */
export interface ChequeRow {
  id: number;
  direction: string;
  party_type: string;
  party_id: number;
  cheque_no: string;
  bank_name: string | null;
  amount: string;
  currency_id: number;
  exchange_rate: string;
  issue_date: string;
  due_date: string;
  status: string;
  bounced_at: string | null;
  bounce_fee: string | null;
  ref_invoice_id: number | null;
  cleared_cash_tx_id: number | null;
  notes: string | null;
}

export interface RecordChequeResult {
  chequeId: number;
}

export interface ClearChequeResult extends RecordVoucherResult {
  chequeId: number;
}

export interface BounceChequeResult {
  chequeId: number;
  /** حركة المصروف التي أنشأت الرسم — null إذا fee = 0 */
  expenseCashTxId: number | null;
  /** الرسم المخزَّن (4dp) */
  bounceFee: string;
}

/* ============================ مساعدات داخلية ============================ */

async function loadCheque(adapter: SqliteAdapter, id: number): Promise<ChequeRow> {
  const rows = await adapter.all<ChequeRow>('SELECT * FROM cheque WHERE id = ?', [id]);
  const row = rows[0];
  if (!row) {
    throw new DomainRuleError('CHEQUE_NOT_FOUND', `الشيك غير موجود (معرّف ${id})`);
  }
  return row;
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
      `${table === 'customer' ? 'العميل' : 'المورّد'} غير موجود (معرّف ${id}) — تحقق من اختيار الطرف`,
    );
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

/** تاريخ اليوم UTC (نفس اصطلاح cash.ts) */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** الحالة قابلة للتحصيل/الإيداع (لم تُقفل الدورة بعد) */
function isLiveCheque(row: ChequeRow): boolean {
  return row.status === 'pending' || row.status === 'deposited';
}

/** رسالة الحالة بالعربية لسياق الأخطاء */
function statusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'قيد التحصيل';
    case 'deposited':
      return 'مودَع بالبنك';
    case 'cleared':
      return 'محصّل';
    case 'bounced':
      return 'مرتد';
    case 'void':
      return 'ملغى';
    default:
      return status;
  }
}

/* ==================== تسجيل شيك (FR-14-01) ==================== */

/**
 * يسجل شيكاً وارداً (من عميل) أو صادراً (لمورّد) داخل Transaction ذرّية:
 *  1) حرس الفترة (على تاريخ الإصدار) + التحقق زود + الأركان.
 *  2) الاتجاه والطرف: in→customer / out→supplier (تعارض صريح يُرفض).
 *  3) السعر: إدخال Snapshot (الأساس = 1 حصراً) أو حل بسياسة resolveRate
 *     بتاريخ الإصدار — MissingRateError إن غاب (قرار 3).
 *  4) الفاتورة المرجعية (اختيارية): عائلة مطابقة + طرف الشيك + حية
 *     (completed) + متبقٍ > 0 (المشتق نفسه المستخدم في السندات).
 *  5) INSERT بحالة pending + قيد audit 'cheque_create'.
 *
 * ⚠️ FR-14-02: لا cash_tx ولا payment_allocation هنا إطلاقاً — الشيك
 * إعادة تبويب مذكّري (AR→CHQ / CHQ→AP)؛ الدين يبقى ظاهراً في كشف الطرف
 * بمعادلة FR-03-02 حتى التحصيل. لذلك «المتبقي على الفاتورة» لا يُستهلك
 * الآن — يُستهلك لحظة cleared فقط.
 */
export async function recordCheque(
  adapter: SqliteAdapter,
  input: RecordChequeInput,
  opts: { createdBy?: number } = {},
): Promise<RecordChequeResult> {
  return adapter.transaction(async () => {
    const parsed = RecordChequeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات الشيك غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inp = parsed.data;

    // الاتجاه يفرض نوع الطرف (in→عميل / out→مورّد)
    const expectedPartyType: 'customer' | 'supplier' =
      inp.direction === 'in' ? 'customer' : 'supplier';
    if (inp.partyType !== undefined && inp.partyType !== expectedPartyType) {
      throw new DomainRuleError(
        'CHEQUE_PARTY_DIRECTION_MISMATCH',
        inp.direction === 'in'
          ? 'الشيك الوارد يستلمه عميل — اختر عميلاً (وليس مورّداً)'
          : 'الشيك الصادر يُلزم مورّداً — اختر مورّداً (وليس عميلاً)',
      );
    }
    const partyTable = expectedPartyType;
    const family: 'sale' | 'purchase' = inp.direction === 'in' ? 'sale' : 'purchase';

    // الاستحقاق لا يسبق الإصدار (DDL منطقي — شيك مؤجل صالح دائماً) — مقارنة نصية ISO
    if (inp.dueDate < inp.issueDate) {
      throw new DomainRuleError(
        'CHEQUE_DUE_BEFORE_ISSUE',
        'تاريخ الاستحقاق لا يسبق تاريخ الإصدار — راجع التاريخين',
      );
    }

    await assertPeriodOpen(adapter, inp.issueDate);
    await assertCurrencyExists(adapter, inp.currencyId);
    await assertPartyExists(adapter, partyTable, inp.partyId);

    // سعر الشيك: Snapshot صريح (الأساس=1) أو حل بسياسة resolveRate (قرار 3)
    const rate =
      inp.exchangeRate !== undefined
        ? await normalizeVoucherRate(adapter, inp.currencyId, inp.exchangeRate)
        : d((await resolveRate(adapter, inp.currencyId, inp.issueDate)).rate);

    // الفاتورة المرجعية: عائلة/طرف/حياة/متبقٍ (نفس دلالات تخصيص السندات)
    if (inp.refInvoiceId !== undefined) {
      await assertRefInvoiceUsable(
        adapter,
        inp.refInvoiceId,
        family,
        partyTable,
        inp.partyId,
        inp.direction === 'in' ? 'receipt' : 'payment',
      );
    }

    const nowIso = new Date().toISOString();
    const rows = await adapter.all<{ id: number }>(
      `INSERT INTO cheque
         (direction, party_type, party_id, cheque_no, bank_name, amount, currency_id,
          exchange_rate, issue_date, due_date, status, bounced_at, bounce_fee,
          ref_invoice_id, cleared_cash_tx_id, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, '0.0000', ?, NULL, ?, ?, ?, ?)
       RETURNING id`,
      [
        inp.direction,
        expectedPartyType,
        inp.partyId,
        inp.chequeNo.trim(),
        inp.bankName?.trim() || null,
        f4(inp.amount),
        inp.currencyId,
        f6(rate),
        inp.issueDate,
        inp.dueDate,
        inp.refInvoiceId ?? null,
        inp.notes?.trim() || null,
        nowIso,
        nowIso,
        opts.createdBy ?? null,
      ],
    );
    const chequeId = Number(rows[0]!.id);

    await audit(
      adapter,
      'cheque_create',
      'cheque',
      chequeId,
      {
        direction: inp.direction,
        chequeNo: inp.chequeNo.trim(),
        bankName: inp.bankName?.trim() ?? null,
        amount: f4(inp.amount),
        currencyId: inp.currencyId,
        exchangeRate: f6(rate),
        issueDate: inp.issueDate,
        dueDate: inp.dueDate,
        refInvoiceId: inp.refInvoiceId ?? null,
      },
      opts.createdBy,
    );
    return { chequeId };
  });
}

/** فاتورة مرجعية صالحة: موجودة + العائلة تطابق الاتجاه + طرف الشيك + حية + متبقٍ > 0 */
async function assertRefInvoiceUsable(
  adapter: SqliteAdapter,
  invoiceId: number,
  family: 'sale' | 'purchase',
  partyTable: 'customer' | 'supplier',
  partyId: number,
  allocationTxType: 'receipt' | 'payment',
): Promise<OpenInvoiceRow> {
  const rows = await adapter.all<OpenInvoiceRow>(
    `SELECT id, invoice_no, doc_type, pay_status, status, issued_at, currency_id,
            exchange_rate, total, paid_amount, due_amount, customer_id, supplier_id
     FROM invoice WHERE id = ?`,
    [invoiceId],
  );
  const inv = rows[0];
  if (!inv) {
    throw new DomainRuleError('INVOICE_NOT_FOUND', `الفاتورة غير موجودة (معرّف ${invoiceId})`);
  }
  if (inv.doc_type !== family) {
    throw new DomainRuleError(
      'CHEQUE_REF_FAMILY_MISMATCH',
      family === 'sale'
        ? 'الشيك الوارد يرتبط بفواتير البيع — لا بفواتير الشراء'
        : 'الشيك الصادر يرتبط بفواتير الشراء — لا بفواتير البيع',
    );
  }
  const partyCol = partyTable === 'customer' ? inv.customer_id : inv.supplier_id;
  if (Number(partyCol) !== partyId) {
    throw new DomainRuleError(
      'CHEQUE_REF_PARTY_MISMATCH',
      `الفاتورة ${inv.invoice_no ?? inv.id} تخص طرفاً آخر — اختر فاتورة من فواتير هذا الطرف`,
    );
  }
  if (inv.status !== 'completed') {
    throw new DomainRuleError(
      'CHEQUE_REF_NOT_LIVE',
      `الفاتورة ${inv.invoice_no ?? inv.id} ليست حية (مسودة أو ملغاة) — اختر فاتورة مكتملة`,
    );
  }
  const remaining = await remainingOnInvoice(adapter, inv, allocationTxType);
  if (remaining.lte(0)) {
    throw new DomainRuleError(
      'CHEQUE_REF_FULLY_PAID',
      `الفاتورة ${inv.invoice_no ?? inv.id} سُدّدت بالكامل — لا متبقي يغطيه الشيك`,
    );
  }
  return inv;
}

/* ==================== الإيداع بالبنك (FR-14-02) ==================== */

/**
 * pending → deposited (تتبع إيداع بنكي — لا أثر مالي إطلاقاً: لا يزال
 * CHQ لا CASH). حارس: من pending فقط. + قيد audit 'cheque_deposit'.
 */
export async function depositCheque(
  adapter: SqliteAdapter,
  id: number,
  opts: { createdBy?: number } = {},
): Promise<void> {
  return adapter.transaction(async () => {
    const cheque = await loadCheque(adapter, id);
    if (cheque.status !== 'pending') {
      throw new DomainRuleError(
        'CHEQUE_DEPOSIT_STATE',
        `الإيداع بالبنك لا يكون إلا لشيك قيد التحصيل — هذا الشيك حالته «${statusLabel(cheque.status)}»`,
      );
    }
    await adapter.run(
      `UPDATE cheque SET status = 'deposited', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    );
    await audit(
      adapter,
      'cheque_deposit',
      'cheque',
      id,
      { chequeNo: cheque.cheque_no, bankName: cheque.bank_name, dueDate: cheque.due_date },
      opts.createdBy,
    );
  });
}

/* ==================== التحصيل/الصرف (FR-14-03) ==================== */

/**
 * pending|deposited → cleared داخل Transaction ذرّية واحدة:
 *  1) حركة الصندوق بنواة recordVoucher نفسها (قبض للوارد / صرف للصادر)
 *     بعملة الشيك ومبلغه، وسعر يوم التحصيل الصارم (getRate — قرار 8:
 *     MissingRateError إن غاب سعر اليوم) — فيرث الترقيم RVT-/PMT-
 *     والتخصيص FIFO وفروق الصرف وassertPeriodOpen كما هي.
 *  2) التخصيص: الفاتورة المرجعية أولاً (صريحاً بقدر المتبقي) ثم FIFO
 *     الأقدم أولاً لما تبقى من نفس عملة الشيك، والباقي «على الحساب».
 *  3) cheque.status='cleared' + cleared_cash_tx_id = السند الجديد.
 *  4) قيد audit 'cheque_clear'.
 *
 * من هنا فقط يتحقق نصف FR-14-02 الثاني: الصندوق يتحرك وكشف الطرف
 * ينقص (التخصيصات الحية تدخل معادلة FR-03-02).
 */
export async function clearCheque(
  adapter: SqliteAdapter,
  id: number,
  input: ClearChequeInput,
  opts: { createdBy?: number } = {},
): Promise<ClearChequeResult> {
  return adapter.transaction(async () => {
    const parsed = ClearChequeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات التحصيل غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inp = parsed.data;

    const cheque = await loadCheque(adapter, id);
    if (!isLiveCheque(cheque)) {
      if (cheque.status === 'cleared') {
        throw new DomainRuleError(
          'CHEQUE_CLEAR_STATE',
          'هذا الشيك محصّل سابقاً — لعكس أثره المالي ألغِ حركة الصندوق التي أنشأها تحصيله',
        );
      }
      throw new DomainRuleError(
        'CHEQUE_CLEAR_STATE',
        `لا يُحصَّل شيك حالته «${statusLabel(cheque.status)}» — الحالة النهائية موثقة`,
      );
    }

    const today = todayISO();
    // سعر يوم التحصيل لعملة الشيك — صارم بلا fallback (الأساس = 1 حصراً)
    const clearRate = d(await getRate(adapter, Number(cheque.currency_id), today));

    const isIn = cheque.direction === 'in';
    const txType: 'receipt' | 'payment' = isIn ? 'receipt' : 'payment';
    const family: 'sale' | 'purchase' = isIn ? 'sale' : 'purchase';
    const amount = d(cheque.amount);

    /* ——— بناء التخصيص: المرجعية أولاً ثم FIFO لما تبقى ——— */
    const chosen: { invoice: OpenInvoiceRow; amount: Decimal }[] = [];
    let left = amount;
    if (cheque.ref_invoice_id !== null && cheque.ref_invoice_id !== undefined) {
      const inv = await loadInvoiceRow(adapter, Number(cheque.ref_invoice_id));
      // الفاتورة ما تزال حية ولهذا الطرف؟ وإلا تُترك والتخصيص يتكفل به FIFO
      if (
        inv !== null &&
        inv.doc_type === family &&
        inv.status === 'completed' &&
        Number(family === 'sale' ? inv.customer_id : inv.supplier_id) === Number(cheque.party_id)
      ) {
        const rem = await remainingOnInvoice(adapter, inv, txType);
        if (rem.gt(0)) {
          const explicit = Decimal.min(left, rem);
          chosen.push({ invoice: inv, amount: roundTo(explicit, 4) });
          left = left.minus(explicit);
        }
      }
    }
    if (left.gt(0)) {
      // FIFO على المفتوحة بنفس عملة الشيك (غير المرجعية) — الأقدم أولاً
      const open = await loadOpenInvoices(adapter, family, Number(cheque.party_id));
      const sameCcy = open.filter(
        (i) =>
          Number(i.currency_id) === Number(cheque.currency_id) &&
          Number(i.id) !== Number(cheque.ref_invoice_id ?? -1),
      );
      chosen.push(...(await fifoAllocate(adapter, sameCcy, left, txType)));
    }

    // السند: نواة recordVoucher داخل هذه المعاملة نفسها (تركيب الوحدات)
    const voucher = await recordVoucherTx(
      adapter,
      {
        txType,
        cashboxId: inp.cashboxId,
        currencyId: Number(cheque.currency_id),
        amount: f4(amount),
        exchangeRate: f6(clearRate),
        txDate: today,
        customerId: isIn ? Number(cheque.party_id) : undefined,
        supplierId: isIn ? undefined : Number(cheque.party_id),
        description: `${isIn ? 'تحصيل شيك' : 'صرف شيك'} ${cheque.cheque_no}${
          cheque.bank_name ? ` — ${cheque.bank_name}` : ''
        }`,
        allocations:
          chosen.length > 0
            ? chosen.map((c) => ({ invoiceId: c.invoice.id, amount: f4(c.amount) }))
            : undefined,
      },
      { createdBy: opts.createdBy },
    );

    await adapter.run(
      `UPDATE cheque SET status = 'cleared', cleared_cash_tx_id = ?, updated_at = ? WHERE id = ?`,
      [voucher.cashTxId, new Date().toISOString(), id],
    );
    await audit(
      adapter,
      'cheque_clear',
      'cheque',
      id,
      {
        chequeNo: cheque.cheque_no,
        cashTxId: voucher.cashTxId,
        voucherNo: voucher.voucherNo,
        onAccountAmount: voucher.onAccountAmount,
        fxGainLoss: voucher.fxGainLoss,
        clearRate: f6(clearRate),
      },
      opts.createdBy,
    );
    return { chequeId: id, ...voucher };
  });
}

/** قراءة صف فاتورة كامل (null إن لم توجد) */
async function loadInvoiceRow(
  adapter: SqliteAdapter,
  invoiceId: number,
): Promise<OpenInvoiceRow | null> {
  const rows = await adapter.all<OpenInvoiceRow>(
    `SELECT id, invoice_no, doc_type, pay_status, status, issued_at, currency_id,
            exchange_rate, total, paid_amount, due_amount, customer_id, supplier_id
     FROM invoice WHERE id = ?`,
    [invoiceId],
  );
  return rows[0] ?? null;
}

/* ==================== الارتداد (FR-14-04) ==================== */

/**
 * pending|deposited → bounced داخل Transaction ذرّية:
 *  - bounced_at = اليوم + bounce_fee = الرسم (4dp).
 *  - الرسم > 0 → مصروف عبر نواة recordExpense بفئة إلزامية وصندوق
 *    محدد (خريطة الترحيل: CASH → EXP **للرسم فقط**)؛ الرسم بعملة الشيك
 *    بسعره المسجَّل عليه (Snapshot) — أثر واحد قابل للتتبع من الشيك نفسه.
 *  - **عكس الدين للعميل يتم طبيعياً بلا أي كتابة**: لم يُخصَّص شيء قط
 *    أثناء pending (FR-14-02)، ومعادلة كشف الطرف (FR-03-02) لم تتغير
 *    أصلاً — فالدين الذي كان ظاهراً يبقى ظاهراً. لا يوجد ما يُفكّ.
 *  - قيد audit 'cheque_bounce'.
 * حارس: ليس من cleared (محصّل لا يرتد — أثره المالي وقع) ولا من
 * حالة نهائية أخرى.
 */
export async function bounceCheque(
  adapter: SqliteAdapter,
  id: number,
  input: BounceChequeInput = {},
  opts: { createdBy?: number } = {},
): Promise<BounceChequeResult> {
  return adapter.transaction(async () => {
    const parsed = BounceChequeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات الارتداد غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inp = parsed.data;

    const cheque = await loadCheque(adapter, id);
    if (!isLiveCheque(cheque)) {
      if (cheque.status === 'cleared') {
        throw new DomainRuleError(
          'CHEQUE_BOUNCE_STATE',
          'شيك محصّل لا يرتد — أثره المالي وقع في الصندوق؛ لعكسه ألغِ حركة الصندوق التي أنشأها تحصيله',
        );
      }
      throw new DomainRuleError(
        'CHEQUE_BOUNCE_STATE',
        `شيك حالته «${statusLabel(cheque.status)}» لا يرتد — الحالة النهائية موثقة`,
      );
    }

    const today = todayISO();
    const fee = inp.fee !== undefined ? d(inp.fee) : new Decimal(0);
    let expenseCashTxId: number | null = null;

    if (fee.gt(0)) {
      if (inp.categoryId === undefined) {
        throw new DomainRuleError(
          'CHEQUE_FEE_CATEGORY_REQUIRED',
          'رسم الارتداد مصروف — اختر فئة المصروف أولاً (مثل: رسوم بنكية)',
        );
      }
      if (inp.cashboxId === undefined) {
        throw new DomainRuleError(
          'CHEQUE_FEE_CASHBOX_REQUIRED',
          'رسم الارتداد يُسحب من صندوق — اختر الصندوق أولاً',
        );
      }
      const res = await recordExpenseTx(
        adapter,
        {
          cashboxId: inp.cashboxId,
          currencyId: Number(cheque.currency_id),
          amount: f4(fee),
          exchangeRate: f6(cheque.exchange_rate),
          txDate: today,
          expenseCategoryId: inp.categoryId,
          description: `رسم ارتداد شيك ${cheque.cheque_no}${
            cheque.bank_name ? ` — ${cheque.bank_name}` : ''
          }`,
        },
        { createdBy: opts.createdBy },
      );
      expenseCashTxId = res.cashTxId;
    }

    await adapter.run(
      `UPDATE cheque SET status = 'bounced', bounced_at = ?, bounce_fee = ?, updated_at = ? WHERE id = ?`,
      [today, f4(fee), new Date().toISOString(), id],
    );
    await audit(
      adapter,
      'cheque_bounce',
      'cheque',
      id,
      {
        chequeNo: cheque.cheque_no,
        bouncedAt: today,
        bounceFee: f4(fee),
        expenseCashTxId,
        // الدين ارتد طبيعياً: لا تخصيص أنشأه الشيك ليُفكّ (FR-14-02)
        debtRestoredWithoutReversal: true,
      },
      opts.createdBy,
    );
    return { chequeId: id, expenseCashTxId, bounceFee: f4(fee) };
  });
}

/* ==================== الإلغاء (FR-14-06) ==================== */

/**
 * pending|deposited → void (مدير فقط — V1 مستخدم واحد = مدير؛ التأكيد
 * في الواجهة + قيد audit 'cheque_void'). **لا حذف فيزيائي** — الصف باقٍ
 * بحالة void.
 * حارس «أُنشئت من فاتورة» بنمط FR-04-08: الشيك **المحصّل** لا يُلغى هنا —
 * أثره المالي (حركة الصندوق + التخصيصات) يُعكس بإلغاء تلك الحركة من
 * النقدية (voidCashTx) فترجع كل آثارها. والمرتد حالة نهائية موثقة.
 */
export async function voidCheque(
  adapter: SqliteAdapter,
  id: number,
  opts: { createdBy?: number } = {},
): Promise<void> {
  return adapter.transaction(async () => {
    const cheque = await loadCheque(adapter, id);
    if (cheque.status === 'cleared') {
      throw new DomainRuleError(
        'CHEQUE_VOID_CLEARED',
        'شيك محصّل لا يُلغى من هنا — ألغِ حركة الصندوق التي أنشأها تحصيله فترجع كل آثاره المالية',
      );
    }
    if (cheque.status === 'void') {
      throw new DomainRuleError('CHEQUE_ALREADY_VOIDED', 'هذا الشيك ملغى سابقاً');
    }
    if (cheque.status === 'bounced') {
      throw new DomainRuleError(
        'CHEQUE_VOID_STATE',
        'الشيك المرتد حالة نهائية موثقة (ورسمه مصروف واقع) — لا يُلغى',
      );
    }
    await adapter.run(
      `UPDATE cheque SET status = 'void', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    );
    await audit(
      adapter,
      'cheque_void',
      'cheque',
      id,
      {
        chequeNo: cheque.cheque_no,
        direction: cheque.direction,
        amount: f4(cheque.amount),
        previousStatus: cheque.status,
      },
      opts.createdBy,
    );
  });
}

/* ==================== تصنيفات العرض (FR-14-05) ==================== */

/** أصغر بيانات تصنيف الشيك للواجهات والاختبارات */
export interface ChequeDueInfo {
  dueDate: string;
  status: string;
}

/** نافذة «يستحق قريباً» بالأيام (نفس نافذة الداشبورد) */
export const DUE_SOON_DAYS = 7;

/** هل الشيك متأخر؟ (استحق في الماضي وما يزال pending/deposited) — مقارنة نصية ISO صالحة */
export function isOverdue(cheque: ChequeDueInfo, today: string = todayISO()): boolean {
  return (
    (cheque.status === 'pending' || cheque.status === 'deposited') && cheque.dueDate < today
  );
}

/** هل الشيك يستحق خلال نافذة الأيام القادمة (pending/deposited فقط)؟ */
export function isDueSoon(
  cheque: ChequeDueInfo,
  today: string = todayISO(),
  days: number = DUE_SOON_DAYS,
): boolean {
  if (cheque.status !== 'pending' && cheque.status !== 'deposited') return false;
  if (cheque.dueDate < today) return false; // الماضي = متأخر لا «قريب»
  const limit = addDays(today, days);
  return cheque.dueDate <= limit;
}

/** الشيكات المستحقة خلال النافذة (تصنيف الداشبورد/قائمة الشيكات) */
export function getDueSoonCheques<T extends ChequeDueInfo>(
  cheques: T[],
  today: string = todayISO(),
  days: number = DUE_SOON_DAYS,
): T[] {
  return cheques.filter((c) => isDueSoon(c, today, days));
}

/** إزاحة أيام على تاريخ ISO (UTC خالص — نفس دورة addDaysISO في format) */
function addDays(iso: string, days: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  const shifted = new Date(t + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}
