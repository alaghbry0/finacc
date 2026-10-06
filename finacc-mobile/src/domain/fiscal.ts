/**
 * fiscal.ts — حرس الفترات المحاسبية والتأريخ الرجعي (SRS §5.4-11 — قرار 6).
 *
 * 1) assertPeriodOpen: كل مسار كتابة بتاريخ يستدعيها وترفض أي تاريخ داخل سنة
 *    مغلقة في fiscal_year (بلا أثر للسنين المفتوحة أو غير المعرفة — تُقبل).
 * 2) isBackdateBeyondLimit: التأريخ الرجعي أكثر من dating.max_backdate_days
 *    (افتراضياً 30 يوماً — ملحق هـ) يتطلب تأكيد المدير + قيد audit.
 */
import type { SqliteAdapter } from '../db/adapter';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** تاريخ داخل سنة مالية مغلقة — يرفض التسجيل (قاعدة 5.4-11) */
export class FiscalPeriodClosedError extends Error {
  readonly year: number;
  readonly dateISO: string;
  constructor(year: number, dateISO: string) {
    super(`السنة المالية مغلقة (${year}) — لا يمكن تسجيل أي عملية بتاريخ ${dateISO} داخل فترة مقفلة`);
    this.name = 'FiscalPeriodClosedError';
    this.year = year;
    this.dateISO = dateISO;
  }
}

/**
 * يرفض (FiscalPeriodClosedError) إذا وقع التاريخ داخل سنة مالية حالة 'closed'.
 * السنة المفتوحة / السنة غير المعرفة → تمرير (لا حجز إلزامياً للفترات في V1).
 */
export async function assertPeriodOpen(adapter: SqliteAdapter, dateISO: string): Promise<void> {
  if (!DATE_RE.test(dateISO)) {
    throw new Error(`تاريخ غير صالح (المتوقع YYYY-MM-DD): ${dateISO}`);
  }
  const rows = await adapter.all<{ year: number | string; status: string }>(
    `SELECT year, status FROM fiscal_year WHERE start_date <= ? AND end_date >= ?`,
    [dateISO, dateISO],
  );
  const closed = rows.find((r) => r.status === 'closed');
  if (closed) {
    throw new FiscalPeriodClosedError(Number(closed.year), dateISO);
  }
}

/**
 * هل التأريخ الرجعي أبعد من الحد المسموح بلا تأكيد مدير؟
 * المقارنة على تاريخ اليوم (UTC) بالأيام الكاملة.
 */
export async function isBackdateBeyondLimit(
  adapter: SqliteAdapter,
  dateISO: string,
  maxDays: number,
): Promise<boolean> {
  // المعامل محجوز لاستخدام مستقبلي (تاريخ عمل مخصص من جدول settings) — الآن اليوم
  void adapter;
  if (!DATE_RE.test(dateISO)) {
    throw new Error(`تاريخ غير صالح (المتوقع YYYY-MM-DD): ${dateISO}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  return daysBetween(today, dateISO) > maxDays;
}

/** فرق الأيام الكاملة بين تاريخين ISO (a - b) — رياضيات UTC خالصة */
export function daysBetween(a: string, b: string): number {
  const ua = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const ub = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((ua - ub) / 86_400_000);
}
