/**
 * تعريف محيطي (ambient) أدنى لوحدة bun:test — لتمرير `tsc --noEmit` على ملفات
 * الاختبارات دون إضافة bun-types عالمياً. وقت التشغيل تُستخدم الوحدة الحقيقية.
 */
declare module 'bun:test' {
  type TestFn = () => void | Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: TestFn, timeout?: number): void;
  export const it: typeof test;
  export function beforeAll(fn: TestFn): void;
  export function afterAll(fn: TestFn): void;
  export function beforeEach(fn: TestFn): void;
  export function afterEach(fn: TestFn): void;
  // مطابقة مرنة تكفي للبوابة النوعية؛ أثناء التشغيل الدلالات Jest-like الكاملة متاحة
  export const expect: {
    (actual: unknown): any;
  };
  export function mock(...args: unknown[]): unknown;
}
