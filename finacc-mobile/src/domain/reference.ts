/**
 * reference.ts — البيانات المرجعية (FR-13-06): فئات المصاريف والوحدات والمخازن
 * والصناديق والعملات. CRUD خفيف محميّ بالحركات:
 *  - لا حذف فيزيائي أبداً — التعطيل (is_archived/is_active) يخفي من قوائم
 *    الاختيار الجديدة وتبقى الحركات القديمة موثّقة.
 *  - العنصر المستخدم في حركات لا يُعطَّل (رسالة صادقة «مستخدمة في حركات»).
 *  - الصندوق/المخزن الافتريان والعملة الأساسية محصّنون (FR-13-01/قرار 8).
 *  - المخازن: إعادة تسمية فقط في V1 (بلا إنشاء — المخزن مفهوم جرد فعلي).
 * كل تعديل بقيد audit (ref_create/ref_rename/ref_archive/ref_activate).
 */
import type { SqliteAdapter } from '../db/adapter';
import { DomainRuleError, ValidationError } from './errors';

/* ============================ مشتركات ============================ */

async function audit(
  adapter: SqliteAdapter,
  action: string,
  entity: string,
  entityId: number,
  details: Record<string, unknown>,
): Promise<void> {
  await adapter.run(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details, at) VALUES (?, ?, ?, ?, ?, ?)',
    [null, action, entity, entityId, JSON.stringify(details), new Date().toISOString()],
  );
}

function requireName(name: string, what = 'الاسم'): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 60) {
    throw new ValidationError(`${what} مطلوب (حتى 60 حرفاً)`);
  }
  return trimmed;
}

async function countRows(
  adapter: SqliteAdapter,
  sql: string,
  params: unknown[],
): Promise<number> {
  const rows = await adapter.all<{ c: number | string }>(sql, params);
  return Number(rows[0]?.c ?? 0);
}

const now = (): string => new Date().toISOString();

/* ============================ فئات المصاريف ============================ */

export interface ExpenseCategoryRow {
  id: number;
  name: string;
  isArchived: boolean;
}

export async function listExpenseCategories(
  adapter: SqliteAdapter,
): Promise<ExpenseCategoryRow[]> {
  const rows = await adapter.all<{ id: number; name: string; is_archived: number }>(
    'SELECT id, name, is_archived FROM expense_category ORDER BY is_archived, id',
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, isArchived: Number(r.is_archived) === 1 }));
}

export async function createExpenseCategory(
  adapter: SqliteAdapter,
  name: string,
): Promise<{ id: number }> {
  const clean = requireName(name);
  const dup = await adapter.all<{ id: number }>(
    'SELECT id FROM expense_category WHERE name = ? COLLATE NOCASE',
    [clean],
  );
  if (dup.length > 0) throw new DomainRuleError('EXPENSE_CAT_DUP_NAME', 'توجد فئة مصاريف بنفس الاسم بالفعل');
  const res = await adapter.all<{ id: number }>(
    'INSERT INTO expense_category (name, is_archived, created_at, updated_at) VALUES (?, 0, ?, ?) RETURNING id',
    [clean, now(), now()],
  );
  const id = Number(res[0]!.id);
  await audit(adapter, 'ref_create', 'expense_category', id, { name: clean });
  return { id };
}

export async function renameExpenseCategory(
  adapter: SqliteAdapter,
  id: number,
  newName: string,
): Promise<void> {
  const clean = requireName(newName);
  await adapter.run('UPDATE expense_category SET name = ?, updated_at = ? WHERE id = ?', [
    clean,
    now(),
    id,
  ]);
  await audit(adapter, 'ref_rename', 'expense_category', id, { newName: clean });
}

export async function archiveExpenseCategory(adapter: SqliteAdapter, id: number): Promise<void> {
  const used = await countRows(
    adapter,
    'SELECT COUNT(*) AS c FROM cash_tx WHERE expense_category_id = ?',
    [id],
  );
  if (used > 0) throw new DomainRuleError('EXPENSE_CAT_IN_USE', 'الفئة مستخدمة في حركات مصاريف — لا تُعطَّل');
  await adapter.run('UPDATE expense_category SET is_archived = 1, updated_at = ? WHERE id = ?', [
    now(),
    id,
  ]);
  await audit(adapter, 'ref_archive', 'expense_category', id, {});
}

/* ============================ وحدات القياس ============================ */

export interface UnitRow {
  id: number;
  name: string;
  factor: string;
  isArchived: boolean;
}

