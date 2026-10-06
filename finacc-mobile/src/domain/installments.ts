/**
 * installments.ts — خطة التقسيط ودورتها (FR-05-01..05-07 نطاق V1 المخفّض).
 *
 * النموذج المحاسبي (خريطة الترحيل — ملحق و):
 *  - إنشاء الخطة من **فاتورة بيع آجلة حية فقط** (doc_type='sale' +
 *    pay_status='credit' + status='completed') — «المبلغ المخصص بلا فاتورة
 *    ممنوع في V1» (FR-05-01: دين بلا مصدر محاسبي). لا تُنشئ الخطة أي أثر
 *    مالي بذاتها: الدين ظاهر أصلاً على الفاتورة في كشف الطرف (AR)، والجدول
 *    مجرد مواعيد تحصيل فوقه.
 *  - الدفعة الأولى (down_payment > 0): سند قبض حقيقي عبر نواة recordVoucherTx
 *    داخل نفس المعاملة، **مخصص صريحاً للفاتورة نفسها** (AR → CASH لحظة
 *    الإنشاء) ومرتبط بها عبر down_payment_cash_tx_id.
 *  - تحصيل قسط (FR-05-02): سند قبض عبر recordVoucherTx بتخصيص صريح
 *    لفاتورة الخطة (بقدر متبقيها الحي) والباقي «على الحساب» — بعملة الخطة
 *    (= عملة الفاتورة) دائماً.
 *  - تعجيل القسط (FR-05-07): الدفع قبل تاريخ الاستحقاق **مسموح** — لا
 *    إعادة توليد للجدول ولا إزاحة للمواعيد؛ يُسجَّل سنداً عادياً على ذلك
 *    القسط نفسه فحسب (رصيد دفعات يستهلكه القسط المستهدف — موثق تعليقاً).
 *  - إعادة الجدولة (FR-05-04): تعديل تاريخ استحقاق القسط **فقط** + قيد
 *    audit — لا إعادة توزيع للمبالغ ولا إزاحة تلقائية لبقية الأقساط.
 *
 * قاعدة التقريب (FR-05-01 / 5.4-9): أقساط متساوية = principal/months مقربة
 * لأقرب وحدة عملة صحيحة (بمنازل العملة: YER=0 → ريال صحيح؛ SAR=2 → 0.01)
 * والفرق يُحمَّل على **القسط الأخير** (seq=months).
 *
 * حسابات التواريخ نقية على نصوص ISO (addCycleMonths بتثبيت نهاية الشهر:
 * 31 يناير + شهر → 28/29 فبراير).
 *
 * قواعد صارمة (موروثة من cash.ts):
 *  - Decimal نصي فقط: f4 للمال، f6 للأسعار (5.2-3).
 *  - سعر الخطة Snapshot من الفاتورة نفسها؛ سندات التحصيل بسعر يوم الدفع
 *    الصارم (getRate — قرار 8) — MissingRateError إن غاب.
 *  - كل كتابة داخل adapter.transaction ذرّية واحدة + assertPeriodOpen + audit.
 *
 * حدود V1 الموثقة:
 *  - **لا إلغاء خطة**: قيمة 'cancelled' في enum تبقى استثماراً هيكلياً بلا
 *    دالة دومين — دين الفاتورة يعيش في الفاتورة نفسها (بطلانها يُعالج من
 *    إلغاء الفاتورة)، وإلغاء خطة ذات سندات قبض يتطلب عكس كل سنداتها.
 *  - 'defaulted' مفهوم عرض لا انتقال حالة: الخطة التي فيها أقساط متأخرة
 *    تُعرض متأخرة (isLate) دون تغيير status — يظل 'active'.
 *  - 'late' في enum القسط قيمة عرض مشتقة: الدومين يكتب pending/partial/paid
 *    فقط، والتأخر يُشتق (due_date < اليوم).
 *  - ملاحظة الخطة (notes) لا عمود لها في DDL v1.2 (مجمّدة — لا تعديل مخطط):
 *    تُحفظ في تفاصيل قيد audit 'installment_plan_create' كي لا تضيع.
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { d, f4, f6, isDecimalString, roundTo, Decimal } from '../utils/money';
import { DomainRuleError, ValidationError } from './errors';
import { assertPeriodOpen } from './fiscal';
import { getRate } from './currency';
import { recordVoucherTx, remainingOnInvoice, type OpenInvoiceRow, type RecordVoucherResult } from './cash';

/* ============================ المخططات (زود) ============================ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** نص رقم غير سالب */
const DecNonNeg = (msg: string) =>
  z.string().refine((s) => isDecimalString(s) && d(s).gte(0), { message: msg });

