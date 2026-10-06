/**
 * stocktake.test.ts — الجرد وتسوية الفروقات (FR-01-08 / AC-04 — قرار 10).
 *
 * الجوهر المختبر:
 *  - **تكلفة اللقطة**: الحركة تُسجَّل بـ WAC لحظة الجرد (unit_cost) ولا تُعاد
 *    حسابها — العجز −3 @ 90 → total_diff −270 والزيادة +5 → +450.
 *  - **كل الأسطر تُسجَّل** (شاملاً المطابق diff=0) والحركة للفروقات فقط.
 *  - **الجرد يقفل الأرصدة**: stock_level = الكمية المعدودة حرفياً بعد الاعتماد.
 *  - الحرس: بلا أسطر / كمية سالبة / مخزن مفقود / صنف خدمي / تكرار صنف /
 *    سنة مالية مغلقة.
 *  - **الذرّية**: فشل منتصف الطريق (صنف غير موجود في سطر لاحق) لا يكتب
 *    شيئاً — لا جرد نصفي ولا رصيد ممسوس.
 */
import { describe, expect, test } from 'bun:test';
import type { SqliteAdapter } from '../../db/adapter';
import { d } from '../../utils/money';
import { recordOpeningStock } from '../inventory';
import { saveInvoice } from '../invoicing';
import { DomainRuleError, FiscalPeriodClosedError, ValidationError } from '../errors';
import { createStocktake, getStocktakeDetails, listStocktakes } from '../stocktake';
import { daysAgoISO, seededDb } from './seed';
import type { Seed } from './seed';

const TODAY = daysAgoISO(0);

/* ============================ مساعدات ============================ */

/** رصيد افتتاحي للحليب (100@90 افتراضياً — WAC يثبت على 90) */
async function openMilk(
  db: SqliteAdapter,
  seed: Seed,
  qty = '100',
  cost = '90',
): Promise<void> {
  await recordOpeningStock(db, {
    productId: seed.milkId,
    warehouseId: seed.warehouseId,
    qty: d(qty),
    unitCost: d(cost),
    movedAt: daysAgoISO(12),
  });
}

/** صنف ثانٍ مخزني («سكر») برصيد افتتاحي — لأسطر مختلطة */
async function addSugar(db: SqliteAdapter, seed: Seed, qty = '50', cost = '40'): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO product (name, cost_price, is_service, created_at, updated_at)
     VALUES ('سكر أبيض', ?, 0, ?, ?) RETURNING id`,
    [`${d(cost).toFixed(4)}`, now, now],
  );
  const id = Number(rows[0]!.id);
  await recordOpeningStock(db, {
    productId: id,
    warehouseId: seed.warehouseId,
    qty: d(qty),
    unitCost: d(cost),
    movedAt: daysAgoISO(10),
  });
  return id;
}

/** صنف ثالث («ماء») لسيناريو الإشارات المختلطة */
async function addWater(db: SqliteAdapter, seed: Seed, qty = '20', cost = '15'): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO product (name, cost_price, is_service, created_at, updated_at)
     VALUES ('ماء معدني', ?, 0, ?, ?) RETURNING id`,
    [`${d(cost).toFixed(4)}`, now, now],
  );
  const id = Number(rows[0]!.id);
  await recordOpeningStock(db, {
    productId: id,
    warehouseId: seed.warehouseId,
    qty: d(qty),
    unitCost: d(cost),
    movedAt: daysAgoISO(9),
  });
  return id;
}

function stInput(seed: Seed, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    warehouseId: seed.warehouseId,
    countedAt: TODAY,
    lines: [] as { productId: number; countedQty: string }[],
    ...overrides,
  };
}

async function stocktakeRows(db: SqliteAdapter) {
  return db.all<Record<string, string | number | null>>('SELECT * FROM stocktake');
}

async function stLines(db: SqliteAdapter, stocktakeId: number) {
  return db.all<Record<string, string | number | null>>(
    'SELECT * FROM stocktake_line WHERE stocktake_id = ? ORDER BY id',
    [stocktakeId],
  );
}

