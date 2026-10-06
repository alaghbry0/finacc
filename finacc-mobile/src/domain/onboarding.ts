/**
 * onboarding.ts — إعداد أول تشغيل (FR-13-01 / AC-24) + كشف حالة التهيئة.
 *
 * **القاعدة المفصلية**: خطوة ختامية واحدة تنشئ تلقائياً «المخزن الرئيسي»
 * و«الصندوق الرئيسي» بالعملة الأساسية — لأن invoice.warehouse_id NOT NULL
 * يجعل أول فاتورة تفشل بدونهما (نص FR-13-01 حرفياً).
 *
 * ما تنشئه المعاملة الواحدة (ذرّية — فشل أي صف يرجع الكل):
 *  1. أربع عملات (YER/SAR/USD/AED): المختارة is_base=1 + is_active=1؛
 *     الباقي غير مفعّل (يُفعّل عند أول سعر)؛ YER منازله 0 والباقي 2 (قرار 9 §5.4).
 *  2. company: العملة + الضريبة (افتراضي 0%) + البادئة + تذييل افتراضي.
 *  3. warehouse «المخزن الرئيسي» is_default=1 (قابل لإعادة التسمية لاحقاً).
 *  4. cashbox «الصندوق الرئيسي» بعملة الأساس is_default=1.
 *  5. unit «قطعة».
 *  6. فئات المصاريف: «رواتب» (إلزامية — FR-04-05) + «مصاريف عامة» + «إيجار»
 *     + «نقل ومواصلات».
 *  7. app_user: admin واحد (FR-12-01) بتجزئة PIN.
 *
 * نقاء الوحدة: adapter + zod + وحدات شقيقة + services/pin (نقي) — NFR-09/11.
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { d, f4, isDecimalString } from '../utils/money';
import { hashPin } from '../services/pin';
import { DomainRuleError, ValidationError } from './errors';

/* ============================ المخطط (زود) ============================ */

const Pct = (msg: string) =>
  z
    .string()
    .refine((s) => isDecimalString(s) && d(s).gte(0) && d(s).lte(100), { message: msg });

export const OnboardingInputSchema = z.object({
  companyName: z.string().trim().min(1, 'اسم المنشأة (اسم متجرك) مطلوب'),
  phone: z.string().trim().optional(),
  whatsapp: z.string().trim().optional(),
  address: z.string().optional(),
  baseCurrencyCode: z.enum(['YER', 'SAR', 'USD', 'AED'], {
    message: 'اختر العملة الأساسية من القائمة',
  }),
  taxRate: Pct('نسبة الضريبة بين 0 و100 — اتركها 0 إن لم تكن مسجّل ضريبياً').optional(),
  invoicePrefix: z
    .string()
    .trim()
    .regex(/^[A-Z]{2,6}$/, 'بادئة الترقيم: 2-6 أحرف لاتينية كبيرة (مثل INV)')
    .optional(),
  pin: z
    .string()
    .regex(/^\d{4,6}$/, 'رمز PIN يجب أن يكون من 4 إلى 6 أرقام'),
  displayName: z.string().trim().optional(),
});

export type OnboardingInput = z.input<typeof OnboardingInputSchema>;

/** بيانات العملات الأربع — منازل YER = 0 (قرار 9 §5.4: «decimals=0 افتراضياً لليمني») */
const CURRENCIES: { code: 'YER' | 'SAR' | 'USD' | 'AED'; name: string; decimals: number }[] = [
  { code: 'YER', name: 'ريال يمني', decimals: 0 },
  { code: 'SAR', name: 'ريال سعودي', decimals: 2 },
  { code: 'USD', name: 'دولار أمريكي', decimals: 2 },
  { code: 'AED', name: 'درهم إماراتي', decimals: 2 },
];

/** تذييل الفاتورة الافتراضي */
export const DEFAULT_INVOICE_FOOTER = 'شكراً لتعاملكم معنا';

export interface OnboardingResult {
  companyId: number;
  warehouseId: number;
  cashboxId: number;
  unitId: number;
  userId: number;
  baseCurrencyId: number;
}

/* ============================ الكشف ============================ */

/** هل اكتملت التهيئة؟ (وجود app_user = المدير الذي ينشئه Onboarding — FR-12-01) */
export async function isOnboarded(adapter: SqliteAdapter): Promise<boolean> {
  const rows = await adapter.all<{ c: number }>('SELECT COUNT(*) AS c FROM app_user');
  return Number(rows[0]?.c ?? 0) > 0;
}

/* ============================ التنفيذ ============================ */

