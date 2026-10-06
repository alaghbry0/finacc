/**
 * parties.ts — نطاق العملاء والموردين (FR-03-01/03/09 + قرار 7 للأرصدة الافتتاحية).
 *
 * القواعد الملزمة المنفَّذة:
 *  - **حد الائتمان ثلاثي الحالات (FR-03-01 حرفياً)**: NULL = بلا حد،
 *    "0" = منع الآجل كلياً، قيمة = حد بالعملة. undefined عند التعديل = إبقاء الحالي.
 *  - **الرصيد الافتتاحي بعملته وسعره وتاريخه**: موجب = مدين للعميل / دائن
 *    للمورد — يُخزَّن بـ opening_balance + currency + as-of rate + date،
 *    والسعر يُحل عبر resolveRate (قرار 3: بلا سعر لليوم → MissingRateError
 *    يفتح إدخال السعر ولا يُحفظ أبداً بسعر 1) — قرار 7: لا إعادة تقييم لاحقاً.
 *  - **الحذف ممنوع لأي طرف له حركات** (فواتير/نقدية/أقساط/شيكات) — البديل
 *    الأرشفة (FR-03-09): «أرشفه بدلاً من الحذف».
 *  - الأرشفة مسموحة دائماً (هي البديل الآمن) — تحجب فقط عند التكرار.
 *
 * نقاء الوحدة: adapter + decimal.js + zod + وحدات شقيقة (NFR-09/11).
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { d, f4, isDecimalString } from '../utils/money';
import { todayISO } from '../utils/format';
import { resolveRate } from './currency';
import { DomainRuleError, ValidationError } from './errors';

/* ============================ المخططات (زود) ============================ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DecNonNeg = (msg: string) =>
  z
    .string()
    .refine((s) => isDecimalString(s) && d(s).gte(0), { message: msg });

/**
 * حد الائتمان — ثلاثي الحالات (FR-03-01): undefined = إبقاء/بلا حد،
 * null/"" = بلا حد (NULL)، "0" = منع الآجل كلياً، قيمة = حد فوري.
 */
const CreditLimitSchema = z
  .union([z.string(), z.null()])
  .optional()
  .refine(
    (v) => v === undefined || v === null || v === '' || (isDecimalString(v) && d(v).gte(0)),
    { message: 'حد الائتمان: قيمة غير سالبة، أو 0 لمنع الآجل، أو فراغ لبلا حد' },
  );

export const CustomerInputSchema = z.object({
  name: z.string().trim().min(1, 'اسم العميل مطلوب'),
  phone: z.string().trim().optional(),
  whatsapp: z.string().trim().optional(),
  address: z.string().optional(),
  area: z.string().optional(),
  creditLimit: CreditLimitSchema,
  openingBalance: DecNonNeg('الرصيد الافتتاحي يجب أن يكون رقماً غير سالب').optional(),
  openingCurrencyId: z.number().int().positive().optional(),
  openingDate: z
    .string()
    .regex(ISO_DATE, 'تاريخ الرصيد الافتتاحي غير صالح (YYYY-MM-DD)')
    .optional(),
  notes: z.string().optional(),
});

export type CustomerInput = z.input<typeof CustomerInputSchema>;

export const SupplierInputSchema = z.object({
  name: z.string().trim().min(1, 'اسم المورد مطلوب'),
  phone: z.string().trim().optional(),
  address: z.string().optional(),
  openingBalance: DecNonNeg('الرصيد الافتتاحي يجب أن يكون رقماً غير سالب').optional(),
  openingCurrencyId: z.number().int().positive().optional(),
  openingDate: z
    .string()
    .regex(ISO_DATE, 'تاريخ الرصيد الافتتاحي غير صالح (YYYY-MM-DD)')
    .optional(),
  notes: z.string().optional(),
});

export type SupplierInput = z.input<typeof SupplierInputSchema>;

/* ============================ الأنواع العامة ============================ */

export interface PartyRow {
  id: number;
  name: string;
  phone: string | null;
  whatsapp?: string | null;
  address: string | null;
  area?: string | null;
  /** NULL = بلا حد؛ "0.0000" = منع الآجل؛ غيرها = حد (FR-03-01) */
  creditLimit: string | null;
  openingBalance: string;
  openingCurrencyId: number | null;
  openingRate: string | null;
  openingDate: string | null;
  notes: string | null;
  isArchived: boolean;
}

function parseOr<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `تحقّق من حقول ${label} — بعض القيم ناقصة أو غير صالحة`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/* ============================ العملاء ============================ */

