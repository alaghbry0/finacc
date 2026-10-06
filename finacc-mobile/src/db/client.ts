/**
 * client.ts — عميل القاعدة للمنصات الأصلية (iOS/Android): expo-sqlite + WAL + الهجرات.
 *
 * على الويب يحلّ metro ملف client.web.ts محل هذا الملف تلقائياً — لكن واجهتهما متطابقة:
 * getDb() / dbReady().
 *
 * ملاحظة: عرض الويب لا يدعم expo-sqlite 15.x (الوحدة أصلية فقط — platforms: apple/android)
 * والتحقق الموثق في سجل العمل؛ client.web.ts هو المسار الفعلي هناك.
 */
import type { SqliteAdapter } from './adapter';
import { openFinaccDb } from './expo-adapter';
import { migrateDb } from './migrate';

let dbPromise: Promise<SqliteAdapter> | null = null;

/** تهيئة singleton: فتح القاعدة + WAL + الهجرات — يستدعى مرة واحدة */
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
  const adapter = await openFinaccDb();
  const result = await migrateDb(adapter);
  console.log(`[db] finacc.db جاهزة — هجرات مطبَّقة: ${result.applied}، آخر إصدار: ${result.latestVersion}`);
  return adapter;
}