export const CreateInstallmentPlanInputSchema = z.object({
  /** فاتورة البيع الآجلة مصدر الدين (لا «مبلغ مخصص» في V1) */
  invoiceId: z.number().int().positive(),
  /** عدد الأقساط (أشهر أو أسابيع حسب الدورية) */
  months: z.number().int().min(1, 'عدد الأقساط لا يقل عن قسط واحد').max(120, 'عدد الأقساط كبير جداً (الحد 120)'),
  cycle: z.enum(['monthly', 'weekly']),
  /** تاريخ استحقاق أول قسط (YYYY-MM-DD) */
  firstDue: z.string().regex(ISO_DATE, 'تاريخ أول قسط غير صالح (المتوقع YYYY-MM-DD)'),
  /** الدفعة الأولى — 0 افتراضياً؛ يجب ألا تتجاوز متبقي الفاتورة */
  downPayment: DecNonNeg('الدفعة الأولى يجب أن تكون رقماً غير سالب').optional(),
  /** الصندوق الذي يستلم الدفعة الأولى — إلزامي عند downPayment > 0 */
  cashboxId: z.number().int().positive().optional(),
  /** ملاحظة تُحفظ في قيد audit (لا عمود notes في DDL v1.2) */
  notes: z.string().optional(),
});
export type CreateInstallmentPlanInput = z.input<typeof CreateInstallmentPlanInputSchema>;

export const PayInstallmentInputSchema = z.object({
  installmentId: z.number().int().positive(),
  cashboxId: z.number().int().positive(),
  /** ي افتراضي = متبقي القسط كاملاً؛ جزئي مسموح، تجاوز المتبقي مرفوض */
  amount: DecNonNeg('مبلغ التحصيل يجب أن يكون رقماً غير سالب').optional(),
  /** تاريخ السند (YYYY-MM-DD) — اليوم افتراضياً */
  date: z.string().regex(ISO_DATE, 'تاريخ غير صالح (المتوقع YYYY-MM-DD)').optional(),
});
export type PayInstallmentInput = z.input<typeof PayInstallmentInputSchema>;

export const RescheduleInstallmentInputSchema = z.object({
  installmentId: z.number().int().positive(),
  /** تاريخ الاستحقاق الجديد — لا يُلمس أي مبلغ ولا موعد آخر */
  newDueDate: z.string().regex(ISO_DATE, 'تاريخ الاستحقاق الجديد غير صالح (المتوقع YYYY-MM-DD)'),
  reason: z.string().optional(),
});
export type RescheduleInstallmentInput = z.input<typeof RescheduleInstallmentInputSchema>;

/* ============================ الأنواع ============================ */

export type InstallmentCycle = 'monthly' | 'weekly';
export type InstallmentStatus = 'pending' | 'partial' | 'paid' | 'late';
export type InstallmentPlanStatus = 'active' | 'completed' | 'defaulted' | 'cancelled';

/** صف installment_plan كما يُقرأ من القاعدة (snake_case حرفياً) */
export interface InstallmentPlanRow {
  id: number;
  customer_id: number;
  invoice_id: number;
  currency_id: number;
  exchange_rate: string;
  principal: string;
  down_payment: string | null;
  down_payment_cash_tx_id: number | null;
  months: number;
  cycle: string | null;
  first_due: string;
  total_paid: string | null;
  status: string | null;
  created_at: string | null;
}

/** صف installment كما يُقرأ من القاعدة (snake_case حرفياً) */
export interface InstallmentRow {
  id: number;
  plan_id: number;
  seq: number;
  due_date: string;
  amount: string;
  paid_amount: string | null;
  status: string | null;
  paid_at: string | null;
  cash_tx_id: number | null;
}

export interface CreateInstallmentPlanResult {
  planId: number;
  /** الجدول المولَّد (seq → تاريخ/مبلغ) — للعرض والاختبار */
  schedule: { seq: number; dueDate: string; amount: string }[];
  /** سند قبض الدفعة الأولى — null عند downPayment = 0 */
  downPaymentVoucher: RecordVoucherResult | null;
}

export interface PayInstallmentResult extends RecordVoucherResult {
  installmentId: number;
  /** المبلغ المدفوع هذه المرة (4dp) */
  paidAmount: string;
  /** متبقي القسط بعد هذه الدفعة (4dp) */
  remainingAfter: string;
  installmentStatus: 'pending' | 'partial' | 'paid';
  /** هل اكتملت الخطة كلها بهذه الدفعة؟ */
  planCompleted: boolean;
}

