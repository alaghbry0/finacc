/**
 * SqliteAdapter — العقد الوحيد بين طبقة Domain ومحرّك SQLite (SRS NFR-09/11).
 *
 * طبقة Domain (src/domain/*) تستورد هذا الملف فقط — لا تستورد react-native/expo أبداً.
 * التنفيذات: src/db/expo-adapter.ts (التطبيق)، src/db/web-adapter.ts (الويب)،
 * src/db/test-adapter.ts (اختبارات bun). النتيجة: نفس منطق الأعمال يعمل على
 * الجهاز وفي الويب وفي الاختبارات بلا تعديل.
 */
export interface SqliteAdapter {
  /** تنفيذ جملة كتابة/قراءة واحدة بمعاملات موضعية (?) — بلا نتيجة */
  run(sql: string, params?: unknown[]): Promise<void>;
  /** تنفيذ استعلام ورد الصفوف ككائنات (يدعم INSERT..RETURNING) */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** تنفيذ نص SQL خام متعدد الجمل (الهجرات) — يشمل أجسام التريغرات */
  exec(sql: string): Promise<void>;
  /** BEGIN ... تنفيذ fn ... COMMIT، وROLLBACK عند أي رمي */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
