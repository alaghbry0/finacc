/**
 * inventory/stocktake.tsx — شاشة «جرد مخزن» (FR-01-08 — Task 16):
 *
 *  - اختيار المخزن (منتقي عند تعدد المخازن — الافتراضي هو مخزن الجلسة)
 *    + تاريخ الجرد (اليوم افتراضياً — عليه تُسجَّل حركات التسوية) + ملاحظة.
 *  - الأصناف القابلة للعدّ (غير الخدمية) مع رصيدها الدفتري وحقل «فعلي»:
 *    الضغط على الصف يفتح NumberPad (كميات 3 منازل) مقترحاً الرصيد الدفتري،
 *    والفرق يظهر فوراً بشريحة موقّعة (زيادة أخضر / نقص كهرماني / مطابق رمادي).
 *  - شريط ملخص حي: المعدود / الفروقات / قيمة الزيادة / قيمة النقص — كلها
 *    بالعملة الأساسية على **تكلفة اللقطة** (avg_cost لحظة الجرد — قرار 10).
 *  - «اعتماد الجرد» → شيت مراجعة (الأعداد + صافي القيمة + تحذير قفل
 *    الأرصدة) → domain/createStocktake (Transaction ذرّية + audit) → شيت
 *    نجاح يوصل بسجل الجرد.
 *  - الحالات: Skeleton / Error(retry) / لا مخازن / فراغ صادق / لا نتائج بحث.
 *  لا كتابة مباشرة هنا — كل الاعتماد عبر الدومين حصراً (NFR-09/11).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ClipboardCheck, PackageSearch } from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  fetchBaseCurrency,
  fetchStocktakeCandidates,
  listWarehouses,
  type CurrencyLite,
  type StocktakeCandidateRow,
} from '@/db/queries';
import { createStocktake, type CreateStocktakeResult } from '@/domain/stocktake';
import { useSession } from '@/store/session';
import { ar, pluralAr } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { currencySymbol, formatAmount, formatQty, todayISO } from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import AmountText from '@/components/ui/AmountText';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import ConfirmSheet from '@/components/ui/ConfirmSheet';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import NoResultsState from '@/components/ui/NoResultsState';
import NumberPad from '@/components/ui/NumberPad';
import OptionPickerSheet from '@/components/ui/OptionPickerSheet';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import SearchBar from '@/components/ui/SearchBar';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * اقتراح العدّ خام بلا أصفار ذيلية: '100.000' → '100' و'10.500' → '10.5'
 * (قيمة 3dp كما خُزّنت تُغلق لوحة الأرقام — لا خانة تُضاف قبل المسح).
 */
function trimQty(s: string): string {
  const t = s.replace(/(\.[1-9]*)0+$/, '$1').replace(/\.$/, '');
  return t === '' ? '0' : t;
}

interface WarehouseLite {
  id: number;
  name: string;
}

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'nowarehouse' }
  | { kind: 'data'; candidates: StocktakeCandidateRow[] };

