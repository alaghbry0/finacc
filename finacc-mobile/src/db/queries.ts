/**
 * queries.ts — استعلامات قراءة مستوى الشاشة (الداشبورد/النقدية) — قراءة فقط.
 *
 * القواعد:
 *  - لا كتابة هنا أبداً ولا منطق أعمال — ذلك حكر Domain (NFR-09/11).
 *  - المبالغ أعمدة TEXT: تُجمَع بـ Decimal في الذاكرة (لا CAST AS REAL) —
 *    دقة مضمونة حتى 50 ألف فاتورة (NFR-03). العرض النهائي نص منسَّق.
 *  - صافي الصندوق يُحسب **بعملة المنشأة فقط** (WHERE currency_id = عملة الشركة)
 *    — جمع عملات مختلفة في رقم واحد فساد محاسبي؛ التجميع متعدد العملة لمرحلة
 *    الشاشة الكاملة للنقدية.
 *  - التحويلات البينية/البنكية محايدة على مستوى كل الصناديق فتُستثنى.
 */
import type { SqliteAdapter } from './adapter';
import { d, f3, f4, sumD } from '@/utils/money';
import { addDaysISO, todayISO } from '@/utils/format';

/* ============ الأنواع ============ */

/** يقرأ عمود منازل عملة نصياً — 0 قيمة صالحة (YER) لا تسقط إلى 2 */
function parseDecimals(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

export interface CompanyProfile {
  id: number;
  name: string;
  phone: string | null;
  /** معرّف عملة المنشأة (لربط استعلامات الصندوق) */
  currencyId: number;
  /** رمز عملة المنشأة (YER…) */
  currencyCode: string;
  /** منازل عملة العرض (YER=0) */
  currencyDecimals: number;
}

export interface DashboardStats {
  /** Σ total لفواتير بيع اليوم المكتملة */
  salesTotal: string;
  /** Σ total − Σ cost_total لنفس المجموعة */
  profitTotal: string;
  /** عدد الفواتير */
  invoiceCount: number;
  /** صافي الصندوق اليوم بعملة المنشأة (وارد − صادر) */
  cashNet: string;
}

export interface DashboardAlerts {
  /** أقساط بتاريخ استحقاق اليوم غير المسددة */
  installmentsDue: number;
  /** أقساط غير مسددة تستحق خلال الأسبوع القادم (بعد اليوم — اليوم له عدّاده) */
  installmentsDueThisWeek: number;
  /** أصناف تحت الحد الأدنى (بأرصدة كل المخازن مجمعة) */
  lowStock: number;
  /** شيكات قائمة تستحق خلال 7 أيام */
  chequesDueSoon: number;
  /** شيكات مرتدة — تنبيه بارز في الداشبورد (FR-14-04) */
  bouncedCheques: number;
}

export interface SparkDay {
  /** YYYY-MM-DD */
  day: string;
  /** إجمالي مبيعات اليوم */
  total: string;
}

export interface DashboardData {
  company: CompanyProfile | null;
  stats: DashboardStats;
  alerts: DashboardAlerts;
  /** آخر 30 يوماً تصاعدياً (اليوم آخر عنصر) */
  spark: SparkDay[];
}

/* ============ الشركة ============ */

const COMPANY_SQL = `
  SELECT c.id, c.name, c.phone, c.currency_id,
         cur.code  AS currency_code,
         cur.decimals AS currency_decimals
  FROM company c
  JOIN currency cur ON cur.id = c.currency_id
  ORDER BY c.id
  LIMIT 1`;

type CompanyRow = {
  id: number;
  name: string;
  phone: string | null;
  currency_id: number;
  currency_code: string;
  currency_decimals: number;
};

export async function fetchCompanyProfile(adapter: SqliteAdapter): Promise<CompanyProfile | null> {
  const rows = await adapter.all<CompanyRow>(COMPANY_SQL);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    currencyId: Number(row.currency_id),
    currencyCode: row.currency_code,
    currencyDecimals: parseDecimals(row.currency_decimals),
  };
}

/* ============ إحصاءات اليوم ============ */

/** فواتير البيع المكتملة في نطاق يوم (خام) */
async function fetchTodaySales(adapter: SqliteAdapter, day: string) {
  const next = addDaysISO(day, 1);
  return adapter.all<{ total: string; cost_total: string }>(
    `SELECT total, cost_total FROM invoice
     WHERE doc_type = 'sale' AND status = 'completed'
       AND issued_at >= ? AND issued_at < ?`,
    [day, next],
  );
}

/** الوارد − الصادر لليوم بعملة المنشأة — بلا كتابة ولا Float */
export async function fetchTodayCashNet(
  adapter: SqliteAdapter,
  companyCurrencyId: number | null,
  day = todayISO(),
): Promise<string> {
  if (companyCurrencyId === null) return '0';
  const rows = await adapter.all<{ tx_type: string; amount: string }>(
    `SELECT tx_type, amount FROM cash_tx
     WHERE tx_date = ? AND is_voided = 0 AND currency_id = ?`,
    [day, companyCurrencyId],
  );
  // معادلة الوردية 5.4 (مختصرة لأنواع الوارد اليومي):
  // قبض/إيداع مالك/رصيد افتتاحي = وارد؛ صرف/مصروف/مسحوبات = صادر؛ التحويلات محايدة.
  let net = d(0);
  for (const r of rows) {
    const amt = d(r.amount);
    if (r.tx_type === 'receipt' || r.tx_type === 'capital_in' || r.tx_type === 'opening') {
      net = net.plus(amt);
    } else if (r.tx_type === 'payment' || r.tx_type === 'expense' || r.tx_type === 'owner_draw') {
      net = net.minus(amt);
    }
  }
  return f4(net);
}

async function fetchStats(adapter: SqliteAdapter, day: string, companyCurrencyId: number | null): Promise<DashboardStats> {
  const [sales, cashNet] = await Promise.all([
    fetchTodaySales(adapter, day),
    fetchTodayCashNet(adapter, companyCurrencyId, day),
  ]);
  const salesSum = sumD(sales.map((r) => r.total));
  const costSum = sumD(sales.map((r) => r.cost_total));
  return {
    salesTotal: f4(salesSum),
    profitTotal: f4(salesSum.minus(costSum)),
    invoiceCount: sales.length,
    cashNet,
  };
}

/* ============ التنبيهات ============ */

