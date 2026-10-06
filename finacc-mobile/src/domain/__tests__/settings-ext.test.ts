/**
 * اختبارات إعدادات المنشأة + بدء الترقيم + البيانات المرجعية + النسخ الاحتياطي
 * (Task 15 — FR-13-01/02/06 + FR-11 V1: 01/02/04/05/06).
 */
import { describe, expect, test } from 'bun:test';
import { freshDb } from '../../db/test-setup';
import { seededDb, daysAgoISO } from './seed';
import {
  getCompanyProfile,
  updateCompanyProfile,
  setDocSequenceStart,
  listDocSequences,
} from '../settings-ext';
import {
  createExpenseCategory,
  renameExpenseCategory,
  archiveExpenseCategory,
  listExpenseCategories,
  renameUnit,
  archiveUnit,
  listUnitsDetailed,
  renameWarehouse,
  listWarehousesDetailed,
  createCashbox,
  renameCashbox,
  archiveCashbox,
  listCashboxesDetailed,
  createCurrency,
  activateCurrency,
  deactivateCurrency,
  listCurrenciesDetailed,
} from '../reference';
import { setSetting, getSetting } from '../settings';
import { nextDocNo } from '../docseq';
import { saveInvoice } from '../invoicing';
import {
  buildBackupJson,
  importBackupJson,
  validateBackupText,
  shouldAutoBackup,
  logBackupEntry,
  listBackupLog,
  lastBackupAtMs,
  backupFileName,
  computeBackupChecksum,
  CURRENT_SCHEMA_VERSION,
  BACKUP_APP_ID,
  maybeAutoBackup,
  checkIntegrity,
} from '../../services/backup';

/* ============ مساعدات ============ */

async function countRows(db: Parameters<typeof listBackupLog>[0], table: string): Promise<number> {
  const rows = await db.all<{ c: number | string }>(`SELECT COUNT(*) AS c FROM "${table}"`);
  return Number(rows[0]?.c ?? 0);
}

async function tableCounts(db: Parameters<typeof listBackupLog>[0]): Promise<Record<string, number>> {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.name] = await countRows(db, r.name);
  return out;
}

/** بذرة فاتورة بيع نقدية مكتملة (تستهلك رقم INV) — سطر خدمي بلا مخزون */
async function seedInvoice(db: Awaited<ReturnType<typeof seededDb>>['db'], seed: Awaited<ReturnType<typeof seededDb>>['seed']): Promise<number> {
  const res = await saveInvoice(db, {
    docType: 'sale',
    payStatus: 'cash',
    status: 'completed',
    issuedAt: daysAgoISO(0),
    customerId: seed.customerId,
    cashboxId: seed.cashboxId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.deliveryId, qty: '1', unitPrice: '50' }],
  });
  return res.invoiceId;
}

/* ============================ 1) بيانات المنشأة ============================ */

