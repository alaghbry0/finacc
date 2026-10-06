/**
 * installments/[id].tsx — تفاصيل خطة التقسيط ودورتها (FR-05 — Task 14):
 *
 *  - بطاقة معلومات: العميل (يفتح ملفه) + فاتورة المصدر (تفتح تفاصيلها —
 *    عائلة بيع) + الأصل/الدفعة الأولى/العملة/شريط التقدّم x/y.
 *  - جدول الأقساط: seq/الاستحقاق/المبلغ/المدفوع/شريحة الحالة (مدفوعة
 *    خضراء · جزئي كهرماني · متأخرة حمراء + «متأخر X يوماً» FR-05-04 ·
 *    قادمة محايدة) — التأخر مشتق (due_date < اليوم) لا مخزَّن.
 *  - لكل قسط غير مسدد صف إجراءات: «تحصيل القسط» (شيت صندوق + مبلغ
 *    مسبق بالمتبقي — جزئي مسموح — FR-05-02 بضغطة) + «تذكير واتساب»
 *    (رسالة جاهزة: العميل/رقم القسط/المبلغ والتاريخ/متبقي الخطة —
 *    FR-05-03؛ من واتساب العميل أو هاتفه، وإلا رسالة صادقة) + «إعادة
 *    جدولة» (تاريخ جديد + سبب اختياري — FR-05-04: التاريخ فقط).
 *  - المكتملة للقراءة فقط بشريط «مكتملة». عملة أجنبية بلا سعر اليوم →
 *    شيت إدخال السعر (قرار 3) ثم إعادة المحاولة.
 *  - الإشعار المحلي قبل الاستحقاق بيوم (FR-05-03) Expo-أصلي → مؤجل
 *    وموثق في سجل العمل (لا إشعارات في معاينة الويب).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Banknote,
  CalendarClock,
  CalendarOff,
  CheckCircle2,
  ChevronLeft,
  MessageCircle,
  ReceiptText,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import { getCashboxBalances, getInstallmentPlan, type CashboxBalance, type InstallmentPlanDetailRow, type InstallmentScheduleRow } from '@/db/queries';
import { daysLate, isLate, payInstallment, rescheduleInstallment } from '@/domain/installments';
import { upsertDailyRate } from '@/domain/currency';
import { MissingRateError } from '@/domain/errors';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import {
  currencySymbol,
  formatAmount,
  formatCount,
  formatDateAr,
  formatDayShortAr,
  todayISO,
} from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import { waLink, waNumber } from '@/services/share-text';
import AmountText from '@/components/ui/AmountText';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import MoneyField from '@/components/ui/MoneyField';
import NumberPad from '@/components/ui/NumberPad';
import OptionPickerSheet from '@/components/ui/OptionPickerSheet';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import TagChip from '@/components/ui/TagChip';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'notfound' }
  | { kind: 'ready'; plan: InstallmentPlanDetailRow };

export default function InstallmentPlanScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const userId = session.user?.id;
  const params = useLocalSearchParams<{ id?: string }>();
  const planId = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  const today = todayISO();

  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  /* ——— شيت التحصيل ——— */
  const [collectSheet, setCollectSheet] = useState(false);
  const [collectTarget, setCollectTarget] = useState<InstallmentScheduleRow | null>(null);
  const [collectAmount, setCollectAmount] = useState('0');
  const [boxes, setBoxes] = useState<CashboxBalance[]>([]);
  const [cashboxId, setCashboxId] = useState<number | null>(null);
  const [boxSheet, setBoxSheet] = useState(false);

  /* ——— شيت إعادة الجدولة ——— */
  const [reschedSheet, setReschedSheet] = useState(false);
  const [reschedTarget, setReschedTarget] = useState<InstallmentScheduleRow | null>(null);
  const [newDueDate, setNewDueDate] = useState('');
  const [reason, setReason] = useState('');

  /* ——— شيت سعر اليوم (عملة أجنبية — قرار 3) ——— */
  const [rateSheet, setRateSheet] = useState(false);
  const [rateValue, setRateValue] = useState('0');
  const rateRetry = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    if (planId === null) {
      setState({ kind: 'notfound' });
      return;
    }
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    try {
      const db = await getDb();
      const plan = await getInstallmentPlan(db, planId);
      if (!plan) {
        setState({ kind: 'notfound' });
        return;
      }
      setState({ kind: 'ready', plan });
    } catch (err) {
      setState({ kind: 'error', technical: technicalText(err) });
    }
  }, [planId]);

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
      void load(); // العودة من ملف الطرف/الفاتورة بعد تحصيل
    }, [load]),
  );

  /* ============ تحصيل قسط (FR-05-02) ============ */

  const openCollectSheet = async (inst: InstallmentScheduleRow) => {
    setCollectTarget(inst);
    setCollectAmount(d(inst.amount).minus(d(inst.paidAmount)).toFixed(4));
    setCollectSheet(true);
    try {
      const db = await getDb();
      const balances = await getCashboxBalances(db);
      setBoxes(balances);
      setCashboxId((prev) => prev ?? (balances.find((b) => b.isDefault)?.id ?? balances[0]?.id ?? null));
    } catch {
      // الصناديق تبقى كما كانت — الزر يعيد المحاولة
    }
  };

  const onCollect = async (afterRate = false) => {
    if (collectTarget === null || cashboxId === null) return;
    setBusy(true);
    try {
      const db = await getDb();
      await payInstallment(
        db,
        {
          installmentId: collectTarget.id,
          cashboxId,
          amount: collectAmount,
        },
        { createdBy: userId },
      );
      setCollectSheet(false);
      feedback.show({ message: ar.installments.details.collectDone, durationMs: 6000 });
      await load();
    } catch (err) {
      if (err instanceof MissingRateError && !afterRate) {
        setRateValue('0');
        rateRetry.current = () => void onCollect(true);
        setRateSheet(true);
        return;
      }
      feedback.show({
        message: domainErrorMessage(err) ?? ar.installments.details.collectFailed,
        durationMs: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  const saveRate = async () => {
    if (state.kind !== 'ready' || !d(rateValue).gt(0)) {
      feedback.show({ message: ar.cash.voucher.rateInvalid });
      return;
    }
    try {
      const db = await getDb();
      await upsertDailyRate(db, state.plan.currencyId, today, rateValue);
      setRateSheet(false);
      feedback.show({ message: ar.cash.voucher.rateSaved });
      rateRetry.current?.();
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.cash.voucher.rateInvalid, durationMs: 8000 });
    }
  };

  /* ============ تذكير واتساب (FR-05-03) ============ */

  const onWhatsapp = (inst: InstallmentScheduleRow) => {
    if (state.kind !== 'ready') return;
    const plan = state.plan;
    const raw = plan.customerWhatsapp ?? plan.customerPhone;
    const phone = raw !== null ? waNumber(raw) : null;
    if (!phone) {
      feedback.show({ message: ar.installments.details.noWhatsapp, durationMs: 7000 });
      return;
    }
    const dec = plan.currencyDecimals;
    const symbol = currencySymbol(plan.currencyCode);
    const money = (v: string) => `${formatAmount(v, dec)}${symbol ? ` ${symbol}` : ''}`;
    const remaining = d(inst.amount).minus(d(inst.paidAmount)).toFixed(4);
    const lines = [
      `${ar.installments.whatsapp.messageHead} — ${plan.customerName ?? ''}`,
      '',
      `${ar.installments.whatsapp.installmentNo} ${inst.seq} ${ar.installments.whatsapp.of} ${plan.totalCount}`,
      `${ar.installments.whatsapp.amountDue}: ${money(remaining)}`,
      `${ar.installments.whatsapp.dueOn}: ${formatDateAr(inst.dueDate)}`,
      `${ar.installments.whatsapp.planRemaining}: ${money(plan.remaining)}`,
      '',
      ar.installments.whatsapp.footer,
    ];
    void Linking.openURL(waLink(phone, lines.join('\n')));
  };

  /* ============ إعادة جدولة (FR-05-04) ============ */

  const openReschedSheet = (inst: InstallmentScheduleRow) => {
    setReschedTarget(inst);
    setNewDueDate(inst.dueDate);
    setReason('');
    setReschedSheet(true);
  };

  const onReschedule = async () => {
    if (reschedTarget === null) return;
    if (!DATE_RE.test(newDueDate)) {
      feedback.show({ message: ar.installments.new.needFirstDue, durationMs: 6000 });
      return;
    }
    setBusy(true);
    try {
      const db = await getDb();
      await rescheduleInstallment(
        db,
        {
          installmentId: reschedTarget.id,
          newDueDate,
          reason: reason.trim() !== '' ? reason.trim() : undefined,
        },
        { createdBy: userId },
      );
      setReschedSheet(false);
      feedback.show({ message: ar.installments.details.rescheduleDone, durationMs: 6000 });
      await load();
    } catch (err) {
      feedback.show({
        message: domainErrorMessage(err) ?? ar.installments.details.rescheduleFailed,
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
        <ScreenHeader title={ar.installments.details.title} onBack={() => router.back()} />
        <AppCard noPadding>
          <LoadingState variant="card" />
        </AppCard>
      </SafeScreen>
    );
  }
  if (state.kind === 'notfound') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.installments.details.title} onBack={() => router.back()} />
        <AppCard noPadding>
          <ErrorState message={ar.installments.details.notFound} onRetry={() => router.back()} />
        </AppCard>
      </SafeScreen>
    );
  }
  if (state.kind === 'error') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.installments.details.title} onBack={() => router.back()} />
        <AppCard noPadding>
          <ErrorState
            message={ar.installments.details.errorLoad}
            technical={state.technical}
            onRetry={() => void load()}
          />
        </AppCard>
      </SafeScreen>
    );
  }

  const plan = state.plan;
  const dec = plan.currencyDecimals;
  const symbol = currencySymbol(plan.currencyCode);
  const money = (v: string) => `${formatAmount(v, dec)}${symbol ? ` ${symbol}` : ''}`;
  const completed = plan.status === 'completed';
  const progress = plan.totalCount > 0 ? plan.paidCount / plan.totalCount : 0;
  const selectedBox = boxes.find((b) => b.id === cashboxId) ?? null;
  const collectRemaining =
    collectTarget !== null
      ? d(collectTarget.amount).minus(d(collectTarget.paidAmount)).toFixed(4)
      : '0.0000';

  return (
    <SafeScreen offline={false}>
      <ScreenHeader
        title={ar.installments.details.title}
        subtitle={plan.invoiceNo ?? undefined}
        onBack={() => router.back()}
      />

      {/* ——— شريط الاكتمال (قراءة فقط) ——— */}
      {completed ? (
        <AppCard noPadding style={styles.completedBanner}>
          <View style={styles.completedRow}>
            <CheckCircle2 size={20} color={colors.success} />
            <Text style={styles.completedText}>{ar.installments.details.completedBanner}</Text>
          </View>
        </AppCard>
      ) : null}

      {/* ——— بطاقة المعلومات ——— */}
      <AppCard noPadding>
        <View style={styles.infoPad}>
          {/* التقدّم */}
          <View style={styles.progressWrap}>
            <View style={styles.progressTopRow}>
              <Text style={styles.progressTitle}>
                {plan.cycle === 'weekly'
                  ? ar.installments.details.cycleWeekly
                  : ar.installments.details.cycleMonthly}
              </Text>
              <Text style={styles.progressText}>
                {`${plan.paidCount}/${plan.totalCount} ${ar.installments.details.progressOf}`}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { flex: Math.max(progress, 0.01) }]} />
            </View>
          </View>

          {/* العميل → ملفه */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${ar.installments.details.customer}: ${plan.customerName ?? '—'}`}
            onPress={() =>
              router.push({
                pathname: '/parties/party-file',
                params: { kind: 'customer', id: String(plan.customerId) },
              })
            }
            style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
            testID="plan-customer-link"
          >
            <Text style={styles.infoLabel}>{ar.installments.details.customer}</Text>
            <View style={styles.linkTrailing}>
              <Text style={styles.linkValue}>{plan.customerName ?? '—'}</Text>
              <ChevronLeft size={16} color={colors.textFaint} />
            </View>
          </Pressable>

          {/* الفاتورة → تفاصيلها (عائلة بيع) */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${ar.installments.details.invoice}: ${plan.invoiceNo ?? '—'}`}
            onPress={() => router.push(`/sales/${plan.invoiceId}`)}
            style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
            testID="plan-invoice-link"
          >
            <Text style={styles.infoLabel}>{ar.installments.details.invoice}</Text>
            <View style={styles.linkTrailing}>
              <View style={styles.linkTexts}>
                <Text style={styles.linkValue}>{plan.invoiceNo ?? '—'}</Text>
                {plan.invoiceRemaining !== null ? (
                  <Text style={styles.linkSub}>
                    {`${ar.installments.details.invoiceRemaining}: ${money(plan.invoiceRemaining)}`}
                  </Text>
                ) : null}
              </View>
              <ReceiptText size={18} color={colors.teal} />
            </View>
          </Pressable>

          {/* الأرقام */}
          <View style={styles.amountsGrid}>
            <View style={styles.amountCell}>
              <Text style={styles.infoLabel}>{ar.installments.details.principal}</Text>
              <AmountText value={plan.principal} tone="neutral" currency={plan.currencyCode} decimals={dec} size="sm" />
            </View>
            <View style={styles.amountCell}>
              <Text style={styles.infoLabel}>{ar.installments.details.downPayment}</Text>
              <AmountText value={plan.downPayment} tone="neutral" currency={plan.currencyCode} decimals={dec} size="sm" />
            </View>
            <View style={styles.amountCell}>
              <Text style={styles.infoLabel}>{ar.installments.details.collected}</Text>
              <AmountText value={plan.totalPaid} tone="in" currency={plan.currencyCode} decimals={dec} size="sm" />
            </View>
            <View style={styles.amountCell}>
              <Text style={styles.infoLabel}>{ar.installments.details.remaining}</Text>
              <AmountText value={plan.remaining} tone="out" currency={plan.currencyCode} decimals={dec} size="sm" />
            </View>
          </View>

          {!completed ? (
            <Text style={styles.earlyNote}>{ar.installments.details.earlyNote}</Text>
          ) : null}
        </View>
      </AppCard>

      {/* ——— جدول الأقساط ——— */}
      <AppCard noPadding>
        <View style={styles.scheduleHead}>
          <Text style={[styles.scheduleHeadText, { flex: 0.7 }]}>{ar.installments.details.seq}</Text>
          <Text style={[styles.scheduleHeadText, { flex: 1.3 }]}>{ar.installments.details.dueDate}</Text>
          <Text style={[styles.scheduleHeadText, { flex: 1, textAlign: 'left' }]}>
            {ar.installments.details.amount}
          </Text>
        </View>
        {plan.schedule.map((inst) => {
          const late = isLate(inst, today) && inst.status !== 'paid';
          const lateDays = late ? daysLate(inst, today) : 0;
          const unpaid = inst.status !== 'paid';
          return (
            <View
              key={inst.id}
              style={[styles.instRow, late && styles.instRowLate, !unpaid && styles.instRowPaid]}
              testID={`installment-row-${inst.id}`}
            >
              <View style={styles.instLine}>
                <Text style={styles.instSeq}>{`${inst.seq}/${plan.totalCount}`}</Text>
                <View style={styles.instDateCell}>
                  <Text style={styles.instDate}>{formatDayShortAr(inst.dueDate)}</Text>
                  {late ? (
                    <View style={styles.lateChip}>
                      <Text style={styles.lateChipText}>
                        {`${formatCount(lateDays)} ${ar.installments.list.daysUnit}`}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <View style={styles.instAmountCell}>
                  <AmountText value={inst.amount} tone="neutral" currency={plan.currencyCode} decimals={dec} size="sm" />
                  {d(inst.paidAmount).gt(0) && inst.status !== 'paid' ? (
                    <Text style={styles.instPaidSub}>
                      {`${ar.installments.details.paid}: ${money(inst.paidAmount)}`}
                    </Text>
                  ) : null}
                </View>
                <InstallmentStatusBadge status={inst.status} late={late} />
              </View>

              {/* إجراءات القسط غير المسدد (FR-05-02/03/04) */}
              {unpaid && !completed ? (
                <View style={styles.instActions}>
                  <PrimaryButton
                    label={ar.installments.details.collect}
                    icon={Banknote}
                    tone="success"
                    compact
                    loading={busy && collectTarget?.id === inst.id}
                    onPress={() => void openCollectSheet(inst)}
                    style={styles.instActionBtn}
                    testID={`installment-collect-${inst.id}`}
                  />
                  <PrimaryButton
                    label={ar.installments.details.whatsapp}
                    icon={MessageCircle}
                    tone="ghost"
                    compact
                    onPress={() => onWhatsapp(inst)}
                    style={styles.instActionBtn}
                    testID={`installment-whatsapp-${inst.id}`}
                  />
                  <PrimaryButton
                    label={ar.installments.details.reschedule}
                    icon={CalendarOff}
                    tone="ghost"
                    compact
                    onPress={() => openReschedSheet(inst)}
                    style={styles.instActionBtn}
                    testID={`installment-reschedule-${inst.id}`}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
      </AppCard>

      {/* ============ الشيتات ============ */}

      {/* شيت التحصيل */}
      <BottomSheet
        visible={collectSheet}
        onClose={() => setCollectSheet(false)}
        title={ar.installments.details.collectTitle}
      >
        <Text style={styles.sheetHint}>{ar.installments.details.collectHint}</Text>
        {collectTarget !== null ? (
          <View style={styles.collectSummary}>
            <View style={styles.collectRow}>
              <Text style={styles.collectLabel}>{ar.installments.details.seq}</Text>
              <Text style={styles.collectValue}>{`${collectTarget.seq}/${plan.totalCount}`}</Text>
            </View>
            <View style={styles.collectRow}>
              <Text style={styles.collectLabel}>{ar.installments.details.collectRemaining}</Text>
              <AmountText
                value={collectRemaining}
                tone="out"
                currency={plan.currencyCode}
                decimals={dec}
              />
            </View>
          </View>
        ) : null}
        <MoneyField
          label={ar.installments.details.collectAmount}
          value={collectAmount}
          onChange={setCollectAmount}
          currencyCode={plan.currencyCode}
          decimals={dec}
          testID="collect-amount"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${ar.cash.voucher.cashbox}: ${selectedBox?.name ?? '—'}`}
          onPress={() => setBoxSheet(true)}
          style={({ pressed }) => [styles.pickerRow, pressed && styles.pickerRowPressed]}
          testID="collect-cashbox"
        >
          <Text style={styles.pickerLabel}>{ar.cash.voucher.cashbox}</Text>
          <View style={styles.linkTrailing}>
            <Text style={styles.pickerValue}>{selectedBox?.name ?? '—'}</Text>
            <ChevronLeft size={16} color={colors.textFaint} />
          </View>
        </Pressable>
        <PrimaryButton
          label={ar.installments.details.collectConfirm}
          tone="success"
          loading={busy}
          disabled={cashboxId === null || !d(collectAmount).gt(0)}
          onPress={() => void onCollect()}
          testID="collect-confirm"
        />
      </BottomSheet>

      {/* منتقي الصندوق */}
      <OptionPickerSheet
        visible={boxSheet}
        title={ar.cash.voucher.pickCashbox}
        options={boxes.map((b) => ({
          id: b.id,
          label: b.name,
          detail: `${formatAmount(b.balance, b.currencyDecimals)} ${currencySymbol(b.currencyCode)} · ${b.currencyCode}`,
        }))}
        selectedId={cashboxId}
        onSelect={(id) => id !== null && setCashboxId(id)}
        onClose={() => setBoxSheet(false)}
        testID="collect-box-picker"
      />

      {/* شيت إعادة الجدولة */}
      <BottomSheet
        visible={reschedSheet}
        onClose={() => setReschedSheet(false)}
        title={ar.installments.details.rescheduleTitle}
      >
        <Text style={styles.sheetHint}>{ar.installments.details.rescheduleHint}</Text>
        <Text
          style={styles.reschedOld}
        >{`${ar.installments.details.dueDate}: ${formatDayShortAr(reschedTarget?.dueDate ?? '')}`}</Text>
        <TextField
          label={ar.installments.details.rescheduleDate}
          value={newDueDate}
          onChangeText={setNewDueDate}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
          maxLength={10}
          hint={ar.installments.new.dateHint}
          testID="resched-date"
        />
        <TextField
          label={ar.installments.details.rescheduleReason}
          value={reason}
          onChangeText={setReason}
          placeholder={ar.installments.details.rescheduleReasonPh}
          testID="resched-reason"
        />
        <PrimaryButton
          label={ar.installments.details.rescheduleConfirm}
          icon={CalendarClock}
          loading={busy}
          disabled={!DATE_RE.test(newDueDate)}
          onPress={() => void onReschedule()}
          testID="resched-confirm"
        />
      </BottomSheet>

      {/* شيت سعر اليوم (عملة أجنبية — قرار 3) */}
      <BottomSheet visible={rateSheet} title={`${ar.cash.voucher.rateTitle} — ${plan.currencyCode}`}>
        <NumberPad
          value={rateValue}
          onChange={setRateValue}
          allowDecimal
          decimals={4}
          label={ar.cash.voucher.rateLabel}
        />
        <Text style={styles.rateHint}>{ar.cash.voucher.rateHint}</Text>
        <PrimaryButton label={ar.cash.voucher.rateSave} onPress={() => void saveRate()} testID="rate-save" />
      </BottomSheet>

      {feedback.host}
    </SafeScreen>
  );
}

/* ============ شريحة حالة القسط ============ */

function InstallmentStatusBadge({
  status,
  late,
}: {
  status: InstallmentScheduleRow['status'];
  late: boolean;
}) {
  if (status === 'paid') {
    return <TagChip label={ar.installments.details.statusPaid} color={colors.success} />;
  }
  if (late) {
    return <TagChip label={ar.installments.details.statusLate} color={colors.danger} />;
  }
  if (status === 'partial') {
    return <TagChip label={ar.installments.details.statusPartial} color={colors.warning} />;
  }
  return <TagChip label={ar.installments.details.statusUpcoming} color={colors.textMuted} />;
}

const styles = StyleSheet.create({
  completedBanner: {
    borderRightWidth: 3,
    borderRightColor: colors.success,
  },
  completedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  completedText: {
    flex: 1,
    color: colors.success,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  infoPad: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  progressWrap: {
    gap: 6,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  progressTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  progressTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  progressText: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  progressTrack: {
    height: 8,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  progressFill: {
    backgroundColor: colors.accent,
    borderRadius: radius.full,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 6,
  },
  linkRowPressed: {
    opacity: 0.75,
  },
  linkTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  linkTexts: {
    alignItems: 'flex-end',
    gap: 1,
    flexShrink: 1,
  },
  linkValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  linkSub: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 16,
  },
  infoLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  amountsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingTop: spacing.xs,
  },
  amountCell: {
    width: '48%',
    gap: 2,
  },
  earlyNote: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    marginTop: spacing.xs,
  },
  scheduleHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  scheduleHeadText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  instRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  instRowLate: {
    // DS-07: المتأخر بخلفية حمراء باهتة (FR-05-04)
    backgroundColor: 'rgba(248, 113, 113, 0.07)',
  },
  instRowPaid: {
    opacity: 0.78,
    // المسدَّد بمسحة خضراء خفيفة — يمسح بالعين أسرع من العتامة وحدها
    backgroundColor: 'rgba(52, 211, 153, 0.05)',
  },
  instLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  instSeq: {
    flex: 0.7,
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  instDateCell: {
    flex: 1.3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  instDate: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  lateChip: {
    borderRadius: radius.full,
    backgroundColor: 'rgba(248, 113, 113, 0.14)',
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  lateChipText: {
    color: colors.danger,
    fontFamily: font.medium,
    fontSize: 10,
    lineHeight: 15,
  },
  instAmountCell: {
    flex: 1,
    alignItems: 'flex-end',
    gap: 1,
  },
  instPaidSub: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 16,
  },
  instActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  instActionBtn: {
    flex: 1,
    minWidth: 120,
  },
  sheetHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  collectSummary: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(34, 211, 238, 0.05)',
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  collectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  collectLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  collectValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
    marginTop: spacing.xs,
  },
  pickerRowPressed: {
    opacity: 0.75,
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
  },
  reschedOld: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
    marginBottom: spacing.md,
  },
  rateHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
});
