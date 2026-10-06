/**
 * اختبارات حرس الفترات المحاسبية والتأريخ الرجعي (SRS §5.4-11 — قرار 6).
 */
import { describe, expect, test } from 'bun:test';
import { freshDb } from '../../db/test-setup';
import type { SqliteAdapter } from '../../db/adapter';
import { assertPeriodOpen, daysBetween, isBackdateBeyondLimit, FiscalPeriodClosedError } from '../fiscal';

const NOW = new Date().toISOString();

async function insertFiscalYear(
  db: SqliteAdapter,
  year: number,
  status: 'open' | 'closed',
): Promise<void> {
  await db.run(
    `INSERT INTO fiscal_year (year, start_date, end_date, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [year, `${year}-01-01`, `${year}-12-31`, status, NOW, NOW],
  );
}

describe('assertPeriodOpen — قفل الفترات (fiscal_year)', () => {
  test('سنة مغلقة تغطي التاريخ → رفض برسالة «السنة المالية مغلقة...»', async () => {
    const db = await freshDb();
    await insertFiscalYear(db, 2026, 'closed');
    let err: unknown;
    try {
      await assertPeriodOpen(db, '2026-06-15');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FiscalPeriodClosedError);
    expect((err as Error).message).toContain('السنة المالية مغلقة');
    expect((err as FiscalPeriodClosedError).year).toBe(2026);
    expect((err as FiscalPeriodClosedError).dateISO).toBe('2026-06-15');
  });

  test('حدود الفترة المغلقة نفسها مرفوضة (البداية والنهاية)', async () => {
    const db = await freshDb();
    await insertFiscalYear(db, 2025, 'closed');
    await expect(assertPeriodOpen(db, '2025-01-01')).rejects.toThrow('السنة المالية مغلقة');
    await expect(assertPeriodOpen(db, '2025-12-31')).rejects.toThrow('السنة المالية مغلقة');
  });

  test('سنة مفتوحة تغطي التاريخ → تمرير', async () => {
    const db = await freshDb();
    await insertFiscalYear(db, 2026, 'open');
    await expect(assertPeriodOpen(db, '2026-06-15')).resolves.toBeUndefined();
  });

  test('لا صف سنة مالية أصلاً → تمرير (لا حجز إلزامي للفترات في V1)', async () => {
    const db = await freshDb();
    await expect(assertPeriodOpen(db, '2030-06-15')).resolves.toBeUndefined();
  });

  test('سنة مغلقة سابقة لا تؤثر على تاريخ لاحق خارجها', async () => {
    const db = await freshDb();
    await insertFiscalYear(db, 2024, 'closed');
    await insertFiscalYear(db, 2025, 'closed');
    await expect(assertPeriodOpen(db, '2026-01-01')).resolves.toBeUndefined();
  });

  test('تاريخ غير صالح → خطأ واضح (لا استعلام غامض)', async () => {
    const db = await freshDb();
    await expect(assertPeriodOpen(db, '15-06-2026')).rejects.toThrow('تاريخ غير صالح');
  });
});

describe('isBackdateBeyondLimit — التأريخ الرجعي (dating.max_backdate_days)', () => {
  test('رجوع 45 يوماً مع حد 30 → true (يتطلب تأكيد المدير + قيد audit)', async () => {
    const db = await freshDb();
    const d45 = daysAgoISO(45);
    expect(await isBackdateBeyondLimit(db, d45, 30)).toBe(true);
  });

  test('رجوع 10 أيام مع حد 30 → false', async () => {
    const db = await freshDb();
    const d10 = daysAgoISO(10);
    expect(await isBackdateBeyondLimit(db, d10, 30)).toBe(false);
  });

  test('المستقبل ليس تأريخاً رجعياً → false', async () => {
    const db = await freshDb();
    const future = daysAgoISO(-3);
    expect(await isBackdateBeyondLimit(db, future, 30)).toBe(false);
  });

  test('بحد يوم واحد: الأمس false والبارحة true — الحدود دقيقة', async () => {
    const db = await freshDb();
    expect(await isBackdateBeyondLimit(db, daysAgoISO(1), 1)).toBe(false);
    expect(await isBackdateBeyondLimit(db, daysAgoISO(2), 1)).toBe(true);
  });
});

describe('daysBetween — رياضيات التواريخ', () => {
  test('فروق صحيحة عبر الشهور', () => {
    expect(daysBetween('2026-05-01', '2026-05-01')).toBe(0);
    expect(daysBetween('2026-05-02', '2026-05-01')).toBe(1);
    expect(daysBetween('2026-03-01', '2026-02-01')).toBe(28);
    expect(daysBetween('2025-03-01', '2025-02-01')).toBe(28); // 2025 ليست كبيسة
    expect(daysBetween('2024-03-01', '2024-02-01')).toBe(29); // 2024 كبيسة
    expect(daysBetween('2026-02-01', '2026-03-01')).toBe(-28);
  });
});

function daysAgoISO(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}
