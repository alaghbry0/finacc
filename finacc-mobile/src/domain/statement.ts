/**
 * statement.ts — كشف حساب الطرف وأرصدته لكل عملة (FR-03-02/03/04 + قرار 8).
 *
 * معادلة الرصيد (FR-03-02 المصححة بقرار 8 — ملزمة حرفياً وتُختبر بAC-02):
 *  رصيد العميل  = Σ(مديونية آجلة بيع) − Σ(تحصيلات) − Σ(مرتجع بيع آجل) + رصيد افتتاحي
 *  رصيد المورّد  = Σ(مديونية آجلة شراء) − Σ(مدفوعات) − Σ(مرتجع شراء آجل) + رصيد افتتاحي
 *  — لكل عملة على حدة (لا تُجمع عملتان في رقم واحد أبداً — FR-08-11)، موجب = دَين
 *  على الطرف لصالح المنشأة (للعميل: عليه؛ للمورد: له)، سالب = رصيد دائن لصالح الطرف.
 *
 * مكونات «التحصيلات/المدفوعات» (سندات النقدية الحرة ref_type='on_account'):
 *  - تخصيصات payment_allocation لفواتير حية غير ملغاة: تُخصم من رصيد عملة الفاتورة
 *    نفسها بمبلغها الاسمي (عملة الفاتورة) — لذلك كشف العملة الواحدة يتوازن دائماً
 *    حتى لو حُصِّل بعملة أخرى (FR-08-10: الفرق يذهب fx_gain_loss بنداً مستقلاً
 *    في الأرباح ولا يُدفن في أي رصيد — AC-18).
 *  - الباقي «على الحساب» (بعد الفواتير المفتوحة أو بلا فواتير): يُخصم من رصيد عملة
 *    السند — الزيادة تصبح رصيداً دائناً لصالح الطرف (قبض على الحساب — FR-04-03).
 *
 * الاستبعاد الموحد للحركات الملغاة (نمط voidInvoice): is_voided = 0 AND reversal_of IS NULL
 *  — الأصل الملغى والمعاكسة كلاهما خارج الأرصدة والكشوف فيعود الرصيد تلقائياً.
 *  تخصيص السند الملغى يفك ارتباطه تلقائياً (بنوده تشير لسند is_voided=1).
 *
 * الكشف (FR-03-04): سطور مرتبة تصاعدياً بالتاريخ برصيد رأسي متحرك بعملة واحدة؛
 *  الحركات المالية بعملة أخرى تظهر فقط في كشف عملتها (سطر إرشادي يذكر وجودها)،
 *  وسطر «رصيد أول المدة» عند تحديد فترة (from) يجرّ كل ما قبله.
 */
import type { SqliteAdapter } from '../db/adapter';
import { d, f4, roundTo, sumD, Decimal } from '../utils/money';
import { DomainRuleError, ValidationError } from './errors';

/* ============================ الأنواع ============================ */

export type PartyType = 'customer' | 'supplier';

export type StatementDocKind =
  | 'opening' // رصيد افتتاحي
  | 'brought_forward' // رصيد أول المدة (عند فلترة from)
  | 'invoice' // فاتورة آجلة/مختلطة (الجزء الآجل)
  | 'return' // مرتجع آجل
  | 'receipt' // سند قبض (عميل)
  | 'payment' // سند صرف (مورّد)
  | 'note'; // سطر إرشادي (عملات أخرى) — لا يغير الرصيد

export type StatementDirection = 'debit' | 'credit' | 'none';

export interface StatementLine {
  /** YYYY-MM-DD (سطر الإرشاد يرث تاريخ آخر سطر مالي) */
  date: string;
  docKind: StatementDocKind;
  docNo: string | null;
  description: string;
  /** debit = يزيد رصيد الطرف · credit = ينقصه · none = سطر إرشادي */
  direction: StatementDirection;
  /** 4dp — صفر لسطور الإرشاد */
  amount: string;
  /** الرصيد بعد هذا السطر (4dp) */
  runningBalance: string;
}

export interface PartyCurrencyBalance {
  currencyId: number;
  currencyCode: string;
  /** + = دَين على الطرف · − = رصيد دائن لصالح الطرف (4dp) */
  balance: string;
}

