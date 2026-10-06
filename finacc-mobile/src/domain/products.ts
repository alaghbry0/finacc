/**
 * products.ts — نطاق الأصناف: إنشاء/تعديل/أرشفة/حذف/قراءة (FR-01-01/02/15/16).
 *
 * القواعد الملزمة المنفَّذة:
 *  - **الباركود فريد عبر كل الأصناف بما فيها المؤرشفة** (FR-01-01: «يبقى
 *    محجوزاً بعد الأرشفة») — التعارض يُرفض برسالة «هذا الباركود مستخدم لصنف آخر».
 *  - الباركود الفارغ → يولَّد تلقائياً EAN-13 داخلي يبدأ «200» (FR-01-02).
 *  - الأصناف الخدمية (is_service=1): بلا حركات ولا رصيد (قرار 5 / FR-01-16).
 *  - الكمية الافتتاحية: حركة 'opening' + مزج WAC عبر inventory.recordOpeningStock —
 *    داخل نفس المعاملة (ذرّية 5.4-4).
 *  - التكلفة يدوياً: تُقبل فقط قبل أول حركة مخزون/فاتورة — بعدها WAC يحكمها
 *    (الشراء هو مصدر التحديث الوحيد) — رفض عربي واضح.
 *  - الحذف: ممنوع مع أي حركة أو إشارة فاتورة → «أرشفه بدلاً من ذلك» (FR-01-15).
 *  - الأسعار: مستوى retail فقط (قرار 5) — Upsert على (صنف/عملة/مستوى) فلا
 *    تتكرر الصفوف أبداً (قيد UNIQUE في القاعدة).
 *
 * نقاء الوحدة: adapter + decimal.js + zod + وحدات شقيقة (NFR-09/11).
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { d, f3, f4, isDecimalString, Decimal } from '../utils/money';
import { generateEan13, isValidEan13 } from '../utils/ean13';
import { DomainRuleError, ValidationError } from './errors';
import { recordOpeningStock } from './inventory';

/* ============================ المخططات (زود) ============================ */

const DecNonNeg = (msg: string) =>
  z
    .string()
    .refine((s) => isDecimalString(s) && d(s).gte(0), { message: msg });

/** سعر بيع بعملة — مستوى retail فقط (قرار 5) */
export const ProductPriceSchema = z.object({
  currencyId: z.number().int().positive({ message: 'معرّف العملة غير صالح' }),
  price: DecNonNeg('سعر البيع يجب أن يكون رقماً غير سالب'),
});

export const ProductInputSchema = z
  .object({
    name: z.string().trim().min(1, 'اسم الصنف مطلوب'),
    barcode: z
      .string()
      .trim()
      .refine((s) => s === '' || (isValidEan13(s) === true && /^\d{13}$/.test(s)), {
        message: 'الباركود يجب أن يكون 13 رقماً صحيحة — أو اتركه فارغاً ليولَّد تلقائياً',
      })
      .optional(),
    categoryId: z.number().int().positive().optional(),
    unitId: z.number().int().positive().optional(),
    costPrice: DecNonNeg('سعر التكلفة يجب أن يكون رقماً غير سالب').optional(),
    minStock: DecNonNeg('الحد الأدنى للتنبيه يجب أن يكون رقماً غير سالب').optional(),
    isService: z.boolean().optional(),
    openingQty: DecNonNeg('الكمية الافتتاحية يجب أن تكون رقماً غير سالب').optional(),
    openingWarehouseId: z.number().int().positive().optional(),
    prices: z
      .array(ProductPriceSchema)
      .min(1, 'أدخل سعر البيع بعملة واحدة على الأقل (العملة الأساسية إلزامية)'),
    notes: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    const opening = p.openingQty !== undefined && d(p.openingQty).gt(0);
    if (p.isService && opening) {
      ctx.addIssue({
        code: 'custom',
        path: ['openingQty'],
        message: 'الصنف الخدمي بلا مخزون — احذف الكمية الافتتاحية (FR-01-16)',
      });
    }
    if (opening && !p.isService && p.openingWarehouseId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['openingWarehouseId'],
        message: 'الكمية الافتتاحية تتطلب اختيار المخزن الذي فيها',
      });
    }
    // عملة واحدة لا تتكرر في قائمة الأسعار (قيد UNIQUE على مستوى القاعدة)
    const seen = new Set<number>();
    for (const [i, pr] of p.prices.entries()) {
      if (seen.has(pr.currencyId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['prices', i, 'currencyId'],
          message: 'سعر العملة مُدخل مرتين — عملة واحدة لكل سعر (مستوى retail)',
        });
      }
      seen.add(pr.currencyId);
    }
  });

