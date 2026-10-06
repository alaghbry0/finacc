/**
 * reports.ts — تقارير الوحدة 09 على خريطة الترحيل الملزمة (FR-09).
 *
 * القانون الحاكم (SRS §5.4-8 / ملحق و): «تقرير الأرباح يُشتق **حصراً** عبر
 * خريطة الترحيل، ولا يجوز لأي تقرير أن يجمع الحركات بمنطق خاص». لذلك كل
 * سطر في getProfitAndLoss يُصنَّف عبر posting-map.ts قبل أن يدخل البند:
 *  - فواتير مكتملة (status='completed' — تستبعد المسودة والملغاة) حسب doc_type
 *    عبر postInvoiceDoc → المبيعات (+) / مرتجع المبيعات (−) بعملة الأساس
 *    (total_base محسوب وقت الحفظ بسعر يوم الحركة — قرار 3: الأساس=1).
 *  - حركات المخزون عبر postStockMovement → COGS (+) من حركات البيع، وتكلفة
 *    المرتجع (−) من حركات مرتجع البيع (بتكلفة line_cost الأصلية — Snapshot)،
 *    وزيادة/عجز الجرد من تسويات الجرد والتسويات اليدوية.
 *  - حركات الصندوق الحية (is_voided=0 AND reversal_of IS NULL — النمط الموحد)
 *    عبر postCashTx → المصاريف (−) / مسحوبات المالك (بند مستقل خارج المصاريف)
 *    / فروق الصرف المحققة (± من fx_gain_loss المحزّن بالأساس — قرار 8).
 *    إيداع المالك (capital_in) لا يدخل الأرباح إطلاقاً (سطر رأس مال فقط).
 *
 * الصيغة المصححة الملزمة (قرار 7 / FR-09-02):
 *   الربح = (المبيعات − مرتجع المبيعات) − (COGS − تكلفة المرتجع)
 *           + زيادة الجرد − عجز الجرد − المصاريف ± فروق الصرف
 *   ثم: صافي ما بقي للمالك = الربح − المسحوبات.
 *
 * كل المبالغ بالعملة الأساسية (4dp نصاً — 5.2-3)، والتحويل بكل صف بسعره
 * المخزن لحظة الحركة. فلترة الفترة بتواريخ العمل (issued_at / moved_at /
 * tx_date) شاملة الطرفين (from ≤ date ≤ to).
 *
 * الوحدة نقية (NFR-09/11): adapter + decimal + وحدات domain شقيقة فقط.
 */
import type { SqliteAdapter } from '../db/adapter';
import { todayISO } from '../utils/format';
import { d, Decimal, f4, roundTo } from '../utils/money';
import { ValidationError } from './errors';
import { postCashTx, postInvoiceDoc, postStockMovement, type PnlFeedKey } from './posting-map';
import { getPartyBalanceByCurrency } from './statement';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** تحقق تاريخ ISO صالح وإلا ValidationError عربية */
function assertIsoDate(label: string, value: string): void {
  if (!ISO_DATE.test(value)) {
    throw new ValidationError(`تاريخ ${label} غير صالح (المتوقع YYYY-MM-DD): ${value}`);
  }
}

/* ============================ قائمة الأرباح والخسائر (FR-09-02) ============================ */

/** تقرير الأرباح والخسائر بالصيغة المصححة — كل القيم بالعملة الأساسية (4dp) */
export interface PnlReport {
  period: { from: string; to: string };
  /** المبيعات (+) — إجمالي فواتير البيع المكتملة بالأساس */
  sales: string;
  /** مرتجع المبيعات (−) — إجمالي سندات مرتجع البيع المكتملة بالأساس */
  salesReturns: string;
  /** صافي المبيعات = المبيعات − المرتجع */
  netSales: string;
  /** COGS (+) — تكلفة حركات البيع (WAC وقت البيع) */
  cogs: string;
  /** تكلفة المرتجع (−) — تخصم من COGS بتكلفة line_cost الأصلية */
  returnsCost: string;
  /** صافي التكلفة = COGS − تكلفة المرتجع */
  netCogs: string;
  /** زيادة الجرد (+) — تسويات الجرد/اليدوية الزائدة بتكلفة اللقطة */
  stockSurplus: string;
  /** عجز الجرد (−) — تسويات الجرد/اليدوية الناقصة بتكلفة اللقطة */
  stockShortage: string;
  /** المصاريف (−) — حركات مصروف حية (شاملة رسوم ارتداد الشيكات المستقبلة) */
  expenses: string;
  /** فروق الصرف المحققة (±) — fx_gain_loss المحزّن (قرار 8) */
  fxGainLoss: string;
  /** الربح = الصيغة المصححة (قرار 7) */
  profit: string;
  /** مسحوبات المالك — بند مستقل خارج المصاريف */
  ownerDraw: string;
  /** صافي ما بقي للمالك = الربح − المسحوبات (سطر ختامي FR-09-02) */
  netRemainingToOwner: string;
}

