/**
 * migrate.ts — نظام الهجرات (SRS §3.3: كل تغيير مخطط = ملف هجرة يُسجَّل في _migrations).
 *
 * يعمل بالتطابق على expo-sqlite (التطبيق) وbun:sqlite (الاختبارات) وsql.js (الويب)
 * لأنه يستخدم عقد SqliteAdapter فقط.
 *
 * الخصائص:
 *  - idempotent: الهجرات المطبَّقة (version مسجَّل في _migrations) تُتخطَّى.
 *  - كل هجرة تُطبَّق داخل transaction واحدة مع تسجيل version في نفس المعاملة —
 *    فشل التنفيذ يرجع الهجرة كاملة (ذرّية الهجرات).
 *  - جدول _migrations ببنية SRS §5.3: id INTEGER PRIMARY KEY, version INTEGER, applied_at TEXT.
 */
import type { SqliteAdapter } from './adapter';
import { MIGRATIONS } from './migrations-manifest';

export interface MigrateResult {
  /** عدد الهجرات المطبَّقة فعلياً في هذه النداء (0 = كانت محدَّثة) */
  applied: number;
  /** أعلى رقم إصدار مطبَّق بعد التنفيذ */
  latestVersion: number;
}

const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  applied_at TEXT
)`;

export async function migrateDb(adapter: SqliteAdapter): Promise<MigrateResult> {
  await adapter.exec(MIGRATIONS_TABLE_DDL);

  const appliedRows = await adapter.all<{ version: number | string }>(
    'SELECT version FROM _migrations',
  );
  const applied = new Set(appliedRows.map((r) => Number(r.version)));

  let count = 0;
  let latest = -1;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      latest = Math.max(latest, migration.version);
      continue;
    }
    await adapter.transaction(async () => {
      // نص الهجرة كاملاً كسلسلة واحدة — exec() يفهم الجمل المتعددة وأجسام التريغرات
      // (BEGIN...END;) دون تقسيم هش.
      await adapter.exec(migration.statements.join('\n'));
      await adapter.run('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)', [
        migration.version,
        new Date().toISOString(),
      ]);
    });
    applied.add(migration.version);
    latest = Math.max(latest, migration.version);
    count += 1;
  }

  return { applied: count, latestVersion: latest };
}
