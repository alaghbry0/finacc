/**
 * test-setup.ts — قاعدة في الذاكرة جديدة مع الهجرات مطبَّقة، لكل اختبار.
 * للاختبارات فقط (bun test) — لا يستورده كود التطبيق.
 */
import type { SqliteAdapter } from './adapter';
import { migrateDb } from './migrate';
import { BunSqliteAdapter } from './test-adapter';

export async function freshDb(): Promise<SqliteAdapter> {
  const adapter = new BunSqliteAdapter(':memory:');
  await migrateDb(adapter);
  return adapter;
}
