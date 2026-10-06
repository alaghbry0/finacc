/**
 * test-adapter.ts — تنفيذ SqliteAdapter فوق bun:sqlite للاختبارات فقط (SRS §0.5-4).
 *
 * ⚠️ لا يستورده كود التطبيق إطلاقاً — فقط ملفات الاختبارات وsrc/db/test-setup.ts.
 * bun:sqlite متزامن — نلفّ النتائج بوعود محققة للالتزام بالعقد غير المتزامن.
 *
 * المعاملات:
 *  - نداء خارجي: BEGIN → fn → COMMIT / ROLLBACK، مع تسلسل (mutex) للنداءات
 *    المتزامنة عبر Promise حتى لا تتداخل BEGIN على نفس الاتصال.
 *  - نداء داخل معاملة مفتوحة (نفس النداء المتسلسل منطقياً): SAVEPOINT/RELEASE —
 *    تراجع جزئي دون كسر المعاملة الأم.
 */
import { Database } from 'bun:sqlite';
import type { SqliteAdapter } from './adapter';

export class BunSqliteAdapter implements SqliteAdapter {
  private readonly db: Database;
  private txDepth = 0;
  private txQueue: Promise<unknown> = Promise.resolve();

  constructor(path: string = ':memory:') {
    this.db = new Database(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  async run(sql: string, params?: unknown[]): Promise<void> {
    this.db.run(sql, ...(params ?? []));
  }

  async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.db.query(sql).all(...(params ?? [])) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) {
      // داخل معاملة مفتوحة — عزل هرمي عبر SAVEPOINT
      const sp = `sp_${this.txDepth}`;
      this.db.exec(`SAVEPOINT ${sp};`);
      this.txDepth += 1;
      try {
        const result = await fn();
        this.db.exec(`RELEASE SAVEPOINT ${sp};`);
        this.txDepth -= 1;
        return result;
      } catch (err) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp};`);
        this.txDepth -= 1;
        throw err;
      }
    }

    // نداء خارجي — يُنفَّذ حصرياً (تسلسل النداءات المتزامنة)
    const run = async (): Promise<T> => {
      this.db.exec('BEGIN;');
      this.txDepth += 1;
      try {
        const result = await fn();
        this.db.exec('COMMIT;');
        this.txDepth -= 1;
        return result;
      } catch (err) {
        this.txDepth -= 1;
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          // الاتصال فُقد — نرمي الخطأ الأصلي
        }
        throw err;
      }
    };
    const result = this.txQueue.then(run, run);
    this.txQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): void {
    this.db.close();
  }
}