describe('updateCompanyProfile — بيانات المنشأة (FR-13-01/02)', () => {
  test('اسم فارغ → رفض زود عربي', async () => {
    const { db } = await seededDb();
    await expect(updateCompanyProfile(db, { name: '   ' })).rejects.toThrow('اسم المنشأة مطلوب');
  });

  test('بادئة ترقيم غير صالحة (صغيرة/قصيرة) → رفض، والصحيحة تُقبل', async () => {
    const { db } = await seededDb();
    await expect(updateCompanyProfile(db, { invoicePrefix: 'inv' })).rejects.toThrow('بادئة الترقيم');
    await expect(updateCompanyProfile(db, { invoicePrefix: 'I' })).rejects.toThrow('بادئة الترقيم');
    await expect(updateCompanyProfile(db, { invoicePrefix: 'FA2' })).resolves.toBeUndefined();
    const profile = await getCompanyProfile(db);
    expect(profile?.invoice_prefix).toBe('FA2');
  });

  test('تحديث جزئي: الحقول غير المرسلة تبقى، المرسلة تتغير + updated_at + قيد audit', async () => {
    const { db } = await seededDb();
    const before = await getCompanyProfile(db);
    await updateCompanyProfile(db, { phone: '777123456', taxNumber: 'TAX-99' });
    const after = await getCompanyProfile(db);
    expect(after?.phone).toBe('777123456');
    expect(after?.tax_number).toBe('TAX-99');
    expect(after?.name).toBe(before?.name); // لم تُرسل → بقيت
    const audits = await db.all<{ action: string; details: string }>(
      "SELECT action, details FROM audit_log WHERE action = 'company_update'",
    );
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0]!.details).changed).toEqual(['phone', 'taxNumber']);
  });

  test('null تفرغ الحقل القابل للفراغ (التذييل) — دلالة patch صريحة', async () => {
    const { db } = await seededDb();
    await db.run("UPDATE company SET footer_text = 'شكراً' WHERE id = (SELECT MIN(id) FROM company)");
    await updateCompanyProfile(db, { footerText: null });
    const profile = await getCompanyProfile(db);
    expect(profile?.footer_text).toBeNull();
  });

  test('لا شركة في القاعدة → رفض صادق', async () => {
    const db = await freshDb();
    await expect(updateCompanyProfile(db, { name: 'متجر' })).rejects.toThrow(
      'لا توجد بيانات منشأة بعد',
    );
  });
});

/* ============================ 2) بدء الترقيم (FR-13-02 — قرار 6) ============================ */

describe('setDocSequenceStart — رقم البداية قبل أول مستند فقط', () => {
  test('يُقبل قبل الإصدار: startNo=100 → الرقم التالي -00100 + قيد audit', async () => {
    const db = await freshDb();
    await setDocSequenceStart(db, 'INV', 2026, 100);
    const rows = await db.all<{ last_no: number }>(
      'SELECT last_no FROM doc_sequence WHERE doc_type = ? AND year = ?',
      ['INV', 2026],
    );
    expect(Number(rows[0]!.last_no)).toBe(99);
    expect(await nextDocNo(db, 'INV', '2026-05-01', 'INV')).toBe('INV-2026-00100');
    const audits = await db.all<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'docseq_start'",
    );
    expect(audits.length).toBe(1);
  });

  test('يُرفض بعد إصدار أول مستند — «الرقم لا يُعدَّل بعد الإصدار» (قرار 6)', async () => {
    const db = await freshDb();
    await nextDocNo(db, 'PUR', '2026-01-05', 'PUR');
    await expect(setDocSequenceStart(db, 'PUR', 2026, 50)).rejects.toThrow(
      'الرقم لا يُعدَّل بعد الإصدار',
    );
  });

  test('startNo أقل من 1 أو غير صحيح → رفض (ترقيم 1-based)', async () => {
    const db = await freshDb();
    await expect(setDocSequenceStart(db, 'RVT', 2026, 0)).rejects.toThrow('رقم البداية');
    await expect(setDocSequenceStart(db, 'RVT', 2026, 2.5)).rejects.toThrow('رقم البداية');
  });

  test('سنة خارج النطاق → رفض', async () => {
    const db = await freshDb();
    await expect(setDocSequenceStart(db, 'INV', 1999, 1)).rejects.toThrow('السنة');
    await expect(setDocSequenceStart(db, 'INV', 2101, 1)).rejects.toThrow('السنة');
  });

  test('listDocSequences: INV مقفلة بعد فاتورة مكتملة (issued=1) والبقية مفتوحة', async () => {
    const { db, seed } = await seededDb();
    await seedInvoice(db, seed);
    const rows = await listDocSequences(db, new Date().getFullYear());
    const inv = rows.find((r) => r.docType === 'INV')!;
    const pur = rows.find((r) => r.docType === 'PUR')!;
    expect(inv.locked).toBe(true);
    expect(inv.lastNo).toBe(1);
    expect(inv.issuedCount).toBe(1);
    expect(inv.nextNo).toBe(`INV-${new Date().getFullYear()}-00002`);
    expect(pur.locked).toBe(false);
    expect(pur.lastNo).toBe(0);
    expect(pur.issuedCount).toBe(0);
  });
});

