/**
 * reports/sales-by.tsx — المبيعات حسب (Task 17 — FR-09-06 أساسية).
 *
 * المسار: /reports/sales-by (من قسم تقارير المخزون والمبيعات).
 *
 *  - أرقاقة وجهة التجزئة (عميل/فئة/صنف/يوم) + أرقاقة الفترات الجاهزة
 *    (FR-09-09 — «مخصص» بحقلَي من/إلى).
 *  - صف لكل مجموعة: التسمية + عدد الفواتير (صيغ الجمع العربية) + الإجمالي
 *    بعملة الأساس + **شريحة نسبة التغير**: أخضر ↑ صعوداً / كهرماني ↓ هبوطاً
 *    (بعلامة غير لونية دائماً — DS-18) / «جديد» رمادية حين لا سابقة.
 *  - بتجزئة العميل حصراً: عمود المرتجعات للمجموعة.
 *  - تذييل الإجمالي بنسبته + ملاحظة «النسبة مقارنة بالفترة السابقة المساوية
 *    في الطول» + مشاركة واتساب (ملخص نصي — قرار Task 17: بلا ورقة هنا).
 *  - التنقل: صف العميل يفتح ملفه، وصف الصنف يفتح بطاقة صنف المخزون.
 *  - الحالات: Skeleton إلزامي / ErrorState بإعادة محاولة / فراغ صادق /
 *    إعادة تحديث عند العودة (useFocusEffect).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft, MessageCircle, TrendingDown, TrendingUp } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { fetchBaseCurrency, type CurrencyLite } from '@/db/queries';
import { getSalesBreakdown, type SalesBreakdown, type SalesBreakdownBy, type SalesBreakdownRow } from '@/domain/analytics';
import { resolveReportPeriod, type ReportPeriodPreset } from '@/domain/reports';
import { buildSalesByWhatsAppMessage, loadSalesByShareData } from '@/services/analytics-print';
import { waLink, waNumber } from '@/services/share-text';
import { ar, pluralAr } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { formatAmount, formatDateAr, todayISO } from '@/utils/format';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

const BY_KEYS: readonly [SalesBreakdownBy, string][] = [
  ['customer', ar.analytics.salesBy.segs.customer],
  ['category', ar.analytics.salesBy.segs.category],
  ['item', ar.analytics.salesBy.segs.item],
  ['day', ar.analytics.salesBy.segs.day],
];

const PERIOD_PRESETS: readonly [ReportPeriodPreset, string][] = [
  ['today', ar.reports.periods.today],
  ['week', ar.reports.periods.week],
  ['month', ar.reports.periods.month],
  ['quarter', ar.reports.periods.quarter],
  ['year', ar.reports.periods.year],
  ['custom', ar.reports.periods.custom],
];

/** تسمية المجموعات بلا اسم صريح (عميل نقدي/بلا فئة/سطر حر) */
function groupLabel(row: SalesBreakdownRow): string {
  if (row.label !== '') return row.label;
  if (row.refKind === 'customer') return ar.analytics.salesBy.cashCustomer;
  if (row.refKind === 'category') return ar.analytics.salesBy.noCategory;
  return ar.analytics.salesBy.freeLine;
}

