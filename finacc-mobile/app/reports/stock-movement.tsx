/**
 * reports/stock-movement.tsx — حركة المخزون الكلي (Task 17 — FR-09-04 مهمة).
 *
 * المسار: /reports/stock-movement (من قسم تقارير المخزون والمبيعات).
 *
 *  - أرقاقة الفترات الجاهزة (FR-09-09) + فلتر مخزن (إن تعدد) + صندوق بحث
 *    يرشّح الصفوف بالاسم لحظياً (تصفية عرض — لا استعلام إضافي).
 *  - صف لكل صنف له حركة داخل الفترة: الاسم والوحدة + الوارد/الصادر/
 *    التسوية/الصافي كميات مدمجة + قيمتا الوارد والصادر بعملة الأساس
 *    (بتكلفة كل حركة) + الرصيد آخر الفترة. تفصيلا المرتجعين سطراً خفيفاً.
 *  - تذييل المجاميع (وارد/صادر/تسوية/صافي + القيمتان) — وملاحظة عملة الأساس.
 *  - الحالات: Skeleton إلزامي / ErrorState بإعادة محاولة / فراغ صادق /
 *    إعادة تحديث عند العودة (useFocusEffect).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Package } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { fetchBaseCurrency, listWarehouses, type CurrencyLite, type RefRow } from '@/db/queries';
import { getStockMovementSummary, type StockMovementSummary } from '@/domain/analytics';
import { resolveReportPeriod, type ReportPeriodPreset } from '@/domain/reports';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { formatAmount, formatQty, todayISO } from '@/utils/format';
import { technicalText } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import SearchBar from '@/components/ui/SearchBar';
import TextField from '@/components/ui/TextField';

const PERIOD_PRESETS: readonly [ReportPeriodPreset, string][] = [
  ['today', ar.reports.periods.today],
  ['week', ar.reports.periods.week],
  ['month', ar.reports.periods.month],
  ['quarter', ar.reports.periods.quarter],
  ['year', ar.reports.periods.year],
  ['custom', ar.reports.periods.custom],
];

export default function StockMovementScreen() {
  const router = useRouter();

  const [preset, setPreset] = useState<ReportPeriodPreset>('month');
  const [customFrom, setCustomFrom] = useState(todayISO());
  const [customTo, setCustomTo] = useState(todayISO());
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [search, setSearch] = useState('');

  const [warehouses, setWarehouses] = useState<RefRow[]>([]);
  const [base, setBase] = useState<CurrencyLite | null>(null);
  const [summary, setSummary] = useState<StockMovementSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const firstFocus = useRef(true);

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

  /* ============ التحميل ============ */

  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = await getDb();
      const [whs, baseCur] = await Promise.all([listWarehouses(db), fetchBaseCurrency(db)]);
      if (!alive) return;
      setWarehouses(whs);
      setBase(baseCur);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (range === null) {
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const db = await getDb();
        const data = await getStockMovementSummary(db, {
          from: range.from,
          to: range.to,
          warehouseId,
        });
        if (!alive) return;
        setSummary(data);
        setLoading(false);
      } catch (err: unknown) {
        if (!alive) return;
        setError(technicalText(err));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [range, warehouseId, reload]);

  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setReload((r) => r + 1);
    }, []),
  );

  /* رشح بالاسم — عرضي فقط */
  const rows = useMemo(() => {
    if (summary === null) return [];
    const q = search.trim();
    if (q === '') return summary.rows;
    return summary.rows.filter((r) => r.name.includes(q));
  }, [summary, search]);

  const decimals = base?.decimals ?? 2;
  const baseCode = base?.code ?? '';

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.analytics.stockMovement.title}
        subtitle={ar.analytics.stockMovement.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* ——— الفترات ——— */}
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
                testID={`stock-move-period-${key}`}
              >
                <Text style={[styles.periodText, selected && styles.periodTextActive]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {preset === 'week' ? <Text style={styles.weekHint}>{ar.reports.weekStartHint}</Text> : null}
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
                testID="stock-move-custom-from"
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
                testID="stock-move-custom-to"
              />
            </View>
          </View>
        ) : null}

        {/* ——— فلتر المخزن ——— */}
        {warehouses.length > 1 ? (
          <View>
            <Text style={styles.sectionLabel}>{ar.analytics.paper.warehouse}</Text>
            <View style={styles.chipsRow}>
              <WarehouseChip
                label={ar.analytics.allWarehouses}
                selected={warehouseId === null}
                onPress={() => setWarehouseId(null)}
                testID="stock-move-wh-all"
              />
              {warehouses.map((w) => (
                <WarehouseChip
                  key={w.id}
                  label={w.name}
                  selected={warehouseId === w.id}
                  onPress={() => setWarehouseId(w.id)}
                  testID={`stock-move-wh-${w.id}`}
                />
              ))}
            </View>
          </View>
        ) : null}

        {error !== null ? (
          <ErrorState
            message={ar.analytics.errorLoad}
            technical={error}
            onRetry={() => setReload((r) => r + 1)}
          />
        ) : loading ? (
          <LoadingState variant="report" />
        ) : summary !== null ? (
          <View style={styles.stack}>
            <SearchBar
              value={search}
              onChangeText={setSearch}
              placeholder={ar.analytics.stockMovement.searchPh}
              testID="stock-move-search"
            />

            {rows.length === 0 ? (
              <AppCard noPadding>
                <View style={styles.cardEmpty}>
                  <EmptyState
                    icon={Package}
                    title={ar.analytics.stockMovement.empty}
                    message={ar.analytics.stockMovement.emptyHint}
                  />
                </View>
              </AppCard>
            ) : (
              <AppCard noPadding>
                <View style={styles.rowsHead}>
                  <Text style={styles.rowsTitle}>{ar.analytics.stockMovement.title}</Text>
                  <Text style={styles.rowsNote}>{ar.analytics.stockMovement.baseNote}</Text>
                </View>
                {rows.map((r, i) => (
                  <View
                    key={r.productId}
                    style={[styles.productRow, i < rows.length - 1 && styles.rowDivider]}
                  >
                    <View style={styles.productHead}>
                      <Text style={styles.productName} numberOfLines={1}>
                        {r.name}
                      </Text>
                      {r.unitName ? <Text style={styles.productUnit}>{r.unitName}</Text> : null}
                    </View>
                    <View style={styles.qtyRow}>
                      <QtyCell label={ar.analytics.stockMovement.inCol} value={r.inQty} tone={colors.success} />
                      <QtyCell label={ar.analytics.stockMovement.outCol} value={r.outQty} tone={colors.danger} />
                      <QtyCell
                        label={ar.analytics.stockMovement.adjustCol}
                        value={r.adjustQty}
                        tone={colors.accent}
                        signed
                      />
                      <QtyCell
                        label={ar.analytics.stockMovement.netCol}
                        value={r.netQty}
                        tone={colors.text}
                        signed
                      />
                      <QtyCell
                        label={ar.analytics.stockMovement.endCol}
                        value={r.endQty}
                        tone={colors.teal}
                      />
                    </View>
                    {r.returnsIn !== '0.000' || r.returnsOut !== '0.000' ? (
                      <Text style={styles.returnsNote}>
                        {`${ar.inventory.movement.sale_return} +${formatQty(r.returnsIn)} · ${ar.inventory.movement.purchase_return} −${formatQty(r.returnsOut)}`}
                      </Text>
                    ) : null}
                    <View style={styles.valueRow}>
                      <Text style={styles.valueText}>
                        {`${ar.analytics.stockMovement.valueIn}: ${formatAmount(r.valueIn, decimals)}${baseCode ? ` ${baseCode}` : ''}`}
                      </Text>
                      <Text style={styles.valueText}>
                        {`${ar.analytics.stockMovement.valueOut}: ${formatAmount(r.valueOut, decimals)}${baseCode ? ` ${baseCode}` : ''}`}
                      </Text>
                    </View>
                  </View>
                ))}

                {/* ——— تذييل المجاميع ——— */}
                <View style={styles.totalsBox}>
                  <Text style={styles.totalsTitle}>{ar.analytics.stockMovement.totalsRow}</Text>
                  <View style={styles.qtyRow}>
                    <QtyCell label={ar.analytics.stockMovement.inCol} value={summary.totals.inQty} tone={colors.success} />
                    <QtyCell label={ar.analytics.stockMovement.outCol} value={summary.totals.outQty} tone={colors.danger} />
                    <QtyCell
                      label={ar.analytics.stockMovement.adjustCol}
                      value={summary.totals.adjustQty}
                      tone={colors.accent}
                      signed
                    />
                    <QtyCell
                      label={ar.analytics.stockMovement.netCol}
                      value={summary.totals.netQty}
                      tone={colors.teal}
                      signed
                      emphasized
                    />
                  </View>
                  <View style={styles.valueRow}>
                    <Text style={[styles.valueText, styles.valueBold]}>
                      {`${ar.analytics.stockMovement.valueIn}: ${formatAmount(summary.totals.valueIn, decimals)}${baseCode ? ` ${baseCode}` : ''}`}
                    </Text>
                    <Text style={[styles.valueText, styles.valueBold]}>
                      {`${ar.analytics.stockMovement.valueOut}: ${formatAmount(summary.totals.valueOut, decimals)}${baseCode ? ` ${baseCode}` : ''}`}
                    </Text>
                  </View>
                </View>
              </AppCard>
            )}
          </View>
        ) : null}
      </ScrollView>
    </SafeScreen>
  );
}

