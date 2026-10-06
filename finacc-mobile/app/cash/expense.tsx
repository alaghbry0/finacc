/**
 * cash/expense.tsx — تسجيل مصروف (Task 10 — FR-04-05):
 *
 *  - الفئة (OptionPickerSheet من expense_category — بذر التهيئة: رواتب/
 *    مصاريف عامة/إيجار/نقل ومواصلات) + الصندوق + العملة (تتبع الصندوق،
 *    مع تدفق فحص سعر اليوم — قرار 3) + المبلغ بNumberPad + البيان + التاريخ.
 *  - الحفظ عبر domain.recordExpense (Transaction ذرّية + فئة إلزامية —
 *    «الراتب مصروف بفئة رواتب» بديل وحدة الموظفين المؤجلة، ملحق ح).
 *  - بعد الحفظ: FeedbackBar عربي + رجوع لتبويب النقدية (يتحدّث عند العودة).
 *  - أخطاء الدومين inline: زود → حقول (amount/…)؛ قواعد → رسالة عربية.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CalendarDays, Receipt } from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  getCashboxBalances,
  listActiveCurrencies,
  listExpenseCategories,
  type CashboxBalance,
  type CurrencyLite,
  type RefRow,
} from '@/db/queries';
import { recordExpense } from '@/domain/cash';
import { resolveRate, upsertDailyRate } from '@/domain/currency';
import { MissingRateError } from '@/domain/errors';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { currencySymbol, formatAmount, formatDateAr, todayISO } from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage, mapErrorToFields, type FieldErrors } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import LoadingState from '@/components/ui/LoadingState';
import MoneyField from '@/components/ui/MoneyField';
import NumberPad from '@/components/ui/NumberPad';
import OptionPickerSheet from '@/components/ui/OptionPickerSheet';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

/* يمسح رسالة خطأ حقل واحد من الخريطة (بلا قيم undefined — FieldErrors نصية) */
function withoutField(fields: FieldErrors, field: string): FieldErrors {
  const next: FieldErrors = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k !== field) next[k] = v;
  }
  return next;
}

