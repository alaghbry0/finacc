/**
 * parties/statement.tsx — شاشة كشف حساب الطرف ⭐ (Task 11 — FR-03-04).
 *
 * المسار: /parties/statement?partyType=customer&partyId=N (من ملف الطرف).
 *
 *  - الرأس: اسم الطرف + رقاقة نوعه (عميل/مورد).
 *  - **اختيار عملة الكشف** (FR-08-11): أرقاقة لكل عملة غير صفرية الرصيد
 *    (من getPartyBalanceByCurrency) بمعاينة رصيد داخل الرقاقة + الافتراضي
 *    الأساس أو أول عملة غير صفرية + تنبيه «له رصيد بعملة أخرى».
 *  - **فلاتر الفترة**: الكل / هذا الشهر / آخر 90 يوماً (chips → {from,to}).
 *  - **بطاقة الرصيد**: الختامي كبيراً بAmountText باتجاهه (عميل: مستحق عليه/
 *    له رصيد دائن — مورد: مستحق له علينا/رصيد دائن لصالحك) + رصيد أول المدة
 *    + صف إحصاءات مدين/دائن بعدد الحركات ومجاميعها.
 *  - **السطور** (FlatList): تاريخ قصير + نوع المستند ورقمه + البيان + المبلغ
 *    باتجاهه (▲ زيادة الدين كهرماني / ▼ تسديد أخضر — علامة غير لونية DS-18)
 *    + عمود الرصيد المتحرك (عريض tabular-nums) وآخر سطر مالي بخلفية مميزة.
 *    سطر «note» = لافتة إرشادية (عملات أخرى).
 *  - **أعمار الديون** (FR-03-03): بطاقة قابلة للطي — توزيع الفواتير الآجلة
 *    المفتوحة بهذه العملة على 4 شرائح عمرية (من issued_at للمتبقي غير المسدد
 *    — إعادة استخدام getOpenInvoicesForParty) بأشرطة نسبية وبلغات نقية.
 *    للعملاء فقط (مرآة الموردين: ما علينا نحن).
 *  - **الإجراءات**: طباعة الكشف (printStatement → معاينة ويب/نظام أصلي) +
 *    مشاركة واتساب (buildStatementWhatsAppMessage → wa.me — من واتساب الطرف
 *    أو هاتفه، وإلا «لا يوجد رقم واتساب»).
 *  - الحالات: Skeleton/Error(retry) لبيئة الطرف وخطأ الكشف، فراغ صادق،
 *    وإعادة تحديث عند العودة من شاشات السندات (useFocusEffect).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  ChevronDown,
  ClipboardList,
  Info,
  MessageCircle,
  Printer,
  RotateCcw,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import { getOpenInvoicesForParty, listActiveCurrencies, type CurrencyLite } from '@/db/queries';
import { getCustomer, getSupplier, type PartyRow } from '@/domain/parties';
import {
  getPartyBalanceByCurrency,
  getStatementLines,
  type PartyCurrencyBalance,
  type PartyType,
  type StatementLine,
  type StatementResult,
} from '@/domain/statement';
import { printStatement } from '@/services/print';
import { buildStatementWhatsAppMessage } from '@/services/statement-share';
import { statementShortDate } from '@/services/statement-html';
import { computeAgingBuckets, loadStatementPrintData, type AgingSummary } from '@/services/statement-data';
import { waLink, waNumber } from '@/services/share-text';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { addDaysISO, formatAmount, todayISO } from '@/utils/format';
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
import TagChip from '@/components/ui/TagChip';
import { useFeedback } from '@/components/ui/feedback';

/* ============ الفترات (chips → {from, to}) ============ */

type PeriodPreset = 'all' | 'month' | 'd90';