/* ============================ 3) البيانات المرجعية (FR-13-06) ============================ */

describe('البيانات المرجعية — CRUD خفيف محميّ بالحركات', () => {
  test('فئات المصاريف: إنشاء + اسم مكرر مرفوض + إعادة تسمية + audit', async () => {
    const { db } = await seededDb();
    const created = await createExpenseCategory(db, 'كهرباء');
    expect(created.id).toBeGreaterThan(0);
    await expect(createExpenseCategory(db, 'كهرباء')).rejects.toThrow('بنفس الاسم');
    await renameExpenseCategory(db, created.id, 'كهرباء ومياه');
    const cats = await listExpenseCategories(db);
    expect(cats.find((c) => c.id === created.id)?.name).toBe('كهرباء ومياه');
    const audits = await db.all<{ action: string }>(
      "SELECT action FROM audit_log WHERE action IN ('ref_create','ref_rename') AND entity = 'expense_category'",
    );
    expect(audits.length).toBe(2);
  });

  test('تعطيل فئة مستخدمة في مصروف → رفض «مستخدمة في حركات»', async () => {
    const { db, seed } = await seededDb();
    const cat = await createExpenseCategory(db, 'صيانة');
    await db.run(
      `INSERT INTO cash_tx (tx_type, cashbox_id, currency_id, amount, exchange_rate, tx_date, expense_category_id, created_at)
       VALUES ('expense', ?, ?, '500', '1', ?, ?, ?)`,
      [seed.cashboxId, seed.yerId, daysAgoISO(0), cat.id, new Date().toISOString()],
    );
    await expect(archiveExpenseCategory(db, cat.id)).rejects.toThrow('مستخدمة في');
    // فئة بلا حركات تُعطَّل
    const free = await createExpenseCategory(db, 'ضيافة');
    await expect(archiveExpenseCategory(db, free.id)).resolves.toBeUndefined();
    const cats = await listExpenseCategories(db);
    expect(cats.find((c) => c.id === free.id)?.isArchived).toBe(true);
  });

  test('الوحدات: إعادة تسمية آمنة؛ التعطيل مرفوض لوحدة مرتبطة بأصناف', async () => {
    const { db, seed } = await seededDb();
    const unit = await db.all<{ id: number }>("INSERT INTO unit (name, factor, created_at, updated_at) VALUES ('كرتون', '12', ?, ?) RETURNING id", [new Date().toISOString(), new Date().toISOString()]);
    const unitId = Number(unit[0]!.id);
    await renameUnit(db, unitId, 'كراتين');
    expect((await listUnitsDetailed(db)).find((u) => u.id === unitId)?.name).toBe('كراتين');
    await db.run('UPDATE product SET unit_id = ? WHERE id = ?', [unitId, seed.milkId]);
    await expect(archiveUnit(db, unitId)).rejects.toThrow('مستخدمة في');
  });

  test('المخازن: إعادة تسمية فقط (بلا حذف أبداً) — آمنة مع الحركات', async () => {
    const { db, seed } = await seededDb();
    await renameWarehouse(db, seed.warehouseId, 'المستودع الكبير');
    const list = await listWarehousesDetailed(db);
    expect(list.find((w) => w.id === seed.warehouseId)?.name).toBe('المستودع الكبير');
    expect(list.find((w) => w.id === seed.warehouseId)?.isDefault).toBe(true);
  });

  test('الصناديق: إنشاء بعملة مفعّلة؛ الافتراضي لا يُعطَّل؛ المستخدم لا يُعطَّل', async () => {
    const { db, seed } = await seededDb();
    const box = await createCashbox(db, { name: 'صندوق الفرع', currencyId: seed.yerId });
    await renameCashbox(db, box.id, 'صندوق الفرع الثاني');
    expect((await listCashboxesDetailed(db)).find((c) => c.id === box.id)?.name).toBe('صندوق الفرع الثاني');
    await expect(archiveCashbox(db, seed.cashboxId)).rejects.toThrow('الصندوق الافتراضي');
    await db.run(
      `INSERT INTO cash_tx (tx_type, cashbox_id, currency_id, amount, exchange_rate, tx_date, created_at)
       VALUES ('expense', ?, ?, '100', '1', ?, ?)`,
      [box.id, seed.yerId, daysAgoISO(0), new Date().toISOString()],
    );
    await expect(archiveCashbox(db, box.id)).rejects.toThrow('مستخدمة في');
  });

  test('العملات: إنشاء غير أساسية + رمز مكرر/أساس مرفوض + تفعيل SAR المعطّلة', async () => {
    const { db, seed } = await seededDb();
    const kwd = await createCurrency(db, { code: 'kwd', name: 'دينار كويتي', decimals: 3 });
    const list = await listCurrenciesDetailed(db);
    expect(list.find((c) => c.id === kwd.id)?.code).toBe('KWD'); // يُطبَّع uppercase
    await expect(createCurrency(db, { code: 'KWD', name: 'مكرر', decimals: 2 })).rejects.toThrow('بهذا الرمز');
    await expect(createCurrency(db, { code: 'YER', name: 'مكرر أساس', decimals: 0 })).rejects.toThrow('العملة الأساسية');
    // SAR في البذرة مفعّلة → نعطّلها ثم نعيد تفعيلها (مسار التهيئة الحقيقي: غير مفعّلة حتى أول سعر)
    await db.run('UPDATE currency SET is_active = 0 WHERE id = ?', [seed.sarId]);
    await activateCurrency(db, seed.sarId);
    expect((await listCurrenciesDetailed(db)).find((c) => c.id === seed.sarId)?.isActive).toBe(true);
  });

  test('تعطيل العملة: الأساس مرفوض دائماً؛ المستخدمة بأسعار مرفوضة بصدق', async () => {
    const { db, seed } = await seededDb();
    await expect(deactivateCurrency(db, seed.yerId)).rejects.toThrow('لا يُعطَّل');
    await db.run(
      `INSERT INTO exchange_rate (currency_id, rate_date, rate, source, created_at)
       VALUES (?, ?, '530', 'manual', ?)`,
      [seed.sarId, daysAgoISO(0), new Date().toISOString()],
    );
    await expect(deactivateCurrency(db, seed.sarId)).rejects.toThrow('مستخدمة في');
  });
});