export default function StocktakeScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const userId = session.user?.id;
  const today = todayISO();

  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [warehouses, setWarehouses] = useState<WarehouseLite[]>([]);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [countedAt, setCountedAt] = useState(today);
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  /** productId → الكمية المعدودة المدخلة (خام — غير المُدخل غير معدود) */
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [base, setBase] = useState<CurrencyLite | null>(null);

  /* ——— الشيتات ——— */
  const [whSheet, setWhSheet] = useState(false);
  const [padFor, setPadFor] = useState<StocktakeCandidateRow | null>(null);
  const [padValue, setPadValue] = useState('0');
  const [confirmSheet, setConfirmSheet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<CreateStocktakeResult | null>(null);

  /* ============ التحميل: مخازن + مرشّحو الجرد + عملة الأساس ============ */

  const load = useCallback(
    async (whId: number | null) => {
      setState({ kind: 'loading' });
      try {
        const db = await getDb();
        const whs = await listWarehouses(db);
        if (whs.length === 0) {
          setState({ kind: 'nowarehouse' });
          return;
        }
        const preferred = whId ?? session.defaults?.warehouseId ?? null;
        const eff = whs.some((w) => w.id === preferred) ? preferred! : whs[0]!.id;
        const [cands, baseCur] = await Promise.all([
          fetchStocktakeCandidates(db, eff),
          fetchBaseCurrency(db),
        ]);
        setWarehouses(whs.map((w) => ({ id: w.id, name: w.name })));
        setWarehouseId(eff);
        setBase(baseCur);
        setState({ kind: 'data', candidates: cands });
      } catch (err) {
        setState({ kind: 'error', technical: technicalText(err) });
      }
    },
    [session.defaults?.warehouseId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  /** تبديل المخزن يعيد الأصناف ويصفّر العدّ (الأرصدة الدفترية تختلف) */
  const onPickWarehouse = (id: number | null) => {
    if (id === null || id === warehouseId) return;
    setCounts({});
    setWarehouseId(id);
    void load(id);
  };

  /* ============ المشتقات الحية ============ */

  const candidates = useMemo(
    () => (state.kind === 'data' ? state.candidates : []),
    [state],
  );
  const warehouseName =
    warehouses.find((w) => w.id === warehouseId)?.name ?? ar.stocktake.new.warehouse;

  const filtered = useMemo(() => {
    const q = search.trim();
    return q === '' ? candidates : candidates.filter((c) => c.name.includes(q));
  }, [candidates, search]);

  /** الفرق = المعدود − الدفتري (Decimal — لا Float) */
  const diffOf = useCallback(
    (c: StocktakeCandidateRow) => d(counts[c.productId] ?? c.bookQty).minus(d(c.bookQty)),
    [counts],
  );

  const summary = useMemo(() => {
    let diffsCount = 0;
    let increase = d(0);
    let shortage = d(0);
    let enteredCount = 0;
    for (const c of candidates) {
      if (counts[c.productId] === undefined) continue;
      enteredCount += 1;
      const diff = diffOf(c);
      if (diff.isZero()) continue;
      diffsCount += 1;
      const value = diff.times(d(c.avgCost));
      if (diff.gt(0)) increase = increase.plus(value);
      else shortage = shortage.plus(value.abs());
    }
    return { enteredCount, diffsCount, increase, shortage, net: increase.minus(shortage) };
  }, [candidates, counts, diffOf]);

  /* ============ لوحة العدّ ============ */

  const openPad = (c: StocktakeCandidateRow) => {
    setPadFor(c);
    // الاقتراح = الرصيد الدفتري (خاماً) — المطابق يضغط «تم» مباشرة
    setPadValue(counts[c.productId] !== undefined ? trimQty(counts[c.productId]!) : trimQty(c.bookQty));
  };

  const onPadChange = (v: string) => {
    setPadValue(v);
    if (padFor !== null) setCounts((prev) => ({ ...prev, [padFor.productId]: v }));
  };

  const onPadDone = () => {
    if (padFor !== null) setCounts((prev) => ({ ...prev, [padFor.productId]: padValue }));
    setPadFor(null);
  };

  /* ============ الاعتماد (domain — ذرّية + audit) ============ */

  const onAdoptPress = () => {
    if (!DATE_RE.test(countedAt)) {
      feedback.show({ message: ar.stocktake.new.dateInvalid, durationMs: 5000 });
      return;
    }
    if (summary.enteredCount === 0) {
      feedback.show({ message: ar.stocktake.new.needCount, durationMs: 5000 });
      return;
    }
    setConfirmSheet(true);
  };

  const doAdopt = async () => {
    setConfirmSheet(false);
    if (warehouseId === null) return;
    setSaving(true);
    try {
      const db = await getDb();
      const res = await createStocktake(
        db,
        {
          warehouseId,
          countedAt,
          notes: notes.trim() === '' ? undefined : notes.trim(),
          lines: candidates
            .filter((c) => counts[c.productId] !== undefined)
            .map((c) => ({ productId: c.productId, countedQty: counts[c.productId]! })),
        },
        { createdBy: userId },
      );
      setSaved(res);
      feedback.show({ message: ar.stocktake.new.saved, durationMs: 5000 });
      // تصفير العدّ وإعادة قراءة الدفتري (صار على الأعداد الجديدة)
      setCounts({});
      setNotes('');
      void load(warehouseId);
    } catch (err) {
      feedback.show({
        message: domainErrorMessage(err) ?? technicalText(err) ?? ar.stocktake.new.failed,
        durationMs: 8000,
      });
    } finally {
      setSaving(false);
    }
  };

  /* ============ حرس الجلسة ============ */

  if (!session.ready || session.locked) {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.stocktake.new.title} onBack={() => router.back()} />
        <View style={styles.body}>
          <AppCard noPadding>
            <LoadingState variant="list" rows={4} />
          </AppCard>
        </View>
      </SafeScreen>
    );
  }

  const dec = base?.decimals ?? 2;
  const code = base?.code ?? '';
  const netText = `${formatAmount(summary.net.toFixed(4), dec)}${currencySymbol(code) ? ` ${currencySymbol(code)}` : ''}`;

  return (
    <SafeScreen scroll={false} padded={false} avoidKeyboard offline>
      <View style={styles.screen}>
        <ScreenHeader
          title={ar.stocktake.new.title}
          subtitle={ar.stocktake.new.subtitle}
          onBack={() => router.back()}
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
                message={ar.stocktake.new.errorLoad}
                technical={state.technical}
                onRetry={() => void load(warehouseId)}
              />
            </AppCard>
          </View>
        ) : state.kind === 'nowarehouse' ? (
          <View style={styles.body}>
            <AppCard noPadding>
              <EmptyState icon={ClipboardCheck} title={ar.stocktake.new.title} message={ar.stocktake.new.needWarehouse} />
            </AppCard>
          </View>
        ) : (
          <View style={styles.body}>
            {/* ——— المخزن + التاريخ + الملاحظة ——— */}
            <AppCard style={styles.metaCard}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${ar.stocktake.new.warehouse}: ${warehouseName}`}
                onPress={() => {
                  if (warehouses.length > 1) setWhSheet(true);
                }}
                style={({ pressed }) => [styles.metaRow, pressed && styles.metaRowPressed]}
                testID="stocktake-warehouse-field"
              >
                <View style={styles.metaTexts}>
                  <Text style={styles.metaLabel}>{ar.stocktake.new.warehouse}</Text>
                  <Text style={styles.metaValue} numberOfLines={1}>
                    {warehouseName}
                  </Text>
                </View>
                {warehouses.length > 1 ? <Text style={styles.metaChevron}>›</Text> : null}
              </Pressable>
              <TextField
                label={ar.stocktake.new.countedAt}
                value={countedAt}
                onChangeText={setCountedAt}
                placeholder="YYYY-MM-DD"
                keyboardType="numbers-and-punctuation"
                maxLength={10}
                hint={ar.stocktake.new.dateHint}
                testID="stocktake-date-field"
              />
              <TextField
                label={ar.stocktake.new.notes}
                value={notes}
                onChangeText={setNotes}
                placeholder={ar.stocktake.new.notesPh}
                testID="stocktake-notes-field"
              />
            </AppCard>

            {/* ——— شريط الملخص الحي ——— */}
            <AppCard noPadding style={styles.summaryCard}>
              <View style={styles.summaryGrid}>
                <SummaryCell
                  label={ar.stocktake.new.summaryEntered}
                  value={pluralAr(summary.enteredCount, ar.stocktake.new.countedForms)}
                  tone="plain"
                />
                <SummaryCell
                  label={ar.stocktake.new.summaryDiffs}
                  value={String(summary.diffsCount)}
                  tone="plain"
                />
                <SummaryCell
                  label={ar.stocktake.new.summaryIncrease}
                  value={`${formatAmount(summary.increase.toFixed(4), dec)}${currencySymbol(code) ? ` ${currencySymbol(code)}` : ''}`}
                  tone="in"
                />
                <SummaryCell
                  label={ar.stocktake.new.summaryShortage}
                  value={`${formatAmount(summary.shortage.toFixed(4), dec)}${currencySymbol(code) ? ` ${currencySymbol(code)}` : ''}`}
                  tone="out"
                />
              </View>
              <Text style={styles.summaryNote}>{ar.stocktake.new.summaryCostNote}</Text>
            </AppCard>

            {/* ——— بحث ——— */}
            <SearchBar
              value={search}
              onChangeText={setSearch}
              placeholder={ar.stocktake.new.searchPh}
              testID="stocktake-search"
            />

            {/* ——— قائمة الأصناف ——— */}
            {candidates.length === 0 ? (
              <AppCard noPadding>
                <EmptyState
                  icon={PackageSearch}
                  title={ar.stocktake.new.empty}
                  message={ar.stocktake.new.emptyHint}
                />
              </AppCard>
            ) : (
              <FlatList
                data={filtered}
                keyExtractor={(c) => String(c.productId)}
                style={styles.list}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={
                  <NoResultsState message={ar.stocktake.new.noResults} onClearFilters={() => setSearch('')} />
                }
                renderItem={({ item }) => (
                  <CountRow
                    item={item}
                    counted={counts[item.productId]}
                    diff={diffOf(item)}
                    onOpen={() => openPad(item)}
                  />
                )}
              />
            )}
          </View>
        )}

        {/* ——— زر الاعتماد ——— */}
        {state.kind === 'data' ? (
          <View style={styles.bottomBar}>
            <PrimaryButton
              label={ar.stocktake.new.adopt}
              icon={ClipboardCheck}
              loading={saving}
              disabled={summary.enteredCount === 0}
              onPress={onAdoptPress}
              testID="stocktake-adopt-btn"
            />
          </View>
        ) : null}
      </View>

      {/* ============ الشيتات ============ */}

      {/* منتقي المخزن (عند التعدد) */}
      <OptionPickerSheet
        visible={whSheet}
        title={ar.stocktake.new.pickWarehouse}
        options={warehouses.map((w) => ({ id: w.id, label: w.name }))}
        selectedId={warehouseId}
        onSelect={onPickWarehouse}
        onClose={() => setWhSheet(false)}
        testID="stocktake-warehouse-picker"
      />

      {/* لوحة العدّ — اقتراح الدفتري والفرق يُحسب فوراً */}
      <BottomSheet
        visible={padFor !== null}
        onClose={() => setPadFor(null)}
        title={padFor !== null ? `${ar.stocktake.new.countField} — ${padFor.name}` : undefined}
      >
        {padFor !== null ? (
          <View style={styles.padWrap}>
            <View style={styles.padMeta}>
              <Text style={styles.padMetaText}>
                {`${ar.stocktake.new.bookLabel}: ${formatQty(padFor.bookQty)}${padFor.unitName ? ` ${padFor.unitName}` : ''}`}
              </Text>
              <Text style={styles.padMetaHint}>{ar.stocktake.new.countHint}</Text>
            </View>
            <NumberPad
              value={padValue}
              onChange={onPadChange}
              onDone={onPadDone}
              allowDecimal
              decimals={3}
              label={ar.stocktake.new.countedLabel}
              testID="stocktake-number-pad"
            />
          </View>
        ) : null}
      </BottomSheet>

      {/* مراجعة الاعتماد: الأعداد + القيمة + تحذير القفل */}
      <ConfirmSheet
        visible={confirmSheet}
        title={ar.stocktake.new.confirmTitle}
        message={[
          `${ar.stocktake.new.confirmEntered}: ${pluralAr(summary.enteredCount, ar.stocktake.new.countedForms)}`,
          `${ar.stocktake.new.confirmDiffs}: ${summary.diffsCount}`,
          `${ar.stocktake.new.confirmNet}: ${netText}`,
          ar.stocktake.new.lockWarning,
        ].join('\n')}
        danger={false}
        onConfirm={() => void doAdopt()}
        onCancel={() => setConfirmSheet(false)}
        testID="stocktake-confirm-sheet"
      />

      {/* شيت النجاح */}
      <BottomSheet visible={saved !== null} title={ar.stocktake.new.successTitle}>
        {saved !== null ? (
          <View style={styles.successWrap}>
            <View style={styles.successCard}>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>{ar.stocktake.new.warehouse}</Text>
                <Text style={styles.successValue}>{warehouseName}</Text>
              </View>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>{ar.stocktake.new.countedAt}</Text>
                <Text style={styles.successValue}>{countedAt}</Text>
              </View>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>{ar.stocktake.new.summaryDiffs}</Text>
                <Text style={styles.successValue}>{String(saved.diffsCount)}</Text>
              </View>
              <View style={styles.successRow}>
                <Text style={styles.successLabel}>{ar.stocktake.new.confirmNet}</Text>
                <AmountText
                  value={saved.totalDiff}
                  tone={saved.diffsCount === 0 ? 'neutral' : d(saved.totalDiff).gte(0) ? 'in' : 'out'}
                  sign
                  currency={code}
                  decimals={dec}
                  size="sm"
                />
              </View>
              <Text style={styles.successHint}>{ar.stocktake.new.successHint}</Text>
            </View>
            <View style={styles.successActions}>
              <PrimaryButton
                label={ar.stocktake.new.successHistory}
                tone="primary"
                onPress={() => {
                  setSaved(null);
                  router.push('/more/stocktakes');
                }}
                style={styles.successBtn}
                testID="stocktake-success-history"
              />
              <PrimaryButton
                label={ar.stocktake.new.successAnother}
                tone="ghost"
                onPress={() => setSaved(null)}
                style={styles.successBtn}
                testID="stocktake-success-another"
              />
            </View>
          </View>
        ) : null}
      </BottomSheet>

      {feedback.host}
    </SafeScreen>
  );
}

/* ============ خلية الملخص ============ */

function SummaryCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'plain' | 'in' | 'out';
}) {
  const color = tone === 'in' ? colors.success : tone === 'out' ? colors.warning : colors.text;
  return (
    <View style={styles.summaryCell}>
      <Text style={styles.summaryLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.summaryValue, { color }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/* ============ صف صنف (دفتري + فعلي + شريحة الفرق) ============ */

function CountRow({
  item,
  counted,
  diff,
  onOpen,
}: {
  item: StocktakeCandidateRow;
  /** الكمية المدخلة (خام) — undefined = لم يُعدّ بعد */
  counted: string | undefined;
  diff: ReturnType<typeof d>;
  onOpen: () => void;
}) {
  const entered = counted !== undefined;
  const isMatch = entered && diff.isZero();
  const isIncrease = entered && diff.gt(0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.name} — ${ar.stocktake.new.bookLabel}: ${formatQty(item.bookQty)}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`stocktake-row-${item.productId}`}
    >
      <View style={styles.rowTexts}>
        <Text style={styles.rowName} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.rowBook}>
          {`${ar.stocktake.new.bookLabel}: ${formatQty(item.bookQty)}${item.unitName ? ` ${item.unitName}` : ''}`}
        </Text>
      </View>
      {entered ? (
        <View style={styles.rowTrailing}>
          {isMatch ? (
            <View style={[styles.chip, styles.chipMatch]}>
              <Text style={[styles.chipText, styles.chipMatchText]}>{ar.stocktake.new.chipMatch}</Text>
            </View>
          ) : (
            <View
              style={[styles.chip, isIncrease ? styles.chipIncrease : styles.chipShortage]}
            >
              <Text
                style={[styles.chipText, isIncrease ? styles.chipIncreaseText : styles.chipShortageText]}
              >
                {`${isIncrease ? ar.stocktake.new.chipIncrease : ar.stocktake.new.chipShortage} ${formatQty(diff.toFixed(3))}`}
              </Text>
            </View>
          )}
          <Text style={styles.rowCounted}>{formatQty(counted!)}</Text>
        </View>
      ) : (
        <View style={[styles.chip, styles.chipCount]}>
          <Text style={styles.chipCountText}>{ar.stocktake.new.countBtn}</Text>
        </View>
      )}
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
    gap: spacing.md,
  },
  metaCard: {
    gap: spacing.md,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
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
  metaChevron: {
    color: colors.textFaint,
    fontSize: 20,
    lineHeight: 24,
  },
  summaryCard: {
    paddingBottom: spacing.sm,
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  summaryCell: {
    width: '50%',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    gap: 2,
  },
  summaryLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  summaryValue: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'left',
  },
  summaryNote: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
  },
  list: {
    flex: 1,
  },
  listContent: {
    gap: spacing.sm,
    paddingBottom: spacing.xl,
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
    opacity: 0.8,
  },
  rowTexts: {
    flex: 1,
    gap: 3,
  },
  rowName: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  rowBook: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  rowTrailing: {
    alignItems: 'flex-end',
    gap: 4,
    flexShrink: 1,
  },
  rowCounted: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 21,
  },
  chip: {
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipMatch: {
    backgroundColor: 'rgba(148, 163, 184, 0.16)',
  },
  chipMatchText: {
    color: colors.textMuted,
  },
  chipIncrease: {
    backgroundColor: 'rgba(52, 211, 153, 0.14)',
  },
  chipIncreaseText: {
    color: colors.success,
  },
  chipShortage: {
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
  },
  chipShortageText: {
    color: colors.warning,
  },
  chipCount: {
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
  },
  chipCountText: {
    color: colors.accent,
  },
  chipText: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  padWrap: {
    gap: spacing.sm,
  },
  padMeta: {
    gap: 2,
    paddingHorizontal: spacing.xs,
  },
  padMetaText: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  padMetaHint: {
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
