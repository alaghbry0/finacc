/**
 * more/reports.tsx — شاشة التقارير ⭐ (Task 13 — FR-09).
 *
 * المسار: /more/reports (من قائمة «المزيد» — LDR-2: التقارير هنا).
 *
 *  - **الفترات الدورية الجاهزة (FR-09-09)**: اليوم/هذا الأسبوع (سبت يمني)/
 *    هذا الشهر/هذا الربع/هذا العام/مخصص — أرقاقة تحل الفترة عبر
 *    resolveReportPeriod؛ «مخصص» يظهر حقلَي من/إلى بصيغة YYYY-MM-DD.
 *  - **بطاقة الأرباح والخسائر (FR-09-02)**: بنود مجمعّة بإشارات +/− (علامات
 *    غير لونية DS-18 — AmountText) ومجاميع فرعية بحد علوي — الإيرادات
 *    (المبيعات/المرتجع/الصافي) ← التكلفة (COGS/تكلفة المرتجع/الصافي) ←
 *    تسويات الجرد ← المصاريف ← فروق الصرف ± ← **الربح** مُبرزاً — ثم
 *    **مسحوبات المالك بمقطع كهرماني مستقل خارج المصاريف** — ثم
 *    **«صافي ما بقي للمالك»** بصندوق كبير بتسميته الصادقة. كل الأرقام
 *    بعملة الأساس (قرار 3) من الدومين المشتق حصراً من خريطة الترحيل.
 *  - **بطاقة الشيكات (FR-09-13)**: تحت التحصيل (الواردة) وتحت السحب
 *    (الصادرة) — عدد وقيمة لكل عملة + أقرب الاستحقاقات قائمة مختصرة.
 *  - **بطاقة الأرصدة الدائنة (FR-09-14)**: عملاء لهم رصيد لصالحهم —
 *    الاسم والهاتف (نقرة تفتح ملف الطرف) والمبلغ بعملته.
 *  - **قسم تقارير المخزون والمبيعات (Task 17)**: بطاقة صنف (FR-09-03) /
 *    حركة المخزون الكلي (FR-09-04) / المبيعات حسب العميل-الفئة-الصنف-اليوم
 *    بنسب التغير (FR-09-06) / تحت الحد الأدنى (FR-09-12) — شاشات مستقلة
 *    بفتراتها وفلاترها، وهذا مدخلها الموحد.
 *  - **الإجراءات (FR-09-10)**: «طباعة التقرير» (printPnl → معاينة الويب/
 *    نظام أصلي — ورقة 420px بتذييل خريطة الترحيل) + «مشاركة واتساب»
 *    (ملخص نصي — من واتساب المنشأة أو رابط wa.me عام بلا رقم).
 *  - الحالات: Skeleton إلزامي للتقارير (§6.5) / ErrorState بإعادة محاولة /
 *    فراغ صادق لكل بطاقة + إعادة تحديث عند العودة (useFocusEffect).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ArrowLeftRight,
  ChevronLeft,
  Coins,
  Landmark,
  MessageCircle,
  Package,
  Printer,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import { listActiveCurrencies, type CurrencyLite } from '@/db/queries';
import {
  getChequesReport,
  getCustomerCreditBalances,
  getProfitAndLoss,
  resolveReportPeriod,
  type ChequeReportRow,
  type ChequesReport,
  type CustomerCreditBalanceRow,
  type PnlReport,
  type ReportPeriodPreset,
} from '@/domain/reports';
import { printPnl } from '@/services/print';
import { loadPnlPrintData } from '@/services/report-data';
import { buildPnlWhatsAppMessage } from '@/services/report-share';
import { statementShortDate } from '@/services/statement-html';
import { waLink, waNumber } from '@/services/share-text';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { formatAmount, todayISO } from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import AmountText from '@/components/ui/AmountText';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import ListRow from '@/components/ui/ListRow';
import LoadingState from '@/components/ui/LoadingState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

/* ============ الفترات (chips) ============ */

