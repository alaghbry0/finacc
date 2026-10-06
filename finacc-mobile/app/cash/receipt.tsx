/**
 * cash/receipt.tsx — سند قبض (تحصيل من عميل) ⭐ (Task 10 — FR-04-03/10):
 *
 *  - شريط ميتا على نمط الكاشير: **العميل** [بحث + عميل جديد] + الصندوق + العملة
 *    (بنفس تدفق فحص سعر اليوم — قرار 3: MissingRateError يفتح شيت إدخال فوري)
 *    + التاريخ (اليوم افتراضياً — عرض).
 *  - المبلغ بMoneyField/NumberPad + بيان اختياري يطبع على السند.
 *  - **معاينة التخصيص FIFO حية** (FR-04-03): عند اختيار العميل تُعرض فواتيره
 *    المفتوحة (remaining>0) الأقدم أولاً مع رقاقة «سيخصص: N» محسوبة لحظياً من
 *    المبلغ المُدخل — حساب عرض نقي؛ **الدومين يعيد الحساب عند الحفظ وهو مصدر
 *    الحقيقة**. الباقي بعد المستحق يظهر «الباقي على الحساب» (دائن للعميل).
 *  - الحفظ عبر domain.recordVoucher (Transaction ذرّية + FIFO + فرق صرف
 *    القرار 8 + رقم RVT-) → شيت نجاح: الرقم + التخصيصات + الباقي + فرق
 *    الصرف + أزرار «طباعة السند» (printVoucher — معاينة ويب/نظام أصلي) / «تم».
 *  - أخطاء الدومين عربية inline (زود → حقول؛ قواعد → رسالة الحقل أو FeedbackBar).
 *
 * payment.tsx يستورد هذه الشاشة نفسها بkind='payment' (مرآة للموردين).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowDownCircle, ArrowUpCircle, CalendarDays, Plus, Printer } from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  getCashboxBalances,
  getOpenInvoicesForParty,
  listActiveCurrencies,
  type CashboxBalance,
  type CurrencyLite,
  type OpenInvoiceRow,
} from '@/db/queries';
import { recordVoucher, type RecordVoucherResult } from '@/domain/cash';
import { resolveRate, upsertDailyRate } from '@/domain/currency';
import { listCustomers, listSuppliers, type PartyRow } from '@/domain/parties';
import { MissingRateError } from '@/domain/errors';
import { printVoucher } from '@/services/print';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import {
  currencySymbol,
  formatAmount,
  formatDateAr,
  formatDayShortAr,
  todayISO,
} from '@/utils/format';
import { d, Decimal } from '@/utils/money';
import { domainErrorMessage, mapErrorToFields, type FieldErrors } from '@/utils/validation';
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

export type VoucherKind = 'receipt' | 'payment';

/* رقاقة ميتا (نمط الكاشير — نسخة محلية مدمجة) */
function MetaChip({
  label,
  value,
  onPress,
  accent,
  error,
  testID,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  accent?: boolean;
  error?: string | null;
  testID?: string;
}) {
  const hasError = error !== null && error !== undefined && error !== '';
  const body = (
    <View style={[styles.metaChip, accent && styles.metaChipAccent, hasError && styles.metaChipError]}>
      <Text style={styles.metaChipLabel}>{label}</Text>
      <Text style={styles.metaChipValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
  if (!onPress) {
    return (
      <View style={styles.metaChipWrapStatic} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      style={({ pressed }) => [styles.metaChipWrap, pressed && styles.metaChipPressed]}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

interface SavedVoucher {
  result: RecordVoucherResult;
  amount: string;
  currencyCode: string;
  currencyDecimals: number;
  partyName: string;
}

/** يمسح رسالة خطأ حقل واحد من الخريطة (بلا قيم undefined — FieldErrors نصية) */
function withoutField(fields: FieldErrors, field: string): FieldErrors {
  const next: FieldErrors = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k !== field) next[k] = v;
  }
  return next;
}

export function VoucherScreen({ kind }: { kind: VoucherKind }) {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const params = useLocalSearchParams<{ partyId?: string }>();
  const userId = session.user?.id;
  const isReceipt = kind === 'receipt';
  const today = todayISO();

  const title = isReceipt ? ar.cash.voucher.receiptTitle : ar.cash.voucher.paymentTitle;
  const subtitle = isReceipt ? ar.cash.voucher.receiptSubtitle : ar.cash.voucher.paymentSubtitle;

  /* ——— المرجعيات ——— */
  const [balances, setBalances] = useState<CashboxBalance[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyLite[]>([]);
  const [booted, setBooted] = useState(false);

  /* ——— النموذج ——— */
  const [party, setParty] = useState<{ id: number; name: string } | null>(null);
  const [cashboxId, setCashboxId] = useState<number | null>(null);
  const [currencyId, setCurrencyId] = useState<number | null>(null);
  const [rate, setRate] = useState('1');
  const [amount, setAmount] = useState('0');
  const [description, setDescription] = useState('');

  /* ——— الشيتات ——— */
  const [partySheet, setPartySheet] = useState(false);
  const [partySearch, setPartySearch] = useState('');
  const [parties, setParties] = useState<PartyRow[]>([]);
  const [cashboxSheet, setCashboxSheet] = useState(false);
  const [currencySheet, setCurrencySheet] = useState(false);
  const [rateSheet, setRateSheet] = useState(false);
  const [rateValue, setRateValue] = useState('0');

  const [openInvoices, setOpenInvoices] = useState<OpenInvoiceRow[] | null>(null);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SavedVoucher | null>(null);
  const [printing, setPrinting] = useState(false);

  const partyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRetry = useRef<(() => void) | null>(null);

  /* ============ التهيئة: مرجعيات + طرف مسبق من ملف الطرف ============ */

  useEffect(() => {
    if (booted || !session.ready || session.locked || !session.defaults) return;
    const defaults = session.defaults;
    setBooted(true);
    void (async () => {
      try {
        const db = await getDb();
        const [boxes, curs] = await Promise.all([
          getCashboxBalances(db),
          listActiveCurrencies(db),
        ]);
        setBalances(boxes);
        setCurrencies(curs);
        const box = boxes.find((b) => b.isDefault) ?? boxes[0] ?? null;
        setCashboxId(box ? box.id : null);
        if (box) {
          setCurrencyId(box.currencyId);
          if (box.currencyId !== defaults.baseCurrencyId) {
            // صندوق أجنبي — يُحل فوراً أو يُطلب السعر عند الحفظ
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
        // دفاعي: القوائم فارغة تعني منتقيات أضيق — لا يوقف الشاشة
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.ready, session.locked, session.defaults]);

  /* طرف مسبق الاختيار (زر «تحصيل»/«دفع» من ملف الطرف) */
  useEffect(() => {
    const pid = params.partyId && /^\d+$/.test(params.partyId) ? Number(params.partyId) : null;
    if (pid === null || !booted) return;
    void (async () => {
      try {
        const db = await getDb();
        const rows = await db.all<{ id: number; name: string }>(
          `SELECT id, name FROM ${isReceipt ? 'customer' : 'supplier'} WHERE id = ?`,
          [pid],
        );
        if (rows[0]) setParty({ id: Number(rows[0].id), name: rows[0].name });
      } catch {
        // طرف غير موجود — المستخدم يختار بنفسه
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.partyId, booted]);

  /* ============ بحث الأطراف داخل الشيت ============ */

  useEffect(() => {
    if (!partySheet) return;
    if (partyTimer.current) clearTimeout(partyTimer.current);
    partyTimer.current = setTimeout(async () => {
      try {
        const db = await getDb();
        const rows = isReceipt
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
  }, [partySheet, partySearch, isReceipt]);

  /* ============ الفواتير المفتوحة للطرف (معاينة FIFO) ============ */

  const reloadOpenInvoices = useCallback(
    async (partyId: number) => {
      setInvoicesLoading(true);
      try {
        const db = await getDb();
        const rows = await getOpenInvoicesForParty(
          db,
          isReceipt ? { customerId: partyId } : { supplierId: partyId },
        );
        setOpenInvoices(rows);
      } catch {
        setOpenInvoices([]);
      } finally {
        setInvoicesLoading(false);
      }
    },
    [isReceipt],
  );

  const onPickParty = (p: { id: number; name: string }) => {
    setParty(p);
    setFieldErrors((f) => withoutField(f, 'party'));
    setPartySheet(false);
    void reloadOpenInvoices(p.id);
  };

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
      feedback.show({ message: domainErrorMessage(err) ?? ar.cash.voucher.failed });
    }
  };

  /* تغيير الصندوق → العملة تتبع صندوقها (FR-04-01) */
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
      setRate('0'); // يُطلب السعر عند الحفظ
    }
  };

  /* ============ معاينة التخصيص FIFO (عرض نقي — الدومين مصدر الحقيقة) ============ */

  const currency = currencies.find((c) => c.id === currencyId) ?? null;
  const decimals = currency?.decimals ?? 0;
  const currencyCode = currency?.code ?? session.defaults?.baseCurrencyCode ?? '';
  const sameCcyInvoices = useMemo(
    () => (openInvoices ?? []).filter((i) => i.currencyId === currencyId),
    [openInvoices, currencyId],
  );
  const otherCcyInvoices = useMemo(
    () => (openInvoices ?? []).filter((i) => i.currencyId !== currencyId),
    [openInvoices, currencyId],
  );

  const fifoPreview = useMemo(() => {
    const rows: { invoice: OpenInvoiceRow; alloc: Decimal }[] = [];
    let left = d(amount);
    for (const inv of sameCcyInvoices) {
      if (left.lte(0)) break;
      const rem = d(inv.remaining);
      if (rem.lte(0)) continue;
      const alloc = Decimal.min(left, rem);
      rows.push({ invoice: inv, alloc });
      left = left.minus(alloc);
    }
    return {
      rows,
      onAccount: left.gt(0) ? left.toFixed(4) : '0.0000',
    };
  }, [sameCcyInvoices, amount]);

  /* ============ الحفظ (recordVoucher — ذرّية + FIFO + fx + RVT-) ============ */

  const doSave = async (afterRate = false) => {
    if (party === null) {
      setFieldErrors({ party: isReceipt ? ar.cash.voucher.noParty : ar.cash.voucher.noPartySupplier });
      setPartySheet(true);
      return;
    }
    if (!d(amount).gt(0)) {
      setFieldErrors({ amount: ar.cash.voucher.needAmount });
      return;
    }
    if (cashboxId === null || currencyId === null) {
      feedback.show({ message: ar.cash.voucher.failed });
      return;
    }
    setSaving(true);
    setFieldErrors({});
    try {
      const db = await getDb();
      // سعر السند: المحلول مسبقاً أو يُحل الآن (الأساس=1 حصراً — قرار 3)
      let voucherRate = rate;
      if (!d(voucherRate).gt(0)) {
        const resolved = await resolveRate(db, currencyId, today);
        voucherRate = resolved.rate;
        setRate(resolved.rate);
      }
      const result = await recordVoucher(
        db,
        {
          txType: kind,
          cashboxId,
          currencyId,
          amount,
          exchangeRate: voucherRate,
          txDate: today,
          customerId: isReceipt ? party.id : undefined,
          supplierId: isReceipt ? undefined : party.id,
          description: description.trim() !== '' ? description.trim() : undefined,
        },
        { createdBy: userId },
      );
      setSaved({
        result,
        amount,
        currencyCode,
        currencyDecimals: decimals,
        partyName: party.name,
      });
      // مسح المدخلات للسند التالي (الطرف/الصندوق يبقيان لتسلسل التحصيل)
      setAmount('0');
      setDescription('');
      feedback.show({
        message: `${isReceipt ? ar.cash.voucher.successReceipt : ar.cash.voucher.successPayment} ${result.voucherNo}`,
        durationMs: 6000,
      });
      void reloadOpenInvoices(party.id);
    } catch (err) {
      if (err instanceof MissingRateError && !afterRate) {
        setRateValue('0');
        saveRetry.current = () => void doSave(true);
        setRateSheet(true);
        return;
      }
      setFieldErrors(mapErrorToFields(err, {
        VOUCHER_PARTY_REQUIRED: 'party',
        VOUCHER_PARTY_MISMATCH: 'party',
        ALLOCATION_PARTY_MISMATCH: 'party',
      }));
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cash.voucher.failed,
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

  /* ============ طباعة السند من شيت النجاح (FR-04-10) ============ */

  const onPrint = async () => {
    if (saved === null) return;
    setPrinting(true);
    try {
      const db = await getDb();
      const res = await printVoucher(db, saved.result.cashTxId, { createdBy: userId });
      feedback.show({ message: res.message, durationMs: res.ok ? 5000 : 8000 });
      if (res.ok) {
        setSaved(null);
        router.back();
      }
    } finally {
      setPrinting(false);
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

  const cashbox = balances.find((b) => b.id === cashboxId) ?? null;
  const partyError = fieldErrors.party ?? null;
  const amountError = fieldErrors.amount ?? null;

  return (
    <SafeScreen scroll={false} padded={false} offline>
      <View style={styles.screen}>
        <ScreenHeader title={title} subtitle={subtitle} onBack={() => router.back()} />

        <View style={styles.body}>
          {/* ——— شريط الميتا ——— */}
          <AppCard style={styles.metaCard}>
            <View style={styles.metaRow}>
              <MetaChip
                label={isReceipt ? ar.cash.voucher.party : ar.cash.voucher.partySupplier}
                value={party ? party.name : '—'}
                onPress={() => setPartySheet(true)}
                accent
                error={partyError}
                testID="voucher-meta-party"
              />
              <MetaChip
                label={ar.cash.voucher.cashbox}
                value={cashbox ? cashbox.name : '—'}
                onPress={balances.length > 1 ? () => setCashboxSheet(true) : undefined}
                testID="voucher-meta-cashbox"
              />
              <MetaChip
                label={ar.cash.voucher.currency}
                value={currencyCode || '—'}
                onPress={() => setCurrencySheet(true)}
                testID="voucher-meta-currency"
              />
              <View style={styles.metaChipWrapStatic}>
                <View style={styles.metaChip}>
                  <Text style={styles.metaChipLabel}>{ar.cash.voucher.date}</Text>
                  <View style={styles.dateRow}>
                    <CalendarDays size={13} color={colors.textFaint} />
                    <Text style={styles.metaChipValue}>{formatDateAr(today)}</Text>
                  </View>
                </View>
              </View>
            </View>
          </AppCard>

          {/* ——— المبلغ + البيان ——— */}
          <AppCard style={styles.amountCard}>
            <MoneyField
              label={ar.cash.voucher.amount}
              value={amount}
              onChange={(v) => {
                setAmount(v);
                setFieldErrors((f) => withoutField(f, 'amount'));
              }}
              currencyCode={currencyCode || undefined}
              decimals={decimals}
              error={amountError}
              testID="voucher-amount"
            />
            <TextField
              label={ar.cash.voucher.description}
              value={description}
              onChangeText={setDescription}
              placeholder={ar.cash.voucher.descriptionPh}
              testID="voucher-desc"
            />
          </AppCard>

          {/* ——— الفواتير المفتوحة + معاينة FIFO ——— */}
          {party !== null ? (
            <AppCard noPadding style={styles.invoicesCard}>
              <View style={styles.invoicesHead}>
                <Text style={styles.invoicesTitle}>{ar.cash.voucher.openInvoices}</Text>
                <Text style={styles.invoicesHint} numberOfLines={1}>
                  {ar.cash.voucher.openInvoicesHint}
                </Text>
              </View>
              {invoicesLoading ? (
                <View style={styles.invoicesLoadingPad}>
                  <LoadingState variant="list" rows={2} />
                </View>
              ) : sameCcyInvoices.length === 0 && otherCcyInvoices.length === 0 ? (
                <View style={styles.noInvoicesBox}>
                  <Text style={styles.noInvoicesTitle}>{ar.cash.voucher.noOpenInvoices}</Text>
                  <Text style={styles.noInvoicesHint}>{ar.cash.voucher.noOpenInvoicesHint}</Text>
                </View>
              ) : (
                <View>
                  {sameCcyInvoices.map((inv, i) => {
                    const preview = fifoPreview.rows.find((r) => r.invoice.id === inv.id);
                    const alloc = preview ? preview.alloc : null;
                    return (
                      <View
                        key={inv.id}
                        style={[
                          styles.invoiceRow,
                          i < sameCcyInvoices.length - 1 ? styles.invoiceRowDivider : null,
                        ]}
                        testID={`voucher-open-invoice-${inv.id}`}
                      >
                        <View style={styles.invoiceTexts}>
                          <View style={styles.invoiceNoRow}>
                            <Text style={styles.invoiceNo}>{inv.invoiceNo ?? '—'}</Text>
                            <Text style={styles.invoiceDate}>{formatDayShortAr(inv.issuedAt)}</Text>
                          </View>
                          <Text style={styles.invoiceAmounts} numberOfLines={1}>
                            {`${ar.cash.voucher.invoiceTotal}: ${formatAmount(inv.total, inv.currencyDecimals)} · ${ar.cash.voucher.invoiceRemaining}: ${formatAmount(inv.remaining, inv.currencyDecimals)} ${currencySymbol(inv.currencyCode)}`}
                          </Text>
                          {alloc !== null && alloc.gt(0) ? (
                            <View style={styles.allocChip}>
                              <Text style={styles.allocChipText}>
                                {`${ar.cash.voucher.allocateChip}: ${formatAmount(alloc.toString(), inv.currencyDecimals)} ${currencySymbol(inv.currencyCode)}`}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                  {otherCcyInvoices.length > 0 ? (
                    <View style={styles.otherCcyNote}>
                      <Text style={styles.otherCcyText}>
                        {ar.cash.voucher.otherCcyCount.replace(
                          '{n}',
                          String(otherCcyInvoices.length),
                        )}
                      </Text>
                    </View>
                  ) : null}
                  {d(fifoPreview.onAccount).gt(0) ? (
                    <View style={styles.onAccountBox}>
                      <Text style={styles.onAccountLabel}>{ar.cash.voucher.onAccountPreview}</Text>
                      <AmountText
                        value={fifoPreview.onAccount}
                        tone="warning"
                        currency={currencyCode || undefined}
                        decimals={decimals}
                        size="sm"
                      />
                      <Text style={styles.onAccountHint}>{ar.cash.voucher.onAccountHint}</Text>
                    </View>
                  ) : null}
                </View>
              )}
            </AppCard>
          ) : null}
        </View>

        {/* ——— زر الحفظ ——— */}
        <View style={styles.bottomBar}>
          <PrimaryButton
            label={ar.cash.voucher.save}
            icon={isReceipt ? ArrowDownCircle : ArrowUpCircle}
            tone={isReceipt ? 'success' : 'primary'}
            loading={saving}
            onPress={() => void doSave()}
            testID="voucher-save"
          />
        </View>
      </View>

      {/* ============ الشيتات ============ */}

      {/* منتقي الطرف (بحث + جديد) */}
      <BottomSheet
        visible={partySheet}
        onClose={() => setPartySheet(false)}
        title={isReceipt ? ar.cash.voucher.pickParty : ar.cash.voucher.pickPartySupplier}
      >
        <SearchBar
          value={partySearch}
          onChangeText={setPartySearch}
          placeholder={ar.cash.voucher.searchParty}
          testID="voucher-party-search"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isReceipt ? ar.cash.voucher.addParty : ar.cash.voucher.addSupplier}
          onPress={() => {
            setPartySheet(false);
            router.push(
              isReceipt ? '/parties/party-edit?kind=customer' : '/parties/party-edit?kind=supplier',
            );
          }}
          style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
          testID="voucher-party-add-new"
        >
          <Plus size={18} color={colors.accent} />
          <Text style={styles.partyAddText}>
            {isReceipt ? ar.cash.voucher.addParty : ar.cash.voucher.addSupplier}
          </Text>
        </Pressable>
        {parties.map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            accessibilityLabel={p.name}
            onPress={() => onPickParty({ id: p.id, name: p.name })}
            style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
            testID={`voucher-party-row-${p.id}`}
          >
            <View style={styles.partyTexts}>
              <Text style={styles.partyRowTitle}>{p.name}</Text>
              {p.phone ? <Text style={styles.partyRowSub}>{p.phone}</Text> : null}
            </View>
            {party?.id === p.id ? <Text style={styles.optionCheck}>✓</Text> : null}
          </Pressable>
        ))}
        {parties.length === 0 ? (
          <Text style={styles.partyEmpty}>{ar.cash.voucher.searchParty}</Text>
        ) : null}
      </BottomSheet>

      {/* منتقي الصندوق */}
      <OptionPickerSheet
        visible={cashboxSheet}
        title={ar.cash.voucher.pickCashbox}
        options={balances.map((b) => ({
          id: b.id,
          label: b.name,
          detail: `${formatAmount(b.balance, b.currencyDecimals)} ${currencySymbol(b.currencyCode)} · ${b.currencyCode}`,
        }))}
        selectedId={cashboxId}
        onSelect={(id) => id !== null && void onSelectCashbox(id)}
        onClose={() => setCashboxSheet(false)}
        testID="voucher-cashbox-picker"
      />

      {/* منتقي العملة */}
      <OptionPickerSheet
        visible={currencySheet}
        title={ar.cash.voucher.pickCurrency}
        options={currencies.map((c) => ({ id: c.id, label: c.name, detail: c.code }))}
        selectedId={currencyId}
        onSelect={(id) => void onSelectCurrency(id)}
        onClose={() => setCurrencySheet(false)}
        testID="voucher-currency-picker"
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
          testID="voucher-rate-save"
        />
      </BottomSheet>

      {/* شيت النجاح: الرقم + التخصيصات + طباعة/تم (بلا إغلاق خلفي — إتمام إلزامي) */}
      <BottomSheet visible={saved !== null} title={ar.cash.voucher.successTitle}>
        {saved !== null ? (
          <View style={styles.successWrap}>
            <View style={styles.successHead}>
              <Text style={styles.successTitle}>
                {isReceipt ? ar.cash.voucher.successReceipt : ar.cash.voucher.successPayment}
              </Text>
              <Text style={styles.successNo}>{saved.result.voucherNo}</Text>
            </View>
            <View style={styles.successCard}>
              <View style={styles.successAmountRow}>
                <Text style={styles.successAmountLabel}>{ar.cash.voucher.amount}</Text>
                <AmountText
                  value={saved.amount}
                  tone={isReceipt ? 'in' : 'out'}
                  currency={saved.currencyCode}
                  decimals={saved.currencyDecimals}
                  size="lg"
                />
              </View>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>
                  {isReceipt ? ar.cash.voucher.party : ar.cash.voucher.partySupplier}
                </Text>
                <Text style={styles.successValue}>{saved.partyName}</Text>
              </View>
              {saved.result.allocations.length > 0 ? (
                <View style={styles.successRow}>
                  <Text style={styles.successLabel}>{ar.cash.voucher.allocatedTo}</Text>
                  <Text style={styles.successValue} numberOfLines={3}>
                    {saved.result.allocations
                      .map(
                        (a) =>
                          `${a.invoiceNo ?? a.invoiceId} (${formatAmount(a.allocatedAmount, saved.currencyDecimals)})`,
                      )
                      .join(' · ')}
                  </Text>
                </View>
              ) : null}
              {d(saved.result.onAccountAmount).gt(0) ? (
                <View style={styles.successRow}>
                  <Text style={styles.successLabel}>{ar.cash.voucher.onAccount}</Text>
                  <Text style={[styles.successValue, styles.successOnAccount]}>
                    {formatAmount(saved.result.onAccountAmount, saved.currencyDecimals)}
                  </Text>
                </View>
              ) : null}
              {d(saved.result.fxGainLoss).abs().gt(0) ? (
                <View style={styles.successRow}>
                  <Text style={styles.successLabel}>{ar.cash.voucher.fxGainLoss}</Text>
                  <Text
                    style={[
                      styles.successValue,
                      d(saved.result.fxGainLoss).gt(0) ? styles.fxGain : styles.fxLoss,
                    ]}
                  >
                    {`${d(saved.result.fxGainLoss).gt(0) ? '+' : '−'}${formatAmount(
                      d(saved.result.fxGainLoss).abs().toString(),
                      2,
                    )}`}
                  </Text>
                </View>
              ) : null}
            </View>
            <PrimaryButton
              label={ar.cash.voucher.print}
              icon={Printer}
              loading={printing}
              onPress={() => void onPrint()}
              testID="voucher-success-print"
            />
            <PrimaryButton
              label={ar.cash.voucher.done}
              tone="ghost"
              onPress={() => {
                setSaved(null);
                router.back();
              }}
              testID="voucher-success-done"
            />
          </View>
        ) : null}
      </BottomSheet>

      {feedback.host}
    </SafeScreen>
  );
}

/* الشاشة الافتراضية: سند القبض (payment.tsx يستورد VoucherScreen نفسها) */
export default function ReceiptScreen() {
  return <VoucherScreen kind="receipt" />;
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
  metaChipWrap: {
    flexBasis: '48%',
    flexGrow: 1,
    borderRadius: radius.md,
  },
  metaChipWrapStatic: {
    flexBasis: '48%',
    flexGrow: 1,
  },
  metaChipPressed: {
    opacity: 0.75,
  },
  metaChip: {
    gap: 3,
    minHeight: touch.min + 6,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  metaChipAccent: {
    borderColor: 'rgba(34, 211, 238, 0.45)',
    backgroundColor: 'rgba(34, 211, 238, 0.07)',
  },
  metaChipError: {
    borderColor: colors.danger,
  },
  metaChipLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  metaChipValue: {
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
  invoicesCard: {
    gap: 0,
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
    paddingBottom: spacing.md,
  },
  noInvoicesBox: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    paddingTop: spacing.xs,
    gap: 3,
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: touch.min + 4,
  },
  invoiceRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  invoiceTexts: {
    flex: 1,
    gap: 3,
    alignItems: 'flex-start',
  },
  invoiceNoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  invoiceNo: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 21,
  },
  invoiceDate: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  invoiceAmounts: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  allocChip: {
    backgroundColor: 'rgba(52, 211, 153, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(52, 211, 153, 0.3)',
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: 2,
  },
  allocChipText: {
    color: colors.success,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  otherCcyNote: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  otherCcyText: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  onAccountBox: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.35)',
    backgroundColor: 'rgba(251, 191, 36, 0.07)',
    padding: spacing.md,
    gap: 4,
  },
  onAccountLabel: {
    color: colors.warning,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  onAccountHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  bottomBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  partyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touch.min + 8,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    paddingHorizontal: spacing.xs,
  },
  partyRowPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.08)',
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
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  partyEmpty: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  optionCheck: {
    color: colors.accent,
    fontFamily: font.bold,
    fontSize: 16,
  },
  rateHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  successWrap: {
    gap: spacing.md,
  },
  successHead: {
    alignItems: 'center',
    gap: 4,
  },
  successTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 17,
    lineHeight: 24,
  },
  successNo: {
    color: colors.accent,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: 0.4,
  },
  successCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: spacing.md,
    gap: 6,
  },
  successAmountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  successAmountLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  successRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 2,
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
  successOnAccount: {
    color: colors.warning,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
  },
  fxGain: {
    color: colors.success,
  },
  fxLoss: {
    color: colors.danger,
  },
});