export default function SalesByScreen() {
  const router = useRouter();
  const feedback = useFeedback();

  const [by, setBy] = useState<SalesBreakdownBy>('customer');
  const [preset, setPreset] = useState<ReportPeriodPreset>('month');
  const [customFrom, setCustomFrom] = useState(todayISO());
  const [customTo, setCustomTo] = useState(todayISO());

  const [base, setBase] = useState<CurrencyLite | null>(null);
  const [companyWhatsapp, setCompanyWhatsapp] = useState<string | null>(null);
  const [report, setReport] = useState<SalesBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
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

  /* ============ التحميل ============ */

  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = await getDb();
      const [baseCur, companyRows] = await Promise.all([
        fetchBaseCurrency(db),
        db.all<{ whatsapp: string | null }>('SELECT whatsapp FROM company ORDER BY id LIMIT 1'),
      ]);
      if (!alive) return;
      setBase(baseCur);
      setCompanyWhatsapp(companyRows[0]?.whatsapp ?? null);
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
        const data = await getSalesBreakdown(db, {
          from: range.from,
          to: range.to,
          by,
        });
        if (!alive) return;
        setReport(data);
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
  }, [range, by, reload]);

  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setReload((r) => r + 1);
    }, []),
  );

  /* ============ واتساب ============ */

  const onShare = async (): Promise<void> => {
    if (sharing || range === null) return;
    setSharing(true);
    try {
      const db = await getDb();
      const data = await loadSalesByShareData(db, { from: range.from, to: range.to, by });
      const message = buildSalesByWhatsAppMessage(data);
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

  const decimals = base?.decimals ?? 2;
  const baseCode = base?.code ?? '';

  /* التنقل من الصفوف: عميل → ملفه، صنف → بطاقة صنف المخزون */
  const onRowPress = (row: SalesBreakdownRow): void => {
    if (row.refKind === 'customer' && row.refId !== null) {
      router.push({
        pathname: '/parties/party-file',
        params: { kind: 'customer', id: String(row.refId) },
      });
    } else if (row.refKind === 'product' && row.refId !== null) {
      router.push({ pathname: '/inventory/[id]', params: { id: String(row.refId) } });
    }
  };

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.analytics.salesBy.title}
        subtitle={ar.analytics.salesBy.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* ——— وجهة التجزئة ——— */}
        <Text style={styles.sectionLabel}>{ar.analytics.salesBy.title}</Text>
        <View style={styles.chipsRow}>
          {BY_KEYS.map(([key, label]) => {
            const selected = by === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => setBy(key)}
                style={({ pressed }) => [
                  styles.periodChip,
                  selected && styles.periodChipActive,
                  pressed && styles.chipPressed,
                ]}
                testID={`sales-by-seg-${key}`}
              >
                <Text style={[styles.periodText, selected && styles.periodTextActive]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>

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
                testID={`sales-by-period-${key}`}
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
                testID="sales-by-custom-from"
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
                testID="sales-by-custom-to"
              />
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
        ) : report !== null ? (
          <View style={styles.stack}>
            <AppCard noPadding>
              <View style={styles.rowsHead}>
                <Text style={styles.rowsTitle}>
                  {`${ar.analytics.salesBy.title.replace('…', '')} ${ar.analytics.salesBy.segs[report.by]}`}
                </Text>
                <Text style={styles.rowsNote}>{ar.analytics.salesBy.prevNote}</Text>
              </View>

              {report.rows.length === 0 ? (
                <View style={styles.cardEmpty}>
                  <EmptyState
                    title={ar.analytics.salesBy.empty}
                    message={ar.analytics.salesBy.emptyHint}
                  />
                </View>
              ) : (
                report.rows.map((row, i) => {
                  const isDay = report.by === 'day';
                  const label = isDay ? formatDateAr(row.key) : groupLabel(row);
                  const navigable =
                    (row.refKind === 'customer' || row.refKind === 'product') &&
                    row.refId !== null;
                  return (
                    <Pressable
                      key={row.key}
                      accessibilityRole={navigable ? 'button' : 'text'}
                      accessibilityLabel={label}
                      onPress={navigable ? () => onRowPress(row) : undefined}
                      style={({ pressed }) => [
                        styles.groupRow,
                        i < report.rows.length - 1 && styles.rowDivider,
                        pressed && navigable && styles.rowPressed,
                      ]}
                      testID={`sales-by-row-${row.key}`}
                    >
                      <View style={styles.groupTexts}>
                        <Text style={styles.groupLabel} numberOfLines={1}>
                          {label}
                        </Text>
                        <Text style={styles.groupCount}>
                          {pluralAr(row.invoicesCount, ar.analytics.salesBy.invoiceForms)}
                          {by === 'customer' && row.returnsTotal !== '0.0000'
                            ? ` · ${ar.analytics.salesBy.returnsCol} ${formatAmount(row.returnsTotal, decimals)}${baseCode ? ` ${baseCode}` : ''}`
                            : ''}
                        </Text>
                      </View>
                      <View style={styles.groupTrailing}>
                        <ChangeChip changePct={row.changePct} />
                        <Text style={styles.groupTotal}>
                          {`${formatAmount(row.total, decimals)}${baseCode ? ` ${baseCode}` : ''}`}
                        </Text>
                        {navigable ? <ChevronLeft size={16} color={colors.textMuted} /> : null}
                      </View>
                    </Pressable>
                  );
                })
              )}

              {/* ——— تذييل الإجمالي ——— */}
              {report.rows.length > 0 ? (
                <View style={styles.totalsBox}>
                  <View style={styles.totalsRow}>
                    <Text style={styles.totalsTitle}>{ar.analytics.salesBy.totalRow}</Text>
                    <View style={styles.totalsTrailing}>
                      <ChangeChip changePct={report.totals.changePct} />
                      <Text style={styles.totalsValue}>
                        {`${formatAmount(report.totals.total, decimals)}${baseCode ? ` ${baseCode}` : ''}`}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.totalsCount}>
                    {pluralAr(report.totals.invoicesCount, ar.analytics.salesBy.invoiceForms)}
                  </Text>
                </View>
              ) : null}
            </AppCard>

            <PrimaryButton
              label={ar.analytics.salesBy.share}
              icon={MessageCircle}
              tone="success"
              onPress={() => void onShare()}
              loading={sharing}
              testID="sales-by-share-btn"
            />
          </View>
        ) : null}
      </ScrollView>
    </SafeScreen>
  );
}