const PERIOD_PRESETS: readonly [ReportPeriodPreset, string][] = [
  ['today', ar.reports.periods.today],
  ['week', ar.reports.periods.week],
  ['month', ar.reports.periods.month],
  ['quarter', ar.reports.periods.quarter],
  ['year', ar.reports.periods.year],
  ['custom', ar.reports.periods.custom],
];

/* ============ الشاشة ============ */

export default function ReportsScreen() {
  const router = useRouter();
  const feedback = useFeedback();

  const [preset, setPreset] = useState<ReportPeriodPreset>('month');
  const [customFrom, setCustomFrom] = useState(todayISO());
  const [customTo, setCustomTo] = useState(todayISO());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [pnl, setPnl] = useState<PnlReport | null>(null);
  const [cheques, setCheques] = useState<ChequesReport | null>(null);
  const [credits, setCredits] = useState<CustomerCreditBalanceRow[] | null>(null);
  const [companyWhatsapp, setCompanyWhatsapp] = useState<string | null>(null);
  const [base, setBase] = useState<CurrencyLite | null>(null);

  const [printing, setPrinting] = useState(false);
  const [sharing, setSharing] = useState(false);

  const firstFocus = useRef(true);

  /* ============ الفترة المحلولة (دوماً صالحة عند العرض) ============ */

  const customInvalid =
    preset === 'custom' &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(customFrom) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(customTo) ||
      customFrom > customTo);

  const range = useMemo(() => {
    if (preset === 'custom' && customInvalid) return null;
    try {
      return resolveReportPeriod(preset, {
        ...(preset === 'custom' ? { from: customFrom, to: customTo } : {}),
      });
    } catch {
      return null;
    }
  }, [preset, customFrom, customTo, customInvalid]);

  /* ============ التحميل (P&L + الشيكات + الأرصدة الدائنة + المنشأة) ============ */

  useEffect(() => {
    if (range === null) {
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      const db = await getDb();
      const [pnlData, chequesData, creditsData, companyRows, currencies] = await Promise.all([
        getProfitAndLoss(db, { from: range.from, to: range.to }),
        getChequesReport(db),
        getCustomerCreditBalances(db),
        db.all<{ whatsapp: string | null }>('SELECT whatsapp FROM company ORDER BY id LIMIT 1'),
        listActiveCurrencies(db),
      ]);
      if (!alive) return;
      setPnl(pnlData);
      setCheques(chequesData);
      setCredits(creditsData);
      setCompanyWhatsapp(companyRows[0]?.whatsapp ?? null);
      setBase(currencies.find((c) => c.isBase) ?? currencies[0] ?? null);
      setLoading(false);
    })().catch((err: unknown) => {
      if (!alive) return;
      setError(technicalText(err));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [range, reload]);

  /* إعادة تحديث عند العودة من شاشات البيع/النقدية/الشيكات */
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setReload((r) => r + 1);
    }, []),
  );

  /* ============ مشتقات العرض ============ */

  const decimals = base?.decimals ?? 2;
  const baseCode = base?.code ?? '';

  const allZero = useMemo(() => {
    if (pnl === null) return false;
    return (
      d(pnl.sales).isZero() &&
      d(pnl.salesReturns).isZero() &&
      d(pnl.cogs).isZero() &&
      d(pnl.stockSurplus).isZero() &&
      d(pnl.stockShortage).isZero() &&
      d(pnl.expenses).isZero() &&
      d(pnl.fxGainLoss).isZero()
    );
  }, [pnl]);

  /** إجمالا شيكات اتجاه واحد مجمّعان لكل عملة */
  const chequeGroups = useCallback(
    (rows: ChequeReportRow[]): { code: string; count: number; total: string }[] => {
      const map = new Map<string, { code: string; count: number; total: ReturnType<typeof d> }>();
      for (const r of rows) {
        const g = map.get(r.currencyCode) ?? { code: r.currencyCode, count: 0, total: d('0') };
        g.count += 1;
        g.total = g.total.plus(d(r.amount));
        map.set(r.currencyCode, g);
      }
      return [...map.values()].map((g) => ({
        code: g.code,
        count: g.count,
        total: g.total.toString(),
      }));
    },
    [],
  );

  const collectionGroups = useMemo(
    () => (cheques ? chequeGroups(cheques.underCollection) : []),
    [cheques, chequeGroups],
  );
  const withdrawalGroups = useMemo(
    () => (cheques ? chequeGroups(cheques.underWithdrawal) : []),
    [cheques, chequeGroups],
  );

  /* ============ الإجراءات: طباعة + واتساب ============ */

  const onPrint = async (): Promise<void> => {
    if (printing || range === null) return;
    setPrinting(true);
    try {
      const db = await getDb();
      const res = await printPnl(db, { from: range.from, to: range.to });
      feedback.show({ message: res.message });
    } catch (err: unknown) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.reports.printFailed });
    } finally {
      setPrinting(false);
    }
  };

  const onShare = async (): Promise<void> => {
    if (sharing || range === null) return;
    setSharing(true);
    try {
      const db = await getDb();
      const data = await loadPnlPrintData(db, { from: range.from, to: range.to });
      const message = buildPnlWhatsAppMessage(data);
      // من واتساب المنشأة إن ضُبط، وإلا رابط wa.me عام بلا رقم (اختيار جهة)
      const phone = companyWhatsapp ? waNumber(companyWhatsapp) : null;
      const url = phone
        ? waLink(phone, message)
        : `https://wa.me/?text=${encodeURIComponent(message)}`;
      await Linking.openURL(url);
      feedback.show({ message: ar.reports.shareSent });
    } catch (err: unknown) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.reports.shareFailed });
    } finally {
      setSharing(false);
    }
  };

  /* ============ العرض ============ */

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.more.reports}
        subtitle={ar.reports.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* ——— تقارير المخزون والمبيعات (Task 17 — FR-09-03/04/06/12) ——— */}
        <AppCard noPadding>
          <View style={styles.analyticsHead}>
            <Package size={15} color={colors.teal} />
            <Text style={styles.analyticsTitle}>{ar.analytics.sectionTitle}</Text>
          </View>
          <Text style={styles.analyticsHint}>{ar.analytics.sectionHint}</Text>
          <ListRow
            title={ar.analytics.navItemCard}
            subtitle={ar.analytics.navItemCardHint}
            divider
            onPress={() => router.push('/reports/item-card')}
            testID="reports-nav-item-card"
          />
          <ListRow
            title={ar.analytics.navStockMovement}
            subtitle={ar.analytics.navStockMovementHint}
            divider
            onPress={() => router.push('/reports/stock-movement')}
            testID="reports-nav-stock-movement"
          />
          <ListRow
            title={ar.analytics.navSalesBy}
            subtitle={ar.analytics.navSalesByHint}
            divider
            onPress={() => router.push('/reports/sales-by')}
            testID="reports-nav-sales-by"
          />
          <ListRow
            title={ar.analytics.navBelowMin}
            subtitle={ar.analytics.navBelowMinHint}
            onPress={() => router.push('/reports/below-min')}
            testID="reports-nav-below-min"
          />
        </AppCard>

        {/* ——— الفترات الجاهزة (FR-09-09) ——— */}
        <Text style={styles.sectionLabel}>{ar.reports.periodLabel}</Text>
        <View style={styles.chipsRow}>
          {PERIOD_PRESETS.map(([key, label]) => {
            const selected = preset === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => setPreset(key)}
                style={({ pressed }) => [
                  styles.periodChip,
                  selected && styles.periodChipActive,
                  pressed && styles.chipPressed,
                ]}
                testID={`reports-period-${key}`}
              >
                <Text style={[styles.periodText, selected && styles.periodTextActive]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {preset === 'week' ? (
          <Text style={styles.weekHint}>{ar.reports.weekStartHint}</Text>
        ) : null}

        {/* مخصص: حقلا من/إلى */}
        {preset === 'custom' ? (
          <View style={styles.customRow}>
            <View style={styles.customField}>
              <TextField
                label={ar.reports.customFrom}
                value={customFrom}
                onChangeText={setCustomFrom}
                placeholder={ar.reports.customDatePh}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
                hint={ar.reports.customDateHint}
                error={customInvalid ? ar.reports.customInvalid : null}
                testID="reports-custom-from"
              />
            </View>
            <View style={styles.customField}>
              <TextField
                label={ar.reports.customTo}
                value={customTo}
                onChangeText={setCustomTo}
                placeholder={ar.reports.customDatePh}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
                hint={ar.reports.customDateHint}
                error={customInvalid ? ar.reports.customInvalid : null}
                testID="reports-custom-to"
              />
            </View>
          </View>
        ) : null}

        {error !== null ? (
          <ErrorState
            message={ar.reports.errorLoad}
            technical={error}
            onRetry={() => setReload((r) => r + 1)}
          />
        ) : loading ? (
          <LoadingState variant="card" />
        ) : pnl !== null && cheques !== null && credits !== null ? (
          <View style={styles.stack}>
            {/* ——— بطاقة الأرباح والخسائر (FR-09-02) ——— */}
            <AppCard>
              <View style={styles.pnlHead}>
                <View style={styles.pnlHeadText}>
                  <TrendingUp size={15} color={colors.teal} />
                  <Text style={styles.pnlTitle}>{ar.reports.pnlTitle}</Text>
                </View>
                <Text style={styles.baseNote}>{ar.reports.baseCurrencyNote}</Text>
              </View>
              <Text style={styles.pnlHint}>{ar.reports.pnlHint}</Text>

              {allZero ? (
                <View style={styles.pnlEmpty}>
                  <EmptyState
                    title={ar.reports.pnlEmpty}
                    message={ar.reports.pnlEmptyHint}
                  />
                </View>
              ) : (
                <View style={styles.pnlBody}>
                  {/* الإيرادات */}
                  <PnlSection title={ar.reports.sections.revenues} icon={TrendingUp} tint={colors.success} />
                  <PnlLine label={ar.reports.lines.sales} value={pnl.sales} tone="in" decimals={decimals} currency={baseCode} />
                  <PnlLine label={ar.reports.lines.salesReturns} value={`-${pnl.salesReturns}`} tone="out" decimals={decimals} currency={baseCode} />
                  <PnlSubtotal label={ar.reports.lines.netSales} value={pnl.netSales} decimals={decimals} currency={baseCode} />

                  {/* التكلفة */}
                  <PnlSection title={ar.reports.sections.costs} icon={TrendingDown} tint={colors.teal} />
                  <PnlLine label={ar.reports.lines.cogs} value={pnl.cogs} tone="neutral" decimals={decimals} currency={baseCode} />
                  <PnlLine label={ar.reports.lines.returnsCost} value={`-${pnl.returnsCost}`} tone="out" decimals={decimals} currency={baseCode} />
                  <PnlSubtotal label={ar.reports.lines.netCogs} value={pnl.netCogs} decimals={decimals} currency={baseCode} />

                  {/* تسويات الجرد */}
                  <PnlSection title={ar.reports.sections.stock} icon={Package} tint={colors.accent} />
                  <PnlLine label={ar.reports.lines.stockSurplus} value={pnl.stockSurplus} tone="in" decimals={decimals} currency={baseCode} />
                  <PnlLine label={ar.reports.lines.stockShortage} value={`-${pnl.stockShortage}`} tone="out" decimals={decimals} currency={baseCode} />

                  {/* المصاريف */}
                  <PnlSection title={ar.reports.sections.expenses} icon={Coins} tint={colors.warning} />
                  <PnlLine label={ar.reports.lines.expenses} value={`-${pnl.expenses}`} tone="out" decimals={decimals} currency={baseCode} />

                  {/* فروق الصرف ± */}
                  <PnlSection title={ar.reports.sections.fx} icon={ArrowLeftRight} tint={colors.danger} />
                  <PnlLine
                    label={ar.reports.lines.fxGainLoss}
                    value={pnl.fxGainLoss}
                    tone={d(pnl.fxGainLoss).gt(0) ? 'in' : d(pnl.fxGainLoss).lt(0) ? 'out' : 'neutral'}
                    decimals={decimals}
                    currency={baseCode}
                  />

                  {/* = الربح (مُبرز) */}
                  <View style={styles.profitRow}>
                    <Text style={styles.profitLabel}>{ar.reports.lines.profit}</Text>
                    <AmountText
                      value={pnl.profit}
                      tone={d(pnl.profit).gt(0) ? 'in' : d(pnl.profit).lt(0) ? 'out' : 'neutral'}
                      size="xl"
                      currency={baseCode}
                      decimals={decimals}
                      testID="reports-profit"
                    />
                  </View>
                </View>
              )}
            </AppCard>

            {/* ——— مسحوبات المالك: مقطع كهرماني مستقل خارج المصاريف ——— */}
            <View style={styles.ownerBox}>
              <View style={styles.ownerHead}>
                <Wallet size={15} color={colors.warning} />
                <Text style={styles.ownerTitle}>{ar.reports.sections.owner}</Text>
              </View>
              <View style={styles.ownerRow}>
                <Text style={styles.ownerLabel}>{ar.reports.lines.ownerDraw}</Text>
                <AmountText
                  value={`-${pnl.ownerDraw}`}
                  tone="out"
                  size="md"
                  currency={baseCode}
                  decimals={decimals}
                  testID="reports-owner-draw"
                />
              </View>
              <Text style={styles.ownerNote}>{ar.reports.ownerSectionNote}</Text>
            </View>

            {/* ——— صافي ما بقي للمالك (الصندوق الختامي) ——— */}
            <View style={styles.finalBox}>
              <Text style={styles.finalTitle}>{ar.reports.lines.netRemaining}</Text>
              <AmountText
                value={pnl.netRemainingToOwner}
                tone={
                  d(pnl.netRemainingToOwner).gt(0)
                    ? 'in'
                    : d(pnl.netRemainingToOwner).lt(0)
                      ? 'out'
                      : 'neutral'
                }
                size="display"
                currency={baseCode}
                decimals={decimals}
                testID="reports-net-remaining"
              />
              <Text style={styles.finalNote}>{ar.reports.netRemainingNote}</Text>
            </View>

            {/* ——— بطاقة الشيكات (FR-09-13) ——— */}
            <AppCard noPadding>
              <View style={styles.chequesHead}>
                <Landmark size={15} color={colors.teal} />
                <Text style={styles.chequesTitle}>{ar.reports.chequesTitle}</Text>
              </View>
              {cheques.underCollection.length === 0 && cheques.underWithdrawal.length === 0 ? (
                <View style={styles.cardEmpty}>
                  <EmptyState title={ar.reports.chequesEmpty} message={ar.reports.chequesEmptyHint} />
                </View>
              ) : (
                <View style={styles.chequesBody}>
                  <ChequeSide
                    title={ar.reports.underCollection}
                    groups={collectionGroups}
                    rows={cheques.underCollection}
                  />
                  <View style={styles.chequesDivider} />
                  <ChequeSide
                    title={ar.reports.underWithdrawal}
                    groups={withdrawalGroups}
                    rows={cheques.underWithdrawal}
                  />
                </View>
              )}
            </AppCard>

            {/* ——— بطاقة الأرصدة الدائنة (FR-09-14) ——— */}
            <AppCard noPadding>
              <View style={styles.chequesHead}>
                <Users size={15} color={colors.accent} />
                <Text style={styles.chequesTitle}>{ar.reports.creditTitle}</Text>
              </View>
              {credits.length === 0 ? (
                <View style={styles.cardEmpty}>
                  <EmptyState title={ar.reports.creditEmpty} message={ar.reports.creditEmptyHint} />
                </View>
              ) : (
                credits.map((c) => (
                  <ListRow
                    key={`${c.customerId}-${c.currencyId}`}
                    title={c.name}
                    subtitle={c.phone ?? `${c.currencyCode} · ${ar.reports.creditUnit}`}
                    divider={false}
                    onPress={() =>
                      router.push({
                        pathname: '/parties/party-file',
                        params: { kind: 'customer', id: String(c.customerId) },
                      })
                    }
                    trailing={
                      <View style={styles.creditTrailing}>
                        <AmountText
                          value={c.balance}
                          tone="out"
                          size="sm"
                          currency={c.currencyCode}
                          testID={`reports-credit-${c.customerId}`}
                        />
                        <ChevronLeft size={16} color={colors.textMuted} />
                      </View>
                    }
                  />
                ))
              )}
              <Text style={styles.creditHint}>{ar.reports.creditHint}</Text>
            </AppCard>

            {/* ——— الإجراءات (FR-09-10) ——— */}
            <View style={styles.actionsRow}>
              <PrimaryButton
                label={ar.reports.print}
                icon={Printer}
                tone="primary"
                onPress={() => void onPrint()}
                loading={printing}
                style={styles.actionBtn}
                testID="reports-print-btn"
              />
              <PrimaryButton
                label={ar.reports.share}
                icon={MessageCircle}
                tone="success"
                onPress={() => void onShare()}
                loading={sharing}
                style={styles.actionBtn}
                testID="reports-share-btn"
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeScreen>
  );
}

/* ============ سطر بند P&L ============ */

function PnlLine({
  label,
  value,
  tone,
  decimals,
  currency,
}: {
  label: string;
  value: string;
  tone: 'in' | 'out' | 'neutral';
  decimals: number;
  currency: string;
}): React.JSX.Element {
  return (
    <View style={styles.pnlLine}>
      <Text style={styles.pnlLineLabel}>{label}</Text>
      <AmountText value={value} tone={tone} size="sm" currency={currency} decimals={decimals} />
    </View>
  );
}

/** مجموع فرعي: حد علوي + عريض */
function PnlSubtotal({
  label,
  value,
  decimals,
  currency,
}: {
  label: string;
  value: string;
  decimals: number;
  currency: string;
}): React.JSX.Element {
  return (
    <View style={styles.pnlSubtotal}>
      <Text style={styles.pnlSubtotalLabel}>{label}</Text>
      <Text style={styles.pnlSubtotalValue}>
        {formatAmount(value, decimals)}
        {currency ? ` ${currency}` : ''}
      </Text>
    </View>
  );
}

/** عنوان مقطع داخل البطاقة — مربع أيقونة ملون (مؤشر بصري للمسح السريع §6.1) */
function PnlSection({
  title,
  icon: Icon,
  tint,
}: {
  title: string;
  icon: typeof TrendingUp;
  tint: string;
}): React.JSX.Element {
  return (
    <View style={styles.pnlSection}>
      <View style={styles.pnlSectionHead}>
        <View style={[styles.pnlSectionIcon, { backgroundColor: `${tint}22` }]}>
          <Icon size={12} color={tint} />
        </View>
        <Text style={[styles.pnlSectionText, { color: tint }]}>{title}</Text>
      </View>
    </View>
  );
}

/* ============ جهة الشيكات (تحت التحصيل/تحت السحب) ============ */

function ChequeSide({
  title,
  groups,
  rows,
}: {
  title: string;
  groups: { code: string; count: number; total: string }[];
  rows: ChequeReportRow[];
}): React.JSX.Element {
  const nextDue = rows.slice(0, 3);
  return (
    <View style={styles.chequeSide}>
      <Text style={styles.chequeSideTitle}>{title}</Text>
      {groups.length === 0 ? (
        <Text style={styles.chequeSideZero}>0</Text>
      ) : (
        groups.map((g) => (
          <View key={g.code} style={styles.chequeGroupRow}>
            <Text style={styles.chequeGroupCount}>{`${g.count} ${ar.reports.chequesUnit} · ${g.code}`}</Text>
            <Text style={styles.chequeGroupValue}>{formatAmount(g.total, 2)}</Text>
          </View>
        ))
      )}
      {nextDue.length > 0 ? (
        <View style={styles.nextDueList}>
          <Text style={styles.nextDueLabel}>{ar.reports.nextDue}</Text>
          {nextDue.map((r) => (
            <View key={r.id} style={styles.nextDueRow}>
              <Text style={styles.nextDueDate} numberOfLines={1}>
                {`${statementShortDate(r.dueDate)} · ${r.chequeNo}`}
              </Text>
              <Text style={styles.nextDueAmount} numberOfLines={1}>
                {`${formatAmount(r.amount, 2)} ${r.currencyCode}`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/* ============ الأنماط ============ */

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.xs,
  },
  stack: {
    gap: spacing.sm,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chipPressed: {
    opacity: 0.7,
  },
  periodChip: {
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingVertical: 6,
    paddingHorizontal: 14,
    minHeight: 36,
    justifyContent: 'center',
  },
  periodChipActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(34, 211, 238, 0.14)',
  },
  periodText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  periodTextActive: {
    color: colors.accent,
    fontFamily: font.bold,
  },
  weekHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  customRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  customField: {
    flex: 1,
  },
  /* ——— بطاقة الأرباح ——— */
  pnlHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  pnlHeadText: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pnlTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 22,
  },
  baseNote: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  pnlHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 17,
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  pnlEmpty: {
    marginTop: spacing.xs,
  },
  pnlBody: {
    gap: 4,
  },
  pnlSection: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    marginTop: 4,
  },
  pnlSectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pnlSectionIcon: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pnlSectionText: {
    fontFamily: font.bold,
    fontSize: 12,
    lineHeight: 17,
  },
  pnlLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 34,
  },
  pnlLineLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
  },
  pnlSubtotal: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(148, 163, 184, 0.45)',
    paddingTop: 6,
    paddingBottom: 2,
  },
  pnlSubtotalLabel: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
  },
  pnlSubtotalValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
  },
  profitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 2,
    borderTopColor: colors.teal,
    // توهج ناعم يؤطّر النتيجة (نمط المهمة review-2)
    shadowColor: colors.teal,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 2,
  },
  profitLabel: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 21,
  },
  /* ——— مقطع المالك الكهرماني (خارج المصاريف) ——— */
  ownerBox: {
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.45)',
    backgroundColor: 'rgba(251, 191, 36, 0.08)',
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 4,
  },
  ownerHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  ownerTitle: {
    color: colors.warning,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
  },
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: 4,
  },
  ownerLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
  },
  ownerNote: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  /* ——— صافي ما بقي للمالك ——— */
  finalBox: {
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: 'rgba(34, 211, 238, 0.08)',
    borderRadius: radius.lg,
    padding: spacing.md,
    alignItems: 'center',
    gap: 4,
    // توهج سماوي يجذب العين للخلاصة النهائية
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.22,
    shadowRadius: 14,
    elevation: 3,
  },
  finalTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  finalNote: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
  },
  /* ——— قسم تقارير المخزون والمبيعات (Task 17) ——— */
  analyticsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: spacing.md,
    paddingBottom: 0,
  },
  analyticsTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 21,
  },
  analyticsHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: spacing.md,
    paddingTop: 2,
    paddingBottom: spacing.xs,
  },
  /* ——— بطاقة الشيكات ——— */
  chequesHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: spacing.md,
    paddingBottom: 0,
  },
  chequesTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 21,
  },
  chequesBody: {
    flexDirection: 'row',
    padding: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  chequeSide: {
    flex: 1,
    gap: 4,
  },
  chequeSideTitle: {
    color: colors.textMuted,
    fontFamily: font.bold,
    fontSize: 11.5,
    lineHeight: 17,
  },
  chequeSideZero: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  chequeGroupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  chequeGroupCount: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
  },
  chequeGroupValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12.5,
    lineHeight: 18,
    fontWeight: '600',
  },
  chequesDivider: {
    width: 1,
    backgroundColor: colors.border,
  },
  nextDueList: {
    marginTop: 6,
    gap: 3,
  },
  nextDueLabel: {
    color: colors.textFaint,
    fontFamily: font.medium,
    fontSize: 10.5,
    lineHeight: 15,
  },
  nextDueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  nextDueDate: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    flex: 1,
  },
  nextDueAmount: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 16,
  },
  cardEmpty: {
    padding: spacing.md,
  },
  /* ——— بطاقة الأرصدة الدائنة ——— */
  creditTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  creditHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    padding: spacing.md,
    paddingTop: 0,
  },
  /* ——— الإجراءات ——— */
  actionsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  actionBtn: {
    flex: 1,
  },
});
