/**
 * reports/item-card.tsx — بطاقة صنف (Task 17 — FR-09-03 أساسية).
 *
 * المسار: /reports/item-card (بمعامل id اختياري — من بطاقة الصنف في المخزون
 * أو من قسم تقارير المخزون بالمزيد، وهناك منتقي أصناف بالبحث).
 *
 *  - رأس بالصنف ووحدته + أرقاقة الفترات الجاهزة (FR-09-09 عبر
 *    resolveReportPeriod — «مخصص» بحقلَي من/إلى) + فلتر مخزن (إن تعدد).
 *  - صف «رصيد ما قبله» الكهرماني حين لا تبدأ الفترة من أول التاريخ، ثم
 *    الحركات تصاعدياً: تاريخ + شارة نوع بتينت النظام (افتتاحي تيل ·
 *    شراء/تحويل وارد أخضر · بيع/تحويل صادر أحمر · مرتجعان كهرماني ·
 *    تسويتان سماوي) + كمية موقّعة بعلامة +/− (DS-18) + **الباقي التراكمي**
 *    مبرزاً بخط الأرقام.
 *  - تذييل: وارد الفترة/صادرها/صافيها/الرصيد الختامي + **طباعة الورقة
 *    420px** (قرار Task 17: التجار يطبعون بطاقات الأصناف) + مشاركة واتساب.
 *  - الحالات: Skeleton إلزامي للتقارير / ErrorState بإعادة محاولة / فراغ
 *    صادق / إعادة تحديث عند العودة (useFocusEffect).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, MessageCircle, Printer, Search } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { listWarehouses, type RefRow } from '@/db/queries';
import { searchStockProducts, type ProductPickerRow } from '@/db/queries-analytics';
import { getItemCard, type ItemCardReport } from '@/domain/analytics';
import { resolveReportPeriod, type ReportPeriodPreset } from '@/domain/reports';
import {
  buildItemCardWhatsAppMessage,
  loadItemCardPrintData,
  printItemCard,
} from '@/services/analytics-print';
import { waLink, waNumber } from '@/services/share-text';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { formatDateAr, formatQty, todayISO } from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import ListRow from '@/components/ui/ListRow';
import LoadingState from '@/components/ui/LoadingState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import SearchBar from '@/components/ui/SearchBar';
import TagChip from '@/components/ui/TagChip';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

/* ============ تسميات وتينت أنواع الحركات (قاموس المخزون نفسه) ============ */

const MOVEMENT_LABELS = ar.inventory.movement as unknown as Record<string, string>;

function movementLabel(type: string): string {
  return MOVEMENT_LABELS[type] ?? type;
}

/** تينت النظام لكل نوع (اللون يقترن دائماً بعلامة الإشارة على الكمية) */
const TYPE_TINT: Record<string, string> = {
  opening: colors.teal,
  purchase: colors.success,
  transfer_in: colors.success,
  sale: colors.danger,
  transfer_out: colors.danger,
  sale_return: colors.warning,
  purchase_return: colors.warning,
  stocktake_adjust: colors.accent,
  manual_adjust: colors.accent,
};

const PERIOD_PRESETS: readonly [ReportPeriodPreset, string][] = [
  ['today', ar.reports.periods.today],
  ['week', ar.reports.periods.week],
  ['month', ar.reports.periods.month],
  ['quarter', ar.reports.periods.quarter],
  ['year', ar.reports.periods.year],
  ['custom', ar.reports.periods.custom],
];

