/**
 * settings/about.tsx — حول التطبيق (FR-13-07): الإصدار والمنشأة وحجم القاعدة
 * وصفوف الجداول + فحص السلامة (integrity_check + foreign_key_check عبر خدمة
 * النسخ) + اختصار النسخ الاحتياطي.
 */
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Building2,
  CheckCircle2,
  Database,
  DatabaseBackup,
  HardDrive,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import { getCompanyProfile } from '@/domain/settings-ext';
import { APP_VERSION, checkIntegrity, getDbStats, type IntegrityResult } from '@/services/backup';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { technicalText } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import ListRow from '@/components/ui/ListRow';
import LoadingState from '@/components/ui/LoadingState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import { useFeedback } from '@/components/ui/feedback';

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${ar.settings.backup.sizeKb}`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function AboutScreen() {
  const router = useRouter();
  const feedback = useFeedback();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [company, setCompany] = useState<string>('');
  const [size, setSize] = useState(0);
  const [counts, setCounts] = useState<{ table: string; rows: number }[]>([]);
  const [integrity, setIntegrity] = useState<IntegrityResult | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      const [profile, stats] = await Promise.all([getCompanyProfile(db), getDbStats(db)]);
      setCompany(profile?.name ?? '—');
      setSize(stats.sizeBytes);
      setCounts(stats.tableCounts);
    } catch (err) {
      setError(technicalText(err));
    } finally {
      setLoading(false);
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

  const runIntegrity = async (): Promise<void> => {
    if (checking) return;
    setChecking(true);
    setIntegrity(null);
    try {
      const db = await getDb();
      const result = await checkIntegrity(db);
      setIntegrity(result);
      if (!result.ok) feedback.show({ message: result.message, durationMs: 8000 });
    } catch (err) {
      feedback.show({ message: technicalText(err) ?? ar.settings.loadFailed });
    } finally {
      setChecking(false);
    }
  };

  const topCounts = counts.slice(0, 6);
  const otherRows = counts.slice(6).reduce((acc, c) => acc + c.rows, 0);

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.settings.sections.about}
        subtitle={ar.settings.about.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {loading ? (
          <AppCard noPadding>
            <LoadingState variant="list" rows={4} />
          </AppCard>
        ) : error !== null ? (
          <AppCard noPadding>
            <LoadingState variant="list" rows={2} />
            <Text style={styles.errorText}>{error}</Text>
          </AppCard>
        ) : (
          <>
            <AppCard noPadding>
              <ListRow
                title={ar.settings.about.version}
                subtitle={`FinAcc v${APP_VERSION}`}
                disabled
                leading={iconWrap(colors.accent, <Database size={20} color={colors.accent} />)}
              />
              <ListRow
                title={ar.settings.about.company}
                subtitle={company}
                disabled
                divider
                leading={iconWrap(colors.success, <Building2 size={20} color={colors.success} />)}
              />
              <ListRow
                title={ar.settings.about.dbSize}
                subtitle={kb(size)}
                disabled
                divider
                leading={iconWrap(colors.warning, <HardDrive size={20} color={colors.warning} />)}
              />
            </AppCard>

            {/* صفوف الجداول */}
            <AppCard noPadding style={styles.countsCard}>
              <Text style={styles.countsTitle}>{ar.settings.about.rowsTitle}</Text>
              <Text style={styles.countsSummary}>
                {ar.settings.about.rowsSummary.replace('{n}', String(counts.length))}
              </Text>
              <View style={styles.countsGrid}>
                {topCounts.map((c) => (
                  <View key={c.table} style={styles.countCell}>
                    <Text style={styles.countTable} numberOfLines={1}>
                      {c.table}
                    </Text>
                    <Text style={styles.countValue}>{String(c.rows)}</Text>
                  </View>
                ))}
                {otherRows > 0 ? (
                  <View style={styles.countCell}>
                    <Text style={styles.countTable}>+{counts.length - topCounts.length}</Text>
                    <Text style={styles.countValue}>{String(otherRows)}</Text>
                  </View>
                ) : null}
              </View>
            </AppCard>

            {/* فحص السلامة */}
            <AppCard noPadding>
              <View style={styles.integrityPad}>
                <View style={styles.integrityHead}>
                  <ShieldCheck size={18} color={colors.teal} />
                  <Text style={styles.integrityTitle}>{ar.settings.about.integrityBtn}</Text>
                </View>
                {integrity !== null ? (
                  <View
                    style={[
                      styles.integrityResult,
                      integrity.ok ? styles.integrityOk : styles.integrityBad,
                    ]}
                  >
                    {integrity.ok ? (
                      <CheckCircle2 size={16} color={colors.success} />
                    ) : (
                      <TriangleAlert size={16} color={colors.danger} />
                    )}
                    <Text
                      style={[
                        styles.integrityText,
                        { color: integrity.ok ? colors.success : colors.danger },
                      ]}
                    >
                      {integrity.ok ? ar.settings.about.integrityOk : ar.settings.about.integrityFailed}
                    </Text>
                  </View>
                ) : null}
                <PrimaryButton
                  label={checking ? ar.settings.about.integrityRunning : ar.settings.about.integrityBtn}
                  onPress={() => void runIntegrity()}
                  loading={checking}
                  testID="about-integrity-btn"
                />
              </View>
            </AppCard>

            {/* اختصار النسخ الاحتياطي */}
            <AppCard noPadding>
              <ListRow
                title={ar.settings.about.backupShortcut}
                subtitle={ar.settings.about.backupShortcutHint}
                onPress={() => router.push('/settings/backup')}
                leading={iconWrap(colors.success, <DatabaseBackup size={20} color={colors.success} />)}
              />
            </AppCard>
          </>
        )}
        {feedback.host}
      </ScrollView>
    </SafeScreen>
  );
}

function iconWrap(tint: string, node: React.ReactNode): React.ReactNode {
  return <View style={[styles.icon, { backgroundColor: `${tint}22` }]}>{node}</View>;
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  icon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    padding: spacing.md,
  },
  countsCard: {
    padding: spacing.md,
    gap: 8,
  },
  countsTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 21,
  },
  countsSummary: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  countsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
  },
  countCell: {
    width: '33.33%',
    paddingVertical: 6,
    gap: 1,
  },
  countTable: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontSize: 11,
    lineHeight: 15,
  },
  countValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 21,
  },
  integrityPad: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  integrityHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  integrityTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  integrityResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  integrityOk: {
    backgroundColor: 'rgba(52, 211, 153, 0.10)',
  },
  integrityBad: {
    backgroundColor: 'rgba(248, 113, 113, 0.10)',
  },
  integrityText: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: 12.5,
    lineHeight: 18,
  },
});
