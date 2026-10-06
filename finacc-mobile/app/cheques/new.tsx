/**
 * cheques/new.tsx — شيك جديد (FR-14-01 — Task 12):
 *
 *  - مبدّل اتجاه: وارد من عميل ← صادر لمورّد (يقلب قوائم الطرف والفواتير).
 *  - منتقي الطرف (بحث + جديد) + رقم الشيك (إلزامي) + البنك + المبلغ
 *    + العملة بفحص سعر اليوم (MissingRateSheet — قرار 3) + تاريخا
 *    الإصدار/الاستحقاق (نمط YYYY-MM-DD) + ملاحظات.
 *  - ربط اختياري بفاتورة مفتوحة للطرف (معاينة المتبقي) — تُخصص أولاً
 *    عند التحصيل (recordCheque يتحقق: العائلة/الطرف/حية/متبقٍ).
 *  - الحفظ عبر domain/recordCheque (Transaction ذرّية + audit) —
 *    **لا يمس الصندوق ولا كشف الطرف** (FR-14-02) — رسالة النجاح توضحها.
 *  - شيت نجاح: ملخص الشيك + «تفاصيل الشيك» / «شيك آخر».
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowDownToLine, ArrowUpFromLine, Banknote, Plus } from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  getOpenInvoicesForParty,
  listActiveCurrencies,
  type CurrencyLite,
  type OpenInvoiceRow,
} from '@/db/queries';
import { recordCheque } from '@/domain/cheques';
import { resolveRate, upsertDailyRate } from '@/domain/currency';
import { listCustomers, listSuppliers, type PartyRow } from '@/domain/parties';
import { MissingRateError } from '@/domain/errors';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import {
  currencySymbol,
  formatAmount,
  formatDayShortAr,
  todayISO,
} from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage, technicalText, type FieldErrors } from '@/utils/validation';
import AmountText from '@/components/ui/AmountText';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import LoadingState from '@/components/ui/LoadingState';
import MoneyField from '@/components/ui/MoneyField';
import NumberPad from '@/components/ui/NumberPad';
import OptionPickerSheet from '@/components/ui/OptionPickerSheet';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import SearchBar from '@/components/ui/SearchBar';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

type Direction = 'in' | 'out';

interface SavedCheque {
  chequeId: number;
  chequeNo: string;
  partyName: string;
  amount: string;
  currencyCode: string;
  currencyDecimals: number;
  dueDate: string;
}

/** يمسح حقل خطأ واحد من الخريطة */
function withoutField(fields: FieldErrors, field: string): FieldErrors {
  const next: FieldErrors = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k !== field) next[k] = v;
  }
  return next;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function NewChequeScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const userId = session.user?.id;
  const today = todayISO();

  /* ——— النموذج ——— */
  const [direction, setDirection] = useState<Direction>('in');
  const [party, setParty] = useState<{ id: number; name: string } | null>(null);
  const [chequeNo, setChequeNo] = useState('');
  const [bankName, setBankName] = useState('');
  const [amount, setAmount] = useState('0');
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [refInvoiceId, setRefInvoiceId] = useState<number | null>(null);

  /* ——— المرجعيات ——— */
  const [currencies, setCurrencies] = useState<CurrencyLite[]>([]);
  const [currencyId, setCurrencyId] = useState<number | null>(null);
  const [rate, setRate] = useState('1');
  const [booted, setBooted] = useState(false);

  /* ——— الشيتات ——— */
  const [partySheet, setPartySheet] = useState(false);
  const [partySearch, setPartySearch] = useState('');
  const [parties, setParties] = useState<PartyRow[]>([]);
  const [currencySheet, setCurrencySheet] = useState(false);
  const [rateSheet, setRateSheet] = useState(false);
  const [rateValue, setRateValue] = useState('0');

  const [openInvoices, setOpenInvoices] = useState<OpenInvoiceRow[] | null>(null);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SavedCheque | null>(null);

  const partyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRetry = useRef<(() => void) | null>(null);

  const isIn = direction === 'in';
  const title = isIn ? ar.cheques.new.titleIn : ar.cheques.new.titleOut;
  const subtitle = isIn ? ar.cheques.new.subtitleIn : ar.cheques.new.subtitleOut;

  /* ============ التهيئة ============ */

  useEffect(() => {
    if (booted || !session.ready || session.locked || !session.defaults) return;
    setBooted(true);
    void (async () => {
      try {
        const db = await getDb();
        const curs = await listActiveCurrencies(db);
        setCurrencies(curs);
        const base = curs.find((c) => c.isBase) ?? curs[0] ?? null;
        if (base) {
          setCurrencyId(base.id);
          setRate('1');
        }
      } catch {
        // دفاعي: قوائم أضيق بلا إسقاط للشاشة
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.ready, session.locked, session.defaults]);

  /* ============ بحث الأطراف داخل الشيت ============ */

  useEffect(() => {
    if (!partySheet) return;
    if (partyTimer.current) clearTimeout(partyTimer.current);
    partyTimer.current = setTimeout(async () => {
      try {
        const db = await getDb();
        const rows = isIn
          ? await listCustomers(db, { search: partySearch, limit: 50 })
          : await listSuppliers(db, { search: partySearch, limit: 50 });
        setParties(rows);
      } catch {
        setParties([]);
      }
    }, 180);
    return () => {
      if (partyTimer.current) clearTimeout(partyTimer.current);
    };
  }, [partySheet, partySearch, isIn]);

  /* ============ الفواتير المفتوحة للطرف ============ */

  const reloadOpenInvoices = useCallback(async (partyId: number) => {
    setInvoicesLoading(true);
    try {
      const db = await getDb();
      const rows = await getOpenInvoicesForParty(
        db,
        isIn ? { customerId: partyId } : { supplierId: partyId },
      );
      setOpenInvoices(rows);
    } catch {
      setOpenInvoices([]);
    } finally {
      setInvoicesLoading(false);
    }
  }, [isIn]);

  const onPickParty = (p: { id: number; name: string }) => {
    setParty(p);
    setRefInvoiceId(null);
    setFieldErrors((f) => withoutField(f, 'party'));
    setPartySheet(false);
    void reloadOpenInvoices(p.id);
  };

  const onSwitchDirection = (next: Direction) => {
    if (next === direction) return;
    setDirection(next);
    setParty(null);
    setRefInvoiceId(null);
    setOpenInvoices(null);
  };

  /* ============ العملة + سعر يوم الإصدار (قرار 3) ============ */

  const onSelectCurrency = async (id: number | null) => {
    if (id === null || id === currencyId) return;
    const cur = currencies.find((c) => c.id === id);
    if (!cur) return;
    if (cur.isBase) {
      setCurrencyId(id);
      setRate('1');
      return;
    }
    try {
      const db = await getDb();
      const resolved = await resolveRate(db, id, issueDate || today);
      setCurrencyId(id);
      setRate(resolved.rate);
    } catch (err) {
      if (err instanceof MissingRateError) {
        setRateValue('0');
        saveRetry.current = () => {
          setCurrencyId(id);
        };
        setRateSheet(true);
        return;
      }
      feedback.show({ message: domainErrorMessage(err) ?? ar.cheques.new.failed });
    }
  };

  const currency = currencies.find((c) => c.id === currencyId) ?? null;
  const decimals = currency?.decimals ?? 0;
  const currencyCode = currency?.code ?? session.defaults?.baseCurrencyCode ?? '';

  /* ============ الحفظ (recordCheque — ذرّية + audit) ============ */

  const doSave = async (afterRate = false) => {
    const errors: FieldErrors = {};
    if (party === null) errors.party = isIn ? ar.cheques.new.noParty : ar.cheques.new.noPartySupplier;
    if (chequeNo.trim() === '') errors.chequeNo = ar.cheques.new.needChequeNo;
    if (!d(amount).gt(0)) errors.amount = ar.cheques.new.needAmount;
    if (!DATE_RE.test(issueDate) || !DATE_RE.test(dueDate)) {
      errors.dueDate = ar.cheques.new.dateHint;
    } else if (dueDate < issueDate) {
      errors.dueDate = ar.cheques.new.dueBeforeIssue;
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.party) setPartySheet(true);
      return;
    }
    if (currencyId === null) {
      feedback.show({ message: ar.cheques.new.failed });
      return;
    }
    setSaving(true);
    setFieldErrors({});
    try {
      const db = await getDb();
      const result = await recordCheque(
        db,
        {
          direction,
          partyId: party!.id,
          chequeNo: chequeNo.trim(),
          bankName: bankName.trim() !== '' ? bankName.trim() : undefined,
          amount,
          currencyId,
          exchangeRate: d(rate).gt(0) ? rate : undefined, // غائب → resolveRate بالسند
          issueDate,
          dueDate,
          refInvoiceId: refInvoiceId ?? undefined,
          notes: notes.trim() !== '' ? notes.trim() : undefined,
        },
        { createdBy: userId },
      );
      setSaved({
        chequeId: result.chequeId,
        chequeNo: chequeNo.trim(),
        partyName: party!.name,
        amount,
        currencyCode,
        currencyDecimals: decimals,
        dueDate,
      });
      // مسح المدخلات للشيك التالي
      setChequeNo('');
      setBankName('');
      setAmount('0');
      setNotes('');
      setRefInvoiceId(null);
      feedback.show({ message: ar.cheques.new.saved, durationMs: 5000 });
      void reloadOpenInvoices(party!.id);
    } catch (err) {
      if (err instanceof MissingRateError && !afterRate) {
        setRateValue('0');
        saveRetry.current = () => void doSave(true);
        setRateSheet(true);
        return;
      }
      feedback.show({
        message: domainErrorMessage(err) ?? technicalText(err) ?? ar.cheques.new.failed,
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
      await upsertDailyRate(db, currencyId, issueDate || today, rateValue);
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
        <ScreenHeader title={title} onBack={() => router.back()} />
        <AppCard noPadding>
          <LoadingState variant="list" rows={3} />
        </AppCard>
      </SafeScreen>
    );
  }

  const partyError = fieldErrors.party ?? null;
  // بحث مباشر بلا Hook (Hook بعد early-return يكسر قواعد الترتيب)
  const selectedInvoice =
    (openInvoices ?? []).find((i) => i.id === refInvoiceId) ?? null;

  return (
    <SafeScreen scroll={false} padded={false} avoidKeyboard offline>
      <View style={styles.screen}>
        <ScreenHeader title={title} subtitle={subtitle} onBack={() => router.back()} />

        <View style={styles.body}>
          {/* ——— مبدّل الاتجاه ——— */}
          <View style={styles.directionSeg}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={ar.cheques.new.directionIn}
              accessibilityState={{ selected: isIn }}
              onPress={() => onSwitchDirection('in')}
              style={[styles.directionBtn, isIn && styles.directionBtnIn]}
              testID="cheque-direction-in"
            >
              <ArrowDownToLine size={16} color={isIn ? colors.onAccent : colors.success} />
              <Text style={[styles.directionText, isIn && styles.directionTextActive]}>
                {ar.cheques.new.directionIn}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={ar.cheques.new.directionOut}
              accessibilityState={{ selected: !isIn }}
              onPress={() => onSwitchDirection('out')}
              style={[styles.directionBtn, !isIn && styles.directionBtnOut]}
              testID="cheque-direction-out"
            >
              <ArrowUpFromLine size={16} color={!isIn ? colors.onAccent : colors.danger} />
              <Text style={[styles.directionText, !isIn && styles.directionTextActive]}>
                {ar.cheques.new.directionOut}
              </Text>
            </Pressable>
          </View>

          {/* ——— الطرف + العملة ——— */}
          <AppCard style={styles.metaCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${isIn ? ar.cheques.new.party : ar.cheques.new.partySupplier}: ${party?.name ?? '—'}`}
              onPress={() => setPartySheet(true)}
              style={({ pressed }) => [styles.metaRow, pressed && styles.metaRowPressed]}
              testID="cheque-party-field"
            >
              <View style={styles.metaTexts}>
                <Text style={styles.metaLabel}>
                  {isIn ? ar.cheques.new.party : ar.cheques.new.partySupplier}
                </Text>
                <Text
                  style={[styles.metaValue, partyError && styles.metaValueError]}
                  numberOfLines={1}
                >
                  {party ? party.name : '—'}
                </Text>
              </View>
              <Text style={styles.metaChevron}>›</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${ar.cheques.new.currency}: ${currencyCode || '—'}`}
              onPress={() => setCurrencySheet(true)}
              style={({ pressed }) => [styles.metaRow, pressed && styles.metaRowPressed]}
              testID="cheque-currency-field"
            >
              <View style={styles.metaTexts}>
                <Text style={styles.metaLabel}>{ar.cheques.new.currency}</Text>
                <Text style={styles.metaValue} numberOfLines={1}>
                  {currencyCode || '—'}
                </Text>
              </View>
              <Text style={styles.metaChevron}>›</Text>
            </Pressable>
          </AppCard>

          {/* ——— رقم الشيك + البنك + المبلغ ——— */}
          <AppCard style={styles.formCard}>
            <TextField
              label={ar.cheques.new.chequeNo}
              value={chequeNo}
              onChangeText={(v) => {
                setChequeNo(v);
                setFieldErrors((f) => withoutField(f, 'chequeNo'));
              }}
              placeholder={ar.cheques.new.chequeNoPh}
              error={fieldErrors.chequeNo ?? null}
              testID="cheque-no-input"
            />
            <TextField
              label={ar.cheques.new.bankName}
              value={bankName}
              onChangeText={setBankName}
              placeholder={ar.cheques.new.bankNamePh}
              testID="cheque-bank-input"
            />
            <MoneyField
              label={ar.cheques.new.amount}
              value={amount}
              onChange={(v) => {
                setAmount(v);
                setFieldErrors((f) => withoutField(f, 'amount'));
              }}
              currencyCode={currencyCode || undefined}
              decimals={decimals}
              error={fieldErrors.amount ?? null}
              testID="cheque-amount"
            />
          </AppCard>

          {/* ——— التاريخان ——— */}
          <AppCard style={styles.formCard}>
            <View style={styles.datesRow}>
              <View style={styles.dateField}>
                <TextField
                  label={ar.cheques.new.issueDate}
                  value={issueDate}
                  onChangeText={(v) => {
                    setIssueDate(v);
                    setFieldErrors((f) => withoutField(f, 'issueDate'));
                  }}
                  placeholder="YYYY-MM-DD"
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                  hint={ar.cheques.new.dateHint}
                  testID="cheque-issue-date"
                />
              </View>
              <View style={styles.dateField}>
                <TextField
                  label={ar.cheques.new.dueDate}
                  value={dueDate}
                  onChangeText={(v) => {
                    setDueDate(v);
                    setFieldErrors((f) => withoutField(f, 'dueDate'));
                  }}
                  placeholder="YYYY-MM-DD"
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                  hint={ar.cheques.new.dateHint}
                  error={fieldErrors.dueDate ?? null}
                  testID="cheque-due-date"
                />
              </View>
            </View>
            <TextField
              label={ar.cheques.new.notes}
              value={notes}
              onChangeText={setNotes}
              placeholder={ar.cheques.new.notesPh}
              multiline
              testID="cheque-notes-input"
            />
          </AppCard>

          {/* ——— الفواتير المفتوحة (ربط اختياري) ——— */}
          {party !== null ? (
            <AppCard noPadding style={styles.invoicesCard}>
              <View style={styles.invoicesHead}>
                <Text style={styles.invoicesTitle}>{ar.cheques.new.openInvoices}</Text>
                <Text style={styles.invoicesHint} numberOfLines={1}>
                  {ar.cheques.new.openInvoicesHint}
                </Text>
              </View>
              {invoicesLoading ? (
                <View style={styles.invoicesLoadingPad}>
                  <LoadingState variant="list" rows={2} />
                </View>
              ) : (openInvoices ?? []).length === 0 ? (
                <View style={styles.noInvoicesBox}>
                  <Text style={styles.noInvoicesTitle}>{ar.cheques.new.noOpenInvoices}</Text>
                  <Text style={styles.noInvoicesHint}>{ar.cheques.new.noOpenInvoicesHint}</Text>
                </View>
              ) : (
                <View>
                  {(openInvoices ?? []).map((inv) => {
                    const selected = refInvoiceId === inv.id;
                    return (
                      <Pressable
                        key={inv.id}
                        accessibilityRole="button"
                        accessibilityLabel={inv.invoiceNo ?? '—'}
                        accessibilityState={{ selected }}
                        onPress={() => setRefInvoiceId(selected ? null : inv.id)}
                        style={({ pressed }) => [
                          styles.invoiceRow,
                          selected && styles.invoiceRowSelected,
                          pressed && styles.invoiceRowPressed,
                        ]}
                        testID={`cheque-invoice-${inv.id}`}
                      >
                        <View style={styles.invoiceTexts}>
                          <View style={styles.invoiceNoRow}>
                            <Text style={styles.invoiceNo}>{inv.invoiceNo ?? '—'}</Text>
                            <Text style={styles.invoiceDate}>{formatDayShortAr(inv.issuedAt)}</Text>
                          </View>
                          <Text style={styles.invoiceAmounts} numberOfLines={1}>
                            {`${ar.cheques.new.invoiceRemaining}: ${formatAmount(inv.remaining, inv.currencyDecimals)} ${currencySymbol(inv.currencyCode)}`}
                          </Text>
                        </View>
                        {selected ? <Text style={styles.optionCheck}>✓</Text> : null}
                      </Pressable>
                    );
                  })}
                  {selectedInvoice !== null ? (
                    <View style={styles.linkedBox}>
                      <Text style={styles.linkedText}>
                        {`${ar.cheques.new.linkedInvoice}: ${selectedInvoice.invoiceNo ?? '—'}`}
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.linkedBox}>
                      <Text style={styles.unlinkedText}>{ar.cheques.new.unlinkedInvoice}</Text>
                    </View>
                  )}
                </View>
              )}
            </AppCard>
          ) : null}
        </View>

        {/* ——— زر الحفظ ——— */}
        <View style={styles.bottomBar}>
          <PrimaryButton
            label={ar.cheques.new.save}
            icon={Banknote}
            tone={isIn ? 'success' : 'primary'}
            loading={saving}
            onPress={() => void doSave()}
            testID="cheque-save-btn"
          />
        </View>
      </View>

      {/* ============ الشيتات ============ */}

      {/* منتقي الطرف */}
      <BottomSheet
        visible={partySheet}
        onClose={() => setPartySheet(false)}
        title={isIn ? ar.cheques.new.pickParty : ar.cheques.new.pickPartySupplier}
      >
        <SearchBar
          value={partySearch}
          onChangeText={setPartySearch}
          placeholder={ar.cheques.new.searchParty}
          testID="cheque-party-search"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isIn ? ar.cheques.new.addParty : ar.cheques.new.addSupplier}
          onPress={() => {
            setPartySheet(false);
            router.push(
              isIn ? '/parties/party-edit?kind=customer' : '/parties/party-edit?kind=supplier',
            );
          }}
          style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
          testID="cheque-party-add-new"
        >
          <Plus size={18} color={colors.accent} />
          <Text style={styles.partyAddText}>
            {isIn ? ar.cheques.new.addParty : ar.cheques.new.addSupplier}
          </Text>
        </Pressable>
        {parties.map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            accessibilityLabel={p.name}
            onPress={() => onPickParty({ id: p.id, name: p.name })}
            style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
            testID={`cheque-party-row-${p.id}`}
          >
            <View style={styles.partyTexts}>
              <Text style={styles.partyRowTitle}>{p.name}</Text>
              {p.phone ? <Text style={styles.partyRowSub}>{p.phone}</Text> : null}
            </View>
            {party?.id === p.id ? <Text style={styles.optionCheck}>✓</Text> : null}
          </Pressable>
        ))}
      </BottomSheet>

      {/* منتقي العملة */}
      <OptionPickerSheet
        visible={currencySheet}
        title={ar.cheques.new.pickCurrency}
        options={currencies.map((c) => ({ id: c.id, label: c.name, detail: c.code }))}
        selectedId={currencyId}
        onSelect={(id) => void onSelectCurrency(id)}
        onClose={() => setCurrencySheet(false)}
        testID="cheque-currency-picker"
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
          testID="cheque-rate-save"
        />
      </BottomSheet>

      {/* شيت النجاح: ملخص + أزرار (بلا إغلاق خلفي — إتمام إلزامي) */}
      <BottomSheet visible={saved !== null} title={ar.cheques.new.successTitle}>
        {saved !== null ? (
          <View style={styles.successWrap}>
            <View style={styles.successHead}>
              <Text style={styles.successChequeNo}>{saved.chequeNo}</Text>
              <AmountText
                value={saved.amount}
                tone={isIn ? 'in' : 'out'}
                currency={saved.currencyCode}
                decimals={saved.currencyDecimals}
                size="lg"
              />
            </View>
            <View style={styles.successCard}>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>
                  {isIn ? ar.cheques.new.party : ar.cheques.new.partySupplier}
                </Text>
                <Text style={styles.successValue}>{saved.partyName}</Text>
              </View>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>{ar.cheques.new.dueDate}</Text>
                <Text style={styles.successValue}>{formatDayShortAr(saved.dueDate)}</Text>
              </View>
              {refInvoiceId !== null && selectedInvoice !== null ? (
                <View style={styles.successRow}>
                  <Text style={styles.successLabel}>{ar.cheques.new.linkedInvoice}</Text>
                  <Text style={styles.successValue}>{selectedInvoice.invoiceNo ?? '—'}</Text>
                </View>
              ) : null}
              <Text style={styles.successHint}>{ar.cheques.new.successHint}</Text>
            </View>
            <View style={styles.successActions}>
              <PrimaryButton
                label={ar.cheques.new.successDetails}
                tone="primary"
                onPress={() => {
                  const id = saved.chequeId;
                  setSaved(null);
                  router.replace(`/cheques/${id}`);
                }}
                style={styles.successBtn}
                testID="cheque-success-details"
              />
              <PrimaryButton
                label={ar.cheques.new.successAnother}
                tone="ghost"
                onPress={() => setSaved(null)}
                style={styles.successBtn}
                testID="cheque-success-another"
              />
            </View>
          </View>
        ) : null}
      </BottomSheet>

      {feedback.host}
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  body: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.md,
  },
  directionSeg: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  directionBtn: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  directionBtnIn: {
    backgroundColor: colors.success,
    borderColor: colors.success,
  },
  directionBtnOut: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
  },
  directionText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  directionTextActive: {
    color: colors.onAccent,
    fontFamily: font.bold,
  },
  metaCard: {
    gap: 0,
    paddingVertical: 0,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  metaRowPressed: {
    opacity: 0.75,
  },
  metaTexts: {
    flex: 1,
    gap: 1,
  },
  metaLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  metaValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  metaValueError: {
    color: colors.danger,
  },
  metaChevron: {
    color: colors.textFaint,
    fontSize: 20,
    lineHeight: 24,
  },
  formCard: {
    gap: spacing.lg,
  },
  datesRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  dateField: {
    flex: 1,
  },
  invoicesCard: {
    marginBottom: spacing.xs,
  },
  invoicesHead: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    gap: 2,
  },
  invoicesTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  invoicesHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  invoicesLoadingPad: {
    padding: spacing.lg,
  },
  noInvoicesBox: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    paddingTop: spacing.xs,
    gap: 2,
  },
  noInvoicesTitle: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  noInvoicesHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  invoiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  invoiceRowSelected: {
    backgroundColor: 'rgba(34, 211, 238, 0.10)',
  },
  invoiceRowPressed: {
    opacity: 0.75,
  },
  invoiceTexts: {
    flex: 1,
    gap: 1,
  },
  invoiceNoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  invoiceNo: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  invoiceDate: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  invoiceAmounts: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  linkedBox: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  linkedText: {
    color: colors.accent,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  unlinkedText: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  optionCheck: {
    color: colors.accent,
    fontSize: 16,
    fontFamily: font.bold,
  },
  partyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 12,
    paddingHorizontal: spacing.xs,
    minHeight: 48,
  },
  partyRowPressed: {
    opacity: 0.75,
  },
  partyTexts: {
    flex: 1,
    gap: 1,
  },
  partyRowTitle: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  partyRowSub: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  partyAddText: {
    color: colors.accent,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  rateHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  bottomBar: {
    padding: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  successWrap: {
    gap: spacing.md,
  },
  successHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  successChequeNo: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 18,
    lineHeight: 26,
    flexShrink: 1,
  },
  successCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(34, 211, 238, 0.06)',
    padding: spacing.md,
    gap: spacing.sm,
  },
  successRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  successLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  successValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'left',
    flexShrink: 1,
  },
  successHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    marginTop: spacing.xs,
  },
  successActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  successBtn: {
    flex: 1,
  },
});
