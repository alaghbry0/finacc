/**
 * parties/party-file.tsx — ملف الطرف الأساسي (عميل/مورد بمعامل kind + id):
 * بطاقة معلومات (هاتف/واتساب/عنوان/منطقة + حد الائتمان بثلاثي الحالات + الرصيد
 * الافتتاحي بعملته وسعره وتاريخه) + **بطاقة الأرصدة لكل عملة** (FR-08-11 —
 * Task 11: getPartyBalanceByCurrency مفصولة لا مجمّعة) مع زر «كشف الحساب»
 * الحقيقي (FR-03-04) + فواتير الطرف (رقم + تاريخ + إجمالي بعملتها + شريحة
 * الحالة) + أزرار تحصيل/دفع وتعديل.
 * الحالات: Skeleton / Error(retry) / فواتير فراغ صادق.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown, ChevronUp, ClipboardList, Pencil, ReceiptText, ArrowDownCircle, ArrowUpCircle } from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  getCustomer,
  getSupplier,
  type PartyRow,
} from '@/domain/parties';
import {
  getPartyBalanceByCurrency,
  type PartyCurrencyBalance,
} from '@/domain/statement';
import {
  fetchPartyInvoices,
  listActiveCurrencies,
  listCheques,
  type ChequeListRow,
  type CurrencyLite,
  type PartyInvoiceRow,
} from '@/db/queries';
import { ar, t, type ArPath } from '@/i18n/ar';
import { colors, font, spacing } from '@/theme';
import {
  formatAmount,
  formatDateAr,
  formatDayShortAr,
  formatQty,
} from '@/utils/format';
import { d } from '@/utils/money';
import { technicalText } from '@/utils/validation';
import AmountText from '@/components/ui/AmountText';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import ListRow from '@/components/ui/ListRow';
import LoadingState from '@/components/ui/LoadingState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import StatusChip, { type ChipKind } from '@/components/ui/StatusChip';
import TagChip from '@/components/ui/TagChip';
import ChequeStatusBadge from '@/components/cheques/ChequeStatusBadge';

type PartyKind = 'customer' | 'supplier';

const DOC_PATHS: Record<string, ArPath> = {
  sale: 'parties.doc.sale',
  purchase: 'parties.doc.purchase',
  sale_return: 'parties.doc.sale_return',
  purchase_return: 'parties.doc.purchase_return',
};

function docLabel(type: string): string {
  const path = DOC_PATHS[type];
  return path ? t(path) : type;
}

/** خريطة حالة الفاتورة → شريحة StatusChip (المسودة بلا رقم تُوسم نصياً) */
function chipFor(inv: PartyInvoiceRow): ChipKind {
  if (inv.status === 'draft') return 'draft';
  if (inv.status === 'void') return 'void';
  switch (inv.payStatus) {
    case 'cash':
      return 'cash';
    case 'credit':
      return 'credit';
    case 'mixed':
      return 'mixed';
    default:
      return 'pending';
  }
}

type FileState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'ready'; data: { party: PartyRow; invoices: PartyInvoiceRow[]; currencies: CurrencyLite[]; balances: PartyCurrencyBalance[]; cheques: ChequeListRow[] } };

