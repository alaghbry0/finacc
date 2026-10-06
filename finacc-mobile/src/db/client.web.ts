/**
 * client.web.ts — عميل القاعدة للويب: sql.js (SQLite WASM) + IndexedDB + الهجرات.
 *
 * يحلّ metro هذا الملف تلقائياً محل client.ts عند تصدير الويب (امتداد .web.ts) —
 * بلا فحص Platform وقت التشغيل وبلا إدخال expo-sqlite في حزمة الويب أصلاً.
 * السبب الموثق (تحقق عملي، سجل العمل المهمة 2): expo-sqlite 15.x أصلية فقط —
 * استيرادها على الويب يرمي «Cannot find native module 'ExpoSQLite'» وقت تحميل
 * الحزمة ويُسقط التطبيق. الواجهة مطابقة تماماً لclient.ts: getDb() / dbReady().
 */
import type { SqliteAdapter } from './adapter';
import { migrateDb } from './migrate';
import { openFinaccWebDb } from './web-adapter';

let dbPromise: Promise<SqliteAdapter> | null = null;

/** تهيئة singleton: تحميل sql.js + استئناف الصورة من IndexedDB + الهجرات */
export function getDb(): Promise<SqliteAdapter> {
  if (!dbPromise) {
    dbPromise = init().catch((err) => {
      dbPromise = null; // نسمح بإعادة المحاولة عند فشل التهيئة
      throw err;
    });
  }
  return dbPromise;
}

/** تنتظر جهوزية القاعدة (للشاشة الجذرية) */
export async function dbReady(): Promise<void> {
  await getDb();
}

async function init(): Promise<SqliteAdapter> {
  const adapter = await openFinaccWebDb();
  const result = await migrateDb(adapter);
  console.log(
    `[db] finacc.db (ويب/sql.js) جاهزة — هجرات مطبَّقة: ${result.applied}، آخر إصدار: ${result.latestVersion}`,
  );
  return adapter;
}
