/**
 * expo-adapter.ts — تنفيذ SqliteAdapter فوق expo-sqlite (iOS/Android — SRS §3.3).
 *
 * استيراد expo-sqlite لا يحدث إلا هنا وفي client.ts — طبقة Domain لا تعرف هذا الملف.
 * API المستخدمة (SDK 54): openDatabaseAsync / execAsync / runAsync / getAllAsync /
 * withTransactionAsync.
 */
import {
  openDatabaseAsync,
  type SQLiteDatabase,
  type SQLiteBindParams,
} from 'expo-sqlite';
import type { SqliteAdapter } from './adapter';

export const FINACC_DB_NAME = 'finacc.db';

export async function openFinaccDb(name: string = FINACC_DB_NAME): Promise<SqliteAdapter> {
  const db = await openDatabaseAsync(name);
  // WAL مفعّل دائماً (SRS §3.3) — بحماية من البيئات التي لا تدعمه
  try {
    await db.execAsync('PRAGMA journal_mode = WAL;');
  } catch {
    // web/ذاكرة: وضع غير مدعوم — نكمل بوضع المحرّك الافتراضي
  }
  // فرض سلامة المفاتيح الأجنبية (علاقات SRS §5.1)
  try {
    await db.execAsync('PRAGMA foreign_keys = ON;');
  } catch {
    // effort أفضل — لا نمنع الإقلاع
  }
  return new ExpoSqliteAdapter(db);
}

class ExpoSqliteAdapter implements SqliteAdapter {
  constructor(private readonly db: SQLiteDatabase) {}

  async run(sql: string, params?: unknown[]): Promise<void> {
    await this.db.runAsync(sql, (params ?? []) as unknown as SQLiteBindParams);
  }

  async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, (params ?? []) as unknown as SQLiteBindParams);
  }

  async exec(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // withTransactionAsync ترفض إرجاع قيمة — نلتقطها
    let result: T;
    let assigned = false;
    await this.db.withTransactionAsync(async () => {
      result = await fn();
      assigned = true;
    });
    if (!assigned) {
      throw new Error('transaction() لم تُنجز الدالة — انهيار غير متوقع');
    }
    return result!;
  }
}