async function fetchAlerts(adapter: SqliteAdapter, day: string): Promise<DashboardAlerts> {
  const weekAhead = addDaysISO(day, 7);
  const [installments, installmentsWeek, lowStock, cheques, bounced] = await Promise.all([
    adapter.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM installment
       WHERE due_date = ? AND status IN ('pending','partial','late')`,
      [day],
    ),
    adapter.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM installment i
       JOIN installment_plan p ON p.id = i.plan_id
       WHERE i.status IN ('pending','partial') AND p.status != 'cancelled'
         AND i.due_date > ? AND i.due_date <= ?`,
      [day, weekAhead],
    ),
    adapter.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM product p
       WHERE p.is_service = 0 AND p.is_archived = 0 AND CAST(p.min_stock AS REAL) > 0
         AND COALESCE((
               SELECT SUM(CAST(sl.qty AS REAL)) FROM stock_level sl WHERE sl.product_id = p.id
             ), 0) < CAST(p.min_stock AS REAL)`,
    ),
    adapter.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM cheque
       WHERE status IN ('pending','deposited') AND due_date >= ? AND due_date <= ?`,
      [day, weekAhead],
    ),
    adapter.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM cheque WHERE status = 'bounced'`,
    ),
  ]);
  return {
    installmentsDue: Number(installments[0]?.c ?? 0),
    installmentsDueThisWeek: Number(installmentsWeek[0]?.c ?? 0),
    lowStock: Number(lowStock[0]?.c ?? 0),
    chequesDueSoon: Number(cheques[0]?.c ?? 0),
    bouncedCheques: Number(bounced[0]?.c ?? 0),
  };
}

/* ============ رسم 30 يوماً ============ */

async function fetchSpark(adapter: SqliteAdapter, day: string): Promise<SparkDay[]> {
  const since = addDaysISO(day, -29);
  const rows = await adapter.all<{ issued_at: string; total: string }>(
    `SELECT issued_at, total FROM invoice
     WHERE doc_type = 'sale' AND status='completed' AND issued_at >= ?
     ORDER BY issued_at`,
    [since],
  );
  const byDay = new Map<string, ReturnType<typeof d>>();
  for (const r of rows) {
    const key = (r.issued_at ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const prev = byDay.get(key) ?? d(0);
    byDay.set(key, prev.plus(d(r.total)));
  }
  const out: SparkDay[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const key = addDaysISO(day, -i);
    out.push({ day: key, total: f4(byDay.get(key) ?? d(0)) });
  }
  return out;
}

/* ============ مجمع الشاشة ============ */

export async function loadDashboard(adapter: SqliteAdapter, day = todayISO()): Promise<DashboardData> {
  const company = await fetchCompanyProfile(adapter);
  const [stats, alerts, spark] = await Promise.all([
    fetchStats(adapter, day, company ? company.currencyId : null),
    fetchAlerts(adapter, day),
    fetchSpark(adapter, day),
  ]);
  return { company, stats, alerts, spark };
}

/** مجمع خفيف لتبويب النقدية (صافي اليوم + اسم العملة) */
export async function loadTodayCashSummary(
  adapter: SqliteAdapter,
  day = todayISO(),
): Promise<{ company: CompanyProfile | null; cashNet: string }> {
  const company = await fetchCompanyProfile(adapter);
  const cashNet = await fetchTodayCashNet(
    adapter,
    company ? company.currencyId : null,
    day,
  );
  return { company, cashNet };
}

/* ================================================================
 *  استعلامات شاشات البيانات المرجعية (المهمة 6-a) — قراءة فقط.
 *  لا كتابة هنا: الإنشاء/التعديل حكر دوال Domain (products/parties).
 * ================================================================ */

/* ============ عملات ============ */

/** عملة خفيفة للعرض (مفاتيح + منازل) */
export interface CurrencyLite {
  id: number;
  code: string;
  name: string;
  decimals: number;
  isBase: boolean;
}

/** العملة الأساسية (YER عادة) — null قبل التهيئة */
export async function fetchBaseCurrency(adapter: SqliteAdapter): Promise<CurrencyLite | null> {
  const rows = await adapter.all<{
    id: number;
    code: string;
    name: string;
    decimals: number;
  }>('SELECT id, code, name, decimals FROM currency WHERE is_base = 1 LIMIT 1');
  const r = rows[0];
  return r
    ? { id: Number(r.id), code: r.code, name: r.name, decimals: parseDecimals(r.decimals), isBase: true }
    : null;
}

/** العملات المفعّلة (الأساس أولاً ثم بالاسم) — لمنتقي عملة الرصيد الافتتاحي */
export async function listActiveCurrencies(adapter: SqliteAdapter): Promise<CurrencyLite[]> {
  const rows = await adapter.all<{
    id: number;
    code: string;
    name: string;
    decimals: number;
    is_base: number;
  }>(
    'SELECT id, code, name, decimals, is_base FROM currency WHERE is_active = 1 ORDER BY is_base DESC, code',
  );
  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    decimals: parseDecimals(r.decimals),
    isBase: Number(r.is_base) === 1,
  }));
}

/* ============ مرجعيات الأصناف ============ */

export interface RefRow {
  id: number;
  name: string;
  isDefault?: boolean;
}

/** فئات الأصناف النشطة (بلا شجرة في V1 — مستوى واحد) */
export async function listCategories(adapter: SqliteAdapter): Promise<RefRow[]> {
  const rows = await adapter.all<{ id: number; name: string }>(
    'SELECT id, name FROM category WHERE is_archived = 0 ORDER BY name',
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

/** وحدات القياس النشطة — على رأسها وحدة التهيئة «قطعة» */
export async function listUnits(adapter: SqliteAdapter): Promise<RefRow[]> {
  const rows = await adapter.all<{ id: number; name: string }>(
    'SELECT id, name FROM unit WHERE is_archived = 0 ORDER BY id',
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

/** المخازن النشطة — الافتراضي أولاً */
export async function listWarehouses(adapter: SqliteAdapter): Promise<RefRow[]> {
  const rows = await adapter.all<{ id: number; name: string; is_default: number }>(
    'SELECT id, name, is_default FROM warehouse WHERE is_archived = 0 ORDER BY is_default DESC, id',
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, isDefault: Number(r.is_default) === 1 }));
}

/** كل الباركودات المحجوزة (شاملة المؤرشفة — FR-01-01) لمعاينة التوليد */
export async function fetchAllBarcodes(adapter: SqliteAdapter): Promise<Set<string>> {
  const rows = await adapter.all<{ barcode: string }>(
    'SELECT barcode FROM product WHERE barcode IS NOT NULL',
  );
  return new Set(rows.map((r) => r.barcode));
}

/* ============ قائمة الأصناف (تفاصيل العرض) ============ */

export interface ProductListDetail {
  stockTotal: string;
  /** سعر البيع بالعملة الأساسية (retail) — null إن لم يُسجَّل */
  basePrice: string | null;
}

/**
 * تفاصيل صفوف قائمة الأصناف: مجموع الرصيد (كل المخازن، Decimal في الذاكرة)
 * + سعر التجزئة بعملة الأساس. البحث/الترتيب نفسه يأتي من domain.listProducts.
 */
export async function fetchProductListDetails(
  adapter: SqliteAdapter,
  productIds: number[],
  baseCurrencyId: number,
): Promise<Map<number, ProductListDetail>> {
  const out = new Map<number, ProductListDetail>();
  if (productIds.length === 0) return out;
  const ids = productIds.map((id) => Number(id)).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const [stocks, prices] = await Promise.all([
    adapter.all<{ product_id: number; qty: string }>(
      `SELECT product_id, qty FROM stock_level WHERE product_id IN (${placeholders})`,
      ids,
    ),
    adapter.all<{ product_id: number; price: string }>(
      `SELECT product_id, price FROM product_price
       WHERE currency_id = ? AND price_level = 'retail' AND product_id IN (${placeholders})`,
      [baseCurrencyId, ...ids],
    ),
  ]);
  const stockSums = new Map<number, ReturnType<typeof d>>();
  for (const r of stocks) {
    const key = Number(r.product_id);
    stockSums.set(key, (stockSums.get(key) ?? d(0)).plus(d(r.qty)));
  }
  const priceMap = new Map<number, string>();
  for (const r of prices) priceMap.set(Number(r.product_id), r.price);
  for (const id of ids) {
    out.set(id, {
      stockTotal: f3(stockSums.get(id) ?? d(0)),
      basePrice: priceMap.get(id) ?? null,
    });
  }
  return out;
}

/* ============ بطاقة الصنف ============ */

/** رصيد الصنف في كل مخزن له صف (مجموع الصف = الرصيد الكلي) */
export interface WarehouseStock {
  warehouseId: number;
  warehouseName: string;
  qty: string;
}

export async function fetchProductStockByWarehouse(
  adapter: SqliteAdapter,
  productId: number,
): Promise<WarehouseStock[]> {
  const rows = await adapter.all<{ warehouse_id: number; name: string; qty: string }>(
    `SELECT sl.warehouse_id, w.name, sl.qty
     FROM stock_level sl JOIN warehouse w ON w.id = sl.warehouse_id
     WHERE sl.product_id = ?
     ORDER BY w.is_default DESC, w.name`,
    [productId],
  );
  return rows.map((r) => ({
    warehouseId: Number(r.warehouse_id),
    warehouseName: r.name,
    qty: r.qty,
  }));
}

/** آخر حركات الصنف (10 افتراضياً) — الأحدث أولاً */
export interface MovementRow {
  id: number;
  movementType: string;
  qty: string;
  unitCost: string;
  movedAt: string;
  warehouseName: string;
  refType: string | null;
  refId: number | null;
}

export async function fetchProductMovements(
  adapter: SqliteAdapter,
  productId: number,
  limit = 10,
): Promise<MovementRow[]> {
  const rows = await adapter.all<{
    id: number;
    movement_type: string;
    qty: string;
    unit_cost: string;
    moved_at: string;
    warehouse: string;
    ref_type: string | null;
    ref_id: number | null;
  }>(
    `SELECT m.id, m.movement_type, m.qty, m.unit_cost, m.moved_at, w.name AS warehouse,
            m.ref_type, m.ref_id
     FROM stock_movement m JOIN warehouse w ON w.id = m.warehouse_id
     WHERE m.product_id = ?
     ORDER BY m.moved_at DESC, m.id DESC
     LIMIT ${Math.min(Math.max(limit, 1), 50)}`,
    [productId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    movementType: r.movement_type,
    qty: r.qty,
    unitCost: r.unit_cost,
    movedAt: r.moved_at,
    warehouseName: r.warehouse,
    refType: r.ref_type,
    refId: r.ref_id === null ? null : Number(r.ref_id),
  }));
}

/** بيانات بطاقة الصنف غير المتوفرة في domain.getProduct: أسماء المرجعيات + التواريخ */
export interface ProductMeta {
  categoryName: string | null;
  unitName: string | null;
  createdAt: string | null;
  /** هل للصنف حركات/بنود فواتير؟ (قفل تعديل التكلفة وقلب الخدمية) */
  hasMovements: boolean;
}

export async function fetchProductMeta(
  adapter: SqliteAdapter,
  productId: number,
): Promise<ProductMeta> {
  const prodRows = await adapter.all<{
    category_id: number | null;
    unit_id: number | null;
    created_at: string | null;
  }>('SELECT category_id, unit_id, created_at FROM product WHERE id = ?', [productId]);
  const prod = prodRows[0];
  const categoryId = prod?.category_id ?? null;
  const unitId = prod?.unit_id ?? null;
  const [cat, unit, moves, items] = await Promise.all([
    categoryId !== null
      ? adapter.all<{ name: string }>('SELECT name FROM category WHERE id = ?', [categoryId])
      : Promise.resolve([] as { name: string }[]),
    unitId !== null
      ? adapter.all<{ name: string }>('SELECT name FROM unit WHERE id = ?', [unitId])
      : Promise.resolve([] as { name: string }[]),
    adapter.all<{ c: number }>('SELECT COUNT(*) AS c FROM stock_movement WHERE product_id = ?', [
      productId,
    ]),
    adapter.all<{ c: number }>('SELECT COUNT(*) AS c FROM invoice_item WHERE product_id = ?', [
      productId,
    ]),
  ]);
  return {
    categoryName: cat[0]?.name ?? null,
    unitName: unit[0]?.name ?? null,
    createdAt: prod?.created_at ?? null,
    hasMovements: Number(moves[0]?.c ?? 0) > 0 || Number(items[0]?.c ?? 0) > 0,
  };
}

/* ============ فواتير الطرف (ملف العميل/المورد) ============ */

export interface PartyInvoiceRow {
  id: number;
  invoiceNo: string | null;
  docType: string;
  payStatus: string;
  status: string;
  issuedAt: string;
  total: string;
  currencyCode: string;
  currencyDecimals: number;
}

/** فواتير العميل (أو المورد) — الأحدث أولاً، بعملة كل فاتورة */
export async function fetchPartyInvoices(
  adapter: SqliteAdapter,
  opts: { customerId?: number; supplierId?: number; limit?: number },
): Promise<PartyInvoiceRow[]> {
  const where =
    opts.customerId !== undefined
      ? 'i.customer_id = ?'
      : opts.supplierId !== undefined
        ? 'i.supplier_id = ?'
        : null;
  if (where === null) return [];
  const partyId = opts.customerId ?? opts.supplierId;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await adapter.all<{
    id: number;
    invoice_no: string | null;
    doc_type: string;
    pay_status: string;
    status: string;
    issued_at: string;
    total: string;
    currency_code: string;
    currency_decimals: number;
  }>(
    `SELECT i.id, i.invoice_no, i.doc_type, i.pay_status, i.status, i.issued_at, i.total,
            c.code AS currency_code, c.decimals AS currency_decimals
     FROM invoice i JOIN currency c ON c.id = i.currency_id
     WHERE ${where}
     ORDER BY i.issued_at DESC, i.id DESC
     LIMIT ${limit}`,
    [partyId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    invoiceNo: r.invoice_no,
    docType: r.doc_type,
    payStatus: r.pay_status,
    status: r.status,
    issuedAt: r.issued_at,
    total: r.total,
    currencyCode: r.currency_code,
    currencyDecimals: parseDecimals(r.currency_decimals),
  }));
}

/* ================================================================
 *  استعلامات شاشة البيع وقوائم الفواتير (المهمة 6-b) — قراءة فقط.
 *  نفس قواعد القسم أعلاه: Decimal في الذاكرة، لا CAST في المجاميع،
 *  ولا كتابة — الحفظ عبر domain.saveInvoice حصراً.
 * ================================================================ */

/* ============ الصناديق ============ */

export interface CashboxLite {
  id: number;
  name: string;
  isDefault: boolean;
}

/** الصناديق النشطة — الافتراضي أولاً (منتقي الصندوق في شريط الميتا) */
export async function listCashboxes(adapter: SqliteAdapter): Promise<CashboxLite[]> {
  const rows = await adapter.all<{ id: number; name: string; is_default: number }>(
    'SELECT id, name, is_default FROM cashbox WHERE is_archived = 0 ORDER BY is_default DESC, id',
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    isDefault: Number(r.is_default) === 1,
  }));
}

/* ============ أصناف البيع (منتقي الأصناف) ============ */

export interface SellableProduct {
  id: number;
  name: string;
  barcode: string | null;
  isService: boolean;
  /** سعر التجزئة بعملة السلة — null إن لم يُسجَّل (يحرَّر يدوياً) */
  price: string | null;
  /** مجموع الرصيد بكل المخازن — '0' للخدمي */
  stockTotal: string;
  /** عدد مرات بيع الصنف (فواتير مكتملة) — 0 افتراضياً */
  timesSold: number;
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** رصيد كل صنف (مجموع كل المخازن — Decimal في الذاكرة) */
export async function fetchStockTotals(
  adapter: SqliteAdapter,
  productIds: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = productIds.filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await adapter.all<{ product_id: number; qty: string }>(
    `SELECT product_id, qty FROM stock_level WHERE product_id IN (${placeholders})`,
    ids,
  );
  const sums = new Map<number, ReturnType<typeof d>>();
  for (const r of rows) {
    const key = Number(r.product_id);
    sums.set(key, (sums.get(key) ?? d(0)).plus(d(r.qty)));
  }
  for (const id of ids) out.set(id, f3(sums.get(id) ?? d(0)));
  return out;
}

/** سعر تجزئة الأصناف بعملة معيّنة (retail) */
export async function fetchRetailPrices(
  adapter: SqliteAdapter,
  productIds: number[],
  currencyId: number,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = productIds.filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await adapter.all<{ product_id: number; price: string }>(
    `SELECT product_id, price FROM product_price
     WHERE currency_id = ? AND price_level = 'retail' AND product_id IN (${placeholders})`,
    [currencyId, ...ids],
  );
  for (const r of rows) out.set(Number(r.product_id), r.price);
  return out;
}

/** عدّاد مرات البيع (فواتير بيع مكتملة) — للشبكة «الأكثر مبيعاً» */
async function fetchTimesSold(
  adapter: SqliteAdapter,
  productIds: number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = productIds.filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await adapter.all<{ product_id: number; c: number }>(
    `SELECT ii.product_id, COUNT(*) AS c
     FROM invoice_item ii
     JOIN invoice i ON i.id = ii.invoice_id
     WHERE i.doc_type = 'sale' AND i.status = 'completed' AND ii.product_id IN (${placeholders})
     GROUP BY ii.product_id`,
    ids,
  );
  for (const r of rows) out.set(Number(r.product_id), Number(r.c));
  return out;
}

/** ينفّش بيانات العرض (سعر/رصيد/عدد بيع) لمجموعة أصناف */
async function decorateSellable(
  adapter: SqliteAdapter,
  rows: { id: number; name: string; barcode: string | null; is_service: number }[],
  currencyId: number,
): Promise<SellableProduct[]> {
  const ids = rows.map((r) => Number(r.id));
  const [prices, stocks, sold] = await Promise.all([
    fetchRetailPrices(adapter, ids, currencyId),
    fetchStockTotals(adapter, ids),
    fetchTimesSold(adapter, ids),
  ]);
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    barcode: r.barcode,
    isService: Number(r.is_service) === 1,
    price: prices.get(Number(r.id)) ?? null,
    stockTotal: Number(r.is_service) === 1 ? '0' : stocks.get(Number(r.id)) ?? '0',
    timesSold: sold.get(Number(r.id)) ?? 0,
  }));
}

/** أصناف قابلة للبيع بالبحث (اسم/باركود) — لقائمة نتائج المنتقي */
export async function listSellableProducts(
  adapter: SqliteAdapter,
  opts: { search?: string; currencyId: number; limit?: number },
): Promise<SellableProduct[]> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const search = (opts.search ?? '').trim();
  const where: string[] = ['p.is_archived = 0'];
  const params: unknown[] = [];
  if (search !== '') {
    where.push("(p.name LIKE ? ESCAPE '\\' OR (p.barcode IS NOT NULL AND p.barcode LIKE ? ESCAPE '\\'))");
    const like = `%${escapeLike(search)}%`;
    params.push(like, like);
  }
  const rows = await adapter.all<{
    id: number;
    name: string;
    barcode: string | null;
    is_service: number;
  }>(
    `SELECT p.id, p.name, p.barcode, p.is_service FROM product p
     WHERE ${where.join(' AND ')}
     ORDER BY p.name
     LIMIT ${limit}`,
    params,
  );
  return decorateSellable(adapter, rows, opts.currencyId);
}

/** الأكثر مبيعاً (أول 20 صنفاً بعدد فواتير البيع المكتملة — FR-02-02) */
export async function listTopSoldProducts(
  adapter: SqliteAdapter,
  opts: { currencyId: number; limit?: number },
): Promise<SellableProduct[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 40);
  const topRows = await adapter.all<{ product_id: number; c: number }>(
    `SELECT ii.product_id, COUNT(*) AS c
     FROM invoice_item ii
     JOIN invoice i ON i.id = ii.invoice_id
     WHERE i.doc_type = 'sale' AND i.status = 'completed'
     GROUP BY ii.product_id
     ORDER BY c DESC
     LIMIT ${limit}`,
  );
  const ids = topRows.map((r) => Number(r.product_id));
  if (ids.length === 0) return [];
  const countMap = new Map<number, number>();
  for (const r of topRows) countMap.set(Number(r.product_id), Number(r.c));
  const placeholders = ids.map(() => '?').join(',');
  const prodRows = await adapter.all<{
    id: number;
    name: string;
    barcode: string | null;
    is_service: number;
  }>(
    `SELECT p.id, p.name, p.barcode, p.is_service FROM product p
     WHERE p.is_archived = 0 AND p.id IN (${placeholders})`,
    ids,
  );
  const decorated = await decorateSellable(adapter, prodRows, opts.currencyId);
  // الترتيب بحسب عدد البيع تنازلياً
  return decorated.sort((a, b) => (countMap.get(b.id) ?? 0) - (countMap.get(a.id) ?? 0));
}

/* ============ قائمة الفواتير ============ */

export type InvoiceDocType = 'sale' | 'purchase' | 'sale_return' | 'purchase_return';

export interface InvoiceListRow {
  id: number;
  invoiceNo: string | null;
  docType: string;
  payStatus: string;
  status: string;
  issuedAt: string;
  total: string;
  currencyCode: string;
  currencyDecimals: number;
  customerName: string | null;
  supplierName: string | null;
}

/** فواتير بأنواعها + بحث بالرقم/اسم الطرف — الأحدث أولاً (سقف 100) */
export async function listInvoices(
  adapter: SqliteAdapter,
  opts: { docType?: InvoiceDocType | 'all'; search?: string; limit?: number } = {},
): Promise<InvoiceListRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
  const docType = opts.docType && opts.docType !== 'all' ? opts.docType : null;
  const search = (opts.search ?? '').trim();
  const where: string[] = ["i.status <> 'draft'"];
  const params: unknown[] = [];
  if (docType) {
    where.push('i.doc_type = ?');
    params.push(docType);
  }
  if (search !== '') {
    where.push(
      "(i.invoice_no LIKE ? ESCAPE '\\' OR cu.name LIKE ? ESCAPE '\\' OR su.name LIKE ? ESCAPE '\\')",
    );
    const like = `%${escapeLike(search)}%`;
    params.push(like, like, like);
  }
  const rows = await adapter.all<{
    id: number;
    invoice_no: string | null;
    doc_type: string;
    pay_status: string;
    status: string;
    issued_at: string;
    total: string;
    currency_code: string;
    currency_decimals: number;
    customer_name: string | null;
    supplier_name: string | null;
  }>(
    `SELECT i.id, i.invoice_no, i.doc_type, i.pay_status, i.status, i.issued_at, i.total,
            c.code AS currency_code, c.decimals AS currency_decimals,
            cu.name AS customer_name, su.name AS supplier_name
     FROM invoice i
     JOIN currency c ON c.id = i.currency_id
     LEFT JOIN customer cu ON cu.id = i.customer_id
     LEFT JOIN supplier su ON su.id = i.supplier_id
     WHERE ${where.join(' AND ')}
     ORDER BY i.issued_at DESC, i.id DESC
     LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    invoiceNo: r.invoice_no,
    docType: r.doc_type,
    payStatus: r.pay_status,
    status: r.status,
    issuedAt: r.issued_at,
    total: r.total,
    currencyCode: r.currency_code,
    currencyDecimals: parseDecimals(r.currency_decimals),
    customerName: r.customer_name,
    supplierName: r.supplier_name,
  }));
}

