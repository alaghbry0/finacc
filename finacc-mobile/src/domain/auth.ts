/**
 * auth.ts — تسجيل الدخول المحلي برمز PIN + سياسة القفل المتصاعد + المسح الكامل
 * (SRS FR-12-01/03/05/06 — قرار 4).
 *
 * القواعد المنفَّذة:
 *  - مدير واحد ينشئه Onboarding (FR-12-01) — صف app_user الأول هو المستخدم.
 *  - المحاولة الخاطئة ترفع failed_attempts؛ عند 5 محاولات قفل متصاعد
 *    (30 → 60 → 120 → 240 → 480 ثانية، سقف 900 = 15 دقيقة) — FR-12-06.
 *  - عند 10 محاولات: needsHardReset=true (الواجهة تعرض خيار المسح الكامل
 *    بتأكيد مزدوج — «نسيان الرمز = فقدان البيانات» موثَّق هناك).
 *  - الرمز الصحيح يصفّر المحاولات ويحدّث last_login_at.
 *  - wipeAllData: المسح الكامل لكل الجداول (ما عدا _migrations) في معاملة
 *    واحدة مع تأجيل FKs + إسقاط/إعادة تريغرات audit_log append-only + قيد
 *    تدقيق بالمسح (التريغرات تحمي من الأدوات الخارجية لا من المسار النظامي الموثَّق).
 *
 * نقاء الوحدة: adapter + وحدات شقيقة + services/pin (نقي هو نفسه) — NFR-09/11.
 */
import type { SqliteAdapter } from '../db/adapter';
import { verifyPin } from '../services/pin';
import {
  DomainRuleError,
  PinLockedError,
  PinWrongError,
  pinLockDelaySeconds,
  PIN_HARD_RESET_THRESHOLD,
} from './errors';

/** صف المستخدم كما يعيده login (الأعمدة التي تحتاجها الجلسة/الواجهة) */
export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
  failedAttempts: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
}

/** يستدعي التريغرات من الهجرة نفسها — مصدر واحد للحقيقة */
const AUDIT_TRIGGERS_SQL = `DROP TRIGGER IF EXISTS audit_log_no_update;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
DROP TRIGGER IF EXISTS audit_log_no_delete;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`;

/**
 * الجداول كلها (DDL §5.3) بترتيب الأبناء أولاً + PRAGMA defer_foreign_keys
 * أثناء المسح — يحل المراجع الذاتية (invoice.original_invoice_id،
 * cash_tx.reversal_of) التي يعجز عنها الترتيب وحده.
 */
const ALL_TABLES = [
  'payment_allocation',
  'installment',
  'installment_plan',
  'cheque',
  'cash_tx',
  'invoice_item',
  'invoice',
  'stock_movement',
  'stock_level',
  'stocktake_line',
  'stocktake',
  'batch',
  'product_price',
  'product',
  'customer',
  'supplier',
  'shift',
  'expense_category',
  'category',
  'unit',
  'exchange_rate',
  'fiscal_year',
  'doc_sequence',
  'audit_log',
  'backup_log',
  'settings',
  'app_user',
  'cashbox',
  'warehouse',
  'company',
  'currency',
] as const;

/**
 * يحاول تسجيل الدخول برمز PIN.
 * @throws PinLockedError  الدخول مقفل الآن (remainingSeconds للعدّاد)
 * @throws PinWrongError   رمز خاطئ (attemptsLeftBeforeLock قبل القفل)
 * @throws DomainRuleError لا يوجد مستخدم أصلاً (قبل التهيئة)
 */
