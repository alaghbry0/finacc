/**
 * parties/party-edit.tsx — نموذج العميل/المورد (ملف واحد بمعامل `kind` + `id` اختياري):
 *  - FR-03-01: حد ائتمان ثلاثي الحالات (بلا حد | منع الآجل | قيمة→NumberPad).
 *  - الرصيد الافتتاحي بعملته وسعره وتاريخه (العملة منتقى — الأساس افتراضياً،
 *    والتاريخ اليوم) — النموذج يرسل undefined عند عدم تغييره في التعديل (إبقاء الدومين).
 *  - المورد بلا حد ائتمان/واتساب/منطقة (SupplierInputSchema) — الافتتاحي = مستحق له.
 *  - كل المبالغ عبر MoneyField (NumberPad في BottomSheet — DS-38).
 *  - أخطاء زود Inline لكل حقل (mapErrorToFields) وأخطاء الدومين في FeedbackBar
 *    (مثل MissingRateError عند عملة بلا سعر يوم).
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Save } from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  createCustomer,
  createSupplier,
  getCustomer,
  getSupplier,
  updateCustomer,
  updateSupplier,
  type PartyRow,
} from '@/domain/parties';
import { listActiveCurrencies, type CurrencyLite } from '@/db/queries';
import { ar } from '@/i18n/ar';
import { useSession } from '@/store/session';
import { colors, font, radius, spacing, touch } from '@/theme';
import { todayISO } from '@/utils/format';
import { d } from '@/utils/money';
import {
  domainErrorMessage,
  mapErrorToFields,
  technicalText,
  type FieldErrors,
} from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import MoneyField from '@/components/ui/MoneyField';
import PickerField from '@/components/ui/PickerField';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

type PartyKind = 'customer' | 'supplier';
type CreditMode = 'none' | 'block' | 'value';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'ready' };

/** القيم الافتتاحية الأصلية — إن لم تتغير لا تُرسل في التعديل (إبقاء الدومين لها) */
interface OpeningSnapshot {
  balance: string;
  currencyId: number | null;
  date: string | null;
}

