/**
 * settings/backup.tsx — النسخ الاحتياطي (FR-11 V1: 01/02/04/05/06/08).
 *
 *  - «نسخة الآن»: بناء JSON كامل (كل الجداول + بصمة SHA-256) → تنزيل ملف عبر
 *    المنصة (الويب: Blob → مجلد التنزيلات؛ الأصلي: مسار EAS مؤجل برسالة صادقة)
 *    → تسجيل «يدوية» في سجل النسخ مع القصّ على حد الاحتفاظ.
 *  - «استيراد نسخة»: منتقي ملفات (ويب) → فحص السلامة (بنية/بصمة/إصدار المخطط)
 *    → ملخص النسخة + تأكيد بكلمة «استعادة» → نسخة أمان تلقائية تُحمَّل قبل أي
 *    استبدال → استبدال ذرّي داخل معاملة → إعادة قراءة الجلسة كاملة.
 *  - الجدولة (يومي/أسبوعي/إيقاف) + حد الاحتفاظ (1-30) + سجل النسخ (FR-11-06).
 *
 * إعادة التحميل بعد الاستعادة: الويب window.location.reload() — أنظف مسار
 * (يعيد كل المتاجر والقاعدة من الصفر)؛ الأصلي: boot() + استبدال المسار.
 */