/** يحل سعر الرصيد الافتتاحي: الأساس = 1؛ غيرها سعر يوم الرصيد أو MissingRateError */
async function resolveOpening(
  adapter: SqliteAdapter,
  openingBalance: string | undefined,
  openingCurrencyId: number | undefined,
  openingDate: string | undefined,
): Promise<{ amount: string; currencyId: number | null; rate: string | null; date: string | null }> {
  if (openingBalance === undefined || d(openingBalance).isZero()) {
    return { amount: '0.0000', currencyId: null, rate: null, date: null };
  }
  const baseRows = await adapter.all<{ id: number }>('SELECT id FROM currency WHERE is_base = 1');
  if (!baseRows[0]) {
    throw new DomainRuleError(
      'NO_BASE_CURRENCY',
      'لا توجد عملة أساسية بعد — أكمل التهيئة الأولى قبل إضافة الأطراف',
    );
  }
  const currencyId = openingCurrencyId ?? Number(baseRows[0].id);
  const date = openingDate ?? todayISO();
  const { rate } = await resolveRate(adapter, currencyId, date);
  return { amount: f4(openingBalance), currencyId, rate, date };
}

export async function createCustomer(
  adapter: SqliteAdapter,
  input: CustomerInput,
): Promise<{ id: number }> {
  const data = parseOr(CustomerInputSchema, input, 'العميل');
  return adapter.transaction(async () => {
    const opening = await resolveOpening(
      adapter,
      data.openingBalance,
      data.openingCurrencyId,
      data.openingDate,
    );
    const now = new Date().toISOString();
    const inserted = await adapter.all<{ id: number }>(
      `INSERT INTO customer
         (name, phone, whatsapp, address, area, credit_limit,
          opening_balance, opening_balance_currency_id, opening_balance_rate, opening_balance_date,
          notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        data.name,
        data.phone || null,
        data.whatsapp || null,
        data.address || null,
        data.area || null,
        normalizeCreditLimit(data.creditLimit, null),
        opening.amount,
        opening.currencyId,
        opening.rate,
        opening.date,
        data.notes || null,
        now,
        now,
      ],
    );
    return { id: Number(inserted[0]!.id) };
  });
}

/**
 * يعدّل عميلاً (patch): creditLimit undefined = إبقاء الحالي، null/"" = بلا حد،
 * "0"/قيمة = تحديث. الرصيد الافتتاحي يُعاد حلُّ سعره إن أُرسل فقط.
 */
export async function updateCustomer(
  adapter: SqliteAdapter,
  id: number,
  input: CustomerInput,
): Promise<void> {
  const data = parseOr(CustomerInputSchema, input, 'العميل');
  await adapter.transaction(async () => {
    const rows = await adapter.all<{
      name: string;
      phone: string | null;
      whatsapp: string | null;
      address: string | null;
      area: string | null;
      credit_limit: string | null;
      notes: string | null;
      opening_balance: string;
      opening_balance_currency_id: number | null;
      opening_balance_rate: string | null;
      opening_balance_date: string | null;
    }>(
      'SELECT name, phone, whatsapp, address, area, credit_limit, notes, opening_balance, opening_balance_currency_id, opening_balance_rate, opening_balance_date FROM customer WHERE id = ?',
      [id],
    );
    const cur = rows[0];
    if (!cur) {
      throw new DomainRuleError('CUSTOMER_NOT_FOUND', `عميل غير موجود (معرّف ${id})`);
    }
    const opening =
      data.openingBalance === undefined
        ? {
            amount: cur.opening_balance,
            currencyId: cur.opening_balance_currency_id,
            rate: cur.opening_balance_rate,
            date: cur.opening_balance_date,
          }
        : await resolveOpening(
            adapter,
            data.openingBalance,
            data.openingCurrencyId,
            data.openingDate,
          );
    await adapter.run(
      `UPDATE customer SET name = ?, phone = ?, whatsapp = ?, address = ?, area = ?,
         credit_limit = ?, opening_balance = ?, opening_balance_currency_id = ?,
         opening_balance_rate = ?, opening_balance_date = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      [
        data.name,
        optStr(data.phone, cur.phone),
        optStr(data.whatsapp, cur.whatsapp),
        optStr(data.address, cur.address),
        optStr(data.area, cur.area),
        normalizeCreditLimit(data.creditLimit, cur.credit_limit),
        opening.amount,
        opening.currencyId,
        opening.rate,
        opening.date,
        optStr(data.notes, cur.notes),
        new Date().toISOString(),
        id,
      ],
    );
  });
}

