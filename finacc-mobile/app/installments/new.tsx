/**
 * installments/new.tsx — خطة تقسيط جديدة (FR-05-01 — Task 14):
 *
 *  - منتقي العميل → فواتيره البيع **الآجلة** المفتوحة فقط (pay_status='credit'
 *    + مكتملة + متبقٍ حي = due_amount − Σ تخصيصات حية — نفس دلالات الدومين)
 *    مع معاينة المتبقي بعملة كل فاتورة.
 *  - عدد الأقساط (NumberPad صحيح) + دورية (شهري/أسبوعي مبدّل) + تاريخ أول
 *    قسط + الدفعة الأولى (MoneyField — 0 افتراضياً ≤ المتبقي؛ يظهر منتقي
 *    الصندوق عند > 0).
 *  - **معاينة جدول حية** (seq/التاريخ/المبلغ) تُعاد حسابها مع كل ضغطة —
 *    من نفس دوال الدومين النقية (computeSchedule/dueDateForSeq) فلا
 *    انفصام بين المعاينة والمحفوظ (قاعدة التقريب 5.4-9 أمام عين التاجر).
 *  - الحفظ عبر domain/createInstallmentPlan (Transaction ذرّية + audit) —
 *    الخطة ذاتها لا تمس الصندوق؛ الدفعة الأولى وحدها سند قبض مخصص
 *    للفاتورة. شيت نجاح: ملخص + «فتح الخطة».
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CalendarClock, ChevronLeft, Plus } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { getCashboxBalances, type CashboxBalance } from '@/db/queries';
import {
  computeSchedule,
  createInstallmentPlan,
  dueDateForSeq,
  type InstallmentCycle,
} from '@/domain/installments';
import { listCustomers, type PartyRow } from '@/domain/parties';
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** فاتورة آجلة مفتوحة (قراءة عرض — نفس اشتقاق متبقي الدومين) */
interface CreditInvoiceRow {
  id: number;
  invoiceNo: string | null;
  issuedAt: string;
  currencyId: number;
  currencyCode: string;
  currencyDecimals: number;
  total: string;
  remaining: string;
}

/** يمسح حقل خطأ واحد من الخريطة */
function withoutField(fields: FieldErrors, field: string): FieldErrors {
  const next: FieldErrors = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k !== field) next[k] = v;
  }
  return next;
}

