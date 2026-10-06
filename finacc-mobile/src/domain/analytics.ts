/**
 * analytics.ts — تقارير تحليلات المخزون والمبيعات (FR-09-03/04/06/12 — Task 17).
 *
 * أربعة تقارير قراءة نقية فوق stock_movement/invoice/invoice_item/stock_level:
 *  - **getItemCard (FR-09-03 أساسية)**: بطاقة صنف — كل حركات صنف واحد بالباقي
 *    التراكمي لفترة/مخزن. «رصيد ما قبله» = مجموع الكميات الموقعة للحركات
 *    الحية **قبل** بداية الفترة؛ حين تغطي الفترة التاريخ كله (لا حركات قبلها)
 *    يبدأ التراكمي من أول صف بلا صف افتتاحي.
 *  - **getStockMovementSummary (FR-09-04 مهمة)**: ملخص حركة المخزون الكلي —
 *    لكل صنف: وارد/صادر/مرتجعان/تسوية/صافي/رصيد آخر الفترة + قيم الوارد
 *    والصادر بتكلفة الحركة (|qty| × unit_cost بالعملة الأساسية).
 *  - **getSalesBreakdown (FR-09-06 أساسية)**: المبيعات حسب العميل/الفئة/
 *    الصنف/اليوم لفترة، مع **نسبة التغير** مقابل الفترة السابقة المساوية
 *    في الطول مباشرة قبل «من» (prev==0 → changePct=null أي «جديد»).
 *  - **getBelowMinimum (FR-09-12 ثانوية)**: الأصناف تحت حد التنبيه (min_stock)
 *    برصيدها المجمّع عبر كل المخازن والنقص وسداد النقص التقديري بWAC.
 *
 * قواعد ملزمة مطبَّقة (مرآة reports.ts):
 *  - **حيوية الحركات (نمط getProfitAndLoss حرفياً)**: حركة sale/sale_return/
 *    purchase/purchase_return لا تُحتسب إلا لمستند مكتمل حي (LEFT JOIN invoice
 *    على ref_type='invoice' — الملغاة تسقط بحالة مستندها ومعاكسات الإلغاء
 *    ref_type='invoice_void' تسقط أصلاً لعدم التحاقها بمستند مكتمل). بهذا
 *    Σ(الحركات الحية) = stock_level دائماً (المسودة بلا حركات أصلاً — قرار 2).
 *  - **المبيعات المكتملة حصراً**: status='completed' (مسودة/ملغاة خارج) وبتواريخ
 *    الإصدار شاملة الطرفين (from ≤ issued_at ≤ to).
 *  - **العملة الأساسية فقط (قرار 3)**: المبيعات بtotal_base المحسوب وقت الحفظ
 *    بسعر يوم الحركة؛ بنود الصنف/الفئة بline_total × exchange_rate للمستند.
 *  - المبالغ نصوص عشرية دقيقة (4dp) والكميات (3dp) — لا Float ولا SUM رقمي
 *    في SQL: التجميع بDecimal في الذاكرة (قاعدة queries.ts).
 *  - الأصناف المؤرشفة: تبقى في تاريخ المبيعات وبطاقة الصنف (FR-01-15) لكنها
 *    **خارج تقرير تحت الحد الأدنى** — قائمة عمل تشغيلية تطابق عدّاد الداشبورد
 *    (fetchAlerts تستثني المؤرشف بالمثل).
 *
 * نقاء الوحدة (NFR-09/11): adapter + decimal + وحدات domain/شقيقة وutils فقط.
 */
import type { SqliteAdapter } from '../db/adapter';
import { addDaysISO } from '../utils/format';
import { d, Decimal, f3, f4 } from '../utils/money';
import { DomainRuleError, ValidationError } from './errors';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** تحقق تاريخ ISO صالح وإلا ValidationError عربية (نمط reports.ts) */
function assertIsoDate(label: string, value: string): void {
  if (!ISO_DATE.test(value)) {
    throw new ValidationError(`تاريخ ${label} غير صالح (المتوقع YYYY-MM-DD): ${value}`);
  }
}

/** تحقق فترة [from, to] — صيغة + ترتيب (نمط getProfitAndLoss) */
function assertPeriod(from: string, to: string): void {
  assertIsoDate('من', from);
  assertIsoDate('حتى', to);
  if (from > to) {
    throw new ValidationError(`بداية الفترة (${from}) بعد نهايتها (${to}) — اقلب الترتيب`);
  }
}