/* صف منتقى (فئة/صندوق/عملة) — نمط رقاقة السند نفسه */
function FieldChip({
  label,
  value,
  detail,
  onPress,
  error,
  testID,
}: {
  label: string;
  value: string;
  detail?: string;
  onPress?: () => void;
  error?: string | null;
  testID?: string;
}) {
  const hasError = error !== null && error !== undefined && error !== '';
  const body = (
    <View style={[styles.fieldChip, hasError && styles.fieldChipError]}>
      <Text style={styles.fieldChipLabel}>{label}</Text>
      <Text style={styles.fieldChipValue} numberOfLines={1}>
        {detail ? `${value} · ${detail}` : value}
      </Text>
    </View>
  );
  if (!onPress) {
    return (
      <View testID={testID} style={styles.fieldChipStatic}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      style={({ pressed }) => [styles.fieldChipStatic, pressed && styles.fieldChipPressed]}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

export default function ExpenseScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const userId = session.user?.id;
  const today = todayISO();

  const [categories, setCategories] = useState<RefRow[]>([]);
  const [balances, setBalances] = useState<CashboxBalance[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyLite[]>([]);
  const [booted, setBooted] = useState(false);

  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [cashboxId, setCashboxId] = useState<number | null>(null);
  const [currencyId, setCurrencyId] = useState<number | null>(null);
  const [rate, setRate] = useState('1');
  const [amount, setAmount] = useState('0');
  const [description, setDescription] = useState('');

  const [categorySheet, setCategorySheet] = useState(false);
  const [cashboxSheet, setCashboxSheet] = useState(false);
  const [currencySheet, setCurrencySheet] = useState(false);
  const [rateSheet, setRateSheet] = useState(false);
  const [rateValue, setRateValue] = useState('0');

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const saveRetry = useRef<(() => void) | null>(null);

  /* ============ التهيئة ============ */

  useEffect(() => {
    if (booted || !session.ready || session.locked || !session.defaults) return;
    const defaults = session.defaults;
    setBooted(true);
    void (async () => {
      try {
        const db = await getDb();
        const [cats, boxes, curs] = await Promise.all([
          listExpenseCategories(db),
          getCashboxBalances(db),
          listActiveCurrencies(db),
        ]);
        setCategories(cats);
        setBalances(boxes);
        setCurrencies(curs);
        setCategoryId(cats[0]?.id ?? null);
        const box = boxes.find((b) => b.isDefault) ?? boxes[0] ?? null;
        setCashboxId(box ? box.id : null);
        if (box) {
          setCurrencyId(box.currencyId);
          if (box.currencyId !== defaults.baseCurrencyId) {
            try {
              const resolved = await resolveRate(db, box.currencyId, today);
              setRate(resolved.rate);
            } catch {
              setRate('0');
            }
          } else {
            setRate('1');
          }
        } else {
          setCurrencyId(defaults.baseCurrencyId);
          setRate('1');
        }
      } catch {
        // دفاعي
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.ready, session.locked, session.defaults]);

  /* ============ العملة + سعر اليوم (قرار 3) ============ */

  const onSelectCurrency = async (id: number | null) => {
    if (id === null || id === currencyId) return;
    const cur = currencies.find((c) => c.id === id);
    if (!cur) return;
    if (cur.isBase || id === session.defaults?.baseCurrencyId) {
      setCurrencyId(id);
      setRate('1');
      return;
    }
    try {
      const db = await getDb();
      const resolved = await resolveRate(db, id, today);
      setCurrencyId(id);
      setRate(resolved.rate);
    } catch (err) {
      if (err instanceof MissingRateError) {
        setRateValue('0');
        saveRetry.current = () => {
          void (async () => {
            const db = await getDb();
            const resolved = await resolveRate(db, id, today);
            setCurrencyId(id);
            setRate(resolved.rate);
          })();
        };
        setRateSheet(true);
        return;
      }
      feedback.show({ message: domainErrorMessage(err) ?? ar.cash.expense.failed });
    }
  };

  const onSelectCashbox = async (id: number) => {
    setCashboxId(id);
    const box = balances.find((b) => b.id === id);
    if (!box) return;
    if (box.currencyId === session.defaults?.baseCurrencyId) {
      setCurrencyId(box.currencyId);
      setRate('1');
      return;
    }
    try {
      const db = await getDb();
      const resolved = await resolveRate(db, box.currencyId, today);
      setCurrencyId(box.currencyId);
      setRate(resolved.rate);
    } catch {
      setCurrencyId(box.currencyId);
      setRate('0');
    }
  };

  /* ============ الحفظ (recordExpense — فئة إلزامية) ============ */

  const doSave = async (afterRate = false) => {
    if (categoryId === null) {
      setFieldErrors({ category: ar.cash.expense.needCategory });
      setCategorySheet(true);
      return;
    }
    if (cashboxId === null) {
      feedback.show({ message: ar.cash.expense.needCashbox });
      return;
    }
    if (!d(amount).gt(0)) {
      setFieldErrors({ amount: ar.cash.expense.needAmount });
      return;
    }
    if (currencyId === null) {
      feedback.show({ message: ar.cash.expense.failed });
      return;
    }
    setSaving(true);
    setFieldErrors({});
    try {
      const db = await getDb();
      let expenseRate = rate;
      if (!d(expenseRate).gt(0)) {
        const resolved = await resolveRate(db, currencyId, today);
        expenseRate = resolved.rate;
        setRate(resolved.rate);
      }
      await recordExpense(
        db,
        {
          cashboxId,
          currencyId,
          amount,
          exchangeRate: expenseRate,
          txDate: today,
          expenseCategoryId: categoryId,
          description: description.trim() !== '' ? description.trim() : undefined,
        },
        { createdBy: userId },
      );
      feedback.show({ message: ar.cash.expense.saved, durationMs: 5000 });
      router.back();
    } catch (err) {
      if (err instanceof MissingRateError && !afterRate) {
        setRateValue('0');
        saveRetry.current = () => void doSave(true);
        setRateSheet(true);
        return;
      }
      setFieldErrors(mapErrorToFields(err, { EXPENSE_CATEGORY_NOT_FOUND: 'category' }));
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cash.expense.failed,
        durationMs: 8000,
      });
    } finally {
      setSaving(false);
    }
  };

  /* ============ شيت سعر اليوم ============ */

  const saveRate = async () => {
    if (!d(rateValue).gt(0)) {
      feedback.show({ message: ar.cash.voucher.rateInvalid });
      return;
    }
    try {
      const db = await getDb();
      if (currencyId === null) return;
      await upsertDailyRate(db, currencyId, today, rateValue);
      setRate(rateValue);
      setRateSheet(false);
      feedback.show({ message: ar.cash.voucher.rateSaved });
      saveRetry.current?.();
    } catch (err) {
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cash.voucher.rateInvalid,
        durationMs: 8000,
      });
    }
  };

  /* ============ حرس الجلسة ============ */

  if (!session.ready || session.locked || !session.defaults) {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.cash.expense.title} onBack={() => router.back()} />
        <AppCard noPadding>
          <LoadingState variant="list" rows={3} />
        </AppCard>
      </SafeScreen>
    );
  }

  const cashbox = balances.find((b) => b.id === cashboxId) ?? null;
  const currency = currencies.find((c) => c.id === currencyId) ?? null;
  const category = categories.find((c) => c.id === categoryId) ?? null;
  const decimals = currency?.decimals ?? 0;
  const currencyCode = currency?.code ?? session.defaults.baseCurrencyCode ?? '';

  return (
    <SafeScreen scroll={false} padded={false} offline>
      <View style={styles.screen}>
        <ScreenHeader
          title={ar.cash.expense.title}
          subtitle={ar.cash.expense.subtitle}
          onBack={() => router.back()}
        />

        <View style={styles.body}>
          {/* ——— الفئة / الصندوق / العملة / التاريخ ——— */}
          <AppCard style={styles.metaCard}>
            <View style={styles.metaRow}>
              <FieldChip
                label={ar.cash.expense.category}
                value={category ? category.name : '—'}
                onPress={() => setCategorySheet(true)}
                error={fieldErrors.category ?? null}
                testID="expense-meta-category"
              />
              <FieldChip
                label={ar.cash.expense.cashbox}
                value={cashbox ? cashbox.name : '—'}
                detail={
                  cashbox
                    ? `${formatAmount(cashbox.balance, cashbox.currencyDecimals)} ${currencySymbol(cashbox.currencyCode)}`
                    : undefined
                }
                onPress={balances.length > 1 ? () => setCashboxSheet(true) : undefined}
                testID="expense-meta-cashbox"
              />
              <FieldChip
                label={ar.cash.expense.currency}
                value={currencyCode || '—'}
                onPress={() => setCurrencySheet(true)}
                testID="expense-meta-currency"
              />
              <View style={styles.fieldChipStatic}>
                <View style={styles.fieldChip}>
                  <Text style={styles.fieldChipLabel}>{ar.cash.expense.date}</Text>
                  <View style={styles.dateRow}>
                    <CalendarDays size={13} color={colors.textFaint} />
                    <Text style={styles.fieldChipValue}>{formatDateAr(today)}</Text>
                  </View>
                </View>
              </View>
            </View>
          </AppCard>

          {/* ——— المبلغ + البيان ——— */}
          <AppCard style={styles.amountCard}>
            <MoneyField
              label={ar.cash.expense.amount}
              value={amount}
              onChange={(v) => {
                setAmount(v);
                setFieldErrors((f) => withoutField(f, 'amount'));
              }}
              currencyCode={currencyCode || undefined}
              decimals={decimals}
              error={fieldErrors.amount ?? null}
              testID="expense-amount"
            />
            <TextField
              label={ar.cash.expense.description}
              value={description}
              onChangeText={setDescription}
              placeholder={ar.cash.expense.descriptionPh}
              testID="expense-desc"
            />
          </AppCard>
        </View>

        {/* ——— زر الحفظ ——— */}
        <View style={styles.bottomBar}>
          <PrimaryButton
            label={ar.cash.expense.save}
            icon={Receipt}
            tone="warning"
            loading={saving}
            onPress={() => void doSave()}
            testID="expense-save"
          />
        </View>
      </View>

      {/* ============ الشيتات ============ */}

      <OptionPickerSheet
        visible={categorySheet}
        title={ar.cash.expense.pickCategory}
        options={categories.map((c) => ({ id: c.id, label: c.name }))}
        selectedId={categoryId}
        onSelect={(id) => {
          setCategoryId(id);
          setFieldErrors((f) => withoutField(f, 'category'));
        }}
        onClose={() => setCategorySheet(false)}
        testID="expense-category-picker"
      />

      <OptionPickerSheet
        visible={cashboxSheet}
        title={ar.cash.expense.pickCashbox}
        options={balances.map((b) => ({
          id: b.id,
          label: b.name,
          detail: `${formatAmount(b.balance, b.currencyDecimals)} ${currencySymbol(b.currencyCode)}`,
        }))}
        selectedId={cashboxId}
        onSelect={(id) => id !== null && void onSelectCashbox(id)}
        onClose={() => setCashboxSheet(false)}
        testID="expense-cashbox-picker"
      />

      <OptionPickerSheet
        visible={currencySheet}
        title={ar.cash.expense.pickCurrency}
        options={currencies.map((c) => ({ id: c.id, label: c.name, detail: c.code }))}
        selectedId={currencyId}
        onSelect={(id) => void onSelectCurrency(id)}
        onClose={() => setCurrencySheet(false)}
        testID="expense-currency-picker"
      />

      {/* شيت سعر اليوم (قرار 3) */}
      <BottomSheet visible={rateSheet} title={`${ar.cash.voucher.rateTitle} — ${currencyCode}`}>
        <NumberPad
          value={rateValue}
          onChange={setRateValue}
          allowDecimal
          decimals={4}
          label={ar.cash.voucher.rateLabel}
        />
        <Text style={styles.rateHint}>{ar.cash.voucher.rateHint}</Text>
        <PrimaryButton
          label={ar.cash.voucher.rateSave}
          onPress={() => void saveRate()}
          testID="expense-rate-save"
        />
      </BottomSheet>

      {feedback.host}
    </SafeScreen>
  );
}

/* ============ الأنماط ============ */

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  body: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.md,
  },
  metaCard: {
    padding: spacing.md,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  fieldChipStatic: {
    flexBasis: '48%',
    flexGrow: 1,
    borderRadius: radius.md,
  },
  fieldChipPressed: {
    opacity: 0.75,
  },
  fieldChip: {
    gap: 3,
    minHeight: touch.min + 6,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  fieldChipError: {
    borderColor: colors.danger,
  },
  fieldChipLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  fieldChipValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'right',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  amountCard: {
    gap: spacing.md,
  },
  bottomBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  rateHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
});