/* ============ أصناف الشراء (منتقي فاتورة الشراء) ============ */

export interface PurchasableProduct {
  id: number;
  name: string;
  barcode: string | null;
  isService: boolean;
  /** تكلفة الوحدة المرجّحة (WAC) بعملة السلة — '0' عند بلا حركات */
  cost: string;
  /** مجموع الرصيد بكل المخازن — '0' للخدمي (عرض محايد للشراء) */
  stockTotal: string;
  /** عدد فواتير الشراء المكتملة التي تضمّنت الصنف — 0 افتراضياً */
  timesPurchased: number;
}

/**
 * يحوّل تكلفة الأساس إلى عملة الشراء بالسعر الممرَّر (rate = قيمة عملة
 * السلة بالأساس؛ الأساس → '1'). قراءة فقط — لا يلمس domain.
 */
function costInCurrency(costBase: string, rate: string): string {
  const r = d(rate);
  if (r.lte(0)) return costBase;
  return f4(d(costBase).div(r));
}

async function decoratePurchasable(
  adapter: SqliteAdapter,
  rows: { id: number; name: string; barcode: string | null; is_service: number; cost_price: string }[],
  rate: string,
): Promise<PurchasableProduct[]> {
  const ids = rows.map((r) => Number(r.id));
  const [stocks, purchased] = await Promise.all([
    fetchStockTotals(adapter, ids),
    fetchTimesPurchased(adapter, ids),
  ]);
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    barcode: r.barcode,
    isService: Number(r.is_service) === 1,
    cost: costInCurrency(r.cost_price ?? '0', rate),
    stockTotal: Number(r.is_service) === 1 ? '0' : stocks.get(Number(r.id)) ?? '0',
    timesPurchased: purchased.get(Number(r.id)) ?? 0,
  }));
}

/** عدّاد مرات الشراء (فواتير شراء مكتملة) — لترتيب «الأكثر شراءً» */
async function fetchTimesPurchased(
  adapter: SqliteAdapter,
  productIds: number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = productIds.filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await adapter.all<{ product_id: number; c: number }>(
    `SELECT ii.product_id, COUNT(*) AS c
     FROM invoice_item ii
     JOIN invoice i ON i.id = ii.invoice_id
     WHERE i.doc_type = 'purchase' AND i.status = 'completed' AND ii.product_id IN (${placeholders})
     GROUP BY ii.product_id`,
    ids,
  );
  for (const r of rows) out.set(Number(r.product_id), Number(r.c));
  return out;
}

/** أصناف قابلة للشراء بالبحث (اسم/باركود) — سعر السطر = التكلفة المرجّحة */
export async function listPurchasableProducts(
  adapter: SqliteAdapter,
  opts: { search?: string; rate?: string; limit?: number } = {},
): Promise<PurchasableProduct[]> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const search = (opts.search ?? '').trim();
  const where: string[] = ['p.is_archived = 0'];
  const params: unknown[] = [];
  if (search !== '') {
    where.push("(p.name LIKE ? ESCAPE '\\' OR (p.barcode IS NOT NULL AND p.barcode LIKE ? ESCAPE '\\'))");
    const like = `%${escapeLike(search)}%`;
    params.push(like, like);
  }
  const rows = await adapter.all<{
    id: number;
    name: string;
    barcode: string | null;
    is_service: number;
    cost_price: string;
  }>(
    `SELECT p.id, p.name, p.barcode, p.is_service, p.cost_price FROM product p
     WHERE ${where.join(' AND ')}
     ORDER BY p.name
     LIMIT ${limit}`,
    params,
  );
  return decoratePurchasable(adapter, rows, opts.rate ?? '1');
}

/** أصناف شراء بمعرّفاتها — لإعادة تسعير سلة الشراء بعد تغيير العملة/الرصيد */
export async function fetchPurchasableProductsByIds(
  adapter: SqliteAdapter,
  productIds: number[],
  rate?: string,
): Promise<Map<number, PurchasableProduct>> {
  const out = new Map<number, PurchasableProduct>();
  const ids = productIds.filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await adapter.all<{
    id: number;
    name: string;
    barcode: string | null;
    is_service: number;
    cost_price: string;
  }>(
    `SELECT p.id, p.name, p.barcode, p.is_service, p.cost_price FROM product p
     WHERE p.is_archived = 0 AND p.id IN (${placeholders})`,
    ids,
  );
  const decorated = await decoratePurchasable(adapter, rows, rate ?? '1');
  for (const r of decorated) out.set(r.id, r);
  return out;
}

