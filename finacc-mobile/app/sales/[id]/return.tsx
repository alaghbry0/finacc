/**
 * sales/[id]/return.tsx — **تدفق المرتجع ReturnFlow** (§6.5 v1.2 — ملزم، Task 8):
 *
 *  يُفتح بزر «مرتجع» من تفاصيل فاتورة **البيع أو الشراء على حد سواء** —
 *  العائلة تُستنتج من doc_type الفاتورة الأصلية (لا معامل رابط):
 *    sale → سند sale_return (SRN) · purchase → سند purchase_return (PRN).
 *
 *  البنية (§6.5 حرفياً — شاشة واحدة بلا تبويبات):
 *   1. رأس: «مرتجع على فاتورة {no}» + الطرف + التاريخ الأصلي.
 *   2. بنود الأصل: الاسم + المباع/المشترى + **القابل للإرجاع: N** (المباع −
 *      المرتجع سابقاً — من getReturnableLines للعرض قبل الحفظ؛ الدومين يعيد
 *      التحقق داخل المعاملة — AC-21) + كمية الإرجاع (QtyStepper 0..returnable،
 *      لوحة الأرقام قد تتجاوز → تحذير أحمر ثم رفض الدومين عند الحفظ) +
 *      سعر الوحدة الأصلي (عرض فقط — قراءة).
 *   3. اتجاه إرجاع المبلغ: بطاقتا راديو — «نقدي من الصندوق» (صرف للعميل في
 *      مرتجع البيع / قبض من المورّد في مرتجع الشراء — التسمية حسب العائلة)
 *      أو «خصم من الحساب».
 *   4. إجمالي المرتجع كبير (Σ كمية × سعر الوحدة الأصلي).
 *   5. «حفظ المرتجع» → ConfirmSheet بكلمة «إرجاع» → domain.createLinkedReturn
 *      (معاملة ذرّية: بنود + حركات مخزون بتكلفة line_cost الأصلية للبيع /
 *      بسعر حركة الشراء الأصلية مع إعادة حساب WAC للشراء + حركة الصندوق حسب
 *      الاتجاه + SRN/PRN) → router.replace لتفاصيل الأصل + «حُفظ المرتجع {no}».
 *   6. أخطاء الدومين (RETURN_EXCEEDS_REMAINING وغيرها) تظهر عبر FeedbackBar —
 *      بلا أثر جزئي (المعاملة ذرّية).
 *   7. الطباعة: من صفحة سند المرتجع نفسه (قائمة الفواتير → فلتر مرتجع) —
 *      القالب يدعم «سند مرتجع بيع/شراء» منذ المهمة 7.
 *   8. الفاتورة الملغاة → الزر معطّل في التفاصيل أصلاً، وهنا شاشة صدق:
 *      «فاتورة ملغاة — لا مرتجع عليها».
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Landmark,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import { getReturnableLines, type ReturnableLine } from '@/db/queries';
import {
  createLinkedReturn,
  getInvoiceWithItems,
  type InvoiceRow,
  type ReturnPayDirection,
} from '@/domain/invoicing';
import { getCustomer, getSupplier } from '@/domain/parties';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { currencySymbol, formatAmount, formatDateAr, formatQty, todayISO } from '@/utils/format';
import { d, roundTo, sumD } from '@/utils/money';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import { invoiceRoute } from '@/utils/doc-routes';
import AppCard from '@/components/ui/AppCard';
import ConfirmSheet from '@/components/ui/ConfirmSheet';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import QtyStepper from '@/components/ui/QtyStepper';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import TagChip from '@/components/ui/TagChip';
import { useFeedback } from '@/components/ui/feedback';

interface PartyLite {
  name: string;
}

interface CurrencyLiteRow {
  code: string;
  decimals: number;
}

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'notfound' }
  | { kind: 'unreturnable'; message: string }
  | {
      kind: 'data';
      invoice: InvoiceRow;
      lines: ReturnableLine[];
      party: PartyLite | null;
      currency: CurrencyLiteRow;
    };

export default function ReturnFlowScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const params = useLocalSearchParams<{ id?: string }>();
  const invoiceId = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;

  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  /** كمية الإرجاع لكل صنف — خام نصي كما ينتظرها LineInput */
  const [returnQty, setReturnQty] = useState<Record<number, string>>({});
  const [direction, setDirection] = useState<ReturnPayDirection>('cash');
  const [confirmSheet, setConfirmSheet] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (invoiceId === null) {
      setState({ kind: 'notfound' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const db = await getDb();
      const { invoice } = await getInvoiceWithItems(db, invoiceId);
      if (invoice.status === 'void') {
        setState({ kind: 'unreturnable', message: ar.returns.voidedOriginal });
        return;
      }
      if (invoice.status !== 'completed') {
        setState({ kind: 'unreturnable', message: ar.sales.details.draftNote });
        return;
      }
      if (invoice.doc_type !== 'sale' && invoice.doc_type !== 'purchase') {
        // مرتجع على مرتجع غير مدعوم في V1 — صادقون في العرض
        setState({ kind: 'unreturnable', message: ar.returns.noLines });
        return;
      }
      const [lines, curRows, party] = await Promise.all([
        getReturnableLines(db, invoiceId),
        db.all<{ code: string; decimals: number }>(
          'SELECT code, decimals FROM currency WHERE id = ?',
          [invoice.currency_id],
        ),
        invoice.customer_id !== null
          ? getCustomer(db, Number(invoice.customer_id))
          : invoice.supplier_id !== null
            ? getSupplier(db, Number(invoice.supplier_id))
            : Promise.resolve(null),
      ]);
      setState({
        kind: 'data',
        invoice,
        lines,
        party: party ? { name: party.name } : null,
        currency: { code: curRows[0]?.code ?? '—', decimals: Number(curRows[0]?.decimals ?? 2) },
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

  /* ============ الحفظ (createLinkedReturn — ذرّية) ============ */

  const onSave = async () => {
    if (state.kind !== 'data' || !session.defaults) return;
    const { invoice } = state;
    const entries = state.lines.filter((l) => d(returnQty[l.productId] ?? '0').gt(0));
    if (entries.length === 0) {
      feedback.show({ message: ar.returns.saveDisabled });
      return;
    }
    setSaving(true);
    try {
      const db = await getDb();
      const result = await createLinkedReturn(
        db,
        {
          docType: invoice.doc_type === 'purchase' ? 'purchase_return' : 'sale_return',
          originalInvoiceId: invoice.id,
          issuedAt: todayISO(),
          returnPayDirection: direction,
          warehouseId: invoice.warehouse_id,
          currencyId: invoice.currency_id,
          cashboxId: direction === 'cash' ? session.defaults.cashboxId ?? undefined : undefined,
          lines: entries.map((l) => ({
            productId: l.productId,
            qty: returnQty[l.productId] ?? '0',
            unitPrice: l.unitPrice,
          })),
          // مرآة ضريبة الأصل: السند يعكس فاتورته (بلا ضريبة إن كانت الأصل كذلك)
          taxRate: d(invoice.tax_rate).gt(0) ? invoice.tax_rate : undefined,
        },
        { createdBy: session.user?.id },
      );
      setConfirmSheet(false);
      feedback.show({
        message: ar.returns.saved.replace('{no}', result.invoiceNo ?? '—'),
        durationMs: 6000,
      });
      // العودة لتفاصيل الأصل (تُظهر بطاقة «مرتجعات مرتبطة») — استبدال لا تكديس
      router.replace(invoiceRoute(invoice.id, invoice.doc_type));
    } catch (err) {
      setConfirmSheet(false);
      // أخطاء الدومين العربية (AC-21: تجاوز المتبقي، أصل ملغاة، عملة مختلفة…)
      feedback.show({
        message: domainErrorMessage(err) ?? ar.returns.errorLoad,
        durationMs: 8000,
      });
    } finally {
      setSaving(false);
    }
  };

  /* ============ العرض ============ */

  if (state.kind === 'loading') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.sales.returnBtn} onBack={() => router.back()} />
        <AppCard noPadding>
          <LoadingState variant="card" />
        </AppCard>
      </SafeScreen>
    );
  }
  if (state.kind === 'notfound') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.sales.returnBtn} onBack={() => router.back()} />
        <AppCard noPadding>
          <ErrorState message={ar.returns.notFound} onRetry={() => router.back()} />
        </AppCard>
      </SafeScreen>
    );
  }
  if (state.kind === 'error') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.sales.returnBtn} onBack={() => router.back()} />
        <AppCard noPadding>
          <ErrorState message={ar.returns.errorLoad} technical={state.technical} onRetry={load} />
        </AppCard>
      </SafeScreen>
    );
  }
  if (state.kind === 'unreturnable') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.sales.returnBtn} onBack={() => router.back()} />
        <AppCard noPadding>
          <ErrorState message={state.message} onRetry={() => router.back()} />
        </AppCard>
      </SafeScreen>
    );
  }

  const { invoice, lines, party, currency } = state;
  const dec = Number.isFinite(currency.decimals) && currency.decimals >= 0 ? currency.decimals : 2;
  const symbol = currencySymbol(currency.code);
  const isPurchase = invoice.doc_type === 'purchase';
  const partyLabel = isPurchase ? ar.returns.partyLabelSupplier : ar.returns.partyLabel;
  const soldLabel = isPurchase ? ar.returns.lines.soldPurchase : ar.returns.lines.sold;
  const unitPriceLabel = isPurchase ? ar.returns.lines.unitPricePurchase : ar.returns.lines.unitPrice;
  const headerTitle = ar.returns.title.replace('{no}', invoice.invoice_no ?? '—');

  /* إجمالي المرتجع — Σ كمية × سعر الوحدة الأصلي (العرض يطابق حساب الدومين:
   * بلا خصومات بنود في السند — LineInput نظيف، والضريبة مرآة الأصل) */
  const total = roundTo(
    sumD(lines.map((l) => d(returnQty[l.productId] ?? '0').times(d(l.unitPrice)))),
    4,
  );
  const anyQty = lines.some((l) => d(returnQty[l.productId] ?? '0').gt(0));
  const overLimit = lines.some((l) => d(returnQty[l.productId] ?? '0').gt(d(l.returnableQty)));

  const setQty = (l: ReturnableLine, raw: string) => {
    setReturnQty((prev) => ({ ...prev, [l.productId]: raw }));
  };

  return (
    <SafeScreen offline={false}>
      <ScreenHeader title={headerTitle} onBack={() => router.back()} />

      {/* ——— 1. رأس: الطرف + التاريخ الأصلي ——— */}
      <AppCard>
        <View style={styles.headRow}>
          <View style={styles.headTexts}>
            <Text style={styles.partyLabel}>{partyLabel}</Text>
            <Text style={styles.partyName}>
              {party
                ? party.name
                : isPurchase
                  ? ar.purchases.meta.cashSupplier
                  : ar.sales.list.cashCustomer}
            </Text>
          </View>
          <View style={styles.headTextsEnd}>
            <Text style={styles.dateLabel}>{ar.sales.details.date}</Text>
            <Text style={styles.dateValue}>{formatDateAr(invoice.issued_at)}</Text>
          </View>
        </View>
        <Text style={styles.subtitle}>{ar.returns.subtitle}</Text>
      </AppCard>

      {/* ——— 2. بنود الفاتورة الأصلية ——— */}
      <AppCard noPadding>
        <View style={styles.linesHead}>
          <Text style={styles.linesTitle}>{ar.returns.lines.title}</Text>
        </View>
        {lines.length === 0 ? (
          <Text style={styles.noLines}>{ar.returns.noLines}</Text>
        ) : (
          lines.map((l) => {
            const qty = returnQty[l.productId] ?? '0';
            const returnable = d(l.returnableQty);
            const over = d(qty).gt(returnable);
            return (
              <View key={l.productId} style={styles.lineRow}>
                <View style={styles.lineHead}>
                  <View style={styles.lineNameWrap}>
                    <Text style={styles.lineName} numberOfLines={1}>
                      {l.name}
                    </Text>
                    <Text style={styles.lineMeta}>
                      {`${soldLabel}: ${formatQty(l.soldQty)}`}
                      {d(l.returnedQty).gt(0)
                        ? ` · ${ar.returns.lines.returnedBefore}: ${formatQty(l.returnedQty)}`
                        : ''}
                    </Text>
                    {returnable.lte(0) ? (
                      <TagChip label={ar.returns.lines.returnableZero} color={colors.textFaint} />
                    ) : (
                      <Text style={[styles.returnableText, over && styles.overLimitText]}>
                        {`${ar.returns.lines.returnable}: ${formatQty(l.returnableQty)}`}
                      </Text>
                    )}
                    {over ? <Text style={styles.overLimitWarn}>{ar.sales.cart.overAvail}</Text> : null}
                  </View>
                  <View style={styles.unitPriceWrap}>
                    <Text style={styles.unitPriceLabel}>{unitPriceLabel}</Text>
                    <Text style={styles.unitPriceValue}>
                      {`${formatAmount(l.unitPrice, dec)}${symbol ? ` ${symbol}` : ''}`}
                    </Text>
                  </View>
                </View>
                <View style={styles.lineControls}>
                  <Text style={styles.returnQtyLabel}>{ar.returns.lines.returnQty}</Text>
                  <QtyStepper
                    value={qty}
                    onChange={(raw) => setQty(l, raw)}
                    min="0"
                    max={l.returnableQty}
                    disabled={returnable.lte(0)}
                    sheetTitle={`${ar.returns.lines.returnQty} — ${l.name}`}
                    testID={`return-qty-${l.productId}`}
                  />
                  <Text style={styles.lineTotalValue}>
                    {`${formatAmount(d(qty).times(d(l.unitPrice)).toFixed(4), dec)}${symbol ? ` ${symbol}` : ''}`}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </AppCard>

      {/* ——— 3. اتجاه إرجاع المبلغ (بطاقتا راديو) ——— */}
      <AppCard>
        <Text style={styles.directionTitle}>{ar.returns.direction.title}</Text>
        <RadioCard
          active={direction === 'cash'}
          onPress={() => setDirection('cash')}
          icon={isPurchase ? ArrowDownToLine : ArrowUpFromLine}
          title={isPurchase ? ar.returns.direction.cashPurchase : ar.returns.direction.cashSale}
          hint={isPurchase ? ar.returns.direction.cashPurchaseHint : ar.returns.direction.cashSaleHint}
          testID="return-direction-cash"
        />
        <RadioCard
          active={direction === 'account'}
          onPress={() => setDirection('account')}
          icon={Landmark}
          title={ar.returns.direction.account}
          hint={ar.returns.direction.accountHint}
          testID="return-direction-account"
        />
      </AppCard>

      {/* ——— 4 + 5. الإجمالي الكبير + الحفظ ——— */}
      <View style={styles.bottomCard}>
        <View style={styles.totalRow}>
          <View style={styles.totalLabelWrap}>
            <Text style={styles.totalLabel}>{ar.returns.total}</Text>
            <Text style={styles.totalHint}>{ar.returns.totalHint}</Text>
          </View>
          <Text
            style={[styles.totalValue, overLimit && { color: colors.danger }]}
            adjustsFontSizeToFit
            numberOfLines={1}
          >
            {`${formatAmount(total.toFixed(4), dec)}${symbol ? ` ${symbol}` : ''}`}
          </Text>
        </View>
        {overLimit ? (
          <View style={styles.overBanner}>
            <AlertCircle size={15} color={colors.danger} />
            <Text style={styles.overBannerText}>{ar.sales.cart.overAvail}</Text>
          </View>
        ) : null}
        <PrimaryButton
          label={ar.returns.save}
          disabled={!anyQty || saving}
          onPress={() => setConfirmSheet(true)}
          testID="return-save"
        />
      </View>

      {/* تأكيد الحفظ بكلمة «إرجاع» (DS-27) */}
      <ConfirmSheet
        visible={confirmSheet}
        title={ar.returns.confirmTitle}
        message={`${ar.returns.confirmBody}\n${ar.returns.total}: ${formatAmount(total.toFixed(4), dec)}${symbol ? ` ${symbol}` : ''}`}
        confirmWord={ar.returns.confirmWord}
        danger={false}
        onConfirm={() => void onSave()}
        onCancel={() => setConfirmSheet(false)}
        testID="return-confirm"
      />

      {feedback.host}
    </SafeScreen>
  );
}

/* ============ بطاقة راديو (اتجاه الإرجاع) ============ */

function RadioCard({
  active,
  onPress,
  icon: Icon,
  title,
  hint,
  testID,
}: {
  active: boolean;
  onPress: () => void;
  icon: React.ComponentType<{ size?: number; color?: string }>;
  title: string;
  hint: string;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [
        styles.radioCard,
        active && styles.radioCardActive,
        pressed && styles.radioCardPressed,
      ]}
      testID={testID}
    >
      <View style={styles.radioIconWrap}>
        <Icon size={20} color={active ? colors.accent : colors.textMuted} />
      </View>
      <View style={styles.radioTexts}>
        <Text style={[styles.radioTitle, active && styles.radioTitleActive]}>{title}</Text>
        <Text style={styles.radioHint}>{hint}</Text>
      </View>
      <View style={[styles.radioDot, active && styles.radioDotActive]}>
        {active ? <Check size={14} color={colors.onAccent} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  headTexts: {
    flex: 1,
    gap: 2,
  },
  headTextsEnd: {
    alignItems: 'flex-end',
    gap: 2,
  },
  partyLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 15,
  },
  partyName: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 24,
  },
  dateLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 15,
  },
  dateValue: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  subtitle: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    paddingTop: spacing.xs,
  },
  linesHead: {
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
  },
  linesTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  noLines: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  lineRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 10,
  },
  lineHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  lineNameWrap: {
    flex: 1,
    gap: 2,
  },
  lineName: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  lineMeta: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  returnableText: {
    color: colors.accent,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  overLimitText: {
    color: colors.danger,
  },
  overLimitWarn: {
    color: colors.danger,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  unitPriceWrap: {
    alignItems: 'flex-end',
    gap: 2,
    minWidth: 90,
  },
  unitPriceLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 15,
  },
  unitPriceValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'left',
  },
  lineControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  returnQtyLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
  },
  lineTotalValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'left',
    minWidth: 80,
  },
  directionTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
    paddingBottom: spacing.sm,
  },
  radioCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    minHeight: touch.min + 16,
  },
  radioCardActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(34, 211, 238, 0.08)',
  },
  radioCardPressed: {
    opacity: 0.8,
  },
  radioIconWrap: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioTexts: {
    flex: 1,
    gap: 2,
  },
  radioTitle: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  radioTitleActive: {
    color: colors.accent,
  },
  radioHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  radioDot: {
    width: 24,
    height: 24,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDotActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  bottomCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  totalLabelWrap: {
    flex: 1,
    gap: 2,
  },
  totalLabel: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  totalHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  totalValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 26,
    lineHeight: 34,
    textAlign: 'left',
    maxWidth: '60%',
  },
  overBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(248, 113, 113, 0.12)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.45)',
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  overBannerText: {
    color: colors.danger,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    flex: 1,
  },
});
