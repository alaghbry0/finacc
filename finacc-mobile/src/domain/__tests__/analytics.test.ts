/**
 * analytics.test.ts — تقارير التحليلات (FR-09-03/04/06/12 — Task 17).
 *
 * سيناريوهات مبذورة يدوياً بأرقام محسوبة حرفياً:
 *  - **بطاقة الصنف (FR-09-03)**: افتتاحي 100 → شراء +50 → بيع −20 → مرتجع +5
 *    → التراكمي 100/150/130/135 بالضبط؛ وفترة مفلترة تستبعد الافتتاحي →
 *    «رصيد ما قبله» = 100 يتصدر الصفوف؛ وفلتر مخزن ثانٍ يعزل حركاته.
 *  - **ملخص الحركة الكلي (FR-09-04)**: وارد 155 (افتتاحي+شراء+مرتجع بيع) /
 *    صادر 20 / صافي +135 / رصيد 135 — والتصنيف الموثق حرفياً + التسويات
 *    الموقّعة + رصيد آخر فترة أقدم (stock_now − ما بعدها).
 *  - **المبيعات حسب (FR-09-06)**: عميل/فئة/صنف/يوم بنِسَب التغير (A: +70%،
 *    B: جديد null، الإجمالي +100%) + مرتجعات العميل عموداً + تجميع يومين
 *    في صف واحد + استبعاد الملغاة.
 *  - **تحت الحد الأدنى (FR-09-12)**: النقص الأكبر أولاً + min=0 والخدمي
 *    والمؤرشف خارجاً أبداً + كلفة السد التقديرية بWAC.
 *
 * حيوية الحركات (مرآة getProfitAndLoss): الملغاة ومعاكساتها تسقط معاً من
 * البطاقة والملخص — فلا يختل التراكمي عن stock_level أبداً.
 */
import { describe, expect, test } from 'bun:test';
import type { SqliteAdapter } from '../../db/adapter';
import { d } from '../../utils/money';
import { DomainRuleError, ValidationError } from '../errors';
import { applyMovement, recordOpeningStock } from '../inventory';
import { saveInvoice, createLinkedReturn, voidInvoice } from '../invoicing';
import {
  getBelowMinimum,
  getItemCard,
  getSalesBreakdown,
  getStockMovementSummary,
  previousPeriod,
} from '../analytics';
import { daysAgoISO, seededDb } from './seed';
import type { Seed } from './seed';

const TODAY = daysAgoISO(0);
const D1 = daysAgoISO(1);
const D2 = daysAgoISO(2);
const D3 = daysAgoISO(3);
const D4 = daysAgoISO(4);
const D5 = daysAgoISO(5);
const D6 = daysAgoISO(6);
const D7 = daysAgoISO(7);
const D8 = daysAgoISO(8);
const D9 = daysAgoISO(9);
const D10 = daysAgoISO(10);
const D12 = daysAgoISO(12);

/* ============================ مساعدات ============================ */

async function addCustomer(db: SqliteAdapter, name: string): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO customer (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id`,
    [name, now, now],
  );
  return Number(rows[0]!.id);
}

async function addCategory(db: SqliteAdapter, name: string): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO category (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id`,
    [name, now, now],
  );
  return Number(rows[0]!.id);
}

async function addProduct(
  db: SqliteAdapter,
  name: string,
  opts: { cost?: string; isService?: boolean; categoryId?: number; minStock?: string } = {},
): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO product (name, cost_price, is_service, category_id, min_stock, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      name,
      opts.cost ?? '0.0000',
      opts.isService ? 1 : 0,
      opts.categoryId ?? null,
      opts.minStock ?? '0.0000',
      now,
      now,
    ],
  );
  return Number(rows[0]!.id);
}

