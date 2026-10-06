/**
 * settings/display.tsx — العرض (FR-13-05): نظام الأرقام + التباين العالي.
 *  - display.numerals (ملحق هـ): غربية/هندية — مطبّق فعلياً عبر setNumeralsMode
 *    في format.ts (المبالغ والكميات والعدّادات) — التبديل فوري بلا إعادة تشغيل.
 *  - ui.high_contrast: يُخزَّن الآن ويوصل مكتمله مع حزمة الثيمات القادمة —
 *    سطر صادق «قيد الإعداد» (لا مفتاح وهمي).
 */
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Contrast, Hash } from 'lucide-react-native';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { getSetting, setSetting } from '@/domain/settings';
import { setNumeralsMode, type NumeralsMode } from '@/utils/format';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { domainErrorMessage } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import ListRow from '@/components/ui/ListRow';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import SegmentedControl from '@/components/ui/SegmentedControl';
import { useFeedback } from '@/components/ui/feedback';

const NumeralsSchema = z.enum(['western', 'arabic_indic']);

export default function DisplaySettingsScreen() {
  const router = useRouter();
  const feedback = useFeedback();

  const [numerals, setNumerals] = useState<NumeralsMode>('western');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const db = await getDb();
      setNumerals(await getSetting(db, 'display.numerals', NumeralsSchema, 'western'));
    } catch {
      // الافتراضي غربية
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

  const pickNumerals = async (mode: NumeralsMode): Promise<void> => {
    if (saving || mode === numerals) return;
    setSaving(true);
    try {
      const db = await getDb();
      await setSetting(db, 'display.numerals', mode);
      setNumeralsMode(mode); // فوري — كل منسّقات العرض تلتقطه
      setNumerals(mode);
      feedback.show({ message: ar.settings.saved });
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.settings.sections.display}
        subtitle={ar.settings.display.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <AppCard noPadding style={styles.cardPad}>
          <SegmentedControl<NumeralsMode>
            label={ar.settings.display.numerals}
            description={ar.settings.display.numeralsDesc}
            options={[
              { value: 'western', label: ar.settings.display.western },
              { value: 'arabic_indic', label: ar.settings.display.indic },
            ]}
            value={numerals}
            onSelect={(v) => void pickNumerals(v)}
            testID="display-numerals"
          />
          <View style={styles.previewRow}>
            <Hash size={14} color={colors.textFaint} />
            <Text style={styles.previewText}>
              {numerals === 'arabic_indic' ? '١٢٣ · ٤٥٫٥٠ · ٠٩ أكتوبر' : '123 · 45.50 · 09 أكتوبر'}
            </Text>
          </View>
        </AppCard>

        <AppCard noPadding>
          <ListRow
            title={ar.settings.display.highContrast}
            subtitle={ar.settings.display.highContrastDesc}
            disabled
            testID="display-high-contrast"
            leading={
              <View style={[styles.icon, { backgroundColor: `${colors.pending}33` }]}>
                <Contrast size={20} color={colors.textMuted} />
              </View>
            }
            trailing={
              <View style={styles.pendingChip}>
                <Text style={styles.pendingText}>{ar.settings.display.highContrastPending}</Text>
              </View>
            }
          />
        </AppCard>
        {feedback.host}
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardPad: {
    padding: spacing.md,
  },
  icon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  previewText: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
  },
  pendingChip: {
    borderRadius: 999,
    backgroundColor: `${colors.pending}33`,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  pendingText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
});