/* ==================== حيوية الحركات (مرآة getProfitAndLoss) ==================== */

/** أنواع الحركات المربوطة بفاتورة — لا تُحتسب إلا لمستند مكتمل حي */
const INVOICE_BOUND_TYPES = new Set(['sale', 'sale_return', 'purchase', 'purchase_return']);

/** صف حركة خام مع سياق مستندها (LEFT JOIN) — النمط الموحد للتقارير */
interface RawMovementRow {
  id: number;
  product_id: number;
  warehouse_id: number;
  movement_type: string;
  qty: string;
  unit_cost: string;
  ref_type: string | null;
  ref_id: number | null;
  moved_at: string;
  notes: string | null;
  inv_status: string | null;
}

/** حركة حية؟ — المربوطة بفاتورة تمر لمستند مكتمل فقط (الملغاة ومعاكساتها تسقط) */
function isLiveMovement(row: { movement_type: string; inv_status: string | null }): boolean {
  if (INVOICE_BOUND_TYPES.has(row.movement_type)) {
    return row.inv_status === 'completed';
  }
  return true; // opening/transfer/adjust: ليست مربوطة بفاتورة أبداً
}

/* ==================== تصنيف الحركة (FR-09-04) ==================== */

/** وجهة كمية نوع حركة: وارد / صادر / تسوية موقّعة */
function movementSide(type: string): 'in' | 'out' | 'adjust' {
  switch (type) {
    case 'purchase':
    case 'opening':
    case 'transfer_in':
    case 'sale_return':
      return 'in';
    case 'sale':
    case 'purchase_return':
    case 'transfer_out':
      return 'out';
    default:
      // stocktake_adjust / manual_adjust — إشارة الكمية تحدد الاتجاه
      return 'adjust';
  }
}

/* ============================ بطاقة صنف (FR-09-03) ============================ */

/** صف حركة في البطاقة — بالباقي التراكمي بعد الحركة */
export interface ItemCardRow {
  id: number;
  movedAt: string;
  movementType: string;
  /** كمية موقّعة (3dp): موجبة وارد / سالبة صادر */
  qty: string;
  /** تكلفة الوحدة بالعملة الأساسية (4dp — لقطة الحركة) */
  unitCost: string;
  refType: string | null;
  refId: number | null;
  notes: string | null;
  warehouseName: string;
  /** الباقي التراكمي بعد هذه الحركة (3dp) */
  running: string;
}

export interface ItemCardTotals {
  /** Σ الكميات الموجبة داخل الفترة (3dp) */
  inQty: string;
  /** Σ |الكميات السالبة| داخل الفترة (3dp) */
  outQty: string;
  /** صافي الفترة = وارد − صادر (3dp — التسويات داخل الإشارة) */
  netQty: string;
  /** الرصيد آخر الفترة = رصيد ما قبله + الصافي (3dp) */
  endQty: string;
}

export interface ItemCardReport {
  productId: number;
  productName: string;
  unitName: string | null;
  period: { from: string; to: string };
  warehouseId: number | null;
  warehouseName: string | null;
  /**
   * «رصيد ما قبله» — مجموع كميات الحركات الحية قبل بداية الفترة (بنفس فلتر
   * المخزن). null حين لا حركات قبلها (الفترة تبدأ من أول التاريخ) — يبدأ
   * التراكمي من أول صف بلا صف افتتاحي.
   */
  openingBalance: string | null;
  rows: ItemCardRow[];
  totals: ItemCardTotals;
}

/**
 * بطاقة صنف (FR-09-03): كل حركات صنف واحد بالباقي التراكمي، لفترة [from, to]
 * شاملة الطرفين ومخزن اختياري. الحركات مرتبة تصاعدياً (moved_at ثم id) —
 * الرصيد التراكمي يتراكم بDecimal 3dp من رصيد ما قبله (أو الصفر).
 */
