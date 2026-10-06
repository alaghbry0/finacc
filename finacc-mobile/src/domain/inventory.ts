/**
 * inventory.ts — محرك حركات المخزون + التكلفة المرجّحة WAC (SRS 5.4-3/5.4-5).
 *
 * قواعد ملزمة مطبَّقة هنا:
 *  - **كل التكاليف بالعملة الأساسية**: product.cost_price (WAC) وstock_movement.unit_cost
 *    وinvoice_item.line_cost كلها بالعملة الأساسية (تعليق DDL: «cost_price بالعملة الأساسية»).
 *    فاتورة شراء بعملة أجنبية تُحوَّل تكلفتها الفعّالة إلى الأساس بسعر يوم الشراء قبل خلط WAC
 *    (AC-03: «التكلفة سُجّلت بسعر يوم الشراء»).
 *  - **منع السالب المخزوني مطلقاً** (قرار 9): فحص تطبيقي قبل الكتابة + CHECK على العمود —
 *    رسالة الرفض تسمّي الصنف والمتاح والنقص (FR-02-18 / §6.3).
 *  - **WAC** (5.4-3): new = (qty_old×cost_old + qty_new×cost_new)/(qty_old+qty_new)؛
 *    عند qty_old ≤ 0 تُعتمد cost_new مباشرة. البيع لا يغيّر WAC — يستهلكه (line_cost snapshot).
 *  - applyMovement تُندى حصراً داخل transaction المستند (ذرّية 5.4-4) — عقد استخدام موثق.
 *
 * نقاء الوحدة: adapter + decimal.js + وحدات domain شقيقة فقط (NFR-09/11).
 */
import type { SqliteAdapter } from '../db/adapter';
import { d, f3, f4 } from '../utils/money';
import { Decimal } from '../utils/money';
import { DomainRuleError, NegativeStockError } from './errors';

export type MovementType =
  | 'purchase'
  | 'sale'
  | 'sale_return'
  | 'purchase_return'
  | 'stocktake_adjust'
  | 'manual_adjust'
  | 'transfer_in'
  | 'transfer_out'
  | 'opening';

const MOVEMENT_TYPES: readonly MovementType[] = [
  'purchase',
  'sale',
  'sale_return',
  'purchase_return',
  'stocktake_adjust',
  'manual_adjust',
  'transfer_in',
  'transfer_out',
  'opening',
];

/**
 * التكلفة المرجّحة بعد إضافة كمية جديدة بتكلفة وحدة معطاة (SRS 5.4-3).
 * دالة نقية خالصة — تُختبر مباشرة (§10.2).
 * @param oldQty   الكمية القديمة (بالأصل السالب/الصفر → تُعتمد cost_new)
 * @param oldCost  WAC القديم
 * @param addQty   الكمية المضافة (موجبة)
 * @param addCost  تكلفة الوحدة المضافة
 * @returns WAC الجديد مقرباً 4 منازل (HALF_UP)
 */
