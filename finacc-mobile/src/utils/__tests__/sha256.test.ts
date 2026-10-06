/**
 * sha256.test.ts — تنفيذ SHA-256 الخالص يطابق node:crypto (متجهات موثقة + عربية).
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { sha256Hex } from '../sha256';

describe('sha256Hex — متجهات FIPS/GS1 الموثقة', () => {
  test('السلسلة الفارغة', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('«abc» — المتجه الأشهر', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('الناتج دائماً 64 حرفاً سداسياً', () => {
    for (const s of ['x', 'أ', 'a'.repeat(1000)]) {
      expect(sha256Hex(s)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('sha256Hex — مطابقة node:crypto (بما فيها العربية UTF-8)', () => {
  const samples = [
    '1234',
    'pin-salt-mix',
    'رمز الدخول ٩٦٣',
    'السلام عليكم — متجر النور',
    'ومزيج مع أرقام 1234567890 ورموز !@#$%^&*()',
    'long'.repeat(300), // يعبر حدود كتل متعددة (64 بايت+)
    'م'.repeat(200),
  ];

  for (const s of samples) {
    test(`يطابق crypto للمدخل: ${s.slice(0, 24)}${s.length > 24 ? '…' : ''}`, () => {
      const expected = createHash('sha256').update(s, 'utf8').digest('hex');
      expect(sha256Hex(s)).toBe(expected);
    });
  }
});