/** حركات تسوية الجرد لصنف (أو الكل عند غياب المعرف) */
async function adjustMovements(db: SqliteAdapter, productId?: number) {
  const sql = `SELECT * FROM stock_movement WHERE movement_type = 'stocktake_adjust' ${
    productId !== undefined ? 'AND product_id = ?' : ''
  } ORDER BY id`;
  return db.all<Record<string, string | number | null>>(sql, productId !== undefined ? [productId] : []);
}

async function stockLevel(db: SqliteAdapter, productId: number, warehouseId: number): Promise<string> {
  const rows = await db.all<{ qty: string }>(
    'SELECT qty FROM stock_level WHERE product_id = ? AND warehouse_id = ?',
    [productId, warehouseId],
  );
  return rows[0]?.qty ?? '0.000';
}

async function auditOf(db: SqliteAdapter, stocktakeId: number) {
  const rows = await db.all<{ action: string; details: string }>(
    'SELECT action, details FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id',
    ['stocktake', stocktakeId],
  );
  return rows;
}

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown = null;
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    caught = err;
  }
  expect(threw).toBe(true);
  expect(caught).toBeInstanceOf(DomainRuleError);
  expect((caught as DomainRuleError).code).toBe(code);
}

async function expectValidation(promise: Promise<unknown>, fragment: string): Promise<void> {
  let caught: unknown = null;
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    caught = err;
  }
  expect(threw).toBe(true);
  expect(caught).toBeInstanceOf(ValidationError);
  expect((caught as ValidationError).message).toContain(fragment);
}

/* ==================== تكلفة اللقطة (قرار 10 / AC-04) ==================== */

describe('createStocktake — تكلفة اللقطة والتسوية', () => {
  test('عجز 3 من كتاب 100@90 → حركة −3 بتكلفة 90 وtotal_diff −270 والرصيد يقفل على 97', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);

    const res = await createStocktake(db, stInput(seed, {
      lines: [{ productId: seed.milkId, countedQty: '97' }],
    }));

    expect(res.linesCount).toBe(1);
    expect(res.diffsCount).toBe(1);
    expect(res.totalDiff).toBe('-270.0000');
    expect(res.adjustments).toHaveLength(1);
    expect(res.adjustments[0]!.diffQty).toBe('-3.000');
    expect(res.adjustments[0]!.unitCost).toBe('90.0000');
    expect(res.adjustments[0]!.newLevel).toBe('97.000');

    // الترويسة والسطر بتكلفة اللقطة حرفياً
    const heads = await stocktakeRows(db);
    expect(heads).toHaveLength(1);
    expect(String(heads[0]!.total_diff)).toBe('-270.0000');
    const lines = await stLines(db, res.stocktakeId);
    expect(lines).toHaveLength(1);
    expect(String(lines[0]!.book_qty)).toBe('100.000');
    expect(String(lines[0]!.counted_qty)).toBe('97.000');
    expect(String(lines[0]!.diff_qty)).toBe('-3.000');
    expect(String(lines[0]!.unit_cost)).toBe('90.0000');

    // الحركة موقّعة بلاقطة التكلفة ومرتبطة بالجرد بتاريخ المستخدم
    const moves = await adjustMovements(db, seed.milkId);
    expect(moves).toHaveLength(1);
    expect(String(moves[0]!.qty)).toBe('-3.000');
    expect(String(moves[0]!.unit_cost)).toBe('90.0000');
    expect(String(moves[0]!.ref_type)).toBe('stocktake');
    expect(Number(moves[0]!.ref_id)).toBe(res.stocktakeId);
    expect(String(moves[0]!.moved_at)).toBe(TODAY);

    // الجرد يقفل الرصيد على المعدود
    expect(await stockLevel(db, seed.milkId, seed.warehouseId)).toBe('97.000');
  });

  test('زيادة 5 → حركة +5 بتكلفة 90 وtotal_diff +450', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);

    const res = await createStocktake(db, stInput(seed, {
      lines: [{ productId: seed.milkId, countedQty: '105' }],
    }));

    expect(res.totalDiff).toBe('450.0000');
    const moves = await adjustMovements(db, seed.milkId);
    expect(moves).toHaveLength(1);
    expect(String(moves[0]!.qty)).toBe('5.000');
    expect(String(moves[0]!.unit_cost)).toBe('90.0000');
    expect(await stockLevel(db, seed.milkId, seed.warehouseId)).toBe('105.000');
  });

  test('كميات عشرية: كتاب 10.5 ومعدود 9.25 → فرق −1.250', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed, '10.5', '90');

    const res = await createStocktake(db, stInput(seed, {
      lines: [{ productId: seed.milkId, countedQty: '9.25' }],
    }));

    expect(res.totalDiff).toBe('-112.5000');
    const lines = await stLines(db, res.stocktakeId);
    expect(String(lines[0]!.diff_qty)).toBe('-1.250');
    expect(await stockLevel(db, seed.milkId, seed.warehouseId)).toBe('9.250');
  });

  test('جرد بلا فروقات (مطابق تام) → أسطر بلا حركات وtotal_diff صفر', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);

    const res = await createStocktake(db, stInput(seed, {
      lines: [{ productId: seed.milkId, countedQty: '100' }],
    }));

    expect(res.diffsCount).toBe(0);
    expect(res.totalDiff).toBe('0.0000');
    expect(res.adjustments).toHaveLength(0);
    expect((await adjustMovements(db)).length).toBe(0);
    expect(await stockLevel(db, seed.milkId, seed.warehouseId)).toBe('100.000');
  });
});

