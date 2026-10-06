/**
 * more/settings.tsx — شاشة الإعدادات الرئيسية (Task 15 — FR-13).
 *
 * قائمة أقسام (ListRow): بيانات المنشأة / الفوترة / الترقيم / النسخ الاحتياطي /
 * الأمان والقفل / العرض / البيانات المرجعية / حول التطبيق — كل قسم شاشة فرعية
 * في app/settings/*.tsx.
 *
 * شريط «مرّ وقت نسختك الاحتياطية» (FR-11-04): يظهر أعلى القائمة عند استحقاق
 * النسخة حسب الجدولة (backup.schedule) وآخر نسخة من سجل النسخ — تذكير صادق
 * بلا إشعارات وهمية (إشعار Expo المحلي أصلي → مؤجل مع بناء EAS).
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Building2,
  DatabaseBackup,
  Hash,
  Info,
  Library,
  Lock,
  Palette,
  ReceiptText,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import { getBackupSchedule, lastBackupAtMs, shouldAutoBackup } from '@/services/backup';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import AppCard from '@/components/ui/AppCard';
import ListRow from '@/components/ui/ListRow';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';

type SectionKey =
  | 'company'
  | 'invoicing'
  | 'numbering'
  | 'backup'
  | 'security'
  | 'display'
  | 'reference'
  | 'about';

const SECTIONS: { key: SectionKey; icon: LucideIcon; iconColor: string }[] = [
  { key: 'company', icon: Building2, iconColor: colors.accent },
  { key: 'invoicing', icon: ReceiptText, iconColor: colors.teal },
  { key: 'numbering', icon: Hash, iconColor: colors.warning },
  { key: 'backup', icon: DatabaseBackup, iconColor: colors.success },
  { key: 'security', icon: Lock, iconColor: colors.danger },
  { key: 'display', icon: Palette, iconColor: colors.teal },
  { key: 'reference', icon: Library, iconColor: colors.warning },
  { key: 'about', icon: Info, iconColor: colors.textMuted },
];

export default function SettingsScreen() {
  const router = useRouter();
  const [backupDue, setBackupDue] = useState(false);

  const loadDue = useCallback(async () => {
    try {
      const db = await getDb();
      const [schedule, lastAt] = await Promise.all([
        getBackupSchedule(db),
        lastBackupAtMs(db),
      ]);
      setBackupDue(shouldAutoBackup(schedule, lastAt, Date.now()));
    } catch {
      setBackupDue(false); // تذكير فقط — لا نكسر القائمة بخطأ
    }
  }, []);

  useEffect(() => {
    void loadDue();
  }, [loadDue]);

  useFocusEffect(
    useCallback(() => {
      void loadDue();
    }, [loadDue]),
  );

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader title={ar.settings.title} subtitle={ar.settings.subtitle} onBack={() => router.back()} />
      <View style={styles.content}>
        {backupDue ? (
          <View style={styles.dueBanner}>
            <TriangleAlert size={18} color={colors.warning} />
            <Text style={styles.dueText}>{ar.settings.bannerDue}</Text>
          </View>
        ) : null}
        <AppCard noPadding>
          {SECTIONS.map((section, i) => {
            const Icon = section.icon;
            return (
              <ListRow
                key={section.key}
                title={ar.settings.sections[section.key]}
                subtitle={ar.settings.sections[`${section.key}Hint` as keyof typeof ar.settings.sections]}
                divider={i < SECTIONS.length - 1}
                onPress={() => router.push(`/settings/${section.key}`)}
                testID={`settings-row-${section.key}`}
                leading={
                  <View style={[styles.icon, { backgroundColor: `${section.iconColor}22` }]}>
                    <Icon size={20} color={section.iconColor} />
                  </View>
                }
              />
            );
          })}
        </AppCard>
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  dueBanner: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: `${colors.warning}1A`,
    borderWidth: 1,
    borderColor: `${colors.warning}55`,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  dueText: {
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
});