/* ============================ 4) setSetting + audit ============================ */

describe('setSetting — كتابة السجل + قيد audit (settings_change)', () => {
  test('الكتابة تنشئ صف الإعداد وقيد audit معاً؛ المفتاح المجهول يُرفض بلا أي أثر', async () => {
    const db = await freshDb();
    await setSetting(db, 'backup.schedule', 'daily');
    expect(await getSetting(db, 'backup.schedule', (await import('zod')).z.enum(['daily', 'weekly', 'off']), 'weekly')).toBe('daily');
    const audits = await db.all<{ action: string; details: string }>(
      "SELECT action, details FROM audit_log WHERE action = 'settings_change'",
    );
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0]!.details).key).toBe('backup.schedule');
    await expect(setSetting(db, 'not.a.key', 1)).rejects.toThrow('مفتاح إعداد غير معروف');
    const after = await db.all<{ action: string }>("SELECT action FROM audit_log WHERE action = 'settings_change'");
    expect(after.length).toBe(1); // المحاولة المرفوضة لا تُسجَّل
  });
});

/* ============================ 5) النسخ الاحتياطي (FR-11) ============================ */

describe('النسخ الاحتياطي — التصدير والاستعادة', () => {
  test('دورة كاملة: بذرة → تصدير → مزيد من البيانات → استيراد → العودة لحالة التصدير', async () => {
    const { db, seed } = await seededDb();
    await seedInvoice(db, seed);
    await setSetting(db, 'backup.schedule', 'weekly');
    const backup = await buildBackupJson(db);
    const countsAtExport = await tableCounts(db);

    // بيانات إضافية بعد التصدير (يجب أن تختفي بعد الاستيراد)
    await seedInvoice(db, seed);
    await setSetting(db, 'backup.schedule', 'daily');
    await db.run("UPDATE company SET name = 'متغيّر' WHERE id = (SELECT MIN(id) FROM company)");
    expect(await countRows(db, 'invoice')).toBe(countsAtExport.invoice! + 1);

    const result = await importBackupJson(db, backup.json);
    expect(result.rowTotal).toBeGreaterThan(0);
    // كل جداول البيانات تعود لحالة التصدير حرفياً — عدا سجلَّي ما بعد الاستعادة
    // (audit_log يقيد restore_backup وbackup_log يقيد pre_restore — توثيق مقصود)
    const after = await tableCounts(db);
    const expected = { ...countsAtExport };
    expected.audit_log = (countsAtExport.audit_log ?? 0) + 1;
    expected.backup_log = (countsAtExport.backup_log ?? 0) + 1;
    expect(after).toEqual(expected);
    expect(await countRows(db, 'invoice')).toBe(countsAtExport.invoice!);
    const nameRows = await db.all<{ name: string }>('SELECT name FROM company');
    expect(nameRows[0]!.name).toBe('متجر الاختبار'); // رجع اسم ما قبل التغيير
    // النسخة نفسها ما تزال صالحة (بصمة سليمة)
    expect(validateBackupText(backup.json).ok).toBe(true);
  });

  test('بنية الملف: finacc + إصدار المخطط الحالي + كل الجداول + الجلسة بعد الاستيراد تصلح', async () => {
    const { db, seed } = await seededDb();
    const backup = await buildBackupJson(db);
    const parsed = JSON.parse(backup.json) as { app: string; schemaVersion: number; tables: Record<string, unknown[]> };
    expect(parsed.app).toBe(BACKUP_APP_ID);
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(Object.keys(parsed.tables).length).toBeGreaterThan(20);
    expect(parsed.tables.company!.length).toBe(1);
    // حجم الملف بالبايت ≈ طول النص
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(backup.fileName).toMatch(/^finacc-backup-\d{8}-\d{4}\.json$/);
  });

  test('بصمة معدَّلة → رفض واضح (FR-11-02)', async () => {
    const { db } = await seededDb();
    const backup = await buildBackupJson(db);
    const tampered = JSON.parse(backup.json) as { company: unknown; tables: { company: { name: string }[] } };
    tampered.tables.company[0]!.name = 'مزوَّر';
    const text = JSON.stringify(tampered); // البصمة القديمة لم تعد تطابق
    const v = validateBackupText(text);
    expect(v.ok).toBe(false);
    expect(v.error).toContain('بصمة الملف');
    await expect(importBackupJson(db, text)).rejects.toThrow('بصمة');
  });

  test('نسخة بمخطط أحدث من التطبيق → رفض حتى لو بصمتها سليمة', async () => {
    const { db } = await seededDb();
    const backup = await buildBackupJson(db);
    const parsed = JSON.parse(backup.json) as Record<string, unknown> & {
      schemaVersion: number;
      checksum: string;
      tables: unknown;
      app: string;
      appVersion: string;
      exportedAt: string;
    };
    parsed.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    const { checksum, ...rest } = parsed;
    void checksum;
    const fixed = JSON.stringify({
      ...rest,
      checksum: computeBackupChecksum(rest as Parameters<typeof computeBackupChecksum>[0]),
    });
    const v = validateBackupText(fixed);
    expect(v.ok).toBe(false);
    expect(v.error).toContain('أحدث من التطبيق');
    await expect(importBackupJson(db, fixed)).rejects.toThrow('أحدث');
  });

  test('ليس JSON / ليس ملف finacc → رفض بنية صادق', async () => {
    expect(validateBackupText('هذا ليس JSON').ok).toBe(false);
    const { db } = await seededDb();
    const backup = await buildBackupJson(db);
    const parsed = JSON.parse(backup.json) as Record<string, unknown>;
    delete parsed.app;
    expect(validateBackupText(JSON.stringify(parsed)).ok).toBe(false);
  });

  test('ذرّية الاستيراد: فشل المنتصف (جدول مجهول في النسخة) → ROLLBACK والبيانات القديمة سليمة', async () => {
    const { db, seed } = await seededDb();
    await seedInvoice(db, seed);
    const before = await tableCounts(db);
    const backup = await buildBackupJson(db);
    const parsed = JSON.parse(backup.json) as {
      checksum: string;
      tables: Record<string, Record<string, unknown>[]>;
    } & Record<string, unknown>;
    parsed.tables.bogus_table = [{ x: 1 }];
    const { checksum, ...rest } = parsed;
    void checksum;
    const text = JSON.stringify({
      ...rest,
      checksum: computeBackupChecksum(rest as Parameters<typeof computeBackupChecksum>[0]),
    });
    await expect(importBackupJson(db, text)).rejects.toThrow();
    expect(await tableCounts(db)).toEqual(before); // لا شيء تغيّر
    expect((await checkIntegrity(db)).ok).toBe(true); // ولا سلامة انكسرت
  });

  test('نسخة الأمان تُسلَّم قبل الاستبدال باسم finacc-safety-*.json + قيد restore_backup', async () => {
    const { db } = await seededDb();
    const source = await seededDb();
    await seedInvoice(source.db, source.seed);
    const backup = await buildBackupJson(source.db);

    const capture: { fileName?: string; json?: string } = {};
    await importBackupJson(db, backup.json, {
      onSafetyBackup: (b) => {
        capture.fileName = b.fileName;
        capture.json = b.json;
      },
    });
    expect(capture.fileName).toMatch(/^finacc-safety-\d{8}-\d{4}\.json$/);
    // نسخة الأمان هي بيانات ما قبل الاستيراد (فارغة الفواتير هنا)
    expect(capture.json).toContain('متجر الاختبار');
    const audits = await db.all<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'restore_backup'",
    );
    expect(audits.length).toBe(1);
    // وسجل النسخة فيه pre_restore
    const log = await listBackupLog(db);
    expect(log.some((r) => r.kind === 'pre_restore')).toBe(true);
  });

  test('تريغرات append-only لسجل التدقيق تعود تعمل بعد الاستيراد (FR-12-04)', async () => {
    const { db, seed } = await seededDb();
    await seedInvoice(db, seed);
    const backup = await buildBackupJson(db);
    await importBackupJson(db, backup.json);
    await expect(
      db.run("UPDATE audit_log SET action = 'x' WHERE id = (SELECT MIN(id) FROM audit_log)"),
    ).rejects.toThrow('append-only');
    await expect(
      db.run('DELETE FROM audit_log WHERE id = (SELECT MIN(id) FROM audit_log)'),
    ).rejects.toThrow('append-only');
  });

  test('_migrations لا تُستبدل — بنية القاعدة الحالية هي الحاكمة', async () => {
    const { db, seed } = await seededDb();
    const before = await db.all<{ version: number }>('SELECT version FROM _migrations ORDER BY version');
    const backup = await buildBackupJson(db);
    await importBackupJson(db, backup.json);
    const after = await db.all<{ version: number }>('SELECT version FROM _migrations ORDER BY version');
    expect(after).toEqual(before);
  });
});