export default function PartyEditScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const params = useLocalSearchParams<{ kind?: string; id?: string }>();
  const kind: PartyKind = params.kind === 'supplier' ? 'supplier' : 'customer';
  const partyId = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  const isEdit = partyId !== null;
  const isCustomer = kind === 'customer';

  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [currencies, setCurrencies] = useState<CurrencyLite[]>([]);
  const [initialOpening, setInitialOpening] = useState<OpeningSnapshot | null>(null);

  /* ——— الحقول ——— */
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [address, setAddress] = useState('');
  const [area, setArea] = useState('');
  const [creditMode, setCreditMode] = useState<CreditMode>('none');
  const [creditValue, setCreditValue] = useState('0');
  const [openingBalance, setOpeningBalance] = useState('0');
  const [openingCurrencyId, setOpeningCurrencyId] = useState<number | null>(null);
  const [openingDate, setOpeningDate] = useState(todayISO());
  const [notes, setNotes] = useState('');

  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const loadOnce = useRef(false);

  const clearField = (field: string) => {
    setErrors((prev) => {
      if (prev[field] === undefined) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  useEffect(() => {
    if (loadOnce.current) return;
    loadOnce.current = true;
    let alive = true;
    (async () => {
      const db = await getDb();
      const currenciesRows = await listActiveCurrencies(db);
      if (!alive) return;
      setCurrencies(currenciesRows);
      const base = currenciesRows.find((c) => c.isBase) ?? currenciesRows[0] ?? null;
      setOpeningCurrencyId(base?.id ?? null);

      if (partyId === null) {
        setLoadState({ kind: 'ready' });
        return;
      }
      const party: PartyRow | null = isCustomer
        ? await getCustomer(db, partyId)
        : await getSupplier(db, partyId);
      if (!alive) return;
      if (!party) {
        setLoadState({ kind: 'error', technical: ar.parties.file.notFound });
        return;
      }
      setName(party.name);
      setPhone(party.phone ?? '');
      if (isCustomer) {
        setWhatsapp(party.whatsapp ?? '');
        setArea(party.area ?? '');
        if (party.creditLimit === null) setCreditMode('none');
        else if (d(party.creditLimit).isZero()) setCreditMode('block');
        else {
          setCreditMode('value');
          setCreditValue(party.creditLimit);
        }
      }
      setAddress(party.address ?? '');
      setOpeningBalance(d(party.openingBalance).gt(0) ? party.openingBalance : '0');
      setOpeningCurrencyId(party.openingCurrencyId ?? base?.id ?? null);
      setOpeningDate(party.openingDate ?? todayISO());
      setNotes(party.notes ?? '');
      setInitialOpening({
        balance: party.openingBalance,
        currencyId: party.openingCurrencyId,
        date: party.openingDate,
      });
      setLoadState({ kind: 'ready' });
    })().catch((err: unknown) => {
      if (alive) setLoadState({ kind: 'error', technical: technicalText(err) });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, kind]);

  const openingCurrency = currencies.find((c) => c.id === openingCurrencyId) ?? null;
  const dec = openingCurrency?.decimals ?? 2;

  const title = isEdit
    ? isCustomer
      ? ar.parties.form.editCustomerTitle
      : ar.parties.form.editSupplierTitle
    : isCustomer
      ? ar.parties.form.newCustomerTitle
      : ar.parties.form.newSupplierTitle;

  /* ——— هل تغيّر الرصيد الافتتاحي؟ (undefined عند التطابق = إبقاء الدومين) ——— */
  const openingChanged = (): boolean => {
    if (!isEdit) return true;
    if (!initialOpening) return true;
    const sameBalance = d(openingBalance).eq(d(initialOpening.balance));
    const sameCurrency = openingCurrencyId === (initialOpening.currencyId ?? openingCurrencyId);
    const sameDate = openingDate === (initialOpening.date ?? openingDate);
    return !(sameBalance && sameCurrency && sameDate);
  };

  /* ——— الحفظ ——— */
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setErrors({});
    try {
      const db = await getDb();
      const creditInput =
        creditMode === 'none' ? null : creditMode === 'block' ? '0' : creditValue;
      const sendOpening = openingChanged();
      if (isCustomer) {
        const input = {
          name: name.trim(),
          phone: phone.trim(),
          whatsapp: whatsapp.trim(),
          address: address.trim(),
          area: area.trim(),
          creditLimit: creditInput,
          ...(sendOpening
            ? {
                openingBalance: openingBalance === '' ? '0' : openingBalance,
                openingCurrencyId: openingCurrencyId ?? undefined,
                openingDate,
              }
            : {}),
          notes: notes.trim(),
        };
        if (isEdit && partyId !== null) {
          await updateCustomer(db, partyId, input);
          useSession.getState().showFlash(ar.parties.form.savedEditCustomer);
        } else {
          await createCustomer(db, input);
          useSession.getState().showFlash(ar.parties.form.savedNewCustomer);
        }
      } else {
        const input = {
          name: name.trim(),
          phone: phone.trim(),
          address: address.trim(),
          ...(sendOpening
            ? {
                openingBalance: openingBalance === '' ? '0' : openingBalance,
                openingCurrencyId: openingCurrencyId ?? undefined,
                openingDate,
              }
            : {}),
          notes: notes.trim(),
        };
        if (isEdit && partyId !== null) {
          await updateSupplier(db, partyId, input);
          useSession.getState().showFlash(ar.parties.form.savedEditSupplier);
        } else {
          await createSupplier(db, input);
          useSession.getState().showFlash(ar.parties.form.savedNewSupplier);
        }
      }
      router.back();
    } catch (err) {
      const fields = mapErrorToFields(err);
      setErrors(fields);
      const general = fields._form ?? null;
      if (general) {
        feedback.show({ message: general });
      } else if (Object.keys(fields).length === 0) {
        feedback.show({ message: domainErrorMessage(err) ?? ar.components.errorState.title });
      }
    } finally {
      setSaving(false);
    }
  };

  if (loadState.kind === 'loading') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={title} onBack={() => router.back()} />
        <LoadingState variant="card" />
      </SafeScreen>
    );
  }
  if (loadState.kind === 'error') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={title} onBack={() => router.back()} />
        <ErrorState
          message={ar.parties.file.errorLoad}
          technical={loadState.technical}
          onRetry={() => router.back()}
          retryLabel={ar.common.back}
        />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen offline={false} avoidKeyboard>
      <ScreenHeader
        title={title}
        subtitle={isCustomer && !isEdit ? ar.parties.form.newCustomerSub : undefined}
        onBack={() => router.back()}
      />

      <AppCard style={styles.formCard}>
        <TextField
          label={ar.parties.form.name}
          value={name}
          onChangeText={(v) => {
            setName(v);
            clearField('name');
          }}
          placeholder={ar.parties.form.namePh}
          error={errors.name ?? null}
          testID="party-name-input"
        />

        <TextField
          label={ar.parties.form.phone}
          value={phone}
          onChangeText={(v) => {
            setPhone(v.replace(/[^\d+]/g, '').slice(0, 15));
            clearField('phone');
          }}
          placeholder={ar.parties.form.phonePh}
          keyboardType="phone-pad"
          error={errors.phone ?? null}
          testID="party-phone-input"
        />

        {isCustomer ? (
          <>
            <TextField
              label={ar.parties.form.whatsapp}
              value={whatsapp}
              onChangeText={(v) => {
                setWhatsapp(v.replace(/[^\d+]/g, '').slice(0, 15));
                clearField('whatsapp');
              }}
              placeholder={ar.parties.form.whatsappPh}
              keyboardType="phone-pad"
              error={errors.whatsapp ?? null}
              testID="party-whatsapp-input"
            />
            <TextField
              label={ar.parties.form.area}
              value={area}
              onChangeText={(v) => {
                setArea(v);
                clearField('area');
              }}
              placeholder={ar.parties.form.areaPh}
              error={errors.area ?? null}
              testID="party-area-input"
            />
          </>
        ) : null}

        <TextField
          label={ar.parties.form.address}
          value={address}
          onChangeText={(v) => {
            setAddress(v);
            clearField('address');
          }}
          placeholder={ar.parties.form.addressPh}
          error={errors.address ?? null}
          testID="party-address-input"
        />

        {/* حد الائتمان — ثلاثي الحالات (FR-03-01) */}
        {isCustomer ? (
          <View style={styles.creditBox}>
            <Text style={styles.label}>{ar.parties.form.creditLimit}</Text>
            <View style={styles.creditSeg}>
              {(
                [
                  ['none', ar.parties.form.creditNone],
                  ['block', ar.parties.form.creditBlock],
                  ['value', ar.parties.form.creditValue],
                ] as [CreditMode, string][]
              ).map(([mode, label]) => {
                const active = creditMode === mode;
                return (
                  <Pressable
                    key={mode}
                    accessibilityRole="button"
                    accessibilityLabel={`${ar.parties.form.creditLimit}: ${label}`}
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      setCreditMode(mode);
                      clearField('creditLimit');
                    }}
                    style={[styles.creditBtn, active && styles.creditBtnActive]}
                    testID={`credit-mode-${mode}`}
                  >
                    <Text
                      style={[
                        styles.creditBtnText,
                        active && styles.creditBtnTextActive,
                        mode === 'block' && active && styles.creditBlockText,
                      ]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {creditMode === 'value' ? (
              <MoneyField
                label={ar.parties.form.creditValue}
                value={creditValue}
                onChange={(v) => {
                  setCreditValue(v);
                  clearField('creditLimit');
                }}
                currencyCode={openingCurrency?.code}
                decimals={dec}
                error={errors.creditLimit ?? null}
                style={styles.creditValueField}
                testID="credit-value-input"
              />
            ) : null}
            <Text style={styles.creditHint}>{ar.parties.form.creditHint}</Text>
            {errors.creditLimit ? (
              <Text style={styles.fieldError}>{errors.creditLimit}</Text>
            ) : null}
          </View>
        ) : null}

        {/* الرصيد الافتتاحي + عملته + تاريخه */}
        <MoneyField
          label={ar.parties.form.openingBalance}
          value={openingBalance}
          onChange={(v) => {
            setOpeningBalance(v);
            clearField('openingBalance');
          }}
          currencyCode={openingCurrency?.code}
          decimals={dec}
          hint={
            isCustomer ? ar.parties.form.openingCustomerHint : ar.parties.form.openingSupplierHint
          }
          error={errors.openingBalance ?? null}
          testID="party-opening-input"
        />

        <View style={styles.openingRow}>
          <View style={styles.openingCurrencyField}>
            <PickerField
              label={ar.parties.form.openingCurrency}
              title={ar.parties.form.openingCurrency}
              options={currencies.map((c) => ({
                id: c.id,
                label: c.name,
                detail: c.code,
              }))}
              selectedId={openingCurrencyId}
              onSelect={(id) => {
                setOpeningCurrencyId(id);
                clearField('openingCurrencyId');
              }}
              error={errors.openingCurrencyId ?? null}
              testID="party-opening-currency"
            />
          </View>
          <View style={styles.openingDateField}>
            <TextField
              label={ar.parties.form.openingDate}
              value={openingDate}
              onChangeText={(v) => {
                setOpeningDate(v);
                clearField('openingDate');
              }}
              placeholder="YYYY-MM-DD"
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              hint={ar.parties.form.dateHint}
              error={errors.openingDate ?? null}
              testID="party-opening-date"
            />
          </View>
        </View>

        <TextField
          label={ar.parties.form.notes}
          value={notes}
          onChangeText={setNotes}
          placeholder={ar.parties.form.notesPh}
          multiline
          testID="party-notes-input"
        />

        <PrimaryButton
          label={isEdit ? ar.parties.form.saveEdit : ar.parties.form.saveNew}
          icon={Save}
          onPress={save}
          loading={saving}
          style={styles.saveBtn}
          testID="party-save-btn"
        />
      </AppCard>

      {feedback.host}
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  formCard: {
    gap: spacing.lg,
  },
  label: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'right',
  },
  creditBox: {
    gap: 8,
  },
  creditSeg: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    gap: 4,
  },
  creditBtn: {
    flex: 1,
    minHeight: touch.min - 8,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  creditBtnActive: {
    backgroundColor: colors.accent,
  },
  creditBtnText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  creditBtnTextActive: {
    color: colors.onAccent,
    fontFamily: font.bold,
  },
  creditBlockText: {
    color: colors.onAccent,
  },
  creditValueField: {
    marginTop: spacing.xs,
  },
  creditHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  fieldError: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  openingRow: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
  },
  openingCurrencyField: {
    flex: 1,
  },
  openingDateField: {
    flex: 1,
  },
  saveBtn: {
    marginTop: spacing.xs,
  },
});