export async function getItemCard(
  adapter: SqliteAdapter,
  opts: {
    productId: number;
    from: string;
    to: string;
    warehouseId?: number | null;
  },
): Promise<ItemCardReport> {
  const { productId, from, to } = opts;
  assertPeriod(from, to);
  const warehouseId = opts.warehouseId ?? null;

  // الصنف (وجود + اسم + وحدته) — مرآة حارس applyMovement
  const prodRows = await adapter.all<{ name: string; is_service: number; unit_name: string | null }>(
    `SELECT p.name, p.is_service, u.name AS unit_name
     FROM product p LEFT JOIN unit u ON u.id = p.unit_id
     WHERE p.id = ?`,
    [productId],
  );
  const prod = prodRows[0];
  if (!prod) {
    throw new DomainRuleError('PRODUCT_NOT_FOUND', `صنف غير موجود (معرّف ${productId})`);
  }

  // كل حركات الصنف (المخزن مفلتر) مع حيوية مستندها — مرة واحدة ثم تُقسَّم
  const movements = await adapter.all<RawMovementRow & { warehouse_name: string }>(
    `SELECT m.id, m.product_id, m.warehouse_id, m.movement_type, m.qty, m.unit_cost,
            m.ref_type, m.ref_id, m.moved_at, m.notes, i.status AS inv_status,
            w.name AS warehouse_name
     FROM stock_movement m
     LEFT JOIN invoice i ON i.id = m.ref_id AND m.ref_type = 'invoice'
     JOIN warehouse w ON w.id = m.warehouse_id
     WHERE m.product_id = ? ${warehouseId !== null ? 'AND m.warehouse_id = ?' : ''}
     ORDER BY m.moved_at ASC, m.id ASC`,
    warehouseId !== null ? [productId, warehouseId] : [productId],
  );

  let opening = new Decimal(0);
  const inPeriod: (RawMovementRow & { warehouse_name: string })[] = [];
  for (const m of movements) {
    if (!isLiveMovement(m)) continue; // ملغاة/معاكسة إلغاء — خارج البطاقة
    if (m.moved_at < from) {
      opening = opening.plus(d(m.qty));
    } else if (m.moved_at <= to) {
      inPeriod.push(m);
    } // بعد الفترة: لا تُعرض ولا تمس أرصدة الفترة
  }

  const hasBefore = movements.some((m) => isLiveMovement(m) && m.moved_at < from);

  let running = opening;
  let inQty = new Decimal(0);
  let outQty = new Decimal(0);
  const rows: ItemCardRow[] = inPeriod.map((m) => {
    const qty = d(m.qty);
    running = running.plus(qty);
    if (qty.gt(0)) inQty = inQty.plus(qty);
    else outQty = outQty.plus(qty.abs());
    return {
      id: Number(m.id),
      movedAt: m.moved_at,
      movementType: m.movement_type,
      qty: f3(qty),
      unitCost: m.unit_cost,
      refType: m.ref_type,
      refId: m.ref_id === null ? null : Number(m.ref_id),
      notes: m.notes,
      warehouseName: m.warehouse_name,
      running: f3(running),
    };
  });

  const netQty = inQty.minus(outQty);
  return {
    productId,
    productName: prod.name,
    unitName: prod.unit_name,
    period: { from, to },
    warehouseId,
    warehouseName: null, // يملؤه المستدعي إن أراد تسمية الفلتر (الشاشة تعرف الاسم)
    openingBalance: hasBefore ? f3(opening) : null,
    rows,
    totals: {
      inQty: f3(inQty),
      outQty: f3(outQty),
      netQty: f3(netQty),
      endQty: f3(opening.plus(netQty)),
    },
  };
}

/* ==================== ملخص حركة المخزون الكلي (FR-09-04) ==================== */

export interface StockMovementSummaryRow {
  productId: number;
  name: string;
  unitName: string | null;
  /** وارد = purchase + opening + transfer_in + sale_return (3dp) */
  inQty: string;
  /** صادر = sale + purchase_return + transfer_out (3dp) */
  outQty: string;
  /** مرتجع بيع — تفصيل ضمن الوارد (3dp) */
  returnsIn: string;
  /** مرتجع شراء — تفصيل ضمن الصادر (3dp) */
  returnsOut: string;
  /** تسويات (stocktake_adjust + manual_adjust) بإشارة الكمية (3dp) */
  adjustQty: string;
  /** الصافي = وارد − صادر + تسوية (3dp) */
  netQty: string;
  /** الرصيد آخر الفترة (3dp) — من تاريخ الحركات الحية */
  endQty: string;
  /** قيمة الوارد بالأساس: Σ |qty| × unit_cost لحركات الوارد (4dp) */
  valueIn: string;
  /** قيمة الصادر بالأساس: Σ |qty| × unit_cost لحركات الصادر (4dp) */
  valueOut: string;
}

