/**
 * settings.ts — قارئ/كاتب سجل الإعدادات (SRS ملحق هـ + FR-13-09).
 *
 * القاعدة: كل سلوك قابل للضبط له مفتاح في السجل، والقيمة JSON مُتحققة بـ zod.
 * القراءة: صف مفقود أو JSON غير صالح → القيمة الافتراضية (التطبيق لا يتعطل أبداً
 * بسبب إعداد تالف — سلوك دفاعي موثق).
 *
 * مفاتيح هذه الوحدة (القيم الافتراضية حرفياً من ملحق هـ):
 *  - fx.fallback                : 'off' | 'last_known'                      (افتراضي off)
 *  - dating.max_backdate_days   : 1–365                                    (افتراضي 30)
 *  - invoicing.tax_mode         : 'per_item' | 'on_total'                  (افتراضي on_total)
 *  - invoicing.discount_below_margin : 'off' | 'warn' | 'block'             (افتراضي off)
 *  - sale.over_avail_policy     : 'warn' | 'add_available'                 (افتراضي warn)
 *  - inventory.min_stock_alert  : 'on' | 'off'                             (افتراضي on)
 *
 * ملاحظة (Task 15): مفتاح inventory.min_stock_alert أُضيف إلى السجل لأنه
 * من مفاتيح ملحق هـ الملزمة — قراءته في بطاقة تنبيهات الداشبورد متابعة
 * لاحقة (لا نعرض مفتاح تبديل في الواجهة قبل أن يقرأه الداشبورد فعلاً —
 * لا مفاتيح وهمية).
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { DomainRuleError, ValidationError } from './errors';

/** يقرأ مفتاح إعداد ويتحقق بمخطط زود — المفقود/التالف → القيمة الافتراضية */
export async function getSetting<T>(
  adapter: SqliteAdapter,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<T> {
  const rows = await adapter.all<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
    key,
  ]);
  const row = rows[0];
  if (!row) return fallback;
  try {
    return schema.parse(JSON.parse(row.value));
  } catch {
    // قيمة تالفة → الافتراضي (دفاعية) — التطبيق لا يتعطل بسبب إعداد
    return fallback;
  }
}

/** مخططات المفاتيح المعروفة (ملحق هـ) — مرجع التحقق عند الكتابة */
const REGISTRY: Record<string, z.ZodType> = {
  'fx.fallback': z.enum(['off', 'last_known']),
  'inventory.min_stock_alert': z.enum(['on', 'off']),
  'dating.max_backdate_days': z.number().int().min(1).max(365),
  'invoicing.tax_mode': z.enum(['per_item', 'on_total']),
  'invoicing.discount_below_margin': z.enum(['off', 'warn', 'block']),
  'invoicing.print_on_save': z.enum(['print', 'no', 'ask']),
  'invoicing.payment_sheet': z.enum(['on', 'off']),
  'sale.over_avail_policy': z.enum(['warn', 'add_available']),
  'parties.credit_limit_action': z.enum(['warn', 'block']),
  'fx.daily_reminder': z.enum(['on', 'off']),
  'display.numerals': z.enum(['western', 'arabic_indic']),
  'ui.high_contrast': z.enum(['on', 'off']),
  'backup.schedule': z.enum(['daily', 'weekly', 'off']),
  'backup.retention_count': z.number().int().min(1).max(30),
  'security.autolock_minutes': z.number().int().min(1).max(60),
};

/** يكتب مفتاح إعداد (Upsert) بعد التحقق بمخطط المفتاح من السجل + قيد audit */
export async function setSetting(
  adapter: SqliteAdapter,
  key: string,
  value: unknown,
): Promise<void> {
  const schema = REGISTRY[key];
  if (!schema) {
    throw new DomainRuleError(
      'UNKNOWN_SETTING_KEY',
      `مفتاح إعداد غير معروف (${key}) — أضِفه أولاً إلى سجل الإعدادات (ملحق هـ)`,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(
      `قيمة غير صالحة لمفتاح الإعداد «${key}» — استخدِم قيمة من القيم المسموحة في سجل الإعدادات`,
      parsed.error.issues,
    );
  }
  await adapter.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(parsed.data), new Date().toISOString()],
  );
  // قيد audit (Task 15): كل تغيير إعداد يُسجَّل — user_id NULL (لا سياق مستخدم
  // في طبقة Domain) والـ FK يقبلها. audit_log append-only عبر تريغرات الهجرة.
  await adapter.run(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details, at) VALUES (NULL, ?, ?, NULL, ?, ?)',
    ['settings_change', 'settings', JSON.stringify({ key, value: parsed.data }), new Date().toISOString()],
  );
}

/* ============ مساعدات مطبوعة لمفاتيح هذه الوحدة ============ */

export interface FxPolicy {
  fallback: 'off' | 'last_known';
}

/** سياسة سعر الصرف المفقود (قرار 3) — الافتراضي: off */
export async function getFxPolicy(adapter: SqliteAdapter): Promise<FxPolicy> {
  const fallback = await getSetting(
    adapter,
    'fx.fallback',
    z.enum(['off', 'last_known']),
    'off' as const,
  );
  return { fallback };
}

export interface DatingPolicy {
  maxBackdateDays: number;
}

/** حد التأريخ الرجعي بلا تأكيد مدير — الافتراضي: 30 يوماً (ملحق هـ) */
export async function getDatingPolicy(adapter: SqliteAdapter): Promise<DatingPolicy> {
  const maxBackdateDays = await getSetting(
    adapter,
    'dating.max_backdate_days',
    z.number().int().min(1).max(365),
    30,
  );
  return { maxBackdateDays };
}

export interface InvoicingSettings {
  taxMode: 'per_item' | 'on_total';
  discountBelowMargin: 'off' | 'warn' | 'block';
}

/** إعدادات الفوترة — tax_mode الافتراضي on_total وdiscount_below_margin الافتراضي off */
export async function getInvoicingSettings(adapter: SqliteAdapter): Promise<InvoicingSettings> {
  const taxMode = await getSetting(
    adapter,
    'invoicing.tax_mode',
    z.enum(['per_item', 'on_total']),
    'on_total' as const,
  );
  const discountBelowMargin = await getSetting(
    adapter,
    'invoicing.discount_below_margin',
    z.enum(['off', 'warn', 'block']),
    'off' as const,
  );
  return { taxMode, discountBelowMargin };
}

export interface SalePolicy {
  overAvailPolicy: 'warn' | 'add_available';
}

/** سلوك تجاوز الكمية المتاحة في البيع — الافتراضي: warn (تحذير لحظي فقط) */
export async function getSalePolicy(adapter: SqliteAdapter): Promise<SalePolicy> {
  const overAvailPolicy = await getSetting(
    adapter,
    'sale.over_avail_policy',
    z.enum(['warn', 'add_available']),
    'warn' as const,
  );
  return { overAvailPolicy };
}

export interface SecuritySettings {
  /** دقائق الخمول قبل القفل التلقائي (FR-12-05 — الافتراضي 5) */
  autolockMinutes: number;
}

/** إعدادات الأمان — autolock_minutes من ملحق هـ (1–60، افتراضي 5) */
export async function getSecuritySettings(
  adapter: SqliteAdapter,
): Promise<SecuritySettings> {
  const autolockMinutes = await getSetting(
    adapter,
    'security.autolock_minutes',
    z.number().int().min(1).max(60),
    5,
  );
  return { autolockMinutes };
}
