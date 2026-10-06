/**
 * تعريف محيطي (ambient) أدنى لوحدة bun:sqlite — فقط لتمرير `tsc --noEmit` دون
 * إضافة bun-types عالمياً (مشروع Expo لا يجب أن يعتمد أنواع Bun).
 *
 * ملاحظات:
 *  - وقت التشغيل (bun test) تُستخدم الوحدة الحقيقية من Bun؛ هذا الملف للأنواع فقط.
 *  - في bun 1.3.x ليس لـ Database نفسها .all/.get — بل على Statement عبر
 *    db.query(sql)/db.prepare(sql)؛ لذلك نصرّح بالأشكال التي نستخدمها فعلاً.
 */
declare module 'bun:sqlite' {
  export class Statement {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | null;
    run(...params: unknown[]): void;
    finalize(): void;
  }

  export class Database {
    constructor(path: string, options?: Record<string, unknown>);
    run(sql: string, ...params: unknown[]): void;
    exec(sql: string): void;
    query(sql: string): Statement;
    prepare(sql: string): Statement;
    close(): void;
  }

  export class SQLiteError extends Error {}
}