import { useCallback, useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { z } from 'zod';
import {
  CalendarClock,
  FileDown,
  FileUp,
  History,
  TriangleAlert,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import { getSetting, setSetting } from '@/domain/settings';
import {
  buildBackupJson,
  getBackupSchedule,
  importBackupJson,
  lastBackupAtMs,
  listBackupLog,
  logBackupEntry,
  shouldAutoBackup,
  validateBackupText,
  type BackupLogRow,
  type BackupValidationInfo,
} from '@/services/backup';
import { downloadBackupFile, pickBackupFileText } from '@/services/backup-io';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { formatDateAr, formatTimeAr } from '@/utils/format';
import { domainErrorMessage } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import ConfirmSheet from '@/components/ui/ConfirmSheet';
import ListRow from '@/components/ui/ListRow';
import NumberPad from '@/components/ui/NumberPad';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import SegmentedControl from '@/components/ui/SegmentedControl';
import { useFeedback } from '@/components/ui/feedback';

type Schedule = 'daily' | 'weekly' | 'off';

/** إعادة تحميل حالة التطبيق كاملة بعد الاستبدال */
async function reloadApp(): Promise<void> {
  if (Platform.OS === 'web') {
    window.location.reload();
    return;
  }
  // الأصلي: إعادة الإقلاع عبر متجر الجلسة (يعيد قراءة المنشأة والافتراضيات)
  await useSession.getState().boot();
}

export default function BackupSettingsScreen() {
  const router = useRouter();
  const feedback = useFeedback();

  const [schedule, setSchedule] = useState<Schedule>('weekly');
  const [retention, setRetention] = useState('7');
  const [log, setLog] = useState<BackupLogRow[]>([]);
  const [due, setDue] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [retentionSheet, setRetentionSheet] = useState(false);
  const [retentionValue, setRetentionValue] = useState('7');

  /** ملف مختار ينتظر تأكيد الاستعادة */
  const [pendingImport, setPendingImport] = useState<{ text: string; info: BackupValidationInfo } | null>(null);

  const load = useCallback(async () => {
    try {
      const db = await getDb();
      const [sched, ret, logRows, lastAt] = await Promise.all([
        getBackupSchedule(db),
        getSetting(db, 'backup.retention_count', z.number().int().min(1).max(30), 7),
        listBackupLog(db),
        lastBackupAtMs(db),
      ]);
      setSchedule(sched);
      setRetention(String(ret));
      setRetentionValue(String(ret));
      setLog(logRows);
      setDue(shouldAutoBackup(sched, lastAt, Date.now()));
    } catch {
      // قراءة فقط — نعرض الافتراضيات
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /* ============ نسخة الآن (FR-11-01/08) ============ */
  const onExport = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    try {
      const db = await getDb();
      const built = await buildBackupJson(db);
      await downloadBackupFile(built.fileName, built.json); // الأصلي يرمي رسالة EAS الصادقة
      await logBackupEntry(db, {
        kind: 'manual',
        fileName: built.fileName,
        sizeBytes: built.sizeBytes,
        checksum: built.checksum,
      });
      feedback.show({ message: ar.settings.backup.exported.replace('{file}', built.fileName) });
      await load();
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.backup.exportFailed });
    } finally {
      setExporting(false);
    }
  };

  /* ============ استيراد نسخة (FR-11-02) ============ */
  const onPickFile = async (): Promise<void> => {
    if (importing) return;
    setImporting(true);
    try {
      const text = await pickBackupFileText();
      if (text === null) {
        setImporting(false);
        return; // أغلق المنتقي بلا اختيار — ليس خطأ
      }
      const validation = validateBackupText(text);
      if (!validation.ok || !validation.info) {
        feedback.show({ message: validation.error ?? ar.settings.backup.importInvalid });
        return;
      }
      setPendingImport({ text, info: validation.info });
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.backup.importPickFailed });
    } finally {
      setImporting(false);
    }
  };

  const onConfirmRestore = async (): Promise<void> => {
    if (!pendingImport) return;
    const { text } = pendingImport;
    setPendingImport(null);
    setImporting(true);
    try {
      const db = await getDb();
      await importBackupJson(db, text, {
        // نسخة أمان تُحمَّل قبل الاستبدال (FR-11-02) — فشل التنزيل يوقف الاستعادة
        onSafetyBackup: async (safety) => {
          await downloadBackupFile(safety.fileName, safety.json);
        },
      });
      feedback.show({ message: ar.settings.backup.restored });
      await reloadApp();
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.backup.restoreFailed });
      setImporting(false);
    }
  };

  /* ============ الجدولة والاحتفاظ ============ */
  const onSchedule = async (next: Schedule): Promise<void> => {
    const prev = schedule;
    setSchedule(next);
    try {
      const db = await getDb();
      await setSetting(db, 'backup.schedule', next);
      await load();
    } catch (err) {
      setSchedule(prev);
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.saveFailed });
    }
  };

  const onSaveRetention = async (): Promise<void> => {
    const n = Number(retentionValue);
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      feedback.show({ message: ar.settings.backup.retentionHint });
      return;
    }
    try {
      const db = await getDb();
      await setSetting(db, 'backup.retention_count', n);
      setRetentionSheet(false);
      feedback.show({ message: ar.settings.saved });
      await load();
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.saveFailed });
    }
  };

  /* ============ عرض السجل ============ */
  const kindLabel = (kind: BackupLogRow['kind']): string =>
    kind === 'manual'
      ? ar.settings.backup.kindManual
      : kind === 'auto'
        ? ar.settings.backup.kindAuto
        : ar.settings.backup.kindSafety;

  const importInfoLine = pendingImport
    ? ar.settings.backup.importInfo
        .replace('{date}', formatDateAr(pendingImport.info.exportedAt.slice(0, 10)))
        .replace('{rows}', String(pendingImport.info.rowTotal))
        .replace('{tables}', String(pendingImport.info.tableCount))
    : '';

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.settings.sections.backup}
        subtitle={ar.settings.backup.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {due ? (
          <View style={styles.banner}>
            <TriangleAlert size={18} color={colors.warning} />
            <Text style={styles.bannerText}>{ar.settings.bannerDue}</Text>
          </View>
        ) : null}

        {/* ——— الإجراءات ——— */}
        <AppCard noPadding>
          <ListRow
            title={ar.settings.backup.now}
            subtitle={ar.settings.backup.nowHint}
            onPress={onExport}
            disabled={exporting || importing}
            divider
            testID="backup-export"
            leading={
              <View style={[styles.icon, { backgroundColor: `${colors.success}22` }]}>
                <FileDown size={20} color={colors.success} />
              </View>
            }
            trailing={
              <Text style={styles.actionText}>{exporting ? ar.settings.backup.exporting : ''}</Text>
            }
          />
          <ListRow
            title={ar.settings.backup.importLabel}
            subtitle={ar.settings.backup.importHint}
            onPress={onPickFile}
            disabled={exporting || importing}
            testID="backup-import"
            leading={
              <View style={[styles.icon, { backgroundColor: `${colors.accent}22` }]}>
                <FileUp size={20} color={colors.accent} />
              </View>
            }
          />
        </AppCard>

        {/* ——— الجدولة (FR-11-04) ——— */}
        <AppCard>
          <SegmentedControl<Schedule>
            label={ar.settings.backup.schedule}
            description={ar.settings.backup.scheduleDesc}
            options={[
              { value: 'daily', label: ar.settings.backup.daily },
              { value: 'weekly', label: ar.settings.backup.weekly },
              { value: 'off', label: ar.settings.backup.off },
            ]}
            value={schedule}
            onSelect={(v) => void onSchedule(v)}
            testID="backup-schedule"
          />
          <ListRow
            title={ar.settings.backup.retention}
            subtitle={`${retention} · ${ar.settings.backup.retentionDesc}`}
            onPress={() => {
              setRetentionValue(retention);
              setRetentionSheet(true);
            }}
            testID="backup-retention"
            leading={
              <View style={[styles.icon, { backgroundColor: `${colors.warning}22` }]}>
                <CalendarClock size={18} color={colors.warning} />
              </View>
            }
            trailing={<Text style={styles.actionText}>{ar.settings.change}</Text>}
            style={styles.retentionRow}
          />
        </AppCard>

        {/* ——— سجل النسخ (FR-11-06) ——— */}
        <AppCard noPadding>
          <View style={styles.logHead}>
            <History size={15} color={colors.teal} />
            <Text style={styles.logTitle}>{ar.settings.backup.logTitle}</Text>
          </View>
          {log.length === 0 ? (
            <Text style={styles.logEmpty}>{ar.settings.backup.logEmpty}</Text>
          ) : (
            log.slice(0, 10).map((row, i) => (
              <ListRow
                key={row.id}
                title={`${kindLabel(row.kind)} · ${formatDateAr(row.at.slice(0, 10))} ${formatTimeAr(row.at)}`}
                subtitle={row.fileName ?? '—'}
                divider={i < Math.min(log.length, 10) - 1}
                testID={`backup-log-${row.id}`}
                leading={
                  <View
                    style={[
                      styles.logDot,
                      { backgroundColor: row.status === 'ok' ? colors.success : colors.danger },
                    ]}
                  />
                }
                trailing={
                  <Text style={styles.logMeta}>
                    {row.status === 'ok' ? ar.settings.backup.statusOk : ar.settings.backup.statusFailed}
                    {row.fileSize !== null
                      ? ` · ${Math.max(1, Math.round(row.fileSize / 1024))} ${ar.settings.backup.sizeKb}`
                      : ''}
                  </Text>
                }
              />
            ))
          )}
        </AppCard>
        {feedback.host}
      </ScrollView>

      {/* حد الاحتفاظ — NumberPad 1-30 */}
      <BottomSheet
        visible={retentionSheet}
        onClose={() => setRetentionSheet(false)}
        title={ar.settings.backup.retentionSheetTitle}
        testID="backup-retention-sheet"
      >
        <Text style={styles.sheetHint}>{ar.settings.backup.retentionHint}</Text>
        <NumberPad
          value={retentionValue}
          onChange={setRetentionValue}
          allowDecimal={false}
          decimals={0}
          label={ar.settings.backup.retention}
        />
        <PrimaryButton
          label={ar.common.save}
          onPress={onSaveRetention}
          style={styles.sheetButton}
          testID="backup-retention-save"
        />
      </BottomSheet>

      {/* تأكيد الاستعادة — كلمة مطبوعة حرفياً (DS-27) */}
      <ConfirmSheet
        visible={pendingImport !== null}
        title={ar.settings.backup.confirmTitle}
        message={`${importInfoLine}\n\n${ar.settings.backup.confirmMsg}`}
        confirmWord={ar.settings.backup.confirmWord}
        onConfirm={() => void onConfirmRestore()}
        onCancel={() => setPendingImport(null)}
        danger
        testID="backup-confirm-restore"
      />
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  banner: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: `${colors.warning}1A`,
    borderWidth: 1,
    borderColor: `${colors.warning}55`,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  bannerText: {
    flex: 1,
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13.5,
    lineHeight: 20,
  },
  icon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    color: colors.accent,
    fontFamily: font.medium,
    fontSize: 12.5,
  },
  retentionRow: {
    marginTop: spacing.xs,
  },
  logHead: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    paddingBottom: spacing.xs,
  },
  logTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 14.5,
  },
  logEmpty: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    padding: spacing.md,
    paddingTop: spacing.xs,
  },
  logDot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
  },
  logMeta: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
    textAlign: 'left',
    maxWidth: 120,
  },
  sheetHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  sheetButton: {
    marginTop: spacing.md,
  },
});
