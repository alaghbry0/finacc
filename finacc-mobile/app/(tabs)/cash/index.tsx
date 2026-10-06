/**
 * (tabs)/cash/index.tsx — شاشة النقدية الرئيسية ⭐ (Task 10 — FR-04):
 *
 *  - بطاقات أرصدة حية لكل صندوق بعملته (FR-04-06): السالب مسموح بتحذير
 *    بصري «رصيد سالب — راجع حركاتك» (قرار 9 / FR-04-09) — تحذير لا منع.
 *  - سجل الحركات (FR-04-08): الأحدث أولاً، مجمّع برؤوس أيام (اليوم/أمس/تاريخ)،
 *    أيقونة ملوّنة بتظليل ناعم حسب النوع (قبض أخضر/صرف أحمر/مصروف كهرماني/
 *    تحويل سماوي/مالك بنفسجي)، المبلغ بإشارة الاتجاه (+ أخضر وارد / − أحمر
 *    صادر)، رقم السند RVT-/PMT- رقاقة mono، فرق الصرف سطراً مستقلاً عند ≠0،
 *    «معاكسة» للحركات المعكوسة وخط شطب للملغاة.
 *  - فلاتر شرائح: الكل/قبض/صرف/مصروف/تحويل/مسحوبات (نمط قائمة الفواتير).
 *  - أزرار الإدخول: سند قبض (أخضر) / سند صرف / مصروف / «المزيد…» (شيت:
 *    مسحوبات مالك/إيداع مالك/تحويل بين الصندوقين — شيتات داخلية).
 *  - نقرة الحركة → شيت تفاصيل كامل + «إلغاء الحركة» بحركة معاكسة (كلمة
 *    «إلغاء» — حركات الفواتير تُلغى من مستندها فقط) + «طباعة السند»
 *    للقبض/الصرف (رقم كسول عند أول طباعة — FR-04-10).
 *  - الحفظ كله عبر domain/cash.ts (recordOwnerTx/recordBoxTransfer/voidCashTx)
 *    — هذه الشاشة عرض وتنقل فقط. التحديث عند العودة للتبويب + زر تحديث.
 *  - الحالات: Skeleton / EmptyState / NoResults (فلترة) / ErrorState.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ArrowDownCircle,
  ArrowLeftRight,
  ArrowUpCircle,
  Banknote,
  Landmark,
  MoreHorizontal,
  RefreshCw,
  Receipt,
  TriangleAlert,
  UserMinus,
  UserPlus,
  Wallet,
  type LucideIcon,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  getCashboxBalances,
  getCashTxAllocations,
  listCashMovements,
  listActiveCurrencies,
  type CashboxBalance,
  type CashMovementsFilter,
  type CashMovementRow,
  type CashTxAllocationRow,
  type CurrencyLite,
} from '@/db/queries';
import { recordBoxTransfer, recordOwnerTx, voidCashTx } from '@/domain/cash';
import { resolveRate, upsertDailyRate } from '@/domain/currency';
import { MissingRateError } from '@/domain/errors';
import { useSession } from '@/store/session';
import { ar, pluralAr } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import {
  currencySymbol,
  formatAmount,
  formatDateAr,
  formatQty,
  formatTimeAr,
  addDaysISO,
  todayISO,
} from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import { printVoucher } from '@/services/print';
import AmountText from '@/components/ui/AmountText';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import ConfirmSheet from '@/components/ui/ConfirmSheet';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import MoneyField from '@/components/ui/MoneyField';
import NoResultsState from '@/components/ui/NoResultsState';
import NumberPad from '@/components/ui/NumberPad';
import OptionPickerSheet from '@/components/ui/OptionPickerSheet';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

/* ============ خرائط النوع: أيقونة + تظليل + تسمية ============ */

/** بنفسجي مالك — توجيه المهمة 10 (تظليل ناعم محلي للشاشة، خارج توكنز DS) */
const OWNER_TINT = '#A78BFA';

interface TypeStyle {
  icon: LucideIcon;
  color: string;
  tint: string;
}

const TYPE_STYLE: Record<string, TypeStyle> = {
  receipt: { icon: ArrowDownCircle, color: colors.success, tint: 'rgba(52, 211, 153, 0.14)' },
  payment: { icon: ArrowUpCircle, color: colors.danger, tint: 'rgba(248, 113, 113, 0.13)' },
  expense: { icon: Receipt, color: colors.warning, tint: 'rgba(251, 191, 36, 0.13)' },
  owner_draw: { icon: UserMinus, color: OWNER_TINT, tint: 'rgba(167, 139, 250, 0.15)' },
  capital_in: { icon: UserPlus, color: OWNER_TINT, tint: 'rgba(167, 139, 250, 0.15)' },
  box_transfer: { icon: ArrowLeftRight, color: colors.accent, tint: 'rgba(34, 211, 238, 0.13)' },
  bank_deposit: { icon: Landmark, color: colors.teal, tint: 'rgba(45, 212, 191, 0.13)' },
  bank_withdraw: { icon: Landmark, color: colors.danger, tint: 'rgba(248, 113, 113, 0.13)' },
  opening: { icon: Wallet, color: colors.textMuted, tint: 'rgba(148, 163, 184, 0.13)' },
};

const FALLBACK_TYPE: TypeStyle = {
  icon: Banknote,
  color: colors.textMuted,
  tint: 'rgba(148, 163, 184, 0.13)',
};

function typeStyle(txType: string): TypeStyle {
  return TYPE_STYLE[txType] ?? FALLBACK_TYPE;
}

function typeLabel(txType: string): string {
  const labels: Record<string, string> = {
    receipt: ar.cash.types.receipt,
    payment: ar.cash.types.payment,
    expense: ar.cash.types.expense,
    owner_draw: ar.cash.types.owner_draw,
    capital_in: ar.cash.types.capital_in,
    box_transfer: ar.cash.types.box_transfer,
    bank_deposit: ar.cash.types.bank_deposit,
    bank_withdraw: ar.cash.types.bank_withdraw,
    opening: ar.cash.types.opening,
  };
  return labels[txType] ?? txType;
}

const FILTERS: { key: CashMovementsFilter; label: string }[] = [
  { key: 'all', label: ar.cash.filters.all },
  { key: 'receipt', label: ar.cash.filters.receipt },
  { key: 'payment', label: ar.cash.filters.payment },
  { key: 'expense', label: ar.cash.filters.expense },
  { key: 'box_transfer', label: ar.cash.filters.transfer },
  { key: 'owner', label: ar.cash.filters.owner },
];