/** الأكثر شراءً (أول 20 صنفاً بعدد فواتير الشراء المكتملة) */
export async function listTopPurchasedProducts(
  adapter: SqliteAdapter,
  opts: { rate?: string; limit?: number } = {},
): Promise<PurchasableProduct[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 40);
  const topRows = await adapter.all<{ product_id: number; c: number }>(
    `SELECT ii.product_id, COUNT(*) AS c
     FROM invoice_item ii
     JOIN invoice i ON i.id = ii.invoice_id
     WHERE i.doc_type = 'purchase' AND i.status = 'completed'
     GROUP BY ii.product_id
     ORDER BY c DESC
     LIMIT ${limit}`,
  );
  const ids = topRows.map((r) => Number(r.product_id));
  if (ids.length === 0) return [];
  const countMap = new Map<number, number>();
  for (const r of topRows) countMap.set(Number(r.product_id), Number(r.c));
  const placeholders = ids.map(() => '?').join(',');
  const prodRows = await adapter.all<{
    id: number;
    name: string;
    barcode: string | null;
    is_service: number;
    cost_price: string;
  }>(
    `SELECT p.id, p.name, p.barcode, p.is_service, p.cost_price FROM product p
     WHERE p.is_archived = 0 AND p.id IN (${placeholders})`,
    ids,
  );
  const decorated = await decoratePurchasable(adapter, prodRows, opts.rate ?? '1');
  return decorated.sort((a, b) => (countMap.get(b.id) ?? 0) - (countMap.get(a.id) ?? 0));
}

/* ============ المرتجعات المرتبطة (ReturnFlow §6.5 — قراءة العرض) ============ */

export interface ReturnableLine {
  productId: number;
  name: string;
  isService: boolean;
  /** المباع بالفاتورة الأصلية (Σ بنود الأصناف) */
  soldQty: string;
  /** المرتجع سابقاً (Σ مرتجعات غير ملغاة) */
  returnedQty: string;
  /** القابل للإرجاع = soldQty − returnedQty (≥ 0) */
  returnableQty: string;
  /** سعر الوحدة الأصلي (متوسط موزون ببنود الأصل) — عرض فقط */
  unitPrice: string;
}

/**
 * بنود فاتورة قابلة للإرجاع مع المتبقي لكل بند (المباع − المرتجع سابقاً)
 * — نفس منطق تحقق AC-21 في Domain (هنا للعرض قبل الحفظ؛ الدومين مصدر الحقيقة).
 * تشمل فقط بنود الأصناف (productId) — بنود الخدمة الحرة غير قابلة للإرجاع
 * في V1 (سطر المرتجع يتطلب صنفاً — RETURN_LINE_NEEDS_PRODUCT).
 */
export async function getReturnableLines(
  adapter: SqliteAdapter,
  invoiceId: number,
): Promise<ReturnableLine[]> {
  const origRows = await adapter.all<{
    product_id: number;
    name: string;
    is_service: number;
    qty: string;
    unit_price: string;
  }>(
    `SELECT ii.product_id, p.name, p.is_service, ii.qty, ii.unit_price
     FROM invoice_item ii
     JOIN product p ON p.id = ii.product_id
     WHERE ii.invoice_id = ? AND ii.product_id IS NOT NULL
     ORDER BY ii.id`,
    [invoiceId],
  );
  const prevRows = await adapter.all<{ product_id: number; qty: string }>(
    `SELECT ii.product_id, ii.qty FROM invoice_item ii
     JOIN invoice i ON i.id = ii.invoice_id
     WHERE i.original_invoice_id = ? AND i.status <> 'void' AND ii.product_id IS NOT NULL`,
    [invoiceId],
  );
  const returnedByProduct = new Map<number, ReturnType<typeof d>>();
  for (const r of prevRows) {
    const pid = Number(r.product_id);
    returnedByProduct.set(pid, (returnedByProduct.get(pid) ?? d(0)).plus(d(r.qty)));
  }
  // تجميع بنود الأصل لكل صنف (متوسط موزون لسعر الوحدة)
  const agg = new Map<
    number,
    { name: string; isService: boolean; qty: ReturnType<typeof d>; value: ReturnType<typeof d> }
  >();
  for (const r of origRows) {
    const pid = Number(r.product_id);
    const row = agg.get(pid) ?? {
      name: r.name,
      isService: Number(r.is_service) === 1,
      qty: d(0),
      value: d(0),
    };
    row.qty = row.qty.plus(d(r.qty));
    row.value = row.value.plus(d(r.qty).times(d(r.unit_price)));
    agg.set(pid, row);
  }
  const out: ReturnableLine[] = [];
  for (const [productId, row] of agg) {
    const returned = returnedByProduct.get(productId) ?? d(0);
    const returnable = row.qty.minus(returned);
    out.push({
      productId,
      name: row.name,
      isService: row.isService,
      soldQty: f3(row.qty),
      returnedQty: f3(returned.gt(0) ? returned : d(0)),
      returnableQty: f3(returnable.gt(0) ? returnable : d(0)),
      unitPrice: row.qty.gt(0) ? f4(row.value.div(row.qty)) : '0',
    });
  }
  return out;
}

export interface LinkedReturnRow {
  id: number;
  invoiceNo: string | null;
  docType: string;
  payStatus: string;
  status: string;
  issuedAt: string;
  total: string;
  currencyCode: string;
  currencyDecimals: number;
}

/** مرتجعات مرتبطة بفاتورة (غير الملغاة أولاً) — بطاقة «مرتجع مرتبط» في التفاصيل */
export async function listLinkedReturns(
  adapter: SqliteAdapter,
  invoiceId: number,
): Promise<LinkedReturnRow[]> {
  const rows = await adapter.all<{
    id: number;
    invoice_no: string | null;
    doc_type: string;
    pay_status: string;
    status: string;
    issued_at: string;
    total: string;
    currency_code: string;
    currency_decimals: number;
  }>(
    `SELECT i.id, i.invoice_no, i.doc_type, i.pay_status, i.status, i.issued_at, i.total,
            c.code AS currency_code, c.decimals AS currency_decimals
     FROM invoice i
     JOIN currency c ON c.id = i.currency_id
     WHERE i.original_invoice_id = ?
     ORDER BY i.status <> 'void', i.issued_at DESC, i.id DESC`,
    [invoiceId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    invoiceNo: r.invoice_no,
    docType: r.doc_type,
    payStatus: r.pay_status,
    status: r.status,
    issuedAt: r.issued_at,
    total: r.total,
    currencyCode: r.currency_code,
    currencyDecimals: parseDecimals(r.currency_decimals),
  }));
}

/* ============ حد الائتمان (تحذير الحفظ الآجل — FR-03-01) ============ */

export interface CustomerCreditInfo {
  /** حد الائتمان خاماً — null بلا حد، '0' منع الآجل */
  creditLimit: string | null;
  /** الرصيد الافتتاحي محوَّلاً للأساس (opening × rate) */
  openingBase: string;
  /** Σ (المتبقي) لفواتير البيع المكتملة محوَّلاً للأساس — يشطر المرتجعات الآجلة */
  dueBase: string;
}

/**
 * استخدام ائتمان العميل بالعملة الأساسية: افتتاحي + متبقي فواتير البيع −
 * مرتجعات البيع الآجلة (عرض تحذيري فقط — قرار الحظر في Domain عند بنائه).
 */
export async function fetchCustomerCreditInfo(
  adapter: SqliteAdapter,
  customerId: number,
): Promise<CustomerCreditInfo> {
  const custRows = await adapter.all<{
    credit_limit: string | null;
    opening_balance: string;
    opening_balance_rate: string | null;
  }>(
    'SELECT credit_limit, opening_balance, opening_balance_rate FROM customer WHERE id = ?',
    [customerId],
  );
  const cust = custRows[0];
  if (!cust) {
    return { creditLimit: null, openingBase: '0', dueBase: '0' };
  }
  const opening = d(cust.opening_balance ?? '0').times(d(cust.opening_balance_rate ?? '1'));
  const dueRows = await adapter.all<{ due_amount: string; exchange_rate: string }>(
    "SELECT due_amount, exchange_rate FROM invoice WHERE customer_id = ? AND doc_type = 'sale' AND status = 'completed'",
    [customerId],
  );
  let due = d(0);
  for (const r of dueRows) {
    due = due.plus(d(r.due_amount ?? '0').times(d(r.exchange_rate ?? '1')));
  }
  const returnRows = await adapter.all<{ total: string; exchange_rate: string }>(
    "SELECT total, exchange_rate FROM invoice WHERE customer_id = ? AND doc_type = 'sale_return' AND status = 'completed' AND pay_status = 'credit'",
    [customerId],
  );
  for (const r of returnRows) {
    due = due.minus(d(r.total ?? '0').times(d(r.exchange_rate ?? '1')));
  }
  return {
    creditLimit: cust.credit_limit,
    openingBase: f4(opening),
    dueBase: f4(due),
  };
}

/** اسم/خدمية الأصناف لعرض بنود الفاتورة (تفاصيل الفاتورة) */
export interface ProductDisplay {
  name: string;
  isService: boolean;
}

export async function fetchProductDisplay(
  adapter: SqliteAdapter,
  productIds: number[],
): Promise<Map<number, ProductDisplay>> {
  const out = new Map<number, ProductDisplay>();
  const ids = productIds.filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await adapter.all<{ id: number; name: string; is_service: number }>(
    `SELECT id, name, is_service FROM product WHERE id IN (${placeholders})`,
    ids,
  );
  for (const r of rows) {
    out.set(Number(r.id), { name: r.name, isService: Number(r.is_service) === 1 });
  }
  return out;
}

/* ================================================================
 *  استعلامات شاشة النقدية الكاملة (المهمة 10 — FR-04) — قراءة فقط.
 *  نفس قواعد الأقسام أعلاه: Decimal في الذاكرة، لا CAST في المجاميع،
 *  ولا كتابة — كل الحفظ/الإلغاء عبر domain/cash.ts حصراً.
 * ================================================================ */

/* ============ أرصدة الصناديق الحية (FR-04-06/09) ============ */

export interface CashboxBalance {
  id: number;
  name: string;
  isDefault: boolean;
  currencyId: number;
  currencyCode: string;
  currencyDecimals: number;
  /** رصيد الصندوق بعملته (4dp) — السالب مسموح مع تحذير (قرار 9 / FR-04-09) */
  balance: string;
}

const IN_TX_TYPES = new Set(['receipt', 'capital_in', 'bank_deposit', 'opening']);
const OUT_TX_TYPES = new Set(['payment', 'expense', 'owner_draw', 'bank_withdraw']);

/**
 * رصيد كل صندوق نشط بعملته لحظياً (FR-04-06):
 *  رصيد = Σ الوارد (قبض/إيداع مالك/إيداع بنكي/افتتاحي/شطر التحويل الوارد)
 *       − Σ الصادر (صرف/مصروف/مسحوبات مالك/سحب بنكي/شطر التحويل الصادر)
 *  — باستبعاد موحّد للملغاة والمعاكسة (is_voided=0 AND reversal_of IS NULL
 *  كما في fetchTodayCashNet ودومين المهمة 9)، وبلا أي تحويل عملات: كل صف
 *  بعملة صندوقه (التحويل شطران، لكل صندوق شطره بعملته — قرارات المهمة 9).
 */
