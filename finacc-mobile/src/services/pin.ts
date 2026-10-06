/**
 * pin.ts — تجزئة رمز PIN والتحقق منه (FR-12-03/06 — قرار 4).
 *
 * ⚠️ **إحلال موثَّق (بيئة Expo Go/الاختبارات بدل EAS)**:
 * SRS يفرض Argon2id (m=64MB, t=3, p=1) لتجزئة PIN — وهو يتطلب كوداً أصلياً
 * (react-native-argon2) لا يعمل إلا في بناءات EAS/Dev Build، ويكسر الويب
 * (المعرفية الأساسية لهذه البيئة). الحل المؤقت الموثَّق: **SHA-256 متكرر
 * 5000 مرة مع ملح عشوائي 64 بت** (تسلسل salt$hex) — قابل للتشغيل والاختبار
 * على المنصات الثلاث، ويُستبدل بـ Argon2id في بناءات الإنتاج (سجل العمل).
 *
 * الصيغة المخزنة: `salt$digest` — salt ست عشرة حرفاً (8 بايت)، digest 64 حرفاً.
 * المقارنة زمن-ثابتة تقريبياً (لا خروج مبكر عند أول اختلاف).
 *
 * وحدة نقية: sha256 الخالص فقط — بلا react-native (NFR-09/11).
 */
import { sha256Hex } from '../utils/sha256';

/** عدد التكرارات — موازنة بين بطء هجوم القاموس وسلاسة UX */
const ITERATIONS = 5000;

/** ملح عشوائي 16 حرفاً سداسياً (8 بايت) — Math.random + Date.now (لا حاجة تشفيرية هنا) */
export function randomSaltHex(): string {
  const entropy = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random()
    .toString(16)
    .slice(2)}`;
  return sha256Hex(entropy).slice(0, 16);
}

/** يشتق الملخص بعد ITERATIONS تكراراً: sha256(salt+القيمة) مراراً */
function derive(salt: string, pin: string): string {
  let acc = sha256Hex(`${salt}${pin}`);
  for (let i = 1; i < ITERATIONS; i += 1) {
    acc = sha256Hex(`${salt}${acc}`);
  }
  return acc;
}

/** مقارنة سداسية زمن-ثابتة تقريبياً — بلا خروج مبكر */
function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * يجزّئ رمز PIN → «salt$digest».
 * @param pin  رمز 4-6 أرقام (التحقق من الشكل مسؤولية المدخل/زود)
 * @param salt ملح اختياري — يُولَّد عشوائياً عند غيابه (لتثبيت الاختبارات فقط)
 */
export function hashPin(pin: string, salt?: string): string {
  const s = salt ?? randomSaltHex();
  return `${s}$${derive(s, pin)}`;
}

/**
 * يتحقق أن الرمز يطابق التجزئة المخزنة.
 * الصيغة غير الصالحة → false (لا يرمي — مسار دفاعي).
 */
export function verifyPin(hash: string, pin: string): boolean {
  const dollarAt = hash.indexOf('$');
  if (dollarAt <= 0 || dollarAt !== hash.length - 65) return false;
  const salt = hash.slice(0, dollarAt);
  const digest = hash.slice(dollarAt + 1);
  if (!/^[0-9a-f]{16}$/.test(salt) || !/^[0-9a-f]{64}$/.test(digest)) return false;
  return constantTimeHexEquals(derive(salt, pin), digest);
}