/** صف فاتورة خام للتصنيف عبر الخريطة */
interface InvoiceFeedRow {
  doc_type: string;
  status: string;
  total_base: string;
}

/** صف حركة مخزون خام (مع سياق مستنده إن وجد) */
interface MovementFeedRow {
  movement_type: string;
  qty: string;
  unit_cost: string;
  ref_type: string | null;
  /** نوع مستند الفاتورة المرجع (LEFT JOIN) — null حين لا مرجع */
  inv_doc_type: string | null;
  inv_status: string | null;
}

/** صف حركة صندوق خام للتصنيف عبر الخريطة */
interface CashFeedRow {
  tx_type: string;
  amount: string;
  exchange_rate: string;
  fx_gain_loss: string;
}

/** أنواع حركات الصندوق التي قد تغذي بنود الأرباح (بقية الأنواع لا ترحّل للقائمة) */
const CASH_FEED_TYPES =
  "('receipt','payment','expense','owner_draw','capital_in','box_transfer','commission_payout','salary_batch')";

/**
 * تقرير الأرباح والخسائر لفترة [from, to] (شاملة الطرفين) — مشتق حصراً
 * عبر خريطة الترحيل (ملحق و): كل صف يُصنَّف بpostInvoiceDoc/postStockMovement/
 * postCashTx قبل أن يغذي بنده، ولا منطق تجميع خاص بأي بند.
 */
export async function getProfitAndLoss(
  adapter: SqliteAdapter,
  opts: { from: string; to: string },
): Promise<PnlReport> {
  const { from, to } = opts;
  assertIsoDate('من', from);
  assertIsoDate('حتى', to);
  if (from > to) {
    throw new ValidationError(`بداية الفترة (${from}) بعد نهايتها (${to}) — اقلب الترتيب`);
  }

  const zero = new Decimal(0);
  const feeds = new Map<PnlFeedKey, Decimal>();
  const add = (key: PnlFeedKey, value: Decimal): void => {
    feeds.set(key, (feeds.get(key) ?? zero).plus(value));
  };

  /* ——— 1) المستندات: بيع (+) / مرتجع بيع (−) — بتواريخ إصدارها ——— */
  const invoices = await adapter.all<InvoiceFeedRow>(
    `SELECT doc_type, status, total_base FROM invoice
     WHERE issued_at >= ? AND issued_at <= ? AND status = 'completed'`,
    [from, to],
  );
  for (const inv of invoices) {
    const c = postInvoiceDoc(inv.doc_type);
    if (c.pnlFeed === 'sales' || c.pnlFeed === 'salesReturns') {
      add(c.pnlFeed, d(inv.total_base));
    }
    // شراء/مرتجع شراء: أصل — الخريطة تقول «لا بند أرباح» فلا يدخل القائمة
  }

  /* ——— 2) حركات المخزون: COGS (+) / تكلفة المرتجع (−) / زيادة/عجز الجرد ——— */
  const movements = await adapter.all<MovementFeedRow>(
    `SELECT m.movement_type, m.qty, m.unit_cost, m.ref_type,
            i.doc_type AS inv_doc_type, i.status AS inv_status
     FROM stock_movement m
     LEFT JOIN invoice i ON i.id = m.ref_id AND m.ref_type = 'invoice'
     WHERE m.moved_at >= ? AND m.moved_at <= ?`,
    [from, to],
  );
  for (const mv of movements) {
    // حركة مربوطة بفاتورة: لا تُحتسب إلا لمستند مكتمل حي (الملغاة تُستبعد بحالة
    // مستندها — وحركات معاكسة الإلغاء ref_type='invoice_void' لا تدخل أصلاً)
    const boundToInvoice = ['sale', 'sale_return', 'purchase', 'purchase_return'].includes(
      mv.movement_type,
    );
    if (boundToInvoice && !(mv.inv_status === 'completed')) {
      continue; // مسودة أو ملغاة أو مرجع مفقود — خارج القائمة الحية
    }
    const c = postStockMovement({ movementType: mv.movement_type, qty: mv.qty });
    if (c.pnlFeed === null) continue; // شراء/مرتجع شراء/افتتاحي/تحويل: أصل
    // قيمة الحركة بتكلفة اللقطة (بالأساس) — |qty| × unit_cost
    const value = roundTo(d(mv.qty).abs().times(d(mv.unit_cost)), 4);
    add(c.pnlFeed, value);
  }

  /* ——— 3) حركات الصندوق الحية: مصاريف/مسحوبات/فروق صرف — بتواريخها ——— */
  const cashRows = await adapter.all<CashFeedRow>(
    `SELECT tx_type, amount, exchange_rate, fx_gain_loss FROM cash_tx
     WHERE is_voided = 0 AND reversal_of IS NULL
       AND tx_date >= ? AND tx_date <= ?
       AND tx_type IN ${CASH_FEED_TYPES}`,
    [from, to],
  );
  for (const tx of cashRows) {
    const c = postCashTx({ txType: tx.tx_type, fxGainLoss: tx.fx_gain_loss });
    // المبلغ بالأساس بسعر الحركة المخزن (قرار 3: الأساس=1 حصراً)
    if (c.pnlFeed === 'expenses' || c.pnlFeed === 'ownerDraw') {
      add(c.pnlFeed, roundTo(d(tx.amount).times(d(tx.exchange_rate)), 4));
    }
    // capital_in: سطر رأس المال في حركة الشركة — ليس بند أرباح (ملحق و)
    if (c.fxFeed) {
      add('fxGainLoss', d(tx.fx_gain_loss)); // محزّن بالأساس جاهزاً (قرار 8)
    }
  }

  const g = (key: PnlFeedKey): Decimal => feeds.get(key) ?? zero;
  const sales = g('sales');
  const salesReturns = g('salesReturns');
  const netSales = sales.minus(salesReturns);
  const cogs = g('cogs');
  const returnsCost = g('returnsCost');
  const netCogs = cogs.minus(returnsCost);
  const surplus = g('stockSurplus');
  const shortage = g('stockShortage');
  const expenses = g('expenses');
  const fx = g('fxGainLoss');
  const ownerDraw = g('ownerDraw');

  // الصيغة الملزمة (قرار 7)
  const profit = netSales.minus(netCogs).plus(surplus).minus(shortage).minus(expenses).plus(fx);
  const netRemainingToOwner = profit.minus(ownerDraw);

  return {
    period: { from, to },
    sales: f4(sales),
    salesReturns: f4(salesReturns),
    netSales: f4(netSales),
    cogs: f4(cogs),
    returnsCost: f4(returnsCost),
    netCogs: f4(netCogs),
    stockSurplus: f4(surplus),
    stockShortage: f4(shortage),
    expenses: f4(expenses),
    fxGainLoss: f4(fx),
    profit: f4(profit),
    ownerDraw: f4(ownerDraw),
    netRemainingToOwner: f4(netRemainingToOwner),
  };
}