export default function NewInstallmentPlanScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const userId = session.user?.id;
  const today = todayISO();

  /* ——— النموذج ——— */
  const [party, setParty] = useState<{ id: number; name: string } | null>(null);
  const [invoice, setInvoice] = useState<CreditInvoiceRow | null>(null);
  const [months, setMonths] = useState('3');
  const [cycle, setCycle] = useState<InstallmentCycle>('monthly');
  const [firstDue, setFirstDue] = useState(today);
  const [downPayment, setDownPayment] = useState('0');

  /* ——— المرجعيات ——— */
  const [invoices, setInvoices] = useState<CreditInvoiceRow[] | null>(null);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [boxes, setBoxes] = useState<CashboxBalance[]>([]);
  const [cashboxId, setCashboxId] = useState<number | null>(null);

  /* ——— الشيتات ——— */
  const [partySheet, setPartySheet] = useState(false);
  const [partySearch, setPartySearch] = useState('');
  const [parties, setParties] = useState<PartyRow[]>([]);
  const [invoiceSheet, setInvoiceSheet] = useState(false);
  const [monthsSheet, setMonthsSheet] = useState(false);
  const [boxSheet, setBoxSheet] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [savedPlanId, setSavedPlanId] = useState<number | null>(null);

  const partyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ============ بحث العملاء داخل الشيت ============ */

  useEffect(() => {
    if (!partySheet) return;
    if (partyTimer.current) clearTimeout(partyTimer.current);
    partyTimer.current = setTimeout(async () => {
      try {
        const db = await getDb();
        setParties(await listCustomers(db, { search: partySearch, limit: 50 }));
      } catch {
        setParties([]);
      }
    }, 180);
    return () => {
      if (partyTimer.current) clearTimeout(partyTimer.current);
    };
  }, [partySheet, partySearch]);

  /* ============ فواتير العميل الآجلة المفتوحة ============ */

  const reloadInvoices = useCallback(async (partyId: number) => {
    setInvoicesLoading(true);
    try {
      const db = await getDb();
      // آجلة حصراً (pay_status='credit') + مكتملة + المتبقي المشتق نفسه
      const rows = await db.all<{
        id: number;
        invoice_no: string | null;
        issued_at: string;
        currency_id: number;
        currency_code: string;
        currency_decimals: number;
        total: string;
        due_amount: string;
        allocated: string | number | null;
      }>(
        `SELECT i.id, i.invoice_no, i.issued_at, i.currency_id,
                cur.code AS currency_code, cur.decimals AS currency_decimals,
                i.total, i.due_amount,
                (SELECT SUM(pa.allocated_amount) FROM payment_allocation pa
                 JOIN cash_tx ct ON ct.id = pa.cash_tx_id
                 WHERE pa.invoice_id = i.id AND ct.is_voided = 0
                   AND ct.reversal_of IS NULL AND ct.tx_type = 'receipt') AS allocated
         FROM invoice i
         JOIN currency cur ON cur.id = i.currency_id
         WHERE i.doc_type = 'sale' AND i.status = 'completed'
           AND i.pay_status = 'credit' AND i.customer_id = ?
         ORDER BY i.issued_at ASC, i.id ASC`,
        [partyId],
      );
      setInvoices(
        rows
          .map((r) => ({
            id: Number(r.id),
            invoiceNo: r.invoice_no,
            issuedAt: r.issued_at,
            currencyId: Number(r.currency_id),
            currencyCode: r.currency_code,
            currencyDecimals: Number(r.currency_decimals ?? 2),
            total: r.total,
            remaining: d(r.due_amount).minus(d(r.allocated ?? 0)).toFixed(4),
          }))
          .filter((r) => d(r.remaining).gt(0)),
      );
    } catch {
      setInvoices([]);
    } finally {
      setInvoicesLoading(false);
    }
  }, []);

  const onPickParty = (p: { id: number; name: string }) => {
    setParty(p);
    setInvoice(null);
    setFieldErrors((f) => withoutField(f, 'party'));
    setPartySheet(false);
    void reloadInvoices(p.id);
  };

  /* ============ الصناديق (تظهر عند دفعة أولى > 0) ============ */

  const loadBoxes = useCallback(async () => {
    try {
      const db = await getDb();
      const balances = await getCashboxBalances(db);
      setBoxes(balances);
      setCashboxId((prev) => prev ?? (balances.find((b) => b.isDefault)?.id ?? balances[0]?.id ?? null));
    } catch {
      // تبقى القائمة كما كانت — المنتقي يعيد المحاولة
    }
  }, []);

  useEffect(() => {
    if (d(downPayment).gt(0) && boxes.length === 0) {
      void loadBoxes();
    }
  }, [downPayment, boxes.length, loadBoxes]);

  /* ============ معاينة الجدول الحية (دوال الدومين نفسها) ============ */

  const remaining = invoice !== null ? d(invoice.remaining) : d(0);
  const down = d(downPayment);
  const monthsCount = Number(months);
  const preview = (() => {
    if (
      invoice === null ||
      !Number.isInteger(monthsCount) ||
      monthsCount < 1 ||
      !DATE_RE.test(firstDue) ||
      down.gt(remaining)
    ) {
      return null;
    }
    const principal = remaining.minus(down);
    if (principal.lte(0)) return null;
    try {
      const schedule = computeSchedule(principal, monthsCount, invoice.currencyDecimals);
      return schedule.map((s) => ({
        seq: s.seq,
        dueDate: dueDateForSeq(firstDue, cycle, s.seq),
        amount: s.amount.toFixed(4),
      }));
    } catch {
      return null; // أقساط كثيرة على المبلغ — يُحرس عند الحفظ
    }
  })();
  const selectedBox = boxes.find((b) => b.id === cashboxId) ?? null;

  /* ============ الحفظ (createInstallmentPlan — ذرّية + audit) ============ */

  const doSave = async () => {
    const errors: FieldErrors = {};
    if (party === null) errors.party = ar.installments.new.noParty;
    if (invoice === null) errors.invoice = ar.installments.new.needInvoice;
    if (!Number.isInteger(monthsCount) || monthsCount < 1) errors.months = ar.installments.new.needMonths;
    if (!DATE_RE.test(firstDue)) errors.firstDue = ar.installments.new.needFirstDue;
    if (down.gt(remaining)) errors.downPayment = ar.installments.new.downPaymentHint;
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.party) setPartySheet(true);
      return;
    }
    if (down.gt(0) && cashboxId === null) {
      feedback.show({ message: ar.installments.new.needCashbox, durationMs: 6000 });
      setBoxSheet(true);
      return;
    }
    setSaving(true);
    setFieldErrors({});
    try {
      const db = await getDb();
      const result = await createInstallmentPlan(
        db,
        {
          invoiceId: invoice!.id,
          months: monthsCount,
          cycle,
          firstDue,
          downPayment,
          cashboxId: down.gt(0) ? cashboxId ?? undefined : undefined,
        },
        { createdBy: userId },
      );
      setSavedPlanId(result.planId);
      feedback.show({ message: ar.installments.new.saved, durationMs: 5000 });
      void reloadInvoices(party!.id);
    } catch (err) {
      feedback.show({
        message: domainErrorMessage(err) ?? technicalText(err) ?? ar.installments.new.failed,
        durationMs: 8000,
      });
    } finally {
      setSaving(false);
    }
  };

  /* ============ حرس الجلسة ============ */

  if (!session.ready || session.locked || !session.defaults) {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.installments.new.title} onBack={() => router.back()} />
        <AppCard noPadding>
          <LoadingState variant="list" rows={3} />
        </AppCard>
      </SafeScreen>
    );
  }

  const partyError = fieldErrors.party ?? null;
  const dec = invoice?.currencyDecimals ?? 2;
  const ccyCode = invoice?.currencyCode ?? '';

  return (
    <SafeScreen scroll={false} padded={false} avoidKeyboard offline>
      <View style={styles.screen}>
        <ScreenHeader
          title={ar.installments.new.title}
          subtitle={ar.installments.new.subtitle}
          onBack={() => router.back()}
        />

        <View style={styles.body}>
          {/* ——— العميل + الفاتورة الآجلة ——— */}
          <AppCard style={styles.metaCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${ar.installments.new.party}: ${party?.name ?? '—'}`}
              onPress={() => setPartySheet(true)}
              style={({ pressed }) => [styles.metaRow, pressed && styles.metaRowPressed]}
              testID="plan-party-field"
            >
              <View style={styles.metaTexts}>
                <Text style={styles.metaLabel}>{ar.installments.new.party}</Text>
                <Text style={[styles.metaValue, partyError && styles.metaValueError]} numberOfLines={1}>
                  {party ? party.name : '—'}
                </Text>
              </View>
              <Text style={styles.metaChevron}>›</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${ar.installments.new.creditInvoices}: ${invoice?.invoiceNo ?? '—'}`}
              onPress={() => {
                if (party === null) {
                  setPartySheet(true);
                  return;
                }
                setInvoiceSheet(true);
              }}
              style={({ pressed }) => [styles.metaRow, pressed && styles.metaRowPressed]}
              testID="plan-invoice-field"
            >
              <View style={styles.metaTexts}>
                <Text style={styles.metaLabel}>{ar.installments.new.creditInvoices}</Text>
                <Text
                  style={[styles.metaValue, fieldErrors.invoice && styles.metaValueError]}
                  numberOfLines={1}
                >
                  {invoice !== null
                    ? `${invoice.invoiceNo ?? '—'} · ${formatAmount(invoice.remaining, dec)}${currencySymbol(ccyCode) ? ` ${currencySymbol(ccyCode)}` : ''}`
                    : '—'}
                </Text>
              </View>
              <Text style={styles.metaChevron}>›</Text>
            </Pressable>
          </AppCard>

          {/* ——— تفاصيل الخطة ——— */}
          <AppCard style={styles.formCard}>
            {/* عدد الأقساط */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${ar.installments.new.months}: ${months}`}
              onPress={() => setMonthsSheet(true)}
              style={({ pressed }) => [styles.monthsRow, pressed && styles.metaRowPressed]}
              testID="plan-months-field"
            >
              <View style={styles.metaTexts}>
                <Text style={styles.metaLabel}>{ar.installments.new.months}</Text>
                <Text style={[styles.monthsValue, fieldErrors.months && styles.metaValueError]}>
                  {months}
                </Text>
                <Text style={styles.monthsHint}>{ar.installments.new.monthsHint}</Text>
              </View>
              <Text style={styles.metaChevron}>›</Text>
            </Pressable>

            {/* دورية السداد */}
            <View>
              <Text style={styles.cycleLabel}>{ar.installments.new.cycleHint}</Text>
              <View style={styles.cycleSeg}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={ar.installments.new.cycleMonthly}
                  accessibilityState={{ selected: cycle === 'monthly' }}
                  onPress={() => setCycle('monthly')}
                  style={[styles.cycleBtn, cycle === 'monthly' && styles.cycleBtnActive]}
                  testID="plan-cycle-monthly"
                >
                  <Text style={[styles.cycleText, cycle === 'monthly' && styles.cycleTextActive]}>
                    {ar.installments.new.cycleMonthly}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={ar.installments.new.cycleWeekly}
                  accessibilityState={{ selected: cycle === 'weekly' }}
                  onPress={() => setCycle('weekly')}
                  style={[styles.cycleBtn, cycle === 'weekly' && styles.cycleBtnActive]}
                  testID="plan-cycle-weekly"
                >
                  <Text style={[styles.cycleText, cycle === 'weekly' && styles.cycleTextActive]}>
                    {ar.installments.new.cycleWeekly}
                  </Text>
                </Pressable>
              </View>
            </View>

            <TextField
              label={ar.installments.new.firstDue}
              value={firstDue}
              onChangeText={(v) => {
                setFirstDue(v);
                setFieldErrors((f) => withoutField(f, 'firstDue'));
              }}
              placeholder="YYYY-MM-DD"
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              hint={ar.installments.new.dateHint}
              error={fieldErrors.firstDue ?? null}
              testID="plan-first-due"
            />

            <MoneyField
              label={ar.installments.new.downPayment}
              value={downPayment}
              onChange={(v) => {
                setDownPayment(v);
                setFieldErrors((f) => withoutField(f, 'downPayment'));
              }}
              currencyCode={ccyCode || undefined}
              decimals={dec}
              hint={ar.installments.new.downPaymentHint}
              error={fieldErrors.downPayment ?? null}
              testID="plan-down-payment"
            />

            {/* صندوق الدفعة الأولى — يظهر عند > 0 حصراً */}
            {down.gt(0) ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${ar.cash.voucher.cashbox}: ${selectedBox?.name ?? '—'}`}
                onPress={() => setBoxSheet(true)}
                style={({ pressed }) => [styles.metaRow, pressed && styles.metaRowPressed]}
                testID="plan-cashbox-field"
              >
                <View style={styles.metaTexts}>
                  <Text style={styles.metaLabel}>{ar.cash.voucher.cashbox}</Text>
                  <Text style={styles.metaValue} numberOfLines={1}>
                    {selectedBox !== null
                      ? `${selectedBox.name} · ${formatAmount(selectedBox.balance, selectedBox.currencyDecimals)} ${currencySymbol(selectedBox.currencyCode)}`
                      : '—'}
                  </Text>
                </View>
                <ChevronLeft size={16} color={colors.textFaint} />
              </Pressable>
            ) : null}
          </AppCard>

          {/* ——— معاينة الجدول الحية ——— */}
          {preview !== null && invoice !== null ? (
            <AppCard noPadding style={styles.previewCard}>
              <View style={styles.previewHead}>
                <Text style={styles.previewTitle}>{ar.installments.new.scheduleTitle}</Text>
                <AmountText
                  value={remaining.minus(down).toFixed(4)}
                  tone="neutral"
                  currency={invoice.currencyCode}
                  decimals={dec}
                  size="sm"
                />
              </View>
              {preview.map((row) => (
                <View key={row.seq} style={styles.previewRow}>
                  <Text style={styles.previewSeq}>{`${ar.installments.new.scheduleSeq} ${row.seq}`}</Text>
                  <Text style={styles.previewDate}>{formatDayShortAr(row.dueDate)}</Text>
                  <Text style={styles.previewAmount}>
                    {`${formatAmount(row.amount, dec)}${currencySymbol(invoice.currencyCode) ? ` ${currencySymbol(invoice.currencyCode)}` : ''}`}
                  </Text>
                </View>
              ))}
            </AppCard>
          ) : invoice !== null ? (
            <View style={styles.previewHintBox}>
              <Text style={styles.previewHintText}>{ar.installments.new.monthsHint}</Text>
            </View>
          ) : null}
        </View>

        {/* ——— زر الحفظ ——— */}
        <View style={styles.bottomBar}>
          <PrimaryButton
            label={ar.installments.new.save}
            icon={CalendarClock}
            loading={saving}
            onPress={() => void doSave()}
            testID="plan-save-btn"
          />
        </View>
      </View>

      {/* ============ الشيتات ============ */}

      {/* منتقي العميل */}
      <BottomSheet
        visible={partySheet}
        onClose={() => setPartySheet(false)}
        title={ar.installments.new.pickParty}
      >
        <SearchBar
          value={partySearch}
          onChangeText={setPartySearch}
          placeholder={ar.installments.new.searchParty}
          testID="plan-party-search"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ar.installments.new.addParty}
          onPress={() => {
            setPartySheet(false);
            router.push('/parties/party-edit?kind=customer');
          }}
          style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
          testID="plan-party-add-new"
        >
          <Plus size={18} color={colors.accent} />
          <Text style={styles.partyAddText}>{ar.installments.new.addParty}</Text>
        </Pressable>
        {parties.map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            accessibilityLabel={p.name}
            onPress={() => onPickParty({ id: p.id, name: p.name })}
            style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
            testID={`plan-party-row-${p.id}`}
          >
            <View style={styles.partyTexts}>
              <Text style={styles.partyRowTitle}>{p.name}</Text>
              {p.phone ? <Text style={styles.partyRowSub}>{p.phone}</Text> : null}
            </View>
            {party?.id === p.id ? <Text style={styles.optionCheck}>✓</Text> : null}
          </Pressable>
        ))}
      </BottomSheet>

      {/* منتقي الفاتورة الآجلة */}
      <BottomSheet
        visible={invoiceSheet}
        onClose={() => setInvoiceSheet(false)}
        title={ar.installments.new.creditInvoices}
      >
        {invoicesLoading ? (
          <LoadingState variant="list" rows={2} />
        ) : (invoices ?? []).length === 0 ? (
          <View style={styles.noInvoicesBox}>
            <Text style={styles.noInvoicesTitle}>{ar.installments.new.noPartyInvoices}</Text>
            <Text style={styles.noInvoicesHint}>{ar.installments.new.noPartyInvoicesHint}</Text>
          </View>
        ) : (
          (invoices ?? []).map((inv) => {
            const selected = invoice?.id === inv.id;
            return (
              <Pressable
                key={inv.id}
                accessibilityRole="button"
                accessibilityLabel={inv.invoiceNo ?? '—'}
                accessibilityState={{ selected }}
                onPress={() => {
                  setInvoice(inv);
                  setFieldErrors((f) => withoutField(f, 'invoice'));
                  setInvoiceSheet(false);
                }}
                style={({ pressed }) => [
                  styles.partyRow,
                  selected && styles.invoiceRowSelected,
                  pressed && styles.partyRowPressed,
                ]}
                testID={`plan-invoice-row-${inv.id}`}
              >
                <View style={styles.partyTexts}>
                  <View style={styles.invoiceNoRow}>
                    <Text style={styles.partyRowTitle}>{inv.invoiceNo ?? '—'}</Text>
                    <View style={styles.creditChip}>
                      <Text style={styles.creditChipText}>{ar.installments.new.invoiceChip}</Text>
                    </View>
                  </View>
                  <Text style={styles.partyRowSub}>
                    {`${formatDayShortAr(inv.issuedAt)} · ${ar.cash.voucher.invoiceRemaining}: ${formatAmount(inv.remaining, inv.currencyDecimals)} ${currencySymbol(inv.currencyCode)}`}
                  </Text>
                </View>
                {selected ? <Text style={styles.optionCheck}>✓</Text> : null}
              </Pressable>
            );
          })
        )}
      </BottomSheet>

      {/* عدد الأقساط — NumberPad صحيح */}
      <BottomSheet
        visible={monthsSheet}
        onClose={() => setMonthsSheet(false)}
        title={ar.installments.new.months}
      >
        <NumberPad
          value={months}
          onChange={(v) => {
            setMonths(v);
            setFieldErrors((f) => withoutField(f, 'months'));
          }}
          onDone={() => setMonthsSheet(false)}
          allowDecimal={false}
          decimals={0}
          label={ar.installments.new.monthsHint}
        />
      </BottomSheet>

      {/* منتقي صندوق الدفعة الأولى */}
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
        testID="plan-cashbox-picker"
      />

      {/* شيت النجاح: ملخص + فتح الخطة */}
      <BottomSheet visible={savedPlanId !== null} title={ar.installments.new.successTitle}>
        {savedPlanId !== null && invoice !== null ? (
          <View style={styles.successWrap}>
            <View style={styles.successCard}>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>{ar.installments.details.customer}</Text>
                <Text style={styles.successValue}>{party?.name ?? '—'}</Text>
              </View>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>{ar.installments.details.invoice}</Text>
                <Text style={styles.successValue}>{invoice.invoiceNo ?? '—'}</Text>
              </View>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>{ar.installments.details.principal}</Text>
                <AmountText
                  value={remaining.minus(down).toFixed(4)}
                  tone="neutral"
                  currency={invoice.currencyCode}
                  decimals={dec}
                />
              </View>
              <Text style={styles.successHint}>{ar.installments.new.successHint}</Text>
            </View>
            <View style={styles.successActions}>
              <PrimaryButton
                label={ar.installments.new.successDetails}
                tone="primary"
                onPress={() => {
                  const id = savedPlanId;
                  setSavedPlanId(null);
                  router.replace(`/installments/${id}`);
                }}
                style={styles.successBtn}
                testID="plan-success-details"
              />
              <PrimaryButton
                label={ar.installments.new.successAnother}
                tone="ghost"
                onPress={() => {
                  setSavedPlanId(null);
                  setInvoice(null);
                  setDownPayment('0');
                }}
                style={styles.successBtn}
                testID="plan-success-another"
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
  monthsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  monthsValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 20,
    lineHeight: 28,
  },
  monthsHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  cycleLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: spacing.xs,
  },
  cycleSeg: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  cycleBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  cycleBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  cycleText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  cycleTextActive: {
    color: colors.onAccent,
    fontFamily: font.bold,
  },
  previewCard: {
    marginBottom: spacing.xs,
  },
  previewHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  previewTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    minHeight: 44,
  },
  previewSeq: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  previewDate: {
    flex: 1,
    textAlign: 'center',
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  previewAmount: {
    flex: 1,
    textAlign: 'left',
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  previewHintBox: {
    paddingHorizontal: spacing.lg,
  },
  previewHintText: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
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
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  partyAddText: {
    color: colors.accent,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  optionCheck: {
    color: colors.accent,
    fontSize: 16,
    fontFamily: font.bold,
  },
  invoiceNoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  invoiceRowSelected: {
    backgroundColor: 'rgba(34, 211, 238, 0.10)',
    borderRadius: radius.md,
  },
  creditChip: {
    borderRadius: radius.full,
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  creditChipText: {
    color: colors.warning,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  noInvoicesBox: {
    paddingVertical: spacing.md,
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
  bottomBar: {
    padding: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  successWrap: {
    gap: spacing.md,
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
    alignItems: 'center',
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