export interface StockMovementSummary {
  period: { from: string; to: string };
  warehouseId: number | null;
  rows: StockMovementSummaryRow[];
  totals: {
    inQty: string;
    outQty: string;
    adjustQty: string;
    netQty: string;
    valueIn: string;
    valueOut: string;
  };
}

/**
 * ملخص حركة المخزون الكلي (FR-09-04): لكل صنف له حركة داخل الفترة —
 * الوارد/الصادر/المرتجعان/التسويات بإشاراتها والصافي والرصيد آخر الفترة،
 * وقيمتا الوارد والصادر بتكلفة كل حركة (لقطة unit_cost بالأساس).
 *
 * رصيد آخر الفترة = الرصيد الحالي (stock_level) − Σ حركات **بعد** نهاية
 * الفترة (الحية) — يكافئ «رصيد ما قبله + صافي الفترة» لأن مجموع الحركات
 * الحية يساوي الرصيد الحالي دائماً (الملغاة ومعاكساتها تتساقط معاً).
 */
export async function getStockMovementSummary(
  adapter: SqliteAdapter,
  opts: { from: string; to: string; warehouseId?: number | null },
): Promise<StockMovementSummary> {
  const { from, to } = opts;
  assertPeriod(from, to);
  const warehouseId = opts.warehouseId ?? null;
  const wh = warehouseId !== null ? 'AND m.warehouse_id = ?' : '';
  const zero = (): Decimal => new Decimal(0);

  interface Agg {
    name: string;
    unitName: string | null;
    inQty: Decimal;
    outQty: Decimal;
    returnsIn: Decimal;
    returnsOut: Decimal;
    adjustQty: Decimal;
    valueIn: Decimal;
    valueOut: Decimal;
    afterQty: Decimal;
  }
  const aggs = new Map<number, Agg>();
  const aggOf = (id: number, name: string, unitName: string | null): Agg => {
    let a = aggs.get(id);
    if (!a) {
      a = {
        name,
        unitName,
        inQty: zero(),
        outQty: zero(),
        returnsIn: zero(),
        returnsOut: zero(),
        adjustQty: zero(),
        valueIn: zero(),
        valueOut: zero(),
        afterQty: zero(),
      };
      aggs.set(id, a);
    }
    return a;
  };

  // 1) حركات الفترة (حيوية فقط) — تجميع لكل صنف
  const periodRows = await adapter.all<RawMovementRow & { p_name: string; unit_name: string | null }>(
    `SELECT m.id, m.product_id, m.warehouse_id, m.movement_type, m.qty, m.unit_cost,
            m.ref_type, m.ref_id, m.moved_at, m.notes, i.status AS inv_status,
            p.name AS p_name, u.name AS unit_name
     FROM stock_movement m
     LEFT JOIN invoice i ON i.id = m.ref_id AND m.ref_type = 'invoice'
     LEFT JOIN product p ON p.id = m.product_id
     LEFT JOIN unit u ON u.id = p.unit_id
     WHERE m.moved_at >= ? AND m.moved_at <= ? ${wh}`,
    warehouseId !== null ? [from, to, warehouseId] : [from, to],
  );
  for (const m of periodRows) {
    if (!isLiveMovement(m)) continue;
    const a = aggOf(Number(m.product_id), m.p_name, m.unit_name);
    const qty = d(m.qty);
    const value = qty.abs().times(d(m.unit_cost));
    switch (movementSide(m.movement_type)) {
      case 'in':
        a.inQty = a.inQty.plus(qty);
        a.valueIn = a.valueIn.plus(value);
        if (m.movement_type === 'sale_return') a.returnsIn = a.returnsIn.plus(qty);
        break;
      case 'out':
        a.outQty = a.outQty.plus(qty.abs());
        a.valueOut = a.valueOut.plus(value);
        if (m.movement_type === 'purchase_return') a.returnsOut = a.returnsOut.plus(qty.abs());
        break;
      default:
        a.adjustQty = a.adjustQty.plus(qty);
        break;
    }
  }

  // 2) حركات ما بعد الفترة (حيوية) — لطرحها من الرصيد الحالي
  const productIds = [...aggs.keys()];
  if (productIds.length > 0) {
    const afterRows = await adapter.all<{ product_id: number; qty: string; movement_type: string; inv_status: string | null }>(
      `SELECT m.product_id, m.qty, m.movement_type, i.status AS inv_status
       FROM stock_movement m
       LEFT JOIN invoice i ON i.id = m.ref_id AND m.ref_type = 'invoice'
       WHERE m.moved_at > ? AND m.product_id IN (${productIds.map(() => '?').join(',')}) ${wh}
       ORDER BY m.moved_at ASC, m.id ASC`,
      warehouseId !== null ? [to, ...productIds, warehouseId] : [to, ...productIds],
    );
    for (const m of afterRows) {
      if (!isLiveMovement(m)) continue;
      const a = aggs.get(Number(m.product_id));
      if (a) a.afterQty = a.afterQty.plus(d(m.qty));
    }
  }

  // 3) الأرصدة الحالية (بفلتر المخزن) — الرصيد الحقيقي المرآة
  const levelRows =
    productIds.length > 0
      ? await adapter.all<{ product_id: number; qty: string }>(
          `SELECT product_id, qty FROM stock_level WHERE product_id IN (${productIds.map(() => '?').join(',')}) ${warehouseId !== null ? 'AND warehouse_id = ?' : ''}`,
          warehouseId !== null ? [...productIds, warehouseId] : productIds,
        )
      : [];
  const levels = new Map<number, Decimal>();
  for (const r of levelRows) {
    const pid = Number(r.product_id);
    levels.set(pid, (levels.get(pid) ?? zero()).plus(d(r.qty)));
  }

  const rows: StockMovementSummaryRow[] = [];
  let tIn = zero();
  let tOut = zero();
  let tAdjust = zero();
  let tValueIn = zero();
  let tValueOut = zero();
  for (const [pid, a] of aggs) {
    const net = a.inQty.minus(a.outQty).plus(a.adjustQty);
    const end = (levels.get(pid) ?? zero()).minus(a.afterQty);
    rows.push({
      productId: pid,
      name: a.name,
      unitName: a.unitName,
      inQty: f3(a.inQty),
      outQty: f3(a.outQty),
      returnsIn: f3(a.returnsIn),
      returnsOut: f3(a.returnsOut),
      adjustQty: f3(a.adjustQty),
      netQty: f3(net),
      endQty: f3(end),
      valueIn: f4(a.valueIn),
      valueOut: f4(a.valueOut),
    });
    tIn = tIn.plus(a.inQty);
    tOut = tOut.plus(a.outQty);
    tAdjust = tAdjust.plus(a.adjustQty);
    tValueIn = tValueIn.plus(a.valueIn);
    tValueOut = tValueOut.plus(a.valueOut);
  }
  // الأكبر صافي حركة أولاً ثم الاسم — مسح بصري أسرع للمخطئة
  rows.sort((x, y) => d(y.inQty).plus(d(y.outQty)).cmp(d(x.inQty).plus(d(x.outQty))));

  return {
    period: { from, to },
    warehouseId,
    rows,
    totals: {
      inQty: f3(tIn),
      outQty: f3(tOut),
      adjustQty: f3(tAdjust),
      netQty: f3(tIn.minus(tOut).plus(tAdjust)),
      valueIn: f4(tValueIn),
      valueOut: f4(tValueOut),
    },
  };
}