/* ============ عناصر القائمة المجمّعة بالأيام ============ */

type ListItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'tx'; key: string; tx: CashMovementRow };

/** تسمية رأس اليوم: اليوم / أمس / تاريخ عربي كامل */
function dayLabel(day: string, today: string, yesterday: string): string {
  if (day === today) return ar.cash.movements.today;
  if (day === yesterday) return ar.cash.movements.yesterday;
  return formatDateAr(day);
}

/** سياق الحركة: الطرف أو الفئة + الصندوق (+ الوقت) */
function movementSubtitle(tx: CashMovementRow): string {
  const parts: string[] = [];
  if (tx.txType === 'box_transfer') {
    // شطران: الصادر (to محدد) والوارد (cashbox هو الوجهة)
    parts.push(
      tx.toCashboxName !== null
        ? `${ar.cash.movements.fromBox} ${tx.cashboxName} ${ar.cash.movements.toBox} ${tx.toCashboxName}`
        : `${ar.cash.movements.toBox} ${tx.cashboxName}`,
    );
  } else {
    const ctx = tx.customerName ?? tx.supplierName ?? tx.expenseCategoryName;
    if (ctx) parts.push(ctx);
    parts.push(tx.cashboxName);
  }
  if (tx.createdAt) {
    const time = formatTimeAr(tx.createdAt);
    if (time !== '') parts.push(time);
  }
  return parts.join(' · ');
}

/* ============ الحالة العامة ============ */

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'data'; balances: CashboxBalance[]; movements: CashMovementRow[] };

type OwnerKind = 'owner_draw' | 'capital_in';

