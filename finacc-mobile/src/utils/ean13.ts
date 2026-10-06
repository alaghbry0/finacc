/**
 * ean13.ts — توليد وتحقق باركود EAN-13 للأصناف (FR-01-02).
 *
 * القواعد:
 *  - خانة التحقق القياسية: مجموع الأرقام الفردية (من اليسار، تبدأ من 1) ×1
 *    + الزوجية ×3، ثم متمّم mod-10: check = (10 − sum mod 10) mod 10.
 *  - الباركود المولَّد داخلياً يبدأ بـ «200» — نطاق المتاجر الداخلي (In-Store EAN)
 *    المحجوز عالمياً للترميز الداخلي حتى لا يتصادم مع باركودات المنتجات الحقيقية
 *    (20-29 prefix مخصص للاستخدام الداخلي).
 *  - العشوائية Math.random كافية هنا (توليد معرّف غير تصادمي، لا أمن تشفيري) —
 *    الإ uniqueness يُضمن عبر مجموعة الباركودات القائمة.
 *
 * وحدة نقية: بلا أي استيراد react-native/expo (NFR-09/11).
 */

/** متجه اختبار موثق: الباركود الكامل 4006381333931 → خانة التحقق 1 */
export const EAN13_KNOWN_VECTOR = { digits12: '400638133393', check: 1 };

/**
 * خانة تحقق EAN-13 لاثني عشر رقماً (standard GS1).
 * @param digits12 سلسلة من 12 رقماً بالضبط
 * @returns خانة التحقق (0-9)
 * @throws Error إذا لم تكن السلسلة 12 رقماً
 */
export function ean13Checksum(digits12: string): number {
  if (!/^\d{12}$/.test(digits12)) {
    throw new Error(`EAN-13 يتطلب 12 رقماً بالضبط — استُلم: "${digits12}"`);
  }
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = digits12.charCodeAt(i) - 48;
    // المواضع الفردية (1،3،5… من اليسار) ×1 — الزوجية (2،4،6…) ×3
    sum += (i + 1) % 2 === 1 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** يتحقق أن باركود 13 رقماً صالح خانة تحقق */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return ean13Checksum(code.slice(0, 12)) === Number(code[12]);
}

/** رقم شبه عشوائي في [0, max) */
function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

/**
 * يولّد باركود EAN-13 داخلياً جديداً: «200» + 9 أرقام عشوائية + خانة تحقق.
 * يعيد التوليد حتى يخرج رمز غير موجود في `existing` (ضمان التفرّد).
 * @param existing مجموعة الباركودات المحجوزة (كل الأصناف بما فيها المؤرشفة — FR-01-01)
 */
export function generateEan13(existing: Set<string>): string {
  // 12 خانة: 3 prefix + 9 عشوائية (5 + 4) — ثم خانة التحقق
  for (let guard = 0; guard < 1000; guard += 1) {
    let body = '200';
    for (let i = 0; i < 9; i += 1) {
      body += String(randomInt(10));
    }
    const code = `${body}${ean13Checksum(body)}`;
    if (!existing.has(code)) return code;
  }
  // احتمال نظري مهمل (10^9 فضاء) — نرمي بدل الالتفاف الأبدي
  throw new Error('تعذّر توليد باركود فريد بعد 1000 محاولة — أعد المحاولة');
}