export async function login(adapter: SqliteAdapter, pin: string): Promise<SessionUser> {
  const rows = await adapter.all<{
    id: number;
    username: string;
    display_name: string;
    role: string;
    pin_hash: string | null;
    failed_attempts: number;
    locked_until: string | null;
    last_login_at: string | null;
  }>('SELECT id, username, display_name, role, pin_hash, failed_attempts, locked_until, last_login_at FROM app_user ORDER BY id LIMIT 1');
  const user = rows[0];
  if (!user) {
    throw new DomainRuleError('NO_USER', 'لا يوجد مستخدم بعد — أكمل التهيئة الأولى للتطبيق');
  }

  // 1) قائم القفل؟ — القراءة قبل أي فحص للرمز
  if (user.locked_until) {
    const until = Date.parse(user.locked_until);
    if (!Number.isNaN(until) && until > Date.now()) {
      const remainingSeconds = Math.ceil((until - Date.now()) / 1000);
      throw new PinLockedError(
        remainingSeconds,
        Number(user.failed_attempts) >= PIN_HARD_RESET_THRESHOLD,
      );
    }
    // القفل منتهي — نسقطه ونكمل الفحص العادي
  }

  // 2) فحص الرمز
  const ok = user.pin_hash !== null && verifyPin(user.pin_hash, pin);
  if (!ok) {
    const attempts = Number(user.failed_attempts) + 1;
    const delay = pinLockDelaySeconds(attempts);
    const lockedUntil =
      delay > 0 ? new Date(Date.now() + delay * 1000).toISOString() : null;
    await adapter.run(
      'UPDATE app_user SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?',
      [attempts, lockedUntil, new Date().toISOString(), user.id],
    );
    if (delay > 0) {
      throw new PinLockedError(delay, attempts >= PIN_HARD_RESET_THRESHOLD);
    }
    throw new PinWrongError(attempts);
  }

  // 3) نجاح — تصفير المحاولات + توثيق آخر دخول
  const now = new Date().toISOString();
  await adapter.run(
    'UPDATE app_user SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?',
    [now, now, user.id],
  );
  return {
    id: Number(user.id),
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    failedAttempts: 0,
    lockedUntil: null,
    lastLoginAt: now,
  };
}

/**
 * مسح كامل لكل البيانات (مسار FR-12-06 الصعب بعد استنفاد المحاولات):
 * كل الصفوف تُحذف ما عدا _migrations (يبقي الهجرات مطبَّقة) — داخل معاملة
 * واحدة، مع إسقاط تريغرات audit_log أثناء المسح وإعادتها بعده، وقيادة
 * عدادات AUTOINCREMENT من جديد، ثم قيد تدقيق يوثّق المسح نفسه.
 */
export async function wipeAllData(adapter: SqliteAdapter): Promise<void> {
  await adapter.transaction(async () => {
    // تأجيل فحوص FK حتى نهاية المعاملة — يحل المراجع الذاتية والمتشابكة
    await adapter.exec('PRAGMA defer_foreign_keys = ON;');
    // التريغرات تمنع DELETE من أي مسار — تُسقط للمسح النظامي الموثَّق وتُعاد بعده
    await adapter.exec(
      'DROP TRIGGER IF EXISTS audit_log_no_update; DROP TRIGGER IF EXISTS audit_log_no_delete;',
    );
    for (const table of ALL_TABLES) {
      await adapter.run(`DELETE FROM ${table}`);
    }
    // إعادة عدادات AUTOINCREMENT (الجدول يوجد فقط بعد أول إدخال)
    const seq = await adapter.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
    );
    if (seq.length > 0) {
      await adapter.run('DELETE FROM sqlite_sequence');
    }
    // إعادة الحماية + قيد التدقيق بالمسح (أول صف في السجل بعد المسح)
    await adapter.exec(AUDIT_TRIGGERS_SQL);
    await adapter.run(
      'INSERT INTO audit_log (user_id, action, entity, entity_id, details, at) VALUES (NULL, ?, ?, NULL, ?, ?)',
      [
        'wipe_all_data',
        'database',
        'مسح كامل لكل البيانات بعد استنفاد محاولات PIN (FR-12-06) — تأكيد مزدوج من المستخدم',
        new Date().toISOString(),
      ],
    );
  });
}