export async function getCashboxBalances(adapter: SqliteAdapter): Promise<CashboxBalance[]> {
  const [boxes, txs] = await Promise.all([
    adapter.all<{
      id: number;
      name: string;
      is_default: number;
      currency_id: number;
      currency_code: string;
      currency_decimals: number;
    }>(
      `SELECT b.id, b.name, b.is_default, b.currency_id,
              c.code AS currency_code, c.decimals AS currency_decimals
       FROM cashbox b JOIN currency c ON c.id = b.currency_id
       WHERE b.is_archived = 0
       ORDER BY b.is_default DESC, b.id`,
    ),
    adapter.all<{
      cashbox_id: number;
      tx_type: string;
      amount: string;
      /** شطر الوارد من تحويل (ref_id يشير للصادر) — غيره NULL */
      ref_id: number | null;
    }>(
      `SELECT cashbox_id, tx_type, amount, ref_id FROM cash_tx
       WHERE is_voided = 0 AND reversal_of IS NULL`,
    ),
  ]);
  const sums = new Map<number, ReturnType<typeof d>>();
  for (const r of txs) {
    const key = Number(r.cashbox_id);
    const amt = d(r.amount);
    const isIn =
      IN_TX_TYPES.has(r.tx_type) ||
      (r.tx_type === 'box_transfer' && r.ref_id !== null); // شطر الوارد من تحويل
    const isOut =
      OUT_TX_TYPES.has(r.tx_type) ||
      (r.tx_type === 'box_transfer' && r.ref_id === null); // شطر الصادر
    if (!isIn && !isOut) continue;
    const prev = sums.get(key) ?? d(0);
    sums.set(key, isIn ? prev.plus(amt) : prev.minus(amt));
  }
  return boxes.map((b) => ({
    id: Number(b.id),
    name: b.name,
    isDefault: Number(b.is_default) === 1,
    currencyId: Number(b.currency_id),
    currencyCode: b.currency_code,
    currencyDecimals: parseDecimals(b.currency_decimals),
    balance: f4(sums.get(Number(b.id)) ?? d(0)),
  }));
}

/* ============ سجل حركات النقدية (FR-04-08) ============ */

/** نوع فلترة السجل (شريحة النشط في الواجهة) */
export type CashMovementsFilter = 'all' | 'receipt' | 'payment' | 'expense' | 'box_transfer' | 'owner';

export interface CashMovementRow {
  id: number;
  txType: string;
  /** اتجاه أثر الحركة على صندوقها: in/out (من tx_type + شطر التحويل) */
  direction: 'in' | 'out';
  cashboxId: number;
  cashboxName: string;
  /** صندوق الوجهة لشطر الصادر من تحويل (null لغيره) */
  toCashboxName: string | null;
  currencyCode: string;
  currencyDecimals: number;
  /** الموجب دائماً (DDL) — الاتجاه في direction */
  amount: string;
  /** سعر عملة السند (6dp نصاً) */
  exchangeRate: string;
  /** سعر التسوية لعملة الفاتورة عند التحصيل بعملة مختلفة — وإلا NULL */
  settlementRate: string | null;
  fxGainLoss: string;
  voucherNo: string | null;
  /** YYYY-MM-DD */
  txDate: string;
  /** تاريخ الإنشاء الكامل — لترتيب الوقت داخل اليوم */
  createdAt: string | null;
  refType: string | null;
  refId: number | null;
  expenseCategoryName: string | null;
  customerName: string | null;
  supplierName: string | null;
  isVoided: boolean;
  reversalOf: number | null;
  description: string | null;
}

/**
 * حركات النقدية بكل الصناديق — الأحدث أولاً (tx_date ثم وقت الإنشاء ثم id)،
 * سقف 200. تشمل الملغاة (للعرض مشطوبة) والمعاكسة (بعلامة «معاكسة») لأن السجل
 * سجل تدقيق كامل (FR-04-08) — الأرصدة وحدها تستبعدها.
 * فلترة النوع: owner تجمع مسحوبات المالك وإيداعه.
 */