/* ============================ الفترات الدورية الجاهزة (FR-09-09) ============================ */

/** الفترات الجاهزة: اليوم/الأسبوع (سبت يمني)/الشهر/الربع/السنة + مخصص */
export type ReportPeriodPreset = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'custom';

export interface ReportPeriodRange {
  preset: ReportPeriodPreset;
  from: string;
  to: string;
}

/** يبدأ الأسبوع اليمني يوم **السبت** — عدد الأيام منذ السبت لِتاريخٍ ما */
function daysSinceSaturday(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return 0;
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  // الأحد=0 … السبت=6 → منذ السبت: (dow + 1) % 7 (السبت نفسه = 0)
  return (dow + 1) % 7;
}

function addDays(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const base = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  base.setUTCDate(base.getUTCDate() + days);
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${base.getUTCFullYear()}-${p(base.getUTCMonth() + 1)}-${p(base.getUTCDate())}`;
}

/**
 * يحل فترة جاهزة إلى {from, to} (نقية — today قابلة للحقن للاختبار).
 *  - week: أسبوع يبدأ **السبت** (نظام الأسبوع اليمني) وينتهي اليوم.
 *  - quarter: ربع السنة الميلادية (يناير/أبريل/يوليو/أكتوبر).
 *  - custom: يتحقق من الصيغة وأن from ≤ to.
 */
export function resolveReportPeriod(
  preset: ReportPeriodPreset,
  opts: { today?: string; from?: string; to?: string } = {},
): ReportPeriodRange {
  const today = opts.today ?? todayISO();
  assertIsoDate('اليوم', today);
  switch (preset) {
    case 'today':
      return { preset, from: today, to: today };
    case 'week':
      return { preset, from: addDays(today, -daysSinceSaturday(today)), to: today };
    case 'month': {
      const from = `${today.slice(0, 7)}-01`;
      return { preset, from, to: today };
    }
    case 'quarter': {
      const month = Number(today.slice(5, 7));
      const qStart = Math.floor((month - 1) / 3) * 3 + 1;
      const from = `${today.slice(0, 4)}-${qStart < 10 ? `0${qStart}` : qStart}-01`;
      return { preset, from, to: today };
    }
    case 'year':
      return { preset, from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'custom': {
      const from = opts.from ?? '';
      const to = opts.to ?? '';
      assertIsoDate('من', from);
      assertIsoDate('حتى', to);
      if (from > to) {
        throw new ValidationError(`بداية الفترة (${from}) بعد نهايتها (${to}) — اقلب الترتيب`);
      }
      return { preset, from, to };
    }
    default:
      throw new ValidationError(`فترة غير معروفة: ${String(preset)}`);
  }
}

/* ============================ تقرير الشيكات (FR-09-13) ============================ */

/** شيك قائم: تحت التحصيل (وارد) أو تحت السحب (صادر) */
export interface ChequeReportRow {
  id: number;
  direction: 'in' | 'out';
  chequeNo: string;
  bankName: string | null;
  amount: string;
  currencyId: number;
  currencyCode: string;
  dueDate: string;
  status: string;
  partyType: 'customer' | 'supplier';
  partyId: number;
  partyName: string | null;
}

export interface ChequesReport {
  /** واردة قائمة (pending + deposited) — تحت التحصيل */
  underCollection: ChequeReportRow[];
  /** صادرة قائمة (pending + deposited) — تحت السحب */
  underWithdrawal: ChequeReportRow[];
}

/**
 * تقرير الشيكات (FR-09-13): الواردة تحت التحصيل والصادرة تحت السحب بقيمتها
 * وعملتها وتاريخ استحقاقها، مرتبة بالاستحقاق الأقرب أولاً. قراءة مباشرة من
 * جدول cheque (القائمة = pending + deposited — cleared/bounced/void خرجت).
 */
export async function getChequesReport(adapter: SqliteAdapter): Promise<ChequesReport> {
  const rows = await adapter.all<{
    id: number;
    direction: string;
    cheque_no: string;
    bank_name: string | null;
    amount: string;
    currency_id: number;
    currency_code: string;
    due_date: string;
    status: string;
    party_type: string;
    party_id: number;
    party_name: string | null;
  }>(
    `SELECT c.id, c.direction, c.cheque_no, c.bank_name, c.amount, c.currency_id,
            cur.code AS currency_code, c.due_date, c.status, c.party_type, c.party_id,
            COALESCE(cu.name, su.name) AS party_name
     FROM cheque c
     JOIN currency cur ON cur.id = c.currency_id
     LEFT JOIN customer cu ON c.party_type = 'customer' AND cu.id = c.party_id
     LEFT JOIN supplier su ON c.party_type = 'supplier' AND su.id = c.party_id
     WHERE c.status IN ('pending', 'deposited')
     ORDER BY c.due_date ASC, c.id ASC`,
  );
  const map = (r: (typeof rows)[number]): ChequeReportRow => ({
    id: Number(r.id),
    direction: r.direction === 'out' ? 'out' : 'in',
    chequeNo: r.cheque_no,
    bankName: r.bank_name,
    amount: r.amount,
    currencyId: Number(r.currency_id),
    currencyCode: r.currency_code,
    dueDate: r.due_date,
    status: r.status,
    partyType: r.party_type === 'supplier' ? 'supplier' : 'customer',
    partyId: Number(r.party_id),
    partyName: r.party_name,
  });
  return {
    underCollection: rows.filter((r) => r.direction === 'in').map(map),
    underWithdrawal: rows.filter((r) => r.direction === 'out').map(map),
  };
}

/* ==================== الأرصدة الدائنة للعملاء (FR-09-14) ==================== */

/** عميل له رصيد دائن بعملة ما (دفع نقدياً ثم أعاد — رصيد لصالحه) */
export interface CustomerCreditBalanceRow {
  customerId: number;
  name: string;
  phone: string | null;
  currencyId: number;
  currencyCode: string;
  /** الرصيد السالب بعملته (لصالح العميل) — 4dp */
  balance: string;
}

/**
 * تقرير الأرصدة الدائنة للعملاء (FR-09-14): كل عميل له رصيد سالب بأي عملة
 * (على حدة — قرار 8) — يعاد استخدام getPartyBalanceByCurrency نفسها التي
 * تُغذي كشوف الحساب (لا معادلة ثانية). يشمل المؤرشفين: حق مالي لصالحهم
 * لا يختفي بالأرشفة (الصنيفات المؤرشفة تبقى في التقارير بالمثل — FR-01-15).
 */
export async function getCustomerCreditBalances(
  adapter: SqliteAdapter,
): Promise<CustomerCreditBalanceRow[]> {
  const customers = await adapter.all<{ id: number; name: string; phone: string | null }>(
    'SELECT id, name, phone FROM customer ORDER BY name ASC',
  );
  const out: CustomerCreditBalanceRow[] = [];
  for (const c of customers) {
    const balances = await getPartyBalanceByCurrency(adapter, 'customer', Number(c.id));
    for (const b of balances) {
      if (d(b.balance).lt(0)) {
        out.push({
          customerId: Number(c.id),
          name: c.name,
          phone: c.phone,
          currencyId: b.currencyId,
          currencyCode: b.currencyCode,
          balance: b.balance,
        });
      }
    }
  }
  return out;
}