export type ProductInput = z.input<typeof ProductInputSchema>;

/* ============================ مساعدات داخلية ============================ */

function parseInput(input: unknown) {
  const parsed = ProductInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      'تحقّق من حقول الصنف — بعض القيم ناقصة أو غير صالحة',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** معرّف العملة الأساسية — يقذف خطأ واضحاً إن لم تُهيَّأ العملات */
async function getBaseCurrencyId(adapter: SqliteAdapter): Promise<number> {
  const rows = await adapter.all<{ id: number }>('SELECT id FROM currency WHERE is_base = 1');
  if (!rows[0]) {
    throw new DomainRuleError(
      'NO_BASE_CURRENCY',
      'لا توجد عملة أساسية بعد — أكمل التهيئة الأولى قبل إضافة الأصناف',
    );
  }
  return Number(rows[0].id);
}

/** يرفض الأسعار إن خلت من العملة الأساسية أو أشارت لعملة غير موجودة */
async function assertPricesCurrencies(
  adapter: SqliteAdapter,
  prices: { currencyId: number; price: string }[],
  baseCurrencyId: number,
): Promise<void> {
  if (!prices.some((p) => p.currencyId === baseCurrencyId)) {
    throw new DomainRuleError(
      'PRICE_BASE_REQUIRED',
      'أدخل سعر البيع بالعملة الأساسية على الأقل — أسعار العملات الأخرى اختيارية',
    );
  }
  const ids = prices.map((p) => p.currencyId);
  const rows = await adapter.all<{ id: number; is_active: number }>(
    `SELECT id, is_active FROM currency WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  const found = new Set(rows.map((r) => Number(r.id)));
  const missing = ids.find((id) => !found.has(id));
  if (missing !== undefined) {
    throw new DomainRuleError('CURRENCY_NOT_FOUND', `عملة غير موجودة (معرّف ${missing})`);
  }
}

/** Upsert سعر بيع (retail، هامش 0) — لا صفوف مكررة أبداً (قيد UNIQUE) */
async function upsertPrices(
  adapter: SqliteAdapter,
  productId: number,
  prices: { currencyId: number; price: string }[],
): Promise<void> {
  const now = new Date().toISOString();
  for (const pr of prices) {
    await adapter.run(
      `INSERT INTO product_price (product_id, currency_id, price, price_level, margin_percent, updated_at)
       VALUES (?, ?, ?, 'retail', '0', ?)
       ON CONFLICT(product_id, currency_id, price_level)
       DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at`,
      [productId, pr.currencyId, f4(pr.price), now],
    );
  }
}

/** كل الباركودات المحجوزة (شاملة المؤرشف — FR-01-01) */
async function allBarcodes(adapter: SqliteAdapter): Promise<Set<string>> {
  const rows = await adapter.all<{ barcode: string | null }>(
    'SELECT barcode FROM product WHERE barcode IS NOT NULL',
  );
  return new Set(rows.map((r) => r.barcode!));
}

/** يضبط الباركود النهائي: فريد عبر الكل، أو مولَّد داخلياً عند الفراغ */
async function resolveBarcode(
  adapter: SqliteAdapter,
  barcode: string | undefined,
  excludeProductId?: number,
): Promise<string> {
  const wanted = (barcode ?? '').trim();
  const existing = await allBarcodes(adapter);
  if (excludeProductId !== undefined) {
    const rows = await adapter.all<{ barcode: string | null }>(
      'SELECT barcode FROM product WHERE id = ? AND barcode IS NOT NULL',
      [excludeProductId],
    );
    if (rows[0]) existing.delete(rows[0].barcode!); // باركوده الحالي ليس تعارضاً مع نفسه
  }
  if (wanted === '') {
    return generateEan13(existing);
  }
  if (existing.has(wanted)) {
    throw new DomainRuleError('BARCODE_TAKEN', 'هذا الباركود مستخدم لصنف آخر');
  }
  return wanted;
}

/* ============================ الإنشاء ============================ */

export interface CreateProductResult {
  id: number;
  barcode: string;
}

/**
 * ينشئ صنفاً كاملاً في **معاملة واحدة**: تحقق → باركود → صف الصنف → أسعار
 * retail → (اختياري) رصيد افتتاحي بحركة 'opening' ومزج WAC.
 */
export async function createProduct(
  adapter: SqliteAdapter,
  input: ProductInput,
  opts?: { createdBy?: number },
): Promise<CreateProductResult> {
  const data = parseInput(input);

  return adapter.transaction(async () => {
    const baseCurrencyId = await getBaseCurrencyId(adapter);
    await assertPricesCurrencies(adapter, data.prices, baseCurrencyId);
    const barcode = await resolveBarcode(adapter, data.barcode);

    const now = new Date().toISOString();
    const inserted = await adapter.all<{ id: number }>(
      `INSERT INTO product
         (name, barcode, category_id, unit_id, cost_price, min_stock, is_service, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        data.name,
        barcode,
        data.categoryId ?? null,
        data.unitId ?? null,
        f4(data.costPrice ?? '0'),
        f3(data.minStock ?? '0'),
        data.isService ? 1 : 0,
        data.notes ?? null,
        now,
        now,
        opts?.createdBy ?? null,
      ],
    );
    const productId = Number(inserted[0]!.id);

    await upsertPrices(adapter, productId, data.prices);

    // الرصيد الافتتاحي — حركة opening + WAC (نفس المعاملة)
    if (!data.isService && data.openingQty !== undefined && d(data.openingQty).gt(0)) {
      await recordOpeningStock(adapter, {
        productId,
        warehouseId: data.openingWarehouseId!,
        qty: d(data.openingQty),
        unitCost: d(data.costPrice ?? '0'),
        movedAt: now.slice(0, 10),
        createdBy: opts?.createdBy,
      });
    }

    return { id: productId, barcode };
  });
}

