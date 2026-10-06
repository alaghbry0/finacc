/**
 * settings/security.tsx — الأمان والقفل (FR-12-05 + ملحق هـ).
 *
 *  - security.autolock_minutes (1-60، افتراضي 5): NumberPad → setSetting ثم
 *    session.refreshCompany حتى يلتقط مؤقت القفل الجديد فوراً.
 *  - security.pin_lockout: نظامية ثابتة (5→تأخير، 10→عبارة مسح) — عرض فقط
 *    بلا أي تحكم (السجل: «نظام — لا يُعدل»).
 *  - تغيير رمز الدخول: لا مسار تغيير في V1 — سطر صادق «يصل في تحديث قادم»
 *    (لا رابط وهمي).
 */
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { KeyRound, ShieldCheck, Timer } from 'lucide-react-native';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { getSetting, setSetting } from '@/domain/settings';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { domainErrorMessage } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import ListRow from '@/components/ui/ListRow';
import NumberPad from '@/components/ui/NumberPad';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import { useFeedback } from '@/components/ui/feedback';

export default function SecuritySettingsScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const refreshCompany = useSession((s) => s.refreshCompany);

  const [autolock, setAutolock] = useState('5');
  const [sheet, setSheet] = useState(false);
  const [sheetValue, setSheetValue] = useState('5');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const db = await getDb();
      const value = await getSetting(
        db,
        'security.autolock_minutes',
        z.number().int().min(1).max(60),
        5,
      );
      setAutolock(String(value));
      setSheetValue(String(value));
    } catch {
      // الافتراضي 5
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

  const onSave = async (): Promise<void> => {
    if (saving) return;
    const n = Number(sheetValue);
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      feedback.show({ message: ar.settings.security.autolockHint });
      return;
    }
    setSaving(true);
    try {
      const db = await getDb();
      await setSetting(db, 'security.autolock_minutes', n);
      await refreshCompany(); // مؤقت القفل في الجذر يقرأ القيمة الجديدة فوراً
      setSheet(false);
      setAutolock(String(n));
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
        title={ar.settings.sections.security}
        subtitle={ar.settings.security.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <AppCard noPadding>
          <ListRow
            title={ar.settings.security.autolock}
            subtitle={`${autolock} ${ar.settings.security.minutes} · ${ar.settings.security.autolockDesc}`}
            onPress={() => setSheet(true)}
            divider
            testID="security-autolock"
            leading={
              <View style={[styles.icon, { backgroundColor: `${colors.accent}22` }]}>
                <Timer size={20} color={colors.accent} />
              </View>
            }
            trailing={<Text style={styles.actionText}>{ar.settings.change}</Text>}
          />
          <ListRow
            title={ar.settings.security.pinLockout}
            subtitle={ar.settings.security.pinLockoutDesc}
            disabled
            testID="security-pin-lockout"
            leading={
              <View style={[styles.icon, { backgroundColor: `${colors.pending}33` }]}>
                <ShieldCheck size={20} color={colors.textMuted} />
              </View>
            }
          />
          <ListRow
            title={ar.settings.security.changePin}
            subtitle={ar.settings.security.changePinHint}
            disabled
            testID="security-change-pin"
            leading={
              <View style={[styles.icon, { backgroundColor: `${colors.pending}33` }]}>
                <KeyRound size={20} color={colors.textMuted} />
              </View>
            }
          />
        </AppCard>
        {feedback.host}
      </ScrollView>

      <BottomSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        title={ar.settings.security.autolockSheetTitle}
        testID="security-autolock-sheet"
      >
        <Text style={styles.sheetHint}>{ar.settings.security.autolockHint}</Text>
        <NumberPad
          value={sheetValue}
          onChange={setSheetValue}
          allowDecimal={false}
          decimals={0}
          label={ar.settings.security.autolock}
        />
        <PrimaryButton
          label={ar.common.save}
          onPress={onSave}
          loading={saving}
          style={styles.sheetButton}
          testID="security-autolock-save"
        />
      </BottomSheet>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
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
