/**
 * more/stocktakes.tsx — شاشة «سجل الجرد» (FR-01-08 — Task 16):
 *
 *  - قائمة عمليات الجرد المعتمدة: التاريخ + المخزن + x أصناف · y فروقات
 *    + صافي قيمة الفروقات (AmountText بإشارة: زيادة أخضر / نقص أحمر —
 *    قيمة الترويسة Σ(diff × تكلفة اللقطة) بالعملة الأساسية).
 *  - الضغط على صف يفتح BottomSheet بالتفاصيل الكاملة (fetchStocktakeDetails):
 *    ترويسة + كل أسطر الجرد (الصنف/دفتري/فعلي/شريحة الفرق/تكلفة اللقطة/
 *    قيمة السطر) — المطابق يظهر باهتاً بشريحة رمادية.
 *  - زر «جرد جديد» → /inventory/stocktake + سحب للتحديث + useFocusEffect
 *    (العودة من الاعتماد تُنعش القائمة) — كل القراءة من queries.ts فقط.
 *  - الحالات: Skeleton / Error(retry) / فراغ صادق.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft, ClipboardCheck, History, Plus, RefreshCw } from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  fetchBaseCurrency,
  fetchStocktakeDetails,
  fetchStocktakes,
  type CurrencyLite,
  type StocktakeDetailsRow,
  type StocktakeListRow,
} from '@/db/queries';
import { ar, pluralAr } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { formatAmount, formatQty, todayISO } from '@/utils/format';
import { d } from '@/utils/money';
import { technicalText } from '@/utils/validation';
import AmountText from '@/components/ui/AmountText';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'data'; rows: StocktakeListRow[] };

type DetailsState =
  | { kind: 'idle' }
  | { kind: 'loading'; id: number }
  | { kind: 'error'; id: number }
  | { kind: 'ready'; details: StocktakeDetailsRow };

export default function StocktakesHistoryScreen() {
  const router = useRouter();
  const today = todayISO();

  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [details, setDetails] = useState<DetailsState>({ kind: 'idle' });
  const [base, setBase] = useState<CurrencyLite | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (skeleton: boolean) => {
    if (skeleton) setState({ kind: 'loading' });
    try {
      const db = await getDb();
      const [rows, baseCur] = await Promise.all([fetchStocktakes(db), fetchBaseCurrency(db)]);
      setBase(baseCur);
      setState({ kind: 'data', rows });
    } catch (err) {
      setState({ kind: 'error', technical: technicalText(err) });
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  /* العودة من شاشة الجرد الجديد تُنعش القائمة */
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void load(false);
    }, [load]),
  );

  /** فتح تفاصيل جرد داخل الشيت */
  const openDetails = useCallback(async (id: number) => {
    setDetails({ kind: 'loading', id });
    try {
      const db = await getDb();
      const det = await fetchStocktakeDetails(db, id);
      if (det === null) {
        setDetails({ kind: 'error', id });
        return;
      }
      setDetails({ kind: 'ready', details: det });
    } catch {
      setDetails({ kind: 'error', id });
    }
  }, []);

  const rows = state.kind === 'data' ? state.rows : [];

  return (
    <SafeScreen scroll={false} padded={false}>
      <View style={styles.screen}>
        <ScreenHeader
          title={ar.stocktake.list.title}
          subtitle={ar.stocktake.list.subtitle}
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
              <LoadingState variant="list" rows={5} />
            </AppCard>
          </View>
        ) : state.kind === 'error' ? (
          <View style={styles.body}>
            <AppCard noPadding>
              <ErrorState
                message={ar.stocktake.list.errorLoad}
                technical={state.technical}
                onRetry={() => void load(true)}
              />
            </AppCard>
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(r) => String(r.id)}
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
            ListEmptyComponent={
              <AppCard noPadding>
                <EmptyState
                  icon={History}
                  title={ar.stocktake.list.empty}
                  message={ar.stocktake.list.emptyHint}
                  actionLabel={ar.stocktake.list.emptyAction}
                  onAction={() => router.push('/inventory/stocktake')}
                />
              </AppCard>
            }
            renderItem={({ item }) => (
              <StocktakeRow
                row={item}
                base={base}
                today={today}
                onOpen={() => void openDetails(item.id)}
              />
            )}
          />
        )}

        {/* ——— زر جرد جديد ——— */}
        {state.kind === 'data' ? (
          <View style={styles.bottomBar}>
            <PrimaryButton
              label={ar.stocktake.list.newAction}
              icon={Plus}
              onPress={() => router.push('/inventory/stocktake')}
              testID="stocktakes-new-btn"
            />
          </View>
        ) : null}
      </View>

      {/* ——— تفاصيل الجرد داخل شيت ——— */}
      <BottomSheet
        visible={details.kind !== 'idle'}
        onClose={() => setDetails({ kind: 'idle' })}
        title={ar.stocktake.list.detailsTitle}
      >
        {details.kind === 'loading' ? (
          <LoadingState variant="list" rows={3} />
        ) : details.kind === 'error' ? (
          <Text style={styles.detailsError}>{ar.stocktake.list.detailsError}</Text>
        ) : details.kind === 'ready' ? (
          <StocktakeDetailsView details={details.details} base={base} />
        ) : null}
      </BottomSheet>
    </SafeScreen>
  );
}