/* ============================ التعديل ============================ */

/**
 * يعدّل صنفاً (patch داخل معاملة واحدة):
 *  - الباركود: إن أُرسل (13 رقماً) يُفحص ضد الكل عدا الصنف نفسه؛ الفراغ/غيابه = إبقاء الحالي.
 *  - التكلفة: تُقبل فقط إن لم يكن للصنف أي حركة مخزون أو إشارة فاتورة —
 *    بعدها WAC يحكمها والتعديل اليدوي يُرفض.
 *  - الأسعار: Upsert على مستوى retail (تحديث لا تكرار).
 *  - الكمية الافتتاحية غير قابلة للتعديل (تُدار بالحركات) — تُرفض إن أُرسلت.
 */
export async function updateProduct(
  adapter: SqliteAdapter,
  id: number,
  input: ProductInput,
): Promise<void> {
  const data = parseInput(input);

  await adapter.transaction(async () => {
    const rows = await adapter.all<{
      name: string;
      barcode: string | null;
      category_id: number | null;
      unit_id: number | null;
      cost_price: string;
      min_stock: string;
      notes: string | null;
      is_service: number;
      is_archived: number;
    }>(
      'SELECT name, barcode, category_id, unit_id, cost_price, min_stock, notes, is_service, is_archived FROM product WHERE id = ?',
      [id],
    );
    const prod = rows[0];
    if (!prod) {
      throw new DomainRuleError('PRODUCT_NOT_FOUND', `صنف غير موجود (معرّف ${id})`);
    }

    // الكمية الافتتاحية تُدخل عند الإنشاء فقط
    if (data.openingQty !== undefined && d(data.openingQty).gt(0)) {
      throw new DomainRuleError(
        'OPENING_QTY_IMMUTABLE',
        'الكمية الافتتاحية تُدخل عند إنشاء الصنف فقط — بعد ذلك عدّل المخزون بفاتورة شراء أو تسوية جرد',
      );
    }

    // التكلفة اليدوية — قبل أول حركة فقط
    const costProvided = data.costPrice !== undefined;
    const costChanged = costProvided && !d(data.costPrice!).eq(d(prod.cost_price));
    if (costChanged) {
      const hasMoves = await hasAnyMovement(adapter, id);
      if (hasMoves) {
        throw new DomainRuleError(
          'COST_WAC_LOCKED',
          'تكلفة الصنف تُحسب آلياً بالمتوسط المرجّح من فواتير الشراء — لا يمكن تعديلها يدوياً بعد وجود حركات. عدّل التكلفة عبر فاتورة شراء',
        );
      }
    }

    // تحويل صنف له حركات إلى خدمي ممنوع (حركاته المخزونية تفقد معناها)
    if (data.isService === true && Number(prod.is_service) === 0) {
      const hasMoves = await hasAnyMovement(adapter, id);
      if (hasMoves) {
        throw new DomainRuleError(
          'SERVICE_FLIP_BLOCKED',
          'لا يمكن تحويل صنف له حركات مخزون إلى صنف خدمي — الأرشفة أولاً ثم أنشئ صنفاً خدمياً جديداً',
        );
      }
    }

    const barcodeWanted = (data.barcode ?? '').trim();
    const finalBarcode =
      barcodeWanted === '' ? prod.barcode : await resolveBarcode(adapter, barcodeWanted, id);

    await adapter.run(
      `UPDATE product SET name = ?, barcode = ?, category_id = ?, unit_id = ?,
         cost_price = ?, min_stock = ?, is_service = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      [
        data.name,
        finalBarcode,
        data.categoryId ?? prod.category_id,
        data.unitId ?? prod.unit_id,
        f4(data.costPrice ?? prod.cost_price),
        f3(data.minStock ?? prod.min_stock),
        data.isService === undefined ? Number(prod.is_service) : data.isService ? 1 : 0,
        data.notes ?? prod.notes,
        new Date().toISOString(),
        id,
      ],
    );

    const baseCurrencyId = await getBaseCurrencyId(adapter);
    await assertPricesCurrencies(adapter, data.prices, baseCurrencyId);
    await upsertPrices(adapter, id, data.prices);
  });
}

/* ============================ الأرشفة والحذف ============================ */

/** أرشفة الصنف: يختفي من القوائم الجديدة والمسح، ويبقى في التقارير — الباركود يبقى محجوزاً */
export async function archiveProduct(adapter: SqliteAdapter, id: number): Promise<void> {
  const rows = await adapter.all<{ is_archived: number }>(
    'SELECT is_archived FROM product WHERE id = ?',
    [id],
  );
  if (!rows[0]) {
    throw new DomainRuleError('PRODUCT_NOT_FOUND', `صنف غير موجود (معرّف ${id})`);
  }
  if (Number(rows[0].is_archived) === 1) {
    throw new DomainRuleError('ALREADY_ARCHIVED', 'الصنف مؤرشف مسبقاً');
  }
  await adapter.run('UPDATE product SET is_archived = 1, updated_at = ? WHERE id = ?', [
    new Date().toISOString(),
    id,
  ]);
}

/** هل للصنف أي حركة مخزون أو إشارة فاتورة (بما فيها المسودات)؟ */
async function hasAnyMovement(adapter: SqliteAdapter, productId: number): Promise<boolean> {
  const [moves, items] = await Promise.all([
    adapter.all<{ c: number }>('SELECT COUNT(*) AS c FROM stock_movement WHERE product_id = ?', [
      productId,
    ]),
    adapter.all<{ c: number }>('SELECT COUNT(*) AS c FROM invoice_item WHERE product_id = ?', [
      productId,
    ]),
  ]);
  return Number(moves[0]?.c ?? 0) > 0 || Number(items[0]?.c ?? 0) > 0;
}

/** حذف نهائي — فقط لصنف بلا أي حركة/إشارة؛ ما سواه أرشفة (FR-01-15) */
export async function deleteProduct(adapter: SqliteAdapter, id: number): Promise<void> {
  await adapter.transaction(async () => {
    const rows = await adapter.all<{ id: number }>('SELECT id FROM product WHERE id = ?', [id]);
    if (!rows[0]) {
      throw new DomainRuleError('PRODUCT_NOT_FOUND', `صنف غير موجود (معرّف ${id})`);
    }
    if (await hasAnyMovement(adapter, id)) {
      throw new DomainRuleError(
        'PRODUCT_HAS_MOVEMENTS',
        'لا يمكن حذف صنف له حركات — أرشفه بدلاً من ذلك ليبقى سجله في التقارير',
      );
    }
    await adapter.run('DELETE FROM product_price WHERE product_id = ?', [id]);
    await adapter.run('DELETE FROM product WHERE id = ?', [id]);
  });
}

/* ============================ القراءة ============================ */

export interface ProductRow {
  id: number;
  name: string;
  barcode: string | null;
  categoryId: number | null;
  unitId: number | null;
  costPrice: string;
  minStock: string;
  isService: boolean;
  notes: string | null;
  isArchived: boolean;
}

export interface ProductPriceRow {
  currencyId: number;
  currencyCode: string;
  price: string;
  priceLevel: string;
}

export interface ProductFull extends ProductRow {
  prices: ProductPriceRow[];
  stockTotal: string;
}

const PRODUCT_COLS =
  'id, name, barcode, category_id, unit_id, cost_price, min_stock, is_service, notes, is_archived';

type RawProduct = {
  id: number;
  name: string;
  barcode: string | null;
  category_id: number | null;
  unit_id: number | null;
  cost_price: string;
  min_stock: string;
  is_service: number;
  notes: string | null;
  is_archived: number;
};

function mapProduct(r: RawProduct): ProductRow {
  return {
    id: Number(r.id),
    name: r.name,
    barcode: r.barcode ?? null,
    categoryId: r.category_id === null ? null : Number(r.category_id),
    unitId: r.unit_id === null ? null : Number(r.unit_id),
    costPrice: r.cost_price,
    minStock: r.min_stock,
    isService: Number(r.is_service) === 1,
    notes: r.notes ?? null,
    isArchived: Number(r.is_archived) === 1,
  };
}

/** صنف واحد + أسعاره + رصيده الكلي (كل المخازن) */
export async function getProduct(adapter: SqliteAdapter, id: number): Promise<ProductFull | null> {
  const rows = await adapter.all<RawProduct>(
    `SELECT ${PRODUCT_COLS} FROM product WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const [prices, stock] = await Promise.all([
    adapter.all<{ currency_id: number; code: string; price: string; price_level: string }>(
      `SELECT pp.currency_id, c.code, pp.price, pp.price_level
       FROM product_price pp JOIN currency c ON c.id = pp.currency_id
       WHERE pp.product_id = ?`,
      [id],
    ),
    getStockTotal(adapter, id),
  ]);
  return {
    ...mapProduct(row),
    prices: prices.map((p) => ({
      currencyId: Number(p.currency_id),
      currencyCode: p.code,
      price: p.price,
      priceLevel: p.price_level,
    })),
    stockTotal: stock,
  };
}

/** مجموع رصيد الصنف عبر كل المخازن — Decimal في الذاكرة (لا Float) */
export async function getStockTotal(adapter: SqliteAdapter, productId: number): Promise<string> {
  const rows = await adapter.all<{ qty: string }>(
    'SELECT qty FROM stock_level WHERE product_id = ?',
    [productId],
  );
  return f3(sumQty(rows.map((r) => r.qty)));
}

function sumQty(qs: string[]): Decimal {
  return qs.reduce((acc, q) => acc.plus(d(q)), new Decimal(0));
}

/** يهرب محارف LIKE الخاصة (%) و(_) حتى لا يفسد البحث */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ListProductsOptions {
  search?: string;
  /** افتراضي true: النشطة فقط؛ false يضم المؤرشفة (للتقارير) */
  onlyActive?: boolean;
  limit?: number;
}

/** قائمة أصناف للشاشات: بحث بالاسم/الباركود، ترتيب بالاسم، سقف 100 */
export async function listProducts(
  adapter: SqliteAdapter,
  opts: ListProductsOptions = {},
): Promise<ProductRow[]> {
  const onlyActive = opts.onlyActive ?? true;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const search = (opts.search ?? '').trim();
  const where: string[] = [];
  const params: unknown[] = [];
  if (onlyActive) {
    where.push('is_archived = 0');
  }
  if (search !== '') {
    // بحث بالاسم أو الباركود (ESCAPE '\' حتى لا تُفسد % و_ البحث)
    where.push(
      "(name LIKE ? ESCAPE '\\' OR (barcode IS NOT NULL AND barcode LIKE ? ESCAPE '\\'))",
    );
    const like = `%${escapeLike(search)}%`;
    params.push(like, like);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = await adapter.all<RawProduct>(
    `SELECT ${PRODUCT_COLS} FROM product${whereSql} ORDER BY name LIMIT ${limit}`,
    params,
  );
  return rows.map(mapProduct);
}