/* ==================== المبيعات حسب (FR-09-06) ==================== */

export type SalesBreakdownBy = 'customer' | 'category' | 'item' | 'day';

/** صف مجموعة مبيعات — مع نسبة التغير عن الفترة السابقة المقابلة */
export interface SalesBreakdownRow {
  /** مفتاح المجموعة (معرّف/تاريخ) — نصي للتوحيد */
  key: string;
  label: string;
  /** معرّف مرجعي للتنقل (عميل/فئة/صنف) — null لليوم والعميل النقدي */
  refId: number | null;
  refKind: 'customer' | 'category' | 'product' | null;
  /** عدد فواتير البيع في المجموعة (الفترة الحالية) */
  invoicesCount: number;
  /** إجمالي المبيعات بالعملة الأساسية (4dp) — إجمالي الفواتير بلا مرتجعات */
  total: string;
  /** مرتجعات المبيعات بالأساس (4dp) — عمود بتجزئة العميل حصراً، وإلا '0.0000' */
  returnsTotal: string;
  /** إجمالي الفترة السابقة المقابلة (4dp) — '0.0000' إن لم توجد */
  prevTotal: string;
  /** نسبة التغير % مقربة عشر منزلة — null حين السابقة صفر («جديد») */
  changePct: number | null;
}