/* ============ صف جرد في السجل ============ */

function StocktakeRow({
  row,
  base,
  today,
  onOpen,
}: {
  row: StocktakeListRow;
  base: CurrencyLite | null;
  today: string;
  onOpen: () => void;
}) {
  const clean = row.diffsCount === 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ar.stocktake.list.title} ${row.countedAt} — ${row.warehouseName}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`stocktake-row-${row.id}`}
    >
      <View style={styles.rowIcon}>
        <ClipboardCheck size={18} color={colors.accent} />
      </View>
      <View style={styles.rowTexts}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowWarehouse} numberOfLines={1}>
            {row.warehouseName}
          </Text>
          {clean ? (
            <View style={styles.chipClean}>
              <Text style={styles.chipCleanText}>{ar.stocktake.list.cleanChip}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.rowMeta}>
          {`${row.countedAt}${row.countedAt === today ? ` · ${ar.common.today}` : ''}`}
        </Text>
        <Text style={styles.rowCounts}>
          {`${pluralAr(row.linesCount, ar.stocktake.new.countForms)} · ${row.diffsCount} ${ar.stocktake.list.diffsUnit}`}
        </Text>
      </View>
      <View style={styles.rowTrailing}>
        <AmountText
          value={row.totalDiff}
          tone={clean ? 'neutral' : d(row.totalDiff).gte(0) ? 'in' : 'out'}
          sign={!clean}
          currency={base?.code}
          decimals={base?.decimals ?? 2}
          size="sm"
        />
        <ChevronLeft size={16} color={colors.textFaint} />
      </View>
    </Pressable>
  );
}

/* ============ عرض التفاصيل داخل الشيت ============ */