/* ============ شريحة نسبة التغير ============ */

function ChangeChip({ changePct }: { changePct: number | null }): React.JSX.Element {
  // «جديد» رمادية حين لا سابقة — وبعدها أخضر ↑ / كهرماني ↓ (علامة غير لونية)
  if (changePct === null) {
    return (
      <View style={[styles.chip, styles.chipNew]}>
        <Text style={styles.chipNewText}>{ar.analytics.salesBy.newLabel}</Text>
      </View>
    );
  }
  const up = changePct > 0;
  const flat = changePct === 0;
  const Icon = up ? TrendingUp : TrendingDown;
  const tone = flat ? colors.textMuted : up ? colors.success : colors.warning;
  return (
    <View
      style={[styles.chip, styles.chipChange, { borderColor: `${tone}55`, backgroundColor: `${tone}14` }]}
      accessibilityLabel={`${up ? ar.analytics.salesBy.upLabel : ar.analytics.salesBy.downLabel} ${Math.abs(changePct)}%`}
    >
      <Icon size={11} color={tone} />
      <Text style={[styles.chipChangeText, { color: tone }]}>
        {`${changePct > 0 ? '+' : changePct < 0 ? '−' : ''}${formatAmount(Math.abs(changePct), 1)}%`}
      </Text>
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
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 60,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.07)',
  },
  groupTexts: {
    flex: 1,
    gap: 2,
  },
  groupLabel: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14.5,
    lineHeight: 21,
  },
  groupCount: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
  },
  groupTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  groupTotal: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13.5,
    lineHeight: 20,
    fontWeight: '600',
  },
  /* ——— شريحة التغير ——— */
  chip: {
    borderRadius: radius.full,
    paddingVertical: 3,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    minHeight: 24,
  },
  chipNew: {
    backgroundColor: 'rgba(100, 116, 139, 0.18)',
  },
  chipNewText: {
    color: colors.textMuted,
    fontFamily: font.bold,
    fontSize: 10.5,
    lineHeight: 15,
  },
  chipChange: {
    borderWidth: 1,
  },
  chipChangeText: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600',
  },
  /* ——— التذييل ——— */
  totalsBox: {
    borderTopWidth: 2,
    borderTopColor: colors.teal,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 4,
    backgroundColor: 'rgba(45, 212, 191, 0.05)',
  },
  totalsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  totalsTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  totalsTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  totalsValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 16,
    lineHeight: 23,
    fontWeight: '700',
  },
  totalsCount: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
  },
});