describe('سجل النسخ والاحتفاظ (FR-11-05/06)', () => {
  test('الاحتفاظ بآخر N: تسجيل 10 مع حد 3 → يبقى 3 (الأحدث) والقديم يُحذف', async () => {
    const { db } = await seededDb();
    await setSetting(db, 'backup.retention_count', 3);
    for (let i = 0; i < 10; i += 1) {
      await logBackupEntry(db, {
        kind: 'manual',
        fileName: `finacc-backup-test-${i}.json`,
        sizeBytes: 100 + i,
      });
    }
    const log = await listBackupLog(db);
    expect(log.length).toBe(3);
    expect(log[0]!.fileName).toBe('finacc-backup-test-9.json');
    expect(log[2]!.fileName).toBe('finacc-backup-test-7.json');
  });

  test('آخر نسخة تُشتق من السجل (lastBackupAtMs) وتتقدم مع كل نسخة', async () => {
    const { db } = await seededDb();
    expect(await lastBackupAtMs(db)).toBeNull();
    await logBackupEntry(db, { kind: 'manual', fileName: 'a.json', sizeBytes: 10 });
    const first = await lastBackupAtMs(db);
    expect(first).not.toBeNull();
    await logBackupEntry(db, { kind: 'auto', fileName: 'b.json', sizeBytes: 10 });
    const second = await lastBackupAtMs(db);
    expect(second!).toBeGreaterThanOrEqual(first!);
  });
});

