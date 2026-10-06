/**
 * stocktake.ts — الجرد وتسوية الفروقات (FR-01-08 / AC-04 — قرار 10).
 *
 * النموذج المحاسبي (خريطة الترحيل — ملحق و):
 *  - الجرد عملية **مقارنة** لا حركة: لكل صنف يُقرأ الرصيد الدفتري
 *    (stock_level) ويُدخل الرصيد الفعلي المعدود، والفرق
 *    diff = counted − book يُولَّد **حركة جرد موقّعة**
 *    (movement_type='stocktake_adjust') عبر applyMovement داخل نفس المعاملة:
 *    موجب = زيادة جرد (وارد المخزون، بند ربح «زيادة الجرد» — قرار 7) وسالب
 *    = عجز (بند خسارة).
 *  - **تكلفة اللقطة (قرار 10 / إصلاح v1.2)**: unit_cost لكل سطر = WAC الصنف
 *    لحظة الجرد (product.cost_price) تُخزَّن في stocktake_line.unit_cost
 *    وتُرحَّل بها الحركة — **لا يُعاد حسابها لاحقاً** بـ WAC متغير.
 *  - **كل الأسطر تُسجَّل** (حتى المطابقة diff=0) لأثر التدقيق — لكن الحركة
 *    تُطبَّق للفروقات فقط (applyMovement يرفض الكمية الصفر).
 *  - total_diff (ترويسة الجرد) = Σ(diff × unit_cost) موقّعاً 4dp بالعملة
 *    الأساسية (unit_cost أساسية دائماً — قاعدة inventory.ts).
 *  - حركة الجرد «تقفل الأرصدة»: بعد التسوية stock_level = الكمية المعدودة
 *    حرفياً (AC-04) — الكتابة كلها داخل Transaction ذرّية واحدة فلا جرد
 *    نصفي أبداً (5.4-4).
 *
 * قواعد صارمة (موروثة عن الوحدات الشقيقة):
 *  - Decimal نصي فقط: f3 للكميات وf4 للتكاليف (5.2-3) — لا Float.
 *  - assertPeriodOpen على تاريخ الجرد (المستخدم) — سنة مغلقة ترفض القاطع.
 *  - audit_log 'stocktake' بتفاصيل JSON كاملة (المخزن/التاريخ/الأعداد/القيمة).
 *
 * حدود V1 الموثقة:
 *  - لا تعديل ولا حذف جرد بعد الاعتماد — التسوية الخاطئة تُعالج بجرد
 *    جديد معاكس (نفس منطق DDL: status='completed' دائماً عند الإنشاء).
 *  - المنتقي (الشاشة) يجلب الأصناف غير الخدمية للمخزن؛ الدومين يحرس
 *    الخدمي مرة ثانية (SERVICE_NO_STOCK) — دفاع في عمق.
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { d, f3, f4, isDecimalString, Decimal } from '../utils/money';
import { DomainRuleError, ValidationError } from './errors';
import { assertPeriodOpen } from './fiscal';
import { applyMovement, getStockLevel } from './inventory';

/* ============================ المخططات (زود) ============================ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** الكمية المعدودة: نص عشري غير سالب (لا جرد بالسالب — العجز يُشتق من الفرق) */
const CountedQty = z
  .string()
  .refine((s) => isDecimalString(s) && d(s).gte(0), {
    message: 'الكمية المعدودة يجب أن تكون رقماً غير سالب',
  });

/** سطر جرد: صنف + ما عُدّ فعلاً في الرف/المخزن */
export const StocktakeLineSchema = z.object({
  productId: z.number().int().positive(),
  countedQty: CountedQty,
});
export type StocktakeLineInput = z.input<typeof StocktakeLineSchema>;