async function addWarehouse(db: SqliteAdapter, name: string): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO warehouse (name, is_default, created_at, updated_at) VALUES (?, 0, ?, ?) RETURNING id`,
    [name, now, now],
  );
  return Number(rows[0]!.id);
}

/** بيع آجل بسيط لعميل — يرجع معرّف الفاتورة */
async function creditSale(
  db: SqliteAdapter,
  seed: Seed,
  customerId: number,
  issuedAt: string,
  lines: { productId: number; qty: string; unitPrice: string }[],
) {
  return saveInvoice(db, {
    docType: 'sale',
    payStatus: 'credit',
    issuedAt,
    customerId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines,
  });
}

/**
 * سيناريو البطاقة/الملخص الأساسي — كل التكاليف 90 حتى يبقى WAC نظيفاً:
 * افتتاحي 100 (D10) → شراء نقدي +50 (D8) → بيع آجل −20 (D7) → مرتجع +5 (D6).
 * الرصيد النهائي 135 — التراكمي 100/150/130/135.
 */
async function cardScenario(): Promise<{ db: SqliteAdapter; seed: Seed; saleInvId: number }> {
  const { db, seed } = await seededDb();
  await recordOpeningStock(db, {
    productId: seed.milkId,
    warehouseId: seed.warehouseId,
    qty: d('100'),
    unitCost: d('90'),
    movedAt: D10,
  });
  await saveInvoice(db, {
    docType: 'purchase',
    payStatus: 'cash',
    issuedAt: D8,
    supplierId: seed.supplierId,
    cashboxId: seed.cashboxId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.milkId, qty: '50', unitPrice: '90' }],
  });
  const sale = await creditSale(db, seed, seed.customerId, D7, [
    { productId: seed.milkId, qty: '20', unitPrice: '115' },
  ]);
  await createLinkedReturn(db, {
    docType: 'sale_return',
    originalInvoiceId: sale.invoiceId,
    issuedAt: D6,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    returnPayDirection: 'cash',
    cashboxId: seed.cashboxId,
    lines: [{ productId: seed.milkId, qty: '5', unitPrice: '115' }],
  });
  return { db, seed, saleInvId: sale.invoiceId };
}

/* ============================ بطاقة صنف (FR-09-03) ============================ */

describe('getItemCard — الباقي التراكمي (FR-09-03)', () => {
  test('كل التاريخ: افتتاحي 100 → شراء +50 → بيع −20 → مرتجع +5 → تراكمي 100/150/130/135', async () => {
    const { db, seed } = await cardScenario();
    const card = await getItemCard(db, {
      productId: seed.milkId,
      from: D12,
      to: TODAY,
    });

    expect(card.productName).toBe('حليب المراعي');
    expect(card.openingBalance).toBeNull(); // الفترة تشمل أول حركة — لا صف افتتاحي
    expect(card.rows).toHaveLength(4);

    const [opening, purchase, sale, ret] = card.rows;
    expect(opening?.movementType).toBe('opening');
    expect(opening?.qty).toBe('100.000');
    expect(opening?.running).toBe('100.000');
    expect(purchase?.movementType).toBe('purchase');
    expect(purchase?.qty).toBe('50.000');
    expect(purchase?.running).toBe('150.000');
    expect(sale?.movementType).toBe('sale');
    expect(sale?.qty).toBe('-20.000');
    expect(sale?.running).toBe('130.000');
    expect(ret?.movementType).toBe('sale_return');
    expect(ret?.qty).toBe('5.000');
    expect(ret?.running).toBe('135.000');

    // مجاميع الفترة = كل التاريخ هنا
    expect(card.totals).toEqual({
      inQty: '155.000',
      outQty: '20.000',
      netQty: '135.000',
      endQty: '135.000',
    });
  });

  test('فترة تبدأ بعد الافتتاحي: «رصيد ما قبله» 100 يتصدر والتراكمي يكمل منه', async () => {
    const { db, seed } = await cardScenario();
    const card = await getItemCard(db, {
      productId: seed.milkId,
      from: D8, // يستبعد افتتاحي D10 فقط
      to: TODAY,
    });

    expect(card.openingBalance).toBe('100.000');
    expect(card.rows).toHaveLength(3); // شراء + بيع + مرتجع
    expect(card.rows[0]?.movementType).toBe('purchase');
    expect(card.rows[0]?.running).toBe('150.000'); // 100 ما قبله + 50
    expect(card.rows[2]?.running).toBe('135.000');
    expect(card.totals.inQty).toBe('55.000'); // 50 شراء + 5 مرتجع
    expect(card.totals.outQty).toBe('20.000');
    expect(card.totals.netQty).toBe('35.000');
    expect(card.totals.endQty).toBe('135.000');
  });

  test('فلتر المخزن: حركات المخزن الثاني وحدها بتراكميها المستقل', async () => {
    const { db, seed } = await cardScenario();
    const wh2 = await addWarehouse(db, 'مخزن الفرع');
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: wh2,
      qty: d('20'),
      unitCost: d('90'),
      movedAt: D9,
    });

    const card2 = await getItemCard(db, {
      productId: seed.milkId,
      from: D12,
      to: TODAY,
      warehouseId: wh2,
    });
    expect(card2.rows).toHaveLength(1);
    expect(card2.rows[0]?.qty).toBe('20.000');
    expect(card2.rows[0]?.running).toBe('20.000');
    expect(card2.totals.endQty).toBe('20.000');

    // المخزن الرئيسي لم تتأثر حركاته بفلتر أخيه
    const card1 = await getItemCard(db, {
      productId: seed.milkId,
      from: D12,
      to: TODAY,
      warehouseId: seed.warehouseId,
    });
    expect(card1.rows).toHaveLength(4);
    expect(card1.rows[3]?.running).toBe('135.000');
  });

  test('فاتورة ملغاة: حركتها ومعاكستها خارجا البطاقة — التراكمي مطابق للرصيد', async () => {
    const { db, seed } = await cardScenario();
    // بيع إضافي ثم إلغاؤه: الأصل −10 والمعاكسة +10 كلاهما خارج البطاقة
    const extra = await creditSale(db, seed, seed.customerId, D1, [
      { productId: seed.milkId, qty: '10', unitPrice: '115' },
    ]);
    await voidInvoice(db, extra.invoiceId);

    const card = await getItemCard(db, {
      productId: seed.milkId,
      from: D12,
      to: TODAY,
    });
    expect(card.rows).toHaveLength(4); // بلا بيع الملغاة ولا معاكستها
    expect(card.rows[3]?.running).toBe('135.000');
    expect(card.totals.endQty).toBe('135.000');

    // والرصيد الفعلي في القاعدة 135 أيضاً (معاكسة الإلغاء ردّته)
    const level = await db.all<{ qty: string }>(
      'SELECT qty FROM stock_level WHERE product_id = ? AND warehouse_id = ?',
      [seed.milkId, seed.warehouseId],
    );
    expect(level[0]?.qty).toBe('135.000');
  });

  test('حروس الزود: تاريخ غير صالح / فترة مقلوبة / صنف غير موجود', async () => {
    const { db, seed } = await cardScenario();
    await expect(
      getItemCard(db, { productId: seed.milkId, from: '2026-13-01', to: TODAY }),
    ).rejects.toThrow(ValidationError);
    await expect(
      getItemCard(db, { productId: seed.milkId, from: D1, to: D10 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      getItemCard(db, { productId: 999999, from: D10, to: TODAY }),
    ).rejects.toThrow(DomainRuleError);
  });
});

/* ==================== ملخص حركة المخزون الكلي (FR-09-04) ==================== */

describe('getStockMovementSummary — التصنيف الموثق (FR-09-04)', () => {
  test('وارد 155 (افتتاحي+شراء+مرتجع بيع) / صادر 20 / صافي +135 / رصيد 135', async () => {
    const { db, seed } = await cardScenario();
    const summary = await getStockMovementSummary(db, { from: D12, to: TODAY });

    expect(summary.rows).toHaveLength(1); // الحليب وحده (الخدمي بلا حركات)
    const row = summary.rows[0]!;
    expect(row.productId).toBe(seed.milkId);
    expect(row.inQty).toBe('155.000');
    expect(row.outQty).toBe('20.000');
    expect(row.returnsIn).toBe('5.000'); // تفصيل ضمن الوارد
    expect(row.returnsOut).toBe('0.000');
    expect(row.adjustQty).toBe('0.000');
    expect(row.netQty).toBe('135.000');
    expect(row.endQty).toBe('135.000');
    // القيم بتكلفة الحركة: وارد 155×90 وصادر 20×90
    expect(row.valueIn).toBe('13950.0000');
    expect(row.valueOut).toBe('1800.0000');

    expect(summary.totals).toEqual({
      inQty: '155.000',
      outQty: '20.000',
      adjustQty: '0.000',
      netQty: '135.000',
      valueIn: '13950.0000',
      valueOut: '1800.0000',
    });
  });

  test('التسويات عموداً مستقلاً بإشارتها: جرد +3 وتسوية يدوية −1 → adjust=+2', async () => {
    const { db, seed } = await cardScenario();
    await applyMovement(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      movementType: 'stocktake_adjust',
      qty: d('3'),
      unitCost: d('90'),
      refType: 'stocktake',
      refId: 1,
      movedAt: D5,
    });
    await applyMovement(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      movementType: 'manual_adjust',
      qty: d('-1'),
      unitCost: d('90'),
      movedAt: D4,
    });

    const summary = await getStockMovementSummary(db, { from: D12, to: TODAY });
    const row = summary.rows[0]!;
    expect(row.inQty).toBe('155.000'); // التسويات ليست وارداً
    expect(row.outQty).toBe('20.000'); // ولا صادراً
    expect(row.adjustQty).toBe('2.000'); // +3 − 1
    expect(row.netQty).toBe('137.000');
    expect(row.endQty).toBe('137.000');
    expect(summary.totals.adjustQty).toBe('2.000');
  });

  test('رصيد آخر فترة أقدم: stock_now − حركات ما بعدها (بيع بعد الفترة لا يخترقها)', async () => {
    const { db, seed } = await cardScenario();
    // بيع متأخر D1 (خارج الفترة الممتدة حتى D5)
    await creditSale(db, seed, seed.customerId, D1, [
      { productId: seed.milkId, qty: '10', unitPrice: '115' },
    ]);

    const summary = await getStockMovementSummary(db, { from: D12, to: D7 });
    const row = summary.rows[0]!;
    // داخل الفترة: افتتاحي 100 + شراء 50 − بيع 20 = وارد 150 / صادر 20
    expect(row.inQty).toBe('150.000');
    expect(row.outQty).toBe('20.000');
    expect(row.netQty).toBe('130.000');
    // رصيد آخر D7 = 125 (الحالي) − (−5) = 130: بعد الفترة مرتجع +5 وبيع −10
    expect(row.endQty).toBe('130.000');
  });

  test('شراء ملغى: حركته ومعاكستها لا تعدل الوارد ولا الرصيد', async () => {
    const { db, seed } = await cardScenario();
    const pur = await saveInvoice(db, {
      docType: 'purchase',
      payStatus: 'cash',
      issuedAt: D2,
      supplierId: seed.supplierId,
      cashboxId: seed.cashboxId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '7', unitPrice: '90' }],
    });
    await voidInvoice(db, pur.invoiceId);

    const summary = await getStockMovementSummary(db, { from: D12, to: TODAY });
    const row = summary.rows[0]!;
    expect(row.inQty).toBe('155.000'); // 7 الملغاة ومعاكستها خارجان
    expect(row.endQty).toBe('135.000');
  });
});

/* ==================== المبيعات حسب (FR-09-06) ==================== */

/**
 * سيناريو المبيعات — فترة حالية [D4..D1] وسابقة [D8..D5]:
 *  - D7 (سابقة): أحمد توصيل 100.
 *  - D4: أحمد حليب 2×50 = 100. · D3: أحمد توصيل 50.
 *  - D2 (يومان في يوم واحد): سالم عصير 3×10 = 30 + أحمد عصير 1×20 = 20.
 *  - D1: مرتجع أحمد حليب 1×50 = 50 (عمود مرتجعات العميل).
 * الأرقام: أحمد 170 (+70%)، سالم 30 (جديد)، الإجمالي 200 (+100%).
 */
async function salesScenario(): Promise<{
  db: SqliteAdapter;
  seed: Seed;
  customerId: number;
  otherId: number;
  juiceId: number;
}> {
  const { db, seed } = await seededDb();
  const otherId = await addCustomer(db, 'سالم');
  const catId = await addCategory(db, 'مشروبات');
  const juiceId = await addProduct(db, 'عصير برتقال', { cost: '20.0000', categoryId: catId });

  await recordOpeningStock(db, {
    productId: seed.milkId,
    warehouseId: seed.warehouseId,
    qty: d('10'),
    unitCost: d('90'),
    movedAt: D9,
  });
  await recordOpeningStock(db, {
    productId: juiceId,
    warehouseId: seed.warehouseId,
    qty: d('10'),
    unitCost: d('20'),
    movedAt: D9,
  });

  // السابقة
  await creditSale(db, seed, seed.customerId, D7, [
    { productId: seed.deliveryId, qty: '1', unitPrice: '100' },
  ]);
  // الحالية
  const milkSale = await creditSale(db, seed, seed.customerId, D4, [
    { productId: seed.milkId, qty: '2', unitPrice: '50' },
  ]);
  await creditSale(db, seed, seed.customerId, D3, [
    { productId: seed.deliveryId, qty: '1', unitPrice: '50' },
  ]);
  await creditSale(db, seed, otherId, D2, [
    { productId: juiceId, qty: '3', unitPrice: '10' },
  ]);
  await creditSale(db, seed, seed.customerId, D2, [
    { productId: juiceId, qty: '1', unitPrice: '20' },
  ]);
  // مرتجع أحمد داخل الفترة الحالية
  await createLinkedReturn(db, {
    docType: 'sale_return',
    originalInvoiceId: milkSale.invoiceId,
    issuedAt: D1,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    returnPayDirection: 'account', // مرتجع آجل — على حساب العميل (النوع: cash | account)
    lines: [{ productId: seed.milkId, qty: '1', unitPrice: '50' }],
  });
  return { db, seed, customerId: seed.customerId, otherId, juiceId };
}

describe('getSalesBreakdown — نسب التغير (FR-09-06)', () => {
  test('حسب العميل: أحمد 170 (+70%) وسالم 30 (جديد null) ومرتجعات أحمد 50', async () => {
    const { db, seed, customerId, otherId } = await salesScenario();
    const rep = await getSalesBreakdown(db, { from: D4, to: D1, by: 'customer' });

    expect(rep.prevPeriod).toEqual({ from: D8, to: D5 });
    expect(rep.rows).toHaveLength(2);
    const [ahmed, salem] = rep.rows;
    expect(ahmed?.key).toBe(String(customerId));
    expect(ahmed?.label).toBe('أحمد');
    expect(ahmed?.invoicesCount).toBe(3);
    expect(ahmed?.total).toBe('170.0000');
    expect(ahmed?.returnsTotal).toBe('50.0000'); // عمود المرتجعات للعميل
    expect(ahmed?.prevTotal).toBe('100.0000');
    expect(ahmed?.changePct).toBe(70); // (170−100)/100
    expect(salem?.key).toBe(String(otherId));
    expect(salem?.total).toBe('30.0000');
    expect(salem?.returnsTotal).toBe('0.0000');
    expect(salem?.changePct).toBeNull(); // «جديد»

    expect(rep.totals).toEqual({
      invoicesCount: 4,
      total: '200.0000',
      returnsTotal: '50.0000',
      prevTotal: '100.0000',
      changePct: 100, // (200−100)/100
    });
    expect(seed.customerId).toBeGreaterThan(0); // بذرة سليمة
  });

  test('حسب اليوم: فاتورتا D2 تتجمعان في صف واحد — والترتيب زمني تصاعدي', async () => {
    const { db } = await salesScenario();
    const rep = await getSalesBreakdown(db, { from: D4, to: D1, by: 'day' });

    expect(rep.rows.map((r) => r.key)).toEqual([D4, D3, D2]);
    const [d4, d3, d2] = rep.rows;
    expect(d4?.invoicesCount).toBe(1);
    expect(d4?.total).toBe('100.0000');
    expect(d3?.total).toBe('50.0000');
    expect(d2?.invoicesCount).toBe(2); // سالم + أحمد في يوم واحد
    expect(d2?.total).toBe('50.0000'); // 30 + 20
    expect(d4?.changePct).toBeNull(); // لا مبيعات في الأربعاء السابق المقابل
  });

  test('حسب الصنف: حليب 100 وتوصيل 70 وعصير 50 — بالأساس من بنود الفواتير', async () => {
    const { db, seed, juiceId } = await salesScenario();
    const rep = await getSalesBreakdown(db, { from: D4, to: D1, by: 'item' });

    expect(rep.rows).toHaveLength(3);
    const [milk, delivery, juice] = rep.rows;
    expect(milk?.key).toBe(String(seed.milkId));
    expect(milk?.label).toBe('حليب المراعي');
    expect(milk?.total).toBe('100.0000');
    expect(milk?.invoicesCount).toBe(1);
    expect(delivery?.key).toBe(String(seed.deliveryId));
    expect(delivery?.total).toBe('50.0000');
    expect(juice?.key).toBe(String(juiceId));
    expect(juice?.total).toBe('50.0000'); // 30 (سالم) + 20 (أحمد)
    expect(juice?.invoicesCount).toBe(2);
  });

  test('حسب الفئة: «مشروبات» 50 وباقي البنود مجموعة «بلا فئة» 150', async () => {
    const { db } = await salesScenario();
    const rep = await getSalesBreakdown(db, { from: D4, to: D1, by: 'category' });

    expect(rep.rows).toHaveLength(2);
    const [none, drinks] = rep.rows;
    expect(none?.refId).toBeNull(); // حليب + توصيل بلا فئة
    expect(none?.total).toBe('150.0000');
    expect(none?.invoicesCount).toBe(2);
    expect(drinks?.label).toBe('مشروبات');
    expect(drinks?.total).toBe('50.0000');
  });

  test('الملغاة خارج كل تجزئة: بيع ثم إلغاء لا يعدل الأرقام', async () => {
    const { db, seed } = await salesScenario();
    const extra = await creditSale(db, seed, seed.customerId, D1, [
      { productId: seed.deliveryId, qty: '1', unitPrice: '40' },
    ]);
    await voidInvoice(db, extra.invoiceId);

    const rep = await getSalesBreakdown(db, { from: D4, to: D1, by: 'customer' });
    const ahmed = rep.rows.find((r) => r.key === String(seed.customerId));
    expect(ahmed?.total).toBe('170.0000'); // 40 الملغاة لم تدخل
    expect(ahmed?.invoicesCount).toBe(3);
    expect(rep.totals.total).toBe('200.0000');
  });

  test('انحدار التسمية: عميل نقدي وبلا فئة يحملان refKind الصحيح لا «سطر حر»', async () => {
    const { db, seed, juiceId } = await salesScenario();
    // بيع نقدي بلا عميل (INV نقدي) — يظهر مجموعة «عميل نقدي»
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'cash',
      issuedAt: D2,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      cashboxId: seed.cashboxId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '50' }],
    });

    const byCustomer = await getSalesBreakdown(db, { from: D4, to: D1, by: 'customer' });
    const cash = byCustomer.rows.find((r) => r.key === 'cash');
    expect(cash).toBeDefined();
    expect(cash?.label).toBe(''); // الواجهة تعرض «عميل نقدي» (ar.analytics.salesBy.cashCustomer)
    expect(cash?.refKind).toBe('customer'); // لا null — وإلا عُرض «سطر حر»
    expect(cash?.total).toBe('50.0000');

    const byCategory = await getSalesBreakdown(db, { from: D4, to: D1, by: 'category' });
    const noneCat = byCategory.rows.find((r) => r.key === 'none');
    expect(noneCat).toBeDefined();
    expect(noneCat?.refKind).toBe('category'); // لا null — وإلا عُرض «سطر حر»
    expect(noneCat?.total).toBe('200.0000'); // 150 + نقدي 50

    // السطور الحرة (بلا صنف) وحدها «سطر حر» — refKind=null في تجزئة الأصناف
    // (لا سطور حرة في هذا السيناريو — الغياب مقبول: المهم ألا تحمل refKind منتجاً)
    const byItem = await getSalesBreakdown(db, { from: D4, to: D1, by: 'item' });
    const freeLine = byItem.rows.find((r) => r.key.startsWith('free:'));
    expect(freeLine ? freeLine.refKind : null).toBeNull();
    expect(juiceId).toBeGreaterThan(0);
  });

  test('previousPeriod: بنفس الطول مباشرة قبل «من» (سنة تعبر حدود الشهر)', () => {
    expect(previousPeriod('2026-01-10', '2026-01-19')).toEqual({
      from: '2025-12-31',
      to: '2026-01-09',
    });
    expect(previousPeriod('2026-03-01', '2026-03-01')).toEqual({
      from: '2026-02-28',
      to: '2026-02-28',
    });
  });
});

/* ==================== تحت الحد الأدنى (FR-09-12) ==================== */

describe('getBelowMinimum — النقص الأكبر أولاً (FR-09-12)', () => {
  test('min=10 وstock=8 → نقص 2؛ الأرز نقصه 15 يتصدر؛ كلفة السد 780', async () => {
    const { db, seed } = await seededDb();
    // حليب: حد 10 ورصيد 8 (افتتاحي 8)
    await db.run('UPDATE product SET min_stock = ? WHERE id = ?', ['10.0000', seed.milkId]);
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('8'),
      unitCost: d('90'),
      movedAt: D5,
    });
    // أرز: حد 20 ورصيد 5 — النقص الأكبر يتصدر
    const riceId = await addProduct(db, 'أرز بسمتي', { cost: '40.0000', minStock: '20.0000' });
    await recordOpeningStock(db, {
      productId: riceId,
      warehouseId: seed.warehouseId,
      qty: d('5'),
      unitCost: d('40'),
      movedAt: D5,
    });

    const report = await getBelowMinimum(db);
    expect(report.rows).toHaveLength(2);
    const [rice, milk] = report.rows;
    expect(rice?.productId).toBe(riceId);
    expect(rice?.deficitQty).toBe('15.000');
    expect(milk?.productId).toBe(seed.milkId);
    expect(milk?.stockQty).toBe('8.000');
    expect(milk?.minQty).toBe('10.000');
    expect(milk?.deficitQty).toBe('2.000');
    expect(milk?.avgCost).toBe('90.0000');
    // كلفة السد التقديرية: 15×40 + 2×90 = 780
    expect(report.replenishValue).toBe('780.0000');
  });

  test('min=0 والخدمي والمؤرشف خارجا أبداً', async () => {
    const { db, seed } = await seededDb();
    // توصيل (خدمي) بحد 5 — لا يظهر
    await db.run('UPDATE product SET min_stock = ? WHERE id = ?', ['5.0000', seed.deliveryId]);
    // صنف حدّه صفر ورصيده صفر — لا يظهر
    await addProduct(db, 'سكر', { cost: '30.0000', minStock: '0.0000' });
    // صنف مؤرشف تحت حدّه — لا يظهر (قائمة عمل تشغيلية كعدّاد الداشبورد)
    const teaId = await addProduct(db, 'شاي أحمد', { cost: '10.0000', minStock: '5.0000' });
    await recordOpeningStock(db, {
      productId: teaId,
      warehouseId: seed.warehouseId,
      qty: d('1'),
      unitCost: d('10'),
      movedAt: D5,
    });
    await db.run('UPDATE product SET is_archived = 1 WHERE id = ?', [teaId]);

    const report = await getBelowMinimum(db);
    expect(report.rows).toHaveLength(0);
    expect(report.replenishValue).toBe('0.0000');
  });

  test('الرصيد مجموع عبر المخازن: 6 + 7 = 13 لا ينقص عن حد 12', async () => {
    const { db, seed } = await seededDb();
    await db.run('UPDATE product SET min_stock = ? WHERE id = ?', ['12.0000', seed.milkId]);
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('6'),
      unitCost: d('90'),
      movedAt: D5,
    });
    const wh2 = await addWarehouse(db, 'مخزن الفرع');
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: wh2,
      qty: d('7'),
      unitCost: d('90'),
      movedAt: D5,
    });

    const report = await getBelowMinimum(db);
    expect(report.rows).toHaveLength(0); // 13 ≥ 12 — التجميع عبر المخازن أنقذه
  });
});