/* ==================== أسطر مختلطة ==================== */

describe('createStocktake — أسطر مختلطة (مطابق + فروقات)', () => {
  test('الكل يُسجَّل سطراً والحركة للفرق فقط، والقيمة مجمّعة بالإشارات', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed); // 100 @ 90
    const sugarId = await addSugar(db, seed); // 50 @ 40
    const waterId = await addWater(db, seed); // 20 @ 15

    const res = await createStocktake(db, stInput(seed, {
      lines: [
        { productId: seed.milkId, countedQty: '100' }, // مطابق — سطر بلا حركة
        { productId: sugarId, countedQty: '48' }, // عجز −2 @ 40 = −80
        { productId: waterId, countedQty: '25' }, // زيادة +5 @ 15 = +75
      ],
    }));

    expect(res.linesCount).toBe(3);
    expect(res.diffsCount).toBe(2);
    // −80 + 75 = −5
    expect(res.totalDiff).toBe('-5.0000');

    const lines = await stLines(db, res.stocktakeId);
    expect(lines).toHaveLength(3); // المطابق سطر كامل لأثر التدقيق

    const moves = await adjustMovements(db);
    expect(moves).toHaveLength(2); // الحركة للفروقات فقط
    expect(await stockLevel(db, seed.milkId, seed.warehouseId)).toBe('100.000');
    expect(await stockLevel(db, sugarId, seed.warehouseId)).toBe('48.000');
    expect(await stockLevel(db, waterId, seed.warehouseId)).toBe('25.000');
  });

  test('مخزن آخر مستقل: جرد المخزن الثاني لا يمس أرصدة الأول', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const now = new Date().toISOString();
    const wh2 = await db.all<{ id: number }>(
      `INSERT INTO warehouse (name, is_default, created_at, updated_at)
       VALUES ('مخزن الفرع', 0, ?, ?) RETURNING id`,
      [now, now],
    );
    const wh2Id = Number(wh2[0]!.id);
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: wh2Id,
      qty: d('30'),
      unitCost: d('90'),
      movedAt: daysAgoISO(5),
    });

    const res = await createStocktake(db, stInput(seed, {
      warehouseId: wh2Id,
      lines: [{ productId: seed.milkId, countedQty: '28' }],
    }));

    expect(res.totalDiff).toBe('-180.0000');
    expect(await stockLevel(db, seed.milkId, wh2Id)).toBe('28.000');
    expect(await stockLevel(db, seed.milkId, seed.warehouseId)).toBe('100.000');
  });
});

/* ==================== الحرس (FR-01-08) ==================== */