/** صف مستحق للداشبورد/القوائم (قسط غير مسدد + بيانات خطته) */
export interface InstallmentDueRow {
  id: number;
  planId: number;
  seq: number;
  dueDate: string;
  amount: string;
  paidAmount: string;
  status: string;
  invoiceId: number;
  customerId: number;
  currencyId: number;
}

/** أصغر بيانات تصنيف القسط للعرض والاختبار */
export interface InstallmentDueInfo {
  dueDate: string;
  status: string;
}

/* ============================ التواريخ (نقية) ============================ */

/** أيام في شهر معين (ميلادي) — 28/29 لفبراير */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * إزاحة أشهر على تاريخ ISO مع **تثبيت نهاية الشهر**: 31 يناير + شهر واحد
 * → 28/29 فبراير (اليوم يُقصّ على آخر يوم ممكن في الشهر الوجهة) — ولا
 * يتسرب «2 مارس» كما في الجمع الأعمى بالأيام.
 */
export function addCycleMonths(iso: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]); // 1..12
  const day = Number(m[3]);
  const total = (y * 12 + (mo - 1)) + months;
  const ny = Math.floor(total / 12);
  const nmo = (total % 12) + 1; // 1..12
  const nd = Math.min(day, daysInMonth(ny, nmo));
  const p2 = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${ny}-${p2(nmo)}-${p2(nd)}`;
}

/** إزاحة أسابيع على تاريخ ISO (حساب UTC خالص — دورة addDaysISO نفسها) */
export function addCycleWeeks(iso: string, weeks: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

/** تاريخ الاستحقاق للقسط seq (1-based) حسب دورية الخطة */
export function dueDateForSeq(firstDue: string, cycle: InstallmentCycle, seq: number): string {
  const k = seq - 1;
  return cycle === 'weekly' ? addCycleWeeks(firstDue, k) : addCycleMonths(firstDue, k);
}

/* ============================ التقريب (FR-05-01 / 5.4-9) ============================ */

/** منازل عملة إلى قيمة roundTo المدعومة (0/2/3/4/6 — YER=0، SAR=2) */
function normalizeDecimals(decimals: number): 0 | 2 | 3 | 4 | 6 {
  if (decimals <= 0) return 0;
  if (decimals === 3) return 3;
  if (decimals === 4) return 4;
  if (decimals >= 6) return 6;
  return 2;
}

/**
 * توليد جدول الأقساط (نقي — نفس منطق createInstallmentPlan للمعاينة الحية):
 * أقساط متساوية = principal/months مقربة لأقرب وحدة (بمنازل العملة)،
 * والفرق كله على القسط الأخير. يُرفض عدد أقساط يجعل القسط الأخير ≤ 0
 * (المبلغ أصغر من دقة العملة على هذا العدد).
 */
export function computeSchedule(
  principal: Decimal,
  months: number,
  currencyDecimals: number,
): { seq: number; amount: Decimal }[] {
  const dp = normalizeDecimals(currencyDecimals);
  const equal = roundTo(principal.div(months), dp);
  const out: { seq: number; amount: Decimal }[] = [];
  let consumed = new Decimal(0);
  for (let seq = 1; seq <= months; seq += 1) {
    const amt =
      seq === months
        ? principal.minus(consumed) // الفرق على الأخير — دقة مطلقة
        : equal;
    if (amt.lte(0)) {
      throw new DomainRuleError(
        'INSTALLMENT_MONTHS_TOO_MANY',
        `عدد الأقساط (${months}) كبير على هذا المبلغ عند دقة العملة — قلّل عدد الأقساط أو زد الدفعة الأولى`,
      );
    }
    out.push({ seq, amount: amt });
    consumed = consumed.plus(amt);
  }
  return out;
}

/* ============================ التصنيف (FR-05-04) ============================ */

/** هل القسط متأخر؟ (pending/partial وتاريخه قبل اليوم) — مقارنة نصية ISO صالحة */
export function isLate(installment: InstallmentDueInfo, today: string = todayISO()): boolean {
  return (
    (installment.status === 'pending' || installment.status === 'partial') &&
    installment.dueDate < today
  );
}

/** أيام التأخر (0 إن لم يتأخر) — فرق أيام UTC صافٍ */
export function daysLate(installment: InstallmentDueInfo, today: string = todayISO()): number {
  if (!isLate(installment, today)) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(installment.dueDate);
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m || !t) return 0;
  const due = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]));
  return Math.round((now - due) / 86_400_000);
}

/** الأقساط غير المسددة المستحقة داخل النافذة (تشمل المتأخر أصلاً) */
export async function getInstallmentsDue(
  adapter: SqliteAdapter,
  opts: { today: string; withinDays?: number },
): Promise<InstallmentDueRow[]> {
  const limit = addDays(opts.today, opts.withinDays ?? 7);
  const rows = await adapter.all<{
    id: number;
    plan_id: number;
    seq: number;
    due_date: string;
    amount: string;
    paid_amount: string | null;
    status: string | null;
    invoice_id: number;
    customer_id: number;
    currency_id: number;
  }>(
    `SELECT i.id, i.plan_id, i.seq, i.due_date, i.amount, i.paid_amount, i.status,
            p.invoice_id, p.customer_id, p.currency_id
     FROM installment i
     JOIN installment_plan p ON p.id = i.plan_id
     WHERE i.status IN ('pending','partial') AND p.status != 'cancelled'
       AND i.due_date <= ?
     ORDER BY i.due_date ASC, p.id ASC, i.seq ASC`,
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    planId: Number(r.plan_id),
    seq: Number(r.seq),
    dueDate: r.due_date,
    amount: r.amount,
    paidAmount: r.paid_amount ?? '0',
    status: r.status ?? 'pending',
    invoiceId: Number(r.invoice_id),
    customerId: Number(r.customer_id),
    currencyId: Number(r.currency_id),
  }));
}

/** تقدّم الخطة من سطور جدولها (نقي): عدد المسدد/الكل + المتبقي النقدي */
export function planProgress(installments: InstallmentRow[]): {
  total: number;
  paidCount: number;
  remaining: Decimal;
} {
  let paidCount = 0;
  let remaining = new Decimal(0);
  for (const i of installments) {
    if (i.status === 'paid') {
      paidCount += 1;
      continue;
    }
    remaining = remaining.plus(d(i.amount).minus(d(i.paid_amount ?? '0')));
  }
  return { total: installments.length, paidCount, remaining };
}

/* ============================ مساعدات داخلية ============================ */

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

/** تاريخ اليوم UTC (نفس اصطلاح cash.ts/cheques.ts) */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** إزاحة أيام على تاريخ ISO (UTC خالص) */
function addDays(iso: string, days: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

async function loadPlan(adapter: SqliteAdapter, id: number): Promise<InstallmentPlanRow> {
  const rows = await adapter.all<InstallmentPlanRow>('SELECT * FROM installment_plan WHERE id = ?', [id]);
  const row = rows[0];
  if (!row) {
    throw new DomainRuleError('INSTALLMENT_PLAN_NOT_FOUND', `خطة التقسيط غير موجودة (معرّف ${id})`);
  }
  return row;
}

async function loadInstallment(adapter: SqliteAdapter, id: number): Promise<InstallmentRow> {
  const rows = await adapter.all<InstallmentRow>('SELECT * FROM installment WHERE id = ?', [id]);
  const row = rows[0];
  if (!row) {
    throw new DomainRuleError('INSTALLMENT_NOT_FOUND', `القسط غير موجود (معرّف ${id})`);
  }
  return row;
}

/** فاتورة الخطة (صف كامل بColumns الدومين) أو null */
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

/* ==================== إنشاء الخطة (FR-05-01) ==================== */

/**
 * يحوّل فاتورة بيع **آجلة حية** إلى خطة تقسيط داخل Transaction ذرّية واحدة:
 *  1) حرس الفترة (على تاريخ أول قسط + سند الدفعة الأولى) + زود.
 *  2) الفاتورة: موجودة + doc_type='sale' + pay_status='credit' (لا نقدي/مختلط
 *     — الدين وحده ما يُقسَّط) + status='completed' (لا مسودة/ملغاة) + لها
 *     عميل + **بلا خطة قائمة سابقة** (أول خطة غير ملغاة تفصح عن الحصر).
 *  3) المتبقي مشتق (due_amount − Σ تخصيصات حية — نفس دلالات السندات):
 *     الدفعة الأولى ≤ المتبقي، والأصل principal = المتبقي − الدفعة > 0.
 *  4) الجدول: قاعدة التقريب أعلاه؛ الاستحقاق seq i = firstDue + (i−1)×شهر/أسبوع.
 *  5) الدفعة الأولى > 0 → سند قبض recordVoucherTx مخصص **صريحاً** للفاتورة
 *     نفسها (يقل متبقيها فوراً) ويرتبط عبر down_payment_cash_tx_id.
 *  6) INSERT الخطة (status='active') + كل الأقساط + قيد audit
 *     'installment_plan_create'.
 *
 * ⚠️ الخطة ذاتها لا تمس الصندوق ولا كشف الطرف — الدين ظاهر أصلاً على
 * الفاتورة؛ الأثر المالي الوحيد هنا هو سند الدفعة الأولى (إن وجد).
 */
export async function createInstallmentPlan(
  adapter: SqliteAdapter,
  input: CreateInstallmentPlanInput,
  opts: { createdBy?: number } = {},
): Promise<CreateInstallmentPlanResult> {
  return adapter.transaction(async () => {
    const parsed = CreateInstallmentPlanInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات خطة التقسيط غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inp = parsed.data;

    const inv = await loadInvoiceRow(adapter, inp.invoiceId);
    if (!inv) {
      throw new DomainRuleError('INVOICE_NOT_FOUND', `الفاتورة غير موجودة (معرّف ${inp.invoiceId})`);
    }
    if (inv.doc_type !== 'sale') {
      throw new DomainRuleError(
        'INSTALLMENT_INVOICE_NOT_SALE',
        'التقسيط على فواتير البيع فقط — لا على الشراء ولا المرتجعات',
      );
    }
    if (inv.pay_status !== 'credit') {
      throw new DomainRuleError(
        'INSTALLMENT_INVOICE_NOT_CREDIT',
        inv.pay_status === 'cash'
          ? 'فاتورة نقدية لا تُقسَّط — الدين غير موجود أصلاً'
          : 'فاتورة مختلطة (جزء نقدي وجزء آجل) لا تُقسَّط في V1 — خصّص القبض للجزء الآجل بسند عادي',
      );
    }
    if (inv.status !== 'completed') {
      throw new DomainRuleError(
        'INSTALLMENT_INVOICE_NOT_LIVE',
        inv.status === 'void'
          ? 'فاتورة ملغاة — لا تقسيط عليها (دينها عُكس بأثرها)'
          : 'المسودة لا تُقسَّط — حوّلها إلى فاتورة مكتملة أولاً',
      );
    }
    if (inv.customer_id === null) {
      throw new DomainRuleError(
        'INSTALLMENT_INVOICE_NO_CUSTOMER',
        'فاتورة آجلة بلا عميل — لا يمكن تقسيطها (حدّث الفاتورة بربطها بعميل)',
      );
    }

    // حصرية الخطة: أول خطة غير ملغاة تمنع غيرها
    const existing = await adapter.all<{ id: number; status: string | null }>(
      `SELECT id, status FROM installment_plan WHERE invoice_id = ? AND status != 'cancelled'`,
      [inp.invoiceId],
    );
    if (existing.length > 0) {
      throw new DomainRuleError(
        'INSTALLMENT_PLAN_EXISTS',
        `هذه الفاتورة لها خطة تقسيط قائمة بالفعل (معرّف ${existing[0]!.id}) — افتحها وتابعها بدل إنشاء ثانية`,
      );
    }

    // المتبقي القابل للتقسيط (مشتق — نفس دلالات السندات حرفياً)
    const remaining = await remainingOnInvoice(adapter, inv, 'receipt');
    if (remaining.lte(0)) {
      throw new DomainRuleError(
        'INSTALLMENT_NO_REMAINING',
        `الفاتورة ${inv.invoice_no ?? inv.id} سُدّدت بالكامل — لا متبقي يُقسَّط`,
      );
    }

    const down = inp.downPayment !== undefined ? d(inp.downPayment) : new Decimal(0);
    if (down.gt(remaining)) {
      throw new DomainRuleError(
        'INSTALLMENT_DOWN_EXCEEDS_REMAINING',
        `الدفعة الأولى (${f4(down)}) تتجاوز متبقي الفاتورة (${f4(remaining)}) — خفّضها إلى المتبقي أو أقل`,
      );
    }
    const principal = remaining.minus(down);
    if (principal.lte(0)) {
      throw new DomainRuleError(
        'INSTALLMENT_PRINCIPAL_ZERO',
        'الدفعة الأولى تغطي كامل متبقي الفاتورة — لا حاجة لخطة تقسيط (سجّلها سند قبض عادياً)',
      );
    }

    // منازل عملة الفاتورة (قاعدة التقريب)
    const curRows = await adapter.all<{ decimals: number }>(
      'SELECT decimals FROM currency WHERE id = ?',
      [Number(inv.currency_id)],
    );
    const currencyDecimals = Number(curRows[0]?.decimals ?? 2);

    // الجدول (يرمي INSTALLMENT_MONTHS_TOO_MANY إن افترق القسط الأخير)
    const schedule = computeSchedule(principal, inp.months, currencyDecimals);
    const cycle: InstallmentCycle = inp.cycle;
    const dueDates = schedule.map((s) => dueDateForSeq(inp.firstDue, cycle, s.seq));

    // حرس الفترة: أول قسط لا يقع في سنة مغلقة (+ سند الدفعة يحرس تاريخه بنفسه)
    await assertPeriodOpen(adapter, inp.firstDue);

    // الدفعة الأولى: سند قبض مخصص صريحاً للفاتورة (AR → CASH لحظة الإنشاء)
    let downVoucher: RecordVoucherResult | null = null;
    const today = todayISO();
    if (down.gt(0)) {
      if (inp.cashboxId === undefined) {
        throw new DomainRuleError(
          'INSTALLMENT_DOWN_CASHBOX_REQUIRED',
          'الدفعة الأولى تستلم نقداً — اختر الصندوق الذي يدخلها',
        );
      }
      const downRate = d(await getRate(adapter, Number(inv.currency_id), today));
      downVoucher = await recordVoucherTx(
        adapter,
        {
          txType: 'receipt',
          cashboxId: inp.cashboxId,
          currencyId: Number(inv.currency_id),
          amount: f4(down),
          exchangeRate: f6(downRate),
          txDate: today,
          customerId: Number(inv.customer_id),
          description: `دفعة أولى لخطة تقسيط الفاتورة ${inv.invoice_no ?? inv.id}`,
          allocations: [{ invoiceId: inv.id, amount: f4(down) }],
        },
        { createdBy: opts.createdBy },
      );
    }

    // إدخال الخطة
    const nowIso = new Date().toISOString();
    const planRows = await adapter.all<{ id: number }>(
      `INSERT INTO installment_plan
         (customer_id, invoice_id, currency_id, exchange_rate, principal, down_payment,
          down_payment_cash_tx_id, months, cycle, first_due, total_paid, status,
          created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0.0000', 'active', ?, ?, ?)
       RETURNING id`,
      [
        Number(inv.customer_id),
        inv.id,
        Number(inv.currency_id),
        f6(inv.exchange_rate), // Snapshot من الفاتورة نفسها (إصلاح v1.2)
        f4(principal),
        f4(down),
        downVoucher !== null ? downVoucher.cashTxId : null,
        inp.months,
        cycle,
        inp.firstDue,
        nowIso,
        nowIso,
        opts.createdBy ?? null,
      ],
    );
    const planId = Number(planRows[0]!.id);

    // إدخال الجدول
    for (let i = 0; i < schedule.length; i += 1) {
      await adapter.run(
        `INSERT INTO installment (plan_id, seq, due_date, amount, paid_amount, status,
                                  paid_at, cash_tx_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, '0.0000', 'pending', NULL, NULL, ?, ?)`,
        [planId, schedule[i]!.seq, dueDates[i], f4(schedule[i]!.amount), nowIso, nowIso],
      );
    }

    await audit(
      adapter,
      'installment_plan_create',
      'installment_plan',
      planId,
      {
        invoiceId: inv.id,
        invoiceNo: inv.invoice_no,
        customerId: Number(inv.customer_id),
        currencyId: Number(inv.currency_id),
        exchangeRate: f6(inv.exchange_rate),
        remainingOnInvoice: f4(remaining),
        downPayment: f4(down),
        downPaymentCashTxId: downVoucher !== null ? downVoucher.cashTxId : null,
        downPaymentVoucherNo: downVoucher !== null ? downVoucher.voucherNo : null,
        principal: f4(principal),
        months: inp.months,
        cycle,
        firstDue: inp.firstDue,
        schedule: schedule.map((s, i) => ({
          seq: s.seq,
          dueDate: dueDates[i],
          amount: f4(s.amount),
        })),
        // لا عمود notes في DDL v1.2 — الملاحظة تعيش هنا كي لا تضيع
        notes: inp.notes?.trim() || null,
      },
      opts.createdBy,
    );

    return {
      planId,
      schedule: schedule.map((s, i) => ({ seq: s.seq, dueDate: dueDates[i]!, amount: f4(s.amount) })),
      downPaymentVoucher: downVoucher,
    };
  });
}

/* ==================== تحصيل قسط (FR-05-02 + FR-05-07) ==================== */

/**
 * يحصّل قسطاً (كاملاً أو جزئياً) داخل Transaction ذرّية واحدة:
 *  1) الحرس: القسط موجود وغير مسدد كاملاً؛ المبلغ > 0 و≤ متبقي القسط
 *     (التعجيل قبل الاستحقاق **مسموح** — FR-05-07: مجرد دفعة على ذلك القسط،
 *     بلا إعادة توليد جدول ولا إزاحة مواعيد).
 *  2) سند قبض recordVoucherTx بعملة الخطة (= عملة الفاتورة) بسعر يوم
 *     الدفع الصارم (getRate — قرار 8)، **مخصص صريحاً لفاتورة الخطة** بقدر
 *     متبقيها الحي، والباقي «على الحساب» (إن سُدّدت الفاتورة من سبيل آخر
 *     تتبع النقديةُ سلوكَ السند الحر: FIFO ثم على الحساب — موثق).
 *  3) تحديث القسط: paid_amount + الحالة (paid كاملاً / partial جزئياً) +
 *     paid_at عند الاكتمال + cash_tx_id (آخر سند — السوابق في سجل النقدية
 *     وتفاصيل audit).
 *  4) تحديث الخطة: total_paid، وتصبح 'completed' حين تُسدد كل الأقساط.
 *  5) قيد audit 'installment_pay'.
 */
export async function payInstallment(
  adapter: SqliteAdapter,
  input: PayInstallmentInput,
  opts: { createdBy?: number } = {},
): Promise<PayInstallmentResult> {
  return adapter.transaction(async () => {
    const parsed = PayInstallmentInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات التحصيل غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inp = parsed.data;

    const inst = await loadInstallment(adapter, inp.installmentId);
    if (inst.status === 'paid') {
      throw new DomainRuleError('INSTALLMENT_ALREADY_PAID', 'هذا القسط مسدد بالكامل — لا تحصيل عليه');
    }
    const instRemaining = d(inst.amount).minus(d(inst.paid_amount ?? '0'));
    const payAmt = inp.amount !== undefined ? d(inp.amount) : instRemaining;
    if (payAmt.lte(0)) {
      throw new DomainRuleError(
        'INSTALLMENT_PAY_NOT_POSITIVE',
        'مبلغ التحصيل يجب أن يكون أكبر من صفر',
      );
    }
    if (payAmt.gt(instRemaining)) {
      throw new DomainRuleError(
        'INSTALLMENT_OVERPAY',
        `المبلغ (${f4(payAmt)}) يتجاوز متبقي القسط (${f4(instRemaining)}) — حصّل المتبقي فقط أو عدّل المبلغ`,
      );
    }

    const plan = await loadPlan(adapter, Number(inst.plan_id));
    if (plan.status === 'cancelled') {
      throw new DomainRuleError('INSTALLMENT_PLAN_CANCELLED', 'خطة تقسيط ملغاة — لا تحصيل على أقساطها');
    }

    const inv = await loadInvoiceRow(adapter, Number(plan.invoice_id));
    if (!inv || inv.status !== 'completed' || inv.doc_type !== 'sale') {
      throw new DomainRuleError(
        'INSTALLMENT_INVOICE_NOT_LIVE',
        `فاتورة الخطة ${inv?.invoice_no ?? plan.invoice_id} لم تعد حية (أُلغيت؟) — راجع الفاتورة قبل تحصيل أقساطها`,
      );
    }

    const txDate = inp.date ?? todayISO();
    const rate = d(await getRate(adapter, Number(plan.currency_id), txDate));

    // التخصيص الصريح لفاتورة الخطة بقدر متبقيها الحي (قرار 8: نفس العملة فلا
    // فرق صرف؛ الزيادة «على الحساب» تلقائياً داخل recordVoucherTx)
    const invRemaining = await remainingOnInvoice(adapter, inv, 'receipt');
    const explicit = Decimal.min(payAmt, invRemaining.gt(0) ? invRemaining : new Decimal(0));

    const voucher = await recordVoucherTx(
      adapter,
      {
        txType: 'receipt',
        cashboxId: inp.cashboxId,
        currencyId: Number(plan.currency_id),
        amount: f4(payAmt),
        exchangeRate: f6(rate),
        txDate,
        customerId: Number(plan.customer_id),
        description: `تحصيل قسط ${inst.seq}/${plan.months} — فاتورة ${inv.invoice_no ?? inv.id}`,
        allocations:
          explicit.gt(0) ? [{ invoiceId: inv.id, amount: f4(explicit) }] : undefined,
      },
      { createdBy: opts.createdBy },
    );

    // تحديث القسط
    const newPaid = d(inst.paid_amount ?? '0').plus(payAmt);
    const isFull = newPaid.gte(d(inst.amount));
    const instStatus: 'paid' | 'partial' = isFull ? 'paid' : 'partial';
    const nowIso = new Date().toISOString();
    await adapter.run(
      `UPDATE installment
         SET paid_amount = ?, status = ?, paid_at = ?, cash_tx_id = ?, updated_at = ?
       WHERE id = ?`,
      [f4(newPaid), instStatus, isFull ? txDate : null, voucher.cashTxId, nowIso, inst.id],
    );

    // تحديث الخطة (total_paid + اكتمال عند سداد الكل — القِراءة بعد تحديث القسط)
    const all = await adapter.all<{ status: string | null }>(
      'SELECT status FROM installment WHERE plan_id = ?',
      [plan.id],
    );
    const newTotalPaid = d(plan.total_paid ?? '0').plus(payAmt);
    const planCompleted = all.every((x) => (x.status ?? 'pending') === 'paid');
    await adapter.run(
      `UPDATE installment_plan
         SET total_paid = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [f4(newTotalPaid), planCompleted ? 'completed' : (plan.status ?? 'active'), nowIso, plan.id],
    );

    await audit(
      adapter,
      'installment_pay',
      'installment',
      inst.id,
      {
        planId: plan.id,
        seq: inst.seq,
        paidNow: f4(payAmt),
        paidAmountTotal: f4(newPaid),
        remainingAfter: f4(d(inst.amount).minus(newPaid)),
        installmentStatus: instStatus,
        // التعجيل قبل الاستحقاق مسموح (FR-05-07) — يوثَّق في القيد لا يُمنع
        earlyPayment: inst.due_date > txDate,
        cashTxId: voucher.cashTxId,
        voucherNo: voucher.voucherNo,
        allocatedToInvoice: f4(explicit),
        onAccountAmount: voucher.onAccountAmount,
        fxGainLoss: voucher.fxGainLoss,
        planCompleted,
      },
      opts.createdBy,
    );

    return {
      installmentId: inst.id,
      paidAmount: f4(payAmt),
      remainingAfter: f4(d(inst.amount).minus(newPaid)),
      installmentStatus: instStatus,
      planCompleted,
      ...voucher,
    };
  });
}