export default function ItemCardScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const params = useLocalSearchParams<{ id?: string }>();
  const initialId = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;

  const [productId, setProductId] = useState<number | null>(initialId);
  const [preset, setPreset] = useState<ReportPeriodPreset>('year');
  const [customFrom, setCustomFrom] = useState(todayISO());
  const [customTo, setCustomTo] = useState(todayISO());
  const [warehouseId, setWarehouseId] = useState<number | null>(null);

  const [warehouses, setWarehouses] = useState<RefRow[]>([]);
  const [companyWhatsapp, setCompanyWhatsapp] = useState<string | null>(null);

  const [card, setCard] = useState<ItemCardReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // منتقي الأصناف (حين دخلنا بلا id)
  const [pickSearch, setPickSearch] = useState('');
  const [pickResults, setPickResults] = useState<ProductPickerRow[] | null>(null);
  const [picking, setPicking] = useState(false);

  const [printing, setPrinting] = useState(false);
  const [sharing, setSharing] = useState(false);

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

  /* ============ المرجعيات (مخازن/واتساب المنشأة) ============ */

  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = await getDb();
      const [whs, companyRows] = await Promise.all([
        listWarehouses(db),
        db.all<{ whatsapp: string | null }>('SELECT whatsapp FROM company ORDER BY id LIMIT 1'),
      ]);
      if (!alive) return;
      setWarehouses(whs);
      setCompanyWhatsapp(companyRows[0]?.whatsapp ?? null);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* ============ البطاقة ============ */

  useEffect(() => {
    if (productId === null || range === null) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const db = await getDb();
        const data = await getItemCard(db, {
          productId,
          from: range.from,
          to: range.to,
          warehouseId,
        });
        if (!alive) return;
        setCard(data);
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
  }, [productId, range, warehouseId, reload]);

  /* ============ منتقي الأصناف ============ */

  useEffect(() => {
    if (productId !== null) return;
    let alive = true;
    setPicking(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const db = await getDb();
          const rows = await searchStockProducts(db, pickSearch);
          if (!alive) return;
          setPickResults(rows);
          setPicking(false);
        } catch {
          if (!alive) return;
          setPickResults([]);
          setPicking(false);
        }
      })();
    }, 180); // مهلة خفيفة تمنع إغراق القاعدة مع كل حرف
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [productId, pickSearch]);

  /* إعادة تحديث عند العودة من شاشات البيع/الشراء */
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setReload((r) => r + 1);
    }, []),
  );

  /* ============ طباعة + واتساب ============ */

  const onPrint = async (): Promise<void> => {
    if (printing || productId === null || range === null) return;
    setPrinting(true);
    try {
      const db = await getDb();
      const res = await printItemCard(db, {
        productId,
        from: range.from,
        to: range.to,
        warehouseId,
      });
      feedback.show({ message: res.message });
    } catch (err: unknown) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.analytics.printFailed });
    } finally {
      setPrinting(false);
    }
  };

  const onShare = async (): Promise<void> => {
    if (sharing || productId === null || range === null) return;
    setSharing(true);
    try {
      const db = await getDb();
      const data = await loadItemCardPrintData(db, {
        productId,
        from: range.from,
        to: range.to,
        warehouseId,
      });
      const message = buildItemCardWhatsAppMessage(data);
      const phone = companyWhatsapp ? waNumber(companyWhatsapp) : null;
      const url = phone
        ? waLink(phone, message)
        : `https://wa.me/?text=${encodeURIComponent(message)}`;
      await Linking.openURL(url);
      feedback.show({ message: ar.analytics.shareSent });
    } catch (err: unknown) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.analytics.shareFailed });
    } finally {
      setSharing(false);
    }
  };

  const warehouseName = useMemo(
    () => warehouses.find((w) => w.id === warehouseId)?.name ?? null,
    [warehouses, warehouseId],
  );

  /* ============ العرض ============ */

  // ——— منتقي الأصناف (دخلنا بلا id) ———
  if (productId === null) {
    return (
      <SafeScreen offline={false}>
        <ScreenHeader
          title={ar.analytics.itemCard.pickTitle}
          subtitle={ar.analytics.itemCard.pickHint}
          onBack={() => router.back()}
        />
        <SearchBar
          value={pickSearch}
          onChangeText={setPickSearch}
          placeholder={ar.analytics.itemCard.searchPh}
          testID="item-card-picker-search"
        />
        <AppCard noPadding>
          {picking || pickResults === null ? (
            <LoadingState variant="list" rows={6} />
          ) : pickResults.length === 0 ? (
            <EmptyState
              title={ar.inventory.empty}
              message={ar.inventory.noResultsHint}
              style={styles.pickerEmpty}
            />
          ) : (
            pickResults.map((p, i) => (
              <ListRow
                key={p.id}
                title={p.name}
                subtitle={p.barcode ?? p.unitName ?? undefined}
                divider={i < pickResults.length - 1}
                leading={
                  p.isArchived ? (
                    <TagChip label={ar.inventory.archivedChip} color={colors.warning} />
                  ) : undefined
                }
                trailing={
                  <View style={styles.pickTrailing}>
                    <Text
                      style={styles.pickStock}
                    >{`${ar.inventory.available}: ${formatQty(p.stockQty)}`}</Text>
                    <ChevronLeft size={16} color={colors.textMuted} />
                  </View>
                }
                onPress={() => setProductId(p.id)}
                testID={`item-card-pick-${p.id}`}
              />
            ))
          )}
        </AppCard>
      </SafeScreen>
    );
  }

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.analytics.itemCard.title}
        subtitle={ar.analytics.itemCard.subtitle}
        onBack={() => router.back()}
        actions={[
          {
            icon: Search,
            label: ar.analytics.itemCard.changeProduct,
            onPress: () => {
              setCard(null);
              setProductId(null);
            },
          },
        ]}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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
                testID={`item-card-period-${key}`}
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
                testID="item-card-custom-from"
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
                testID="item-card-custom-to"
              />
            </View>
          </View>
        ) : null}

        {/* ——— فلتر المخزن (إن تعدد) ——— */}
        {warehouses.length > 1 ? (
          <View>
            <Text style={styles.sectionLabel}>{ar.analytics.paper.warehouse}</Text>
            <View style={styles.chipsRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ar.analytics.allWarehouses}
                onPress={() => setWarehouseId(null)}
                style={({ pressed }) => [
                  styles.periodChip,
                  warehouseId === null && styles.periodChipActive,
                  pressed && styles.chipPressed,
                ]}
                testID="item-card-wh-all"
              >
                <Text style={[styles.periodText, warehouseId === null && styles.periodTextActive]}>
                  {ar.analytics.allWarehouses}
                </Text>
              </Pressable>
              {warehouses.map((w) => {
                const selected = warehouseId === w.id;
                return (
                  <Pressable
                    key={w.id}
                    accessibilityRole="button"
                    accessibilityLabel={w.name}
                    onPress={() => setWarehouseId(w.id)}
                    style={({ pressed }) => [
                      styles.periodChip,
                      selected && styles.periodChipActive,
                      pressed && styles.chipPressed,
                    ]}
                    testID={`item-card-wh-${w.id}`}
                  >
                    <Text style={[styles.periodText, selected && styles.periodTextActive]}>
                      {w.name}
                    </Text>
                  </Pressable>
                );
              })}
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
        ) : card !== null ? (
          <View style={styles.stack}>
            {/* ——— رأس الصنف ——— */}
            <AppCard>
              <View style={styles.headRow}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarLetter}>{card.productName.slice(0, 1)}</Text>
                </View>
                <View style={styles.headTexts}>
                  <Text style={styles.productName}>{card.productName}</Text>
                  <Text style={styles.headMeta}>{`${warehouseName ?? ar.analytics.allWarehouses} · ${formatQty(card.totals.endQty)}${card.unitName ? ` ${card.unitName}` : ''}`}</Text>
                </View>
              </View>
            </AppCard>

            {/* ——— الحركات ——— */}
            <AppCard noPadding>
              <View style={styles.movesHead}>
                <Text style={styles.movesTitle}>{ar.analytics.itemCard.title}</Text>
                <Text style={styles.movesCount}>{`${ar.analytics.itemCard.inTotal} ${formatQty(card.totals.inQty)} · ${ar.analytics.itemCard.outTotal} ${formatQty(card.totals.outQty)}`}</Text>
              </View>

              {card.rows.length === 0 && card.openingBalance === null ? (
                <View style={styles.cardEmpty}>
                  <EmptyState
                    title={ar.analytics.itemCard.empty}
                    message={ar.analytics.itemCard.emptyHint}
                  />
                </View>
              ) : (
                <View>
                  {card.openingBalance !== null ? (
                    <View style={styles.openingRow}>
                      <Text style={styles.openingLabel}>{ar.analytics.itemCard.openingRow}</Text>
                      <Text style={styles.openingValue}>{formatQty(card.openingBalance)}</Text>
                    </View>
                  ) : null}
                  {card.rows.map((m, i) => {
                    const tint = TYPE_TINT[m.movementType] ?? colors.textMuted;
                    const qty = d(m.qty);
                    const showWh = warehouseId === null;
                    return (
                      <View
                        key={m.id}
                        style={[styles.moveRow, i < card.rows.length - 1 && styles.moveDivider]}
                      >
                        <View style={styles.moveBadge}>
                          <View style={[styles.badgeDot, { backgroundColor: `${tint}22` }]}>
                            <Text style={[styles.badgeText, { color: tint }]}>
                              {movementLabel(m.movementType)}
                            </Text>
                          </View>
                        </View>
                        <View style={styles.moveDateCol}>
                          <Text style={styles.moveDate}>{formatDateAr(m.movedAt)}</Text>
                          {showWh ? (
                            <Text style={styles.moveWh} numberOfLines={1}>
                              {m.warehouseName}
                            </Text>
                          ) : null}
                        </View>
                        <Text
                          style={[
                            styles.moveQty,
                            { color: qty.gt(0) ? colors.success : colors.danger },
                          ]}
                        >
                          {`${qty.gt(0) ? '+' : '−'} ${formatQty(m.qty.replace('-', ''))}`}
                        </Text>
                        <Text style={styles.moveRunning}>{formatQty(m.running)}</Text>
                      </View>
                    );
                  })}
                </View>
              )}
            </AppCard>

            {/* ——— تذييل المجاميع ——— */}
            <AppCard>
              <View style={styles.totalsGrid}>
                <TotalCell
                  label={ar.analytics.itemCard.inTotal}
                  value={formatQty(card.totals.inQty)}
                  tone={colors.success}
                />
                <TotalCell
                  label={ar.analytics.itemCard.outTotal}
                  value={formatQty(card.totals.outQty)}
                  tone={colors.danger}
                />
                <TotalCell
                  label={ar.analytics.itemCard.netTotal}
                  value={formatQty(card.totals.netQty)}
                  tone={colors.text}
                />
                <TotalCell
                  label={ar.analytics.itemCard.closing}
                  value={formatQty(card.totals.endQty)}
                  tone={colors.teal}
                  emphasized
                />
              </View>
              {card.unitName ? (
                <Text
                  style={styles.unitNote}
                >{`${ar.inventory.card.unitLabel}: ${card.unitName}`}</Text>
              ) : null}
            </AppCard>

            {/* ——— الإجراءات: ورقة + واتساب ——— */}
            <View style={styles.actionsRow}>
              <PrimaryButton
                label={ar.analytics.itemCard.print}
                icon={Printer}
                tone="primary"
                onPress={() => void onPrint()}
                loading={printing}
                style={styles.actionBtn}
                testID="item-card-print-btn"
              />
              <PrimaryButton
                label={ar.analytics.itemCard.share}
                icon={MessageCircle}
                tone="success"
                onPress={() => void onShare()}
                loading={sharing}
                style={styles.actionBtn}
                testID="item-card-share-btn"
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeScreen>
  );
}