export const CreateStocktakeInputSchema = z.object({
  warehouseId: z.number().int().positive(),
  /** تاريخ الجرد الذي أدخله المستخدم (YYYY-MM-DD) — تاريخ الحركة */
  countedAt: z.string().regex(ISO_DATE, 'تاريخ الجرد غير صالح (المتوقع YYYY-MM-DD)'),
  notes: z.string().optional(),
  /** أسطر الجرد (الأصناف المعدودة فقط — المطابق يُسجَّل سطراً بفرق 0) */
  lines: z.array(StocktakeLineSchema).min(1, 'لا توجد أصناف في الجرد — عدّ صنفاً واحداً على الأقل'),
});
export type CreateStocktakeInput = z.input<typeof CreateStocktakeInputSchema>;

/* ============================ الأنواع ============================ */

/** صف stocktake كما يُقرأ من القاعدة (snake_case حرفياً) */
export interface StocktakeRow {
  id: number;
  warehouse_id: number;
  counted_at: string;
  total_diff: string | null;
  status: string | null;
  notes: string | null;
  created_at: string | null;
  created_by: number | null;
}

/** نتيجة اعتماد الجرد — للشيتات والاختبارات */
export interface CreateStocktakeResult {
  stocktakeId: number;
  /** عدد الأسطر المسجَّلة (كل ما عُدّ — شاملاً المطابق) */
  linesCount: number;
  /** عدد أسطر الفرق (تولّدت لها حركات تسوية) */
  diffsCount: number;
  /** Σ(diff × unit_cost) موقّعاً (4dp) — بالعملة الأساسية */
  totalDiff: string;
  /** التسويات المطبَّقة (سطر لكل فرق ≠ 0) */
  adjustments: {
    productId: number;
    productName: string;
    diffQty: string;
    unitCost: string;
    lineValue: string;
    /** الرصيد بعد التسوية = الكمية المعدودة حرفياً */
    newLevel: string;
  }[];
}

/** صف جرد لقائمة السجل */
export interface StocktakeListRow {
  id: number;
  warehouseId: number;
  warehouseName: string;
  countedAt: string;
  totalDiff: string;
  status: string;
  notes: string | null;
  createdAt: string | null;
  linesCount: number;
  diffsCount: number;
}

/** سطر تفصيل الجرد مع بياناته المشتقة */
export interface StocktakeLineDetail {
  id: number;
  productId: number;
  productName: string;
  /** الرصيد الدفتري وقت الجرد (3dp) */
  bookQty: string;
  countedQty: string;
  diffQty: string;
  /** لقطة تكلفة الوحدة وقت الجرد (4dp) */
  unitCost: string;
  /** قيمة الفرق = diff × unit_cost (4dp موقّعة) */
  lineValue: string;
}