/** أرشفة عميل — البديل الآمن لمن له حركات (FR-03-09) */
export async function archiveCustomer(adapter: SqliteAdapter, id: number): Promise<void> {
  const rows = await adapter.all<{ is_archived: number }>(
    'SELECT is_archived FROM customer WHERE id = ?',
    [id],
  );
  if (!rows[0]) {
    throw new DomainRuleError('CUSTOMER_NOT_FOUND', `عميل غير موجود (معرّف ${id})`);
  }
  if (Number(rows[0].is_archived) === 1) {
    throw new DomainRuleError('ALREADY_ARCHIVED', 'العميل مؤرشف مسبقاً');
  }
  await adapter.run('UPDATE customer SET is_archived = 1, updated_at = ? WHERE id = ?', [
    new Date().toISOString(),
    id,
  ]);
}

/** هل للطرف أي حركة؟ (فواتير/نقدية/خطط أقساط/شيكات) */
async function customerHasRefs(adapter: SqliteAdapter, id: number): Promise<boolean> {
  const [inv, cash, plans, chq] = await Promise.all([
    adapter.all<{ c: number }>('SELECT COUNT(*) AS c FROM invoice WHERE customer_id = ?', [id]),
    adapter.all<{ c: number }>('SELECT COUNT(*) AS c FROM cash_tx WHERE customer_id = ?', [id]),
    adapter.all<{ c: number }>('SELECT COUNT(*) AS c FROM installment_plan WHERE customer_id = ?', [
      id,
    ]),
    adapter.all<{ c: number }>(
      "SELECT COUNT(*) AS c FROM cheque WHERE party_type = 'customer' AND party_id = ?",
      [id],
    ),
  ]);
  return (
    Number(inv[0]?.c ?? 0) > 0 ||
    Number(cash[0]?.c ?? 0) > 0 ||
    Number(plans[0]?.c ?? 0) > 0 ||
    Number(chq[0]?.c ?? 0) > 0
  );
}

/** حذف عميل — فقط بلا أي حركة؛ ما سواه أرشفة (FR-03-09) */
export async function deleteCustomer(adapter: SqliteAdapter, id: number): Promise<void> {
  await adapter.transaction(async () => {
    const rows = await adapter.all<{ id: number }>('SELECT id FROM customer WHERE id = ?', [id]);
    if (!rows[0]) {
      throw new DomainRuleError('CUSTOMER_NOT_FOUND', `عميل غير موجود (معرّف ${id})`);
    }
    if (await customerHasRefs(adapter, id)) {
      throw new DomainRuleError(
        'CUSTOMER_HAS_MOVEMENTS',
        'لا يمكن حذف عميل له حركات (فواتير/نقدية/أقساط/شيكات) — أرشفه بدلاً من الحذف',
      );
    }
    await adapter.run('DELETE FROM customer WHERE id = ?', [id]);
  });
}

export async function getCustomer(
  adapter: SqliteAdapter,
  id: number,
): Promise<PartyRow | null> {
  const rows = await adapter.all<{
    id: number;
    name: string;
    phone: string | null;
    whatsapp: string | null;
    address: string | null;
    area: string | null;
    credit_limit: string | null;
    opening_balance: string;
    opening_balance_currency_id: number | null;
    opening_balance_rate: string | null;
    opening_balance_date: string | null;
    notes: string | null;
    is_archived: number;
  }>(
    `SELECT id, name, phone, whatsapp, address, area, credit_limit,
            opening_balance, opening_balance_currency_id, opening_balance_rate, opening_balance_date,
            notes, is_archived
     FROM customer WHERE id = ?`,
    [id],
  );
  const r = rows[0];
  return r ? mapParty(r) : null;
}