export default function PartyFileScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ kind?: string; id?: string }>();
  const kind: PartyKind = params.kind === 'supplier' ? 'supplier' : 'customer';
  const partyId = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;

  const [state, setState] = useState<FileState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [chequesOpen, setChequesOpen] = useState(false); // بطاقة «شيكاته» قابلة للطي
  const firstLoad = useRef(true);

  const load = useCallback(() => {
    void reload; // إعادة تشغيل مقصودة عند العودة من شاشة النموذج
    if (partyId === null) {
      setState({ kind: 'error', technical: 'INVALID_ID' });
      return;
    }
    setState((prev) => (firstLoad.current || prev.kind === 'error' ? { kind: 'loading' } : prev));
    firstLoad.current = false;
    let alive = true;
    (async () => {
      const db = await getDb();
      const [party, invoices, currencies, balances, cheques] = await Promise.all([
        kind === 'customer' ? getCustomer(db, partyId) : getSupplier(db, partyId),
        fetchPartyInvoices(
          db,
          kind === 'customer' ? { customerId: partyId } : { supplierId: partyId },
        ),
        listActiveCurrencies(db),
        getPartyBalanceByCurrency(db, kind, partyId),
        listCheques(db, { partyType: kind, partyId }), // شيكاته (FR-14-05)
      ]);
      if (!alive) return;
      if (!party) {
        setState({ kind: 'error', technical: ar.parties.file.notFound });
        return;
      }
      setState({ kind: 'ready', data: { party, invoices, currencies, balances, cheques } });
    })().catch((err: unknown) => {
      if (alive) setState({ kind: 'error', technical: technicalText(err) });
    });
    return () => {
      alive = false;
    };
  }, [kind, partyId, reload]);

  useEffect(load, [load]);

  /* تحديث عند العودة من النموذج */
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setReload((r) => r + 1);
    }, []),
  );

  if (state.kind === 'loading') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.parties.listTitle} onBack={() => router.back()} />
        <LoadingState variant="card" />
      </SafeScreen>
    );
  }
  if (state.kind === 'error') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.parties.listTitle} onBack={() => router.back()} />
        <ErrorState
          message={ar.parties.file.errorLoad}
          technical={state.technical}
          onRetry={() => setReload((r) => r + 1)}
        />
      </SafeScreen>
    );
  }

  const { party, invoices, currencies, balances, cheques } = state.data;
  const isCustomer = kind === 'customer';
  const openingCurrency = currencies.find((c) => c.id === party.openingCurrencyId) ?? null;
  const hasOpening = d(party.openingBalance).gt(0);
  const credit = party.creditLimit;
  const isZero = credit !== null && d(credit).isZero();

  return (
    <SafeScreen offline={false}>
      <ScreenHeader
        title={party.name}
        onBack={() => router.back()}
        actions={[
          {
            icon: Pencil,
            label: ar.parties.file.edit,
            onPress: () =>
              router.push({
                pathname: '/parties/party-edit',
                params: { kind, id: String(party.id) },
              }),
          },
        ]}
      />

      {/* بطاقة المعلومات */}
      <AppCard>
        {party.isArchived ? (
          <View style={styles.chipsRow}>
            <TagChip label={ar.parties.archivedChip} color={colors.warning} />
          </View>
        ) : null}
        {party.phone ? <InfoRow label={ar.parties.file.phone} value={party.phone} mono /> : null}
        {isCustomer && party.whatsapp ? (
          <InfoRow label={ar.parties.file.whatsapp} value={party.whatsapp} mono />
        ) : null}
        {party.address ? <InfoRow label={ar.parties.file.address} value={party.address} /> : null}
        {isCustomer && party.area ? (
          <InfoRow label={ar.parties.file.area} value={party.area} />
        ) : null}

        {isCustomer ? (
          <View style={styles.creditRow}>
            <Text style={styles.infoLabel}>{ar.parties.file.creditLimit}</Text>
            {credit === null ? (
              <Text style={styles.creditNone}>{ar.parties.file.creditNoLimit}</Text>
            ) : isZero ? (
              <TagChip
                label={ar.parties.file.creditBlocked}
                color={colors.danger}
                background="rgba(248, 113, 113, 0.12)"
              />
            ) : (
              <AmountText
                value={credit}
                tone="warning"
                currency={openingCurrency?.code}
                decimals={openingCurrency?.decimals ?? 2}
                size="sm"
                hint={ar.parties.creditLimitPrefix}
              />
            )}
          </View>
        ) : null}

        <View style={styles.openingBox}>
          <Text style={styles.infoLabel}>
            {isCustomer ? ar.parties.file.openingForCustomer : ar.parties.file.openingForSupplier}
          </Text>
          {hasOpening ? (
            <View style={styles.openingValues}>
              <AmountText
                value={party.openingBalance}
                currency={openingCurrency?.code}
                decimals={openingCurrency?.decimals ?? 2}
                size="md"
              />
              <Text style={styles.openingMeta}>
                {`${ar.parties.file.asOf} ${formatDateAr(party.openingDate ?? '')}${
                  party.openingRate && d(party.openingRate).gt(0) && !openingCurrency?.isBase
                    ? ` — ${ar.parties.file.rateLabel} ${formatQty(party.openingRate)}`
                    : ''
                }`}
              </Text>
            </View>
          ) : (
            <Text style={styles.openingNone}>{formatAmount(0, 2)}</Text>
          )}
        </View>

        {party.notes ? (
          <View style={styles.notesBox}>
            <Text style={styles.infoLabel}>{ar.parties.file.notes}</Text>
            <Text style={styles.notesText}>{party.notes}</Text>
          </View>
        ) : null}
      </AppCard>

      {/* بطاقة الأرصدة لكل عملة (FR-08-11 — Task 11) + زر كشف الحساب (FR-03-04) */}
      <AppCard noPadding>
        <View style={styles.balancesHead}>
          <Text style={styles.sectionTitle}>{ar.statement.balancesTitle}</Text>
        </View>
        {balances.length === 0 ? (
          <View style={styles.balancesEmptyBox}>
            <Text style={styles.balancesEmpty}>{ar.statement.balancesEmpty}</Text>
          </View>
        ) : (
          balances.map((b, i) => {
            const pos = d(b.balance).gt(0);
            const cur = currencies.find((c) => c.id === b.currencyId);
            return (
              <ListRow
                key={b.currencyId}
                title={b.currencyCode}
                subtitle={
                  isCustomer
                    ? pos
                      ? ar.statement.customerDebit
                      : ar.statement.customerCredit
                    : pos
                      ? ar.statement.supplierDebit
                      : ar.statement.supplierCredit
                }
                divider={i < balances.length - 1}
                trailing={
                  <AmountText
                    value={b.balance}
                    tone={d(b.balance).isZero() ? 'neutral' : pos ? 'warning' : 'success'}
                    currency={b.currencyCode}
                    decimals={cur?.decimals ?? 2}
                    size="md"
                    testID={`party-balance-${b.currencyCode}`}
                  />
                }
                testID={`party-balance-row-${b.currencyCode}`}
              />
            );
          })
        )}
        <View style={styles.statementBtnBox}>
          <PrimaryButton
            label={ar.statement.statementBtn}
            icon={ClipboardList}
            tone="ghost"
            onPress={() =>
              router.push({
                pathname: '/parties/statement',
                params: { partyType: kind, partyId: String(party.id) },
              })
            }
            testID="party-file-statement-btn"
          />
        </View>
      </AppCard>

      {/* شيكاته — بطاقة قابلة للطي (FR-14-05: تبويب شيكات في حركة الأطراف) */}
      <AppCard noPadding>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ar.cheques.partyCard.title}
          accessibilityState={{ expanded: chequesOpen }}
          onPress={() => setChequesOpen((v) => !v)}
          style={styles.chequesHead}
          testID="party-cheques-toggle"
        >
          <View style={styles.chequesHeadTexts}>
            <Text style={styles.sectionTitle}>{ar.cheques.partyCard.title}</Text>
            {cheques.length > 0 ? (
              <Text style={styles.chequesCount}>
                {`${cheques.length} ${ar.cheques.partyCard.count}`}
              </Text>
            ) : null}
          </View>
          {chequesOpen ? (
            <ChevronUp size={18} color={colors.textFaint} />
          ) : (
            <ChevronDown size={18} color={colors.textFaint} />
          )}
        </Pressable>
        {chequesOpen ? (
          cheques.length === 0 ? (
            <View style={styles.chequesEmptyBox}>
              <Text style={styles.chequesEmpty}>{ar.cheques.partyCard.empty}</Text>
            </View>
          ) : (
            cheques.map((c, i) => (
              <ListRow
                key={c.id}
                title={c.chequeNo}
                divider={i < cheques.length - 1}
                subtitleNode={
                  <Text style={styles.chequeDue}>
                    {`${ar.cheques.partyCard.dueOn} ${formatDayShortAr(c.dueDate)}${c.bankName ? ` · ${c.bankName}` : ''}`}
                  </Text>
                }
                trailing={
                  <View style={styles.chequeTrailing}>
                    <AmountText
                      value={c.amount}
                      currency={c.currencyCode}
                      decimals={c.currencyDecimals}
                      size="sm"
                      tone={c.status === 'void' ? 'neutral' : c.direction === 'in' ? 'in' : 'out'}
                    />
                    <ChequeStatusBadge status={c.status} direction={c.direction} />
                  </View>
                }
                onPress={() => router.push(`/cheques/${c.id}`)}
                testID={`party-cheque-${c.id}`}
              />
            ))
          )
        ) : null}
      </AppCard>

      {/* فواتير الطرف */}
      <AppCard noPadding>
        <View style={styles.invoicesHead}>
          <Text style={styles.sectionTitle}>
            {isCustomer ? ar.parties.file.customerInvoices : ar.parties.file.supplierInvoices}
          </Text>
          <Text style={styles.invoicesCount}>{formatQty(invoices.length)}</Text>
        </View>
        {invoices.length === 0 ? (
          <EmptyState icon={ReceiptText} title={ar.parties.file.noInvoices} style={styles.invEmpty} />
        ) : (
          invoices.map((inv, i) => (
            <InvoiceRow key={inv.id} inv={inv} divider={i < invoices.length - 1} />
          ))
        )}
      </AppCard>

      {/* إجراء سريع: تحصيل من العميل / دفع للمورد (Task 10 — سندات النقدية) */}
      <View style={styles.quickRow}>
        {isCustomer ? (
          <PrimaryButton
            label={ar.cash.partyFile.collect}
            icon={ArrowDownCircle}
            tone="success"
            onPress={() => router.push(`/cash/receipt?partyId=${party.id}`)}
            style={styles.quickBtn}
            testID="party-file-collect-btn"
          />
        ) : (
          <PrimaryButton
            label={ar.cash.partyFile.pay}
            icon={ArrowUpCircle}
            tone="primary"
            onPress={() => router.push(`/cash/payment?partyId=${party.id}`)}
            style={styles.quickBtn}
            testID="party-file-pay-btn"
          />
        )}
        <PrimaryButton
          label={ar.parties.file.edit}
          icon={Pencil}
          tone="ghost"
          onPress={() =>
            router.push({ pathname: '/parties/party-edit', params: { kind, id: String(party.id) } })
          }
          style={styles.quickBtn}
          testID="party-file-edit-btn"
        />
      </View>
    </SafeScreen>
  );
}