/* ============ مساعدات عرض ============ */

function QtyCell({
  label,
  value,
  tone,
  signed = false,
  emphasized = false,
}: {
  label: string;
  value: string;
  tone: string;
  signed?: boolean;
  emphasized?: boolean;
}): React.JSX.Element {
  const sign = signed && value.startsWith('-') ? '− ' : '';
  const body = signed && value.startsWith('-') ? value.slice(1) : value;
  return (
    <View style={[styles.qtyCell, emphasized && styles.qtyCellEmph]}>
      <Text style={styles.qtyLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.qtyValue, { color: tone }]} numberOfLines={1}>
        {`${sign}${formatQty(body)}`}
      </Text>
    </View>
  );
}

function WarehouseChip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.periodChip,
        selected && styles.periodChipActive,
        pressed && styles.chipPressed,
      ]}
      testID={testID}
    >
      <Text style={[styles.periodText, selected && styles.periodTextActive]}>{label}</Text>
    </Pressable>
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
  fieldLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 4,
  },
  dateInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.md,
    minHeight: 48,
    justifyContent: 'center',
  },
  dateInputError: {
    borderColor: colors.danger,
  },
  dateInputText: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 8,
    textAlign: 'right',
  },
  dateError: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  cardEmpty: {
    padding: spacing.md,
  },
  rowsHead: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    gap: 2,
  },
  rowsTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 21,
  },
  rowsNote: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  productRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 6,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  productHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  productName: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 14.5,
    lineHeight: 21,
    flex: 1,
  },
  productUnit: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
  },
  qtyRow: {
    flexDirection: 'row',
    gap: 6,
  },
  qtyCell: {
    flex: 1,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingHorizontal: 6,
    paddingVertical: 5,
    alignItems: 'center',
    gap: 1,
  },
  qtyCellEmph: {
    borderColor: colors.teal,
  },
  qtyLabel: {
    color: colors.textFaint,
    fontFamily: font.medium,
    fontSize: 10,
    lineHeight: 14,
  },
  qtyValue: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12.5,
    lineHeight: 18,
  },
  returnsNote: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  valueRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  valueText: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11.5,
    lineHeight: 17,
  },
  valueBold: {
    color: colors.text,
    fontFamily: font.bold,
  },
  totalsBox: {
    borderTopWidth: 2,
    borderTopColor: colors.teal,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 8,
    backgroundColor: 'rgba(45, 212, 191, 0.05)',
  },
  totalsTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
});
