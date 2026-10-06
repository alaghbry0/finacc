/**
 * local-store.test.ts — اختبارات المخزن المحلي المتزامن (نقية — bun).
 *
 * تُحقن خلفية localStorage وهمية قبل الاستيراد لأن bun بلا DOM: كل
 * الدوال تمر عبر getBackend() التي تلتقط globalThis.localStorage،
 * فالحقن يمنحنا حتمية كاملة (حصة منتهية/قيمة فاسدة/غياب الخلف).
 */
import { beforeEach, describe, expect, test } from 'bun:test';

/** خلفية وهمية قابلة للفشل الموجَّه */
class FakeStorage {
  store = new Map<string, string>();
  failSet = false;
  failGet = false;
  getItem(k: string): string | null {
    if (this.failGet) throw new Error('quota-read');
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    if (this.failSet) throw new Error('quota-exceeded');
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
}

const fake = new FakeStorage();
(globalThis as { localStorage?: unknown }).localStorage = fake;

// الاستيراد بعد الحقن حتى يلتقط getBackend الخلفية (ترتيب مقصود)
const { STORE_KEYS, getItem, setItem, removeItem } = await import('../local-store');

beforeEach(() => {
  fake.store.clear();
  fake.failSet = false;
  fake.failGet = false;
});

describe('local-store — المخزن المحلي المتزامن', () => {
  test('جولة كاملة: setItem ثم getItem بنفس القيمة ثم removeItem → null', () => {
    const snap = { lines: [{ key: 'k1', qty: '2' }], savedAt: '2026-10-06T10:00:00.000Z' };
    setItem(STORE_KEYS.saleCartDraft, snap);
    const back = getItem<typeof snap>(STORE_KEYS.saleCartDraft);
    expect(back).not.toBeNull();
    expect((back as typeof snap).lines[0]!.qty).toBe('2');
    removeItem(STORE_KEYS.saleCartDraft);
    expect(getItem(STORE_KEYS.saleCartDraft)).toBeNull();
  });

  test('المفاتيح الأربعة منفصلة: مسودة البيع لا تظهر في الشراء والعكس', () => {
    setItem(STORE_KEYS.saleCartDraft, { tag: 'sale' });
    setItem(STORE_KEYS.purchaseCartDraft, { tag: 'purchase' });
    expect(getItem<{ tag: string }>(STORE_KEYS.saleCartDraft)!.tag).toBe('sale');
    expect(getItem<{ tag: string }>(STORE_KEYS.purchaseCartDraft)!.tag).toBe('purchase');
    expect(String(STORE_KEYS.saleCartDraft) !== String(STORE_KEYS.purchaseCartDraft)).toBe(true);
  });

  test('قيمة فاسدة (JSON مكسور) → null ويُنظَّف المفتاح الفاسد', () => {
    fake.store.set(STORE_KEYS.saleCartParked, '{not-json');
    expect(getItem(STORE_KEYS.saleCartParked)).toBeNull();
    // نُنظّف المفتاح فعلاً: كتابة سليمة بعده تُقرأ
    setItem(STORE_KEYS.saleCartParked, [{ id: 'p1' }]);
    expect(getItem<{ id: string }[]>(STORE_KEYS.saleCartParked)).toEqual([{ id: 'p1' }]);
  });

  test('فشل الكتابة (نفاد الحصة) لا يرمي ولا يمس القيمة السابقة', () => {
    setItem(STORE_KEYS.saleCartDraft, { v: 1 });
    fake.failSet = true;
    expect(() => setItem(STORE_KEYS.saleCartDraft, { v: 2 })).not.toThrow();
    expect(getItem<{ v: number }>(STORE_KEYS.saleCartDraft)!.v).toBe(1);
  });

  test('فشل القراءة يرجع null بأمان', () => {
    setItem(STORE_KEYS.purchaseCartParked, [{ id: 'x' }]);
    fake.failGet = true;
    expect(getItem(STORE_KEYS.purchaseCartParked)).toBeNull();
  });

  test('removeItem على مفتاح غائب لا يرمي', () => {
    expect(() => removeItem('finacc.no-such-key')).not.toThrow();
  });

  test('القيم نصية خالصة تُلف بـ JSON (لا تسريب كائنات JS في التخزين)', () => {
    setItem('k', 'نص حر');
    expect(fake.store.get('k')).toBe('"نص حر"');
    expect(getItem<string>('k')).toBe('نص حر');
  });

  test('الأنماط المطبَّعة تمر عبر المفاتيح المسبوقة finacc. كلها', () => {
    for (const key of Object.values(STORE_KEYS)) {
      expect(key.startsWith('finacc.')).toBe(true);
    }
  });
});