/* ==================== إعادة الجدولة (FR-05-04) ==================== */

/**
 * يعيد جدولة قسط: تعديل **تاريخ الاستحقاق فقط** + قيد audit
 * 'installment_reschedule'. لا إعادة توزيع للمبالغ ولا إزاحة تلقائية
 * لبقية الأقساط (موثقة FR-05-04: «يُميّز لوناً فقط» للتأخر).
 * حارس: ليس على قسط مسدد كاملاً (المسدد واقعة مالية مقفلة).
 */
export async function rescheduleInstallment(
  adapter: SqliteAdapter,
  input: RescheduleInstallmentInput,
  opts: { createdBy?: number } = {},
): Promise<void> {
  return adapter.transaction(async () => {
    const parsed = RescheduleInstallmentInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات إعادة الجدولة غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inp = parsed.data;

    const inst = await loadInstallment(adapter, inp.installmentId);
    if (inst.status === 'paid') {
      throw new DomainRuleError(
        'INSTALLMENT_RESCHEDULE_PAID',
        'قسط مسدد لا يُعاد جدولته — موعده واقعة منتهية',
      );
    }
    if (inp.newDueDate === inst.due_date) {
      return; // لا تغيير فعلي — لا قيد ولا كتابة
    }

    // الاستحقاق الجديد لا يقع في سنة مغلقة (5.4-11)
    await assertPeriodOpen(adapter, inp.newDueDate);

    await adapter.run(
      'UPDATE installment SET due_date = ?, updated_at = ? WHERE id = ?',
      [inp.newDueDate, new Date().toISOString(), inst.id],
    );
    await audit(
      adapter,
      'installment_reschedule',
      'installment',
      inst.id,
      {
        planId: Number(inst.plan_id),
        seq: inst.seq,
        oldDueDate: inst.due_date,
        newDueDate: inp.newDueDate,
        // بلا إعادة توزيع وبلا إزاحة تلقائية للغير (FR-05-04)
        amountsUntouched: true,
        reason: inp.reason?.trim() || null,
      },
      opts.createdBy,
    );
  });
}

/* ==================== قراءة الخطة بجدولها ==================== */

/** الخطة + سطور جدولها مرتبة بالتسلسل (للشاشات والاختبارات) */
export async function getPlanWithSchedule(
  adapter: SqliteAdapter,
  planId: number,
): Promise<{ plan: InstallmentPlanRow; installments: InstallmentRow[] } | null> {
  const plans = await adapter.all<InstallmentPlanRow>(
    'SELECT * FROM installment_plan WHERE id = ?',
    [planId],
  );
  if (!plans[0]) return null;
  const installments = await adapter.all<InstallmentRow>(
    'SELECT id, plan_id, seq, due_date, amount, paid_amount, status, paid_at, cash_tx_id FROM installment WHERE plan_id = ? ORDER BY seq ASC',
    [planId],
  );
  return { plan: plans[0], installments };
}