describe('createStocktake — الحرس', () => {
  test('بلا أسطر → رفض «لا توجد أصناف»', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expectValidation(createStocktake(db, stInput(seed)), 'لا توجد أصناف');
  });

  test('كمية معدودة سالبة → رفض', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expectValidation(
      createStocktake(db, stInput(seed, {
        lines: [{ productId: seed.milkId, countedQty: '-5' }],
      })),
      'غير سالب',
    );
  });

  test('مخزن غير موجود → WAREHOUSE_NOT_FOUND', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expectDomainError(
      createStocktake(db, stInput(seed, {
        warehouseId: 9999,
        lines: [{ productId: seed.milkId, countedQty: '100' }],
      })),
      'WAREHOUSE_NOT_FOUND',
    );
  });

  test('صنف خدمي → SERVICE_NO_STOCK', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expectDomainError(
      createStocktake(db, stInput(seed, {
        lines: [
          { productId: seed.milkId, countedQty: '100' },
          { productId: seed.deliveryId, countedQty: '1' },
        ],
      })),
      'SERVICE_NO_STOCK',
    );
  });

  test('تكرار الصنف في الأسطر → رفض دمج الكميات', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expectValidation(
      createStocktake(db, stInput(seed, {
        lines: [
          { productId: seed.milkId, countedQty: '97' },
          { productId: seed.milkId, countedQty: '98' },
        ],
      })),
      'مكرر',
    );
  });

  test('تاريخ داخل سنة مغلقة → رفض قاطع (FiscalPeriodClosedError)', async () => {
    const { db, seed } = await seededDb();
    const year = Number(TODAY.slice(0, 4));
    await db.run(
      'INSERT INTO fiscal_year (year, start_date, end_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [year, `${year}-01-01`, `${year}-12-31`, 'closed', new Date().toISOString(), new Date().toISOString()],
    );
    await openMilk(db, seed);
    await expect(
      createStocktake(db, stInput(seed, {
        lines: [{ productId: seed.milkId, countedQty: '97' }],
      })),
    ).rejects.toBeInstanceOf(FiscalPeriodClosedError);
  });

  test('تاريخ غير صالح → رفض زود', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expectValidation(
      createStocktake(db, stInput(seed, {
        countedAt: '15-2026-01',
        lines: [{ productId: seed.milkId, countedQty: '97' }],
      })),
      'غير صالح',
    );
  });
});

/* ==================== الذرّية (5.4-4) ==================== */

describe('createStocktake — ذرّية المعاملة', () => {
  test('فشل منتصف الطريق (صنف غير موجود بعد سطر صالح) → لا يكتب شيئاً', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);

    await expectDomainError(
      createStocktake(db, stInput(seed, {
        lines: [
          { productId: seed.milkId, countedQty: '97' },
          { productId: 99999, countedQty: '3' },
        ],
      })),
      'PRODUCT_NOT_FOUND',
    );

    // لا جرد نصفي: لا ترويسة ولا أسطر
    expect((await stocktakeRows(db)).length).toBe(0);
    expect((await db.all('SELECT * FROM stocktake_line')).length).toBe(0);
    // الرصيد لم يُمس (الافتتاحي فقط)
    expect(await stockLevel(db, seed.milkId, seed.warehouseId)).toBe('100.000');
    // ولا حركة تسوية
    expect((await adjustMovements(db)).length).toBe(0);
  });
});

/* ==================== دورة كاملة (AC-04) ==================== */