export async function listUnitsDetailed(adapter: SqliteAdapter): Promise<UnitRow[]> {
  const rows = await adapter.all<{
    id: number;
    name: string;
    factor: string | null;
    is_archived: number;
  }>('SELECT id, name, factor, is_archived FROM unit ORDER BY is_archived, id');
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    factor: r.factor ?? '1',
    isArchived: Number(r.is_archived) === 1,
  }));
}

export async function renameUnit(adapter: SqliteAdapter, id: number, newName: string): Promise<void> {
  const clean = requireName(newName);
  await adapter.run('UPDATE unit SET name = ?, updated_at = ? WHERE id = ?', [clean, now(), id]);
  await audit(adapter, 'ref_rename', 'unit', id, { newName: clean });
}

export async function archiveUnit(adapter: SqliteAdapter, id: number): Promise<void> {
  const products = await countRows(adapter, 'SELECT COUNT(*) AS c FROM product WHERE unit_id = ?', [
    id,
  ]);
  const items = await countRows(
    adapter,
    'SELECT COUNT(*) AS c FROM invoice_item WHERE unit_id = ?',
    [id],
  );
  if (products + items > 0) {
    throw new DomainRuleError('UNIT_IN_USE', 'الوحدة مستخدمة في أصناف أو بنود فواتير — لا تُعطَّل');
  }
  await adapter.run('UPDATE unit SET is_archived = 1, updated_at = ? WHERE id = ?', [now(), id]);
  await audit(adapter, 'ref_archive', 'unit', id, {});
}

/* ============================ المخازن ============================ */

export interface WarehouseRow {
  id: number;
  name: string;
  location: string | null;
  isDefault: boolean;
  isArchived: boolean;
}

export async function listWarehousesDetailed(adapter: SqliteAdapter): Promise<WarehouseRow[]> {
  const rows = await adapter.all<{
    id: number;
    name: string;
    location: string | null;
    is_default: number;
    is_archived: number;
  }>('SELECT id, name, location, is_default, is_archived FROM warehouse ORDER BY is_archived, id');
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    location: r.location,
    isDefault: Number(r.is_default) === 1,
    isArchived: Number(r.is_archived) === 1,
  }));
}

/** المخازن: إعادة تسمية فقط (آمنة مع الحركات — بلا أي حذف أو تعطيل في V1) */
export async function renameWarehouse(
  adapter: SqliteAdapter,
  id: number,
  newName: string,
): Promise<void> {
  const clean = requireName(newName);
  await adapter.run('UPDATE warehouse SET name = ?, updated_at = ? WHERE id = ?', [clean, now(), id]);
  await audit(adapter, 'ref_rename', 'warehouse', id, { newName: clean });
}

/* ============================ الصناديق ============================ */

export interface CashboxRow {
  id: number;
  name: string;
  currencyCode: string;
  isDefault: boolean;
  isArchived: boolean;
}

