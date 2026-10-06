/**
 * settings/invoicing.tsx — إعدادات الفوترة (FR-13-02 — مفاتيح ملحق هـ حصراً).
 *
 * كل صف: تسمية + وصف + مقاطع/مفتاح تبديل → setSetting (تحقق زود + قيد audit
 * settings_change داخل الدومين). القيم الافتراضية من السجل حرفياً؛ قراءة تالفة
 * أو مفقودة → الافتراضي (getSetting الدفاعي).
 *
 * مفاتيح الشاشة: invoicing.print_on_save / invoicing.payment_sheet /
 * invoicing.tax_mode / invoicing.discount_below_margin / sale.over_avail_policy /
 * parties.credit_limit_action / fx.fallback / fx.daily_reminder.
 * (inventory.min_stock_alert في السجل منذ هذه المهمة — عرضه مؤجل حتى يقرأه
 * الداشبورد فعلاً: لا مفاتيح وهمية.)
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { getSetting, setSetting } from '@/domain/settings';
import { ar } from '@/i18n/ar';
import { colors, font, spacing } from '@/theme';
import { domainErrorMessage } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import SegmentedControl from '@/components/ui/SegmentedControl';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import { useFeedback } from '@/components/ui/feedback';

type Schedule = 'print' | 'no' | 'ask';

interface InvoicingState {
  printOnSave: Schedule;
  paymentSheet: 'on' | 'off';
  taxMode: 'on_total' | 'per_item';
  discountBelowMargin: 'off' | 'warn' | 'block';
  overAvail: 'warn' | 'add_available';
  creditLimit: 'warn' | 'block';
  fxFallback: 'off' | 'last_known';
  fxDailyReminder: 'on' | 'off';
}

const DEFAULTS: InvoicingState = {
  printOnSave: 'ask',
  paymentSheet: 'on',
  taxMode: 'on_total',
  discountBelowMargin: 'off',
  overAvail: 'warn',
  creditLimit: 'warn',
  fxFallback: 'off',
  fxDailyReminder: 'on',
};

async function loadState(db: Awaited<ReturnType<typeof getDb>>): Promise<InvoicingState> {
  const [printOnSave, paymentSheet, taxMode, discount, overAvail, creditLimit, fxFallback, fxReminder] =
    await Promise.all([
      getSetting(db, 'invoicing.print_on_save', z.enum(['print', 'no', 'ask']), DEFAULTS.printOnSave),
      getSetting(db, 'invoicing.payment_sheet', z.enum(['on', 'off']), DEFAULTS.paymentSheet),
      getSetting(db, 'invoicing.tax_mode', z.enum(['per_item', 'on_total']), DEFAULTS.taxMode),
      getSetting(db, 'invoicing.discount_below_margin', z.enum(['off', 'warn', 'block']), DEFAULTS.discountBelowMargin),
      getSetting(db, 'sale.over_avail_policy', z.enum(['warn', 'add_available']), DEFAULTS.overAvail),
      getSetting(db, 'parties.credit_limit_action', z.enum(['warn', 'block']), DEFAULTS.creditLimit),
      getSetting(db, 'fx.fallback', z.enum(['off', 'last_known']), DEFAULTS.fxFallback),
      getSetting(db, 'fx.daily_reminder', z.enum(['on', 'off']), DEFAULTS.fxDailyReminder),
    ]);
  return {
    printOnSave,
    paymentSheet,
    taxMode,
    discountBelowMargin: discount,
    overAvail,
    creditLimit,
    fxFallback,
    fxDailyReminder: fxReminder,
  };
}

export default function InvoicingSettingsScreen() {
  const router = useRouter();
  const feedback = useFeedback();

  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<InvoicingState>(DEFAULTS);

  useEffect(() => {
    let alive = true;
    (async () => {
      const db = await getDb();
      const loaded = await loadState(db);
      if (alive) {
        setState(loaded);
        setLoading(false);
      }
    })().catch(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** يطبّق تغيير مفتاح: كتابة فورية + تحديث محلي — رفض زود يُرجع القيمة السابقة */
  const apply = async <K extends keyof InvoicingState>(
    key: K,
    settingKey: string,
    value: InvoicingState[K],
  ): Promise<void> => {
    const prev = state[key];
    setState((s) => ({ ...s, [key]: value })); // استجابة فورية
    try {
      const db = await getDb();
      await setSetting(db, settingKey, value);
      feedback.show({ message: ar.settings.saved });
    } catch (err) {
      setState((s) => ({ ...s, [key]: prev })); // رجوع للقيمة السابقة عند الرفض
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.saveFailed });
    }
  };

  const toggle = (key: 'paymentSheet' | 'fxDailyReminder', settingKey: string, next: boolean) => {
    void apply(key, settingKey, next ? 'on' : 'off');
  };

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.settings.sections.invoicing}
        subtitle={ar.settings.invoicing.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <AppCard>
          <SegmentedControl<Schedule>
            label={ar.settings.invoicing.printOnSave}
            description={ar.settings.invoicing.printOnSaveDesc}
            options={[
              { value: 'print', label: ar.settings.invoicing.print },
              { value: 'ask', label: ar.settings.invoicing.printAsk },
              { value: 'no', label: ar.settings.invoicing.printNo },
            ]}
            value={state.printOnSave}
            onSelect={(v) => void apply('printOnSave', 'invoicing.print_on_save', v)}
            testID="invoicing-print-on-save"
          />
          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <Text style={styles.toggleLabel}>{ar.settings.invoicing.paymentSheet}</Text>
              <Text style={styles.toggleDesc}>{ar.settings.invoicing.paymentSheetDesc}</Text>
            </View>
            <Switch
              value={state.paymentSheet === 'on'}
              onValueChange={(v) => toggle('paymentSheet', 'invoicing.payment_sheet', v)}
              trackColor={{ false: colors.border, true: colors.accent }}
              thumbColor={colors.text}
              disabled={loading}
              accessibilityLabel={ar.settings.invoicing.paymentSheet}
            />
          </View>
          <SegmentedControl<'on_total' | 'per_item'>
            label={ar.settings.invoicing.taxMode}
            description={ar.settings.invoicing.taxModeDesc}
            options={[
              { value: 'on_total', label: ar.settings.invoicing.taxOnTotal },
              { value: 'per_item', label: ar.settings.invoicing.taxPerItem },
            ]}
            value={state.taxMode}
            onSelect={(v) => void apply('taxMode', 'invoicing.tax_mode', v)}
            testID="invoicing-tax-mode"
          />
          <SegmentedControl<'off' | 'warn' | 'block'>
            label={ar.settings.invoicing.discountBelowMargin}
            description={ar.settings.invoicing.discountBelowMarginDesc}
            options={[
              { value: 'off', label: ar.settings.invoicing.marginOff },
              { value: 'warn', label: ar.settings.invoicing.marginWarn },
              { value: 'block', label: ar.settings.invoicing.marginBlock },
            ]}
            value={state.discountBelowMargin}
            onSelect={(v) => void apply('discountBelowMargin', 'invoicing.discount_below_margin', v)}
            testID="invoicing-margin"
          />
          <SegmentedControl<'warn' | 'add_available'>
            label={ar.settings.invoicing.overAvail}
            description={ar.settings.invoicing.overAvailDesc}
            options={[
              { value: 'warn', label: ar.settings.invoicing.overWarn },
              { value: 'add_available', label: ar.settings.invoicing.overAddAvailable },
            ]}
            value={state.overAvail}
            onSelect={(v) => void apply('overAvail', 'sale.over_avail_policy', v)}
            testID="invoicing-over-avail"
          />
          <SegmentedControl<'warn' | 'block'>
            label={ar.settings.invoicing.creditLimit}
            description={ar.settings.invoicing.creditLimitDesc}
            options={[
              { value: 'warn', label: ar.settings.invoicing.creditWarn },
              { value: 'block', label: ar.settings.invoicing.creditBlock },
            ]}
            value={state.creditLimit}
            onSelect={(v) => void apply('creditLimit', 'parties.credit_limit_action', v)}
            testID="invoicing-credit-limit"
          />
          <SegmentedControl<'off' | 'last_known'>
            label={ar.settings.invoicing.fxFallback}
            description={ar.settings.invoicing.fxFallbackDesc}
            options={[
              { value: 'off', label: ar.settings.invoicing.fxOff },
              { value: 'last_known', label: ar.settings.invoicing.fxLastKnown },
            ]}
            value={state.fxFallback}
            onSelect={(v) => void apply('fxFallback', 'fx.fallback', v)}
            testID="invoicing-fx-fallback"
          />
          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <Text style={styles.toggleLabel}>{ar.settings.invoicing.fxDailyReminder}</Text>
              <Text style={styles.toggleDesc}>{ar.settings.invoicing.fxDailyReminderDesc}</Text>
            </View>
            <Switch
              value={state.fxDailyReminder === 'on'}
              onValueChange={(v) => toggle('fxDailyReminder', 'fx.daily_reminder', v)}
              trackColor={{ false: colors.border, true: colors.accent }}
              thumbColor={colors.text}
              disabled={loading}
              accessibilityLabel={ar.settings.invoicing.fxDailyReminder}
            />
          </View>
        </AppCard>
        {feedback.host}
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
  },
  toggleRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  toggleText: {
    flex: 1,
    gap: 4,
  },
  toggleLabel: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 21,
  },
  toggleDesc: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 18,
  },
});