export interface ListPartiesOptions {
  search?: string;
  onlyActive?: boolean;
  limit?: number;
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** قائمة عملاء للشاشات: بحث بالاسم/الهاتف، ترتيب بالاسم، سقف 100 */
export async function listCustomers(
  adapter: SqliteAdapter,
  opts: ListPartiesOptions = {},
): Promise<PartyRow[]> {
  const onlyActive = opts.onlyActive ?? true;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const search = (opts.search ?? '').trim();
  const where: string[] = [];
  const params: unknown[] = [];
  if (onlyActive) where.push('is_archived = 0');
  if (search !== '') {
    where.push("(name LIKE ? ESCAPE '\\' OR (phone IS NOT NULL AND phone LIKE ? ESCAPE '\\'))");
    const like = `%${escapeLike(search)}%`;
    params.push(like, like);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = await adapter.all<Record<string, unknown>>(
    `SELECT id, name, phone, whatsapp, address, area, credit_limit,
            opening_balance, opening_balance_currency_id, opening_balance_rate, opening_balance_date,
            notes, is_archived
     FROM customer${whereSql} ORDER BY name LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => mapParty(r));
}

/* ============================ الموردون ============================ */

export async function createSupplier(
  adapter: SqliteAdapter,
  input: SupplierInput,
): Promise<{ id: number }> {
  const data = parseOr(SupplierInputSchema, input, 'المورد');
  return adapter.transaction(async () => {
    // موجب = دائن (مستحق للمورد) — يُخزَّن بنفس أعمدة العميل بدلالة معاكسة
    const opening = await resolveOpening(
      adapter,
      data.openingBalance,
      data.openingCurrencyId,
      data.openingDate,
    );
    const now = new Date().toISOString();
    const inserted = await adapter.all<{ id: number }>(
      `INSERT INTO supplier
         (name, phone, address, opening_balance, opening_balance_currency_id,
          opening_balance_rate, opening_balance_date, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        data.name,
        data.phone || null,
        data.address || null,
        opening.amount,
        opening.currencyId,
        opening.rate,
        opening.date,
        data.notes || null,
        now,
        now,
      ],
    );
    return { id: Number(inserted[0]!.id) };
  });
}

export async function updateSupplier(
  adapter: SqliteAdapter,
  id: number,
  input: SupplierInput,
): Promise<void> {
  const data = parseOr(SupplierInputSchema, input, 'المورد');
  await adapter.transaction(async () => {
    const rows = await adapter.all<{
      name: string;
      phone: string | null;
      address: string | null;
      notes: string | null;
      opening_balance: string;
      opening_balance_currency_id: number | null;
      opening_balance_rate: string | null;
      opening_balance_date: string | null;
    }>(
      'SELECT name, phone, address, notes, opening_balance, opening_balance_currency_id, opening_balance_rate, opening_balance_date FROM supplier WHERE id = ?',
      [id],
    );
    const cur = rows[0];
    if (!cur) {
      throw new DomainRuleError('SUPPLIER_NOT_FOUND', `مورد غير موجود (معرّف ${id})`);
    }
    const opening =
      data.openingBalance === undefined
        ? {
            amount: cur.opening_balance,
            currencyId: cur.opening_balance_currency_id,
            rate: cur.opening_balance_rate,
            date: cur.opening_balance_date,
          }
        : await resolveOpening(
            adapter,
            data.openingBalance,
            data.openingCurrencyId,
            data.openingDate,
          );
    await adapter.run(
      `UPDATE supplier SET name = ?, phone = ?, address = ?, opening_balance = ?,
         opening_balance_currency_id = ?, opening_balance_rate = ?, opening_balance_date = ?,
         notes = ?, updated_at = ?
       WHERE id = ?`,
      [
        data.name,
        optStr(data.phone, cur.phone),
        optStr(data.address, cur.address),
        opening.amount,
        opening.currencyId,
        opening.rate,
        opening.date,
        optStr(data.notes, cur.notes),
        new Date().toISOString(),
        id,
      ],
    );
  });
}

export async function archiveSupplier(adapter: SqliteAdapter, id: number): Promise<void> {
  const rows = await adapter.all<{ is_archived: number }>(
    'SELECT is_archived FROM supplier WHERE id = ?',
    [id],
  );
  if (!rows[0]) {
    throw new DomainRuleError('SUPPLIER_NOT_FOUND', `مورد غير موجود (معرّف ${id})`);
  }
  if (Number(rows[0].is_archived) === 1) {
    throw new DomainRuleError('ALREADY_ARCHIVED', 'المورد مؤرشف مسبقاً');
  }
  await adapter.run('UPDATE supplier SET is_archived = 1, updated_at = ? WHERE id = ?', [
    new Date().toISOString(),
    id,
  ]);
}