describe('shouldAutoBackup — حدود الجدولة (FR-11-04)', () => {
  const DAY = 24 * 3_600_000;
  const NOW = 1_800_000_000_000;
  test('off: لا تذكير أبداً حتى لو لم تُعمل نسخة قط', () => {
    expect(shouldAutoBackup('off', null, NOW)).toBe(false);
    expect(shouldAutoBackup('off', NOW - 100 * DAY, NOW)).toBe(false);
  });
  test('لم تُعمل نسخة قط → مستحقة فوراً (أي خطة فعّالة)', () => {
    expect(shouldAutoBackup('daily', null, NOW)).toBe(true);
    expect(shouldAutoBackup('weekly', null, NOW)).toBe(true);
  });
  test('يومي: 23:59 ساعة → لا؛ 24 ساعة بالضبط → نعم', () => {
    expect(shouldAutoBackup('daily', NOW - DAY + 60_000, NOW)).toBe(false);
    expect(shouldAutoBackup('daily', NOW - DAY, NOW)).toBe(true);
  });
  test('أسبوعي: 6 أيام و23 ساعة → لا؛ 7 أيام → نعم', () => {
    expect(shouldAutoBackup('weekly', NOW - 7 * DAY + 60_000, NOW)).toBe(false);
    expect(shouldAutoBackup('weekly', NOW - 7 * DAY, NOW)).toBe(true);
  });
  test('ساعة الجهاز رجعت للخلف (فرق سالب) → انتظار لا تذكير', () => {
    expect(shouldAutoBackup('daily', NOW + DAY, NOW)).toBe(false);
  });
});

