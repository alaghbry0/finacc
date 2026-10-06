/**
 * more/installments.tsx — شاشة «الأقساط» (FR-05-02/05 — Task 14):
 *
 *  - شريط ملخص حي 4 خلايا (FR-05-05): المحصّل حتى الآن / المستحق القادم
 *    (خلال 7 أيام) / متأخر / متوقع هذا الشهر — القيم بالعملة الأساسية
 *    (Σ المبلغ × سعر الخطة المسجَّل — Decimal لا Float، قرار 8: لا تجميع
 *    عملات في رقم واحد إلا مقيّمة بالأساس كمعاينة).
 *  - رقائق فلترة: الكل / مستحق اليوم / هذا الأسبوع / متأخر — على الخطط
 *    (خطة تدخل «اليوم/الأسبوع» إن فيها قسط غير مسدد بتلك النافذة).
 *  - صف الخطة: العميل + رقم الفاتورة + شريط تقدّم + x/y مدفوعة + المتبقي
 *    بعملة الخطة + الاستحقاق القادم وشرائح «متأخر X يوماً» (DS-07 أحمر)
 *    و«يستحق قريباً» (كهرماني) و«مكتملة» للمكتملة (باهتة).
 *  - زر أساسي «خطة تقسيط جديدة» → /installments/new + تحديث عند العودة
 *    + سحب للتحديث — كل القراءة من queries.ts فقط (لا كتابة هنا).
 *  - الحالات: Skeleton / Error(retry) / فراغ صادق / لا نتائج بالفلاتر.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  CalendarClock,
  ChevronLeft,
  Coins,
  Plus,
  RefreshCw,
  TriangleAlert,
  Wallet,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  fetchCompanyProfile,
  listDueInstallments,
  listInstallmentPlans,
  type DueInstallmentRow,
  type InstallmentPlanListRow,
} from '@/db/queries';
import { daysLate, isLate } from '@/domain/installments';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import {
  addDaysISO,
  currencySymbol,
  formatAmount,
  formatCount,
  formatDayShortAr,
  todayISO,
} from '@/utils/format';
import { d } from '@/utils/money';
import { technicalText } from '@/utils/validation';
import AmountText from '@/components/ui/AmountText';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import NoResultsState from '@/components/ui/NoResultsState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | {
      kind: 'data';
      plans: InstallmentPlanListRow[];
      due: DueInstallmentRow[];
      baseDecimals: number;
      baseCode: string;
    };

type PlanFilter = 'all' | 'today' | 'week' | 'late';

const PLAN_FILTERS: { key: PlanFilter; label: string }[] = [
  { key: 'all', label: ar.installments.list.filterAll },
  { key: 'today', label: ar.installments.list.filterToday },
  { key: 'week', label: ar.installments.list.filterWeek },
  { key: 'late', label: ar.installments.list.filterLate },
];

/** نهاية الشهر الجاري (ISO) — لنافذة «متوقع هذا الشهر» */
function endOfMonthISO(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${today.slice(0, 8)}${last < 10 ? `0${last}` : last}`;
}

export default function InstallmentsScreen() {
  const router = useRouter();
  const session = useSession();
  const today = todayISO();

  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [filter, setFilter] = useState<PlanFilter>('all');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (skeleton: boolean) => {
    if (skeleton) setState({ kind: 'loading' });
    try {
      const db = await getDb();
      // المستحق حتى نهاية الشهر (يشمل المتأخر) — يغذي الخلايا والفلاتر معاً
      const [plans, due, company] = await Promise.all([
        listInstallmentPlans(db),
        listDueInstallments(db, { today, withinDays: 35 }),
        fetchCompanyProfile(db),
      ]);
      const base = session.defaults;
      setState({
        kind: 'data',
        plans,
        due,
        baseDecimals: company ? company.currencyDecimals : 2,
        baseCode: base?.baseCurrencyCode ?? '',
      });
    } catch (err) {
      setState({ kind: 'error', technical: technicalText(err) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.defaults?.baseCurrencyCode, today]);

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
      void load(false); // العودة من الخطة الجديدة/التفاصيل
    }, [load]),
  );

  const plans = useMemo(() => (state.kind === 'data' ? state.plans : []), [state]);

  /* ——— شريط الملخص (FR-05-05) — القيم بالأساس عبر سعر الخطة المسجَّل ——— */
  const summary = useMemo(() => {
    if (state.kind !== 'data') return null;
    const weekEnd = addDaysISO(today, 7);
    const monthEnd = endOfMonthISO(today);
    const rateOf = new Map(state.plans.map((p) => [p.id, d(p.exchangeRate)]));
    const baseValue = (list: DueInstallmentRow[]): string =>
      list
        .reduce((acc, x) => acc.plus(d(x.remaining).times(rateOf.get(x.planId) ?? d(1))), d(0))
        .toFixed(4);
    const late = state.due.filter((x) => isLate(x, today));
    const upcoming = state.due.filter((x) => x.dueDate >= today);
    const week = upcoming.filter((x) => x.dueDate <= weekEnd);
    const month = upcoming.filter((x) => x.dueDate <= monthEnd);
    const collectedBase = state.plans
      .reduce((acc, p) => acc.plus(d(p.totalPaid).times(d(p.exchangeRate))), d(0))
      .toFixed(4);
    const collectedCount = state.plans.reduce((acc, p) => acc + p.paidCount, 0);
    return {
      collectedValue: collectedBase,
      collectedCount,
      weekCount: week.length,
      weekValue: baseValue(week),
      lateCount: late.length,
      lateValue: baseValue(late),
      monthCount: month.length,
      monthValue: baseValue(month),
    };
  }, [state, today]);

  /* ——— مجموعات الفلاتر: خطط فيها قسط غير مسدد بالنافذة ——— */
  const filterSets = useMemo(() => {
    if (state.kind !== 'data') return null;
    const weekEnd = addDaysISO(today, 7);
    const todayIds = new Set<number>();
    const weekIds = new Set<number>();
    const lateIds = new Set<number>();
    for (const x of state.due) {
      if (x.dueDate < today) lateIds.add(x.planId);
      if (x.dueDate === today) todayIds.add(x.planId);
      if (x.dueDate >= today && x.dueDate <= weekEnd) weekIds.add(x.planId);
    }
    return { todayIds, weekIds, lateIds };
  }, [state, today]);

  const filtered = useMemo(() => {
    if (filterSets === null) return [];
    if (filter === 'all') return plans;
    const set =
      filter === 'today' ? filterSets.todayIds : filter === 'week' ? filterSets.weekIds : filterSets.lateIds;
    return plans.filter((p) => set.has(p.id));
  }, [plans, filter, filterSets]);

  const hasFilter = filter !== 'all';

  return (
    <SafeScreen scroll={false} padded={false}>
      <View style={styles.screen}>
        <ScreenHeader
          title={ar.installments.list.title}
          subtitle={ar.installments.list.subtitle}
          onBack={() => router.back()}
          actions={[
            {
              icon: RefreshCw,
              label: ar.common.retry,
              onPress: () => void load(false),
            },
          ]}
        />

        {state.kind === 'loading' ? (
          <View style={styles.body}>
            <AppCard noPadding>
              <LoadingState variant="list" rows={6} />
            </AppCard>
          </View>
        ) : state.kind === 'error' ? (
          <View style={styles.body}>
            <AppCard noPadding>
              <ErrorState
                message={ar.installments.list.errorLoad}
                technical={state.technical}
                onRetry={() => void load(true)}
              />
            </AppCard>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(p) => String(p.id)}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => {
                  setRefreshing(true);
                  void load(false).then(() => setRefreshing(false));
                }}
                tintColor={colors.accent}
              />
            }
            ListHeaderComponent={
              <View>
                {/* ——— شريط الملخص (FR-05-05) ——— */}
                {summary !== null ? (
                  <AppCard noPadding style={styles.summaryCard}>
                    <View style={styles.summaryGrid}>
                      <SummaryCell
                        icon={Wallet}
                        color={colors.success}
                        label={ar.installments.list.summaryCollected}
                        count={summary.collectedCount}
                        value={summary.collectedValue}
                        baseCode={state.baseCode}
                        decimals={state.baseDecimals}
                      />
                      <SummaryCell
                        icon={CalendarClock}
                        color={colors.accent}
                        label={ar.installments.list.summaryNextDue}
                        count={summary.weekCount}
                        value={summary.weekValue}
                        baseCode={state.baseCode}
                        decimals={state.baseDecimals}
                      />
                      <SummaryCell
                        icon={TriangleAlert}
                        color={colors.danger}
                        label={ar.installments.list.summaryLate}
                        count={summary.lateCount}
                        value={summary.lateValue}
                        baseCode={state.baseCode}
                        decimals={state.baseDecimals}
                      />
                      <SummaryCell
                        icon={Coins}
                        color={colors.warning}
                        label={ar.installments.list.summaryMonth}
                        count={summary.monthCount}
                        value={summary.monthValue}
                        baseCode={state.baseCode}
                        decimals={state.baseDecimals}
                      />
                    </View>
                  </AppCard>
                ) : null}

                {/* ——— رقائق الفلترة ——— */}
                <View style={styles.chipsRow}>
                  {PLAN_FILTERS.map((f) => {
                    const active = f.key === filter;
                    return (
                      <Pressable
                        key={f.key}
                        accessibilityRole="button"
                        accessibilityLabel={f.label}
                        accessibilityState={{ selected: active }}
                        onPress={() => setFilter(f.key)}
                        style={[styles.filterChip, active && styles.filterChipActive]}
                        testID={`installments-filter-${f.key}`}
                      >
                        <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                          {f.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {state.kind === 'data' ? (
                  <View style={styles.countRow}>
                    <Text style={styles.countLabel}>
                      {`${formatCount(filtered.length)} ${ar.installments.list.plansUnit}`}
                    </Text>
                  </View>
                ) : null}
              </View>
            }
            ListEmptyComponent={
              hasFilter ? (
                <NoResultsState
                  message={ar.installments.list.emptyFiltered}
                  onClearFilters={() => setFilter('all')}
                />
              ) : (
                <AppCard noPadding>
                  <EmptyState
                    icon={CalendarClock}
                    title={ar.installments.list.empty}
                    message={ar.installments.list.emptyHint}
                    actionLabel={ar.installments.list.emptyAction}
                    onAction={() => router.push('/installments/new')}
                  />
                </AppCard>
              )
            }
            renderItem={({ item }) => (
              <PlanRow plan={item} today={today} onPress={() => router.push(`/installments/${item.id}`)} />
            )}
          />
        )}

        {/* ——— زر خطة جديدة ——— */}
        {state.kind === 'data' ? (
          <View style={styles.bottomBar}>
            <PrimaryButton
              label={ar.installments.list.emptyAction}
              icon={Plus}
              onPress={() => router.push('/installments/new')}
              testID="installments-new-btn"
            />
          </View>
        ) : null}
      </View>
    </SafeScreen>
  );
}

/* ============ خلية الملخص ============ */

function SummaryCell({
  icon: Icon,
  color,
  label,
  count,
  value,
  baseCode,
  decimals,
}: {
  icon: typeof Wallet;
  color: string;
  label: string;
  count: number;
  value: string;
  baseCode: string;
  decimals: number;
}) {
  return (
    <View style={styles.summaryCell}>
      <View style={styles.summaryHead}>
        <View style={[styles.summaryIcon, { backgroundColor: `${color}22` }]}>
          <Icon size={14} color={color} />
        </View>
        <Text style={styles.summaryLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.summaryCount, { color }]}>{formatCount(count)}</Text>
      </View>
      <Text
        style={styles.summaryValue}
        accessibilityLabel={`${label}: ${formatAmount(value, decimals)} ${baseCode}`}
        numberOfLines={1}
      >
        {`${formatAmount(value, decimals)}${baseCode ? ` ${currencySymbol(baseCode)}` : ''}`}
      </Text>
    </View>
  );
}

/* ============ صف الخطة ============ */

function PlanRow({
  plan,
  today,
  onPress,
}: {
  plan: InstallmentPlanListRow;
  today: string;
  onPress: () => void;
}) {
  const completed = plan.status === 'completed' || plan.remaining === '0.0000';
  const nextDueInfo =
    plan.nextDue !== null
      ? { dueDate: plan.nextDue, status: 'pending' as const }
      : null;
  const late = nextDueInfo !== null && isLate(nextDueInfo, today);
  const lateDays = late ? daysLate(nextDueInfo!, today) : 0;
  // «يستحق قريباً»: أقرب استحقاق خلال 7 أيام قادمة
  const dueSoon =
    !completed && !late && plan.nextDue !== null && plan.nextDue <= addDaysISO(today, 7);
  const progress = plan.totalCount > 0 ? plan.paidCount / plan.totalCount : 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${plan.customerName ?? ''} — ${plan.invoiceNo ?? ''}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        late && styles.rowLate,
        dueSoon && styles.rowDueSoon,
        completed && styles.rowFaded,
        pressed && styles.rowPressed,
      ]}
      testID={`installment-plan-row-${plan.id}`}
    >
      <View style={styles.rowTexts}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowCustomer} numberOfLines={1}>
            {plan.customerName ?? '—'}
          </Text>
          <Text style={styles.rowInvoiceNo} numberOfLines={1}>
            {plan.invoiceNo ?? '—'}
          </Text>
        </View>
        {/* شريط التقدّم + x/y مدفوعة */}
        <View style={styles.progressRow}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { flex: Math.max(progress, 0.01) }]} />
          </View>
          <Text style={styles.progressText}>
            {`${plan.paidCount}/${plan.totalCount} ${ar.installments.list.paidOfUnit}`}
          </Text>
        </View>
        <View style={styles.rowMetaLine}>
          {completed ? (
            <View style={styles.rowTagCompleted}>
              <Text style={styles.rowTagCompletedText}>{ar.installments.list.completedChip}</Text>
            </View>
          ) : plan.nextDue !== null ? (
            <>
              <Text style={styles.rowDue}>
                {`${ar.installments.list.nextDueLabel}: ${formatDayShortAr(plan.nextDue)}`}
              </Text>
              {late ? (
                <View style={styles.rowTagLate}>
                  <Text style={styles.rowTagLateText}>
                    {`${ar.installments.list.overdueChip} ${formatCount(lateDays)} ${ar.installments.list.daysUnit}`}
                  </Text>
                </View>
              ) : dueSoon ? (
                <View style={styles.rowTagDueSoon}>
                  <Text style={styles.rowTagDueSoonText}>{ar.installments.list.dueSoonChip}</Text>
                </View>
              ) : null}
            </>
          ) : null}
          <Text style={styles.rowCycle}>
            {plan.cycle === 'weekly'
              ? ar.installments.list.weekly
              : ar.installments.list.monthly}
          </Text>
        </View>
      </View>
      <View style={styles.rowTrailing}>
        <AmountText
          value={plan.remaining}
          tone="neutral"
          currency={plan.currencyCode}
          decimals={plan.currencyDecimals}
          size="sm"
        />
        <ChevronLeft size={16} color={colors.textFaint} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  body: {
    flex: 1,
    padding: spacing.lg,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  summaryCard: {
    marginBottom: spacing.xs,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.10,
    shadowRadius: 12,
    elevation: 2,
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  summaryCell: {
    width: '50%',
    padding: spacing.md,
    gap: 4,
  },
  summaryHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  summaryIcon: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryLabel: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  summaryCount: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
  },
  summaryValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'left',
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  filterChip: {
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(34, 211, 238, 0.16)',
  },
  filterChipText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  filterChipTextActive: {
    color: colors.accent,
  },
  countRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  countLabel: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  row: {
    minHeight: touch.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: spacing.md,
    // إطار البداية (يمين في RTL) — شريط الحالة البصري (نمط الشيكات)
    borderRightWidth: 3,
    borderRightColor: colors.border,
  },
  rowLate: {
    borderRightColor: colors.danger,
    backgroundColor: 'rgba(248, 113, 113, 0.07)',
  },
  rowDueSoon: {
    borderRightColor: colors.warning,
    backgroundColor: 'rgba(251, 191, 36, 0.06)',
  },
  rowFaded: {
    opacity: 0.6,
  },
  rowPressed: {
    opacity: 0.85,
  },
  rowTexts: {
    flex: 1,
    gap: 4,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  rowCustomer: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
    flexShrink: 1,
  },
  rowInvoiceNo: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
    flexShrink: 1,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  progressTrack: {
    flex: 1,
    height: 6,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  progressFill: {
    backgroundColor: colors.accent,
    borderRadius: radius.full,
  },
  progressText: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  rowMetaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  rowDue: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  rowCycle: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  rowTagLate: {
    borderRadius: radius.full,
    backgroundColor: 'rgba(248, 113, 113, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  rowTagLateText: {
    color: colors.danger,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  rowTagDueSoon: {
    borderRadius: radius.full,
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  rowTagDueSoonText: {
    color: colors.warning,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  rowTagCompleted: {
    borderRadius: radius.full,
    backgroundColor: 'rgba(52, 211, 153, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  rowTagCompletedText: {
    color: colors.success,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  rowTrailing: {
    alignItems: 'flex-end',
    gap: 4,
    flexShrink: 1,
  },
  bottomBar: {
    padding: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