export async function listCashMovements(
  adapter: SqliteAdapter,
  opts: { filter?: CashMovementsFilter; limit?: number } = {},
): Promise<CashMovementRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const filter = opts.filter ?? 'all';
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter === 'receipt' || filter === 'payment' || filter === 'expense') {
    where.push('ct.tx_type = ?');
    params.push(filter);
  } else if (filter === 'box_transfer') {
    where.push("ct.tx_type = 'box_transfer'");
  } else if (filter === 'owner') {
    where.push("ct.tx_type IN ('owner_draw', 'capital_in')");
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = await adapter.all<{
    id: number;
    tx_type: string;
    cashbox_id: number;
    cashbox_name: string;
    to_cashbox_name: string | null;
    currency_code: string;
    currency_decimals: number;
    amount: string;
    exchange_rate: string;
    settlement_rate: string | null;
    fx_gain_loss: string;
    voucher_no: string | null;
    tx_date: string;
    created_at: string | null;
    ref_type: string | null;
    ref_id: number | null;
    expense_category_name: string | null;
    customer_name: string | null;
    supplier_name: string | null;
    is_voided: number;
    reversal_of: number | null;
    description: string | null;
  }>(
    `SELECT ct.id, ct.tx_type, ct.cashbox_id, ct.to_cashbox_id, ct.amount,
            ct.exchange_rate, ct.settlement_rate, ct.fx_gain_loss,
            ct.voucher_no, ct.tx_date, ct.created_at, ct.ref_type, ct.ref_id,
            ct.is_voided, ct.reversal_of, ct.description,
            cb.name AS cashbox_name, toc.name AS to_cashbox_name,
            cur.code AS currency_code, cur.decimals AS currency_decimals,
            ec.name AS expense_category_name, cu.name AS customer_name, su.name AS supplier_name
     FROM cash_tx ct
     JOIN cashbox cb ON cb.id = ct.cashbox_id
     JOIN currency cur ON cur.id = ct.currency_id
     LEFT JOIN cashbox toc ON toc.id = ct.to_cashbox_id
     LEFT JOIN expense_category ec ON ec.id = ct.expense_category_id
     LEFT JOIN customer cu ON cu.id = ct.customer_id
     LEFT JOIN supplier su ON su.id = ct.supplier_id${whereSql}
     ORDER BY ct.tx_date DESC, ct.created_at DESC, ct.id DESC
     LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => {
    // التحويل شطران: الصادر (to_cashbox_id محدد) والوارد (ref_id → الصادر)
    const isInTransferLeg = r.tx_type === 'box_transfer' && r.ref_id !== null;
    const direction: 'in' | 'out' =
      IN_TX_TYPES.has(r.tx_type) || isInTransferLeg
        ? 'in'
        : 'out';
    return {
      id: Number(r.id),
      txType: r.tx_type,
      direction,
      cashboxId: Number(r.cashbox_id),
      cashboxName: r.cashbox_name,
      toCashboxName: r.to_cashbox_name,
      currencyCode: r.currency_code,
      currencyDecimals: parseDecimals(r.currency_decimals),
      amount: r.amount,
      exchangeRate: r.exchange_rate,
      settlementRate: r.settlement_rate,
      fxGainLoss: r.fx_gain_loss,
      voucherNo: r.voucher_no,
      txDate: r.tx_date,
      createdAt: r.created_at,
      refType: r.ref_type,
      refId: r.ref_id === null ? null : Number(r.ref_id),
      expenseCategoryName: r.expense_category_name,
      customerName: r.customer_name,
      supplierName: r.supplier_name,
      isVoided: Number(r.is_voided) === 1,
      reversalOf: r.reversal_of === null ? null : Number(r.reversal_of),
      description: r.description,
    };
  });
}

/* ============ الفواتير المفتوحة لطرف (معاينة التخصيص FIFO) ============ */

export interface OpenInvoiceRow {
  id: number;
  invoiceNo: string | null;
  issuedAt: string;
  currencyId: number;
  currencyCode: string;
  currencyDecimals: number;
  /** إجمالي الفاتورة بعملتها */
  total: string;
  /** المتبقي القابل للتخصيص (4dp) — مشتق لا عمود يُحدّث */
  remaining: string;
}

/**
 * الفواتير المفتوحة لعميل (فواتير البيع) أو مورد (فواتير الشراء) — الأقدم أولاً،
 * مع المتبقي القابل للتخصيص **بنفس دلالات الدومين حرفياً** (المهمة 9):
 *  remaining = invoice.due_amount − Σ payment_allocation لسندات حية
 *  (ct.is_voided=0 AND ct.reversal_of IS NULL AND ct.tx_type = القبض للعملاء /
 *  الصرف للموردين).
 *  ملاحظة: paid_amount على الفاتورة يغطي نقدية وقت الفاتورة فقط (تحدّثه
 *  saveInvoice) — تحصيلات السندات لاحقاً لا تلمسه؛ لذلك المتبقي مشتق هنا كما
 *  في domain/cash.ts remainingOnInvoice — الدومين مصدر الحقيقة عند الحفظ،
 *  وهذه المعاينة للعرض فقط (FR-04-03).
 *  تشمل الفواتير المكتملة فقط بعملتها الأصلية (لا تجميع عملات — FR-08-11).
 */
export async function getOpenInvoicesForParty(
  adapter: SqliteAdapter,
  opts: { customerId?: number; supplierId?: number },
): Promise<OpenInvoiceRow[]> {
  const isCustomer = opts.customerId !== undefined;
  const partyId = opts.customerId ?? opts.supplierId;
  if (partyId === undefined) return [];
  const family = isCustomer ? 'sale' : 'purchase';
  const partyCol = isCustomer ? 'customer_id' : 'supplier_id';
  const allocType = isCustomer ? 'receipt' : 'payment';
  const rows = await adapter.all<{
    id: number;
    invoice_no: string | null;
    issued_at: string;
    currency_id: number;
    currency_code: string;
    currency_decimals: number;
    total: string;
    due_amount: string;
    allocated: string | null;
  }>(
    `SELECT i.id, i.invoice_no, i.issued_at, i.currency_id,
            cur.code AS currency_code, cur.decimals AS currency_decimals,
            i.total, i.due_amount,
            (SELECT SUM(pa.allocated_amount) FROM payment_allocation pa
             JOIN cash_tx ct ON ct.id = pa.cash_tx_id
             WHERE pa.invoice_id = i.id AND ct.is_voided = 0
               AND ct.reversal_of IS NULL AND ct.tx_type = '${allocType}') AS allocated
     FROM invoice i
     JOIN currency cur ON cur.id = i.currency_id
     WHERE i.doc_type = '${family}' AND i.status = 'completed' AND i.${partyCol} = ?
     ORDER BY i.issued_at ASC, i.id ASC`,
    [partyId],
  );
  return rows
    .map((r) => ({
      id: Number(r.id),
      invoiceNo: r.invoice_no,
      issuedAt: r.issued_at,
      currencyId: Number(r.currency_id),
      currencyCode: r.currency_code,
      currencyDecimals: parseDecimals(r.currency_decimals),
      total: r.total,
      remaining: f4(d(r.due_amount).minus(d(r.allocated ?? '0'))),
    }))
    .filter((r) => d(r.remaining).gt(0));
}

/* ============ فئات المصاريف (FR-04-05) ============ */

/** فئات المصاريف النشطة (البذر: رواتب/مصاريف عامة/إيجار/نقل ومواصلات) */
export async function listExpenseCategories(adapter: SqliteAdapter): Promise<RefRow[]> {
  const rows = await adapter.all<{ id: number; name: string }>(
    'SELECT id, name FROM expense_category WHERE is_archived = 0 ORDER BY id',
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

/* ============ تخصيصات سند على فواتيره (تفاصيل الحركة) ============ */

export interface CashTxAllocationRow {
  invoiceId: number;
  invoiceNo: string | null;
  allocatedAmount: string;
}

/** بنود تخصيص سند قبض/صرف على الفواتير — الأقدم أولاً (شيت التفاصيل) */
export async function getCashTxAllocations(
  adapter: SqliteAdapter,
  cashTxId: number,
): Promise<CashTxAllocationRow[]> {
  const rows = await adapter.all<{ invoice_id: number; invoice_no: string | null; allocated_amount: string }>(
    `SELECT pa.invoice_id, i.invoice_no, pa.allocated_amount
     FROM payment_allocation pa JOIN invoice i ON i.id = pa.invoice_id
     WHERE pa.cash_tx_id = ?
     ORDER BY i.issued_at ASC, i.id ASC`,
    [cashTxId],
  );
  return rows.map((r) => ({
    invoiceId: Number(r.invoice_id),
    invoiceNo: r.invoice_no,
    allocatedAmount: r.allocated_amount,
  }));
}

/* ================================================================
 *  الشيكات (FR-14 — قراءة العرض فقط) — الإضافة تُلحق بنهاية الملف
 *  حصراً (تنسيق الوكلاء المتوازيين): listCheques / getChequeById.
 * ================================================================ */

/** صف شيك للقائمة (اسم الطرف + العملة مضمومة) */
export interface ChequeListRow {
  id: number;
  direction: 'in' | 'out';
  partyType: 'customer' | 'supplier';
  partyId: number;
  partyName: string | null;
  chequeNo: string;
  bankName: string | null;
  /** بعملة الشيك (4dp) */
  amount: string;
  currencyId: number;
  currencyCode: string;
  currencyDecimals: number;
  /** Snapshot وقت التسجيل (6dp) */
  exchangeRate: string;
  issueDate: string;
  dueDate: string;
  status: 'pending' | 'deposited' | 'cleared' | 'bounced' | 'void';
  bouncedAt: string | null;
  bounceFee: string | null;
  refInvoiceId: number | null;
  notes: string | null;
}

export interface ChequeListFilters {
  direction?: 'in' | 'out';
  status?: 'pending' | 'deposited' | 'cleared' | 'bounced' | 'void';
  partyType?: 'customer' | 'supplier';
  partyId?: number;
  /** الاستحقاق خلال الأيام القادمة (الشيكات الحية فقط) */
  dueWithinDays?: number;
}

const CHEQUE_STATUS_VALUES = ['pending', 'deposited', 'cleared', 'bounced', 'void'] as const;
type ChequeStatusLite = (typeof CHEQUE_STATUS_VALUES)[number];

function chequeStatus(v: unknown): ChequeStatusLite {
  const s = String(v);
  return (CHEQUE_STATUS_VALUES as readonly string[]).includes(s)
    ? (s as ChequeStatusLite)
    : 'pending';
}

/** خريطة الصف الخام للقائمة (snake_case) */
interface ChequeListRawRow {
  id: number;
  direction: string;
  party_type: string;
  party_id: number;
  party_name: string | null;
  cheque_no: string;
  bank_name: string | null;
  amount: string;
  currency_id: number;
  currency_code: string;
  currency_decimals: number;
  exchange_rate: string;
  issue_date: string;
  due_date: string;
  status: string;
  bounced_at: string | null;
  bounce_fee: string | null;
  ref_invoice_id: number | null;
  notes: string | null;
}

/**
 * قائمة الشيكات مرتبة بتاريخ الاستحقاق تصاعدياً (FR-14-05) مع اسم الطرف
 * (يُضم حسب نوعه) ورمز عملته. الفلاتر كلها اختيارية — dueWithinDays يعرض
 * الحية (pending/deposited) المستحقة خلال النافذة من اليوم.
 */
export async function listCheques(
  adapter: SqliteAdapter,
  filters: ChequeListFilters = {},
): Promise<ChequeListRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.direction !== undefined) {
    where.push('ch.direction = ?');
    params.push(filters.direction);
  }
  if (filters.status !== undefined) {
    where.push('ch.status = ?');
    params.push(filters.status);
  }
  if (filters.partyType !== undefined) {
    where.push('ch.party_type = ?');
    params.push(filters.partyType);
  }
  if (filters.partyId !== undefined) {
    where.push('ch.party_id = ?');
    params.push(filters.partyId);
  }
  if (filters.dueWithinDays !== undefined) {
    // نافذة الاستحقاق من اليوم (من اليوم حتى اليوم+N) للحية فقط
    const today = todayISO();
    const until = addDaysISO(today, filters.dueWithinDays);
    where.push("ch.status IN ('pending','deposited') AND ch.due_date >= ? AND ch.due_date <= ?");
    params.push(today, until);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await adapter.all<ChequeListRawRow>(
    `SELECT ch.id, ch.direction, ch.party_type, ch.party_id, ch.cheque_no, ch.bank_name,
            ch.amount, ch.currency_id, ch.exchange_rate, ch.issue_date, ch.due_date,
            ch.status, ch.bounced_at, ch.bounce_fee, ch.ref_invoice_id, ch.notes,
            cur.code AS currency_code, cur.decimals AS currency_decimals,
            CASE WHEN ch.party_type = 'customer' THEN cu.name ELSE su.name END AS party_name
     FROM cheque ch
     JOIN currency cur ON cur.id = ch.currency_id
     LEFT JOIN customer cu ON ch.party_type = 'customer' AND cu.id = ch.party_id
     LEFT JOIN supplier su ON ch.party_type = 'supplier' AND su.id = ch.party_id
     ${whereSql}
     ORDER BY ch.due_date ASC, ch.id ASC`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    direction: r.direction === 'out' ? 'out' : 'in',
    partyType: r.party_type === 'supplier' ? 'supplier' : 'customer',
    partyId: Number(r.party_id),
    partyName: r.party_name ?? null,
    chequeNo: r.cheque_no,
    bankName: r.bank_name ?? null,
    amount: r.amount,
    currencyId: Number(r.currency_id),
    currencyCode: r.currency_code,
    currencyDecimals: parseDecimals(r.currency_decimals),
    exchangeRate: r.exchange_rate,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    status: chequeStatus(r.status),
    bouncedAt: r.bounced_at ?? null,
    bounceFee: r.bounce_fee ?? null,
    refInvoiceId: r.ref_invoice_id === null ? null : Number(r.ref_invoice_id),
    notes: r.notes ?? null,
  }));
}

/** شيك مفصل بضمات كاملة (الطرف/العملة/الفاتورة المرجعية/حركة التحصيل) */
export interface ChequeDetailRow extends ChequeListRow {
  createdAt: string | null;
  /** الفاتورة المرجعية (إن وجدت) */
  refInvoiceNo: string | null;
  refInvoiceDocType: string | null;
  refInvoiceTotal: string | null;
  /** حركة الصندوق التي أنشأها التحصيل (cleared فقط) */
  clearedCashTxId: number | null;
  clearedVoucherNo: string | null;
  clearedTxType: string | null;
  clearedTxDate: string | null;
  clearedTxAmount: string | null;
  clearedCashboxName: string | null;
}

/**
 * شيك واحد بتفصيل كامل: الطرف واسمه، عملته، فاتورته المرجعية (رقمها
 * وعائلتها وإجماليها)، وحركة الصندوق التي أنشأها تحصيله (رقم السند
 * RVT-/PMT- وتاريخها وصندوقها) — null ما لم يوجد.
 */
export async function getChequeById(
  adapter: SqliteAdapter,
  id: number,
): Promise<ChequeDetailRow | null> {
  const rows = await adapter.all<
    ChequeListRawRow & {
      created_at: string | null;
      cleared_cash_tx_id: number | null;
      ref_invoice_no: string | null;
      ref_invoice_doc_type: string | null;
      ref_invoice_total: string | null;
      cleared_voucher_no: string | null;
      cleared_tx_type: string | null;
      cleared_tx_date: string | null;
      cleared_tx_amount: string | null;
      cleared_cashbox_name: string | null;
    }
  >(
    `SELECT ch.id, ch.direction, ch.party_type, ch.party_id, ch.cheque_no, ch.bank_name,
            ch.amount, ch.currency_id, ch.exchange_rate, ch.issue_date, ch.due_date,
            ch.status, ch.bounced_at, ch.bounce_fee, ch.ref_invoice_id, ch.notes,
            ch.created_at, ch.cleared_cash_tx_id,
            cur.code AS currency_code, cur.decimals AS currency_decimals,
            CASE WHEN ch.party_type = 'customer' THEN cu.name ELSE su.name END AS party_name,
            ri.invoice_no AS ref_invoice_no, ri.doc_type AS ref_invoice_doc_type,
            ri.total AS ref_invoice_total,
            ct.voucher_no AS cleared_voucher_no, ct.tx_type AS cleared_tx_type,
            ct.tx_date AS cleared_tx_date, ct.amount AS cleared_tx_amount,
            cb.name AS cleared_cashbox_name
     FROM cheque ch
     JOIN currency cur ON cur.id = ch.currency_id
     LEFT JOIN customer cu ON ch.party_type = 'customer' AND cu.id = ch.party_id
     LEFT JOIN supplier su ON ch.party_type = 'supplier' AND su.id = ch.party_id
     LEFT JOIN invoice ri ON ri.id = ch.ref_invoice_id
     LEFT JOIN cash_tx ct ON ct.id = ch.cleared_cash_tx_id
     LEFT JOIN cashbox cb ON cb.id = ct.cashbox_id
     WHERE ch.id = ?`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    direction: r.direction === 'out' ? 'out' : 'in',
    partyType: r.party_type === 'supplier' ? 'supplier' : 'customer',
    partyId: Number(r.party_id),
    partyName: r.party_name ?? null,
    chequeNo: r.cheque_no,
    bankName: r.bank_name ?? null,
    amount: r.amount,
    currencyId: Number(r.currency_id),
    currencyCode: r.currency_code,
    currencyDecimals: parseDecimals(r.currency_decimals),
    exchangeRate: r.exchange_rate,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    status: chequeStatus(r.status),
    bouncedAt: r.bounced_at ?? null,
    bounceFee: r.bounce_fee ?? null,
    refInvoiceId: r.ref_invoice_id === null ? null : Number(r.ref_invoice_id),
    notes: r.notes ?? null,
    createdAt: r.created_at ?? null,
    refInvoiceNo: r.ref_invoice_no ?? null,
    refInvoiceDocType: r.ref_invoice_doc_type ?? null,
    refInvoiceTotal: r.ref_invoice_total ?? null,
    clearedCashTxId: r.cleared_cash_tx_id === null ? null : Number(r.cleared_cash_tx_id),
    clearedVoucherNo: r.cleared_voucher_no ?? null,
    clearedTxType: r.cleared_tx_type ?? null,
    clearedTxDate: r.cleared_tx_date ?? null,
    clearedTxAmount: r.cleared_tx_amount ?? null,
    clearedCashboxName: r.cleared_cashbox_name ?? null,
  };
}

/* ================================================================
 *  الأقساط (FR-05 — قراءة العرض فقط) — الإضافة تُلحق بنهاية الملف
 *  حصراً (تنسيق الوكلاء المتوازيين): listInstallmentPlans /
 *  getInstallmentPlan / listDueInstallments / getInvoicePlanSummary.
 *  المبالغ تُجمَع بDecimal في الذاكرة (لا CAST AS REAL — قاعدة الملف).
 * ================================================================ */

/** صف خطة للقائمة: بيانات الخطة + الطرف والعملة والفاتورة + التقدّم المشتق */
export interface InstallmentPlanListRow {
  id: number;
  customerId: number;
  customerName: string | null;
  invoiceId: number;
  invoiceNo: string | null;
  currencyId: number;
  currencyCode: string;
  currencyDecimals: number;
  /** أصل التقسيط بعد الدفعة الأولى (4dp) */
  principal: string;
  downPayment: string;
  totalPaid: string;
  /** Snapshot من الفاتورة (6dp) — لتقييم الأساس في شريط الملخص */
  exchangeRate: string;
  months: number;
  cycle: 'monthly' | 'weekly';
  firstDue: string;
  status: 'active' | 'completed' | 'defaulted' | 'cancelled';
  createdAt: string | null;
  /* ——— مشتق من الجدول ——— */
  /** عدد الأقساط المسددة كاملاً */
  paidCount: number;
  totalCount: number;
  /** Σ(amount − paid) للأقساط غير المسددة (4dp) */
  remaining: string;
  /** أقرب استحقاق غير مسدد — null للمكتملة */
  nextDue: string | null;
}

/** خطة مفصلة بجدولها الكامل (شاشة التفاصيل) */
export interface InstallmentScheduleRow {
  id: number;
  seq: number;
  dueDate: string;
  amount: string;
  paidAmount: string;
  status: 'pending' | 'partial' | 'paid' | 'late';
  paidAt: string | null;
  cashTxId: number | null;
}

export interface InstallmentPlanDetailRow extends InstallmentPlanListRow {
  customerPhone: string | null;
  customerWhatsapp: string | null;
  /** إجمالي فاتورة المصدر بعملتها */
  invoiceTotal: string | null;
  /** المتبقي الحي للفاتورة (due_amount − Σ تخصيصات حية — 4dp) */
  invoiceRemaining: string | null;
  schedule: InstallmentScheduleRow[];
}

/** قسط مستحق مع سياقه (قائمة المستحق/المتأخر) */
export interface DueInstallmentRow {
  id: number;
  planId: number;
  seq: number;
  dueDate: string;
  amount: string;
  paidAmount: string;
  /** متبقي القسط (4dp) */
  remaining: string;
  status: 'pending' | 'partial' | 'paid' | 'late';
  planStatus: string;
  customerId: number;
  customerName: string | null;
  customerPhone: string | null;
  customerWhatsapp: string | null;
  invoiceId: number;
  invoiceNo: string | null;
  currencyId: number;
  currencyCode: string;
  currencyDecimals: number;
}

/** ملخص خطة فاتورة (البطاقة الشرطية في تفاصيل الفاتورة — SELECT واحد) */
export interface InvoicePlanSummaryRow {
  planId: number;
  status: string;
  months: number;
  cycle: string;
  paidCount: number;
  totalCount: number;
  nextDue: string | null;
}

const PLAN_CYCLE_VALUES = ['monthly', 'weekly'] as const;
const INST_STATUS_VALUES = ['pending', 'partial', 'paid', 'late'] as const;
const PLAN_STATUS_VALUES = ['active', 'completed', 'defaulted', 'cancelled'] as const;

function planCycleOf(v: unknown): 'monthly' | 'weekly' {
  const s = String(v);
  return (PLAN_CYCLE_VALUES as readonly string[]).includes(s) ? (s as 'monthly' | 'weekly') : 'monthly';
}

function instStatusOf(v: unknown): 'pending' | 'partial' | 'paid' | 'late' {
  const s = String(v);
  return (INST_STATUS_VALUES as readonly string[]).includes(s)
    ? (s as 'pending' | 'partial' | 'paid' | 'late')
    : 'pending';
}

function planStatusOf(v: unknown): 'active' | 'completed' | 'defaulted' | 'cancelled' {
  const s = String(v);
  return (PLAN_STATUS_VALUES as readonly string[]).includes(s)
    ? (s as 'active' | 'completed' | 'defaulted' | 'cancelled')
    : 'active';
}

/**
 * خطط التقسيط للقائمة: الطرف والعملة والفاتورة مضمومة، والتقدّم (مسدد/كل،
 * المتبقي، أقرب استحقاق غير مسدد) مشتق من سطور الجدول بDecimal في الذاكرة.
 * الترتيب: أقرب استحقاق غير مسدد أولاً (المتأخر يفرض نفسه طبيعياً)،
 * والمكتملة في ذيل القائمة.
 */
export async function listInstallmentPlans(
  adapter: SqliteAdapter,
): Promise<InstallmentPlanListRow[]> {
  const plans = await adapter.all<{
    id: number;
    customer_id: number;
    customer_name: string | null;
    invoice_id: number;
    invoice_no: string | null;
    currency_id: number;
    currency_code: string;
    currency_decimals: number;
    principal: string;
    down_payment: string | null;
    total_paid: string | null;
    exchange_rate: string;
    months: number;
    cycle: string | null;
    first_due: string;
    status: string | null;
    created_at: string | null;
  }>(
    `SELECT p.id, p.customer_id, p.invoice_id, p.months, p.cycle, p.first_due,
            p.principal, p.down_payment, p.total_paid, p.status, p.created_at,
            p.exchange_rate,
            cu.name AS customer_name, i.invoice_no,
            cur.id AS currency_id, cur.code AS currency_code, cur.decimals AS currency_decimals
     FROM installment_plan p
     JOIN customer cu ON cu.id = p.customer_id
     JOIN currency cur ON cur.id = p.currency_id
     LEFT JOIN invoice i ON i.id = p.invoice_id`,
  );
  const insts = await adapter.all<{
    plan_id: number;
    status: string | null;
    amount: string;
    paid_amount: string | null;
    due_date: string;
  }>(
    `SELECT plan_id, status, amount, paid_amount, due_date FROM installment`,
  );
  const byPlan = new Map<number, typeof insts>();
  for (const x of insts) {
    const key = Number(x.plan_id);
    const list = byPlan.get(key);
    if (list) list.push(x);
    else byPlan.set(key, [x]);
  }
  const rows: InstallmentPlanListRow[] = plans.map((p) => {
    const xs = byPlan.get(Number(p.id)) ?? [];
    let paidCount = 0;
    let remaining = d(0);
    let nextDue: string | null = null;
    for (const x of xs) {
      if ((x.status ?? 'pending') === 'paid') {
        paidCount += 1;
        continue;
      }
      remaining = remaining.plus(d(x.amount).minus(d(x.paid_amount ?? '0')));
      if (nextDue === null || x.due_date < nextDue) nextDue = x.due_date;
    }
    return {
      id: Number(p.id),
      customerId: Number(p.customer_id),
      customerName: p.customer_name ?? null,
      invoiceId: Number(p.invoice_id),
      invoiceNo: p.invoice_no ?? null,
      currencyId: Number(p.currency_id),
      currencyCode: p.currency_code,
      currencyDecimals: parseDecimals(p.currency_decimals),
      principal: p.principal,
      downPayment: p.down_payment ?? '0.0000',
      totalPaid: p.total_paid ?? '0.0000',
      exchangeRate: p.exchange_rate,
      months: Number(p.months),
      cycle: planCycleOf(p.cycle),
      firstDue: p.first_due,
      status: planStatusOf(p.status),
      createdAt: p.created_at ?? null,
      paidCount,
      totalCount: xs.length,
      remaining: f4(remaining),
      nextDue,
    };
  });
  // أقرب استحقاق غير مسدد أولاً؛ المكتملة (null) في الذيل ثم بالأحدث إنشاءً
  rows.sort((a, b) => {
    if (a.nextDue === null && b.nextDue === null) return b.id - a.id;
    if (a.nextDue === null) return 1;
    if (b.nextDue === null) return -1;
    return a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : b.id - a.id;
  });
  return rows;
}

/**
 * خطة واحدة بتفصيل كامل: الطرف (هاتفه وواتسابه للتذكير)، عملتها، فاتورة
 * مصدرها (رقمها وإجماليها ومتبقيها الحي بنفس دلالات الدومين)، وجدول
 * الأقساط كاملاً بالتسلسل. null إن لم توجد.
 */
export async function getInstallmentPlan(
  adapter: SqliteAdapter,
  id: number,
): Promise<InstallmentPlanDetailRow | null> {
  const rows = await adapter.all<{
    id: number;
    customer_id: number;
    customer_name: string | null;
    customer_phone: string | null;
    customer_whatsapp: string | null;
    invoice_id: number;
    invoice_no: string | null;
    invoice_total: string | null;
    invoice_due: string | null;
    invoice_allocated: string | number | null;
    currency_id: number;
    currency_code: string;
    currency_decimals: number;
    principal: string;
    down_payment: string | null;
    total_paid: string | null;
    exchange_rate: string;
    months: number;
    cycle: string | null;
    first_due: string;
    status: string | null;
    created_at: string | null;
  }>(
    `SELECT p.id, p.customer_id, p.invoice_id, p.months, p.cycle, p.first_due,
            p.principal, p.down_payment, p.total_paid, p.status, p.created_at,
            p.exchange_rate,
            cu.name AS customer_name, cu.phone AS customer_phone, cu.whatsapp AS customer_whatsapp,
            i.invoice_no, i.total AS invoice_total, i.due_amount AS invoice_due,
            (SELECT SUM(pa.allocated_amount) FROM payment_allocation pa
             JOIN cash_tx ct ON ct.id = pa.cash_tx_id
             WHERE pa.invoice_id = i.id AND ct.is_voided = 0
               AND ct.reversal_of IS NULL AND ct.tx_type = 'receipt') AS invoice_allocated,
            cur.id AS currency_id, cur.code AS currency_code, cur.decimals AS currency_decimals
     FROM installment_plan p
     JOIN customer cu ON cu.id = p.customer_id
     JOIN currency cur ON cur.id = p.currency_id
     LEFT JOIN invoice i ON i.id = p.invoice_id
     WHERE p.id = ?`,
    [id],
  );
  const p = rows[0];
  if (!p) return null;
  const schedule = await adapter.all<{
    id: number;
    seq: number;
    due_date: string;
    amount: string;
    paid_amount: string | null;
    status: string | null;
    paid_at: string | null;
    cash_tx_id: number | null;
  }>(
    `SELECT id, seq, due_date, amount, paid_amount, status, paid_at, cash_tx_id
     FROM installment WHERE plan_id = ? ORDER BY seq ASC`,
    [id],
  );
  let paidCount = 0;
  let remaining = d(0);
  let nextDue: string | null = null;
  for (const x of schedule) {
    if ((x.status ?? 'pending') === 'paid') {
      paidCount += 1;
      continue;
    }
    remaining = remaining.plus(d(x.amount).minus(d(x.paid_amount ?? '0')));
    if (nextDue === null || x.due_date < nextDue) nextDue = x.due_date;
  }
  return {
    id: Number(p.id),
    customerId: Number(p.customer_id),
    customerName: p.customer_name ?? null,
    invoiceId: Number(p.invoice_id),
    invoiceNo: p.invoice_no ?? null,
    currencyId: Number(p.currency_id),
    currencyCode: p.currency_code,
    currencyDecimals: parseDecimals(p.currency_decimals),
    principal: p.principal,
    downPayment: p.down_payment ?? '0.0000',
    totalPaid: p.total_paid ?? '0.0000',
    exchangeRate: p.exchange_rate,
    months: Number(p.months),
    cycle: planCycleOf(p.cycle),
    firstDue: p.first_due,
    status: planStatusOf(p.status),
    createdAt: p.created_at ?? null,
    paidCount,
    totalCount: schedule.length,
    remaining: f4(remaining),
    nextDue,
    customerPhone: p.customer_phone ?? null,
    customerWhatsapp: p.customer_whatsapp ?? null,
    invoiceTotal: p.invoice_total ?? null,
    invoiceRemaining:
      p.invoice_total !== null
        ? f4(d(p.invoice_due ?? '0').minus(d(p.invoice_allocated ?? 0)))
        : null,
    schedule: schedule.map((x) => ({
      id: Number(x.id),
      seq: Number(x.seq),
      dueDate: x.due_date,
      amount: x.amount,
      paidAmount: x.paid_amount ?? '0.0000',
      status: instStatusOf(x.status),
      paidAt: x.paid_at ?? null,
      cashTxId: x.cash_tx_id === null ? null : Number(x.cash_tx_id),
    })),
  };
}

/**
 * الأقساط غير المسددة المستحقة داخل النافذة (تشمل المتأخر منها — due_date
 * قبل اليوم) مع طرفها وفاتورتها وعملتها — لقائمة «المستحق اليوم/هذا
 * الأسبوع» وشريط الملخص (FR-05-02/05).
 */
export async function listDueInstallments(
  adapter: SqliteAdapter,
  opts: { today: string; withinDays?: number },
): Promise<DueInstallmentRow[]> {
  const limit = addDaysISO(opts.today, opts.withinDays ?? 7);
  const rows = await adapter.all<{
    id: number;
    plan_id: number;
    seq: number;
    due_date: string;
    amount: string;
    paid_amount: string | null;
    status: string | null;
    plan_status: string | null;
    customer_id: number;
    customer_name: string | null;
    customer_phone: string | null;
    customer_whatsapp: string | null;
    invoice_id: number;
    invoice_no: string | null;
    currency_id: number;
    currency_code: string;
    currency_decimals: number;
  }>(
    `SELECT i.id, i.plan_id, i.seq, i.due_date, i.amount, i.paid_amount, i.status,
            p.status AS plan_status, p.customer_id, p.invoice_id,
            cu.name AS customer_name, cu.phone AS customer_phone, cu.whatsapp AS customer_whatsapp,
            inv.invoice_no,
            cur.id AS currency_id, cur.code AS currency_code, cur.decimals AS currency_decimals
     FROM installment i
     JOIN installment_plan p ON p.id = i.plan_id
     JOIN customer cu ON cu.id = p.customer_id
     JOIN currency cur ON cur.id = p.currency_id
     LEFT JOIN invoice inv ON inv.id = p.invoice_id
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
    paidAmount: r.paid_amount ?? '0.0000',
    remaining: f4(d(r.amount).minus(d(r.paid_amount ?? '0'))),
    status: instStatusOf(r.status),
    planStatus: r.plan_status ?? 'active',
    customerId: Number(r.customer_id),
    customerName: r.customer_name ?? null,
    customerPhone: r.customer_phone ?? null,
    customerWhatsapp: r.customer_whatsapp ?? null,
    invoiceId: Number(r.invoice_id),
    invoiceNo: r.invoice_no ?? null,
    currencyId: Number(r.currency_id),
    currencyCode: r.currency_code,
    currencyDecimals: parseDecimals(r.currency_decimals),
  }));
}