export default function CashScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const userId = session.user?.id;

  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [filter, setFilter] = useState<CashMovementsFilter>('all');

  /* ——— الشيتات ——— */
  const [moreSheet, setMoreSheet] = useState(false);
  const [ownerKind, setOwnerKind] = useState<OwnerKind | null>(null);
  const [ownerCashboxId, setOwnerCashboxId] = useState<number | null>(null);
  const [ownerAmount, setOwnerAmount] = useState('0');
  const [ownerDesc, setOwnerDesc] = useState('');
  const [ownerSaving, setOwnerSaving] = useState(false);
  const [ownerCashboxSheet, setOwnerCashboxSheet] = useState(false);

  const [transferSheet, setTransferSheet] = useState(false);
  const [fromId, setFromId] = useState<number | null>(null);
  const [toId, setToId] = useState<number | null>(null);
  const [transferAmount, setTransferAmount] = useState('0');
  const [toAmount, setToAmount] = useState('0');
  const [fromSheet, setFromSheet] = useState(false);
  const [toSheet, setToSheet] = useState(false);
  const [transferSaving, setTransferSaving] = useState(false);
  const [rateSheet, setRateSheet] = useState<{ code: string; name: string; retry: () => void } | null>(null);
  const [rateValue, setRateValue] = useState('0');

  const [detailTx, setDetailTx] = useState<CashMovementRow | null>(null);
  const [detailAllocs, setDetailAllocs] = useState<CashTxAllocationRow[]>([]);
  const [voidSheet, setVoidSheet] = useState(false);
  const [busy, setBusy] = useState(false);

  const today = todayISO();
  const yesterday = addDaysISO(today, -1);

  const balances = state.kind === 'data' ? state.balances : [];
  const movements = state.kind === 'data' ? state.movements : [];

  /* ============ التحميل + التحديث عند العودة (refresh on focus) ============ */

  const load = useCallback(
    async (showSkeleton: boolean) => {
      if (showSkeleton) setState({ kind: 'loading' });
      try {
        const db = await getDb();
        const [boxBalances, rows] = await Promise.all([
          getCashboxBalances(db),
          listCashMovements(db, { filter }),
        ]);
        setState({ kind: 'data', balances: boxBalances, movements: rows });
      } catch (err) {
        setState({ kind: 'error', technical: technicalText(err) });
      }
    },
    [filter],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void load(false); // تحديث بلا skeleton — العودة من شاشة سند/مصروف
    }, [load]),
  );

  /* ============ بنود القائمة المجمّعة ============ */
  const items: ListItem[] = [];
  let lastDay = '';
  for (const tx of movements) {
    if (tx.txDate !== lastDay) {
      lastDay = tx.txDate;
      items.push({ kind: 'day', key: `day-${tx.txDate}`, label: dayLabel(tx.txDate, today, yesterday) });
    }
    items.push({ kind: 'tx', key: `tx-${tx.id}`, tx });
  }
  const countLabel = pluralAr(movements.length, ar.cash.movements.countForms);
  const defaultBox = balances.find((b) => b.isDefault) ?? balances[0] ?? null;

  /* ============ شيت التفاصيل ============ */

  const openDetail = async (tx: CashMovementRow) => {
    setDetailTx(tx);
    setDetailAllocs([]);
    if ((tx.txType === 'receipt' || tx.txType === 'payment') &&
        tx.refType === 'on_account' &&
        !tx.isVoided &&
        tx.reversalOf === null) {
      try {
        const db = await getDb();
        setDetailAllocs(await getCashTxAllocations(db, tx.id));
      } catch {
        // عرض فقط — نتجاهل
      }
    }
  };

  const closeDetail = () => {
    setDetailTx(null);
    setDetailAllocs([]);
  };

  /* ============ طباعة السند (FR-04-10 — رقم كسول عند أول طباعة) ============ */

  const onPrintVoucher = async (tx: CashMovementRow) => {
    setBusy(true);
    try {
      const db = await getDb();
      const res = await printVoucher(db, tx.id, { createdBy: userId });
      feedback.show({ message: res.message, durationMs: res.ok ? 4500 : 7000 });
      if (res.ok) {
        closeDetail();
        void load(false); // الرقم المخزّن الآن يظهر رقاقة RVT-/PMT-
      }
    } finally {
      setBusy(false);
    }
  };

  /* ============ الإلغاء بحركة معاكسة (FR-04-08) ============ */

  const onVoid = async () => {
    if (!detailTx) return;
    setBusy(true);
    try {
      const db = await getDb();
      await voidCashTx(db, detailTx.id, { createdBy: userId });
      setVoidSheet(false);
      closeDetail();
      feedback.show({ message: ar.cash.detail.voided, durationMs: 6000 });
      void load(false);
    } catch (err) {
      setVoidSheet(false);
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cash.detail.voidFailed,
        durationMs: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  /* ============ مسحوبات/إيداع المالك (FR-04-02) ============ */

  const openOwner = (kind: OwnerKind) => {
    setMoreSheet(false);
    setOwnerKind(kind);
    setOwnerAmount('0');
    setOwnerDesc('');
    setOwnerCashboxId(defaultBox ? defaultBox.id : null);
  };

  const saveOwner = async (retry = false) => {
    if (ownerKind === null || ownerCashboxId === null) {
      feedback.show({ message: ar.cash.owner.needCashbox });
      return;
    }
    if (!d(ownerAmount).gt(0)) {
      feedback.show({ message: ar.cash.owner.needAmount });
      return;
    }
    const box = balances.find((b) => b.id === ownerCashboxId);
    if (!box) {
      feedback.show({ message: ar.cash.owner.needCashbox });
      return;
    }
    setOwnerSaving(true);
    try {
      const db = await getDb();
      // العملة = عملة الصندوق؛ سعرها بresolveRate (الأساس=1) مع شيت سعر اليوم عند فقده
      const resolved = await resolveRate(db, box.currencyId, today);
      await recordOwnerTx(db, {
        txKind: ownerKind,
        cashboxId: ownerCashboxId,
        currencyId: box.currencyId,
        amount: ownerAmount,
        exchangeRate: resolved.rate,
        txDate: today,
        description: ownerDesc.trim() !== '' ? ownerDesc.trim() : undefined,
      });
      setOwnerKind(null);
      feedback.show({
        message: ownerKind === 'owner_draw' ? ar.cash.owner.saved : ar.cash.owner.savedIn,
        durationMs: 6000,
      });
      void load(false);
    } catch (err) {
      if (err instanceof MissingRateError && !retry) {
        setRateValue('0');
        setRateSheet({
          code: err.currencyCode,
          name: err.currencyName,
          retry: () => void saveOwner(true),
        });
        return;
      }
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cash.owner.failed,
        durationMs: 8000,
      });
    } finally {
      setOwnerSaving(false);
    }
  };

  /* ============ التحويل بين صندوقين (FR-04-07) ============ */

  const openTransfer = () => {
    setMoreSheet(false);
    setTransferSheet(true);
    setTransferAmount('0');
    setToAmount('0');
    setFromId(defaultBox ? defaultBox.id : null);
    setToId(balances.find((b) => b.id !== (defaultBox?.id ?? -1))?.id ?? null);
  };

  const fromBox = balances.find((b) => b.id === fromId) ?? null;
  const toBox = balances.find((b) => b.id === toId) ?? null;
  const crossCurrency =
    fromBox !== null && toBox !== null && fromBox.currencyId !== toBox.currencyId;

  /** معاينة التحويل (عرض فقط — الدومين يحسب الحقيقة عند الحفظ) */
  const [transferPreview, setTransferPreview] = useState<{
    toAmount: string;
    fx: string;
    missingRate: boolean;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (fromBox === null || toBox === null || !crossCurrency) {
        if (alive) setTransferPreview(null);
        return;
      }
      try {
        const db = await getDb();
        const fromRate = d((await resolveRate(db, fromBox.currencyId, today)).rate);
        const toRate = d((await resolveRate(db, toBox.currencyId, today)).rate);
        if (!d(transferAmount).gt(0)) {
          if (alive) setTransferPreview({ toAmount: '0', fx: '0', missingRate: false });
          return;
        }
        if (d(toAmount).gt(0)) {
          const fx = d(toAmount).times(toRate).minus(d(transferAmount).times(fromRate));
          if (alive) setTransferPreview({ toAmount, fx: fx.toFixed(4), missingRate: false });
        } else {
          const derived = d(transferAmount).times(fromRate).div(toRate);
          if (alive) setTransferPreview({ toAmount: derived.toFixed(4), fx: '0', missingRate: false });
        }
      } catch {
        // سعر اليوم مفقود — يُطلب عند الحفظ (شيت سعر اليوم)
        if (alive) setTransferPreview({ toAmount: '0', fx: '0', missingRate: true });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromBox?.id, toBox?.id, transferAmount, toAmount, crossCurrency]);

  const saveTransfer = async (retry = false) => {
    if (fromId === null || toId === null || fromId === toId) {
      feedback.show({ message: ar.cash.transfer.needBoxes });
      return;
    }
    if (!d(transferAmount).gt(0)) {
      feedback.show({ message: ar.cash.transfer.needAmount });
      return;
    }
    setTransferSaving(true);
    try {
      const db = await getDb();
      const res = await recordBoxTransfer(db, {
        fromCashboxId: fromId,
        toCashboxId: toId,
        amount: transferAmount,
        toAmount: crossCurrency && d(toAmount).gt(0) ? toAmount : undefined,
        txDate: today,
      });
      setTransferSheet(false);
      feedback.show({
        message: `${ar.cash.transfer.saved} — ${formatQty(res.toAmount)}`,
        durationMs: 6000,
      });
      void load(false);
    } catch (err) {
      if (err instanceof MissingRateError && !retry) {
        setRateValue('0');
        setRateSheet({
          code: err.currencyCode,
          name: err.currencyName,
          retry: () => void saveTransfer(true),
        });
        return;
      }
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cash.transfer.failed,
        durationMs: 8000,
      });
    } finally {
      setTransferSaving(false);
    }
  };

  /* ============ شيت سعر اليوم (نمط البيع/الشراء — قرار 3) ============ */

  const saveRate = async () => {
    if (!rateSheet) return;
    if (!d(rateValue).gt(0)) {
      feedback.show({ message: ar.cash.voucher.rateInvalid });
      return;
    }
    try {
      const db = await getDb();
      // العملة من الرمز: نبحثها من قائمة العملات النشطة
      const currencies: CurrencyLite[] = await listActiveCurrencies(db);
      const cur = currencies.find((c) => c.code === rateSheet.code);
      if (!cur) {
        setRateSheet(null);
        return;
      }
      await upsertDailyRate(db, cur.id, today, rateValue);
      const retry = rateSheet.retry;
      setRateSheet(null);
      feedback.show({ message: ar.cash.voucher.rateSaved });
      retry();
    } catch (err) {
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cash.voucher.rateInvalid,
        durationMs: 8000,
      });
    }
  };

  /* ============ حرس الجلسة ============ */

  if (!session.ready || session.locked) {
    return (
      <SafeScreen scroll={false} offline={false}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{ar.cash.title}</Text>
        </View>
        <AppCard noPadding>
          <LoadingState variant="list" rows={4} />
        </AppCard>
      </SafeScreen>
    );
  }

  const detailCanPrint =
    detailTx !== null &&
    (detailTx.txType === 'receipt' || detailTx.txType === 'payment') &&
    !detailTx.isVoided &&
    detailTx.reversalOf === null;
  const detailFromInvoice =
    detailTx !== null && (detailTx.refType === 'invoice' || detailTx.refType === 'invoice_void');
  const detailCanVoid =
    detailTx !== null && !detailTx.isVoided && detailTx.reversalOf === null && !detailFromInvoice;

  return (
    <SafeScreen scroll={false} padded={false} offline>
      <View style={styles.screen}>
        {/* ——— الرأس ——— */}
        <View style={styles.header}>
          <View style={styles.headerTitles}>
            <Text style={styles.headerTitle}>{ar.cash.title}</Text>
            <Text style={styles.headerSubtitle}>{ar.cash.subtitle}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.common.retry}
            onPress={() => void load(false)}
            style={({ pressed }) => [styles.refreshBtn, pressed && styles.refreshBtnPressed]}
            testID="cash-refresh"
          >
            <RefreshCw size={20} color={colors.accent} />
          </Pressable>
        </View>

        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View>
              {/* ——— بطاقات الأرصدة (FR-04-06) ——— */}
              {state.kind === 'data' ? (
                <BalanceCard balances={balances} />
              ) : null}

              {/* ——— رأس السجل + الفلاتر ——— */}
              <View style={styles.movementsHead}>
                <Text style={styles.movementsTitle}>{ar.cash.movements.title}</Text>
                {state.kind === 'data' ? (
                  <Text style={styles.countLabel}>{countLabel}</Text>
                ) : null}
              </View>
              <View style={styles.chipsRow}>
                {FILTERS.map((f) => {
                  const active = f.key === filter;
                  return (
                    <Pressable
                      key={f.key}
                      accessibilityRole="button"
                      accessibilityLabel={f.label}
                      accessibilityState={{ selected: active }}
                      onPress={() => setFilter(f.key)}
                      style={[styles.filterChip, active && styles.filterChipActive]}
                      testID={`cash-filter-${f.key}`}
                    >
                      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                        {f.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {state.kind === 'loading' ? (
                <AppCard noPadding>
                  <LoadingState variant="list" rows={6} />
                </AppCard>
              ) : null}
              {state.kind === 'error' ? (
                <AppCard noPadding>
                  <ErrorState
                    message={ar.cash.movements.errorLoad}
                    technical={state.technical}
                    onRetry={() => void load(true)}
                  />
                </AppCard>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            state.kind === 'data' ? (
              filter !== 'all' ? (
                <NoResultsState
                  message={ar.cash.movements.noFilterResults}
                  onClearFilters={() => setFilter('all')}
                />
              ) : (
                <AppCard noPadding>
                  <EmptyState
                    icon={Wallet}
                    title={ar.cash.movements.empty}
                    message={ar.cash.movements.emptyHint}
                    actionLabel={ar.cash.actions.receipt}
                    onAction={() => router.push('/cash/receipt')}
                  />
                </AppCard>
              )
            ) : null
          }
          renderItem={({ item }) =>
            item.kind === 'day' ? (
              <View style={styles.dayHeader} testID="cash-day-header">
                <Text style={styles.dayHeaderText}>{item.label}</Text>
              </View>
            ) : (
              <MovementRow
                tx={item.tx}
                baseCurrencyCode={session.defaults?.baseCurrencyCode ?? null}
                onPress={() => void openDetail(item.tx)}
              />
            )
          }
        />

        {/* ——— أزرار الإدخول (سندات/مصروف/المزيد) ——— */}
        <View style={styles.bottomBar}>
          <ActionButton
            label={ar.cash.actions.receipt}
            tone="success"
            icon={ArrowDownCircle}
            flex={1.4}
            onPress={() => router.push('/cash/receipt')}
            testID="cash-new-receipt"
          />
          <ActionButton
            label={ar.cash.actions.payment}
            tone="danger"
            icon={ArrowUpCircle}
            flex={1.2}
            onPress={() => router.push('/cash/payment')}
            testID="cash-new-payment"
          />
          <ActionButton
            label={ar.cash.actions.expense}
            tone="warning"
            icon={Receipt}
            flex={1}
            onPress={() => router.push('/cash/expense')}
            testID="cash-new-expense"
          />
          <ActionButton
            label={ar.cash.actions.more}
            tone="ghost"
            icon={MoreHorizontal}
            flex={0.8}
            onPress={() => setMoreSheet(true)}
            testID="cash-more"
          />
        </View>
      </View>

      {/* ============ الشيتات ============ */}

      {/* شيت «المزيد…» — حركات المالك + التحويل */}
      <BottomSheet visible={moreSheet} onClose={() => setMoreSheet(false)} title={ar.cash.more.title}>
        <OptionRow
          icon={UserMinus}
          color={OWNER_TINT}
          label={ar.cash.more.ownerDraw}
          hint={ar.cash.more.ownerDrawHint}
          onPress={() => openOwner('owner_draw')}
          testID="cash-more-owner-draw"
        />
        <OptionRow
          icon={UserPlus}
          color={OWNER_TINT}
          label={ar.cash.more.capitalIn}
          hint={ar.cash.more.capitalInHint}
          onPress={() => openOwner('capital_in')}
          testID="cash-more-capital-in"
        />
        <OptionRow
          icon={ArrowLeftRight}
          color={colors.accent}
          label={ar.cash.more.transfer}
          hint={ar.cash.more.transferHint}
          onPress={openTransfer}
          testID="cash-more-transfer"
        />
      </BottomSheet>

      {/* شيت مسحوبات/إيداع المالك */}
      <BottomSheet
        visible={ownerKind !== null}
        onClose={() => setOwnerKind(null)}
        title={ownerKind === 'owner_draw' ? ar.cash.owner.drawTitle : ar.cash.owner.inTitle}
      >
        <View style={styles.fieldRow}>
          <View style={styles.fieldGrow}>
            <PickerButton
              label={ar.cash.owner.cashbox}
              value={
                balances.find((b) => b.id === ownerCashboxId)?.name ??
                (balances.length === 0 ? ar.cash.balanceCard.noBoxes : '—')
              }
              detail={
                balances.find((b) => b.id === ownerCashboxId)
                  ? `${currencySymbol(balances.find((b) => b.id === ownerCashboxId)!.currencyCode)}`
                  : undefined
              }
              onPress={balances.length > 1 ? () => setOwnerCashboxSheet(true) : undefined}
              testID="cash-owner-cashbox"
            />
          </View>
        </View>
        <MoneyField
          label={ar.cash.owner.amount}
          value={ownerAmount}
          onChange={setOwnerAmount}
          currencyCode={
            balances.find((b) => b.id === ownerCashboxId)?.currencyCode ?? undefined
          }
          decimals={balances.find((b) => b.id === ownerCashboxId)?.currencyDecimals ?? 2}
          testID="cash-owner-amount"
        />
        <TextField
          label={ar.cash.owner.description}
          value={ownerDesc}
          onChangeText={setOwnerDesc}
          placeholder={ar.cash.owner.descriptionPh}
          testID="cash-owner-desc"
        />
        <PrimaryButton
          label={ownerKind === 'owner_draw' ? ar.cash.owner.save : ar.cash.owner.saveIn}
          loading={ownerSaving}
          tone={ownerKind === 'owner_draw' ? 'danger' : 'success'}
          onPress={() => void saveOwner()}
          testID="cash-owner-save"
        />
      </BottomSheet>

      {/* منتقي صندوق حركة المالك */}
      <OptionPickerSheet
        visible={ownerCashboxSheet}
        title={ar.cash.owner.pickCashbox}
        options={balances.map((b) => ({
          id: b.id,
          label: b.name,
          detail: `${formatAmount(b.balance, b.currencyDecimals)} ${currencySymbol(b.currencyCode)}`,
        }))}
        selectedId={ownerCashboxId}
        onSelect={(id) => id !== null && setOwnerCashboxId(id)}
        onClose={() => setOwnerCashboxSheet(false)}
        testID="cash-owner-cashbox-picker"
      />

      {/* شيت التحويل بين صندوقين */}
      <BottomSheet
        visible={transferSheet}
        onClose={() => setTransferSheet(false)}
        title={ar.cash.transfer.title}
      >
        <View style={styles.fieldRow}>
          <View style={styles.fieldGrow}>
            <PickerButton
              label={ar.cash.transfer.from}
              value={fromBox?.name ?? (balances.length === 0 ? ar.cash.balanceCard.noBoxes : '—')}
              detail={fromBox ? `${formatAmount(fromBox.balance, fromBox.currencyDecimals)} ${currencySymbol(fromBox.currencyCode)}` : undefined}
              onPress={() => setFromSheet(true)}
              testID="cash-transfer-from"
            />
          </View>
          <View style={styles.fieldGrow}>
            <PickerButton
              label={ar.cash.transfer.to}
              value={toBox?.name ?? '—'}
              detail={toBox ? `${formatAmount(toBox.balance, toBox.currencyDecimals)} ${currencySymbol(toBox.currencyCode)}` : undefined}
              onPress={() => setToSheet(true)}
              testID="cash-transfer-to"
            />
          </View>
        </View>
        <MoneyField
          label={ar.cash.transfer.amount}
          value={transferAmount}
          onChange={setTransferAmount}
          currencyCode={fromBox?.currencyCode ?? undefined}
          decimals={fromBox?.currencyDecimals ?? 2}
          testID="cash-transfer-amount"
        />
        {crossCurrency ? (
          <>
            <MoneyField
              label={ar.cash.transfer.toAmount}
              value={toAmount}
              onChange={setToAmount}
              currencyCode={toBox?.currencyCode ?? undefined}
              decimals={toBox?.currencyDecimals ?? 2}
              hint={ar.cash.transfer.toAmountHint}
              testID="cash-transfer-to-amount"
            />
            {transferPreview ? (
              <View style={styles.fxPreviewBox}>
                <Text style={styles.fxPreviewLabel}>{ar.cash.transfer.fxPreview}</Text>
                {transferPreview.missingRate ? (
                  <Text style={styles.fxPreviewMuted}>{ar.cash.transfer.missingRateHint}</Text>
                ) : d(transferPreview.fx).gt(0) ? (
                  <Text style={[styles.fxPreviewValue, styles.fxGain]}>
                    {`${ar.cash.transfer.fxGain} +${formatAmount(transferPreview.fx, 2)}${
                      session.defaults?.baseCurrencyCode
                        ? ` ${currencySymbol(session.defaults.baseCurrencyCode)}`
                        : ''
                    }`}
                  </Text>
                ) : d(transferPreview.fx).lt(0) ? (
                  <Text style={[styles.fxPreviewValue, styles.fxLoss]}>
                    {`${ar.cash.transfer.fxLoss} ${formatAmount(transferPreview.fx, 2)}${
                      session.defaults?.baseCurrencyCode
                        ? ` ${currencySymbol(session.defaults.baseCurrencyCode)}`
                        : ''
                    }`}
                  </Text>
                ) : (
                  <Text style={styles.fxPreviewValue}>
                    {`${ar.cash.transfer.bookTransfer} — ${formatAmount(
                      transferPreview.toAmount,
                      toBox?.currencyDecimals ?? 2,
                    )} ${toBox ? currencySymbol(toBox.currencyCode) : ''}`}
                  </Text>
                )}
              </View>
            ) : null}
          </>
        ) : fromBox !== null && toBox !== null ? (
          <Text style={styles.sameCurrencyNote}>{ar.cash.transfer.sameCurrencyNote}</Text>
        ) : null}
        <PrimaryButton
          label={ar.cash.transfer.save}
          loading={transferSaving}
          onPress={() => void saveTransfer()}
          testID="cash-transfer-save"
        />
      </BottomSheet>

      {/* منتقيا التحويل */}
      <OptionPickerSheet
        visible={fromSheet}
        title={ar.cash.transfer.pickFrom}
        options={balances.map((b) => ({
          id: b.id,
          label: b.name,
          detail: `${formatAmount(b.balance, b.currencyDecimals)} ${currencySymbol(b.currencyCode)}`,
        }))}
        selectedId={fromId}
        onSelect={(id) => id !== null && setFromId(id)}
        onClose={() => setFromSheet(false)}
        testID="cash-transfer-from-picker"
      />
      <OptionPickerSheet
        visible={toSheet}
        title={ar.cash.transfer.pickTo}
        options={balances.map((b) => ({
          id: b.id,
          label: b.name,
          detail: `${formatAmount(b.balance, b.currencyDecimals)} ${currencySymbol(b.currencyCode)}`,
        }))}
        selectedId={toId}
        onSelect={(id) => id !== null && setToId(id)}
        onClose={() => setToSheet(false)}
        testID="cash-transfer-to-picker"
      />

      {/* شيت سعر اليوم (قرار 3 — المفاتيح هنا تخص شيتات المالك/التحويل) */}
      <BottomSheet
        visible={rateSheet !== null}
        title={`${ar.cash.voucher.rateTitle} — ${rateSheet?.name ?? ''} (${rateSheet?.code ?? ''})`}
      >
        <NumberPad
          value={rateValue}
          onChange={setRateValue}
          allowDecimal
          decimals={4}
          label={ar.cash.voucher.rateLabel}
        />
        <Text style={styles.rateHint}>{ar.cash.voucher.rateHint}</Text>
        <PrimaryButton label={ar.cash.voucher.rateSave} onPress={() => void saveRate()} testID="cash-rate-save" />
      </BottomSheet>

      {/* شيت تفاصيل الحركة */}
      <BottomSheet visible={detailTx !== null} onClose={closeDetail} title={ar.cash.detail.title}>
        {detailTx !== null ? (
          <View style={styles.detailWrap}>
            <View style={styles.detailHeadRow}>
              <View style={[styles.typeIcon, { backgroundColor: typeStyle(detailTx.txType).tint }]}>
                {(() => {
                  const TS = typeStyle(detailTx.txType);
                  const Icon = TS.icon;
                  return <Icon size={22} color={TS.color} />;
                })()}
              </View>
              <View style={styles.detailHeadTexts}>
                <Text
                  style={[
                    styles.detailTypeLabel,
                    detailTx.isVoided && styles.struckThrough,
                  ]}
                >
                  {typeLabel(detailTx.txType)}
                </Text>
                <Text style={styles.detailDir}>
                  {detailTx.direction === 'in'
                    ? ar.cash.detail.directionIn
                    : ar.cash.detail.directionOut}
                </Text>
              </View>
              <AmountText
                value={detailTx.amount}
                tone={detailTx.direction === 'in' ? 'in' : 'out'}
                currency={detailTx.currencyCode}
                decimals={detailTx.currencyDecimals}
                size="lg"
              />
            </View>

            <View style={styles.detailCard}>
              <DetailRow label={ar.cash.detail.cashbox} value={detailTx.cashboxName} />
              {detailTx.toCashboxName !== null ? (
                <DetailRow label={ar.cash.detail.toCashbox} value={detailTx.toCashboxName} />
              ) : null}
              {detailTx.customerName !== null || detailTx.supplierName !== null ? (
                <DetailRow
                  label={ar.cash.detail.party}
                  value={detailTx.customerName ?? detailTx.supplierName ?? '—'}
                />
              ) : null}
              {detailTx.expenseCategoryName !== null ? (
                <DetailRow label={ar.cash.detail.category} value={detailTx.expenseCategoryName} />
              ) : null}
              <DetailRow label={ar.cash.detail.currency} value={detailTx.currencyCode} />
              <DetailRow label={ar.cash.detail.rate} value={formatQty(detailTx.exchangeRate)} />
              {detailTx.settlementRate !== null ? (
                <DetailRow
                  label={ar.cash.detail.settlementRate}
                  value={formatQty(detailTx.settlementRate)}
                />
              ) : null}
              {d(detailTx.fxGainLoss).abs().gt(0) ? (
                <DetailRow
                  label={ar.cash.detail.fx}
                  value={formatAmount(detailTx.fxGainLoss, 2)}
                />
              ) : null}
              <DetailRow
                label={ar.cash.detail.voucherNo}
                value={detailTx.voucherNo ?? ar.cash.detail.noVoucher}
                mono={detailTx.voucherNo !== null}
              />
              <DetailRow label={ar.cash.detail.date} value={formatDateAr(detailTx.txDate)} />
              {detailTx.createdAt ? (
                <DetailRow
                  label={ar.cash.detail.createdAt}
                  value={`${formatDateAr(detailTx.createdAt)}${formatTimeAr(detailTx.createdAt) ? ` · ${formatTimeAr(detailTx.createdAt)}` : ''}`}
                />
              ) : null}
              {detailTx.description ? (
                <DetailRow label={ar.cash.detail.description} value={detailTx.description} />
              ) : null}
            </View>

            {/* تخصيصات السند على الفواتير */}
            {detailAllocs.length > 0 ? (
              <View style={styles.detailCard}>
                <Text style={styles.detailSection}>{ar.cash.detail.linkedInvoices}</Text>
                {detailAllocs.map((a) => (
                  <DetailRow
                    key={a.invoiceId}
                    label={a.invoiceNo ?? String(a.invoiceId)}
                    value={formatAmount(a.allocatedAmount, detailTx.currencyDecimals)}
                    mono
                  />
                ))}
              </View>
            ) : null}

            {/* حالات الحماية */}
            {detailTx.isVoided ? (
              <View style={styles.guardBox}>
                <Text style={styles.guardText}>{ar.cash.detail.alreadyVoided}</Text>
              </View>
            ) : null}
            {detailFromInvoice ? (
              <View style={styles.guardBox}>
                <Text style={styles.guardTitle}>{ar.cash.detail.fromInvoice}</Text>
                <Text style={styles.guardText}>{ar.cash.detail.fromInvoiceHint}</Text>
              </View>
            ) : null}

            {/* الأزرار */}
            {detailCanPrint ? (
              <PrimaryButton
                label={ar.cash.detail.printVoucher}
                icon={Receipt}
                loading={busy}
                onPress={() => void onPrintVoucher(detailTx)}
                testID="cash-detail-print"
              />
            ) : null}
            {detailCanVoid ? (
              <PrimaryButton
                label={ar.cash.detail.voidButton}
                tone="danger"
                icon={TriangleAlert}
                disabled={busy}
                onPress={() => setVoidSheet(true)}
                testID="cash-detail-void"
              />
            ) : null}
          </View>
        ) : null}
      </BottomSheet>

      {/* تأكيد الإلغاء (كلمة «إلغاء» — نفس نمط إلغاء الفاتورة) */}
      <ConfirmSheet
        visible={voidSheet}
        title={ar.cash.detail.voidTitle}
        message={ar.cash.detail.voidBody}
        confirmWord={ar.cash.detail.voidWord}
        danger
        onConfirm={() => void onVoid()}
        onCancel={() => setVoidSheet(false)}
        testID="cash-void-confirm"
      />

      {feedback.host}
    </SafeScreen>
  );
}

/* ============ بطاقة الأرصدة ============ */

function BalanceCard({ balances }: { balances: CashboxBalance[] }) {
  if (balances.length === 0) {
    return (
      <AppCard>
        <Text style={styles.balanceTitle}>{ar.cash.balanceCard.cashboxes}</Text>
        <Text style={styles.noBoxesHint}>{ar.cash.balanceCard.noBoxesHint}</Text>
      </AppCard>
    );
  }
  return (
    <AppCard noPadding>
      <View style={styles.balanceHead}>
        <Text style={styles.balanceTitle}>{ar.cash.balanceCard.cashboxes}</Text>
        <Text style={styles.balanceCount}>
          {`${balances.length} ${ar.cash.balanceCard.cashboxes}`}
        </Text>
      </View>
      {balances.map((b, i) => {
        const negative = d(b.balance).lt(0);
        return (
          <View
            key={b.id}
            style={[
              styles.balanceRow,
              i < balances.length - 1 ? styles.balanceRowDivider : null,
              negative && styles.balanceRowNegative,
            ]}
            testID={`cash-balance-${b.id}`}
          >
            <View style={styles.balanceTexts}>
              <View style={styles.balanceNameRow}>
                <Text style={styles.balanceName}>{b.name}</Text>
                {b.isDefault ? (
                  <View style={styles.defaultChip}>
                    <Text style={styles.defaultChipText}>{ar.cash.balanceCard.defaultChip}</Text>
                  </View>
                ) : null}
              </View>
              {negative ? (
                <View style={styles.negativeWarnRow}>
                  <TriangleAlert size={13} color={colors.danger} />
                  <Text style={styles.negativeWarnText}>{ar.cash.balanceCard.negativeWarning}</Text>
                </View>
              ) : null}
            </View>
            <AmountText
              value={b.balance}
              tone={negative ? 'out' : 'neutral'}
              currency={b.currencyCode}
              decimals={b.currencyDecimals}
              size="lg"
              testID={`cash-balance-amount-${b.id}`}
            />
          </View>
        );
      })}
    </AppCard>
  );
}

/* ============ صف حركة ============ */

function MovementRow({
  tx,
  baseCurrencyCode,
  onPress,
}: {
  tx: CashMovementRow;
  baseCurrencyCode: string | null;
  onPress: () => void;
}) {
  const TS = typeStyle(tx.txType);
  const Icon = TS.icon;
  const fx = d(tx.fxGainLoss).abs().gt(0) ? tx.fxGainLoss : null;
  const subtitle = movementSubtitle(tx);
  const title = typeLabel(tx.txType);
  const voided = tx.isVoided;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title} — ${subtitle}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.movementRow,
        voided && styles.movementRowVoided,
        pressed && styles.movementRowPressed,
      ]}
      testID={`cash-tx-${tx.id}`}
    >
      <View style={[styles.typeIcon, { backgroundColor: TS.tint }]}>
        <Icon size={21} color={TS.color} />
      </View>
      <View style={styles.movementTexts}>
        <Text style={[styles.movementTitle, voided && styles.struckThrough]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.movementSubtitle} numberOfLines={2}>
          {subtitle}
        </Text>
        {tx.voucherNo !== null || tx.reversalOf !== null ? (
          <View style={styles.badgesRow}>
            {tx.voucherNo !== null ? (
              <View style={styles.voucherChip}>
                <Text style={styles.voucherChipText}>{tx.voucherNo}</Text>
              </View>
            ) : null}
            {tx.reversalOf !== null ? (
              <View style={styles.reversalChip}>
                <Text style={styles.reversalChipText}>{ar.cash.movements.voidedBadge}</Text>
              </View>
            ) : null}
            {voided ? (
              <View style={styles.voidedChip}>
                <Text style={styles.voidedChipText}>{ar.cash.movements.voidedLabel}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={styles.movementTrailing}>
        <AmountText
          value={tx.amount}
          tone={tx.direction === 'in' ? 'in' : 'out'}
          currency={tx.currencyCode}
          decimals={tx.currencyDecimals}
          size="md"
        />
        {fx !== null ? (
          <Text
            style={[
              styles.fxLine,
              d(tx.fxGainLoss).gt(0) ? styles.fxGain : styles.fxLoss,
            ]}
            numberOfLines={1}
          >
            {`${ar.cash.movements.fxLabel} ${
              d(tx.fxGainLoss).gt(0) ? '+' : '−'
            }${formatAmount(d(tx.fxGainLoss).abs().toString(), 2)}${
              baseCurrencyCode ? ` ${currencySymbol(baseCurrencyCode)}` : ''
            }`}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/* ============ عناصر محلية صغيرة ============ */

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono && styles.detailMono]}>{value}</Text>
    </View>
  );
}

function OptionRow({
  icon,
  color,
  label,
  hint,
  onPress,
  testID,
}: {
  icon: LucideIcon;
  color: string;
  label: string;
  hint: string;
  onPress: () => void;
  testID?: string;
}) {
  const Icon = icon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.optionRow, pressed && styles.optionRowPressed]}
      testID={testID}
    >
      <View style={[styles.optionIcon, { backgroundColor: `${color}26` }]}>
        <Icon size={20} color={color} />
      </View>
      <View style={styles.optionTexts}>
        <Text style={styles.optionLabel}>{label}</Text>
        <Text style={styles.optionHint} numberOfLines={2}>
          {hint}
        </Text>
      </View>
    </Pressable>
  );
}

function PickerButton({
  label,
  value,
  detail,
  onPress,
  testID,
}: {
  label: string;
  value: string;
  detail?: string;
  onPress?: () => void;
  testID?: string;
}) {
  const body = (
    <View style={styles.pickerBox}>
      <Text style={styles.pickerLabel}>{label}</Text>
      <Text style={styles.pickerValue} numberOfLines={1}>
        {detail ? `${value} · ${detail}` : value}
      </Text>
    </View>
  );
  if (!onPress) {
    return <View testID={testID}>{body}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      style={({ pressed }) => [styles.pickerWrap, pressed && styles.pickerPressed]}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

function ActionButton({
  label,
  icon,
  tone,
  onPress,
  flex,
  testID,
}: {
  label: string;
  icon?: LucideIcon;
  tone: 'success' | 'danger' | 'warning' | 'ghost';
  onPress: () => void;
  flex: number;
  testID?: string;
}) {
  const TONES: Record<typeof tone, { bg: string; fg: string; border?: string }> = {
    success: { bg: colors.success, fg: colors.onAccent },
    danger: { bg: colors.danger, fg: colors.onAccent },
    warning: { bg: colors.warning, fg: colors.onAccent },
    ghost: { bg: 'transparent', fg: colors.textMuted, border: colors.border },
  };
  const t = TONES[tone];
  const Icon = icon;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionBtn,
        { flex, backgroundColor: t.bg },
        t.border ? { borderWidth: 1, borderColor: t.border } : null,
        /* الأزرار الملونة الأساسية تحمل ظفاً خفيفاً — هرمية بصرية فوق الشريط */
        tone !== 'ghost' ? styles.actionBtnLift : null,
        pressed && styles.actionBtnPressed,
      ]}
    >
      {Icon ? <Icon size={17} color={t.fg} /> : null}
      <Text style={[styles.actionBtnLabel, { color: t.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/* ============ الأنماط ============ */

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  headerTitles: {
    flex: 1,
    gap: 0,
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
  refreshBtn: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(34, 211, 238, 0.45)',
    backgroundColor: 'rgba(34, 211, 238, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshBtnPressed: {
    opacity: 0.75,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  /* ——— بطاقة الأرصدة ——— */
  balanceHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  balanceTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  balanceCount: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  noBoxesHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: touch.min + 8,
  },
  balanceRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  /** صف الصندوق السالب: تظليل أحمر ناعم + حد كهرماني (FR-04-09 — تحذير لا منع) */
  balanceRowNegative: {
    backgroundColor: 'rgba(248, 113, 113, 0.08)',
    borderBottomColor: 'rgba(251, 191, 36, 0.35)',
  },
  balanceTexts: {
    flex: 1,
    gap: 3,
    alignItems: 'flex-start',
  },
  balanceNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  balanceName: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  defaultChip: {
    backgroundColor: 'rgba(34, 211, 238, 0.14)',
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  defaultChipText: {
    color: colors.accent,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  negativeWarnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  negativeWarnText: {
    color: colors.danger,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  /* ——— رأس السجل + الفلاتر ——— */
  movementsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
  },
  movementsTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  countLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingTop: 6,
    paddingBottom: spacing.xs,
  },
  filterChip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    /* توهج ناعم للشريحة النشطة — إحساس لمسي مميز عند الاختيار */
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  filterChipText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  filterChipTextActive: {
    color: colors.onAccent,
    fontFamily: font.bold,
  },
  /* ——— رؤوس الأيام ——— */
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: 2,
  },
  dayHeaderText: {
    color: colors.textMuted,
    fontFamily: font.bold,
    fontSize: 12,
    lineHeight: 17,
    letterSpacing: 0.3,
  },
  /* ——— صف الحركة ——— */
  movementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: touch.min + 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  movementRowPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.07)',
  },
  movementRowVoided: {
    opacity: 0.55,
  },
  struckThrough: {
    textDecorationLine: 'line-through',
  },
  typeIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  movementTexts: {
    flex: 1,
    gap: 2,
    alignItems: 'flex-start',
  },
  movementTitle: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  movementSubtitle: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 3,
  },
  voucherChip: {
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(34, 211, 238, 0.3)',
    borderRadius: radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  voucherChipText: {
    color: colors.accent,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 16,
  },
  reversalChip: {
    backgroundColor: 'rgba(251, 191, 36, 0.12)',
    borderRadius: radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  reversalChipText: {
    color: colors.warning,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  voidedChip: {
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    borderRadius: radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  voidedChipText: {
    color: colors.danger,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  movementTrailing: {
    alignItems: 'flex-end',
    gap: 2,
    flexShrink: 1,
  },
  fxLine: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 16,
  },
  fxGain: {
    color: colors.success,
  },
  fxLoss: {
    color: colors.danger,
  },
  /* ——— الشريط السفلي ——— */
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: touch.min,
    borderRadius: radius.md,
    paddingHorizontal: 8,
  },
  actionBtnPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }],
  },
  actionBtnLift: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  actionBtnLabel: {
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  /* ——— الشيتات ——— */
  fieldRow: {
    flexDirection: 'row',
    gap: 8,
  },
  fieldGrow: {
    flex: 1,
  },
  pickerWrap: {
    borderRadius: radius.md,
  },
  pickerPressed: {
    opacity: 0.75,
  },
  pickerBox: {
    gap: 4,
    minHeight: touch.min + 8,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pickerLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  pickerValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'right',
  },
  fxPreviewBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  fxPreviewLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  fxPreviewValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  fxPreviewMuted: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  sameCurrencyNote: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  rateHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touch.min + 8,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
  },
  optionRowPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.08)',
  },
  optionIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionTexts: {
    flex: 1,
    gap: 2,
  },
  optionLabel: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  optionHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  /* ——— شيت التفاصيل ——— */
  detailWrap: {
    gap: spacing.md,
  },
  detailHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  detailHeadTexts: {
    flex: 1,
    gap: 2,
  },
  detailTypeLabel: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 17,
    lineHeight: 24,
  },
  detailDir: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  detailCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: spacing.md,
    gap: 6,
  },
  detailSection: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 2,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 3,
  },
  detailLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  detailValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'left',
    flexShrink: 1,
  },
  detailMono: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
  },
  guardBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.35)',
    backgroundColor: 'rgba(251, 191, 36, 0.08)',
    padding: spacing.md,
    gap: 3,
  },
  guardTitle: {
    color: colors.warning,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  guardText: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
});