export interface SalesBreakdown {
  by: SalesBreakdownBy;
  period: { from: string; to: string };
  /** الفترة السابقة المقابلة — بنفس الطول مباشرة قبل «من» */
  prevPeriod: { from: string; to: string };
  rows: SalesBreakdownRow[];
  totals: {
    invoicesCount: number;
    total: string;
    returnsTotal: string;
    prevTotal: string;
    changePct: number | null;
  };
}

/** مجموعة خام لفترة واحدة — تبنيها fetchSalesGroups ثم تُقرن بالسابقة */
interface SalesGroup {
  label: string;
  refId: number | null;
  refKind: 'customer' | 'category' | 'product' | null;
  count: number;
  total: Decimal;
}

/** فترة سابقة مقابلة: بنفس عدد الأيام، تنتهي اليومَ قبل «من» */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  ) + 1;
  const prevTo = addDaysISO(from, -1);
  return { from: addDaysISO(prevTo, -(days - 1)), to: prevTo };
}

/** يجمع مبيعات فترة واحدة حسب وجهة التجزئة — فواتير مكتملة حصراً */
async function fetchSalesGroups(
  adapter: SqliteAdapter,
  by: SalesBreakdownBy,
  from: string,
  to: string,
): Promise<Map<string, SalesGroup>> {
  const groups = new Map<string, SalesGroup>();
  const put = (
    key: string,
    label: string,
    refId: number | null,
    refKind: SalesGroup['refKind'],
    value: Decimal,
    count = 0,
  ): void => {
    const g =
      groups.get(key) ?? { label, refId, refKind, count: 0, total: d(0) };
    g.total = g.total.plus(value);
    g.count += count;
    groups.set(key, g);
  };

  if (by === 'customer' || by === 'day') {
    // تجميع على مستوى الفاتورة (total_base — قرار 3)
    const rows = await adapter.all<{
      id: number;
      customer_id: number | null;
      customer_name: string | null;
      issued_at: string;
      total_base: string;
    }>(
      `SELECT i.id, i.customer_id, cu.name AS customer_name, i.issued_at, i.total_base
       FROM invoice i
       LEFT JOIN customer cu ON cu.id = i.customer_id
       WHERE i.doc_type = 'sale' AND i.status = 'completed'
         AND i.issued_at >= ? AND i.issued_at <= ?`,
      [from, to],
    );
    for (const r of rows) {
      if (by === 'day') {
        const day = r.issued_at.slice(0, 10);
        put(day, day, null, null, d(r.total_base), 1);
      } else {
        const cid = r.customer_id === null ? null : Number(r.customer_id);
        // العميل النقدي: refKind='customer' (بلا refId) كي تعرضه الواجهة «عميل نقدي»
        // لا «سطر حر» — التمييز بrefKind لا بkey النصي (استُخدم في الاختبارات).
        put(
          cid === null ? 'cash' : String(cid),
          r.customer_name ?? '',
          cid,
          'customer',
          d(r.total_base),
          1,
        );
      }
    }
    return groups;
  }

  // by === 'item' | 'category' — تجميع على مستوى البند (line_total × سعر المستند)
  const rows = await adapter.all<{
    invoice_id: number;
    product_id: number | null;
    line_desc: string | null;
    line_total: string;
    exchange_rate: string;
    product_name: string | null;
    category_id: number | null;
    category_name: string | null;
  }>(
    `SELECT ii.invoice_id, ii.product_id, ii.line_desc, ii.line_total, i.exchange_rate,
            p.name AS product_name, p.category_id, c.name AS category_name
     FROM invoice_item ii
     JOIN invoice i ON i.id = ii.invoice_id
     LEFT JOIN product p ON p.id = ii.product_id
     LEFT JOIN category c ON c.id = p.category_id
     WHERE i.doc_type = 'sale' AND i.status = 'completed'
       AND i.issued_at >= ? AND i.issued_at <= ?`,
    [from, to],
  );
  const counted = new Set<string>(); // عدّ الفواتير مرة لكل مجموعة (لا لكل بند)
  for (const r of rows) {
    const base = d(r.line_total).times(d(r.exchange_rate));
    if (by === 'item') {
      const pid = r.product_id === null ? null : Number(r.product_id);
      const key = pid === null ? `free:${r.invoice_id}` : String(pid);
      const label = pid === null ? r.line_desc ?? '' : r.product_name ?? '';
      const dedup = `${key}:${r.invoice_id}`;
      const isNew = !counted.has(dedup);
      if (isNew) counted.add(dedup);
      put(key, label, pid, pid === null ? null : 'product', base, isNew ? 1 : 0);
    } else {
      const cat = r.category_id === null ? null : Number(r.category_id);
      const key = cat === null ? 'none' : String(cat);
      const label = cat === null ? '' : r.category_name ?? '';
      const dedup = `${key}:${r.invoice_id}`;
      const isNew = !counted.has(dedup);
      if (isNew) counted.add(dedup);
      // بلا فئة: refKind='category' (بلا refId) كي تعرضه الواجهة «بلا فئة» لا «سطر حر»
      put(key, label, cat, 'category', base, isNew ? 1 : 0);
    }
  }
  return groups;
}