export interface StatementResult {
  partyType: PartyType;
  partyId: number;
  partyName: string;
  currencyId: number;
  currencyCode: string;
  /** السطور المالية مرتبة تصاعدياً + سطر إرشادي أخيراً إن وجدت عملات أخرى */
  lines: StatementLine[];
  /** الرصيد قبل أول سطر (يشمل جرّ ما قبل from إن حُدد) — 4dp */
  openingBalance: string;
  /** الرصيد بعد آخر سطر مالي — 4dp */
  closingBalance: string;
  /** أرصدة الطرف بالعملات الأخرى غير صفرية (قرار 8: مفصولة لا مجمّعة) */
  otherCurrencies: PartyCurrencyBalance[];
}

/* ============================ بناء الحركات الداخلية ============================ */

interface OpeningData {
  date: string;
  currencyId: number;
  amount: Decimal;
}

interface InvoiceData {
  id: number;
  invoiceNo: string | null;
  payStatus: string;
  issuedAt: string;
  currencyId: number;
  dueAmount: Decimal;
  total: Decimal;
}

interface ReturnData {
  id: number;
  invoiceNo: string | null;
  issuedAt: string;
  currencyId: number;
  total: Decimal;
}

interface VoucherAllocData {
  invoiceId: number;
  invoiceNo: string | null;
  invoiceCurrencyId: number;
  /** بمبلغه الاسمي بعملة الفاتورة */
  amount: Decimal;
}

interface VoucherData {
  id: number;
  voucherNo: string | null;
  txDate: string;
  currencyId: number;
  amount: Decimal;
  exchangeRate: Decimal;
  settlementRate: Decimal | null;
  allocations: VoucherAllocData[];
  /** الباقي على الحساب بعملة السند (مشتق) */
  remainder: Decimal;
}