describe('maybeAutoBackup — النسخ الصامت عند الفتح', () => {
  test('مستحقة عند أول فتح (لا سجل) → تُبنى وتُسجَّل auto؛ ثم لا تتكرر', async () => {
    const { db, seed } = await seededDb();
    await seedInvoice(db, seed);
    await setSetting(db, 'backup.schedule', 'daily');
    const built = await maybeAutoBackup(db);
    expect(built).not.toBeNull();
    expect(built!.json).toContain(BACKUP_APP_ID);
    const log = await listBackupLog(db);
    expect(log[0]!.kind).toBe('auto');
    // استُهلكت — النداء الثاني لا يفعل شيئاً
    expect(await maybeAutoBackup(db)).toBeNull();
    expect((await listBackupLog(db)).length).toBe(1);
  });

  test('الخطة off → لا نسخ صامتة إطلاقاً', async () => {
    const { db } = await seededDb();
    await setSetting(db, 'backup.schedule', 'off');
    expect(await maybeAutoBackup(db)).toBeNull();
    expect(await lastBackupAtMs(db)).toBeNull();
  });
});

describe('أسماء الملفات — طابع زمني محلي', () => {
  test('نسخة عادية وأمان بالبادئتين الصحيحتين', () => {
    const now = new Date(2026, 9, 7, 14, 5); // 7 أكتوبر 2026 14:05 محلي
    expect(backupFileName('backup', now)).toBe('finacc-backup-20261007-1405.json');
    expect(backupFileName('safety', now)).toBe('finacc-safety-20261007-1405.json');
  });
});
