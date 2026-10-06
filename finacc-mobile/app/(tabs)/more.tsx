/**
 * (tabs)/more.tsx — قائمة «المزيد» (LDR-2: التقارير هنا لا في الشريط):
 * العملاء والموردون / التقارير / الأقساط / الشيكات / الجرد / الإعدادات / حول —
 * كلها شاشات حقيقية الآن (وحدات Task 13/14/15/16) — لم يبق أي كعب.
 */
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  CalendarClock,
  ClipboardCheck,
  FileText,
  Info,
  Landmark,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import AppCard from '@/components/ui/AppCard';
import ListRow from '@/components/ui/ListRow';
import SafeScreen from '@/components/ui/SafeScreen';

type MenuItem = {
  key: string;
  title: string;
  hint: string;
  icon: LucideIcon;
  iconColor: string;
};

const MENU: MenuItem[] = [
  { key: 'parties', title: ar.more.parties, hint: ar.more.partiesHint, icon: Users, iconColor: colors.accent },
  { key: 'reports', title: ar.more.reports, hint: ar.more.reportsHint, icon: FileText, iconColor: colors.teal },
  { key: 'installments', title: ar.more.installments, hint: ar.more.installmentsHint, icon: CalendarClock, iconColor: colors.warning },
  { key: 'cheques', title: ar.more.cheques, hint: ar.more.chequesHint, icon: Landmark, iconColor: colors.teal },
  { key: 'stocktake', title: ar.more.stocktake, hint: ar.more.stocktakeHint, icon: ClipboardCheck, iconColor: colors.success },
  { key: 'settings', title: ar.more.settings, hint: ar.more.settingsHint, icon: Settings, iconColor: colors.textMuted },
  { key: 'about', title: ar.more.about, hint: ar.more.aboutHint, icon: Info, iconColor: colors.textMuted },
];

export default function MoreScreen() {
  const router = useRouter();

  const open = (item: MenuItem) => {
    if (item.key === 'parties') {
      router.push('/parties'); // شاشة الأطراف الحقيقية (المهمة 6-a)
      return;
    }
    if (item.key === 'reports') {
      router.push('/more/reports'); // شاشة التقارير الحقيقية (FR-09 — Task 13)
      return;
    }
    if (item.key === 'cheques') {
      router.push('/more/cheques'); // شاشة الشيكات الحقيقية (FR-14 — Task 12)
      return;
    }
    if (item.key === 'installments') {
      router.push('/more/installments'); // شاشة الأقساط الحقيقية (FR-05 — Task 14)
      return;
    }
    if (item.key === 'stocktake') {
      router.push('/more/stocktakes'); // سجل عمليات الجرد (FR-01-08 — Task 16)
      return;
    }
    if (item.key === 'settings') {
      router.push('/more/settings'); // شاشة الإعدادات الحقيقية (FR-13 — Task 15)
      return;
    }
    if (item.key === 'about') {
      router.push('/settings/about'); // حول التطبيق (FR-13-07 — Task 15)
      return;
    }
    router.push({ pathname: '/stub/[name]', params: { name: item.key, title: item.title } });
  };

  return (
    <SafeScreen>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{ar.more.title}</Text>
        <Text style={styles.headerSubtitle}>{ar.more.subtitle}</Text>
      </View>

      <AppCard noPadding>
        {MENU.map((item, i) => {
          const Icon = item.icon;
          return (
            <ListRow
              key={item.key}
              title={item.title}
              subtitle={item.hint}
              divider={i < MENU.length - 1}
              onPress={() => open(item)}
              leading={
                <View style={[styles.menuIcon, { backgroundColor: `${item.iconColor}22` }]}>
                  <Icon size={20} color={item.iconColor} />
                </View>
              }
            />
          );
        })}
      </AppCard>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: 2,
    paddingTop: spacing.xs,
  },
  headerTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 24,
    lineHeight: 32,
  },
  headerSubtitle: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  menuIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