function StocktakeDetailsView({
  details,
  base,
}: {
  details: StocktakeDetailsRow;
  base: CurrencyLite | null;
}) {
  const dec = base?.decimals ?? 2;
  const code = base?.code ?? '';
  const clean = details.diffsCount === 0;
  return (
    <View style={styles.detailsWrap}>
      {/* ترويسة الجرد */}
      <View style={styles.detailsHead}>
        <View style={styles.detailsHeadRow}>
          <Text style={styles.detailsLabel}>{ar.stocktake.list.countedOn}</Text>
          <Text style={styles.detailsValue}>{details.countedAt}</Text>
        </View>
        <View style={styles.detailsHeadRow}>
          <Text style={styles.detailsLabel}>{ar.stocktake.new.warehouse}</Text>
          <Text style={styles.detailsValue}>{details.warehouseName}</Text>
        </View>
        <View style={styles.detailsHeadRow}>
          <Text style={styles.detailsLabel}>{ar.stocktake.list.linesOf}</Text>
          <Text
            style={styles.detailsValue}
          >{`${details.linesCount} ${ar.stocktake.list.linesUnit} · ${details.diffsCount} ${ar.stocktake.list.diffsUnit}`}</Text>
        </View>
        <View style={styles.detailsHeadRow}>
          <Text style={styles.detailsLabel}>{ar.stocktake.list.totalDiff}</Text>
          <AmountText
            value={details.totalDiff}
            tone={clean ? 'neutral' : d(details.totalDiff).gte(0) ? 'in' : 'out'}
            sign={!clean}
            currency={code}
            decimals={dec}
            size="sm"
          />
        </View>
        {details.notes ? (
          <View style={styles.detailsHeadRow}>
            <Text style={styles.detailsLabel}>{ar.stocktake.list.notesLabel}</Text>
            <Text style={[styles.detailsValue, { flex: 1, textAlign: 'left' }]}>{details.notes}</Text>
          </View>
        ) : null}
      </View>

      {/* رأس جدول الأسطر */}
      <View style={styles.linesHeader}>
        <Text style={[styles.linesColName, styles.linesHeaderText]}>{ar.stocktake.list.colProduct}</Text>
        <Text style={[styles.linesColQty, styles.linesHeaderText]}>{ar.stocktake.list.colBook}</Text>
        <Text style={[styles.linesColQty, styles.linesHeaderText]}>{ar.stocktake.list.colCounted}</Text>
        <Text style={[styles.linesColQty, styles.linesHeaderText]}>{ar.stocktake.list.colDiff}</Text>
        <Text style={[styles.linesColVal, styles.linesHeaderText]}>{ar.stocktake.list.colValue}</Text>
      </View>

      {/* أسطر الجرد */}
      {details.lines.map((l) => {
        const diff = d(l.diffQty);
        const match = diff.isZero();
        const increase = diff.gt(0);
        return (
          <View key={l.id} style={[styles.lineRow, match && styles.lineRowMatch]}>
            <View style={styles.lineNameWrap}>
              <Text style={[styles.lineName, match && styles.lineTextFaint]} numberOfLines={1}>
                {l.productName}
              </Text>
              <Text style={styles.lineCost}>{`${ar.stocktake.list.colCost}: ${formatAmount(l.unitCost, 4)}`}</Text>
            </View>
            <Text style={[styles.linesColQty, styles.lineQty, match && styles.lineTextFaint]}>
              {formatQty(l.bookQty)}
            </Text>
            <Text style={[styles.linesColQty, styles.lineQty, match && styles.lineTextFaint]}>
              {formatQty(l.countedQty)}
            </Text>
            <Text
              style={[
                styles.linesColQty,
                styles.lineQty,
                match
                  ? styles.lineTextFaint
                  : increase
                    ? styles.lineIncrease
                    : styles.lineShortage,
              ]}
            >
              {match
                ? ar.stocktake.list.diffMatch
                : `${increase ? ar.stocktake.list.diffIncrease : ar.stocktake.list.diffShortage} ${formatQty(diff.toFixed(3))}`}
            </Text>
            <AmountText
              value={l.lineValue}
              tone={match ? 'neutral' : increase ? 'in' : 'out'}
              sign={!match}
              decimals={dec}
              size="micro"
              style={styles.linesColVal}
            />
          </View>
        );
      })}
    </View>
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
  },
  rowPressed: {
    opacity: 0.85,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTexts: {
    flex: 1,
    gap: 3,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  rowWarehouse: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
    flexShrink: 1,
  },
  chipClean: {
    borderRadius: radius.full,
    backgroundColor: 'rgba(52, 211, 153, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  chipCleanText: {
    color: colors.success,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  rowMeta: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  rowCounts: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
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
  /* ——— التفاصيل ——— */
  detailsError: {
    color: colors.danger,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    paddingVertical: spacing.md,
    textAlign: 'center',
  },
  detailsWrap: {
    gap: spacing.sm,
  },
  detailsHead: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(34, 211, 238, 0.06)',
    padding: spacing.md,
    gap: spacing.sm,
  },
  detailsHeadRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  detailsLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  detailsValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'left',
  },
  linesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: spacing.xs,
    paddingBottom: 2,
  },
  linesHeaderText: {
    color: colors.textFaint,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  linesColName: {
    flex: 1.6,
  },
  linesColQty: {
    flex: 1,
    textAlign: 'center',
  },
  linesColVal: {
    flex: 1.1,
    textAlign: 'left',
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 10,
    minHeight: 44,
  },
  lineRowMatch: {
    opacity: 0.62,
  },
  lineNameWrap: {
    flex: 1.6,
    gap: 1,
  },
  lineName: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  lineTextFaint: {
    color: colors.textFaint,
  },
  lineCost: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 15,
  },
  lineQty: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
    color: colors.text,
  },
  lineIncrease: {
    color: colors.success,
  },
  lineShortage: {
    color: colors.warning,
  },
});
