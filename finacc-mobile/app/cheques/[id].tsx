/**
 * cheques/[id].tsx — تفاصيل الشيك ودورته (FR-14 — Task 12):
 *
 *  - بطاقة معلومات كاملة (الرقم/البنك/الطرف قابل للفتح في ملفه/المبلغ
 *    بعملته/سعره وقت التسجيل/التاريخان/ملاحظات) + سطر الفاتورة المرجعية
 *    (يفتح تفاصيلها حسب عائلتها) + سطر حركة التحصيل عند cleared (رقم
 *    السند والتاريخ والصندوق + زر فتح سجل النقدية).
 *  - خط زمني بصري: تسجيل → إيداع بالبنك → محصّل، أو → مرتد (والملغى
 *    يرمادي كل المسار).
 *  - الإجراءات بحالة الشيك: «إيداع بالبنك» (pending) / «تحصيل/صرف»
 *    (شيت صندوق + معاينة سعر اليوم لغير الأساس) / «ارتداد» (شيت رسم
 *    اختياري بفئته وصندوقه) / «إلغاء الشيك» (تأكيد بكلمة — FR-14-06).
 *  - الحالات الختامية للقراءة فقط: cleared (ملاحظة عكس الأثر من
 *    النقدية) / bounced (تاريخ الارتداد + الرسم + عودة الدين) / void
 *    (باهت).
 *  - كل الكتابة عبر domain/cheques.ts — الشاشة عرض وتنقل فقط.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Banknote,
  Building2,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Landmark,
  ReceiptText,
  TriangleAlert,
  XCircle,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  getCashboxBalances,
  getChequeById,
  listExpenseCategories,
  type CashboxBalance,
  type ChequeDetailRow,
  type RefRow,
} from '@/db/queries';
import {
  bounceCheque,
  clearCheque,
  depositCheque,
  voidCheque,
} from '@/domain/cheques';
import { getRate } from '@/domain/currency';
import { MissingRateError } from '@/domain/errors';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import {
  currencySymbol,
  formatAmount,
  formatDateAr,
  formatDayShortAr,
  todayISO,
} from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import AmountText from '@/components/ui/AmountText';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import ConfirmSheet from '@/components/ui/ConfirmSheet';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import MoneyField from '@/components/ui/MoneyField';
import OptionPickerSheet from '@/components/ui/OptionPickerSheet';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import { useFeedback } from '@/components/ui/feedback';
import ChequeStatusBadge from '@/components/cheques/ChequeStatusBadge';

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'notfound' }
  | { kind: 'ready'; cheque: ChequeDetailRow };

export default function ChequeDetailsScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const userId = session.user?.id;
  const params = useLocalSearchParams<{ id?: string }>();
  const chequeId = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  const today = todayISO();

  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  /* ——— شيت التحصيل ——— */
  const [clearSheet, setClearSheet] = useState(false);
  const [boxes, setBoxes] = useState<CashboxBalance[]>([]);
  const [clearBoxId, setClearBoxId] = useState<number | null>(null);
  const [clearBoxSheet, setClearBoxSheet] = useState(false);
  const [todayRate, setTodayRate] = useState<string | null>(null);

  /* ——— شيت الارتداد ——— */
  const [bounceSheet, setBounceSheet] = useState(false);
  const [fee, setFee] = useState('0');
  const [categories, setCategories] = useState<RefRow[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [categorySheet, setCategorySheet] = useState(false);
  const [feeBoxId, setFeeBoxId] = useState<number | null>(null);
  const [feeBoxSheet, setFeeBoxSheet] = useState(false);

  /* ——— شيت الإلغاء ——— */
  const [voidSheet, setVoidSheet] = useState(false);

  const load = useCallback(async () => {
    if (chequeId === null) {
      setState({ kind: 'notfound' });
      return;
    }
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    try {
      const db = await getDb();
      const cheque = await getChequeById(db, chequeId);
      if (!cheque) {
        setState({ kind: 'notfound' });
        return;
      }
      setState({ kind: 'ready', cheque });
    } catch (err) {
      setState({ kind: 'error', technical: technicalText(err) });
    }
  }, [chequeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void load(); // العودة من ملف الطرف/الفاتورة بعد تغييرات
    }, [load]),
  );

  /* ============ تجهيز شيت التحصيل: الصناديق + سعر اليوم ============ */

  const openClearSheet = async () => {
    setClearSheet(true);
    try {
      const db = await getDb();
      const [list, balances] = await Promise.all([
        getChequeById(db, chequeId ?? -1),
        getCashboxBalances(db),
      ]);
      setBoxes(balances);
      setClearBoxId((prev) => prev ?? (balances.find((b) => b.isDefault)?.id ?? balances[0]?.id ?? null));
      if (list && Number(list.currencyId) !== session.defaults?.baseCurrencyId) {
        try {
          setTodayRate(await getRate(db, list.currencyId, today));
        } catch {
          setTodayRate(null); // سيُطلب سعر اليوم عند التنفيذ (MissingRateError)
        }
      } else {
        setTodayRate(null);
      }
    } catch {
      // الصناديق تبقى كما كانت — الزر يعيد المحاولة
    }
  };

  /* ============ الإجراءات ============ */

  const onDeposit = async () => {
    if (chequeId === null) return;
    setBusy(true);
    try {
      const db = await getDb();
      await depositCheque(db, chequeId, { createdBy: userId });
      feedback.show({ message: ar.cheques.actions.depositDone, durationMs: 5000 });
      await load();
    } catch (err) {
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cheques.actions.depositFailed,
        durationMs: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    if (chequeId === null || clearBoxId === null) return;
    setBusy(true);
    try {
      const db = await getDb();
      const result = await clearCheque(db, chequeId, { cashboxId: clearBoxId }, { createdBy: userId });
      setClearSheet(false);
      feedback.show({
        message: `${state.kind === 'ready' && state.cheque.direction === 'in' ? ar.cheques.actions.done : ar.cheques.actions.doneOut} — ${result.voucherNo}`,
        durationMs: 6000,
      });
      await load();
    } catch (err) {
      if (err instanceof MissingRateError) {
        feedback.show({
          message: domainErrorMessage(err) ?? ar.cheques.actions.failed,
          durationMs: 9000,
        });
        return;
      }
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cheques.actions.failed,
        durationMs: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  const openBounceSheet = async () => {
    setBounceSheet(true);
    setFee('0');
    setCategoryId(null);
    setFeeBoxId(null);
    try {
      const db = await getDb();
      const [cats, balances] = await Promise.all([
        listExpenseCategories(db),
        getCashboxBalances(db),
      ]);
      setCategories(cats);
      setBoxes(balances);
      setFeeBoxId(balances.find((b) => b.isDefault)?.id ?? balances[0]?.id ?? null);
    } catch {
      // فئات فارغة = الرسم غير متاح (fee=0 يبقى صالحاً)
    }
  };

  const onBounce = async () => {
    if (chequeId === null) return;
    const feeAmount = d(fee);
    if (feeAmount.gt(0) && categoryId === null) {
      feedback.show({ message: ar.cheques.actions.needCategory, durationMs: 6000 });
      setCategorySheet(true);
      return;
    }
    if (feeAmount.gt(0) && feeBoxId === null) {
      feedback.show({ message: ar.cheques.actions.needFeeCashbox, durationMs: 6000 });
      setFeeBoxSheet(true);
      return;
    }
    setBusy(true);
    try {
      const db = await getDb();
      await bounceCheque(
        db,
        chequeId,
        {
          fee: feeAmount.gt(0) ? fee : undefined,
          categoryId: feeAmount.gt(0) ? categoryId ?? undefined : undefined,
          cashboxId: feeAmount.gt(0) ? feeBoxId ?? undefined : undefined,
        },
        { createdBy: userId },
      );
      setBounceSheet(false);
      feedback.show({ message: ar.cheques.actions.bounceDone, durationMs: 6000 });
      await load();
    } catch (err) {
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cheques.actions.bounceFailed,
        durationMs: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  const onVoid = async () => {
    if (chequeId === null) return;
    setBusy(true);
    try {
      const db = await getDb();
      await voidCheque(db, chequeId, { createdBy: userId });
      setVoidSheet(false);
      feedback.show({ message: ar.cheques.actions.voidDone, durationMs: 5000 });
      await load();
    } catch (err) {
      feedback.show({
        message: domainErrorMessage(err) ?? ar.cheques.actions.voidFailed,
        durationMs: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  /* ============ الحالات ============ */

  if (state.kind === 'loading') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.cheques.details.title} onBack={() => router.back()} />
        <AppCard noPadding>
          <LoadingState variant="card" />
        </AppCard>
      </SafeScreen>
    );
  }
  if (state.kind === 'notfound') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.cheques.details.title} onBack={() => router.back()} />
        <AppCard noPadding>
          <ErrorState message={ar.cheques.details.notFound} onRetry={() => router.back()} />
        </AppCard>
      </SafeScreen>
    );
  }
  if (state.kind === 'error') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.cheques.details.title} onBack={() => router.back()} />
        <AppCard noPadding>
          <ErrorState
            message={ar.cheques.details.errorLoad}
            technical={state.technical}
            onRetry={() => void load()}
          />
        </AppCard>
      </SafeScreen>
    );
  }

  const cheque = state.cheque;
  const isIn = cheque.direction === 'in';
  const isLive = cheque.status === 'pending' || cheque.status === 'deposited';
  const isForeign = cheque.currencyId !== session.defaults?.baseCurrencyId;
  const selectedClearBox = boxes.find((b) => b.id === clearBoxId) ?? null;
  const selectedFeeBox = boxes.find((b) => b.id === feeBoxId) ?? null;
  const selectedCategory = categories.find((c) => c.id === categoryId) ?? null;

  return (
    <SafeScreen offline={false}>
      <ScreenHeader
        title={isIn ? ar.cheques.details.directionIn : ar.cheques.details.directionOut}
        subtitle={cheque.chequeNo}
        onBack={() => router.back()}
      />

      {/* ——— الخط الزمني (مسار الشيك) ——— */}
      <AppCard noPadding>
        <View style={styles.timelineHead}>
          <Text style={styles.timelineTitle}>{ar.cheques.details.timeline}</Text>
          <ChequeStatusBadge status={cheque.status} direction={cheque.direction} />
        </View>
        <Timeline status={cheque.status} />
      </AppCard>

      {/* ——— بطاقة المعلومات ——— */}
      <AppCard noPadding style={cheque.status === 'void' ? styles.faded : null}>
        <View style={styles.infoPad}>
          <View style={styles.amountRow}>
            <View style={styles.amountTexts}>
              <Text style={styles.infoLabel}>{ar.cheques.details.amount}</Text>
              <AmountText
                value={cheque.amount}
                tone={isIn ? 'in' : 'out'}
                currency={cheque.currencyCode}
                decimals={cheque.currencyDecimals}
                size="lg"
              />
              {isForeign ? (
                <Text style={styles.rateText}>
                  {`${ar.cheques.details.rate}: ${formatAmount(cheque.exchangeRate, 2)}`}
                </Text>
              ) : null}
            </View>
            <View style={[styles.directionIcon, { backgroundColor: isIn ? 'rgba(52, 211, 153, 0.14)' : 'rgba(248, 113, 113, 0.13)' }]}>
              <Banknote size={22} color={isIn ? colors.success : colors.danger} />
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${ar.cheques.details.party}: ${cheque.partyName ?? '—'}`}
            onPress={() =>
              router.push({
                pathname: '/parties/party-file',
                params: { kind: cheque.partyType, id: String(cheque.partyId) },
              })
            }
            style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
            testID="cheque-party-link"
          >
            <Text style={styles.infoLabel}>{ar.cheques.details.party}</Text>
            <View style={styles.linkTrailing}>
              <Text style={styles.linkValue}>{cheque.partyName ?? '—'}</Text>
              <ChevronLeft size={16} color={colors.textFaint} />
            </View>
          </Pressable>

          <InfoRow label={ar.cheques.details.chequeNo} value={cheque.chequeNo} mono />
          {cheque.bankName ? (
            <InfoRow label={ar.cheques.details.bank} value={cheque.bankName} />
          ) : null}
          <View style={styles.datesGrid}>
            <View style={styles.dateCell}>
              <Text style={styles.infoLabel}>{ar.cheques.details.issueDate}</Text>
              <Text style={styles.dateValue}>{formatDayShortAr(cheque.issueDate)}</Text>
            </View>
            <View style={styles.dateCell}>
              <Text style={styles.infoLabel}>{ar.cheques.details.dueDate}</Text>
              <Text style={[styles.dateValue, styles.dateDue]}>{formatDayShortAr(cheque.dueDate)}</Text>
            </View>
          </View>
          {cheque.notes ? (
            <View style={styles.notesBox}>
              <Text style={styles.infoLabel}>{ar.cheques.details.notes}</Text>
              <Text style={styles.notesText}>{cheque.notes}</Text>
            </View>
          ) : null}
        </View>
      </AppCard>

      {/* ——— الفاتورة المرجعية ——— */}
      {cheque.refInvoiceId !== null ? (
        <AppCard noPadding>
          <View style={styles.infoPad}>
            <Text style={styles.sectionTitle}>{ar.cheques.details.refInvoice}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={cheque.refInvoiceNo ?? '—'}
              onPress={() =>
                router.push(
                  cheque.refInvoiceDocType === 'purchase'
                    ? `/purchases/${cheque.refInvoiceId}`
                    : `/sales/${cheque.refInvoiceId}`,
                )
              }
              style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
              testID="cheque-ref-invoice-link"
            >
              <View style={styles.linkTexts}>
                <Text style={styles.linkValue}>{cheque.refInvoiceNo ?? '—'}</Text>
                {cheque.refInvoiceTotal !== null ? (
                  <Text style={styles.linkSub}>
                    {`${ar.cheques.details.refInvoiceTotal}: ${formatAmount(cheque.refInvoiceTotal, cheque.currencyDecimals)} ${currencySymbol(cheque.currencyCode)}`}
                  </Text>
                ) : null}
              </View>
              <ReceiptText size={18} color={colors.teal} />
            </Pressable>
          </View>
        </AppCard>
      ) : null}

      {/* ——— الحالات الخاصة ——— */}
      {cheque.status === 'bounced' ? (
        <AppCard noPadding>
          <View style={styles.infoPad}>
            <View style={styles.stateHeadRow}>
              <View style={styles.stateIconDanger}>
                <TriangleAlert size={20} color={colors.danger} />
              </View>
              <Text style={styles.stateTitleDanger}>{ar.cheques.details.bouncedTitle}</Text>
            </View>
            <InfoRow
              label={ar.cheques.details.bouncedAt}
              value={formatDateAr(cheque.bouncedAt ?? '')}
            />
            <InfoRow
              label={ar.cheques.details.bouncedFee}
              value={`${formatAmount(cheque.bounceFee ?? '0', cheque.currencyDecimals)} ${currencySymbol(cheque.currencyCode)}`}
              mono
            />
            <View style={styles.stateNoteBox}>
              <Text style={styles.stateNoteText}>{ar.cheques.details.bouncedDebtNote}</Text>
            </View>
          </View>
        </AppCard>
      ) : null}

      {cheque.status === 'cleared' ? (
        <AppCard noPadding>
          <View style={styles.infoPad}>
            <Text style={styles.sectionTitle}>{ar.cheques.details.clearedTx}</Text>
            <View style={styles.clearedCard}>
              <View style={styles.clearedHeadRow}>
                <View style={styles.stateIconSuccess}>
                  <CheckCircle2 size={20} color={colors.success} />
                </View>
                <Text style={styles.clearedVoucher}>{cheque.clearedVoucherNo ?? '—'}</Text>
              </View>
              <InfoRow
                label={ar.cheques.details.clearedVoucher}
                value={cheque.clearedVoucherNo ?? '—'}
                mono
              />
              <InfoRow
                label={ar.cheques.details.dueDate}
                value={formatDateAr(cheque.clearedTxDate ?? '')}
              />
              {cheque.clearedCashboxName ? (
                <InfoRow
                  label={ar.cash.voucher.cashbox}
                  value={cheque.clearedCashboxName}
                />
              ) : null}
              {cheque.clearedTxAmount !== null ? (
                <InfoRow
                  label={isIn ? ar.cheques.details.directionIn : ar.cheques.details.directionOut}
                  value={`${formatAmount(cheque.clearedTxAmount, cheque.currencyDecimals)} ${currencySymbol(cheque.currencyCode)}`}
                  mono
                />
              ) : null}
              <Text style={styles.clearedNote}>{ar.cheques.details.clearedNote}</Text>
              <PrimaryButton
                label={ar.cheques.details.viewCashTx}
                icon={Landmark}
                tone="ghost"
                compact
                onPress={() => router.push('/cash')}
                style={styles.cashTxBtn}
                testID="cheque-cash-link"
              />
            </View>
          </View>
        </AppCard>
      ) : null}

      {cheque.status === 'void' ? (
        <AppCard noPadding>
          <View style={styles.infoPad}>
            <View style={styles.stateHeadRow}>
              <View style={styles.stateIconMuted}>
                <XCircle size={20} color={colors.textMuted} />
              </View>
              <Text style={styles.stateTitleMuted}>{ar.cheques.details.voidedTitle}</Text>
            </View>
            <Text style={styles.stateNoteText}>{ar.cheques.details.voidedNote}</Text>
          </View>
        </AppCard>
      ) : null}

      {/* ——— الإجراءات ——— */}
      {isLive ? (
        <View style={styles.actionsCard}>
          {cheque.status === 'pending' ? (
            <PrimaryButton
              label={ar.cheques.actions.deposit}
              icon={Building2}
              tone="ghost"
              loading={busy}
              onPress={() => void onDeposit()}
              testID="cheque-deposit-btn"
            />
          ) : null}
          <PrimaryButton
            label={isIn ? ar.cheques.actions.clear : ar.cheques.actions.clearOut}
            icon={isIn ? CheckCircle2 : Banknote}
            tone={isIn ? 'success' : 'danger'}
            loading={busy}
            onPress={() => void openClearSheet()}
            testID="cheque-clear-btn"
          />
          <PrimaryButton
            label={ar.cheques.actions.bounce}
            icon={CircleAlert}
            tone="warning"
            loading={busy}
            onPress={() => void openBounceSheet()}
            testID="cheque-bounce-btn"
          />
          <PrimaryButton
            label={ar.cheques.actions.void}
            icon={XCircle}
            tone="ghost"
            onPress={() => setVoidSheet(true)}
            testID="cheque-void-btn"
          />
        </View>
      ) : null}

      {/* ============ الشيتات ============ */}

      {/* شيت التحصيل/الصرف */}
      <BottomSheet visible={clearSheet} onClose={() => setClearSheet(false)} title={isIn ? ar.cheques.actions.clearTitle : ar.cheques.actions.clearTitleOut}>
        <Text style={styles.sheetHint}>{ar.cheques.actions.clearHint}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${ar.cheques.actions.cashbox}: ${selectedClearBox?.name ?? '—'}`}
          onPress={() => setClearBoxSheet(true)}
          style={({ pressed }) => [styles.pickerRow, pressed && styles.pickerRowPressed]}
          testID="cheque-clear-cashbox"
        >
          <Text style={styles.pickerLabel}>{ar.cheques.actions.cashbox}</Text>
          <View style={styles.linkTrailing}>
            <Text style={styles.pickerValue}>{selectedClearBox?.name ?? '—'}</Text>
            <ChevronLeft size={16} color={colors.textFaint} />
          </View>
        </Pressable>
        <View style={styles.clearSummary}>
          <View style={styles.clearRow}>
            <Text style={styles.clearLabel}>{ar.cheques.details.amount}</Text>
            <AmountText
              value={cheque.amount}
              tone={isIn ? 'in' : 'out'}
              currency={cheque.currencyCode}
              decimals={cheque.currencyDecimals}
            />
          </View>
          {isForeign ? (
            <View style={styles.clearRow}>
              <Text style={styles.clearLabel}>{ar.cheques.actions.fxPreview}</Text>
              <Text style={styles.clearRate}>
                {todayRate !== null
                  ? `${formatAmount(cheque.amount, cheque.currencyDecimals)} × ${formatAmount(todayRate, 2)} = ${formatAmount(d(cheque.amount).times(d(todayRate)).toFixed(4), 2)} ${currencySymbol(session.defaults?.baseCurrencyCode ?? '')}`
                  : '—'}
              </Text>
            </View>
          ) : null}
        </View>
        <PrimaryButton
          label={isIn ? ar.cheques.actions.confirm : ar.cheques.actions.confirmOut}
          tone={isIn ? 'success' : 'danger'}
          loading={busy}
          disabled={clearBoxId === null}
          onPress={() => void onClear()}
          testID="cheque-clear-confirm"
        />
      </BottomSheet>

      {/* منتقي صندوق التحصيل */}
      <OptionPickerSheet
        visible={clearBoxSheet}
        title={ar.cheques.actions.pickCashbox}
        options={boxes.map((b) => ({
          id: b.id,
          label: b.name,
          detail: `${formatAmount(b.balance, b.currencyDecimals)} ${currencySymbol(b.currencyCode)} · ${b.currencyCode}`,
        }))}
        selectedId={clearBoxId}
        onSelect={(id) => id !== null && setClearBoxId(id)}
        onClose={() => setClearBoxSheet(false)}
        testID="cheque-clear-box-picker"
      />

      {/* شيت الارتداد */}
      <BottomSheet visible={bounceSheet} onClose={() => setBounceSheet(false)} title={ar.cheques.actions.bounceTitle}>
        <Text style={styles.sheetHint}>{ar.cheques.actions.bounceHint}</Text>
        <MoneyField
          label={ar.cheques.actions.bounceFee}
          value={fee}
          onChange={setFee}
          currencyCode={cheque.currencyCode}
          decimals={cheque.currencyDecimals}
          hint={ar.cheques.actions.bounceFeeHint}
          testID="cheque-bounce-fee"
        />
        {d(fee).gt(0) ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${ar.cheques.actions.bounceCategory}: ${selectedCategory?.name ?? '—'}`}
              onPress={() => setCategorySheet(true)}
              style={({ pressed }) => [styles.pickerRow, pressed && styles.pickerRowPressed]}
              testID="cheque-bounce-category"
            >
              <Text style={styles.pickerLabel}>{ar.cheques.actions.bounceCategory}</Text>
              <View style={styles.linkTrailing}>
                <Text style={styles.pickerValue}>{selectedCategory?.name ?? '—'}</Text>
                <ChevronLeft size={16} color={colors.textFaint} />
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${ar.cheques.actions.cashbox}: ${selectedFeeBox?.name ?? '—'}`}
              onPress={() => setFeeBoxSheet(true)}
              style={({ pressed }) => [styles.pickerRow, pressed && styles.pickerRowPressed]}
              testID="cheque-bounce-cashbox"
            >
              <Text style={styles.pickerLabel}>{ar.cheques.actions.cashbox}</Text>
              <View style={styles.linkTrailing}>
                <Text style={styles.pickerValue}>{selectedFeeBox?.name ?? '—'}</Text>
                <ChevronLeft size={16} color={colors.textFaint} />
              </View>
            </Pressable>
          </>
        ) : null}
        <PrimaryButton
          label={ar.cheques.actions.bounceConfirm}
          tone="warning"
          loading={busy}
          onPress={() => void onBounce()}
          testID="cheque-bounce-confirm"
        />
      </BottomSheet>

      {/* منتقي فئة الرسم */}
      <OptionPickerSheet
        visible={categorySheet}
        title={ar.cheques.actions.pickCategory}
        options={categories.map((c) => ({ id: c.id, label: c.name }))}
        selectedId={categoryId}
        onSelect={(id) => setCategoryId(id)}
        onClose={() => setCategorySheet(false)}
        testID="cheque-category-picker"
      />

      {/* منتقي صندوق الرسم */}
      <OptionPickerSheet
        visible={feeBoxSheet}
        title={ar.cheques.actions.pickCashbox}
        options={boxes.map((b) => ({
          id: b.id,
          label: b.name,
          detail: `${formatAmount(b.balance, b.currencyDecimals)} ${currencySymbol(b.currencyCode)} · ${b.currencyCode}`,
        }))}
        selectedId={feeBoxId}
        onSelect={(id) => id !== null && setFeeBoxId(id)}
        onClose={() => setFeeBoxSheet(false)}
        testID="cheque-fee-box-picker"
      />

      {/* تأكيد الإلغاء (كلمة مطبوعة — FR-14-06) */}
      <ConfirmSheet
        visible={voidSheet}
        title={ar.cheques.actions.voidTitle}
        message={ar.cheques.actions.voidMessage}
        confirmWord={ar.cheques.actions.voidConfirmWord}
        danger
        onConfirm={() => void onVoid()}
        onCancel={() => setVoidSheet(false)}
        testID="cheque-void-confirm"
      />

      {feedback.host}
    </SafeScreen>
  );
}

