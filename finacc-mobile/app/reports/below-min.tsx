/**
 * reports/below-min.tsx — الأصناف تحت الحد الأدنى (Task 17 — FR-09-12 ثانوية).
 *
 * المسار: /reports/below-min (من قسم تقارير المخزون والمبيعات).
 *
 *  - عدّاد رأسي بصيغ الجمع العربية (X صنفاً تحت الحد) + صف لكل صنف: الاسم
 *    والوحدة + المتاح والحد + **شارة النقص** الحمراء بالفرق — مرتبة بالنقص
 *    الأكبر أولاً (من الدومين). النقر يفتح بطاقة الصنف في المخزون.
 *  - صندوق «كلفة سدّ النقص تقديرياً» بمتوسط التكلفة (WAC) بعملة الأساس
 *    + تلميح التسديد: شراء أو تسوية جرد (الكمية لا تُعدّل يدوياً).
 *  - «الراكد 90 يوماً» مؤجل V1.1 كما في الوثيقة — المؤرشف خارج القائمة
 *    (قائمة عمل تشغيلية تطابق عدّاد الداشبورد).
 *  - الحالات: Skeleton إلزامي / ErrorState بإعادة محاولة / فراغ صادق
 *    مفرح («كل أصنافك فوق حدّها») / إعادة تحديث عند العودة (useFocusEffect).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft, PackageSearch } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { fetchBaseCurrency, type CurrencyLite } from '@/db/queries';
import { getBelowMinimum, type BelowMinimumReport } from '@/domain/analytics';
import { ar, pluralAr } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { formatAmount, formatQty } from '@/utils/format';
import { technicalText } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';

export default function BelowMinScreen() {
  const router = useRouter();

  const [base, setBase] = useState<CurrencyLite | null>(null);
  const [report, setReport] = useState<BelowMinimumReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const firstFocus = useRef(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const db = await getDb();
        const [data, baseCur] = await Promise.all([
          getBelowMinimum(db),
          fetchBaseCurrency(db),
        ]);
        if (!alive) return;
        setReport(data);
        setBase(baseCur);
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
  }, [reload]);

  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setReload((r) => r + 1);
    }, []),
  );

  const decimals = base?.decimals ?? 2;
  const baseCode = base?.code ?? '';

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.analytics.belowMin.title}
        subtitle={ar.analytics.belowMin.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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
            {/* ——— العدّاد ——— */}
            <View style={styles.countBox}>
              <PackageSearch size={18} color={report.rows.length > 0 ? colors.warning : colors.success} />
              <Text
                style={[
                  styles.countText,
                  { color: report.rows.length > 0 ? colors.warning : colors.success },
                ]}
              >
                {pluralAr(report.rows.length, ar.analytics.belowMin.countForms)}
              </Text>
            </View>

            {report.rows.length === 0 ? (
              <AppCard noPadding>
                <View style={styles.cardEmpty}>
                  <EmptyState
                    title={ar.analytics.belowMin.empty}
                    message={ar.analytics.belowMin.emptyHint}
                  />
                </View>
              </AppCard>
            ) : (
              <AppCard noPadding>
                {report.rows.map((r, i) => (
                  <Pressable
                    key={r.productId}
                    accessibilityRole="button"
                    accessibilityLabel={r.name}
                    onPress={() =>
                      router.push({ pathname: '/inventory/[id]', params: { id: String(r.productId) } })
                    }
                    style={({ pressed }) => [
                      styles.row,
                      i < report.rows.length - 1 && styles.rowDivider,
                      pressed && styles.rowPressed,
                    ]}
                    testID={`below-min-row-${r.productId}`}
                  >
                    <View style={styles.rowTexts}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {r.name}
                      </Text>
                      <Text style={styles.rowMeta}>
                        {`${ar.analytics.belowMin.stockCol} ${formatQty(r.stockQty)} · ${ar.analytics.belowMin.minCol} ${formatQty(r.minQty)}`}
                      </Text>
                    </View>
                    <View style={styles.rowTrailing}>
                      <View style={styles.deficitBadge}>
                        <Text style={styles.deficitText}>
                          {`${ar.analytics.belowMin.deficitCol} ${formatQty(r.deficitQty)}`}
                        </Text>
                      </View>
                      <ChevronLeft size={16} color={colors.textMuted} />
                    </View>
                  </Pressable>
                ))}

                {/* ——— كلفة السد التقديرية ——— */}
                <View style={styles.replenishBox}>
                  <View style={styles.replenishHead}>
                    <Text style={styles.replenishLabel}>
                      {ar.analytics.belowMin.replenishLabel}
                    </Text>
                    <Text style={styles.replenishValue}>
                      {`${formatAmount(report.replenishValue, decimals)}${baseCode ? ` ${baseCode}` : ''}`}
                    </Text>
                  </View>
                  <Text style={styles.replenishHint}>{ar.analytics.belowMin.replenishHint}</Text>
                </View>
              </AppCard>
            )}

            {/* ——— تلميح التسديد ——— */}
            <Text style={styles.footHint}>{ar.analytics.belowMin.hint}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeScreen>
  );
}

/* ============ الأنماط ============ */

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
  },
  stack: {
    gap: spacing.sm,
  },
  countBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.4)',
    backgroundColor: 'rgba(251, 191, 36, 0.08)',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignSelf: 'flex-start',
  },
  countText: {
    fontFamily: font.bold,
    fontSize: 13.5,
    lineHeight: 19,
  },
  cardEmpty: {
    padding: spacing.md,
  },
  row: {
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
  rowTexts: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14.5,
    lineHeight: 21,
  },
  rowMeta: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  rowTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  deficitBadge: {
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.5)',
    backgroundColor: 'rgba(248, 113, 113, 0.14)',
    paddingVertical: 3,
    paddingHorizontal: 10,
  },
  deficitText: {
    color: colors.danger,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11.5,
    lineHeight: 16,
    fontWeight: '600',
  },
  replenishBox: {
    borderTopWidth: 2,
    borderTopColor: colors.warning,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 4,
    backgroundColor: 'rgba(251, 191, 36, 0.06)',
  },
  replenishHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  replenishLabel: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
  },
  replenishValue: {
    color: colors.warning,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '700',
  },
  replenishHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  footHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 17,
    textAlign: 'center',
  },
});