interface PartyMovements {
  opening: OpeningData | null;
  invoices: InvoiceData[];
  returns: ReturnData[];
  vouchers: VoucherData[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** يجمع كل حركات الطرف المعدّة للأرصدة والكشوف (استثناء موحد للملغاة والمعاكسات) */
async function buildPartyMovements(
  adapter: SqliteAdapter,
  partyType: PartyType,
  partyId: number,
): Promise<PartyMovements> {
  const table = partyType === 'customer' ? 'customer' : 'supplier';
  const partyRows = await adapter.all<{
    name: string;
    opening_balance: string | null;
    opening_balance_currency_id: number | null;
    opening_balance_date: string | null;
  }>(
    'SELECT name, opening_balance, opening_balance_currency_id, opening_balance_date FROM ' +
      table +
      ' WHERE id = ?',
    [partyId],
  );
  const party = partyRows[0];
  if (!party) {
    throw new DomainRuleError(
      'PARTY_NOT_FOUND',
      `${partyType === 'customer' ? 'العميل' : 'المورّد'} غير موجود (معرّف ${partyId})`,
    );
  }

  // رصيد افتتاحي: عملته وسعره وتاريخه (FR-03-01) — بلا عملة يُنسب للأساس
  let opening: OpeningData | null = null;
  const openingAmount = d(party.opening_balance ?? '0');
  if (!openingAmount.isZero()) {
    let ccy = party.opening_balance_currency_id;
    if (ccy === null || ccy === undefined) {
      const base = await adapter.all<{ id: number }>(
        'SELECT id FROM currency WHERE is_base = 1',
      );
      ccy = base[0] ? Number(base[0].id) : null;
    }
    if (ccy !== null) {
      opening = {
        amount: openingAmount,
        currencyId: ccy,
        date: party.opening_balance_date ?? '0000-00-00',
      };
    }
  }

  // فواتير العائلة المكتملة غير الملغاة (المديونية = due_amount: نقدي=0 تلقائياً)
  const invoiceFamily = partyType === 'customer' ? 'sale' : 'purchase';
  const partyCol = partyType === 'customer' ? 'customer_id' : 'supplier_id';
  const invoiceRows = await adapter.all<{
    id: number;
    invoice_no: string | null;
    pay_status: string;
    issued_at: string;
    currency_id: number;
    total: string;
    due_amount: string;
  }>(
    `SELECT id, invoice_no, pay_status, issued_at, currency_id, total, due_amount
     FROM invoice
     WHERE doc_type = ? AND status = 'completed' AND ${partyCol} = ?
     ORDER BY issued_at ASC, id ASC`,
    [invoiceFamily, partyId],
  );
  const invoices: InvoiceData[] = invoiceRows.map((r) => ({
    id: Number(r.id),
    invoiceNo: r.invoice_no,
    payStatus: r.pay_status,
    issuedAt: r.issued_at,
    currencyId: Number(r.currency_id),
    dueAmount: d(r.due_amount),
    total: d(r.total),
  }));

  // مرتجعات آجلة (على الحساب) — النقدية منها بلا أثر على رصيد الطرف
  const returnFamily = partyType === 'customer' ? 'sale_return' : 'purchase_return';
  const returnRows = await adapter.all<{
    id: number;
    invoice_no: string | null;
    issued_at: string;
    currency_id: number;
    total: string;
  }>(
    `SELECT id, invoice_no, issued_at, currency_id, total
     FROM invoice
     WHERE doc_type = ? AND status = 'completed' AND pay_status = 'credit' AND ${partyCol} = ?
     ORDER BY issued_at ASC, id ASC`,
    [returnFamily, partyId],
  );
  const returns: ReturnData[] = returnRows.map((r) => ({
    id: Number(r.id),
    invoiceNo: r.invoice_no,
    issuedAt: r.issued_at,
    currencyId: Number(r.currency_id),
    total: d(r.total),
  }));

  // سندات النقدية الحرة للطرف (قبض للعميل / صرف للمورّد) — حية فقط
  const voucherTxType = partyType === 'customer' ? 'receipt' : 'payment';
  const voucherRows = await adapter.all<{
    id: number;
    voucher_no: string | null;
    tx_date: string;
    currency_id: number;
    amount: string;
    exchange_rate: string;
    settlement_rate: string | null;
  }>(
    `SELECT id, voucher_no, tx_date, currency_id, amount, exchange_rate, settlement_rate
     FROM cash_tx
     WHERE tx_type = ? AND ref_type = 'on_account' AND ${partyCol} = ?
       AND is_voided = 0 AND reversal_of IS NULL
     ORDER BY tx_date ASC, id ASC`,
    [voucherTxType, partyId],
  );

  // تخصيصات تلك السندات لفواتير حية (الفاتورة الملغاة → تخصيصها يذوب في «على الحساب»)
  const allocRows = await adapter.all<{
    cash_tx_id: number;
    invoice_id: number;
    invoice_no: string | null;
    invoice_currency_id: number;
    invoice_status: string;
    allocated_amount: string;
  }>(
    `SELECT pa.cash_tx_id, pa.invoice_id, pa.allocated_amount,
            i.invoice_no, i.currency_id AS invoice_currency_id, i.status AS invoice_status
     FROM payment_allocation pa
     JOIN cash_tx ct ON ct.id = pa.cash_tx_id
     JOIN invoice i ON i.id = pa.invoice_id
     WHERE ct.tx_type = ? AND ct.${partyCol} = ?
       AND ct.is_voided = 0 AND ct.reversal_of IS NULL`,
    [voucherTxType, partyId],
  );
  const allocsByTx = new Map<number, VoucherAllocData[]>();
  for (const a of allocRows) {
    if (a.invoice_status !== 'completed') continue; // فاتورة ملغاة: لا تُخصم من رصيد الفاتورة
    const list = allocsByTx.get(Number(a.cash_tx_id)) ?? [];
    list.push({
      invoiceId: Number(a.invoice_id),
      invoiceNo: a.invoice_no,
      invoiceCurrencyId: Number(a.invoice_currency_id),
      amount: d(a.allocated_amount),
    });
    allocsByTx.set(Number(a.cash_tx_id), list);
  }

  const vouchers: VoucherData[] = voucherRows.map((v) => {
    const rate = d(v.exchange_rate);
    const settle = v.settlement_rate !== null ? d(v.settlement_rate) : null;
    const allocations = allocsByTx.get(Number(v.id)) ?? [];
    // قيمة التخصيصات بالأساس: نفس العملة بسعر السند، وإلا بسعر يوم الدفع (قرار 8)
    const allocBase = sumD(
      allocations.map((a) =>
        a.invoiceCurrencyId === Number(v.currency_id)
          ? a.amount.times(rate)
          : a.amount.times(settle ?? rate),
      ),
    );
    const remainder = roundTo(d(v.amount).minus(allocBase.div(rate)), 4);
    return {
      id: Number(v.id),
      voucherNo: v.voucher_no,
      txDate: v.tx_date,
      currencyId: Number(v.currency_id),
      amount: d(v.amount),
      exchangeRate: rate,
      settlementRate: settle,
      allocations,
      remainder,
    };
  });

  return { opening, invoices, returns, vouchers };
}

/** خريطة رصيد الطرف لكل عملة من الحركات (المصدر الوحيد للحقيقة لكلا الدالتين) —
 *  لا إعادة تقييم للأرصدة الأجنبية في V1 (قرار 8 موثق صراحة) */
function balancesFromMovements(mov: PartyMovements): Map<number, Decimal> {
  const map = new Map<number, Decimal>();
  const add = (ccy: number, delta: Decimal): void => {
    map.set(ccy, (map.get(ccy) ?? new Decimal(0)).plus(delta));
  };
  if (mov.opening) {
    add(mov.opening.currencyId, mov.opening.amount);
  }
  for (const inv of mov.invoices) {
    if (!inv.dueAmount.isZero()) add(inv.currencyId, inv.dueAmount); // مديونية آجلة
  }
  for (const ret of mov.returns) {
    add(ret.currencyId, ret.total.neg()); // مرتجع آجل ينقص
  }
  for (const v of mov.vouchers) {
    for (const a of v.allocations) {
      add(a.invoiceCurrencyId, a.amount.neg()); // التحصيل يخصم من رصيد عملة الفاتورة
    }
    if (!v.remainder.isZero()) {
      add(v.currencyId, v.remainder.neg()); // الباقي على الحساب بعملة السند
    }
  }
  return map;
}

async function currencyCodes(
  adapter: SqliteAdapter,
  ids: number[],
): Promise<Map<number, { code: string; name: string }>> {
  const map = new Map<number, { code: string; name: string }>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await adapter.all<{ id: number; code: string; name: string }>(
    `SELECT id, code, name FROM currency WHERE id IN (${placeholders})`,
    ids,
  );
  for (const r of rows) map.set(Number(r.id), { code: r.code, name: r.name });
  return map;
}

/* ==================== الرصيد لكل عملة (FR-03-02 / FR-08-11) ==================== */

/**
 * رصيد الطرف لكل عملة على حدة (قرار 8 — لا تجميع أبداً):
 *  رصيد = Σ(آجل) − Σ(تحصيلات/مدفوعات) − Σ(مرتجع آجل) + رصيد افتتاحي.
 * موجب = دَين على الطرف · سالب = رصيد دائن لصالح الطرف · الصفرية تُستبعد.
 */
export async function getPartyBalanceByCurrency(
  adapter: SqliteAdapter,
  partyType: PartyType,
  partyId: number,
): Promise<PartyCurrencyBalance[]> {
  const mov = await buildPartyMovements(adapter, partyType, partyId);
  const map = balancesFromMovements(mov);
  const codes = await currencyCodes(adapter, [...map.keys()]);
  const out: PartyCurrencyBalance[] = [];
  for (const [ccyId, bal] of map) {
    if (bal.isZero()) continue;
    const cur = codes.get(ccyId);
    out.push({
      currencyId: ccyId,
      currencyCode: cur?.code ?? String(ccyId),
      balance: f4(bal),
    });
  }
  out.sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
  return out;
}

/* ==================== سطور كشف الحساب (FR-03-04) ==================== */

/** سطر خام قبل الفرز والترصيد */
interface RawLine {
  date: string;
  docKind: StatementDocKind;
  docNo: string | null;
  description: string;
  direction: StatementDirection;
  amount: Decimal;
  /** ترتيب مستقر داخل اليوم: افتتاحي → فواتير → مرتجعات → سندات */
  rank: number;
  seq: number;
}

const KIND_RANK: Record<string, number> = {
  opening: 0,
  brought_forward: 0,
  invoice: 1,
  return: 2,
  receipt: 3,
  payment: 3,
  note: 4,
};

/**
 * سطور كشف حساب الطرف بعملة واحدة مع رصيد رأسي متحرك (FR-03-04):
 *  - السطور المالية بعملة الكشف فقط + الرصيد الافتتاحي بها (قرار 8:
 *    الكشف بعملة واحدة يتوازن دائماً — فروق الصرف لا تُدفن فيه).
 *  - الحركات بعملات أخرى: سطر إرشادي أخيراً + قائمة otherCurrencies.
 *  - from: يجرّ كل ما قبله في سطر «رصيد أول المدة»؛ to: يقفل عند تاريخه.
 *  - الترتيب: التاريخ تصاعدياً، ثم افتتاحي/فواتير/مرتجعات/سندات داخل اليوم.
 */
export async function getStatementLines(
  adapter: SqliteAdapter,
  partyType: PartyType,
  partyId: number,
  currencyId: number,
  opts: { from?: string; to?: string } = {},
): Promise<StatementResult> {
  for (const [label, value] of [
    ['from', opts.from],
    ['to', opts.to],
  ] as const) {
    if (value !== undefined && !ISO_DATE.test(value)) {
      throw new ValidationError(`تاريخ ${label} غير صالح (المتوقع YYYY-MM-DD): ${value}`);
    }
  }

  const mov = await buildPartyMovements(adapter, partyType, partyId);
  const codes = await currencyCodes(adapter, [currencyId]);
  const cur = codes.get(currencyId);
  if (!cur) {
    throw new DomainRuleError('CURRENCY_NOT_FOUND', `العملة غير موجودة (معرّف ${currencyId})`);
  }
  const isCustomer = partyType === 'customer';
  const partyNameRows = await adapter.all<{ name: string }>(
    `SELECT name FROM ${isCustomer ? 'customer' : 'supplier'} WHERE id = ?`,
    [partyId],
  );

  const raw: RawLine[] = [];
  let seq = 0;
  const push = (l: Omit<RawLine, 'seq'>): void => {
    raw.push({ ...l, seq: seq++ });
  };

  // 1) الرصيد الافتتاحي بعملة الكشف
  if (mov.opening && mov.opening.currencyId === currencyId) {
    push({
      date: mov.opening.date === '0000-00-00' ? '0000-00-00' : mov.opening.date,
      docKind: 'opening',
      docNo: null,
      description: 'رصيد افتتاحي',
      direction: 'debit',
      amount: mov.opening.amount,
      rank: KIND_RANK.opening,
    });
  }

  // 2) الفواتير: المديونية الآجلة (نقدي = صفر فلا سطر؛ مختلط = الجزء الآجل فقط)
  for (const inv of mov.invoices) {
    if (inv.currencyId !== currencyId || inv.dueAmount.isZero()) continue;
    const kindWord = isCustomer ? 'بيع' : 'شراء';
    const desc =
      inv.payStatus === 'mixed'
        ? `فاتورة ${kindWord} مختلطة ${inv.invoiceNo ?? ''} (الجزء الآجل)`.trim()
        : `فاتورة ${kindWord} آجلة ${inv.invoiceNo ?? ''}`.trim();
    push({
      date: inv.issuedAt,
      docKind: 'invoice',
      docNo: inv.invoiceNo,
      description: desc,
      direction: 'debit',
      amount: inv.dueAmount,
      rank: KIND_RANK.invoice,
    });
  }

  // 3) المرتجعات الآجلة (تنقص الرصيد — AC-02)
  for (const ret of mov.returns) {
    if (ret.currencyId !== currencyId) continue;
    const kindWord = isCustomer ? 'بيع' : 'شراء';
    push({
      date: ret.issuedAt,
      docKind: 'return',
      docNo: ret.invoiceNo,
      description: `مرتجع ${kindWord} آجل ${ret.invoiceNo ?? ''}`.trim(),
      direction: 'credit',
      amount: ret.total,
      rank: KIND_RANK.return,
    });
  }

  // 4) السندات: تخصيصاتها بعملة الفاتورة + باقيها على الحساب بعملة السند
  for (const v of mov.vouchers) {
    for (const a of v.allocations) {
      if (a.invoiceCurrencyId !== currencyId) continue;
      const vword = isCustomer ? 'قبض' : 'صرف';
      push({
        date: v.txDate,
        docKind: isCustomer ? 'receipt' : 'payment',
        docNo: v.voucherNo,
        description: `سند ${vword} ${v.voucherNo ?? `#${v.id}`} — تخصيص لفاتورة ${a.invoiceNo ?? a.invoiceId}`,
        direction: 'credit',
        amount: a.amount,
        rank: KIND_RANK[isCustomer ? 'receipt' : 'payment'],
      });
    }
    if (v.currencyId === currencyId && !v.remainder.isZero()) {
      const vword = isCustomer ? 'قبض' : 'صرف';
      push({
        date: v.txDate,
        docKind: isCustomer ? 'receipt' : 'payment',
        docNo: v.voucherNo,
        description: `سند ${vword} على الحساب ${v.voucherNo ?? `#${v.id}`}`,
        direction: 'credit',
        amount: v.remainder,
        rank: KIND_RANK[isCustomer ? 'receipt' : 'payment'],
      });
    }
  }

  raw.sort((a, b) =>
    a.date === b.date
      ? a.rank - b.rank || a.seq - b.seq
      : a.date < b.date
        ? -1
        : 1,
  );

  // 5) فلترة الفترة + سطر «رصيد أول المدة» عند from
  const inPeriod = raw.filter(
    (l) =>
      (opts.from === undefined || l.date >= opts.from) &&
      (opts.to === undefined || l.date <= opts.to),
  );
  const before = raw.filter((l) => opts.from !== undefined && l.date < opts.from);
  const openingBefore = sumD(before.map((l) => (l.direction === 'debit' ? l.amount : l.amount.neg())));

  const lines: StatementLine[] = [];
  let running = openingBefore;
  if (opts.from !== undefined && !openingBefore.isZero()) {
    lines.push({
      date: opts.from,
      docKind: 'brought_forward',
      docNo: null,
      description: 'رصيد أول المدة',
      direction: openingBefore.gt(0) ? 'debit' : 'credit',
      amount: f4(openingBefore.abs()),
      runningBalance: f4(running),
    });
  } else if (opts.from !== undefined) {
    // رصيد أول المدة صفر — يبدأ الكشف من الصفر بلا سطر
  }

  for (const l of inPeriod) {
    running = l.direction === 'debit' ? running.plus(l.amount) : running.minus(l.amount);
    lines.push({
      date: l.date === '0000-00-00' ? opts.from ?? '0000-00-00' : l.date,
      docKind: l.docKind,
      docNo: l.docNo,
      description: l.description,
      direction: l.direction,
      amount: f4(l.amount),
      runningBalance: f4(running),
    });
  }

  // 6) العملات الأخرى غير الصفرية — سطر إرشادي لا يغير الرصيد (قرار 8)
  const map = balancesFromMovements(mov);
  const otherCurrencies: PartyCurrencyBalance[] = [];
  const otherCodes = await currencyCodes(adapter, [...map.keys()]);
  for (const [ccyId, bal] of map) {
    if (ccyId === currencyId || bal.isZero()) continue;
    const c = otherCodes.get(ccyId);
    otherCurrencies.push({
      currencyId: ccyId,
      currencyCode: c?.code ?? String(ccyId),
      balance: f4(bal),
    });
  }
  otherCurrencies.sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
  if (otherCurrencies.length > 0) {
    const last = lines.length > 0 ? lines[lines.length - 1]! : null;
    lines.push({
      date: last ? last.date : opts.from ?? new Date().toISOString().slice(0, 10),
      docKind: 'note',
      docNo: null,
      description: `لدى الطرف أرصدة بعملات أخرى (${otherCurrencies
        .map((c) => c.currencyCode)
        .join('، ')}) — بدّل عملة الكشف لعرضها`,
      direction: 'none',
      amount: '0.0000',
      runningBalance: last ? last.runningBalance : f4(running),
    });
  }

  return {
    partyType,
    partyId,
    partyName: partyNameRows[0]?.name ?? '',
    currencyId,
    currencyCode: cur.code,
    lines,
    openingBalance: f4(openingBefore),
    closingBalance: f4(running),
    otherCurrencies,
  };
}