/* ============ الخط الزمني ============ */

function Timeline({ status }: { status: ChequeDetailRow['status'] }) {
  // المسار الرئيس: تسجيل → إيداع → محصّل؛ الارتداد فرع أحمر والملغى يرمادي
  const steps: { label: string; state: 'done' | 'active' | 'future' | 'danger' | 'muted' }[] = [
    { label: ar.cheques.details.stepPending, state: 'done' },
    { label: ar.cheques.details.stepDeposited, state: 'future' },
    {
      label:
        status === 'bounced' ? ar.cheques.details.stepBounced : ar.cheques.details.stepCleared,
      state: 'future',
    },
  ];
  if (status === 'pending') {
    steps[0].state = 'active';
  } else if (status === 'deposited') {
    steps[0].state = 'done';
    steps[1].state = 'active';
  } else if (status === 'cleared') {
    steps[0].state = 'done';
    steps[1].state = 'done';
    steps[2].state = 'done';
  } else if (status === 'bounced') {
    steps[0].state = 'done';
    steps[1].state = 'done';
    steps[2].state = 'danger';
  } else if (status === 'void') {
    steps[0].state = 'muted';
    steps[1].state = 'muted';
    steps[2] = { label: ar.cheques.details.stepVoid, state: 'muted' };
  }
  return (
    <View style={styles.timelineRow} testID="cheque-timeline">
      {steps.map((s, i) => {
        const isLast = i === steps.length - 1;
        const color =
          s.state === 'danger'
            ? colors.danger
            : s.state === 'done' || s.state === 'active'
              ? s.state === 'active'
                ? colors.accent
                : colors.success
              : s.state === 'muted'
                ? colors.textMuted
                : colors.textFaint;
        return (
          <View key={s.label} style={[styles.timelineStep, isLast && styles.timelineStepLast]}>
            <View
              style={[
                styles.timelineDot,
                { borderColor: color, backgroundColor: s.state === 'future' ? 'transparent' : `${color}33` },
              ]}
            >
              {s.state === 'done' || s.state === 'danger' ? (
                <View style={[styles.timelineDotInner, { backgroundColor: color }]} />
              ) : null}
            </View>
            {!isLast ? (
              <View
                style={[
                  styles.timelineBar,
                  {
                    backgroundColor:
                      steps[i + 1].state === 'future' || steps[i + 1].state === 'muted'
                        ? colors.border
                        : steps[i + 1].state === 'danger'
                          ? colors.danger
                          : colors.success,
                  },
                ]}
              />
            ) : null}
            <Text style={[styles.timelineLabel, { color }]} numberOfLines={1}>
              {s.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/* ============ صف معلومة ============ */

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && styles.infoMono]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  faded: {
    opacity: 0.6,
  },
  infoPad: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: spacing.xs,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  amountTexts: {
    flex: 1,
    gap: 2,
  },
  directionIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rateText: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 5,
  },
  infoLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  infoValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'left',
    flexShrink: 1,
  },
  infoMono: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
  },
  datesGrid: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.xs,
  },
  dateCell: {
    flex: 1,
    gap: 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  dateValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
  },
  dateDue: {
    color: colors.warning,
    fontFamily: font.bold,
  },
  notesBox: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: 4,
  },
  notesText: {
    color: colors.text,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'right',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 6,
  },
  linkRowPressed: {
    opacity: 0.7,
  },
  linkTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 1,
  },
  linkValue: {
    color: colors.accent,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
    flexShrink: 1,
  },
  linkTexts: {
    flex: 1,
    gap: 1,
  },
  linkSub: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  stateHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.xs,
  },
  stateIconDanger: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(248, 113, 113, 0.14)',
  },
  stateIconSuccess: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(52, 211, 153, 0.14)',
  },
  stateIconMuted: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
  },
  stateTitleDanger: {
    color: colors.danger,
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 24,
  },
  stateTitleMuted: {
    color: colors.textMuted,
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 24,
  },
  stateNoteBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.30)',
    backgroundColor: 'rgba(248, 113, 113, 0.07)',
    padding: spacing.md,
    marginTop: spacing.xs,
  },
  stateNoteText: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 19,
    textAlign: 'right',
  },
  clearedCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(52, 211, 153, 0.30)',
    backgroundColor: 'rgba(52, 211, 153, 0.06)',
    padding: spacing.md,
    gap: 2,
  },
  clearedHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.xs,
  },
  clearedVoucher: {
    color: colors.success,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 16,
    lineHeight: 24,
    flexShrink: 1,
  },
  clearedNote: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    marginTop: spacing.xs,
  },
  cashTxBtn: {
    marginTop: spacing.sm,
  },
  actionsCard: {
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  timelineHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  timelineTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    paddingTop: spacing.sm,
  },
  timelineStep: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  timelineStepLast: {
    flex: 0,
    flexShrink: 1,
  },
  timelineDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timelineDotInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  timelineBar: {
    flex: 1,
    height: 2,
    marginHorizontal: 6,
    borderRadius: 1,
  },
  timelineLabel: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    marginLeft: 6,
    flexShrink: 1,
  },
  sheetHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 19,
    marginBottom: spacing.md,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.xs,
  },
  pickerRowPressed: {
    opacity: 0.7,
  },
  pickerLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  pickerValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
    flexShrink: 1,
  },
  clearSummary: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(34, 211, 238, 0.05)',
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  clearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  clearLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  clearRate: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'left',
    flexShrink: 1,
  },
});
