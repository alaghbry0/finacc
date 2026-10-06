/**
 * backup.ts — النسخ الاحتياطي المحلي والاستعادة (FR-11 V1: 01/02/04/05/06/08).
 *
 * القرار المعماري الموثَّق (سجل الإعدادات مقابل الحالة التشغيلية):
 *  - **سجل النسخ (FR-11-06) يُخزَّن في جدول backup_log الجاهز في المخطط** — لا في
 *    صف settings: سجل الإعدادات (ملحق هـ) يحكم «السلوكيات القابلة للضبط» حصراً،
 *    وسجل النسخ **حالة تشغيلية** (تاريخ أحداث) لجدوله الخاص المصمم في DDL
 *    (kind/file_name/file_size/checksum/status/at). «آخر نسخة» (backup.last_at)
 *    يُشتق من السجل نفسه (أحدث صف status='ok') — لا حاجة لصف حالة منفصل.
 *  - صيغة الملف: JSON واحد {app, appVersion, schemaVersion, exportedAt, tables,
 *    checksum} — الملف المضغوط SQLite+ZIP (نص FR-11-01 حرفياً) يتطلب كتابة ملفات
 *    النظام على الجهاز → مسار EAS الأصلي (expo-file-system) مؤجَّل V1.1 وموثَّق؛
 *    JSON + مشاركة عبر النظام (FR-11-08) يغطيان نفس الحاجة على الويب الآن.
 *
 * الاستعادة (FR-11-02) — سياسة الإخفاق الموثقة:
 *  1. فحص السلامة: بنية JSON + checksum + app + إصدار المخطط (**أحدث من التطبيق
 *     تُرفض** برسالة واضحة).
 *  2. نسخة أمان تلقائية للبيانات الحالية (تُسلَّم للمستدعي عبر onSafetyBackup
 *     ليحمّلها الملف قبل أي مسح — الوحدة نفسها نقية بلا DOM).
 *  3. الاستبدال داخل معاملة واحدة: PRAGMA defer_foreign_keys (مسموح داخل
 *     المعاملة) → إسقاط تريغرات append-only لـ audit_log مؤقتاً → DELETE كل
 *     جداول البيانات → INSERT كل صفوف النسخة (المفاتيح صراحةً) → إعادة بناء
 *     التريغرات → قيد audit «restore_backup» → COMMIT (فحص FK عند الالتزام —
 *     نسخة داخلية غير متسقة = فشل التزام = بياناتك القديمة سليمة).
 *  4. فشل المنتصف = ROLLBACK = البيانات القديمة كما كانت (ذرّية SQLite).
 *  5. _migrations **لا تُستبدل**: بنية القاعدة الحالية (جداول/أعمدة) هي الحاكمة،
 *     والإصدار المحفوظ فيها موثوق — النسخة الأقدم بياناتٍ فقط.
 *
 * الجدولة (FR-11-04): shouldAutoBackup نقية (يومي/أسبوعي/إيقاف) — إشعار
 * Expo المحلي أصلي → V1: شريط «مرّ وقت نسختك الاحتياطية» في شاشة الإعدادات +
 * نسخ صامت عند فتح التطبيق (يستدعيه الجذر بعد الإقلاع).
 *
 * الاحتفاظ (FR-11-05): آخر N نسخة في السجل (backup.retention_count، افتراضي 7)
 * — الأقدم يُحذف من السجل بعد كل نسخة. حذف «ملفات» النسخ نفسها يتطلب وصول
 * نظام ملفات → مع مسار EAS الأصلي (V1.1).
 *
 * وحدة نقية: adapter + zod + sha256 (بلا DOM/react-native — قابلة للاختبار).
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { MIGRATIONS } from '../db/migrations-manifest';
import { sha256Hex } from '../utils/sha256';
import { DomainRuleError } from '../domain/errors';
import { getSetting } from '../domain/settings';

/** إصدار التطبيق المرافق للنسخة — ثابت المشروع (يُحدَّث مع الإصدارات) */
export const APP_VERSION = '1.0.0';

/** معرّف صيغة ملف النسخة */
export const BACKUP_APP_ID = 'finacc';

/** إصدار المخطط الحالي — من بيان الهجرات (مصدر الحقيقة الوحيد، migrate.ts) */
export const CURRENT_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

export type BackupKind = 'manual' | 'auto' | 'pre_restore';

