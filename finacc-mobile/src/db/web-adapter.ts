/**
 * web-adapter.ts — تنفيذ SqliteAdapter للويب عبر sql.js (SQLite WASM).
 *
 * ⚠️ لماذا هذا الملف موجود: تحقق عملي (سجل العمل — المهمة 2): expo-sqlite 15.x
 * وحدة أصلية فقط (expo-module.config: platforms apple/android) — استيرادها على
 * الويب يرمي «Cannot find native module 'ExpoSQLite'» وقت تحميل الحزمة ويُسقط
 * التطبيق كله. لذا مسار الويب = sql.js، ومسار الأصل = expo-adapter.ts
 * (الاختيار عبر ملفات المنصة client.ts / client.web.ts — بلا فحص وقت تشغيل).
 *
 * التحميل: <script src="/rn/sql-wasm.js"> (UMD كلاسيكي → window.initSqlJs) ثم
 * locateFile → /rn/sql-wasm.wasm — كلاهما يُنسخ للتصدير عبر scripts/build-rn-web.sh.
 * سبب التحميل عبر وسم سكربت بدل حزمته عبر metro: صقيل emscripten يتطلب require('fs')
 * في فرع Node داخله — metro يعجز عن حله ويكسر الحزمة؛ كملف ثابت يُخدم كما هو بلا أي
 * أثر على حجم حزمة التطبيق.
 *
 * الاستمرارية: صورة القاعدة تُصدَّر (db.export()) إلى IndexedDB خام (بلا اعتماد
 * إضافي) بعد كل كتابة (debounce) وتُحمَّل عند الإقلاع — مفتاح «finacc-db».
 */
import type { SqliteAdapter } from './adapter';

/* ============ أنواع sql.js الدنيا (لا نستورد الحزمة — تُحمَّل كسكربت) ============ */

interface SqlJsStatement {
  bind(params?: unknown[]): boolean;
  step(): boolean;
  getAsObject(params?: unknown[]): Record<string, unknown>;
  free(): boolean;
}
interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}
interface SqlJsModule {
  Database: new (data?: ArrayLike<number> | null) => SqlJsDatabase;
}
type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsModule>;

declare global {
  interface Window {
    initSqlJs?: InitSqlJs;
  }
}

/* ============ ثوابت ============ */

const SQLJS_SCRIPT_URL = '/rn/sql-wasm.js';
const SQLJS_WASM_DIR = '/rn/';
const IDB_NAME = 'finacc';
const IDB_STORE = 'dbs';
const IDB_KEY = 'finacc-db';
const SAVE_DEBOUNCE_MS = 400;

/* ============ تحميل المحرّك ============ */

let sqlJsModulePromise: Promise<SqlJsModule> | null = null;

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-finacc-sqljs]`);
    if (existing) {
      if (window.initSqlJs) resolve();
      else {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error(`فشل تحميل ${src}`)));
      }
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.dataset.finaccSqljs = '1';
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`فشل تحميل محرّك SQLite للويب: ${src}`));
    document.head.appendChild(el);
  });
}

async function loadSqlJs(): Promise<SqlJsModule> {
  if (!sqlJsModulePromise) {
    sqlJsModulePromise = (async () => {
      await injectScript(SQLJS_SCRIPT_URL);
      const init = window.initSqlJs;
      if (!init) {
        throw new Error('window.initSqlJs غير موجود بعد تحميل sql-wasm.js');
      }
      return init({ locateFile: (file) => SQLJS_WASM_DIR + file });
    })().catch((err) => {
      sqlJsModulePromise = null; // نسمح بإعادة المحاولة
      throw err;
    });
  }
  return sqlJsModulePromise;
}

/* ============ IndexedDB خام (بلا اعتماد إضافي) ============ */

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('فشل فتح IndexedDB'));
  });
}

async function idbGet(key: string): Promise<Uint8Array | null> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('فشل قراءة القاعدة من IndexedDB'));
  });
}

async function idbPut(key: string, value: Uint8Array): Promise<void> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('فشل حفظ القاعدة في IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('أُلغيت معاملة الحفظ'));
  });
}

/* ============ المحوّل ============ */

class WebSqliteAdapter implements SqliteAdapter {
  private readonly db: SqlJsDatabase;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(db: SqlJsDatabase) {
    this.db = db;
    // حفظ أخير عند إخفاء الصفحة (إغلاق التبويب/التنقل) — بلا انتظار الـ debounce
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => {
        void this.flushNow();
      });
    }
  }

  async run(sql: string, params?: unknown[]): Promise<void> {
    this.db.run(sql, params ?? []);
    this.scheduleSave();
  }

  async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params ?? []);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
    this.scheduleSave();
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN;');
    try {
      const result = await fn();
      this.db.exec('COMMIT;');
      this.scheduleSave();
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // الاتصال فُقد — نرمي الخطأ الأصلي
      }
      throw err;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private async flushNow(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const image = this.db.export();
      // نسدّ السلسلة حتى لا تتسارع الكتابات المتوازية على IndexedDB
      this.saving = this.saving.then(() => idbPut(IDB_KEY, image));
      await this.saving;
    } catch (err) {
      console.warn('[web-adapter] تعذّر حفظ صورة القاعدة في IndexedDB:', err);
    }
  }
}

/* ============ النقطة العامة ============ */

/**
 * يفتح (أو يستأنف) قاعدة الويب: تحميل محرّك sql.js → قراءة الصورة من IndexedDB
 * → إنشاء المحوّل. الهجرات يديرها client.web.ts بعد الفتح.
 */
export async function openFinaccWebDb(): Promise<SqliteAdapter> {
  const SQL = await loadSqlJs();
  const image = await idbGet(IDB_KEY).catch(() => null);
  const db = image && image.byteLength > 0 ? new SQL.Database(image) : new SQL.Database();
  const adapter = new WebSqliteAdapter(db);
  // WAL (SRS §3.3): على sql.js القاعدة صورة في الذاكرة — الطلب مقبول لكنه بلا أثر؛
  // نحميه بـ try/catch وفقاً للقرار الموثق.
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // بلا أثر
  }
  try {
    db.exec('PRAGMA foreign_keys = ON;');
  } catch {
    // effort أفضل — لا نمنع الإقلاع
  }
  return adapter;
}