/**
 * ملخص خطة فاتورة (بطاقة «خطة تقسيط» الشرطية في تفاصيل الفاتورة) —
 * SELECT واحد بأعداد ومواعيد فقط (لا جمع أموال بREAL). null إن لا خطة.
 */
export async function getInvoicePlanSummary(
  adapter: SqliteAdapter,
  invoiceId: number,
): Promise<InvoicePlanSummaryRow | null> {
  const rows = await adapter.all<{
    id: number;
    status: string | null;
    months: number;
    cycle: string | null;
    paid_count: number;
    total_count: number;
    next_due: string | null;
  }>(
    `SELECT p.id, p.status, p.months, p.cycle,
            (SELECT COUNT(*) FROM installment x
              WHERE x.plan_id = p.id AND x.status = 'paid') AS paid_count,
            (SELECT COUNT(*) FROM installment x WHERE x.plan_id = p.id) AS total_count,
            (SELECT MIN(x.due_date) FROM installment x
              WHERE x.plan_id = p.id AND x.status != 'paid') AS next_due
     FROM installment_plan p
     WHERE p.invoice_id = ? AND p.status != 'cancelled'
     ORDER BY p.id DESC
     LIMIT 1`,
    [invoiceId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    planId: Number(r.id),
    status: r.status ?? 'active',
    months: Number(r.months),
    cycle: r.cycle ?? 'monthly',
    paidCount: Number(r.paid_count ?? 0),
    totalCount: Number(r.total_count ?? 0),
    nextDue: r.next_due ?? null,
  };
}

/* ================================================================
 *  الجرد (FR-01-08 — قراءة العرض فقط) — Task 16: الإضافة تُلحق
 *  بنهاية الملف حصراً: fetchStocktakeCandidates / fetchStocktakes /
 *  fetchStocktakeDetails. لا كتابة هنا أبداً — الاعتماد عبر
 *  domain/stocktake.createStocktake (Transaction ذرّية + audit).
 * ================================================================ */

/** مرشّح الجرد: صنف مخزني قابل للعدّ في مخزن معيّن */
export interface StocktakeCandidateRow {
  productId: number;
  name: string;
  /** اسم وحدة القياس إن ضُبطت في الصنف */
  unitName: string | null;
  /** الرصيد الدفتري في المخزن (3dp) — 0 إن لا صف stock_level */
  bookQty: string;
  /** لقطة WAC (4dp) — تكلفة التسوية المرتقبة (قرار 10) */
  avgCost: string;
  /** حد الطلب الأدنى (لعرض تنبيه تحت الحد أثناء العدّ) */
  minQty: string;
}

/**
 * مرشّحو الجرد لمخزن: كل الأصناف **غير الخدمية** غير المؤرشفة مع رصيدها
 * الدفتري في المخزن (LEFT JOIN stock_level — من بلا صف رصيده 0، فزيادة صنف
 * غير المسجَّل بعد تُعدّ وتُسوّى)، مرتبة بالاسم. القراءة فقط.
 */
export async function fetchStocktakeCandidates(
  adapter: SqliteAdapter,
  warehouseId: number,
): Promise<StocktakeCandidateRow[]> {
  const rows = await adapter.all<{
    id: number;
    name: string;
    unit_name: string | null;
    qty: string | null;
    cost_price: string;
    min_stock: string;
  }>(
    `SELECT p.id, p.name, p.cost_price, p.min_stock,
            u.name AS unit_name,
            sl.qty AS qty
     FROM product p
     LEFT JOIN stock_level sl
       ON sl.product_id = p.id AND sl.warehouse_id = ?
     LEFT JOIN unit u ON u.id = p.unit_id
     WHERE p.is_service = 0 AND p.is_archived = 0
     ORDER BY p.name ASC`,
    [warehouseId],
  );
  return rows.map((r) => ({
    productId: Number(r.id),
    name: r.name,
    unitName: r.unit_name ?? null,
    bookQty: r.qty ?? '0.000',
    avgCost: r.cost_price,
    minQty: r.min_stock,
  }));
}

/** صف جرد لقائمة السجل (شاشة «سجل الجرد») */
export interface StocktakeListRow {
  id: number;
  warehouseId: number;
  warehouseName: string;
  countedAt: string;
  /** Σ(diff × unit_cost) موقّعة (4dp) بالعملة الأساسية */
  totalDiff: string;
  status: string;
  notes: string | null;
  createdAt: string | null;
  linesCount: number;
  diffsCount: number;
}

/** سجل عمليات الجرد — الأحدث أولاً (تاريخ الجرد ثم المعرّف) */
export async function fetchStocktakes(
  adapter: SqliteAdapter,
): Promise<StocktakeListRow[]> {
  const rows = await adapter.all<{
    id: number;
    warehouse_id: number;
    warehouse_name: string;
    counted_at: string;
    total_diff: string | null;
    status: string | null;
    notes: string | null;
    created_at: string | null;
    lines_count: number;
    diffs_count: number;
  }>(
    `SELECT s.id, s.counted_at, s.total_diff, s.status, s.notes, s.created_at,
            w.id AS warehouse_id, w.name AS warehouse_name,
            (SELECT COUNT(*) FROM stocktake_line l WHERE l.stocktake_id = s.id) AS lines_count,
            (SELECT COUNT(*) FROM stocktake_line l
              WHERE l.stocktake_id = s.id AND CAST(l.diff_qty AS REAL) <> 0) AS diffs_count
     FROM stocktake s
     JOIN warehouse w ON w.id = s.warehouse_id
     ORDER BY s.counted_at DESC, s.id DESC`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    warehouseId: Number(r.warehouse_id),
    warehouseName: r.warehouse_name,
    countedAt: r.counted_at,
    totalDiff: r.total_diff ?? '0.0000',
    status: r.status ?? 'completed',
    notes: r.notes ?? null,
    createdAt: r.created_at ?? null,
    linesCount: Number(r.lines_count ?? 0),
    diffsCount: Number(r.diffs_count ?? 0),
  }));
}