const DAY_MS = 24 * 3_600_000;

/* ============================ البنية والتحقق ============================ */

export interface BackupTables {
  [table: string]: Record<string, unknown>[];
}

const TablesSchema = z.record(z.string(), z.array(z.record(z.string(), z.unknown())));

export const BackupFileSchema = z.object({
  app: z.literal(BACKUP_APP_ID),
  appVersion: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  exportedAt: z.string(),
  tables: TablesSchema,
  checksum: z.string().length(64),
});

export type BackupFile = z.infer<typeof BackupFileSchema>;

/** تسلسل قياسي (مفاتيح مرتّبة عودياً) — أساس checksum المستقر */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** بصمة النسخة: SHA-256 للصيغة القياسية للمحتوى كله عدا حقل checksum نفسه */
export function computeBackupChecksum(payload: Omit<BackupFile, 'checksum'>): string {
  return sha256Hex(canonicalJson(payload));
}

export interface BackupValidationInfo {
  appVersion: string;
  schemaVersion: number;
  exportedAt: string;
  tableCount: number;
  rowTotal: number;
}

export interface BackupValidation {
  ok: boolean;
  /** رسالة الرفض العربية (ماذا حدث + ما الحل) — null عند النجاح */
  error: string | null;
  info: BackupValidationInfo | null;
}

/** فحص السلامة الكامل (FR-11-02): بنية + checksum + إصدار المخطط */
export function validateBackupText(
  jsonText: string,
  currentSchemaVersion = CURRENT_SCHEMA_VERSION,
): BackupValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: 'الملف ليس نسخة صالحة — تعذّرت قراءته كملف JSON سليم', info: null };
  }
  const parsed = BackupFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'الملف ليس نسخة «المُحاسِب الشخصي» — بنيته لا تطابق صيغة النسخ الاحتياطي',
      info: null,
    };
  }
  const file = parsed.data;

  const { checksum, ...rest } = file;
  if (computeBackupChecksum(rest) !== checksum) {
    return {
      ok: false,
      error: 'بصمة الملف لا تطابق محتواه — يبدو أنه عُدِّل أو تلف أثناء النقل. لا يمكن الاستعادة منه',
      info: null,
    };
  }
  if (file.schemaVersion > currentSchemaVersion) {
    return {
      ok: false,
      error: `النسخة أحدث من التطبيق (مخطط ${file.schemaVersion} والتطبيق ${currentSchemaVersion}) — حدّث التطبيق أولاً ثم استعد`,
      info: null,
    };
  }
  const tableCount = Object.keys(file.tables).length;
  const rowTotal = Object.values(file.tables).reduce((n, rows) => n + rows.length, 0);
  return {
    ok: true,
    error: null,
    info: {
      appVersion: file.appVersion,
      schemaVersion: file.schemaVersion,
      exportedAt: file.exportedAt,
      tableCount,
      rowTotal,
    },
  };
}

/* ============================ التصدير (FR-11-01/08) ============================ */

/** حجم النص بالبايت (UTF-8) — لعرضه في سجل النسخ */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.codePointAt(i)!;
    if (c > 0xffff) i += 1; // الزوج البديل
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** اسم ملف النسخة: finacc-backup-YYYYMMDD-HHmm.json (بتوقيت الجهاز) */
export function backupFileName(prefix: 'backup' | 'safety' = 'backup', now = new Date()): string {
  const p2 = (n: number) => (n < 10 ? `0${n}` : String(n));
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
  return prefix === 'backup' ? `finacc-backup-${stamp}.json` : `finacc-safety-${stamp}.json`;
}

/** كل جداول البيانات (بدون الجداول الداخلية sqlite_*) — يضم _migrations معلوماتياً */
export async function listBackupTables(adapter: SqliteAdapter): Promise<string[]> {
  const rows = await adapter.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((r) => r.name);
}

export interface BuiltBackup {
  json: string;
  fileName: string;
  sizeBytes: number;
  checksum: string;
}

/** يبني نسخة كاملة (كل الجداول) كنص JSON جاهز للتنزيل/المشاركة */
export async function buildBackupJson(adapter: SqliteAdapter): Promise<BuiltBackup> {
  const tables: BackupTables = {};
  for (const table of await listBackupTables(adapter)) {
    tables[table] = await adapter.all(`SELECT * FROM "${table}"`);
  }
  const payload: Omit<BackupFile, 'checksum'> = {
    app: BACKUP_APP_ID,
    appVersion: APP_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tables,
  };
  const checksum = computeBackupChecksum(payload);
  const json = JSON.stringify({ ...payload, checksum });
  return { json, fileName: backupFileName('backup'), sizeBytes: utf8ByteLength(json), checksum };
}