/** مرتجعات بيع فترة — بتجزئة العميل حصراً (عمود إضافي في تلك الشاشة) */
async function fetchCustomerReturns(
  adapter: SqliteAdapter,
  from: string,
  to: string,
): Promise<Map<number, Decimal>> {
  const rows = await adapter.all<{ customer_id: number | null; total_base: string }>(
    `SELECT i.customer_id, i.total_base
     FROM invoice i
     WHERE i.doc_type = 'sale_return' AND i.status = 'completed'
       AND i.issued_at >= ? AND i.issued_at <= ?`,
    [from, to],
  );
  const out = new Map<number, Decimal>();
  for (const r of rows) {
    if (r.customer_id === null) continue;
    const cid = Number(r.customer_id);
    out.set(cid, (out.get(cid) ?? d(0)).plus(d(r.total_base)));
  }
  return out;
}

/**
 * المبيعات حسب العميل/الفئة/الصنف/اليوم (FR-09-06) لفترة [from, to] —
 * فواتير البيع المكتملة حصراً بعملة الأساس، مع نسبة التغير % مقابل الفترة
 * السابقة المساوية في الطول (prev==0 → changePct=null أي «جديد» جديد).
 * الصفوف: حسب اليوم تصاعدياً؛ حسب العميل/الفئة/الصنف بالأعلى مبيعاً أولاً.
 */
export async function getSalesBreakdown(
  adapter: SqliteAdapter,
  opts: { from: string; to: string; by: SalesBreakdownBy },
): Promise<SalesBreakdown> {
  const { by } = opts;
  assertPeriod(opts.from, opts.to);
  const prev = previousPeriod(opts.from, opts.to);

  const [cur, prevGroups, returns] = await Promise.all([
    fetchSalesGroups(adapter, by, opts.from, opts.to),
    fetchSalesGroups(adapter, by, prev.from, prev.to),
    by === 'customer' ? fetchCustomerReturns(adapter, opts.from, opts.to) : Promise.resolve(null),
  ]);

  const rows: SalesBreakdownRow[] = [];
  for (const [key, g] of cur) {
    const prevG = prevGroups.get(key);
    const prevTotal = prevG ? prevG.total : d(0);
    const curTotal = g.total;
    const changePct =
      prevTotal.isZero()
        ? null // «جديد» — لا أساس للمقارنة (والصافي صفر بلا صف أصلاً)
        : Number(
            curTotal
              .minus(prevTotal)
              .div(prevTotal)
              .times(100)
              .toDecimalPlaces(1, Decimal.ROUND_HALF_UP),
          );
    rows.push({
      key,
      label: g.label,
      refId: g.refId,
      refKind: g.refKind,
      invoicesCount: g.count,
      total: f4(curTotal),
      returnsTotal: '0.0000',
      prevTotal: f4(prevTotal),
      changePct,
    });
  }

  // مرتجعات التجزئة بالعميل — عمود إضافي حصراً هناك
  if (returns !== null) {
    for (const row of rows) {
      if (row.refKind === 'customer' && row.refId !== null) {
        const r = returns.get(row.refId);
        if (r) row.returnsTotal = f4(r);
      }
    }
  }

  // ترتيب: اليوم تصاعدياً؛ الباقي بالأعلى مبيعاً ثم بالاسم
  rows.sort((a, b) => {
    if (by === 'day') return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    const cmpTotal = d(b.total).cmp(d(a.total));
    if (cmpTotal !== 0) return cmpTotal;
    return a.label.localeCompare(b.label, 'ar');
  });

  const totalCount = rows.reduce((n, r) => n + r.invoicesCount, 0);
  const total = rows.reduce((s, r) => s.plus(d(r.total)), d(0));
  const returnsTotal = rows.reduce((s, r) => s.plus(d(r.returnsTotal)), d(0));
  const prevTotalAll = rows.reduce((s, r) => s.plus(d(r.prevTotal)), d(0));
  const totalChangePct =
    prevTotalAll.isZero() || total.isZero()
      ? null
      : Number(
          total
            .minus(prevTotalAll)
            .div(prevTotalAll)
            .times(100)
            .toDecimalPlaces(1, Decimal.ROUND_HALF_UP),
        );

  return {
    by,
    period: { from: opts.from, to: opts.to },
    prevPeriod: prev,
    rows,
    totals: {
      invoicesCount: totalCount,
      total: f4(total),
      returnsTotal: f4(returnsTotal),
      prevTotal: f4(prevTotalAll),
      changePct: totalChangePct,
    },
  };
}

