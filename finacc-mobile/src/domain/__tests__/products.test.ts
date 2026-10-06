/**
 * products.test.ts — نطاق الأصناف: الباركود المحجوز + الافتتاحي/WAC + الخدمي +
 * الحذف/الأرشفة + Upsert الأسعار + التكلفة بعد الحركات (FR-01-01/02/15/16).
 */
import { describe, expect, test } from 'bun:test';
import { d } from '../../utils/money';
import { isValidEan13 } from '../../utils/ean13';
import {
  archiveProduct,
  createProduct,
  deleteProduct,
  getProduct,
  getStockTotal,
  listProducts,
  updateProduct,
} from '../products';
import { DomainRuleError, ValidationError } from '../errors';
import { applyMovement } from '../inventory';
import { seededDb, daysAgoISO } from './seed';

const BASE_PRICE = { currencyId: 1, price: '115' };

describe('createProduct — الباركود', () => {
  test('الفراغ يولّد EAN-13 داخلياً: 13 رقماً يبدأ «200» + خانة تحقق + فريد', async () => {
    const { db } = await seededDb();
    const a = await createProduct(db, { name: 'صنف أ', prices: [BASE_PRICE] });
    const b = await createProduct(db, { name: 'صنف ب', prices: [BASE_PRICE] });
    expect(isValidEan13(a.barcode)).toBe(true);
    expect(a.barcode.startsWith('200')).toBe(true);
    expect(b.barcode).not.toBe(a.barcode);
    expect(isValidEan13(b.barcode)).toBe(true);
  });

  test('باركود مُدخل يُخزَّن كما هو', async () => {
    const { db } = await seededDb();
    const p = await createProduct(db, {
      name: 'صنف بباركود',
      barcode: '5901234123457',
      prices: [BASE_PRICE],
    });
    expect(p.barcode).toBe('5901234123457');
  });

  test('التكرار يُرفض — وضمن ذلك ضد صنف مؤرشف (الباركود محجوز — FR-01-01)', async () => {
    const { db } = await seededDb();
    const a = await createProduct(db, {
      name: 'الأول',
      barcode: '5901234123457',
      prices: [BASE_PRICE],
    });
    await archiveProduct(db, a.id);
    let err: unknown;
    try {
      await createProduct(db, { name: 'الثاني', barcode: '5901234123457', prices: [BASE_PRICE] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainRuleError);
    expect((err as DomainRuleError).code).toBe('BARCODE_TAKEN');
    expect((err as DomainRuleError).message).toContain('هذا الباركود مستخدم لصنف آخر');
  });

  test('باركود ليس 13 رقماً → ValidationError عربية', async () => {
    const { db } = await seededDb();
    let err: unknown;
    try {
      await createProduct(db, { name: 'x', barcode: '12345', prices: [BASE_PRICE] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues[0]!.message).toContain('13 رقماً');
  });
});

describe('createProduct — الرصيد الافتتاحي والخدمي', () => {
  test('openingQty → حركة opening + رصيد + WAC = التكلفة المدخلة', async () => {
    const { db, seed } = await seededDb();
    const p = await createProduct(db, {
      name: 'سكر',
      costPrice: '90',
      openingQty: '10',
      openingWarehouseId: seed.warehouseId,
      prices: [BASE_PRICE],
    });
    const moves = await db.all<{ movement_type: string; qty: string; unit_cost: string }>(
      'SELECT movement_type, qty, unit_cost FROM stock_movement WHERE product_id = ?',
      [p.id],
    );
    expect(moves.length).toBe(1);
    expect(moves[0]!.movement_type).toBe('opening');
    expect(moves[0]!.qty).toBe('10.000');
    expect(moves[0]!.unit_cost).toBe('90.0000');
    const level = await db.all<{ qty: string }>('SELECT qty FROM stock_level WHERE product_id = ?', [
      p.id,
    ]);
    expect(level[0]!.qty).toBe('10.000');
    const full = await getProduct(db, p.id);
    expect(full!.costPrice).toBe('90.0000');
    expect(full!.stockTotal).toBe('10.000');
  });

  test('الصنف الخدمي بلا حركات ولا رصيد مهما أدخلت', async () => {
    const { db } = await seededDb();
    const p = await createProduct(db, {
      name: 'توصيل',
      isService: true,
      prices: [BASE_PRICE],
    });
    const moves = await db.all('SELECT id FROM stock_movement WHERE product_id = ?', [p.id]);
    const level = await db.all('SELECT id FROM stock_level WHERE product_id = ?', [p.id]);
    expect(moves.length).toBe(0);
    expect(level.length).toBe(0);
    expect((await getProduct(db, p.id))!.stockTotal).toBe('0.000');
  });

  test('خدمي + كمية افتتاحية → رفض (FR-01-16)؛ كمية بلا مخزن → رفض', async () => {
    const { db } = await seededDb();
    let e1: unknown;
    try {
      await createProduct(db, {
        name: 'خدمة بكمية',
        isService: true,
        openingQty: '5',
        prices: [BASE_PRICE],
      });
    } catch (e) {
      e1 = e;
    }
    expect(e1).toBeInstanceOf(ValidationError);
    let e2: unknown;
    try {
      await createProduct(db, { name: 'بلا مخزن', openingQty: '5', prices: [BASE_PRICE] });
    } catch (e) {
      e2 = e;
    }
    expect(e2).toBeInstanceOf(ValidationError);
    expect((e2 as ValidationError).issues.some((i) => i.path.includes('openingWarehouseId'))).toBe(
      true,
    );
  });

  test('الأسعار بلا عملة أساسية → رفض عربي', async () => {
    const { db, seed } = await seededDb();
    let err: unknown;
    try {
      await createProduct(db, {
        name: 'بسعر أجنبي فقط',
        prices: [{ currencyId: seed.sarId, price: '10' }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainRuleError);
    expect((err as DomainRuleError).code).toBe('PRICE_BASE_REQUIRED');
  });
});

describe('updateProduct — التكلفة والأسعار', () => {
  test('تعديل التكلفة مقبول قبل أول حركة — ومرفوض بعدها (WAC يحكمها)', async () => {
    const { db, seed } = await seededDb();
    const p = await createProduct(db, {
      name: 'شاي',
      costPrice: '50',
      prices: [BASE_PRICE],
    });
    await updateProduct(db, p.id, { name: 'شاي', costPrice: '55', prices: [BASE_PRICE] });
    expect((await getProduct(db, p.id))!.costPrice).toBe('55.0000');

    // حركة واحدة → القفل
    await applyMovement(db, {
      productId: p.id,
      warehouseId: seed.warehouseId,
      movementType: 'opening',
      qty: d('4'),
      unitCost: d('55'),
      refType: 'opening',
      movedAt: daysAgoISO(1),
    });
    let err: unknown;
    try {
      await updateProduct(db, p.id, { name: 'شاي', costPrice: '60', prices: [BASE_PRICE] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainRuleError);
    expect((err as DomainRuleError).code).toBe('COST_WAC_LOCKED');
    expect((err as DomainRuleError).message).toContain('المتوسط المرجّح');
  });

  test('Upsert الأسعار: تعديلان متتاليان → صف واحد للعملة بقيمة الأخيرة', async () => {
    const { db } = await seededDb();
    const p = await createProduct(db, { name: 'أرز', prices: [{ currencyId: 1, price: '100' }] });
    await updateProduct(db, p.id, { name: 'أرز', prices: [{ currencyId: 1, price: '120' }] });
    await updateProduct(db, p.id, { name: 'أرز', prices: [{ currencyId: 1, price: '125' }] });
    const rows = await db.all<{ price: string; price_level: string }>(
      'SELECT price, price_level FROM product_price WHERE product_id = ?',
      [p.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.price).toBe('125.0000');
    expect(rows[0]!.price_level).toBe('retail');
  });

  test('الحقول غير المرسلة تبقى كما هي (patch) — والكمية الافتتاحية تُرفض في التعديل', async () => {
    const { db, seed } = await seededDb();
    const p = await createProduct(db, {
      name: 'ملح',
      costPrice: '10',
      minStock: '3',
      notes: 'ملاحظة أصلية',
      prices: [BASE_PRICE],
    });
    await updateProduct(db, p.id, { name: 'ملح مطحون', prices: [BASE_PRICE] });
    const full = await getProduct(db, p.id);
    expect(full!.name).toBe('ملح مطحون');
    expect(full!.minStock).toBe('3.000');
    expect(full!.notes).toBe('ملاحظة أصلية');
    expect(full!.costPrice).toBe('10.0000');

    let err: unknown;
    try {
      await updateProduct(db, p.id, {
        name: 'ملح',
        openingQty: '9',
        openingWarehouseId: seed.warehouseId,
        prices: [BASE_PRICE],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainRuleError);
    expect((err as DomainRuleError).code).toBe('OPENING_QTY_IMMUTABLE');
  });

  test('تحويل صنف له حركات إلى خدمي ممنوع', async () => {
    const { db, seed } = await seededDb();
    const p = await createProduct(db, {
      name: 'زيت',
      openingQty: '2',
      openingWarehouseId: seed.warehouseId,
      prices: [BASE_PRICE],
    });
    let err: unknown;
    try {
      await updateProduct(db, p.id, { name: 'زيت', isService: true, prices: [BASE_PRICE] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainRuleError);
    expect((err as DomainRuleError).code).toBe('SERVICE_FLIP_BLOCKED');
  });
});

describe('الأرشفة والحذف (FR-01-15)', () => {
  test('الحذف ممنوع مع حركات/إشارات — رسالة «أرشفه بدلاً من ذلك»', async () => {
    const { db, seed } = await seededDb();
    const p = await createProduct(db, {
      name: 'قماش',
      openingQty: '1',
      openingWarehouseId: seed.warehouseId,
      prices: [BASE_PRICE],
    });
    let err: unknown;
    try {
      await deleteProduct(db, p.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainRuleError);
    expect((err as DomainRuleError).code).toBe('PRODUCT_HAS_MOVEMENTS');
    expect((err as DomainRuleError).message).toContain('أرشفه بدلاً من ذلك');

    // نظيف تماماً → الحذف يمر ويزيل أسعاره
    const q = await createProduct(db, { name: 'صنف نظيف', prices: [BASE_PRICE] });
    await deleteProduct(db, q.id);
    expect(await getProduct(db, q.id)).toBeNull();
    const prices = await db.all('SELECT id FROM product_price WHERE product_id = ?', [q.id]);
    expect(prices.length).toBe(0);
  });

  test('الأرشفة تُكرَّر بالرفض؛ المؤرشف يختفي من القائمة النشطة ويبقى بـ onlyActive=false', async () => {
    const { db } = await seededDb();
    const p = await createProduct(db, { name: 'صنف للأرشفة', prices: [BASE_PRICE] });
    await archiveProduct(db, p.id);
    let err: unknown;
    try {
      await archiveProduct(db, p.id);
    } catch (e) {
      err = e;
    }
    expect((err as DomainRuleError).code).toBe('ALREADY_ARCHIVED');

    const active = await listProducts(db, { search: 'للأرشفة' });
    expect(active.length).toBe(0);
    const all = await listProducts(db, { search: 'للأرشفة', onlyActive: false });
    expect(all.length).toBe(1);
    expect(all[0]!.isArchived).toBe(true);
  });
});

describe('listProducts/getStockTotal — القراءة', () => {
  test('البحث بالاسم والباركود يعمل (LIKE)، والمجموع عبر المخازن', async () => {
    const { db, seed } = await seededDb();
    const a = await createProduct(db, { name: 'حليب المراعي كبير', prices: [BASE_PRICE] });
    await createProduct(db, {
      name: 'حليب نادك',
      barcode: '2000000000015',
      prices: [BASE_PRICE],
    });
    const byName = await listProducts(db, { search: 'حليب' });
    expect(byName.length).toBeGreaterThanOrEqual(2);
    const byBarcode = await listProducts(db, { search: '2000000000015' });
    expect(byBarcode.length).toBe(1);
    expect(byBarcode[0]!.name).toBe('حليب نادك');

    // مجموع الرصيد عبر مخزنين
    await applyMovement(db, {
      productId: a.id,
      warehouseId: seed.warehouseId,
      movementType: 'opening',
      qty: d('7'),
      unitCost: d('1'),
      refType: 'opening',
      movedAt: daysAgoISO(3),
    });
    const w2 = await db.all<{ id: number }>(
      "INSERT INTO warehouse (name, created_at, updated_at) VALUES ('مخزن ثانٍ', ?, ?) RETURNING id",
      [new Date().toISOString(), new Date().toISOString()],
    );
    await applyMovement(db, {
      productId: a.id,
      warehouseId: Number(w2[0]!.id),
      movementType: 'opening',
      qty: d('3'),
      unitCost: d('1'),
      refType: 'opening',
      movedAt: daysAgoISO(3),
    });
    expect(await getStockTotal(db, a.id)).toBe('10.000');
  });
});