describe('createStocktake — دورة كاملة: افتتاحي → بيع → جرد', () => {
  test('افتتاحي 100@90 → بيع 20 → جرد معدود 78 → فرق −2 والرصيد 78 وقيد تدقيق', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);

    const sale = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'cash',
      issuedAt: daysAgoISO(3),
      customerId: seed.customerId,
      cashboxId: seed.cashboxId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '20', unitPrice: '115' }],
    });
    void sale;
    expect(await stockLevel(db, seed.milkId, seed.warehouseId)).toBe('80.000');

    const res = await createStocktake(db, stInput(seed, {
      notes: 'جرد نهاية الشهر',
      lines: [{ productId: seed.milkId, countedQty: '78' }],
    }));

    expect(res.totalDiff).toBe('-180.0000');
    // الجرد يقفل الرصيد على المعدود حرفياً (AC-04)
    expect(await stockLevel(db, seed.milkId, seed.warehouseId)).toBe('78.000');

    // الحركة بلاقطة التكلفة (WAC لم يتغير بالبيع) ومرتبطة بالجرد
    const moves = await adjustMovements(db, seed.milkId);
    expect(moves).toHaveLength(1);
    expect(String(moves[0]!.qty)).toBe('-2.000');
    expect(String(moves[0]!.unit_cost)).toBe('90.0000');
    expect(Number(moves[0]!.ref_id)).toBe(res.stocktakeId);

    // قيد التدقيق بتفاصيل JSON كاملة
    const aud = await auditOf(db, res.stocktakeId);
    expect(aud).toHaveLength(1);
    expect(aud[0]!.action).toBe('stocktake');
    const details = JSON.parse(aud[0]!.details) as Record<string, unknown>;
    expect(details.warehouseId).toBe(seed.warehouseId);
    expect(details.countedAt).toBe(TODAY);
    expect(details.linesCount).toBe(1);
    expect(details.diffsCount).toBe(1);
    expect(details.totalDiff).toBe('-180.0000');
    expect(details.notes).toBe('جرد نهاية الشهر');
  });
});

/* ==================== السجل والتفاصيل ==================== */

describe('listStocktakes / getStocktakeDetails', () => {
  test('الأحدث أولاً بعدد الأسطر والفروقات + تفاصيل بالأسماء وقيم الأسطر', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed); // 100 @ 90
    const sugarId = await addSugar(db, seed); // 50 @ 40

    const older = await createStocktake(db, stInput(seed, {
      countedAt: daysAgoISO(5),
      lines: [{ productId: seed.milkId, countedQty: '98' }], // −2 @ 90 = −180
    }));
    // الجرد الأحدث بعد تسوية الأول: دفتري الحليب صار 98
    const newer = await createStocktake(db, stInput(seed, {
      countedAt: TODAY,
      lines: [
        { productId: seed.milkId, countedQty: '100' }, // +2 @ 90 = +180
        { productId: sugarId, countedQty: '52' }, // +2 @ 40 = +80
      ],
    }));

    const list = await listStocktakes(db);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(newer.stocktakeId); // الأحدث أولاً
    expect(list[0]!.countedAt).toBe(TODAY);
    expect(list[0]!.warehouseName).toBe('المخزن الرئيسي');
    expect(list[0]!.linesCount).toBe(2);
    expect(list[0]!.diffsCount).toBe(2);
    expect(list[0]!.totalDiff).toBe('260.0000');
    expect(list[1]!.id).toBe(older.stocktakeId);
    expect(list[1]!.linesCount).toBe(1);
    expect(list[1]!.diffsCount).toBe(1);

    // التفاصيل: أسماء الأصناف وقيمة كل سطر (diff × cost بالذاكرة)
    const details = await getStocktakeDetails(db, newer.stocktakeId);
    expect(details).not.toBeNull();
    expect(details!.lines).toHaveLength(2);
    const sugarLine = details!.lines.find((l) => l.productId === sugarId)!;
    expect(sugarLine.productName).toBe('سكر أبيض');
    expect(sugarLine.bookQty).toBe('50.000');
    expect(sugarLine.countedQty).toBe('52.000');
    expect(sugarLine.diffQty).toBe('2.000');
    expect(sugarLine.unitCost).toBe('40.0000');
    expect(sugarLine.lineValue).toBe('80.0000');
    const milkLine = details!.lines.find((l) => l.productId === seed.milkId)!;
    expect(milkLine.bookQty).toBe('98.000'); // دفتري ما بعد الجرد الأول
    expect(milkLine.lineValue).toBe('180.0000');
  });

  test('جرد غير موجود → null', async () => {
    const { db } = await seededDb();
    expect(await getStocktakeDetails(db, 777)).toBeNull();
  });

  test('قائمة فارغة عند بلا جرد', async () => {
    const { db } = await seededDb();
    expect(await listStocktakes(db)).toEqual([]);
  });
});