/* ============================ سجل النسخ (FR-11-06) ============================ */

export interface BackupLogRow {
  id: number;
  kind: BackupKind;
  fileName: string | null;
  fileSize: number | null;
  status: string;
  at: string;
}

/** يقرأ حد الاحتفاظ من سجل الإعدادات (ملحق هـ — افتراضي 7) */
async function retentionCount(adapter: SqliteAdapter): Promise<number> {
  return getSetting(adapter, 'backup.retention_count', z.number().int().min(1).max(30), 7);
}

/** يسجّل نسخة + يقصّ السجل على آخر N (FR-11-05 — يحذف الأقدم) */
export async function logBackupEntry(
  adapter: SqliteAdapter,
  entry: { kind: BackupKind; fileName: string; sizeBytes: number; checksum?: string; status?: string },
): Promise<void> {
  await adapter.run(
    `INSERT INTO backup_log (kind, file_name, file_size, checksum, status, at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.kind,
      entry.fileName,
      entry.sizeBytes,
      entry.checksum ?? null,
      entry.status ?? 'ok',
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
  await pruneBackupLog(adapter, await retentionCount(adapter));
}

/** يقصّ السجل على آخر n صف — الأقدم يُحذف (FR-11-05) */
export async function pruneBackupLog(adapter: SqliteAdapter, keep: number): Promise<void> {
  await adapter.run(
    `DELETE FROM backup_log WHERE id NOT IN (SELECT id FROM backup_log ORDER BY id DESC LIMIT ?)`,
    [Math.max(1, Math.trunc(keep))],
  );
}

/** سجل النسخ معروضاً (الأحدث أولاً) */
export async function listBackupLog(adapter: SqliteAdapter): Promise<BackupLogRow[]> {
  const rows = await adapter.all<{
    id: number;
    kind: string;
    file_name: string | null;
    file_size: number | null;
    status: string;
    at: string;
  }>('SELECT id, kind, file_name, file_size, status, at FROM backup_log ORDER BY id DESC');
  return rows.map((r) => ({
    id: Number(r.id),
    kind: (['manual', 'auto', 'pre_restore'] as const).includes(r.kind as BackupKind)
      ? (r.kind as BackupKind)
      : 'manual',
    fileName: r.file_name,
    fileSize: r.file_size === null ? null : Number(r.file_size),
    status: r.status ?? 'ok',
    at: r.at,
  }));
}

/** آخر نسخة ناجحة (ms) — null إن لم تُعمل نسخة قط (يُشتق من السجل نفسه) */
export async function lastBackupAtMs(adapter: SqliteAdapter): Promise<number | null> {
  const rows = await adapter.all<{ at: string }>(
    "SELECT at FROM backup_log WHERE status = 'ok' ORDER BY id DESC LIMIT 1",
  );
  if (!rows[0]) return null;
  const ms = Date.parse(rows[0].at);
  return Number.isFinite(ms) ? ms : null;
}

/* ============================ الجدولة (FR-11-04) ============================ */

/**
 * هل حان وقت النسخة؟ (نقية — تُختبر حدودها)
 *  - off: لا تذكير أبداً.
 *  - null (لم تُعمل نسخة قط): مستحق فوراً — بيانات التاجر تستحق نسخة من اليوم الأول.
 *  - daily: مضى يوم كامل (≥ 24 ساعة)؛ weekly: أسبوع كامل (≥ 7 أيام).
 */
export function shouldAutoBackup(
  schedule: 'daily' | 'weekly' | 'off',
  lastAtMs: number | null,
  nowMs: number,
): boolean {
  if (schedule === 'off') return false;
  if (lastAtMs === null) return true;
  const elapsed = nowMs - lastAtMs;
  if (elapsed < 0) return false; // ساعة الجهاز رجعت للخلف — ننتظر
  return schedule === 'daily' ? elapsed >= DAY_MS : elapsed >= 7 * DAY_MS;
}

/** خطة النسخ من سجل الإعدادات (ملحق هـ — الافتراضي أسبوعي) */
export async function getBackupSchedule(
  adapter: SqliteAdapter,
): Promise<'daily' | 'weekly' | 'off'> {
  return getSetting(adapter, 'backup.schedule', z.enum(['daily', 'weekly', 'off']), 'weekly');
}

/**
 * النسخ الصامت عند فتح التطبيق (FR-11-04): إن حان الوقت حسب الخطة → يبني نسخة
 * ويسجّلها «auto» ويعيدها للمستدعي ليوصلها للتنزيل — وإلا null. لا يرمي: الفشل
 * يُسجَّل في السجل بحالة failed فقط (لا يكسر فتح التطبيق).
 */
export async function maybeAutoBackup(
  adapter: SqliteAdapter,
): Promise<BuiltBackup | null> {
  const schedule = await getBackupSchedule(adapter);
  const lastAt = await lastBackupAtMs(adapter);
  if (!shouldAutoBackup(schedule, lastAt, Date.now())) return null;
  try {
    const built = await buildBackupJson(adapter);
    await logBackupEntry(adapter, {
      kind: 'auto',
      fileName: built.fileName,
      sizeBytes: built.sizeBytes,
      checksum: built.checksum,
    });
    return built;
  } catch (err) {
    try {
      await adapter.run(
        `INSERT INTO backup_log (kind, file_name, file_size, status, at, created_at)
         VALUES ('auto', NULL, NULL, 'failed', ?, ?)`,
        [new Date().toISOString(), new Date().toISOString()],
      );
    } catch {
      // حتى التسجيل فشل — لا شيء آخر نفعله بصدق
    }
    console.warn('[backup] فشلت النسخة التلقائية:', err);
    return null;
  }
}

/* ============================ الاستعادة (FR-11-02) ============================ */

/** إعادة بناء تريغرات append-only (نفس نص الهجرة 0000 حرفياً) */
const AUDIT_TRIGGERS_SQL = `
DROP TRIGGER IF EXISTS audit_log_no_update;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
DROP TRIGGER IF EXISTS audit_log_no_delete;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;

export interface ImportOptions {
  /** تسليم نسخة الأمان (المحتوى + الاسم) قبل الاستبدال — يُنتظر؛ رميُه يوقف الاستعادة */
  onSafetyBackup?: (backup: BuiltBackup) => void | Promise<void>;
}

export interface ImportResult {
  safety: BuiltBackup;
  tableCount: number;
  rowTotal: number;
}

/**
 * يستبدل كل البيانات بمحتوى نسخة — السياسة الكاملة موثّقة في رأس الوحدة.
 * يرمي DomainRuleError عربية واضحة عند كل سبب رفض (بنية/بصمة/إصدار أحدث/جدول
 * مجهول) — والفشل داخل المعاملة = ROLLBACK = البيانات القديمة كما كانت.
 */
export async function importBackupJson(
  adapter: SqliteAdapter,
  jsonText: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  // 1) فحص السلامة (يرمي بصيغة موحّدة للشاشة)
  const validation = validateBackupText(jsonText);
  if (!validation.ok || !validation.info) {
    throw new DomainRuleError('BACKUP_INVALID', validation.error ?? 'نسخة غير صالحة');
  }
  const file = BackupFileSchema.parse(JSON.parse(jsonText));

  // 2) نسخة أمان للبيانات الحالية — قبل أي مسح (FR-11-02). يُنتظر التسليم:
  // فشل تنزيلها (أو رمي مسار الأصلي) يوقف الاستعادة قبل أي كتابة.
  const safety = await buildBackupJson(adapter);
  safety.fileName = backupFileName('safety');
  await opts.onSafetyBackup?.(safety);

  // 3) الاستبدال الذرّي
  await adapter.transaction(async () => {
    // تأجيل فحوص FK إلى لحظة الالتزام — يسمح بأي ترتيب حذف/إدراج داخل المعاملة
    // ويضمن أن النسخة الداخلية غير المتسقة تفشل عند COMMIT لا بعد المسح.
    await adapter.exec('PRAGMA defer_foreign_keys = ON;');
    // التريغرات تمنع مسح audit_log — نُسقطها ونُعيد بناءها داخل المعاملة نفسها
    await adapter.exec(
      'DROP TRIGGER IF EXISTS audit_log_no_update; DROP TRIGGER IF EXISTS audit_log_no_delete;',
    );

    // مسح كل جداول البيانات الحالية — _migrations يبقى (البنية الحالية هي الحاكمة)
    for (const table of await listBackupTables(adapter)) {
      if (table === '_migrations') continue;
      await adapter.run(`DELETE FROM "${table}"`);
    }

    // إدراج كل صفوف النسخة (المفاتيح صراحةً — الأعمدة كما في ملف النسخة)
    for (const table of Object.keys(file.tables).sort()) {
      if (table === '_migrations') continue;
      const rows = file.tables[table];
      for (const row of rows) {
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        const placeholders = cols.map(() => '?').join(', ');
        await adapter.run(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
          cols.map((c) => row[c] ?? null),
        );
      }
    }

    // قيد الاستعادة — يُكتب فوق البيانات المستعادة ليبقى في السجل الجديد
    await adapter.run(
      'INSERT INTO audit_log (user_id, action, entity, entity_id, details, at) VALUES (NULL, ?, ?, NULL, ?, ?)',
      [
        'restore_backup',
        'backup',
        JSON.stringify({
          schemaVersion: file.schemaVersion,
          appVersion: file.appVersion,
          exportedAt: file.exportedAt,
          safetyFile: safety.fileName,
        }),
        new Date().toISOString(),
      ],
    );

    // إعادة تريغرات الحماية قبل الالتزام
    await adapter.exec(AUDIT_TRIGGERS_SQL);
  });

  // 4) سجل النسخة الوقائية — بعد نجاح الالتزام (لو كُتب قبلها لمسحته الاستعادة)
  await logBackupEntry(adapter, {
    kind: 'pre_restore',
    fileName: safety.fileName,
    sizeBytes: safety.sizeBytes,
    checksum: safety.checksum,
  });

  return { safety, tableCount: validation.info.tableCount, rowTotal: validation.info.rowTotal };
}

/* ============================ فحص السلامة (FR-13-07) ============================ */

export interface IntegrityResult {
  ok: boolean;
  /** رسالة النتيجة عربية — «سليمة» أو أول خلل وجد */
  message: string;
  foreignKeyViolations: number;
}

/** فحص سلامة القاعدة: PRAGMA integrity_check + foreign_key_check */
export async function checkIntegrity(adapter: SqliteAdapter): Promise<IntegrityResult> {
  const integrityRows = await adapter.all<{ integrity_check?: string; [k: string]: unknown }>(
    'PRAGMA integrity_check',
  );
  const integrityOk =
    integrityRows.length === 1 && String(integrityRows[0]?.integrity_check ?? '') === 'ok';
  const fkRows = await adapter.all<Record<string, unknown>>('PRAGMA foreign_key_check');
  const fkCount = fkRows.length;
  if (integrityOk && fkCount === 0) {
    return { ok: true, message: 'القاعدة سليمة — لا أخطاء بنية ولا مراجع مكسورة', foreignKeyViolations: 0 };
  }
  const problems: string[] = [];
  if (!integrityOk) problems.push('خلل في بنية الصفحات');
  if (fkCount > 0) problems.push(`${fkCount} ${fkCount === 1 ? 'مرجع مكسور' : 'مراجع مكسورة'}`);
  return {
    ok: false,
    message: `فحص السلامة وجد: ${problems.join(' و')} — خذ نسخة احتياطية الآن وراجع دعم الفني`,
    foreignKeyViolations: fkCount,
  };
}

/** حجم القاعدة بالبايت (page_count × page_size) وعدد صفوف الجداول الرئيسية */
export async function getDbStats(adapter: SqliteAdapter): Promise<{
  sizeBytes: number;
  tableCounts: { table: string; rows: number }[];
}> {
  const pc = await adapter.all<{ page_count: number | string }>('PRAGMA page_count');
  const ps = await adapter.all<{ page_size: number | string }>('PRAGMA page_size');
  const sizeBytes = Number(pc[0]?.page_count ?? 0) * Number(ps[0]?.page_size ?? 0);
  const tables = await listBackupTables(adapter);
  const tableCounts: { table: string; rows: number }[] = [];
  for (const table of tables) {
    if (table === '_migrations') continue;
    const rows = await adapter.all<{ c: number | string }>(`SELECT COUNT(*) AS c FROM "${table}"`);
    tableCounts.push({ table, rows: Number(rows[0]?.c ?? 0) });
  }
  tableCounts.sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table));
  return { sizeBytes, tableCounts };
}
