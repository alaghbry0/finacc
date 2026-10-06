/**
 * onboarding.test.ts — التهيئة الأولى (FR-13-01): كل الصفوف تنشأ في معاملة
 * واحدة + الرفض المزدوج + انعكاس اختيار العملة + صيغة تجزئة PIN.
 */
import { describe, expect, test } from 'bun:test';
import { completeOnboarding, isOnboarded } from '../onboarding';
import { login, wipeAllData } from '../auth';
import { DomainRuleError, PinLockedError, PinWrongError } from '../errors';
import { hashPin, verifyPin } from '../../services/pin';
import { freshDb } from '../../db/test-setup';

const BASE_INPUT = {
  companyName: 'متجر النور',
  phone: '777123456',
  whatsapp: '777123456',
  address: 'صنعاء — شارع الستين',
  baseCurrencyCode: 'YER' as const,
  pin: '1234',
};

describe('completeOnboarding — المعاملة الواحدة', () => {
  test('isOnboarded=false قبل → ينشئ كل الصفوف → true بعده', async () => {
    const db = await freshDb();
    expect(await isOnboarded(db)).toBe(false);
    const res = await completeOnboarding(db, BASE_INPUT);
    expect(await isOnboarded(db)).toBe(true);

    // العملات الأربع — المختارة أساس+مفعّلة، YER بلا كسور
    const currencies = await db.all<{
      code: string;
      is_base: number;
      decimals: number;
      is_active: number;
    }>('SELECT code, is_base, decimals, is_active FROM currency ORDER BY id');
    expect(currencies.length).toBe(4);
    const yer = currencies.find((c) => c.code === 'YER')!;
    expect(Number(yer.is_base)).toBe(1);
    expect(yer.decimals).toBe(0);
    expect(Number(yer.is_active)).toBe(1);
    const sar = currencies.find((c) => c.code === 'SAR')!;
    expect(Number(sar.is_base)).toBe(0);
    expect(Number(sar.is_active)).toBe(0);

    // المنشأة + المخزن + الصندوق + الوحدة + فئات المصاريف + المستخدم
    const company = await db.all<{
      name: string;
      currency_id: number;
      tax_rate: string;
      invoice_prefix: string | null;
      footer_text: string | null;
    }>('SELECT name, currency_id, tax_rate, invoice_prefix, footer_text FROM company');
    expect(company.length).toBe(1);
    expect(company[0]!.name).toBe('متجر النور');
    expect(Number(company[0]!.currency_id)).toBe(res.baseCurrencyId);
    expect(company[0]!.tax_rate).toBe('0.0000');
    expect(company[0]!.invoice_prefix).toBe('INV');
    expect(company[0]!.footer_text).toBe('شكراً لتعاملكم معنا');

    const wh = await db.all<{ name: string; is_default: number }>(
      'SELECT name, is_default FROM warehouse',
    );
    expect(wh.length).toBe(1);
    expect(wh[0]!.name).toBe('المخزن الرئيسي');
    expect(Number(wh[0]!.is_default)).toBe(1);

    const box = await db.all<{ name: string; currency_id: number; is_default: number }>(
      'SELECT name, currency_id, is_default FROM cashbox',
    );
    expect(box.length).toBe(1);
    expect(box[0]!.name).toBe('الصندوق الرئيسي');
    expect(Number(box[0]!.currency_id)).toBe(res.baseCurrencyId);

    const units = await db.all<{ name: string }>('SELECT name FROM unit');
    expect(units.map((u) => u.name)).toEqual(['قطعة']);

    const cats = await db.all<{ name: string }>('SELECT name FROM expense_category');
    expect(cats.map((c) => c.name)).toEqual(['رواتب', 'مصاريف عامة', 'إيجار', 'نقل ومواصلات']);

    const users = await db.all<{
      username: string;
      display_name: string;
      role: string;
      pin_hash: string;
    }>('SELECT username, display_name, role, pin_hash FROM app_user');
    expect(users.length).toBe(1);
    expect(users[0]!.username).toBe('admin');
    expect(users[0]!.role).toBe('admin');
    expect(users[0]!.display_name).toBe('متجر النور'); // displayName الافتراضي = اسم المنشأة
    expect(verifyPin(users[0]!.pin_hash, '1234')).toBe(true);
  });

  test('التشغيل الثاني يُرفض — «تم إعداد التطبيق مسبقاً»', async () => {
    const db = await freshDb();
    await completeOnboarding(db, BASE_INPUT);
    let err: unknown;
    try {
      await completeOnboarding(db, { ...BASE_INPUT, companyName: 'محاولة ثانية' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainRuleError);
    expect((err as DomainRuleError).code).toBe('ALREADY_ONBOARDED');
    expect((err as DomainRuleError).message).toBe('تم إعداد التطبيق مسبقاً');
    // لا شيء تغيّر
    const companies = await db.all('SELECT id FROM company');
    expect(companies.length).toBe(1);
  });

  test('اختيار SAR بدل YER ينعكس: is_base + company.currency_id + منازل', async () => {
    const db = await freshDb();
    const res = await completeOnboarding(db, { ...BASE_INPUT, baseCurrencyCode: 'SAR' });
    const base = await db.all<{ code: string; decimals: number }>(
      'SELECT code, decimals FROM currency WHERE is_base = 1',
    );
    expect(base[0]!.code).toBe('SAR');
    expect(base[0]!.decimals).toBe(2);
    const company = await db.all<{ currency_id: number }>('SELECT currency_id FROM company');
    expect(Number(company[0]!.currency_id)).toBe(res.baseCurrencyId);
    const box = await db.all<{ currency_id: number }>('SELECT currency_id FROM cashbox');
    expect(Number(box[0]!.currency_id)).toBe(res.baseCurrencyId);
    // YER الآن غير مفعّلة
    const yer = await db.all<{ is_active: number }>(
      "SELECT is_active FROM currency WHERE code = 'YER'",
    );
    expect(Number(yer[0]!.is_active)).toBe(0);
  });

  test('مدخل ناقص (اسم فارغ/PIN قصير) → ValidationError عربية بلا أي كتابة', async () => {
    const db = await freshDb();
    let err: unknown;
    try {
      await completeOnboarding(db, { ...BASE_INPUT, companyName: '  ', pin: '12' });
    } catch (e) {
      err = e;
    }
    expect((err as DomainRuleError).name).toBe('ValidationError');
    expect(await isOnboarded(db)).toBe(false);
    const companies = await db.all('SELECT id FROM company');
    expect(companies.length).toBe(0);
  });
});

describe('خدمة PIN — الصيغة والمطابقة', () => {
  test('الصيغة salt$digest: ملح 16 سداسياً + ملخص 64؛ نفس الرمز يمر والآخر يُرفض', () => {
    const hash = hashPin('1234');
    const [salt, digest] = hash.split('$');
    expect(salt).toMatch(/^[0-9a-f]{16}$/);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPin(hash, '1234')).toBe(true);
    expect(verifyPin(hash, '1235')).toBe(false);
    expect(verifyPin(hash, '')).toBe(false);
    expect(verifyPin('ليس-صيغة', '1234')).toBe(false);
    // ملح مختلف → تجزئة مختلفة (نفس الرمز)
    const hash2 = hashPin('1234');
    expect(hash2).not.toBe(hash);
    expect(verifyPin(hash2, '1234')).toBe(true);
  });
});

describe('auth.login — سياسة القفل (FR-12-06)', () => {
  test('الرمز الصحيح يمر ويصفّر المحاولات ويحدّث آخر دخول', async () => {
    const db = await freshDb();
    await completeOnboarding(db, BASE_INPUT);
    // محاولتان خاطئتان ثم الصحيح
    try {
      await login(db, '0000');
    } catch {
      /* متوقعة */
    }
    try {
      await login(db, '9999');
    } catch {
      /* متوقعة */
    }
    const user = await login(db, '1234');
    expect(user.displayName).toBe('متجر النور');
    expect(user.failedAttempts).toBe(0);
    expect(user.lastLoginAt).not.toBeNull();
    const row = await db.all<{ failed_attempts: number; locked_until: string | null }>(
      'SELECT failed_attempts, locked_until FROM app_user',
    );
    expect(Number(row[0]!.failed_attempts)).toBe(0);
    expect(row[0]!.locked_until).toBeNull();
  });

  test('5 محاولات خاطئة → قفل 30 ثانية (locked_until مضبوط) وPinLockedError', async () => {
    const db = await freshDb();
    await completeOnboarding(db, BASE_INPUT);
    let lockedErr: unknown;
    for (let i = 1; i <= 5; i += 1) {
      try {
        await login(db, '0000');
      } catch (e) {
        if (i === 5) lockedErr = e;
      }
    }
    expect(lockedErr).toBeInstanceOf(PinLockedError);
    expect((lockedErr as PinLockedError).remainingSeconds).toBe(30);
    const row = await db.all<{ failed_attempts: number; locked_until: string }>(
      'SELECT failed_attempts, locked_until FROM app_user',
    );
    expect(Number(row[0]!.failed_attempts)).toBe(5);
    const until = Date.parse(row[0]!.locked_until!);
    const in30s = until - Date.now();
    expect(in30s).toBeGreaterThan(25_000);
    expect(in30s).toBeLessThanOrEqual(30_500);

    // والمحاولة التالية (خلال القفل) تُرفض بـ PinLockedError فوراً دون زيادة
    const before = Number(row[0]!.failed_attempts);
    let still: unknown;
    try {
      await login(db, '0000');
    } catch (e) {
      still = e;
    }
    expect(still).toBeInstanceOf(PinLockedError);
    const after = await db.all<{ failed_attempts: number }>(
      'SELECT failed_attempts FROM app_user',
    );
    expect(Number(after[0]!.failed_attempts)).toBe(before);
  });

  test('منحنى التأخير حتى 10 محاولات: 30/60/120/240/480/900 + needsHardReset عند 10', async () => {
    const db = await freshDb();
    await completeOnboarding(db, BASE_INPUT);
    const delays: number[] = [];
    let hardReset = false;
    for (let i = 1; i <= 10; i += 1) {
      // نُبطل القفل فوراً بعد كل محاولة لنبقى على منحنى المحاولات وحده
      await db.run('UPDATE app_user SET locked_until = NULL');
      try {
        await login(db, '0000');
      } catch (e) {
        if (e instanceof PinLockedError) {
          delays.push(e.remainingSeconds);
          hardReset = e.needsHardReset;
        }
      }
    }
    expect(delays).toEqual([30, 60, 120, 240, 480, 900]); // المحاولات 5..10
    expect(hardReset).toBe(true);
  });

  test('قفل 10 محاولات = 15 دقيقة (900 ثانية) فعلاً في locked_until', async () => {
    const db = await freshDb();
    await completeOnboarding(db, BASE_INPUT);
    for (let i = 1; i <= 10; i += 1) {
      await db.run('UPDATE app_user SET locked_until = NULL');
      try {
        await login(db, '0000');
      } catch {
        /* متوقعة */
      }
    }
    const row = await db.all<{ locked_until: string }>('SELECT locked_until FROM app_user');
    const ms = Date.parse(row[0]!.locked_until!) - Date.now();
    expect(ms).toBeGreaterThan(890_000);
    expect(ms).toBeLessThanOrEqual(901_000);
  });

  test('رمز خاطئ قبل القفل → PinWrongError يخبر بالمتبقي قبل القفل', async () => {
    const db = await freshDb();
    await completeOnboarding(db, BASE_INPUT);
    let err: unknown;
    try {
      await login(db, '1111');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PinWrongError);
    const wrong = err as PinWrongError;
    expect(wrong.failedAttempts).toBe(1);
    expect(wrong.attemptsLeftBeforeLock).toBe(4);
    expect(wrong.message).toContain('4');
  });
});

describe('wipeAllData — مسار FR-12-06 الصعب', () => {
  test('يمسح كل شيء (ما عدا الهجرات) + قيد تدقيق واحد + يعيد الحماية للتريغرات', async () => {
    const db = await freshDb();
    await completeOnboarding(db, BASE_INPUT);
    // بعض البيانات في عدة جداول
    await db.run(
      "INSERT INTO category (name, created_at, updated_at) VALUES ('مشروبات', ?, ?)",
      [new Date().toISOString(), new Date().toISOString()],
    );
    const auditCount = async () =>
      Number((await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM audit_log'))[0]!.c);

    await wipeAllData(db);

    expect(await isOnboarded(db)).toBe(false);
    for (const table of ['company', 'currency', 'warehouse', 'cashbox', 'app_user', 'category']) {
      const rows = await db.all(`SELECT id FROM ${table}`);
      expect(rows.length).toBe(0);
    }
    // قيد تدقيق واحد بالمسح
    expect(await auditCount()).toBe(1);
    const entry = await db.all<{ action: string }>('SELECT action FROM audit_log');
    expect(entry[0]!.action).toBe('wipe_all_data');
    // التريغرات أُعيدت: محاولة DELETE من audit_log تُرفض
    let triggerErr: unknown;
    try {
      await db.run('DELETE FROM audit_log WHERE id = 1');
    } catch (e) {
      triggerErr = e;
    }
    expect(triggerErr).toBeDefined();
    // التهيئة بعد المسح تعمل من جديد (حلقة كاملة)
    await completeOnboarding(db, { ...BASE_INPUT, companyName: 'متجر بعد المسح' });
    expect(await isOnboarded(db)).toBe(true);
  });
});
