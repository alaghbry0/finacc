/**
 * sha256.ts — تنفيذ SHA-256 خالص بـ TypeScript (لا وحدة أصلية).
 *
 * **لماذا هو هنا**: تجزئة PIN تتطلب SHA-256 على المنصات الثلاث (أصل/ويب/اختبارات)
 * بلا expo-crypto (وحدة أصلية تكسر حزمة الويب) وبلا تبعية npm جديدة (قانون البيئة).
 * تنفيذ صغير، قابل للاختبار، مطابق للمواصفة FIPS 180-4 — يُتحقق منه في
 * الاختبارات ضد node:crypto (متجهات ASCII وعربية).
 *
 * وحدة نقية: بلا أي استيراد (NFR-09/11).
 */

/* ثوابت K من FIPS 180-4 (أول 32 بتاً من الكسور التكعيبية للأعداد الأولية الأولى) */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

/** القيم التمهيدية H0 (جذور تكعيبية) */
const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

/** تدوير يميني 32 بت */
const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** ترميز UTF-8 يدوي (يعمل على أي JS engine — بلا TextEncoder كضرورة) */
function utf8Bytes(input: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let c = input.codePointAt(i)!;
    if (c > 0xffff) {
      // زوج بديل (astral) — codePointAt يعيد القيمة الكاملة ويتخطى الوحدة التالية
      i += 1;
    }
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    }
  }
  return out;
}

const HEX = '0123456789abcdef';

/**
 * SHA-256 لسلسلة (مرمّزة UTF-8) → سداسي عشري 64 حرفاً (FIPS 180-4).
 * تنقّح مقابل node:crypto في الاختبارات.
 */
export function sha256Hex(input: string): string {
  const msg = utf8Bytes(input);
  const bitLen = msg.length * 8;

  // الحشو: 0x80 ثم أصفار حتى ≡ 56 (mod 64) ثم الطول 64 بت big-endian
  const padded: number[] = [...msg, 0x80];
  while (padded.length % 64 !== 56) padded.push(0);
  // الطول 64 بت big-endian — 8 بايت (الجزء العلوي صفر عملياً: المدخلات هنا قصيرة)
  for (let shift = 56; shift >= 0; shift -= 8) {
    padded.push((bitLen / 2 ** shift) & 0xff);
  }

  const w = new Array<number>(64);
  const h: number[] = [...H0];

  for (let block = 0; block < padded.length; block += 64) {
    // 16 كلمة 32 بت من الكتلة
    for (let t = 0; t < 16; t += 1) {
      const i = block + t * 4;
      w[t] = (padded[i]! << 24) | (padded[i + 1]! << 16) | (padded[i + 2]! << 8) | padded[i + 3]!;
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[t]! + w[t]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }

  let hex = '';
  for (const word of h) {
    // توقيع الأجزاء — إلى سداسي عشري 8 خانات
    const u = word >>> 0;
    hex += HEX[(u >>> 28) & 15]! + HEX[(u >>> 24) & 15]!;
    hex += HEX[(u >>> 20) & 15]! + HEX[(u >>> 16) & 15]!;
    hex += HEX[(u >>> 12) & 15]! + HEX[(u >>> 8) & 15]!;
    hex += HEX[(u >>> 4) & 15]! + HEX[u & 15]!;
  }
  return hex;
}
