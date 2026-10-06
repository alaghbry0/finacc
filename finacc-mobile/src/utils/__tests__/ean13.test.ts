/**
 * ean13.test.ts — خانة التحقق القياسية + توليد الباركود الداخلي (FR-01-02).
 */
import { describe, expect, test } from 'bun:test';
import {
  EAN13_KNOWN_VECTOR,
  ean13Checksum,
  generateEan13,
  isValidEan13,
} from '../ean13';

describe('ean13Checksum — الخوارزمية القياسية', () => {
  test('المتجه الموثق GS1: 400638133393 → 1', () => {
    expect(ean13Checksum(EAN13_KNOWN_VECTOR.digits12)).toBe(EAN13_KNOWN_VECTOR.check);
    expect(isValidEan13('4006381333931')).toBe(true);
  });

  test('متجهات معروفة إضافية (590123412345 → 7 / 200000000000 → 8)', () => {
    // 5901234123457 — مثال GS1 الشهير
    expect(ean13Checksum('590123412345')).toBe(7);
    // 200000000000 → حساب يدوي: أرقام زوجية 0، فردية 2 → sum=2 → check=8
    expect(ean13Checksum('200000000000')).toBe(8);
    expect(isValidEan13('5901234123457')).toBe(true);
  });

  test('كل خانات التحقق الممكنة متمّمة صحيحة: check(code+check) صالح دائماً', () => {
    const body = '400638133393';
    const c = ean13Checksum(body);
    expect(isValidEan13(`${body}${c}`)).toBe(true);
    // تغيير خانة التحقق يفسد الصلاحية (ما عدا التماثل check→check)
    const bad = c === 0 ? 1 : 0;
    expect(isValidEan13(`${body}${bad}`)).toBe(false);
  });

  test('يرفض مدخلاً ليس 12 رقماً', () => {
    expect(() => ean13Checksum('12345')).toThrow();
    expect(() => ean13Checksum('400638133393a')).toThrow();
  });
});

describe('generateEan13 — التوليد الداخلي', () => {
  test('13 رقماً، يبدأ «200»، خانة التحقق صحيحة', () => {
    for (let i = 0; i < 25; i += 1) {
      const code = generateEan13(new Set());
      expect(code).toMatch(/^\d{13}$/);
      expect(code.startsWith('200')).toBe(true);
      expect(isValidEan13(code)).toBe(true);
    }
  });

  test('لا يُرجع رمزاً موجوداً في المجموعة — دائماً فريد', () => {
    const existing = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const code = generateEan13(existing);
      expect(existing.has(code)).toBe(false);
      existing.add(code);
    }
    expect(existing.size).toBe(50);
  });
});