export interface StocktakeDetails extends StocktakeListRow {
  lines: StocktakeLineDetail[];
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

/* ==================== اعتماد الجرد (FR-01-08) ==================== */

/**
 * يعتمد جرد مخزن داخل Transaction ذرّية واحدة:
 *  1) زود + حرس الفترة على تاريخ الجرد + وجود المخزن.
 *  2) لكل سطر: الصنف موجود + غير خدمي + بلا تكرار، والرصيد الدفتري
 *     يُقرأ من stock_level، ولقطة التكلفة unit_cost = WAC الصنف الآن.
 *  3) إدخال الترويسة (total_diff = Σ diff×cost موقّعة 4dp) أولاً لأخذ
 *     المعرّف، ثم كل الأسطر (شاملاً المطابق diff=0 لأثر التدقيق).
 *  4) لكل فرق ≠ 0: applyMovement('stocktake_adjust', qty موقّعة, unitCost
 *     اللقطة, refType='stocktake', refId=معرّف الجرد, movedAt=تاريخ الجرد)
 *     — الحركة والسطر والرصيد كلهم داخل نفس المعاملة (ذرّية 5.4-4).
 *  5) قيد audit 'stocktake' بتفاصيل JSON.
 *
 * بعد النجاح: stock_level لكل صنف معدود = countedQty حرفياً (AC-04).
 */
export async function createStocktake(
  adapter: SqliteAdapter,
  input: CreateStocktakeInput,
  opts: { createdBy?: number } = {},
): Promise<CreateStocktakeResult> {
  return adapter.transaction(async () => {
    const parsed = CreateStocktakeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `بيانات الجرد غير صالحة: ${parsed.error.issues[0]?.message ?? 'راجع الحقول'}`,
        parsed.error.issues,
      );
    }
    const inp = parsed.data;

    // حرس الفترة المحاسبية على تاريخ الجرد (سنة مغلقة → رفض قاطع)
    await assertPeriodOpen(adapter, inp.countedAt);

    // المخزن
    const whRows = await adapter.all<{ id: number; name: string }>(
      'SELECT id, name FROM warehouse WHERE id = ?',
      [inp.warehouseId],
    );
    const wh = whRows[0];
    if (!wh) {
      throw new DomainRuleError(
        'WAREHOUSE_NOT_FOUND',
        `المخزن غير موجود (معرّف ${inp.warehouseId}) — أعد فتح الجرد واختر مخزناً صحيحاً`,
      );
    }

    // تكرار الصنف في الأسطر — كمية كل صنف تُدمج في سطر واحد
    const seen = new Set<number>();
    for (const line of inp.lines) {
      if (seen.has(line.productId)) {
        throw new ValidationError(
          `الصنف (معرّف ${line.productId}) مكرر في أكثر من سطر — ادمج كميته المعدودة في سطر واحد`,
        );
      }
      seen.add(line.productId);
    }

    /* ——— قراءات الأسطر: الرصيد الدفتري + لقطة التكلفة (قراءة قبل أي كتابة) ——— */
    const prepared: {
      productId: number;
      productName: string;
      bookQty: Decimal;
      countedQty: Decimal;
      diffQty: Decimal;
      unitCost: Decimal;
      lineValue: Decimal;
    }[] = [];
    for (const line of inp.lines) {
      const prodRows = await adapter.all<{ name: string; is_service: number; cost_price: string }>(
        'SELECT name, is_service, cost_price FROM product WHERE id = ?',
        [line.productId],
      );
      const prod = prodRows[0];
      if (!prod) {
        throw new DomainRuleError(
          'PRODUCT_NOT_FOUND',
          `صنف غير موجود (معرّف ${line.productId}) — أعد فتح الجرد وحدّث قائمة الأصناف`,
        );
      }
      if (Number(prod.is_service) === 1) {
        throw new DomainRuleError(
          'SERVICE_NO_STOCK',
          `الصنف «${prod.name}» صنف خدمي — لا يُجرى ولا تُسوّى له أرصدة`,
        );
      }
      const bookQty = await getStockLevel(adapter, line.productId, inp.warehouseId);
      const countedQty = d(line.countedQty);
      const diffQty = countedQty.minus(bookQty);
      const unitCost = d(prod.cost_price); // لقطة WAC وقت الجرد (قرار 10)
      prepared.push({
        productId: line.productId,
        productName: prod.name,
        bookQty,
        countedQty,
        diffQty,
        unitCost,
        lineValue: diffQty.times(unitCost),
      });
    }

    let totalDiff = new Decimal(0);
    let diffsCount = 0;
    for (const p of prepared) {
      if (!p.diffQty.isZero()) diffsCount += 1;
      totalDiff = totalDiff.plus(p.lineValue);
    }

    /* ——— الترويسة أولاً (لمعرف الربط) ثم الأسطر ثم الحركات ——— */
    const nowIso = new Date().toISOString();
    const headRows = await adapter.all<{ id: number }>(
      `INSERT INTO stocktake (warehouse_id, counted_at, total_diff, status, notes, created_at, created_by)
       VALUES (?, ?, ?, 'completed', ?, ?, ?)
       RETURNING id`,
      [inp.warehouseId, inp.countedAt, f4(totalDiff), inp.notes ?? null, nowIso, opts.createdBy ?? null],
    );
    const stocktakeId = Number(headRows[0]!.id);

    for (const p of prepared) {
      await adapter.run(
        `INSERT INTO stocktake_line
           (stocktake_id, product_id, book_qty, counted_qty, diff_qty, unit_cost, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stocktakeId,
          p.productId,
          f3(p.bookQty),
          f3(p.countedQty),
          f3(p.diffQty),
          f4(p.unitCost),
          nowIso,
          opts.createdBy ?? null,
        ],
      );
    }

    const adjustments: CreateStocktakeResult['adjustments'] = [];
    for (const p of prepared) {
      if (p.diffQty.isZero()) continue; // المطابق: سطر بلا حركة (قرار الدومين)
      const { newLevel } = await applyMovement(adapter, {
        productId: p.productId,
        warehouseId: inp.warehouseId,
        movementType: 'stocktake_adjust',
        qty: p.diffQty, // موقّعة: + زيادة / − عجز
        unitCost: p.unitCost, // لقطة التكلفة — قرار 10
        refType: 'stocktake',
        refId: stocktakeId,
        movedAt: inp.countedAt, // بتاريخ المستخدم
        notes: `تسوية جرد «${p.productName}» — ${wh.name} (${inp.countedAt})`,
        createdBy: opts.createdBy,
      });
      adjustments.push({
        productId: p.productId,
        productName: p.productName,
        diffQty: f3(p.diffQty),
        unitCost: f4(p.unitCost),
        lineValue: f4(p.lineValue),
        newLevel: f3(newLevel),
      });
    }

    await audit(
      adapter,
      'stocktake',
      'stocktake',
      stocktakeId,
      {
        warehouseId: inp.warehouseId,
        warehouseName: wh.name,
        countedAt: inp.countedAt,
        linesCount: prepared.length,
        diffsCount,
        totalDiff: f4(totalDiff),
        notes: inp.notes ?? null,
      },
      opts.createdBy,
    );

    return {
      stocktakeId,
      linesCount: prepared.length,
      diffsCount,
      totalDiff: f4(totalDiff),
      adjustments,
    };
  });
}

/* ==================== قائمة السجل وتفاصيل الجرد ==================== */

/**
 * سجل عمليات الجرد: الأحدث أولاً (تاريخ الجرد ثم المعرّف)، مع اسم المخزن
 * وعدد الأسطر وعدد الفروقات. عدّ الفروقات بمقارنة CAST(diff AS REAL) ≠ 0 —
 * فحص صفريّ دقيق (المقارنة لا تجمع مالاً فلا كسر دقة — قاعدة الملف).
 */
export async function listStocktakes(adapter: SqliteAdapter): Promise<StocktakeListRow[]> {
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

/** ترويسة جرد واحدة أو null */
async function loadStocktakeHead(adapter: SqliteAdapter, id: number): Promise<StocktakeListRow | null> {
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
     WHERE s.id = ?`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
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
  };
}

/**
 * تفاصيل جرد: الترويسة + كل الأسطر بأسماء الأصناف وقيمة كل فرق
 * (diff × unit_cost بالDecimal في الذاكرة — لا CAST لمال).
 */
export async function getStocktakeDetails(
  adapter: SqliteAdapter,
  id: number,
): Promise<StocktakeDetails | null> {
  const head = await loadStocktakeHead(adapter, id);
  if (!head) return null;
  const lineRows = await adapter.all<{
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
  const lines: StocktakeLineDetail[] = lineRows.map((r) => {
    const diff = d(r.diff_qty);
    return {
      id: Number(r.id),
      productId: Number(r.product_id),
      productName: r.product_name,
      bookQty: r.book_qty,
      countedQty: r.counted_qty,
      diffQty: r.diff_qty,
      unitCost: r.unit_cost,
      lineValue: f4(diff.times(d(r.unit_cost))),
    };
  });
  return { ...head, lines };
}