export async function listCashboxesDetailed(adapter: SqliteAdapter): Promise<CashboxRow[]> {
  const rows = await adapter.all<{
    id: number;
    name: string;
    code: string;
    is_default: number;
    is_archived: number;
  }>(
    `SELECT cb.id, cb.name, cur.code, cb.is_default, cb.is_archived
     FROM cashbox cb JOIN currency cur ON cur.id = cb.currency_id
     ORDER BY cb.is_archived, cb.id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    currencyCode: r.code,
    isDefault: Number(r.is_default) === 1,
    isArchived: Number(r.is_archived) === 1,
  }));
}

export async function createCashbox(
  adapter: SqliteAdapter,
  input: { name: string; currencyId: number },
): Promise<{ id: number }> {
  const clean = requireName(input.name);
  const cur = await adapter.all<{ id: number }>(
    'SELECT id FROM currency WHERE id = ? AND is_active = 1',
    [input.currencyId],
  );
  if (cur.length === 0) throw new DomainRuleError('CURRENCY_NOT_FOUND', 'عملة الصندوق غير موجودة أو غير مفعّلة');
  const res = await adapter.all<{ id: number }>(
    `INSERT INTO cashbox (name, currency_id, is_default, is_archived, created_at, updated_at)
     VALUES (?, ?, 0, 0, ?, ?) RETURNING id`,
    [clean, input.currencyId, now(), now()],
  );
  const id = Number(res[0]!.id);
  await audit(adapter, 'ref_create', 'cashbox', id, { name: clean, currencyId: input.currencyId });
  return { id };
}

export async function renameCashbox(
  adapter: SqliteAdapter,
  id: number,
  newName: string,
): Promise<void> {
  const clean = requireName(newName);
  await adapter.run('UPDATE cashbox SET name = ?, updated_at = ? WHERE id = ?', [clean, now(), id]);
  await audit(adapter, 'ref_rename', 'cashbox', id, { newName: clean });
}

export async function archiveCashbox(adapter: SqliteAdapter, id: number): Promise<void> {
  const def = await adapter.all<{ is_default: number }>('SELECT is_default FROM cashbox WHERE id = ?', [
    id,
  ]);
  if (def.length === 0) throw new DomainRuleError('CASHBOX_NOT_FOUND', 'الصندوق غير موجود');
  if (Number(def[0]!.is_default) === 1) {
    throw new DomainRuleError('CASHBOX_DEFAULT', 'الصندوق الافتراضي مطلوب لكل حركة نقدية — لا يُعطَّل');
  }
  const used = await countRows(adapter, 'SELECT COUNT(*) AS c FROM cash_tx WHERE cashbox_id = ?', [
    id,
  ]);
  if (used > 0) throw new DomainRuleError('CASHBOX_IN_USE', 'الصندوق مستخدمة في حركات نقدية — لا يُعطَّل');
  await adapter.run('UPDATE cashbox SET is_archived = 1, updated_at = ? WHERE id = ?', [now(), id]);
  await audit(adapter, 'ref_archive', 'cashbox', id, {});
}

/* ============================ العملات ============================ */

export interface CurrencyRow {
  id: number;
  code: string;
  name: string;
  decimals: number;
  isBase: boolean;
  isActive: boolean;
}

export async function listCurrenciesDetailed(adapter: SqliteAdapter): Promise<CurrencyRow[]> {
  const rows = await adapter.all<{
    id: number;
    code: string;
    name: string;
    decimals: number;
    is_base: number;
    is_active: number;
  }>('SELECT id, code, name, decimals, is_base, is_active FROM currency ORDER BY id');
  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    decimals: Number(r.decimals),
    isBase: Number(r.is_base) === 1,
    isActive: Number(r.is_active) === 1,
  }));
}

export async function createCurrency(
  adapter: SqliteAdapter,
  input: { code: string; name: string; decimals: number },
): Promise<{ id: number }> {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new ValidationError('رمز العملة 3 أحرف لاتينية — مثل KWD');
  }
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) {
    throw new ValidationError('اسم العملة مطلوب (حتى 40 حرفاً)');
  }
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 4) {
    throw new ValidationError('عدد المنازل العشرية رقم من 0 إلى 4');
  }
  const base = await adapter.all<{ code: string }>('SELECT code FROM currency WHERE is_base = 1');
  if (base[0]?.code === code) {
    throw new DomainRuleError('CURRENCY_IS_BASE', 'العملة الأساسية عملة الحساب كلها — لا تُنشأ من جديد');
  }
  const dup = await adapter.all<{ id: number }>('SELECT id FROM currency WHERE code = ?', [code]);
  if (dup.length > 0) throw new DomainRuleError('CURRENCY_DUP_CODE', 'توجد عملة بهذا الرمز بالفعل');
  // العملة الجديدة غير أساسية دائماً — الأساس يُثبَّت في التهيئة (FR-13-01)
  const res = await adapter.all<{ id: number }>(
    `INSERT INTO currency (code, name, decimals, is_base, is_active) VALUES (?, ?, ?, 0, 1) RETURNING id`,
    [code, name, input.decimals],
  );
  const id = Number(res[0]!.id);
  await audit(adapter, 'ref_create', 'currency', id, { code, name });
  return { id };
}

export async function activateCurrency(adapter: SqliteAdapter, id: number): Promise<void> {
  await adapter.run('UPDATE currency SET is_active = 1 WHERE id = ?', [id]);
  await audit(adapter, 'ref_activate', 'currency', id, {});
}

export async function deactivateCurrency(adapter: SqliteAdapter, id: number): Promise<void> {
  const rows = await adapter.all<{ is_base: number }>('SELECT is_base FROM currency WHERE id = ?', [
    id,
  ]);
  if (rows.length === 0) throw new DomainRuleError('CURRENCY_NOT_FOUND', 'العملة غير موجودة');
  if (Number(rows[0]!.is_base) === 1) {
    throw new DomainRuleError('CURRENCY_IS_BASE', 'العملة الأساسية لا يُعطَّل — عملة الحساب كلها');
  }
  const rates = await countRows(
    adapter,
    'SELECT COUNT(*) AS c FROM exchange_rate WHERE currency_id = ?',
    [id],
  );
  if (rates > 0) throw new DomainRuleError('CURRENCY_IN_USE', 'العملة مستخدمة في حركات أو أسعار صرف — لا تُعطَّل');
  await adapter.run('UPDATE currency SET is_active = 0 WHERE id = ?', [id]);
  await audit(adapter, 'ref_archive', 'currency', id, {});
}