export function computeWac(
  oldQty: string | number | Decimal,
  oldCost: string | number | Decimal,
  addQty: string | number | Decimal,
  addCost: string | number | Decimal,
): Decimal {
  const oq = d(oldQty);
  const oc = d(oldCost);
  const aq = d(addQty);
  const ac = d(addCost);
  // 5.4-3: عند qty_old ≤ 0 تُعتمد cost_new مباشرة
  if (oq.lte(0)) {
    return ac.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  }
  const wac = oq.times(oc).plus(aq.times(ac)).div(oq.plus(aq));
  return wac.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/** مدخل حركة مخزون — qty **موقّعة**: سالبة للصادر */
export interface MovementInput {
  productId: number;
  warehouseId: number;
  movementType: MovementType;
  /** كمية موقّعة: موجبة وارد / سالبة صادر */
  qty: Decimal | string;
  /** تكلفة الوحدة بالعملة الأساسية (لقطة WAC أو سعر الشراء الفعلي) */
  unitCost: Decimal | string;
  refType?: string;
  refId?: number;
  movedAt: string;
  notes?: string;
  createdBy?: number;
}

/**
 * يطبّق حركة مخزون واحدة: تحقق الصنف + حارس السالب + UPSERT الرصيد + سطر الحركة.
 * ⚠️ يجب أن تُستدعى داخل transaction المستند الأم (ذرّية 5.4-4) — ليست معاملة مستقلة.
 * @returns الرصيد الجديد بعد الحركة
 */
export async function applyMovement(
  adapter: SqliteAdapter,
  m: MovementInput,
): Promise<{ newLevel: Decimal }> {
  if (!MOVEMENT_TYPES.includes(m.movementType)) {
    throw new DomainRuleError('BAD_MOVEMENT_TYPE', `نوع حركة مخزون غير معروف: ${m.movementType}`);
  }
  const qty = d(m.qty);
  if (qty.isZero()) {
    throw new DomainRuleError('ZERO_MOVEMENT', 'كمية الحركة لا يمكن أن تكون صفراً');
  }

  // 1) الصنف: وجود + ليس خدمياً (قرار 5: الخدمي بلا أثر مخزوني)
  const prodRows = await adapter.all<{ name: string; is_service: number }>(
    'SELECT name, is_service FROM product WHERE id = ?',
    [m.productId],
  );
  const prod = prodRows[0];
  if (!prod) {
    throw new DomainRuleError('PRODUCT_NOT_FOUND', `صنف غير موجود (معرّف ${m.productId})`);
  }
  if (Number(prod.is_service) === 1) {
    throw new DomainRuleError(
      'SERVICE_NO_STOCK',
      `الصنف «${prod.name}» صنف خدمي — لا يجوز تسجيل حركات مخزون له`,
    );
  }

  // 2) + 3) الرصيد الحالي ثم حارس السالب (قرار 9) — الرسالة تسمّي الصنف والنقص
  const level = await getStockLevel(adapter, m.productId, m.warehouseId);
  const newLevel = level.plus(qty);
  if (newLevel.lt(0)) {
    throw new NegativeStockError(prod.name, f3(level), f3(qty.abs()));
  }

  // 4) UPSERT الرصيد (CHECK qty >= 0 حارس ثانٍ على مستوى القاعدة)
  await adapter.run(
    `INSERT INTO stock_level (product_id, warehouse_id, qty) VALUES (?, ?, ?)
     ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty = excluded.qty`,
    [m.productId, m.warehouseId, f3(newLevel)],
  );

  // 5) سطر الحركة (qty موقّعة 3dp، unit_cost 4dp)
  const now = new Date().toISOString();
  await adapter.run(
    `INSERT INTO stock_movement
       (product_id, warehouse_id, movement_type, qty, unit_cost, ref_type, ref_id, moved_at, notes, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.productId,
      m.warehouseId,
      m.movementType,
      f3(qty),
      f4(m.unitCost),
      m.refType ?? null,
      m.refId ?? null,
      m.movedAt,
      m.notes ?? null,
      now,
      m.createdBy ?? null,
    ],
  );
  return { newLevel };
}

/** رصيد صنف في مخزن — 0 إن لم يوجد صف */
export async function getStockLevel(
  adapter: SqliteAdapter,
  productId: number,
  warehouseId: number,
): Promise<Decimal> {
  const rows = await adapter.all<{ qty: string }>(
    'SELECT qty FROM stock_level WHERE product_id = ? AND warehouse_id = ?',
    [productId, warehouseId],
  );
  return rows[0] ? d(rows[0].qty) : new Decimal(0);
}

/** يحدّث WAC الصنف (بالعملة الأساسية، 4dp) */
export async function updateProductCost(
  adapter: SqliteAdapter,
  productId: number,
  newCost: Decimal | string,
): Promise<void> {
  await adapter.run('UPDATE product SET cost_price = ?, updated_at = ? WHERE id = ?', [
    f4(newCost),
    new Date().toISOString(),
    productId,
  ]);
}

/** بيانات رصيد افتتاحي (Onboarding / استيراد) */
export interface OpeningStockInput {
  productId: number;
  warehouseId: number;
  qty: Decimal | string;
  unitCost: Decimal | string;
  movedAt: string;
  createdBy?: number;
}

/**
 * يسجل رصيداً افتتاحياً: حركة 'opening' + رفع الرصيد + مزج WAC
 * (qty_old×cost_old + qty_new×cost_new) — 5.4-3.
 */
export async function recordOpeningStock(
  adapter: SqliteAdapter,
  input: OpeningStockInput,
): Promise<void> {
  const prodRows = await adapter.all<{ cost_price: string }>(
    'SELECT cost_price FROM product WHERE id = ?',
    [input.productId],
  );
  const prod = prodRows[0];
  if (!prod) {
    throw new DomainRuleError('PRODUCT_NOT_FOUND', `صنف غير موجود (معرّف ${input.productId})`);
  }
  const oldQty = await getStockLevel(adapter, input.productId, input.warehouseId);
  const oldCost = d(prod.cost_price);
  const newWac = computeWac(oldQty, oldCost, d(input.qty), d(input.unitCost));
  await applyMovement(adapter, {
    productId: input.productId,
    warehouseId: input.warehouseId,
    movementType: 'opening',
    qty: d(input.qty),
    unitCost: d(input.unitCost),
    refType: 'opening',
    movedAt: input.movedAt,
    createdBy: input.createdBy,
  });
  await updateProductCost(adapter, input.productId, newWac);
}
