/**
 * money.ts — أدوات المال الدقيقة (SRS 5.2-3: لا Float أبداً).
 *
 * كل الحساب المالي/الكميات عبر decimal.js بدقة 20 خانة وتقريب ROUND_HALF_UP.
 * التسلسل القياسي (قرار Task 2 الملزم):
 *  - المبالغ/التكاليف/الأسعار: نص .toFixed(4)
 *  - الكميات: نص .toFixed(3)
 *  - أسعار الصرف: نص .toFixed(6)
 * التخزين TEXT في SQLite والقراءة string ثم d() لاستعادة Decimal.
 *
 * وحدة نقية: تستورد decimal.js فقط — بلا أي react-native/expo (NFR-09/11).
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/** أي قيمة قابلة للتحويل إلى Decimal */
export type Numeric = string | number | Decimal;

/** يحوّل إلى Decimal (يبقى الأصل إن كان Decimalاً) */
export const d = (x: Numeric): Decimal => (x instanceof Decimal ? x : new Decimal(x));

/** تسلسل مبلغ/تكلفة/سعر: 4 منازل عشرية نصاً */
export const f4 = (x: Numeric): string => d(x).toFixed(4);

/** تسلسل كمية: 3 منازل عشرية نصاً */
export const f3 = (x: Numeric): string => d(x).toFixed(3);

/** تسلسل سعر صرف: 6 منازل عشرية نصاً (NUMERIC(12,6)) */
export const f6 = (x: Numeric): string => d(x).toFixed(6);

/** مجموع دقيق لمصفوفة قيم */
export const sumD = (xs: Numeric[]): Decimal =>
  xs.reduce<Decimal>((acc, x) => acc.plus(d(x)), new Decimal(0));

/** ضرب دقيق */
export const mult = (a: Numeric, b: Numeric): Decimal => d(a).times(d(b));

/** مقارنة: -1 إذا a<b، 0 تساوٍ، 1 إذا a>b */
export const cmp = (a: Numeric, b: Numeric): number => d(a).cmp(d(b));

/** تقريب لعدد منازل محدد (HALF_UP) — dp: 0|2|3|4|6 */
export function roundTo(v: Numeric, dp: 0 | 2 | 3 | 4 | 6): Decimal {
  return d(v).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
}

/** حارس: القيمة أكبر من الصفر وإلا يرمى برسالة عربية (ماذا حدث + ما الحل) */
export function assertPositive(v: Numeric, msg: string): Decimal {
  const x = d(v);
  if (!x.isFinite() || x.lte(0)) throw new Error(msg);
  return x;
}

/** حارس: القيمة غير سالبة وإلا يرمى برسالة عربية */
export function assertNonNegative(v: Numeric, msg: string): Decimal {
  const x = d(v);
  if (!x.isFinite() || x.lt(0)) throw new Error(msg);
  return x;
}

/** هل النص رقم عشري صالح (للاستخدام في refine زود) */
export function isDecimalString(s: string): boolean {
  if (typeof s !== 'string' || s.trim() === '') return false;
  try {
    const v = new Decimal(s);
    return v.isFinite();
  } catch {
    return false;
  }
}

export { Decimal };
