/**
 * inventory.test.ts — محرك حركات المخزون (SRS §10.2: منع السالب + الحركات الموقّعة + WAC).
 */
import { describe, expect, test } from 'bun:test';
import { d } from '../../utils/money';
import {
  applyMovement,
  getStockLevel,
  recordOpeningStock,
  updateProductCost,
} from '../inventory';
import { DomainRuleError, NegativeStockError } from '../errors';
import { daysAgoISO, seededDb } from './seed';

describe('applyMovement — الحارس المخزوني (قرار 9)', () => {
  test('حركة صادر تُنقص الرصيد وتسجّل صفاً موقّعاً (3dp)', async () => {
    const { db, seed } = await seededDb();
    await applyMovement(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      movementType: 'opening',
      qty: d('10'),
      unitCost: d('90'),
      refType: 'opening',
      movedAt: daysAgoISO(2),
    });
    const res = await applyMovement(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      movementType: 'sale',
      qty: d('-4'),
      unitCost: d('90'),
      refType: 'invoice',
      refId: 1,
      movedAt: daysAgoISO(0),
    });
    expect(res.newLevel.toFixed(3)).toBe('6.000');
    const level = await getStockLevel(db, seed.milkId, seed.warehouseId);
    expect(level.toFixed(3)).toBe('6.000');
    const mv = await db.all<{ qty: string; movement_type: string; unit_cost: string }>(
      'SELECT qty, movement_type, unit_cost FROM stock_movement WHERE movement_type = ? ORDER BY id DESC LIMIT 1',
      ['sale'],
    );
    expect(mv[0]!.qty).toBe('-4.000');
    expect(mv[0]!.unit_cost).toBe('90.0000');
  });

  test('تجاوز المتاح → NegativeStockError برسالة عربية تسمّي الصنف والمتاح والنقص — ولا يُكتب شيء', async () => {
    const { db, seed } = await seededDb();
    await applyMovement(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      movementType: 'opening',
      qty: d('5'),
      unitCost: d('90'),
      refType: 'opening',
      movedAt: daysAgoISO(2),
    });
    let err: unknown;
    try {
      await applyMovement(db, {
        productId: seed.milkId,
        warehouseId: seed.warehouseId,
        movementType: 'sale',
        qty: d('-8'),
        unitCost: d('90'),
        refType: 'invoice',
        refId: 1,
        movedAt: daysAgoISO(0),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NegativeStockError);
    const msg = (err as NegativeStockError).message;
    expect(msg).toContain('حليب المراعي');
    expect(msg).toContain('5.000');
    expect(msg).toContain('النقص 3.000');
    expect(msg).toContain('خفّض الكمية');
    // ذرّية: الرصيد لم يتغير ولا صف حركة جديد
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('5.000');
    const count = await db.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM stock_movement WHERE product_id = ?',
      [seed.milkId],
    );
    expect(Number(count[0]!.n)).toBe(1); // حركة الافتتاح فقط
  });

  test('حركة لصنف خدمي → رفض برسالة واضحة (قرار 5)', async () => {
    const { db, seed } = await seededDb();
    await expect(
      applyMovement(db, {
        productId: seed.deliveryId,
        warehouseId: seed.warehouseId,
        movementType: 'sale',
        qty: d('-1'),
        unitCost: d('0'),
        refType: 'invoice',
        refId: 1,
        movedAt: daysAgoISO(0),
      }),
    ).rejects.toBeInstanceOf(DomainRuleError);
  });

  test('كمية صفر → رفض (CHECK qty <> 0 محاكى تطبيقياً)', async () => {
    const { db, seed } = await seededDb();
    await expect(
      applyMovement(db, {
        productId: seed.milkId,
        warehouseId: seed.warehouseId,
        movementType: 'manual_adjust',
        qty: d('0'),
        unitCost: d('90'),
        movedAt: daysAgoISO(0),
      }),
    ).rejects.toThrow('لا يمكن أن تكون صفراً');
  });

  test('صنف غير موجود → رسالة واضحة', async () => {
    const { db, seed } = await seededDb();
    await expect(
      applyMovement(db, {
        productId: 999,
        warehouseId: seed.warehouseId,
        movementType: 'sale',
        qty: d('-1'),
        unitCost: d('90'),
        movedAt: daysAgoISO(0),
      }),
    ).rejects.toThrow('صنف غير موجود');
  });
});

describe('getStockLevel / updateProductCost / recordOpeningStock', () => {
  test('الرصيد الافتراضي صفر عند غياب الصف', async () => {
    const { db, seed } = await seededDb();
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('0.000');
  });

  test('updateProductCost يخزّن 4dp وupdatedAt', async () => {
    const { db, seed } = await seededDb();
    await updateProductCost(db, seed.milkId, d('110.123456'));
    const rows = await db.all<{ cost_price: string; updated_at: string }>(
      'SELECT cost_price, updated_at FROM product WHERE id = ?',
      [seed.milkId],
    );
    expect(rows[0]!.cost_price).toBe('110.1235');
    expect(rows[0]!.updated_at).toBeTruthy();
  });

  test('رصيد افتتاحي: حركة opening + رفع الرصيد + مزج WAC فوق رصيد قائم', async () => {
    const { db, seed } = await seededDb();
    // رصيد أول 10 @ 100
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('10'),
      unitCost: d('100'),
      movedAt: daysAgoISO(5),
    });
    // رصيد ثانٍ 10 @ 120 → WAC = 110 (5.4-3)
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('10'),
      unitCost: d('120'),
      movedAt: daysAgoISO(4),
    });
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('20.000');
    const prod = await db.all<{ cost_price: string }>(
      'SELECT cost_price FROM product WHERE id = ?',
      [seed.milkId],
    );
    expect(prod[0]!.cost_price).toBe('110.0000');
    const openingRows = await db.all<{ qty: string; movement_type: string }>(
      'SELECT qty, movement_type FROM stock_movement WHERE movement_type = ?',
      ['opening'],
    );
    expect(openingRows.length).toBe(2);
    expect(openingRows[0]!.qty).toBe('10.000');
  });
});
