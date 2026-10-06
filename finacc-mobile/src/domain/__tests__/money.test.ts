/**
 * money.test.ts — أدوات المال الدقيقة + WAC الخالص (SRS §10.2: inventory/WAC «بدقة 4 منازل
 * مع توزيع خصم رأس الفاتورة» — جزء WAC الخالص هنا، والتوزيع pro-rata في invoicing.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { cmp, d, f3, f4, f6, mult, roundTo, sumD } from '../../utils/money';
import { computeWac } from '../inventory';

describe('d/f4/f3/f6 — التسلسل القياسي (4/3/6 منازل، HALF_UP)', () => {
  test('f4: تقريب HALF_UP عند الحد الخامس', () => {
    expect(f4('0.00005')).toBe('0.0001'); // HALF_UP يرفع
    expect(f4('0.00004')).toBe('0.0000');
    expect(f4('1.5')).toBe('1.5000');
    expect(f4('123.456789')).toBe('123.4568');
  });

  test('f3 للكميات وf6 لأسعار الصرف', () => {
    expect(f3('2.5')).toBe('2.500');
    expect(f3('0.0005')).toBe('0.001');
    expect(f6('530')).toBe('530.000000');
    expect(f6('0.1234567')).toBe('0.123457');
  });

  test('roundTo: منازل 0/2/3/4/6', () => {
    expect(roundTo('2.6789', 0).toFixed(0)).toBe('3');
    expect(roundTo('2.6789', 2).toFixed(2)).toBe('2.68');
    expect(roundTo('2.6789', 3).toFixed(3)).toBe('2.679');
    expect(roundTo('2.67895', 4).toFixed(4)).toBe('2.6790');
    expect(roundTo('2.6789549', 6).toFixed(6)).toBe('2.678955');
  });
});

describe('sumD/mult/cmp — جمع ومقارنة دقيقة', () => {
  test('sumD يجمع نصوصاً وDecimals دون فاقد دقة', () => {
    expect(sumD(['0.1', '0.2', d('0.3')]).toString()).toBe('0.6');
    expect(sumD([0.1, 0.2]).toString()).toBe('0.3');
  });

  test('mult: 0.1 × 0.2 = 0.02 (لا خطأ Float)', () => {
    expect(mult('0.1', '0.2').toString()).toBe('0.02');
    expect(mult(3, '33.3333').toString()).toBe('99.9999');
  });

  test('cmp: -1/0/1', () => {
    expect(cmp('5.0001', '5')).toBe(1);
    expect(cmp('5', '5.0000')).toBe(0);
    expect(cmp('4.9999', '5')).toBe(-1);
  });
});

describe('computeWac — التكلفة المرجّحة (SRS 5.4-3)', () => {
  test('(أ) مزج 10@100 + 10@120 → 110 بالضبط', () => {
    expect(computeWac('10', '100', '10', '120').toString()).toBe('110');
  });

  test('(ب) رصيد قديم صفري → تكلفة الشحنة الجديدة مباشرة (5.4-3)', () => {
    expect(computeWac('0', '0', '10', '90').toString()).toBe('90');
    expect(computeWac('0', '555', '7', '123.456789').toString()).toBe('123.4568');
  });

  test('(ب+) رصيد قديم سالب (حالة حدية) → تكلفة الجديدة', () => {
    expect(computeWac('-3', '100', '5', '200').toString()).toBe('200');
  });

  test('(ج) سيناريو خصم رأس الفاتورة: شراء 10 @100 بخصم 10% → الوحدة 90 → WAC من 90 (لا 100)', () => {
    // التوزيع pro-rata نفسه مختبر في invoicing.test.ts — هنا الوحدة الفعلية بعد الخصم
    const effectiveUnit = mult('10', '100').minus(mult('1000', '0.1')).div('10'); // 90
    expect(computeWac('0', '0', '10', effectiveUnit).toString()).toBe('90');
    // ومزجها فوق رصيد قائم: 10 قديم @95 + 10 جديد @90 → 92.5
    expect(computeWac('10', '95', '10', effectiveUnit).toString()).toBe('92.5');
  });

  test('استقرار 4 منازل: كسور متكررة لا تتذبذب', () => {
    // (3×33.3333 + 2×50)/5 = (99.9999+100)/5 = 39.99998 → 40.0000
    expect(computeWac('3', '33.3333', '2', '50').toFixed(4)).toBe('40.0000');
    // (1×10.5555 + 1×10.5555)/2 = 10.5555
    expect(computeWac('1', '10.5555', '1', '10.5555').toFixed(4)).toBe('10.5555');
    // 7@0.33335 → 0.33335 → 0.3334 (HALF_UP)
    expect(computeWac('0', '0', '7', '0.33335').toFixed(4)).toBe('0.3334');
  });
});
