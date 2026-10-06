/**
 * more/cheques.tsx — شاشة «الشيكات» (FR-14-05 — Task 12):
 *
 *  - شريط ملخص حي: تحت التحصيل (واردة حية) / تحت السحب (صادرة حية) /
 *    تستحق خلال 7 أيام / متأخرة — كل خلية عدد + قيمة بالعملة الأساسية
 *    (Σ المبلغ × سعره المسجَّل — Decimal لا Float).
 *  - رقائق فلترة: الاتجاه (الكل/واردة/صادرة) + الحالة (كل الحالات أو
 *    حالة بعينها) — تصفية لحظية على قائمة واحدة محمّلة (V1 حجمها صغير).
 *  - القائمة مرتبة بتاريخ الاستحقاق (الاستعلام) وصفوفها: رقم الشيك +
 *    البنك + الطرف + المبلغ بعملته + الاستحقاق القصير + شريحة الحالة.
 *    المتأخر بإطار أحمر على حافة البداية وتظليل، والقريب الموعد بكهرماني.
 *  - زر أساسي «شيك جديد» → /cheques/new. تحديث عند العودة + زر تحديث
 *    + سحب للتحديث (RefreshControl) — كل القراءة من queries.ts فقط.
 *  - الحالات: Skeleton / Error(retry) / فراغ صادق / لا نتائج بالفلاتر.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ArrowDownToLine, ArrowUpFromLine, Banknote, ChevronLeft, Plus, RefreshCw } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { fetchCompanyProfile, listCheques, type ChequeListRow } from '@/db/queries';
import { isDueSoon, isOverdue } from '@/domain/cheques';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import {
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
import ChequeStatusBadge from '@/components/cheques/ChequeStatusBadge';

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'data'; rows: ChequeListRow[]; baseDecimals: number; baseCode: string };

type DirectionFilter = 'all' | 'in' | 'out';
type StatusFilter = 'all' | ChequeListRow['status'];

const DIRECTION_FILTERS: { key: DirectionFilter; label: string }[] = [
  { key: 'all', label: ar.cheques.list.countAll },
  { key: 'in', label: ar.cheques.list.directionIn },
  { key: 'out', label: ar.cheques.list.directionOut },
];

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: ar.cheques.list.statusAll },
  { key: 'pending', label: ar.cheques.status.pendingIn },
  { key: 'deposited', label: ar.cheques.status.deposited },
  { key: 'cleared', label: ar.cheques.status.cleared },
  { key: 'bounced', label: ar.cheques.status.bounced },
  { key: 'void', label: ar.cheques.status.void },
];

export default function ChequesScreen() {
  const router = useRouter();
  const session = useSession();
  const today = todayISO();

  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [direction, setDirection] = useState<DirectionFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (skeleton: boolean) => {
    if (skeleton) setState({ kind: 'loading' });
    try {
      const db = await getDb();
      const [rows, company] = await Promise.all([listCheques(db), fetchCompanyProfile(db)]);
      const base = session.defaults;
      setState({
        kind: 'data',
        rows,
        // منازل عملة المنشأة (YER=0) — من ملف الشركة الحي
        baseDecimals: company ? company.currencyDecimals : 2,
        baseCode: base?.baseCurrencyCode ?? '',
      });
    } catch (err) {
      setState({ kind: 'error', technical: technicalText(err) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.defaults?.baseCurrencyCode]);

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
      void load(false); // العودة من شاشة الشيك الجديد/التفاصيل
    }, [load]),
  );

  const rows = useMemo(() => (state.kind === 'data' ? state.rows : []), [state]);

  /* ——— الشريط الملخص (من كل الصفوف — فلاتر العرض لا تمسه) ——— */
  const summary = useMemo(() => {
    const live = rows.filter((c) => c.status === 'pending' || c.status === 'deposited');
    const inLive = live.filter((c) => c.direction === 'in');
    const outLive = live.filter((c) => c.direction === 'out');
    const dueSoon = rows.filter((c) => isDueSoon(c, today));
    const overdue = rows.filter((c) => isOverdue(c, today));
    const baseValue = (list: ChequeListRow[]): string =>
      list.reduce((acc, c) => acc.plus(d(c.amount).times(d(c.exchangeRate))), d(0)).toFixed(4);
    return {
      inCount: inLive.length,
      inValue: baseValue(inLive),
      outCount: outLive.length,
      outValue: baseValue(outLive),
      dueSoonCount: dueSoon.length,
      dueSoonValue: baseValue(dueSoon),
      overdueCount: overdue.length,
      overdueValue: baseValue(overdue),
    };
  }, [rows, today]);

  /* ——— التصفية اللحظية ——— */
  const filtered = useMemo(
    () =>
      rows.filter(
        (c) =>
          (direction === 'all' || c.direction === direction) &&
          (status === 'all' || c.status === status),
      ),
    [rows, direction, status],
  );

  const hasFilters = direction !== 'all' || status !== 'all';

  return (
    <SafeScreen scroll={false} padded={false}>
      <View style={styles.screen}>
        <ScreenHeader
          title={ar.cheques.list.title}
          subtitle={ar.cheques.list.subtitle}
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
                message={ar.cheques.list.errorLoad}
                technical={state.technical}
                onRetry={() => void load(true)}
              />
            </AppCard>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(c) => String(c.id)}
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
                {/* ——— شريط الملخص ——— */}
                <AppCard noPadding style={styles.summaryCard}>
                  <View style={styles.summaryGrid}>
                    <SummaryCell
                      icon={ArrowDownToLine}
                      color={colors.success}
                      label={ar.cheques.list.summaryIn}
                      count={summary.inCount}
                      value={summary.inValue}
                      baseCode={state.baseCode}
                      decimals={state.baseDecimals}
                    />
                    <SummaryCell
                      icon={ArrowUpFromLine}
                      color={colors.danger}
                      label={ar.cheques.list.summaryOut}
                      count={summary.outCount}
                      value={summary.outValue}
                      baseCode={state.baseCode}
                      decimals={state.baseDecimals}
                    />
                    <SummaryCell
                      icon={Banknote}
                      color={colors.warning}
                      label={ar.cheques.list.summaryDueSoon}
                      count={summary.dueSoonCount}
                      value={summary.dueSoonValue}
                      baseCode={state.baseCode}
                      decimals={state.baseDecimals}
                    />
                    <SummaryCell
                      icon={Banknote}
                      color={colors.danger}
                      label={ar.cheques.list.summaryOverdue}
                      count={summary.overdueCount}
                      value={summary.overdueValue}
                      baseCode={state.baseCode}
                      decimals={state.baseDecimals}
                    />
                  </View>
                </AppCard>

                {/* ——— فلاتر الاتجاه ——— */}
                <View style={styles.chipsRow}>
                  {DIRECTION_FILTERS.map((f) => {
                    const active = f.key === direction;
                    return (
                      <Pressable
                        key={f.key}
                        accessibilityRole="button"
                        accessibilityLabel={f.label}
                        accessibilityState={{ selected: active }}
                        onPress={() => setDirection(f.key)}
                        style={[styles.filterChip, active && styles.filterChipActive]}
                        testID={`cheques-direction-${f.key}`}
                      >
                        <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                          {f.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* ——— فلاتر الحالة ——— */}
                <View style={styles.chipsRow}>
                  {STATUS_FILTERS.map((f) => {
                    const active = f.key === status;
                    return (
                      <Pressable
                        key={f.key}
                        accessibilityRole="button"
                        accessibilityLabel={f.label}
                        accessibilityState={{ selected: active }}
                        onPress={() => setStatus(f.key)}
                        style={[styles.filterChip, active && styles.filterChipStatusActive]}
                        testID={`cheques-status-${f.key}`}
                      >
                        <Text
                          style={[styles.filterChipText, active && styles.filterChipTextStatusActive]}
                        >
                          {f.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {state.kind === 'data' ? (
                  <View style={styles.countRow}>
                    <Text style={styles.countLabel}>
                      {`${formatCount(filtered.length)} ${ar.cheques.list.chequesUnit}`}
                    </Text>
                  </View>
                ) : null}
              </View>
            }
            ListEmptyComponent={
              hasFilters ? (
                <NoResultsState
                  message={ar.cheques.list.emptyFiltered}
                  onClearFilters={() => {
                    setDirection('all');
                    setStatus('all');
                  }}
                />
              ) : (
                <AppCard noPadding>
                  <EmptyState
                    icon={Banknote}
                    title={ar.cheques.list.empty}
                    message={ar.cheques.list.emptyHint}
                    actionLabel={ar.cheques.list.emptyAction}
                    onAction={() => router.push('/cheques/new')}
                  />
                </AppCard>
              )
            }
            renderItem={({ item }) => (
              <ChequeRow cheque={item} today={today} onPress={() => router.push(`/cheques/${item.id}`)} />
            )}
          />
        )}

        {/* ——— زر شيك جديد ——— */}
        {state.kind === 'data' ? (
          <View style={styles.bottomBar}>
            <PrimaryButton
              label={ar.cheques.list.emptyAction}
              icon={Plus}
              onPress={() => router.push('/cheques/new')}
              testID="cheques-new-btn"
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
  icon: typeof Banknote;
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

/* ============ صف الشيك ============ */

function ChequeRow({
  cheque,
  today,
  onPress,
}: {
  cheque: ChequeListRow;
  today: string;
  onPress: () => void;
}) {
  const overdue = isOverdue(cheque, today);
  const dueSoon = !overdue && isDueSoon(cheque, today);
  const faded = cheque.status === 'void';
  const bounced = cheque.status === 'bounced';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${cheque.chequeNo} — ${cheque.partyName ?? ''}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        overdue && styles.rowOverdue,
        dueSoon && styles.rowDueSoon,
        bounced && styles.rowBounced,
        faded && styles.rowFaded,
        pressed && styles.rowPressed,
      ]}
      testID={`cheque-row-${cheque.id}`}
    >
      <View style={styles.rowTexts}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowChequeNo} numberOfLines={1}>
            {cheque.chequeNo}
          </Text>
          {cheque.bankName ? (
            <Text style={styles.rowBank} numberOfLines={1}>
              {cheque.bankName}
            </Text>
          ) : null}
        </View>
        <Text style={styles.rowParty} numberOfLines={1}>
          {cheque.partyName ?? '—'}
        </Text>
        <View style={styles.rowMetaLine}>
          <Text style={styles.rowDue}>{`${ar.cheques.list.dueOn} ${formatDayShortAr(cheque.dueDate)}`}</Text>
          {overdue ? (
            <View style={styles.rowTagOverdue}>
              <Text style={styles.rowTagOverdueText}>{ar.cheques.list.overdueChip}</Text>
            </View>
          ) : dueSoon ? (
            <View style={styles.rowTagDueSoon}>
              <Text style={styles.rowTagDueSoonText}>{ar.cheques.list.dueSoonChip}</Text>
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.rowTrailing}>
        <AmountText
          value={cheque.amount}
          tone={cheque.direction === 'in' ? 'in' : 'out'}
          currency={cheque.currencyCode}
          decimals={cheque.currencyDecimals}
          size="sm"
        />
        <ChequeStatusBadge status={cheque.status} direction={cheque.direction} />
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
    // توهج ناعم يميّز شريط الملخص (نمط المهمة review-2)
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
  filterChipStatusActive: {
    borderColor: colors.warning,
    backgroundColor: 'rgba(251, 191, 36, 0.16)',
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
  filterChipTextStatusActive: {
    color: colors.warning,
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
    // إطار البداية (يمين في RTL) — شريط الحالة البصري
    borderRightWidth: 3,
    borderRightColor: colors.border,
  },
  rowOverdue: {
    borderRightColor: colors.danger,
    backgroundColor: 'rgba(248, 113, 113, 0.07)',
  },
  rowBounced: {
    // الشيك المرتد — إطار أحمر دائم (حالة لا تاريخ) يليق بتحذير FR-14-04
    borderRightColor: colors.danger,
    backgroundColor: 'rgba(248, 113, 113, 0.10)',
  },
  rowDueSoon: {
    borderRightColor: colors.warning,
    backgroundColor: 'rgba(251, 191, 36, 0.06)',
  },
  rowFaded: {
    opacity: 0.55,
  },
  rowPressed: {
    opacity: 0.85,
  },
  rowTexts: {
    flex: 1,
    gap: 2,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  rowChequeNo: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
    flexShrink: 1,
  },
  rowBank: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    flexShrink: 1,
  },
  rowParty: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  rowMetaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowDue: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  rowTagOverdue: {
    borderRadius: radius.full,
    backgroundColor: 'rgba(248, 113, 113, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  rowTagOverdueText: {
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