/* ==================== الأصناف تحت الحد الأدنى (FR-09-12) ==================== */

export interface BelowMinimumRow {
  productId: number;
  name: string;
  /** حد التنبيه min_stock (3dp) */
  minQty: string;
  /** الرصيد الحالي المجمّع عبر كل المخازن (3dp) */
  stockQty: string;
  /** النقص = الحد − الرصيد (3dp، موجب) */
  deficitQty: string;
  /** متوسط تكلفة الوحدة WAC بالأساس (4dp) — لتقدير كلفة سد النقص */
  avgCost: string;
}

export interface BelowMinimumReport {
  rows: BelowMinimumRow[];
  /** كلفة سد النقص تقديرياً بالأساس: Σ نقص × WAC (4dp) */
  replenishValue: string;
}

/**
 * الأصناف تحت الحد الأدنى (FR-09-12): غير خدمية، غير مؤرشفة (قائمة عمل
 * تشغيلية تطابق عدّاد الداشبورد)، min_stock > 0، ورصيدها المجمّع عبر كل
 * المخازن تحت الحد — مرتبة بالنقص الأكبر أولاً. «الراكد 90 يوماً» مؤجل V1.1
 * كما في الوثيقة. النقص يُسدّد بفاتورة شراء أو تسوية جرد (تلميح الشاشة).
 */
export async function getBelowMinimum(adapter: SqliteAdapter): Promise<BelowMinimumReport> {
  // فلترة الحد>0 في SQL (عتبة مقارنة لا جمع — نمط fetchAlerts)، والباقي Decimal
  const products = await adapter.all<{
    id: number;
    name: string;
    min_stock: string;
    cost_price: string;
  }>(
    `SELECT id, name, min_stock, cost_price FROM product
     WHERE is_service = 0 AND is_archived = 0 AND CAST(min_stock AS REAL) > 0`,
  );
  if (products.length === 0) return { rows: [], replenishValue: '0.0000' };

  const levels = await adapter.all<{ product_id: number; qty: string }>(
    `SELECT product_id, qty FROM stock_level
     WHERE product_id IN (${products.map(() => '?').join(',')})`,
    products.map((p) => Number(p.id)),
  );
  const stock = new Map<number, Decimal>();
  for (const r of levels) {
    const pid = Number(r.product_id);
    stock.set(pid, (stock.get(pid) ?? d(0)).plus(d(r.qty)));
  }

  const rows: BelowMinimumRow[] = [];
  let replenish = d(0);
  for (const p of products) {
    const pid = Number(p.id);
    const minQty = d(p.min_stock);
    const stockQty = stock.get(pid) ?? d(0);
    if (stockQty.gte(minQty)) continue;
    const deficit = minQty.minus(stockQty);
    replenish = replenish.plus(deficit.times(d(p.cost_price)));
    rows.push({
      productId: pid,
      name: p.name,
      minQty: f3(minQty),
      stockQty: f3(stockQty),
      deficitQty: f3(deficit),
      avgCost: f4(p.cost_price),
    });
  }
  rows.sort((a, b) => d(b.deficitQty).cmp(d(a.deficitQty)));

  return { rows, replenishValue: f4(replenish) };
}