/** سطر تفصيل جرد مع بياناته المشتقة */
export interface StocktakeLineRow {
  id: number;
  productId: number;
  productName: string;
  bookQty: string;
  countedQty: string;
  diffQty: string;
  /** لقطة تكلفة الوحدة وقت الجرد (4dp — قرار 10) */
  unitCost: string;
  /** قيمة الفرق = diff × unit_cost (4dp موقّعة — Decimal في الذاكرة) */
  lineValue: string;
}

export interface StocktakeDetailsRow extends StocktakeListRow {
  lines: StocktakeLineRow[];
}

/** تفاصيل جرد واحد: الترويسة + كل الأسطر بأسماء الأصناف — null إن لا جرد */
export async function fetchStocktakeDetails(
  adapter: SqliteAdapter,
  id: number,
): Promise<StocktakeDetailsRow | null> {
  const headRows = await adapter.all<{
    id: number;
    warehouse_id: number;
    warehouse_name: string;
    counted_at: string;
    total_diff: string | null;
    status: string | null;
    notes: string | null;
    created_at: string | null;
    lines_count: number;
    diffs_count: number;
  }>(
    `SELECT s.id, s.counted_at, s.total_diff, s.status, s.notes, s.created_at,
            w.id AS warehouse_id, w.name AS warehouse_name,
            (SELECT COUNT(*) FROM stocktake_line l WHERE l.stocktake_id = s.id) AS lines_count,
            (SELECT COUNT(*) FROM stocktake_line l
              WHERE l.stocktake_id = s.id AND CAST(l.diff_qty AS REAL) <> 0) AS diffs_count
     FROM stocktake s
     JOIN warehouse w ON w.id = s.warehouse_id
     WHERE s.id = ?`,
    [id],
  );
  const head = headRows[0];
  if (!head) return null;
  const rows = await adapter.all<{
    id: number;
    product_id: number;
    product_name: string;
    book_qty: string;
    counted_qty: string;
    diff_qty: string;
    unit_cost: string;
  }>(
    `SELECT l.id, l.product_id, l.book_qty, l.counted_qty, l.diff_qty, l.unit_cost,
            p.name AS product_name
     FROM stocktake_line l
     JOIN product p ON p.id = l.product_id
     WHERE l.stocktake_id = ?
     ORDER BY l.id ASC`,
    [id],
  );
  const lines: StocktakeLineRow[] = rows.map((r) => ({
    id: Number(r.id),
    productId: Number(r.product_id),
    productName: r.product_name,
    bookQty: r.book_qty,
    countedQty: r.counted_qty,
    diffQty: r.diff_qty,
    unitCost: r.unit_cost,
    lineValue: f4(d(r.diff_qty).times(d(r.unit_cost))),
  }));
  return {
    id: Number(head.id),
    warehouseId: Number(head.warehouse_id),
    warehouseName: head.warehouse_name,
    countedAt: head.counted_at,
    totalDiff: head.total_diff ?? '0.0000',
    status: head.status ?? 'completed',
    notes: head.notes ?? null,
    createdAt: head.created_at ?? null,
    linesCount: Number(head.lines_count ?? 0),
    diffsCount: Number(head.diffs_count ?? 0),
    lines,
  };
}