/* ============ خلية مجموع ============ */

function TotalCell({
  label,
  value,
  tone,
  emphasized = false,
}: {
  label: string;
  value: string;
  tone: string;
  emphasized?: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.totalCell, emphasized && styles.totalCellEmph]}>
      <Text style={styles.totalLabel}>{label}</Text>
      <Text style={[styles.totalValue, { color: tone }]}>{value}</Text>
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
  /* ——— رأس الصنف ——— */
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(45, 212, 191, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: colors.teal,
    fontFamily: font.bold,
    fontSize: 22,
    lineHeight: 30,
  },
  headTexts: {
    flex: 1,
    gap: 2,
  },
  productName: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 17,
    lineHeight: 24,
  },
  headMeta: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 18,
  },
  /* ——— الحركات ——— */
  movesHead: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    gap: 2,
  },
  movesTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 21,
  },
  movesCount: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
  },
  cardEmpty: {
    padding: spacing.md,
  },
  openingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: 'rgba(251, 191, 36, 0.10)',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.35)',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  openingLabel: {
    color: colors.warning,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
  },
  openingValue: {
    color: colors.warning,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
  },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: 56,
  },
  moveDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  moveBadge: {
    flexShrink: 1,
  },
  badgeDot: {
    borderRadius: radius.full,
    paddingVertical: 3,
    paddingHorizontal: 10,
    alignSelf: 'flex-start',
  },
  badgeText: {
    fontFamily: font.bold,
    fontSize: 11.5,
    lineHeight: 16,
  },
  moveDateCol: {
    flex: 1,
    gap: 1,
  },
  moveDate: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  moveWh: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 15,
  },
  moveQty: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'left',
  },
  moveRunning: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '700',
    textAlign: 'left',
    minWidth: 56,
  },
  /* ——— المجاميع ——— */
  totalsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  totalCell: {
    flexBasis: '47%',
    flexGrow: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: spacing.md,
    gap: 3,
  },
  totalCellEmph: {
    borderColor: colors.teal,
  },
  totalLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  totalValue: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 18,
    lineHeight: 26,
  },
  unitNote: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    marginTop: spacing.xs,
  },
  /* ——— المنتقي والإجراءات ——— */
  pickerEmpty: {
    paddingVertical: spacing.md,
  },
  pickTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  pickStock: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  actionBtn: {
    flex: 1,
  },
});