async function supplierHasRefs(adapter: SqliteAdapter, id: number): Promise<boolean> {
  const [inv, cash, chq] = await Promise.all([
    adapter.all<{ c: number }>('SELECT COUNT(*) AS c FROM invoice WHERE supplier_id = ?', [id]),
    adapter.all<{ c: number }>('SELECT COUNT(*) AS c FROM cash_tx WHERE supplier_id = ?', [id]),
    adapter.all<{ c: number }>(
      "SELECT COUNT(*) AS c FROM cheque WHERE party_type = 'supplier' AND party_id = ?",
      [id],
    ),
  ]);
  return (
    Number(inv[0]?.c ?? 0) > 0 || Number(cash[0]?.c ?? 0) > 0 || Number(chq[0]?.c ?? 0) > 0
  );
}

export async function deleteSupplier(adapter: SqliteAdapter, id: number): Promise<void> {
  await adapter.transaction(async () => {
    const rows = await adapter.all<{ id: number }>('SELECT id FROM supplier WHERE id = ?', [id]);
    if (!rows[0]) {
      throw new DomainRuleError('SUPPLIER_NOT_FOUND', `مورد غير موجود (معرّف ${id})`);
    }
    if (await supplierHasRefs(adapter, id)) {
      throw new DomainRuleError(
        'SUPPLIER_HAS_MOVEMENTS',
        'لا يمكن حذف مورد له حركات (فواتير/نقدية/شيكات) — أرشفه بدلاً من الحذف',
      );
    }
    await adapter.run('DELETE FROM supplier WHERE id = ?', [id]);
  });
}

export async function getSupplier(
  adapter: SqliteAdapter,
  id: number,
): Promise<PartyRow | null> {
  const rows = await adapter.all<Record<string, unknown>>(
    `SELECT id, name, phone, address, opening_balance, opening_balance_currency_id,
            opening_balance_rate, opening_balance_date, notes, is_archived
     FROM supplier WHERE id = ?`,
    [id],
  );
  const r = rows[0];
  return r ? mapParty(r) : null;
}

export async function listSuppliers(
  adapter: SqliteAdapter,
  opts: ListPartiesOptions = {},
): Promise<PartyRow[]> {
  const onlyActive = opts.onlyActive ?? true;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const search = (opts.search ?? '').trim();
  const where: string[] = [];
  const params: unknown[] = [];
  if (onlyActive) where.push('is_archived = 0');
  if (search !== '') {
    where.push("(name LIKE ? ESCAPE '\\' OR (phone IS NOT NULL AND phone LIKE ? ESCAPE '\\'))");
    const like = `%${escapeLike(search)}%`;
    params.push(like, like);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = await adapter.all<Record<string, unknown>>(
    `SELECT id, name, phone, address, opening_balance, opening_balance_currency_id,
            opening_balance_rate, opening_balance_date, notes, is_archived
     FROM supplier${whereSql} ORDER BY name LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => mapParty(r));
}

/* ============================ مساعدات ============================ */

/**
 * يحوّل المدخل ثلاثي الحالات إلى قيمة التخزين:
 * undefined → keep (قيمة القاعدة الحالية)، null/"" → NULL (بلا حد)، غيرها → f4.
 */
function normalizeCreditLimit(
  input: string | null | undefined,
  keep: string | null,
): string | null {
  if (input === undefined) return keep;
  if (input === null || input === '') return null;
  return f4(input);
}

/** نص اختياري: undefined = إبقاء الحالي، "" = مسح (NULL)، غيره = القيمة */
function optStr(input: string | undefined, keep: string | null): string | null {
  if (input === undefined) return keep;
  return input === '' ? null : input;
}

type PartyRaw = {
  id: number | unknown;
  name: unknown;
  phone: unknown;
  whatsapp?: unknown;
  address: unknown;
  area?: unknown;
  credit_limit?: unknown;
  opening_balance: unknown;
  opening_balance_currency_id: unknown;
  opening_balance_rate: unknown;
  opening_balance_date: unknown;
  notes: unknown;
  is_archived: unknown;
};

function mapParty(input: Record<string, unknown>): PartyRow {
  const r = input as PartyRaw;
  return {
    id: Number(r.id),
    name: String(r.name),
    phone: (r.phone as string | null) ?? null,
    whatsapp: (r.whatsapp as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    area: (r.area as string | null) ?? null,
    creditLimit: (r.credit_limit as string | null) ?? null,
    openingBalance: (r.opening_balance as string) ?? '0',
    openingCurrencyId:
      r.opening_balance_currency_id === null || r.opening_balance_currency_id === undefined
        ? null
        : Number(r.opening_balance_currency_id),
    openingRate: (r.opening_balance_rate as string | null) ?? null,
    openingDate: (r.opening_balance_date as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    isArchived: Number(r.is_archived ?? 0) === 1,
  };
}
