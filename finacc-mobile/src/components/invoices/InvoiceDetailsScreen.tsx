/**
 * InvoiceDetailsScreen — تفاصيل المستند المشتركة (بيع/شراء/مرتجعات — Task 8):
 *
 *  مكوّن واحد تستهلكه المساران /sales/[id] و/purchases/[id] بprop
 *  `family` — تفادي التكرار مع فروق عائلية دقيقة فقط:
 *  - رأس: «فاتورة {no}» + شريحة الحالة + شارة «سعر صرف تقديري» (FR-02-20)
 *    + بطاقة نوع المستند (فاتورة شراء/سند مرتجع…).
 *  - بطاقة بيانات: الطرف (عميل/مورّد حسب المستند) + الهاتف (واتساب حقيقي)
 *    + التاريخ + العملة وسعر الصرف.
 *  - جدول البنود + الإجماليات + المدفوع/المتبقي + «الربح لهذه الفاتورة»
 *    (بيع فقط — FR-09-11) وبطاقة «حدّثت التكلفة المرجحة تلقائياً» (شراء — WAC).
 *  - **المرتجعات المرتبطة**: بطاقة تعدّ كل سند مرتجع مرتبط بهذه الفاتورة
 *    (SRN/PRN + الإجمالي + الشريحة) بنقرة إلى صفحته، وشارة «مرتجع على فاتورة
 *    {no}» لمستند المرتجع نفسه (عائلة أصل الأصل).
 *  - الإجراءات: طباعة/مشاركة (المهمة 7) + **مرتجع** (ReturnFlow — Task 8، يُفتح
 *    من هنا للعائلتين؛ معطّل مع نص «فاتورة ملغاة — لا مرتجع عليها») + إلغاء.
 *  - «اطبع بعد الحفظ؟» (FR-02-14): ?print=ask → حوار، ?print=print → فوري،
 *    ثم يُستهلك المعامل (router.setParams) فلا يتكرر.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeftRight,
  CalendarClock,
  ChevronLeft,
  MessageCircle,
  Printer,
  RotateCcw,
  Share2,
  TrendingUp,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  fetchProductDisplay,
  getInvoicePlanSummary,
  listLinkedReturns,
  type InvoicePlanSummaryRow,
  type LinkedReturnRow,
  type ProductDisplay,
} from '@/db/queries';
import { getInvoiceWithItems, voidInvoice, type InvoiceRow, type InvoiceItemRow } from '@/domain/invoicing';
import { getCustomer, getSupplier } from '@/domain/parties';
import { printInvoice } from '@/services/print';
import { shareInvoice } from '@/services/share';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { currencySymbol, formatAmount, formatDateAr, formatDayShortAr, formatQty } from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import { invoiceRoute } from '@/utils/doc-routes';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import ConfirmSheet from '@/components/ui/ConfirmSheet';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import StatusChip, { type ChipKind } from '@/components/ui/StatusChip';
import TagChip from '@/components/ui/TagChip';
import { useFeedback } from '@/components/ui/feedback';

export type InvoiceDetailsFamily = 'sale' | 'purchase';

interface PartyLite {
  name: string;
  phone: string | null;
}

interface CurrencyLiteRow {
  code: string;
  decimals: number;
}

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'notfound' }
  | {
      kind: 'data';
      invoice: InvoiceRow;
      items: InvoiceItemRow[];
      party: PartyLite | null;
      currency: CurrencyLiteRow;
      products: Map<number, ProductDisplay>;
      linkedReturns: LinkedReturnRow[];
      /** رقم فاتورة الأصل لمستند مرتجع — null لغير المرتجعات */
      originalNo: string | null;
      /** ملخص خطة التقسيط — للفواتير الآجلة ذات خطة فقط (FR-05) */
      planSummary: InvoicePlanSummaryRow | null;
    };

const PAY_CHIP: Record<string, ChipKind> = {
  cash: 'cash',
  credit: 'credit',
  mixed: 'mixed',
};