function periodRange(preset: PeriodPreset): { from?: string; to?: string } {
  const today = todayISO();
  switch (preset) {
    case 'month': {
      const n = new Date();
      const from = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`;
      return { from, to: today };
    }
    case 'd90':
      return { from: addDaysISO(today, -89), to: today };
    default:
      return {};
  }
}

/* ============ ألوان أعمار الديون (شرائح 4) ============ */

const AGING_COLORS = [
  colors.teal, // 0-30: حديث
  colors.warning, // 31-60
  'rgba(248, 113, 113, 0.62)', // 61-90
  colors.danger, // +90
] as const;

const AGING_TONES = ['neutral', 'warning', 'out', 'out'] as const;

/* ثوابت مرجعية مستقرة — تمنع تحذيرات exhaustive-deps وتحفظ التخزين المؤقت */
const NO_CURRENCIES: CurrencyLite[] = [];
const NO_LINES: StatementLine[] = [];

type BootState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | {
      kind: 'ready';
      party: PartyRow;
      balances: PartyCurrencyBalance[];
      currencies: CurrencyLite[];
    };

export default function PartyStatementScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const params = useLocalSearchParams<{ partyType?: string; partyId?: string }>();
  const partyType: PartyType = params.partyType === 'supplier' ? 'supplier' : 'customer';
  const partyId =
    params.partyId && /^\d+$/.test(params.partyId) ? Number(params.partyId) : null;
  const isCustomer = partyType === 'customer';

  const [boot, setBoot] = useState<BootState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [retryStmt, setRetryStmt] = useState(0);

  const [currencyId, setCurrencyId] = useState<number | null>(null);
  const [period, setPeriod] = useState<PeriodPreset>('all');

  const [stmt, setStmt] = useState<StatementResult | null>(null);
  const [stmtLoading, setStmtLoading] = useState(false);
  const [stmtError, setStmtError] = useState<string | null>(null);

  const [aging, setAging] = useState<AgingSummary | null>(null);
  const [agingOpen, setAgingOpen] = useState(true);

  const [printing, setPrinting] = useState(false);
  const [sharing, setSharing] = useState(false);

  const firstFocus = useRef(true);

  /* ============ تهيئة: الطرف + أرصدته لكل عملة + العملات ============ */

  useEffect(() => {
    if (partyId === null) {
      setBoot({ kind: 'error', technical: 'INVALID_ID' });
      return;
    }
    let alive = true;
    setBoot({ kind: 'loading' });
    (async () => {
      const db = await getDb();
      const [party, balances, currencies] = await Promise.all([
        isCustomer ? getCustomer(db, partyId) : getSupplier(db, partyId),
        getPartyBalanceByCurrency(db, partyType, partyId),
        listActiveCurrencies(db),
      ]);
      if (!alive) return;
      if (!party) {
        setBoot({ kind: 'error', technical: ar.statement.notFound });
        return;
      }
      setBoot({ kind: 'ready', party, balances, currencies });
      const base = currencies.find((c) => c.isBase) ?? null;
      setCurrencyId((prev) => {
        if (prev !== null) return prev;
        const inBase = base ? balances.find((b) => b.currencyId === base.id) : undefined;
        return inBase?.currencyId ?? balances[0]?.currencyId ?? base?.id ?? currencies[0]?.id ?? null;
      });
    })().catch((err: unknown) => {
      if (alive) setBoot({ kind: 'error', technical: technicalText(err) });
    });
    return () => {
      alive = false;
    };
  }, [partyType, partyId, isCustomer, reload]);

  /* إعادة تحديث عند العودة من شاشات السندات/الفواتير */
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setReload((r) => r + 1);
    }, []),
  );

  /* ============ سطور الكشف + الأعمار (حسب العملة والفترة) ============ */

  useEffect(() => {
    if (boot.kind !== 'ready' || currencyId === null || partyId === null) {
      setStmt(null);
      setAging(null);
      return;
    }
    let alive = true;
    setStmtLoading(true);
    setStmtError(null);
    const range = periodRange(period);
    (async () => {
      try {
        const db = await getDb();
        const result = await getStatementLines(db, partyType, partyId, currencyId, range);
        if (!alive) return;
        setStmt(result);
        setStmtLoading(false);
        if (isCustomer) {
          const open = await getOpenInvoicesForParty(db, { customerId: partyId });
          if (!alive) return;
          setAging(
            computeAgingBuckets(
              open.filter((i) => i.currencyId === currencyId),
              todayISO(),
            ),
          );
        } else {
          setAging(null);
        }
      } catch (err: unknown) {
        if (!alive) return;
        setStmt(null);
        setAging(null);
        setStmtError(technicalText(err));
        setStmtLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [boot.kind, currencyId, period, partyType, partyId, isCustomer, retryStmt, reload]);

  /* ============ مشتقات العرض ============ */

  const currencies = boot.kind === 'ready' ? boot.currencies : NO_CURRENCIES;
  const currency = useMemo(
    () => currencies.find((c) => c.id === currencyId) ?? null,
    [currencies, currencyId],
  );
  const decimals = currency?.decimals ?? 2;

  /** أرقاقة العملات: غير الصفرية أولاً (+ الأساس/المختارة دائماً حاضرة) */
  const currencyChips = useMemo(() => {
    if (boot.kind !== 'ready') return [] as CurrencyLite[];
    const nonzero = new Set(boot.balances.map((b) => b.currencyId));
    const list = boot.currencies.filter(
      (c) => nonzero.has(c.id) || c.id === currencyId || c.isBase,
    );
    // غير الصفرية أولاً ثم الأساس
    return [...list].sort((a, b) => {
      const an = nonzero.has(a.id) ? 0 : 1;
      const bn = nonzero.has(b.id) ? 0 : 1;
      if (an !== bn) return an - bn;
      return 0;
    });
  }, [boot, currencyId]);

  const balanceOf = useCallback(
    (ccyId: number): string | null => {
      if (boot.kind !== 'ready') return null;
      return boot.balances.find((b) => b.currencyId === ccyId)?.balance ?? null;
    },
    [boot],
  );

  const lines = stmt?.lines ?? NO_LINES;
  const financialLines = useMemo(() => lines.filter((l) => l.direction !== 'none'), [lines]);
  const lastFinancialIdx = lines.length - 1 - [...lines].reverse().findIndex((l) => l.direction !== 'none');

  const closing = stmt?.closingBalance ?? '0';
  const closingVal = d(closing);
  const closingTone = closingVal.isZero() ? 'neutral' : closingVal.gt(0) ? 'warning' : 'success';
  const closingLabel = closingVal.isZero()
    ? ar.statement.balanced
    : isCustomer
      ? closingVal.gt(0)
        ? ar.statement.customerDebit
        : ar.statement.customerCredit
      : closingVal.gt(0)
        ? ar.statement.supplierDebit
        : ar.statement.supplierCredit;

  const debitStats = useMemo(() => {
    const dl = financialLines.filter((l) => l.direction === 'debit');
    return { count: dl.length, sum: dl.reduce((acc, l) => acc.plus(d(l.amount)), d('0')) };
  }, [financialLines]);
  const creditStats = useMemo(() => {
    const cl = financialLines.filter((l) => l.direction === 'credit');
    return { count: cl.length, sum: cl.reduce((acc, l) => acc.plus(d(l.amount)), d('0')) };
  }, [financialLines]);

  /* ============ الإجراءات: طباعة + واتساب ============ */

  const range = periodRange(period);

  const onPrint = async (): Promise<void> => {
    if (printing || currencyId === null || partyId === null) return;
    setPrinting(true);
    try {
      const db = await getDb();
      const res = await printStatement(db, partyType, partyId, currencyId, range);
      feedback.show({ message: res.message });
    } catch (err: unknown) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.statement.printFailed });
    } finally {
      setPrinting(false);
    }
  };

  const onShare = async (): Promise<void> => {
    if (sharing || currencyId === null || partyId === null || boot.kind !== 'ready') return;
    setSharing(true);
    try {
      const db = await getDb();
      const data = await loadStatementPrintData(db, partyType, partyId, currencyId, range);
      const raw = boot.party.whatsapp ?? boot.party.phone ?? null;
      const phone = raw !== null ? waNumber(raw) : null;
      if (!phone) {
        feedback.show({ message: ar.statement.noWhatsapp });
        return;
      }
      await Linking.openURL(waLink(phone, buildStatementWhatsAppMessage(data)));
      feedback.show({ message: ar.statement.shareSent });
    } catch (err: unknown) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.statement.shareFailed });
    } finally {
      setSharing(false);
    }
  };

  /* ============ العرض ============ */

  if (boot.kind === 'loading') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.statement.title} onBack={() => router.back()} />
        <LoadingState variant="card" />
      </SafeScreen>
    );
  }
  if (boot.kind === 'error') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.statement.title} onBack={() => router.back()} />
        <ErrorState
          message={ar.statement.errorLoad}
          technical={boot.technical}
          onRetry={() => setReload((r) => r + 1)}
        />
      </SafeScreen>
    );
  }

  const party = boot.party;
  const otherCurrencies = (stmt?.otherCurrencies ?? []).filter(
    (c) => c.currencyId !== currencyId,
  );

  const listData = lines;
  const showEmpty = !stmtLoading && stmtError === null && stmt !== null && lines.length === 0;

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={party.name}
        subtitle={ar.statement.title}
        onBack={() => router.back()}
        leading={
          <TagChip
            label={isCustomer ? ar.statement.customerChip : ar.statement.supplierChip}
            color={colors.accent}
            background="rgba(34, 211, 238, 0.14)"
          />
        }
      />
      <FlatList
        data={listData}
        keyExtractor={(item, i) => `${item.docKind}-${item.docNo ?? ''}-${item.date}-${i}`}
        renderItem={({ item, index }) => (
          <LineRow
            line={item}
            isLast={index === lastFinancialIdx}
            decimals={decimals}
            currencyCode={currency?.code ?? ''}
          />
        )}
        ListHeaderComponent={
          <View style={styles.headerStack}>
            {/* عملة الكشف (FR-08-11) */}
            <SectionLabel label={ar.statement.currencyLabel} />
            <View style={styles.chipsRow}>
              {currencyChips.map((c) => {
                const bal = balanceOf(c.id);
                const selected = c.id === currencyId;
                return (
                  <Pressable
                    key={c.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${ar.statement.currencyLabel}: ${c.code}`}
                    onPress={() => setCurrencyId(c.id)}
                    style={({ pressed }) => [
                      styles.ccyChip,
                      selected && styles.ccyChipActive,
                      pressed && styles.chipPressed,
                    ]}
                    testID={`statement-ccy-${c.code}`}
                  >
                    <Text style={[styles.ccyCode, selected && styles.ccyCodeActive]}>{c.code}</Text>
                    {bal !== null ? (
                      <Text
                        style={[styles.ccyBalance, selected && styles.ccyBalanceActive]}
                        numberOfLines={1}
                      >
                        {formatAmount(bal, c.decimals)}
                      </Text>
                    ) : (
                      <Text style={[styles.ccyBalance, selected && styles.ccyBalanceActive]}>
                        —
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
            {otherCurrencies.length > 0 ? (
              <View style={styles.otherCcyBox}>
                <Info size={14} color={colors.warning} />
                <Text style={styles.otherCcyText}>{ar.statement.otherCcyNote}</Text>
              </View>
            ) : null}

            {/* الفترة */}
            <SectionLabel label={ar.statement.periodLabel} />
            <View style={styles.chipsRow}>
              {(
                [
                  ['all', ar.statement.periodAll],
                  ['month', ar.statement.periodMonth],
                  ['d90', ar.statement.period90],
                ] as const
              ).map(([key, label]) => {
                const selected = period === key;
                return (
                  <Pressable
                    key={key}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    onPress={() => setPeriod(key)}
                    style={({ pressed }) => [
                      styles.periodChip,
                      selected && styles.periodChipActive,
                      pressed && styles.chipPressed,
                    ]}
                    testID={`statement-period-${key}`}
                  >
                    <Text style={[styles.periodText, selected && styles.periodTextActive]}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {stmtError !== null ? (
              <ErrorState
                message={ar.statement.errorLoad}
                technical={stmtError}
                onRetry={() => setRetryStmt((r) => r + 1)}
                style={styles.stmtError}
              />
            ) : null}

            {stmtLoading && stmt === null ? (
              <LoadingState variant="card" />
            ) : stmt !== null ? (
              <View style={styles.headerStack}>
                {/* بطاقة الرصيد */}
                <AppCard>
                  <View style={styles.closingHead}>
                    <Text style={styles.closingTitle}>{ar.statement.closingTitle}</Text>
                    <TagChip
                      label={closingLabel}
                      color={closingVal.isZero() ? colors.textMuted : closingVal.gt(0) ? colors.warning : colors.success}
                    />
                  </View>
                  <AmountText
                    value={closing}
                    tone={closingTone}
                    size="display"
                    currency={currency?.code}
                    decimals={decimals}
                    testID="statement-closing"
                  />
                  <View style={styles.statRow}>
                    <View style={styles.statCell}>
                      <Text style={styles.statLabel}>{ar.statement.openingLabel}</Text>
                      <AmountText
                        value={stmt.openingBalance}
                        size="sm"
                        currency={currency?.code}
                        decimals={decimals}
                        tone="neutral"
                      />
                    </View>
                    <View style={styles.statSep} />
                    <View style={styles.statCell}>
                      <Text style={styles.statLabel}>{ar.statement.debitStat}</Text>
                      <Text style={styles.statValue}>
                        <Text style={styles.statCount}>
                          {`${debitStats.count} ${ar.statement.moveUnit} · `}
                        </Text>
                        {formatAmount(debitStats.sum.toString(), decimals)}
                      </Text>
                    </View>
                    <View style={styles.statSep} />
                    <View style={styles.statCell}>
                      <Text style={styles.statLabel}>{ar.statement.creditStat}</Text>
                      <Text style={styles.statValue}>
                        <Text style={styles.statCount}>
                          {`${creditStats.count} ${ar.statement.moveUnit} · `}
                        </Text>
                        {formatAmount(creditStats.sum.toString(), decimals)}
                      </Text>
                    </View>
                  </View>
                </AppCard>

                {/* أعمار الديون (FR-03-03) — العملاء فقط */}
                {isCustomer && aging !== null ? (
                  <AgingCard
                    aging={aging}
                    currencyCode={currency?.code ?? ''}
                    decimals={decimals}
                    open={agingOpen}
                    onToggle={() => setAgingOpen((v) => !v)}
                  />
                ) : null}

                {/* الإجراءات */}
                <View style={styles.actionsRow}>
                  <PrimaryButton
                    label={ar.statement.print}
                    icon={Printer}
                    tone="primary"
                    onPress={() => void onPrint()}
                    loading={printing}
                    style={styles.actionBtn}
                    testID="statement-print-btn"
                  />
                  <PrimaryButton
                    label={ar.statement.share}
                    icon={MessageCircle}
                    tone="success"
                    onPress={() => void onShare()}
                    loading={sharing}
                    style={styles.actionBtn}
                    testID="statement-share-btn"
                  />
                </View>

                {stmtLoading ? (
                  <View style={styles.refreshRow}>
                    <RotateCcw size={14} color={colors.textFaint} />
                    <Text style={styles.refreshText}>{ar.common.loading}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          showEmpty ? (
            <EmptyState
              icon={ClipboardList}
              title={ar.statement.empty}
              message={ar.statement.emptyHint}
              style={styles.emptyList}
            />
          ) : null
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
      {feedback.host}
    </SafeScreen>
  );
}

/* ============ تسمية قسم صغيرة ============ */

function SectionLabel({ label }: { label: string }) {
  return <Text style={styles.sectionLabel}>{label}</Text>;
}

/* ============ صف سطر الكشف ============ */

function LineRow({
  line,
  isLast,
  decimals,
  currencyCode,
}: {
  line: StatementLine;
  isLast: boolean;
  decimals: number;
  currencyCode: string;
}) {
  if (line.docKind === 'note') {
    return (
      <View style={styles.noteBanner} testID="statement-note-line">
        <Info size={15} color={colors.warning} />
        <Text style={styles.noteText}>{line.description}</Text>
      </View>
    );
  }
  const isDebit = line.direction === 'debit';
  const isCredit = line.direction === 'credit';
  const kindLabel = ar.statement.docLabels[line.docKind] ?? line.docKind;
  const dateText =
    line.date && line.date !== '0000-00-00' ? statementShortDate(line.date) : '—';

  return (
    <ListRow
      title={
        line.docNo ? `${kindLabel} ${line.docNo}` : kindLabel
      }
      subtitleNode={
        <View style={styles.lineSub}>
          <Text style={styles.lineDesc} numberOfLines={2}>
            {line.description}
          </Text>
          <Text style={styles.lineDate}>{dateText}</Text>
        </View>
      }
      trailing={
        <View style={[styles.lineSide, isLast && styles.lineSideLast]}>
          <View style={styles.amountRow}>
            <Text
              accessibilityLabel={isDebit ? ar.statement.glyphDebitLabel : ar.statement.glyphCreditLabel}
              style={[styles.glyph, isDebit ? styles.glyphDebit : styles.glyphCredit]}
            >
              {isDebit ? '▲' : isCredit ? '▼' : '·'}
            </Text>
            {isDebit || isCredit ? (
              <AmountText
                value={line.amount}
                tone={isDebit ? 'warning' : 'success'}
                size="sm"
                currency={currencyCode}
                decimals={decimals}
              />
            ) : (
              <Text style={styles.amountNone}>—</Text>
            )}
          </View>
          <View style={styles.runningRow}>
            <Text style={styles.runningLabel}>{ar.statement.runningLabel}</Text>
            <Text
              style={[styles.runningValue, isLast && styles.runningValueLast]}
              numberOfLines={1}
            >
              {formatAmount(line.runningBalance, decimals)}
            </Text>
          </View>
        </View>
      }
      style={isLast ? styles.lineLast : undefined}
      testID={`statement-line-${line.docKind}-${line.docNo ?? 'x'}`}
    />
  );
}

/* ============ بطاقة أعمار الديون (FR-03-03) ============ */

function AgingCard({
  aging,
  currencyCode,
  decimals,
  open,
  onToggle,
}: {
  aging: AgingSummary;
  currencyCode: string;
  decimals: number;
  open: boolean;
  onToggle: () => void;
}) {
  const total = d(aging.total);
  const labels = [
    ar.statement.aging.bucket0,
    ar.statement.aging.bucket1,
    ar.statement.aging.bucket2,
    ar.statement.aging.bucket3,
  ];
  const isEmpty = total.isZero();

  return (
    <AppCard noPadding style={styles.agingCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ar.statement.aging.title}
        onPress={onToggle}
        style={({ pressed }) => [styles.agingHead, pressed && styles.chipPressed]}
        testID="statement-aging-toggle"
      >
        <View style={styles.agingHeadText}>
          <Text style={styles.agingTitle}>{ar.statement.aging.title}</Text>
          <Text style={styles.agingTotal} numberOfLines={1}>
            {`${ar.statement.aging.total}: ${formatAmount(aging.total, decimals)} ${currencyCode}`}
          </Text>
        </View>
        <ChevronDown
          size={20}
          color={colors.textMuted}
          style={open ? styles.chevronOpen : styles.chevronClosed}
        />
      </Pressable>
      {open ? (
        <View style={styles.agingBody}>
          {isEmpty ? (
            <Text style={styles.agingEmpty}>{ar.statement.aging.empty}</Text>
          ) : (
            <>
              <View style={styles.agingBar}>
                {aging.buckets.map((b, i) => {
                  const w = total.gt(0) ? d(b.amount).div(total).toNumber() : 0;
                  if (w <= 0) return null;
                  return (
                    <View
                      key={b.index}
                      style={[
                        styles.agingSeg,
                        { flex: Math.max(w, 0.04), backgroundColor: AGING_COLORS[i] },
                      ]}
                    />
                  );
                })}
              </View>
              <View style={styles.agingLegend}>
                {aging.buckets.map((b, i) => (
                  <View key={b.index} style={styles.agingLegendCell}>
                    <View style={[styles.agingDot, { backgroundColor: AGING_COLORS[i] }]} />
                    <Text style={styles.agingBucketLabel}>{labels[i]}</Text>
                    <AmountText
                      value={b.amount}
                      size="micro"
                      tone={d(b.amount).isZero() ? 'neutral' : AGING_TONES[i]}
                      currency={d(b.amount).isZero() ? undefined : currencyCode}
                      decimals={decimals}
                    />
                  </View>
                ))}
              </View>
            </>
          )}
          <Text style={styles.agingHint}>{ar.statement.aging.hint}</Text>
        </View>
      ) : null}
    </AppCard>
  );
}

/* ============ الأنماط ============ */

const styles = StyleSheet.create({
  listContent: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  headerStack: {
    gap: spacing.sm,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.xs,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chipPressed: {
    opacity: 0.7,
  },
  /* ——— أرقاقة العملات ——— */
  ccyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingVertical: 5,
    paddingHorizontal: 10,
    minHeight: 34,
  },
  ccyChipActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(34, 211, 238, 0.14)',
  },
  ccyCode: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 12,
    lineHeight: 17,
  },
  ccyCodeActive: {
    color: colors.accent,
  },
  ccyBalance: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 16,
    maxWidth: 110,
  },
  ccyBalanceActive: {
    color: colors.textMuted,
  },
  otherCcyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.35)',
    backgroundColor: 'rgba(251, 191, 36, 0.08)',
    borderRadius: radius.md,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  otherCcyText: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
  },
  /* ——— أرقاقة الفترة ——— */
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
  stmtError: {
    marginTop: spacing.xs,
  },
  /* ——— بطاقة الرصيد ——— */
  closingHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: 6,
  },
  closingTitle: {
    color: colors.textMuted,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  statCell: {
    flex: 1,
    gap: 2,
    alignItems: 'flex-start',
  },
  statSep: {
    width: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.sm,
  },
  statLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  statValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  statCount: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
  },
  /* ——— الأعمار ——— */
  agingCard: {
    overflow: 'hidden',
  },
  agingHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    padding: spacing.lg,
    minHeight: touch.min,
  },
  agingHeadText: {
    flex: 1,
    gap: 2,
  },
  agingTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  agingTotal: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  chevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  chevronClosed: {},
  agingBody: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  agingBar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: radius.full,
    overflow: 'hidden',
    backgroundColor: 'rgba(148, 163, 184, 0.18)',
  },
  agingSeg: {
    height: '100%',
  },
  agingLegend: {
    flexDirection: 'row',
    gap: 6,
  },
  agingLegendCell: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  agingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  agingBucketLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 10.5,
    lineHeight: 15,
    textAlign: 'center',
  },
  agingEmpty: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 19,
    textAlign: 'center',
    paddingVertical: spacing.sm,
  },
  agingHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
  },
  /* ——— الإجراءات ——— */
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: spacing.xs,
  },
  actionBtn: {
    flex: 1,
  },
  refreshRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: spacing.xs,
  },
  refreshText: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  /* ——— سطر الكشف ——— */
  lineSub: {
    gap: 2,
    marginTop: 2,
    maxWidth: '100%',
  },
  lineDesc: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  lineDate: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 16,
  },
  lineSide: {
    alignItems: 'flex-end',
    gap: 4,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minWidth: 110,
  },
  lineSideLast: {
    backgroundColor: 'rgba(34, 211, 238, 0.10)',
  },
  lineLast: {
    backgroundColor: 'rgba(34, 211, 238, 0.06)',
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  glyph: {
    fontSize: 11,
    lineHeight: 15,
  },
  glyphDebit: {
    color: colors.warning,
  },
  glyphCredit: {
    color: colors.success,
  },
  amountNone: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
  },
  runningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  runningLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 10,
    lineHeight: 14,
  },
  runningValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  runningValueLast: {
    fontFamily: font.bold,
    fontSize: 13,
  },
  noteBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.35)',
    backgroundColor: 'rgba(251, 191, 36, 0.08)',
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  noteText: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
  },
  emptyList: {
    paddingVertical: spacing.xl,
  },
});
