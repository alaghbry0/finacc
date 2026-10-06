/**
 * stub/[name].tsx — شاشة العناصر القادمة (واحدة ديناميكية بدل ست ملفات):
 * تدفع إليها «المزيد» وبطاقات الداشبورد بمعامل name (+title اختياري).
 * صادقة: «قيد الإعداد في مرحلة قادمة» — لا تزيّف وظائف، ورجوع موحّد.
 */
import { useMemo } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Construction } from 'lucide-react-native';
import { ar, t, type ArPath } from '@/i18n/ar';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import { spacing } from '@/theme';

/** عناوين معروفة عند غياب معامل title (اسم مفتاح → مسار قاموس) */
const KNOWN_TITLES: Record<string, ArPath> = {
  parties: 'more.parties',
  reports: 'more.reports',
  installments: 'more.installments',
  'installments-due': 'dashboard.installmentsDue',
  cheques: 'more.cheques',
  'cheques-due': 'dashboard.chequesSoon',
  'inventory-alerts': 'dashboard.stockAlerts',
  settings: 'more.settings',
  about: 'more.about',
};

export default function StubScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name?: string; title?: string }>();
  const name = typeof params.name === 'string' ? params.name : '';

  const title = useMemo(() => {
    if (typeof params.title === 'string' && params.title !== '') return params.title;
    const path = KNOWN_TITLES[name];
    return path ? t(path) : ar.stub.title;
  }, [params.title, name]);

  return (
    <SafeScreen offline={false} scroll={false} padded={false}>
      <ScreenHeader title={title} subtitle={ar.app.version} onBack={() => router.back()} />
      <View style={{ padding: spacing.lg, flex: 1 }}>
        <AppCard noPadding>
          <EmptyState icon={Construction} title={ar.stub.title} message={ar.stub.message} />
        </AppCard>
      </View>
    </SafeScreen>
  );
}