export default function InvoiceDetailsScreen({ family }: { family: InvoiceDetailsFamily }) {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const params = useLocalSearchParams<{ id?: string; print?: string }>();
  const invoiceId = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  /** ?print=ask|print من تدفق «الطباعة عند الحفظ» — يُستهلك مرة واحدة */
  const printParam = params.print === 'ask' || params.print === 'print' ? params.print : null;

  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [voidSheet, setVoidSheet] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [askPrintSheet, setAskPrintSheet] = useState(false);
  const printAskHandledRef = useRef(false);

  const load = useCallback(async () => {
    if (invoiceId === null) {
      setState({ kind: 'notfound' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const db = await getDb();
      const { invoice, items } = await getInvoiceWithItems(db, invoiceId);
      const productIds = items
        .map((it) => (it.product_id !== null ? Number(it.product_id) : 0))
        .filter((n) => n > 0);
      const [curRows, partyRows, products, linkedReturns, originalRows, planSummary] = await Promise.all([
        db.all<{ code: string; decimals: number }>(
          'SELECT code, decimals FROM currency WHERE id = ?',
          [invoice.currency_id],
        ),
        invoice.customer_id !== null
          ? getCustomer(db, Number(invoice.customer_id))
          : invoice.supplier_id !== null
            ? getSupplier(db, Number(invoice.supplier_id))
            : Promise.resolve(null),
        fetchProductDisplay(db, productIds),
        listLinkedReturns(db, invoiceId),
        invoice.original_invoice_id !== null
          ? db.all<{ invoice_no: string | null }>('SELECT invoice_no FROM invoice WHERE id = ?', [
              Number(invoice.original_invoice_id),
            ])
          : Promise.resolve([] as { invoice_no: string | null }[]),
        // بطاقة «خطة تقسيط» — استعلام واحد صارم الشرط: بيع آجل مكتمل فقط (FR-05)
        invoice.doc_type === 'sale' &&
        invoice.pay_status === 'credit' &&
        invoice.status === 'completed'
          ? getInvoicePlanSummary(db, invoiceId)
          : Promise.resolve(null),
      ]);
      setState({
        kind: 'data',
        invoice,
        items,
        party: partyRows ? { name: partyRows.name, phone: partyRows.phone } : null,
        currency: {
          code: curRows[0]?.code ?? '—',
          decimals: Number(curRows[0]?.decimals ?? 2),
        },
        products,
        linkedReturns,
        originalNo: originalRows[0]?.invoice_no ?? null,
        planSummary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('غير موجودة')) {
        setState({ kind: 'notfound' });
        return;
      }
      setState({ kind: 'error', technical: technicalText(err) });
    }
  }, [invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onVoid = async () => {
    if (invoiceId === null || state.kind !== 'data') return;
    setVoiding(true);
    try {
      const db = await getDb();
      await voidInvoice(db, invoiceId, { createdBy: session.user?.id });
      setVoidSheet(false);
      feedback.show({ message: ar.sales.details.voided, durationMs: 7000 });
      await load();
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.sales.details.errorLoad });
    } finally {
      setVoiding(false);
    }
  };

  const onPrint = async () => {
    if (invoiceId === null) return;
    const db = await getDb();
    const result = await printInvoice(db, invoiceId);
    feedback.show({ message: result.message });
  };

  const onShare = async () => {
    if (invoiceId === null) return;
    const db = await getDb();
    const result = await shareInvoice(db, invoiceId);
    feedback.show({ message: result.message });
  };

  /* "اطبع بعد الحفظ؟" (FR-02-14 — invoicing.print_on_save): يستهلك معامل
   * الرابط مرة واحدة بعد جاهزية البيانات: ask → حوار، print → فوري */
  useEffect(() => {
    if (state.kind !== 'data' || printParam === null || printAskHandledRef.current) return;
    printAskHandledRef.current = true;
    router.setParams({ print: undefined }); // يمنع تكرار الحوار عند العودة
    if (printParam === 'print') {
      void onPrint();
    } else {
      setAskPrintSheet(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, printParam]);

  /* عنوان ما قبل البيانات حسب عائلة المسار (بيع/شراء) — بعدها يصير العنوان
   * docType-aware داخل البيانات (فاتورة شراء/سند مرتجع…) */
  const preTitle = family === 'purchase' ? ar.purchases.newTitle : ar.sales.details.title;

  if (state.kind === 'loading') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={preTitle} onBack={() => router.back()} />
        <AppCard noPadding>
          <LoadingState variant="card" />
        </AppCard>
      </SafeScreen>
    );
  }
  if (state.kind === 'notfound') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={preTitle} onBack={() => router.back()} />
        <AppCard noPadding>
          <ErrorState message={ar.sales.details.notFound} onRetry={() => router.back()} />
        </AppCard>
      </SafeScreen>
    );
  }
  if (state.kind === 'error') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={preTitle} onBack={() => router.back()} />
        <AppCard noPadding>
          <ErrorState message={ar.sales.details.errorLoad} technical={state.technical} onRetry={load} />
        </AppCard>
      </SafeScreen>
    );
  }

  const { invoice, items, party, currency, products, linkedReturns, originalNo, planSummary } = state;
  const dec = Number.isFinite(currency.decimals) && currency.decimals >= 0 ? currency.decimals : 2;
  const symbol = currencySymbol(currency.code);
  const isVoid = invoice.status === 'void';
  const isDraft = invoice.status === 'draft';
  const isPurchaseDoc = invoice.doc_type === 'purchase' || invoice.doc_type === 'purchase_return';
  const isReturnDoc =
    invoice.doc_type === 'sale_return' || invoice.doc_type === 'purchase_return';
  const payChip = PAY_CHIP[invoice.pay_status] ?? 'pending';
  const profit = d(invoice.total).minus(d(invoice.cost_total));
  const hasDue = d(invoice.due_amount).gt(0);
  /** المرتجع متاح: مستند مكتمل من عائلة بيع/شراء (لا مرتجع على مرتجع — V1) */
  const canReturn = !isVoid && !isDraft && !isReturnDoc;
  const title = invoice.invoice_no
    ? `${ar.sales.details.title} ${invoice.invoice_no}`
    : ar.sales.details.draftNote;

  return (
    <SafeScreen offline={false}>
      <ScreenHeader title={title} onBack={() => router.back()} />

      {/* شرائح الحالة + نوع المستند + الأصل */}
      <View style={styles.chipsRow}>
        {isVoid ? <StatusChip kind="void" /> : isDraft ? <StatusChip kind="draft" /> : <StatusChip kind={payChip} />}
        {isVoid || isDraft ? <StatusChip kind={payChip} /> : null}
        {invoice.doc_type !== 'sale' ? (
          <TagChip
            label={ar.sales.doc[invoice.doc_type as keyof typeof ar.sales.doc] ?? invoice.doc_type}
            color={colors.textMuted}
          />
        ) : null}
        {Number(invoice.rate_is_fallback) === 1 ? (
          <TagChip label={ar.sales.details.rateFallback} color={colors.warning} />
        ) : null}
        {/* شراء مكتمل: WAC حُدِّث تلقائياً داخل معاملة الحفظ */}
        {invoice.doc_type === 'purchase' && !isVoid ? (
          <TagChip label={ar.purchases.details.wacNote} color={colors.accent} />
        ) : null}
      </View>

      {/* بطاقة بيانات المستند */}
      <AppCard>
        <View style={styles.partyRow}>
          <View style={styles.partyTexts}>
            <Text style={styles.partyName}>
              {party
                ? party.name
                : isPurchaseDoc
                  ? ar.purchases.meta.cashSupplier
                  : ar.sales.list.cashCustomer}
            </Text>
            <Text style={styles.partyMeta}>
              {`${formatDateAr(invoice.issued_at)} · ${currency.code} × ${formatQty(invoice.exchange_rate)}`}
            </Text>
            {originalNo ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${ar.returns.linked.original} ${originalNo}`}
                onPress={() =>
                  router.push(invoiceRoute(Number(invoice.original_invoice_id), invoice.doc_type === 'purchase_return' ? 'purchase' : 'sale'))
                }
                testID="invoice-original-link"
              >
                <Text style={styles.originalLink}>
                  {`${ar.returns.linked.original} ${originalNo}`}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {party?.phone ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={ar.sales.print.whatsapp}
              onPress={() => void onShare()}
              style={({ pressed }) => [styles.whatsappBtn, pressed && styles.iconPressed]}
            >
              <MessageCircle size={20} color={colors.success} />
            </Pressable>
          ) : null}
        </View>
      </AppCard>

      {/* بنود المستند */}
      <AppCard noPadding>
        <View style={styles.tableHead}>
          <Text style={[styles.tableHeadText, { flex: 2 }]}>{ar.sales.details.desc}</Text>
          <Text style={[styles.tableHeadText, { flex: 1.4, textAlign: 'center' }]}>
            {ar.sales.details.qtyPrice}
          </Text>
          <Text style={[styles.tableHeadText, { flex: 1.1, textAlign: 'left' }]}>
            {ar.sales.details.lineTotal}
          </Text>
        </View>
        {items.map((it) => {
          const prod = it.product_id !== null ? products.get(Number(it.product_id)) : undefined;
          const lineName = prod ? prod.name : (it.line_desc ?? '');
          const isService = (prod?.isService ?? false) || it.product_id === null;
          return (
            <View key={it.id} style={styles.tableRow}>
              <View style={[styles.tableCell, { flex: 2 }]}>
                <Text style={styles.itemName} numberOfLines={2}>
                  {lineName}
                </Text>
                {isService ? <TagChip label={ar.sales.cart.serviceChip} color={colors.textMuted} /> : null}
              </View>
              <Text style={[styles.tableCellText, { flex: 1.4, textAlign: 'center' }]}>
                {`${formatQty(it.qty)} × ${formatAmount(it.unit_price, dec)}`}
              </Text>
              <Text style={[styles.tableCellText, { flex: 1.1, textAlign: 'left' }]}>
                {formatAmount(it.line_total, dec)}
              </Text>
            </View>
          );
        })}
      </AppCard>

      {/* الإجماليات */}
      <AppCard>
        <View style={styles.totalsTable}>
          <TotalRow label={ar.sales.details.subtotal} value={invoice.subtotal} dec={dec} symbol={symbol} />
          {d(invoice.discount_amount).gt(0) ? (
            <TotalRow
              label={ar.sales.details.discount}
              value={invoice.discount_amount}
              dec={dec}
              symbol={symbol}
              tone="warning"
            />
          ) : null}
          {d(invoice.tax_amount).gt(0) ? (
            <TotalRow label={ar.sales.details.tax} value={invoice.tax_amount} dec={dec} symbol={symbol} />
          ) : null}
          <View style={styles.totalRow}>
            <Text style={styles.totalRowLabel}>{ar.sales.details.total}</Text>
            <Text style={styles.totalRowValue}>
              {`${formatAmount(invoice.total, dec)}${symbol ? ` ${symbol}` : ''}`}
            </Text>
          </View>
          {hasDue || d(invoice.paid_amount).gt(0) ? (
            <View style={styles.paidDueRow}>
              <View style={styles.paidDueCell}>
                <Text style={styles.paidDueLabel}>{ar.sales.details.paid}</Text>
                <Text style={[styles.paidDueValue, { color: colors.success }]}>
                  {`${formatAmount(invoice.paid_amount, dec)}${symbol ? ` ${symbol}` : ''}`}
                </Text>
              </View>
              <View style={styles.paidDueSep} />
              <View style={styles.paidDueCell}>
                <Text style={styles.paidDueLabel}>{ar.sales.details.due}</Text>
                <Text style={[styles.paidDueValue, { color: colors.warning }]}>
                  {`${formatAmount(invoice.due_amount, dec)}${symbol ? ` ${symbol}` : ''}`}
                </Text>
              </View>
            </View>
          ) : null}
        </View>

        {/* الربح لهذه الفاتورة (بيع/مرتجع بيع فقط — FR-09-11) */}
        {!isPurchaseDoc && d(invoice.total).gt(0) && !isVoid && !isDraft ? (
          <View style={styles.profitRow}>
            <View style={styles.profitLabelWrap}>
              <TrendingUp size={15} color={colors.textMuted} />
              <Text style={styles.profitLabel}>{ar.sales.details.profit}</Text>
            </View>
            <View style={styles.profitValueWrap}>
              <Text
                style={[
                  styles.profitValue,
                  {
                    color: profit.gt(0)
                      ? colors.success
                      : profit.lt(0)
                        ? colors.danger
                        : colors.textMuted,
                  },
                ]}
              >
                {`${profit.gt(0) ? '+' : profit.lt(0) ? '−' : ''}${formatAmount(profit.abs().toFixed(4), dec)}${symbol ? ` ${symbol}` : ''}`}
              </Text>
              <Text style={styles.profitCost}>{`${ar.sales.details.profitCost}: ${formatAmount(invoice.cost_total, dec)}`}</Text>
            </View>
          </View>
        ) : null}
      </AppCard>

      {/* مرتجعات مرتبطة بهذه الفاتورة */}
      {linkedReturns.length > 0 ? (
        <AppCard noPadding>
          <View style={styles.linkedHead}>
            <RotateCcw size={15} color={colors.textMuted} />
            <Text style={styles.linkedTitle}>{ar.returns.linked.title}</Text>
          </View>
          {linkedReturns.map((r) => (
            <Pressable
              key={r.id}
              accessibilityRole="button"
              accessibilityLabel={r.invoiceNo ?? ''}
              onPress={() => router.push(invoiceRoute(r.id, r.docType))}
              style={({ pressed }) => [styles.linkedRow, pressed && styles.linkedRowPressed]}
              testID={`linked-return-${r.id}`}
            >
              <View style={styles.linkedTexts}>
                <Text style={styles.linkedNo}>{r.invoiceNo ?? ar.sales.details.draftNote}</Text>
                <Text style={styles.linkedSub}>
                  {`${ar.sales.doc[r.docType as keyof typeof ar.sales.doc] ?? r.docType} · ${formatDayShortAr(r.issuedAt)}`}
                </Text>
              </View>
              <View style={styles.linkedTrailing}>
                <Text style={styles.linkedAmount}>
                  {`${formatAmount(r.total, r.currencyDecimals)}${currencySymbol(r.currencyCode) ? ` ${currencySymbol(r.currencyCode)}` : ''}`}
                </Text>
                {r.status === 'void' ? (
                  <TagChip label={ar.returns.voidedOriginal} color={colors.danger} />
                ) : (
                  <StatusChip kind={PAY_CHIP[r.payStatus] ?? 'pending'} />
                )}
              </View>
            </Pressable>
          ))}
        </AppCard>
      ) : null}

      {/* خطة تقسيط على هذه الفاتورة — بطاقة شرطية صارمة (FR-05) */}
      {planSummary !== null ? (
        <AppCard noPadding>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.installments.invoiceCard.title}
            onPress={() => router.push(`/installments/${planSummary.planId}`)}
            style={({ pressed }) => [planStyles.planRow, pressed && planStyles.planRowPressed]}
            testID="invoice-plan-card"
          >
            <View style={planStyles.planIcon}>
              <CalendarClock size={18} color={colors.warning} />
            </View>
            <View style={planStyles.planTexts}>
              <View style={planStyles.planTitleRow}>
                <Text style={planStyles.planTitle}>{ar.installments.invoiceCard.title}</Text>
                {planSummary.status === 'completed' ? (
                  <TagChip label={ar.installments.invoiceCard.completed} color={colors.success} />
                ) : null}
              </View>
              <View style={planStyles.planProgressBar}>
                <View
                  style={[
                    planStyles.planProgressFill,
                    {
                      flex: Math.max(
                        planSummary.totalCount > 0
                          ? planSummary.paidCount / planSummary.totalCount
                          : 0,
                        0.01,
                      ),
                    },
                  ]}
                />
              </View>
              <Text style={planStyles.planMeta}>
                {`${planSummary.paidCount}/${planSummary.totalCount} ${ar.installments.details.progressOf}${
                  planSummary.nextDue !== null
                    ? ` · ${ar.installments.list.nextDueLabel}: ${formatDayShortAr(planSummary.nextDue)}`
                    : ''
                }`}
              </Text>
            </View>
            <ChevronLeft size={16} color={colors.textFaint} />
          </Pressable>
        </AppCard>
      ) : null}

      {/* الإجراءات */}
      <View style={styles.actionsCol}>
        <View style={styles.actionsRow}>
          <PrimaryButton
            label={ar.sales.print.button}
            icon={Printer}
            tone="primary"
            onPress={() => void onPrint()}
            style={styles.actionBtn}
            testID="invoice-print"
          />
          <PrimaryButton
            label={ar.sales.print.share}
            icon={Share2}
            tone="ghost"
            onPress={() => void onShare()}
            style={styles.actionBtn}
            testID="invoice-share"
          />
        </View>
        <View style={styles.actionsRow}>
          {canReturn ? (
            <PrimaryButton
              label={ar.sales.returnBtn}
              icon={RotateCcw}
              tone="ghost"
              onPress={() => router.push(`/sales/${invoice.id}/return`)}
              style={styles.actionBtn}
              testID="invoice-return"
            />
          ) : isVoid ? (
            <View style={[styles.returnChip, styles.actionBtn]}>
              <RotateCcw size={17} color={colors.textFaint} />
              <Text style={styles.returnChipText}>{ar.returns.voidedOriginal}</Text>
            </View>
          ) : null}
          <PrimaryButton
            label={ar.sales.details.void}
            icon={ArrowLeftRight}
            tone="danger"
            disabled={isVoid || isDraft || voiding}
            onPress={() => setVoidSheet(true)}
            style={styles.actionBtn}
            testID="invoice-void"
          />
        </View>
      </View>

      {/* تأكيد الإلغاء بكلمة «إلغاء» (DS-27) */}
      <ConfirmSheet
        visible={voidSheet}
        title={ar.sales.details.voidTitle}
        message={ar.sales.details.voidBody}
        confirmWord={ar.sales.details.voidWord}
        danger
        onConfirm={() => void onVoid()}
        onCancel={() => setVoidSheet(false)}
        testID="void-confirm"
      />

      {/* «اطبع الفاتورة الآن؟» — print_on_save = ask (FR-02-14) */}
      <BottomSheet
        visible={askPrintSheet}
        onClose={() => setAskPrintSheet(false)}
        title={ar.sales.print.askTitle}
        footer={
          <View style={styles.askActions}>
            <PrimaryButton
              label={ar.sales.print.askPrint}
              icon={Printer}
              tone="primary"
              onPress={() => {
                setAskPrintSheet(false);
                void onPrint();
              }}
              style={styles.askBtn}
              testID="print-ask-yes"
            />
            <PrimaryButton
              label={ar.sales.print.askLater}
              tone="ghost"
              onPress={() => setAskPrintSheet(false)}
              style={styles.askBtn}
              testID="print-ask-later"
            />
          </View>
        }
        testID="print-ask-sheet"
      >
        <Text style={styles.askBody}>{ar.sales.print.askBody}</Text>
      </BottomSheet>

      {feedback.host}
    </SafeScreen>
  );
}

/* ============ عناصر محلية ============ */

/* بطاقة «خطة تقسيط» الشرطية (FR-05) */
const planStyles = StyleSheet.create({
  planRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  planRowPressed: {
    opacity: 0.75,
  },
  planIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
  },
  planTexts: {
    flex: 1,
    gap: 4,
  },
  planTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  planTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  planProgressBar: {
    height: 5,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  planProgressFill: {
    backgroundColor: colors.warning,
    borderRadius: radius.full,
  },
  planMeta: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 16,
  },
});

function TotalRow({
  label,
  value,
  dec,
  symbol,
  tone,
}: {
  label: string;
  value: string;
  dec: number;
  symbol: string;
  tone?: 'warning';
}) {
  return (
    <View style={styles.totalRowLine}>
      <Text style={styles.totalLineLabel}>{label}</Text>
      <Text style={[styles.totalLineValue, tone === 'warning' ? { color: colors.warning } : null]}>
        {`${formatAmount(value, dec)}${symbol ? ` ${symbol}` : ''}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chipsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  partyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  partyTexts: {
    flex: 1,
    gap: 2,
  },
  partyName: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 24,
  },
  partyMeta: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  originalLink: {
    color: colors.accent,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    paddingTop: 2,
  },
  whatsappBtn: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.md,
    backgroundColor: 'rgba(52, 211, 153, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconPressed: {
    opacity: 0.7,
  },
  tableHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tableHeadText: {
    color: colors.textFaint,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    minHeight: touch.min + 8,
    gap: 6,
  },
  tableCell: {
    gap: 4,
  },
  tableCellText: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  itemName: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  totalsTable: {
    gap: 4,
  },
  totalRowLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 30,
  },
  totalLineLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  totalLineValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'left',
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: 6,
    paddingTop: 8,
  },
  totalRowLabel: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  totalRowValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 24,
    lineHeight: 32,
    textAlign: 'left',
  },
  paidDueRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.md,
    marginTop: 8,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  paidDueCell: {
    flex: 1,
    gap: 2,
  },
  paidDueSep: {
    width: 1,
    backgroundColor: colors.border,
  },
  paidDueLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  paidDueValue: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'left',
  },
  profitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: 10,
    paddingTop: 10,
  },
  profitLabelWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  profitLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  profitValueWrap: {
    alignItems: 'flex-end',
    gap: 2,
  },
  profitValue: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 17,
    lineHeight: 24,
    textAlign: 'left',
  },
  profitCost: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 11,
    lineHeight: 16,
  },
  linkedHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
  },
  linkedTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  linkedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 8,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    minHeight: touch.min + 8,
  },
  linkedRowPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.07)',
  },
  linkedTexts: {
    flex: 1,
    gap: 2,
    alignItems: 'flex-start',
  },
  linkedNo: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
  },
  linkedSub: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  linkedTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  linkedAmount: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'left',
  },
  actionsCol: {
    gap: 8,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
  },
  returnChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: touch.min,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    opacity: 0.55,
  },
  returnChipText: {
    color: colors.textFaint,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
  },
  askBody: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 22,
    paddingBottom: spacing.sm,
  },
  askActions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  askBtn: {
    flex: 1,
  },
});