/* ============ صف معلومة ============ */

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && styles.infoMono]}>{value}</Text>
    </View>
  );
}

/* ============ صف فاتورة ============ */

function InvoiceRow({ inv, divider }: { inv: PartyInvoiceRow; divider: boolean }) {
  const number = inv.invoiceNo ?? ar.invoice.statusDraft;
  return (
    <ListRow
      title={`${docLabel(inv.docType)} — ${number}`}
      divider={divider}
      subtitleNode={<Text style={styles.invDate}>{formatDateAr(inv.issuedAt)}</Text>}
      trailing={
        <View style={styles.invTrailing}>
          <AmountText
            value={inv.total}
            currency={inv.currencyCode}
            decimals={inv.currencyDecimals}
            size="sm"
            tone={inv.status === 'void' ? 'neutral' : undefined}
          />
          <StatusChip kind={chipFor(inv)} />
        </View>
      }
      testID={`party-invoice-${inv.id}`}
    />
  );
}

const styles = StyleSheet.create({
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  invoicesHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  invoicesCount: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  invEmpty: {
    paddingVertical: spacing.md,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 5,
  },
  infoLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  infoValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'left',
    flexShrink: 1,
  },
  infoMono: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
  },
  creditRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 5,
  },
  creditNone: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  openingBox: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    gap: 4,
  },
  openingValues: {
    gap: 2,
  },
  openingMeta: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  openingNone: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
  },
  notesBox: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    gap: 4,
  },
  notesText: {
    color: colors.text,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'right',
  },
  invDate: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  invTrailing: {
    alignItems: 'flex-end',
    gap: 4,
    flexShrink: 1,
  },
  balancesHead: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  balancesEmptyBox: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  balancesEmpty: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'right',
  },
  statementBtnBox: {
    padding: spacing.lg,
    paddingTop: spacing.md,
  },
  editBtn: {
    marginTop: spacing.xs,
  },
  quickRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: spacing.xs,
  },
  quickBtn: {
    flex: 1,
  },
  chequesHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  chequesHeadTexts: {
    flex: 1,
    gap: 1,
  },
  chequesCount: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  chequesEmptyBox: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  chequesEmpty: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  chequeDue: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  chequeTrailing: {
    alignItems: 'flex-end',
    gap: 4,
    flexShrink: 1,
  },
});
