/**
 * (tabs)/index.tsx — الداشبورد الحقيقي (§6.5): بطاقة ترحيب (اسم المنشأة + التاريخ)
 * + 4 بلاطات بأرقام حية من القاعدة + «أقساط مستحقة اليوم» + «تنبيهات المخزون»
 * + «شيكات تستحق قريباً» (كل بطاقة تدفعك لشاشتها) + رسم 30 يوماً بثلاثين عمود
 * View خالصة (لا مكتبة رسوم) + الحالات الثلاث: Skeleton/Empty/Error (لا بياض أبداً).
 * الأرقام تُقرأ عبر src/db/queries.ts (قراءة فقط — Decimal لا Float).
 */
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { CalendarClock, ChevronLeft, CircleAlert, Landmark, PackageSearch, ShoppingCart, Store } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { loadDashboard, type DashboardData } from '@/db/queries';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch, type AmountTone } from '@/theme';
import { formatAmount, formatCount, formatDateAr, formatDayShortAr, todayISO } from '@/utils/format';
import { d } from '@/utils/money';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import SafeScreen from '@/components/ui/SafeScreen';
import StatTile from '@/components/StatTile';

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical?: string }
  | { kind: 'data'; data: DashboardData };

export default function DashboardScreen() {
  const router = useRouter();
  const session = useSession();
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const today = todayISO();

  const load = useCallback((silent = false) => {
    if (!silent) setState({ kind: 'loading' });
    getDb()
      .then((db) => loadDashboard(db, today))
      .then((data) => setState({ kind: 'data', data }))
      .catch((err: unknown) => {
        setState({
          kind: 'error',
          technical: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      });
  }, [today]);

  // التحميل عند التركيز أول مرة + انعاش صامت عند كل عودة للتبويب (البيع يغيّر الأرقام)
  const firstLoad = useRef(true);
  useFocusEffect(
    useCallback(() => {
      load(!firstLoad.current);
      firstLoad.current = false;
    }, [load]),
  );

  // حرس الجلسة: قبل جهوزيتها أو أثناء القفل — هيكل حي بلا تسريب بيانات
  if (!session.ready || session.locked) {
    return (
      <SafeScreen>
        <AppCard noPadding>
          <LoadingState variant="report" rows={4} />
        </AppCard>
      </SafeScreen>
    );
  }

  const push = (name: string, title: string) => {
    router.push({ pathname: '/stub/[name]', params: { name, title } });
  };

  return (
    <SafeScreen>
      {state.kind === 'loading' ? (
        <AppCard noPadding>
          <LoadingState variant="report" rows={4} />
        </AppCard>
      ) : state.kind === 'error' ? (
        <AppCard noPadding>
          <ErrorState message={ar.errors.dashboard} technical={state.technical} onRetry={load} />
        </AppCard>
      ) : !state.data.company ? (
        <AppCard noPadding>
          <EmptyState
            icon={Store}
            title={ar.dashboard.notSetup}
            message={ar.dashboard.notSetupHint}
            actionLabel={ar.dashboard.notSetupAction}
            actionDisabled
          />
        </AppCard>
      ) : (
        <DashboardBody data={state.data} today={today} push={push} />
      )}
    </SafeScreen>
  );
}

function DashboardBody({
  data,
  today,
  push,
}: {
  data: DashboardData;
  today: string;
  push: (name: string, title: string) => void;
}) {
  const router = useRouter();
  const { company, stats, alerts } = data;
  if (!company) return null; // محسوم في الأب — حرس الأنواع فقط
  const dec = company.currencyDecimals;
  const cashNetD = d(stats.cashNet);
  const cashTone: AmountTone = cashNetD.gt(0) ? 'in' : cashNetD.lt(0) ? 'out' : 'neutral';
  const emptyDay = stats.invoiceCount === 0 && d(stats.salesTotal).isZero();

  return (
    <>
      {/* بطاقة الترحيب — اسم المنشأة من الجلسة الحية */}
      <AppCard>
        <View style={styles.welcomeRow}>
          <View style={styles.welcomeIcon}>
            <Store size={26} color={colors.accent} />
          </View>
          <View style={styles.welcomeTexts}>
            <Text style={styles.greeting}>{`${ar.dashboard.greeting} ${company.name}`}</Text>
            <Text style={styles.todayDate}>{formatDateAr(today)}</Text>
          </View>
        </View>
      </AppCard>

      {/* البلاطات الأربع — أرقام حية */}
      <View style={styles.grid}>
        <StatTile
          title={ar.dashboard.salesToday}
          value={stats.salesTotal}
          tone="in"
          decimals={dec}
        />
        <StatTile
          title={ar.dashboard.profitToday}
          value={stats.profitTotal}
          tone="success"
          decimals={dec}
        />
        <StatTile
          title={ar.dashboard.invoicesToday}
          value={String(stats.invoiceCount)}
          isCount
          unit={ar.dashboard.invoiceUnit}
          onPress={() => router.push('/sales')}
        />
        <StatTile
          title={ar.dashboard.cashNetToday}
          value={stats.cashNet}
          tone={cashTone}
          decimals={dec}
        />
      </View>

      {emptyDay ? (
        <AppCard noPadding>
          <EmptyState
            icon={ShoppingCart}
            title={ar.dashboard.firstInvoiceTitle}
            message={ar.dashboard.firstInvoiceHint}
            actionLabel={ar.dashboard.firstInvoiceAction}
            onAction={() => router.push('/sales/new')}
          />
        </AppCard>
      ) : null}

      {/* بطاقات المتابعة — كل واحدة تدفع لشاشتها */}
      <AlertCard
        icon={CalendarClock}
        iconColor={colors.warning}
        title={ar.dashboard.installmentsDue}
        hint={ar.dashboard.installmentsDueHint}
        count={alerts.installmentsDue}
        unit={ar.dashboard.installmentUnit}
        onPress={() => router.push('/more/installments')} // شاشة الأقساط الحقيقية (FR-05 — Task 14)
      />
      <AlertCard
        icon={PackageSearch}
        iconColor={colors.accent}
        title={ar.dashboard.stockAlerts}
        hint={ar.dashboard.stockAlertsHint}
        count={alerts.lowStock}
        unit={ar.dashboard.stockUnit}
        onPress={() => router.push('/reports/below-min')} // تقرير الأصناف تحت الحد الأدنى (FR-09-12 — Task 17)
      />
      <AlertCard
        icon={Landmark}
        iconColor={colors.teal}
        title={ar.dashboard.chequesSoon}
        hint={ar.dashboard.chequesSoonHint}
        count={alerts.chequesDueSoon}
        unit={ar.dashboard.chequeUnit}
        onPress={() => router.push('/more/cheques')} // شاشة الشيكات الحقيقية (FR-14)
      />
      {alerts.bouncedCheques > 0 ? (
        <AlertCard
          icon={CircleAlert}
          iconColor={colors.danger}
          title={ar.cheques.dashboard.bouncedAlert}
          hint={ar.cheques.dashboard.bouncedAlertHint}
          count={alerts.bouncedCheques}
          unit={ar.cheques.dashboard.bouncedUnit}
          onPress={() => router.push('/more/cheques')} // FR-14-04: تنبيه بارز للمرتدة
        />
      ) : null}

      {/* رسم 30 يوماً — أعمدة View خالصة (لا مكتبات) */}
      <AppCard>
        <Text style={styles.cardTitle}>{ar.dashboard.sparkTitle}</Text>
        <Sparkline days={data.spark} dec={dec} />
      </AppCard>
    </>
  );
}

/* ============ بطاقة تنبيه (عنوان + عدد + سهم) ============ */

function AlertCard({
  icon: Icon,
  iconColor,
  title,
  hint,
  count,
  unit,
  onPress,
}: {
  icon: typeof CalendarClock;
  iconColor: string;
  title: string;
  hint: string;
  count: number;
  unit: string;
  onPress: () => void;
}) {
  const has = count > 0;
  return (
    <AppCard onPress={onPress}>
      <View style={styles.alertRow}>
        <View style={[styles.alertIcon, { backgroundColor: `${iconColor}22` }]}>
          <Icon size={22} color={iconColor} />
        </View>
        <View style={styles.alertTexts}>
          <Text style={styles.alertTitle}>{title}</Text>
          <Text style={styles.alertHint}>{hint}</Text>
        </View>
        <View style={styles.alertTrailing}>
          {has ? (
            <>
              <Text style={[styles.alertCount, { color: iconColor }]}>{formatCount(count)}</Text>
              <Text style={styles.alertUnit}>{unit}</Text>
            </>
          ) : (
            <Text style={styles.alertNone}>{ar.dashboard.nothingDue}</Text>
          )}
          <ChevronLeft size={18} color={colors.textFaint} />
        </View>
      </View>
    </AppCard>
  );
}

/* ============ الرسم الشريطي — 30 يوماً تفاعلي (أعمدة View خالصة) ============ */

/**
 * Sparkline v2 — ثلاثون عموداً بمجموعات أسبوعية وفوارق بصرية:
 *  - عمود «اليوم» بلون التمييز والبقية بتدرّج عتامة حسب قيمتها (خريطة حرارة)
 *  - أيام الصفر كعبوات خافتة 3px (تمييز «لا بيع» عن «بيع قليل»)
 *  - أعلى يوم عموده أسطع + رقاقة إحصاء: المجموع/المتوسط/أعلى يوم
 *  - نقر أي عمود يعرض سطر تفاصيله (التاريخ + المبلغ) ويبقى حتى النقر مجدداً
 *  - فاصل أعرض بعد كل 7 أيام (إيقاع أسابيع بصري) — الترتيب RTL: الأقدم يميناً
 */
function Sparkline({ days, dec }: { days: { day: string; total: string }[]; dec: number }) {
  const [sel, setSel] = useState<number | null>(null);
  const values = days.map((x) => d(x.total));
  const max = values.reduce((m, v) => (v.gt(m) ? v : m), d(0));
  if (max.isZero()) {
    return <Text style={styles.sparkEmpty}>{ar.dashboard.sparkHint}</Text>;
  }
  const sum = values.reduce((s, v) => s.plus(v), d(0));
  const avg = sum.div(days.length || 1);
  const maxIdx = values.reduce((mi, v, i) => (v.gt(values[mi]!) ? i : mi), 0);
  const bestDay = days[maxIdx]?.day ?? '';
  const selDay = sel !== null && days[sel] ? days[sel] : null;

  return (
    <View>
      {/* رقاقات الإحصاء */}
      <View style={styles.sparkStats}>
        <View style={styles.sparkChip}>
          <Text style={styles.sparkChipLabel}>{ar.dashboard.sparkTotal}</Text>
          <Text style={styles.sparkChipValue}>{formatAmount(sum.toString(), dec)} ر.ي</Text>
        </View>
        <View style={styles.sparkChip}>
          <Text style={styles.sparkChipLabel}>{ar.dashboard.sparkAvg}</Text>
          <Text style={styles.sparkChipValue}>{formatAmount(avg.toString(), dec)} ر.ي</Text>
        </View>
        <View style={[styles.sparkChip, styles.sparkChipBest]}>
          <Text style={styles.sparkChipLabel}>{ar.dashboard.sparkBest}</Text>
          <Text style={styles.sparkChipValue}>{formatDayShortAr(bestDay)}</Text>
        </View>
      </View>

      {/* الأعمدة */}
      <View style={styles.sparkRow} accessibilityLabel={ar.dashboard.sparkTitle}>
        {values.map((v, i) => {
          const zero = v.isZero();
          const ratio = v.div(max).toNumber();
          const height = zero ? 3 : Math.max(5, Math.round(ratio * 56));
          const isLast = i === values.length - 1;
          const isMax = i === maxIdx && !zero;
          const isSel = sel === i;
          // عتامة متدرجة 0.30→0.92 حسب النسبة — خريطة حرارة بصرية
          const opacity = zero ? 0.16 : 0.3 + 0.62 * ratio;
          const weekBreak = i % 7 === 6 && i !== values.length - 1;
          return (
            <Pressable
              key={days[i].day}
              onPress={() => setSel(sel === i ? null : i)}
              accessibilityLabel={`${formatDateAr(days[i].day)} — ${
                zero ? ar.dashboard.sparkNoSales : `${formatAmount(v.toString(), dec)} ر.ي`
              }`}
              accessibilityRole="button"
              style={[styles.sparkHit, weekBreak && styles.sparkWeekBreak]}
            >
              <View
                style={[
                  styles.sparkBar,
                  { height },
                  zero && styles.sparkBarZero,
                  isLast && styles.sparkBarLast,
                  isMax && !isLast && styles.sparkBarMax,
                  isSel && styles.sparkBarSel,
                  !isLast && !isMax && !isSel && !zero && { opacity },
                ]}
              />
            </Pressable>
          );
        })}
      </View>

      {/* سطر التفاصيل: اليوم المختار أو دليل التسميات */}
      {selDay ? (
        <View style={styles.sparkSelRow}>
          <Text style={styles.sparkSelDate}>{formatDateAr(selDay.day)}</Text>
          <Text style={styles.sparkSelValue}>
            {d(selDay.total).isZero()
              ? ar.dashboard.sparkNoSales
              : `${formatAmount(selDay.total, dec)} ر.ي`}
          </Text>
        </View>
      ) : (
        <View style={styles.sparkLabels}>
          <Text style={styles.sparkLabel}>{formatDayShortAr(days[0]?.day ?? todayISO())}</Text>
          <Text style={styles.sparkLabel}>{ar.dashboard.sparkPickHint}</Text>
          <Text style={styles.sparkLabel}>{ar.dashboard.sparkLast}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  welcomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  welcomeIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
  },
  welcomeTexts: {
    flex: 1,
    gap: 1,
  },
  greeting: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 20,
    lineHeight: 28,
  },
  todayDate: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  cardTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
  },
  alertIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertTexts: {
    flex: 1,
    gap: 1,
  },
  alertTitle: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  alertHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  alertTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  alertCount: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 17,
    lineHeight: 24,
  },
  alertUnit: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  alertNone: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  sparkStats: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: spacing.md,
  },
  sparkChip: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 1,
    alignItems: 'center',
  },
  sparkChipBest: {
    borderColor: 'rgba(52, 211, 153, 0.45)',
    backgroundColor: 'rgba(52, 211, 153, 0.08)',
  },
  sparkChipLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 10,
    lineHeight: 14,
  },
  sparkChipValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    fontVariant: ['tabular-nums'],
  },
  sparkRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
    height: 64,
  },
  sparkHit: {
    flex: 1,
    minHeight: touch.min,
    justifyContent: 'flex-end',
  },
  sparkWeekBreak: {
    marginStart: 5,
  },
  sparkBar: {
    flex: 1,
    borderRadius: 2,
    minHeight: 3,
    backgroundColor: 'rgba(34, 211, 238, 0.75)',
  },
  sparkBarZero: {
    backgroundColor: 'rgba(148, 163, 184, 0.35)',
  },
  sparkBarLast: {
    backgroundColor: colors.accent,
  },
  sparkBarMax: {
    backgroundColor: 'rgba(34, 211, 238, 1)',
  },
  sparkBarSel: {
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: '#E2F5FC',
  },
  sparkSelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(34, 211, 238, 0.45)',
    backgroundColor: 'rgba(34, 211, 238, 0.08)',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  sparkSelDate: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  sparkSelValue: {
    color: colors.accent,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 18,
    fontVariant: ['tabular-nums'],
  },
  sparkEmpty: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  sparkLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  sparkLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
});