/**
 * ينفّذ التهيئة كاملة داخل **معاملة واحدة** — يرفض التكرار:
 * «تم إعداد التطبيق مسبقاً» (إعادة التهيئة = مسح كامل أولاً بمسار FR-12-06).
 */
export async function completeOnboarding(
  adapter: SqliteAdapter,
  input: OnboardingInput,
): Promise<OnboardingResult> {
  const parsed = OnboardingInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      'تحقّق من خطوات التهيئة — بعض الحقول ناقصة أو غير صالحة',
      parsed.error.issues,
    );
  }
  const data = parsed.data;

  return adapter.transaction(async () => {
    // 0) الرفض المسبق — لا تهيئة مزدوجة أبداً
    if (await isOnboarded(adapter)) {
      throw new DomainRuleError('ALREADY_ONBOARDED', 'تم إعداد التطبيق مسبقاً');
    }

    const now = new Date().toISOString();

    // 1) العملات: Upsert الأربع — المختارة أساس+مفعّلة، والبقية غير مفعّلة
    //    (أي صف عملة قديم آخر يُنزَع الأساس أولاً حتى لا يبقى أساسان)
    await adapter.run('UPDATE currency SET is_base = 0');
    const currencyIds = new Map<string, number>();
    for (const c of CURRENCIES) {
      const chosen = c.code === data.baseCurrencyCode;
      const rows = await adapter.all<{ id: number }>(
        `INSERT INTO currency (code, name, is_base, decimals, is_active)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           is_base = excluded.is_base, decimals = excluded.decimals, is_active = excluded.is_active
         RETURNING id`,
        [c.code, c.name, chosen ? 1 : 0, c.decimals, chosen ? 1 : 0],
      );
      currencyIds.set(c.code, Number(rows[0]!.id));
    }
    const baseCurrencyId = currencyIds.get(data.baseCurrencyCode)!;

    // 2) المنشأة — ضريبة 0% وبادئة INV وتذييل افتراضي عند الغياب (FR-13-01/02)
    const companyRows = await adapter.all<{ id: number }>(
      `INSERT INTO company
         (name, phone, whatsapp, address, currency_id, tax_rate, invoice_prefix, footer_text,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        data.companyName,
        data.phone || null,
        data.whatsapp || null,
        data.address || null,
        baseCurrencyId,
        f4(data.taxRate ?? '0'),
        data.invoicePrefix ?? 'INV',
        DEFAULT_INVOICE_FOOTER,
        now,
        now,
      ],
    );
    const companyId = Number(companyRows[0]!.id);

    // 3) المخزن الرئيسي (is_default=1) — أول فاتورة لا تفشل بعده
    const warehouseRows = await adapter.all<{ id: number }>(
      `INSERT INTO warehouse (name, is_default, created_at, updated_at)
       VALUES ('المخزن الرئيسي', 1, ?, ?) RETURNING id`,
      [now, now],
    );
    const warehouseId = Number(warehouseRows[0]!.id);

    // 4) الصندوق الرئيسي بعملة الأساس (is_default=1)
    const cashboxRows = await adapter.all<{ id: number }>(
      `INSERT INTO cashbox (name, currency_id, is_default, created_at, updated_at)
       VALUES ('الصندوق الرئيسي', ?, 1, ?, ?) RETURNING id`,
      [baseCurrencyId, now, now],
    );
    const cashboxId = Number(cashboxRows[0]!.id);

    // 5) وحدة «قطعة»
    const unitRows = await adapter.all<{ id: number }>(
      `INSERT INTO unit (name, factor, created_at, updated_at)
       VALUES ('قطعة', '1', ?, ?) RETURNING id`,
      [now, now],
    );
    const unitId = Number(unitRows[0]!.id);

    // 6) فئات المصاريف — «رواتب» إلزامية (FR-04-05: بديل مسحوبات الرواتب)
    for (const cat of ['رواتب', 'مصاريف عامة', 'إيجار', 'نقل ومواصلات']) {
      await adapter.run(
        `INSERT INTO expense_category (name, created_at, updated_at) VALUES (?, ?, ?)`,
        [cat, now, now],
      );
    }

    // 7) المدير الواحد (FR-12-01) — pin_hash بصيغة salt$digest
    const userRows = await adapter.all<{ id: number }>(
      `INSERT INTO app_user (username, display_name, role, pin_hash, is_active, created_at, updated_at)
       VALUES ('admin', ?, 'admin', ?, 1, ?, ?) RETURNING id`,
      [data.displayName ?? data.companyName, hashPin(data.pin), now, now],
    );
    const userId = Number(userRows[0]!.id);

    return { companyId, warehouseId, cashboxId, unitId, userId, baseCurrencyId };
  });
}
