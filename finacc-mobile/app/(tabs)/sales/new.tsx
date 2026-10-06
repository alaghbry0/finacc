/**
 * (tabs)/sales/new.tsx — شاشة البيع/الكاشير ⭐ (§6.5 — البنية الملزمة / LDR-1):
 *
 *  - أعلى: شريط ميتا قابل للطي (عميل [بحث] + صندوق + عملة) بأهداف قابلة للنقر.
 *  - منتصف: بنود الفاتورة الحية (QtyStepper + سعر قابل للتعديل + «المتاح: N»)
 *    + «إضافة صنف» (ItemPickerSheet: الأكثر مبيعاً + بحث، نقرة = كمية 1) +
 *    شريط «المعلّقات» عند وجود سلال معلّقة (Park — قرار 2).
 *  - أسفل (ثابت): المجموع/الخصم/الضريبة = الإجمالي الكبير + شريط الأزرار الرباعي:
 *    **حفظ نقدي (أخضر) / حفظ آجل (كهرماني) / تعليق / إضافات (…)** — قرار 1/LDR-1.
 *  - الحفظ عبر domain.saveInvoice (Transaction ذرّية) — النقدي عبر PaymentSheet
 *    (DS-40، حسب إعداد invoicing.payment_sheet)، الآجل بتأكيد + تحذير حد الائتمان
 *    (parties.credit_limit_action=warn افتراضاً — متابعة مسموحة).
 *  - الأخطاء: MissingRateError → شيت سعر اليوم (FR-08-09) ثم إعادة الحفظ تلقائياً؛
 *    NegativeStockError → رسالة الدومين (تسمّي الصنف) بلا أثر جزئي؛
 *    BackdateConfirmationRequired → تأكيد كلمة «متابعة».
 *  - مسودة السلة: تُحفظ تلقائياً (debounce 500ms) وتُستعاد بعد الانهيار مع
 *    Banner «تمت استعادة فاتورتك غير المحفوظة» (AC-23/FR-02-13).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { z } from 'zod';
import {
  ChevronDown,
  ChevronUp,
  ClipboardList,
  MoreHorizontal,
  Pause,
  Pencil,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  fetchCustomerCreditInfo,
  fetchRetailPrices,
  fetchStockTotals,
  listActiveCurrencies,
  listCashboxes,
  type CashboxLite,
  type CurrencyLite,
  type CustomerCreditInfo,
} from '@/db/queries';
import { saveInvoice } from '@/domain/invoicing';
import { resolveRate, upsertDailyRate } from '@/domain/currency';
import { getInvoicingSettings, getSetting } from '@/domain/settings';
import { listCustomers, type PartyRow } from '@/domain/parties';
import {
  BackdateConfirmationRequiredError,
  MissingRateError,
} from '@/domain/errors';
import { useSession } from '@/store/session';
import { computeCartTotals, useCart, type CartLine } from '@/store/cart';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { currencySymbol, formatAmount, formatDateAr, formatQty, todayISO } from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import ConfirmSheet from '@/components/ui/ConfirmSheet';
import EmptyState from '@/components/ui/EmptyState';
import LoadingState from '@/components/ui/LoadingState';
import NumberPad, { tapHaptic } from '@/components/ui/NumberPad';
import PaymentSheet from '@/components/ui/PaymentSheet';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import SearchBar from '@/components/ui/SearchBar';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';
import CartLineRow from '@/components/sales/CartLineRow';
import ItemPickerSheet, { type PickableProduct } from '@/components/sales/ItemPickerSheet';
import LineEditSheet from '@/components/sales/LineEditSheet';

/* ============ سياق شيت سعر الصرف (اختيار عملة أو فشل الحفظ) ============ */

interface RateSheetCtx {
  currencyId: number;
  code: string;
  name: string;
  /** يُستدعى بعد حفظ السعر (متابعة الحفظ أو تثبيت العملة) */
  onSaved: () => void;
}

type SavePay = { payStatus: 'cash' | 'credit' | 'mixed'; paidAmount?: string };

export default function NewSaleScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const cart = useCart();

  /* ——— إعدادات الشاشة ——— */
  const [taxMode, setTaxMode] = useState<'per_item' | 'on_total'>('on_total');
  const [paymentSheetOn, setPaymentSheetOn] = useState(true);
  const [cashboxes, setCashboxes] = useState<CashboxLite[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyLite[]>([]);
  const [metaCollapsed, setMetaCollapsed] = useState(false);

  /* ——— الشيتات ——— */
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerAdded, setPickerAdded] = useState(0);
  const [editLineKey, setEditLineKey] = useState<string | null>(null);
  const [discountSheet, setDiscountSheet] = useState(false);
  const [extrasSheet, setExtrasSheet] = useState(false);
  const [clearSheet, setClearSheet] = useState(false);
  const [parkedSheet, setParkedSheet] = useState(false);
  const [replaceParkedId, setReplaceParkedId] = useState<string | null>(null);
  const [customerSheet, setCustomerSheet] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState<PartyRow[]>([]);
  const [cashboxSheet, setCashboxSheet] = useState(false);
  const [currencySheet, setCurrencySheet] = useState(false);
  const [payVisible, setPayVisible] = useState(false);
  const [creditSheet, setCreditSheet] = useState(false);
  const [creditInfo, setCreditInfo] = useState<CustomerCreditInfo | null>(null);
  const [creditExposure, setCreditExposure] = useState<string | null>(null);
  const [creditLimitHit, setCreditLimitHit] = useState(false);
  const [backdateSheet, setBackdateSheet] = useState(false);
  const [backdateMessage, setBackdateMessage] = useState<string | null>(null);
  const [rateCtx, setRateCtx] = useState<RateSheetCtx | null>(null);
  const [rateValue, setRateValue] = useState('0');

  const [saving, setSaving] = useState(false);
  const hydratedOnce = useRef(false);
  const customerSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRetryRef = useRef<(() => void) | null>(null);

  const defaults = session.defaults;
  const company = session.company;
  const taxRate = company?.taxRate ?? '0';
  const currencyDecimals =
    currencies.find((c) => c.id === cart.currencyId)?.decimals ?? 0;
  const currencyCode = cart.currencyCode;

  /* ——— التهيئة: ميتا + إعدادات + مسودة (مرة واحدة) ——— */
  useEffect(() => {
    if (hydratedOnce.current || !session.ready || session.locked) return;
    hydratedOnce.current = true;
    cart.hydrate({
      cashboxId: defaults?.cashboxId ?? null,
      currencyId: defaults?.baseCurrencyId ?? null,
      currencyCode: defaults?.baseCurrencyCode ?? null,
    });
    const state = useCart.getState();
    if (state.restored && state.lines.length > 0) {
      feedback.show({ message: ar.sales.feedback.restored, durationMs: 9000 });
      state.markRestoredSeen();
    }
    (async () => {
      try {
        const db = await getDb();
        const [boxes, curs, inv, paySheetSetting] = await Promise.all([
          listCashboxes(db),
          listActiveCurrencies(db),
          getInvoicingSettings(db),
          getSetting(db, 'invoicing.payment_sheet', z.enum(['on', 'off']), 'on' as const),
        ]);
        setCashboxes(boxes);
        setCurrencies(curs);
        setTaxMode(inv.taxMode);
        setPaymentSheetOn(paySheetSetting === 'on');
      } catch {
        // دفاعي: إعدادات تالفة لا توقف الكاشير — يبقى الافتراضي
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.ready, session.locked]);

  /* ——— تحديث «المتاح» عند العودة للشاشة (الرصيد يتغير بالحفظ من شاشات أخرى) ——— */
  const refreshAvailability = useCallback(async () => {
    const state = useCart.getState();
    const ids = state.lines
      .filter((l) => !l.isService && l.productId !== null)
      .map((l) => l.productId!);
    if (ids.length === 0) return;
    try {
      const db = await getDb();
      const stocks = await fetchStockTotals(db, ids);
      state.refreshAvailability(stocks);
    } catch {
      // عرض فقط — نتجاهل
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshAvailability();
    }, [refreshAvailability]),
  );

  /* ——— بحث العملاء داخل الشيت ——— */
  useEffect(() => {
    if (!customerSheet) return;
    if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current);
    customerSearchTimer.current = setTimeout(async () => {
      try {
        const db = await getDb();
        setCustomers(await listCustomers(db, { search: customerSearch, limit: 50 }));
      } catch {
        setCustomers([]);
      }
    }, 200);
    return () => {
      if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current);
    };
  }, [customerSheet, customerSearch]);

  /* ============ المجاميع — مطابقة للدومين حرفياً ============ */

  const totals = computeCartTotals(
    { lines: cart.lines, invoiceDiscount: cart.invoiceDiscount },
    taxRate,
    taxMode,
  );
  const lineTotalByKey = new Map(totals.lines.map((l) => [l.key, l.total]));
  const cartQtyCount = cart.lines.length;
  const editLine = cart.lines.find((l) => l.key === editLineKey) ?? null;

  /* ============ إضافة/تعديل البنود ============ */

  const pickProduct = (p: PickableProduct) => {
    tapHaptic();
    cart.addItem({
      productId: p.id,
      name: p.name,
      isService: p.isService,
      price: 'price' in p ? (p.price ?? '0') : '0',
      available: p.isService ? '' : p.stockTotal,
    });
    setPickerAdded((n) => n + 1);
  };

  const deleteLine = (line: CartLine) => {
    const removed = cart.removeLine(line.key);
    if (!removed) return;
    feedback.show({
      message: ar.sales.cart.lineDeleted,
      actionLabel: ar.common.undo,
      onAction: () => cart.insertLineAt(removed.line, removed.index),
    });
  };

  /* ============ اختيار العملة + سعر اليوم (قرار 3 / FR-08-09) ============ */

  const applyCurrency = async (id: number, code: string) => {
    cart.setCurrency(id, code);
    // إعادة تسعير السلة بأسعار العملة الجديدة + تحديث المتاح
    const ids = cart.lines.map((l) => l.productId).filter((x): x is number => x !== null);
    if (ids.length > 0) {
      try {
        const db = await getDb();
        const [prices, stocks] = await Promise.all([
          fetchRetailPrices(db, ids, id),
          fetchStockTotals(db, ids),
        ]);
        cart.repriceLines(prices, stocks);
      } catch {
        // دفاعي
      }
    }
    feedback.show({ message: ar.sales.feedback.currencyChanged });
  };

  const onSelectCurrency = async (id: number | null) => {
    if (id === null || id === cart.currencyId) return;
    const cur = currencies.find((c) => c.id === id);
    if (!cur) return;
    if (cur.isBase || cur.id === defaults?.baseCurrencyId) {
      await applyCurrency(id, cur.code);
      return;
    }
    // عملة غير الأساس → فحص سعر اليوم الآن (قرار 3)
    try {
      const db = await getDb();
      await resolveRate(db, id, todayISO());
      await applyCurrency(id, cur.code);
    } catch (err) {
      if (err instanceof MissingRateError) {
        setRateValue('0');
        setRateCtx({
          currencyId: id,
          code: err.currencyCode,
          name: err.currencyName,
          onSaved: () => {
            void applyCurrency(id, cur.code);
          },
        });
        return;
      }
      feedback.show({ message: domainErrorMessage(err) ?? ar.sales.errors.saveFailed });
    }
  };

  /* ============ الحفظ (saveInvoice — Transaction ذرّية) ============ */

  const doSave = async (pay: SavePay, confirmBackdate = false) => {
    if (cart.lines.length === 0) {
      feedback.show({ message: ar.sales.errors.emptyCart });
      return;
    }
    if (totals.netInvalid) {
      feedback.show({ message: ar.sales.errors.netInvalid });
      return;
    }
    if (!defaults || !company) {
      feedback.show({ message: ar.sales.errors.saveFailed });
      return;
    }
    const db = await getDb();
    setSaving(true);
    try {
      const result = await saveInvoice(
        db,
        {
          docType: 'sale',
          payStatus: pay.payStatus,
          status: 'completed',
          issuedAt: todayISO(),
          customerId: cart.customer?.id,
          cashboxId: cart.cashboxId ?? undefined,
          warehouseId: defaults.warehouseId,
          currencyId: cart.currencyId ?? defaults.baseCurrencyId,
          lines: cart.lines.map((l) => ({
            productId: l.productId,
            qty: l.qty,
            unitPrice: l.unitPrice,
            discountPercent: d(l.lineDiscountPercent).gt(0) ? l.lineDiscountPercent : undefined,
            discountAmount: d(l.lineDiscountAmount).gt(0) ? l.lineDiscountAmount : undefined,
          })),
          discountAmount: d(cart.invoiceDiscount).gt(0) ? cart.invoiceDiscount : undefined,
          taxRate: d(taxRate).gt(0) ? taxRate : undefined,
          paidAmount: pay.payStatus === 'mixed' ? pay.paidAmount : undefined,
          notesPrinted: cart.notesPrinted.trim() !== '' ? cart.notesPrinted.trim() : undefined,
          notesInternal: cart.notesInternal.trim() !== '' ? cart.notesInternal.trim() : undefined,
        },
        { confirmBackdate, createdBy: session.user?.id },
      );
      cart.clearCart();
      setPickerAdded(0);
      feedback.show({
        message: ar.sales.feedback.saved.replace('{no}', result.invoiceNo ?? '—'),
        durationMs: 6000,
      });
      // الطباعة عند الحفظ (FR-02-14): إعداد invoicing.print_on_save
      // (ask/print/no — افتراضي ask) يُقرأ لحظة الحفظ ويُمرَّر لشاشة
      // التفاصيل: ask → حوار «اطبع الآن؟» / print → طباعة فورية / no → صمت.
      const printOnSave = await getSetting(
        db,
        'invoicing.print_on_save',
        z.enum(['print', 'no', 'ask']),
        'ask' as const,
      );
      const query = printOnSave === 'no' ? '' : `?print=${printOnSave}`;
      router.push(`/sales/${result.invoiceId}${query}`);
    } catch (err) {
      if (err instanceof MissingRateError) {
        // قرار 3: شيت سعر اليوم ثم إعادة المحاولة تلقائياً
        setRateValue('0');
        setRateCtx({
          currencyId: cart.currencyId ?? defaults.baseCurrencyId,
          code: err.currencyCode,
          name: err.currencyName,
          onSaved: () => {
            feedback.show({ message: ar.sales.rate.saved });
            void doSave(pay, confirmBackdate);
          },
        });
      } else if (err instanceof BackdateConfirmationRequiredError) {
        saveRetryRef.current = () => void doSave(pay, true);
        setBackdateMessage(err.message);
        setBackdateSheet(true);
      } else {
        feedback.show({ message: domainErrorMessage(err) ?? ar.sales.errors.saveFailed });
      }
    } finally {
      setSaving(false);
    }
  };

  /* ============ الدفع النقدي (PaymentSheet — DS-40) ============ */

  const onCashPress = () => {
    if (cart.lines.length === 0) {
      feedback.show({ message: ar.sales.errors.emptyCart });
      return;
    }
    if (totals.netInvalid) {
      feedback.show({ message: ar.sales.errors.netInvalid });
      return;
    }
    if (paymentSheetOn) {
      setPayVisible(true);
      return;
    }
    void doSave({ payStatus: 'cash' });
  };

  const onPayConfirm = (r: { received: string; mode: 'cash' | 'mixed' }) => {
    setPayVisible(false);
    if (r.mode === 'mixed') {
      void doSave({ payStatus: 'mixed', paidAmount: r.received });
    } else {
      void doSave({ payStatus: 'cash' });
    }
  };

  /* ============ الحفظ الآجل (تأكيد + حد الائتمان) ============ */

  const onCreditPress = async () => {
    if (cart.lines.length === 0) {
      feedback.show({ message: ar.sales.errors.emptyCart });
      return;
    }
    if (totals.netInvalid) {
      feedback.show({ message: ar.sales.errors.netInvalid });
      return;
    }
    if (!cart.customer) {
      feedback.show({ message: ar.sales.credit.needCustomer });
      setCustomerSheet(true);
      return;
    }
    try {
      const db = await getDb();
      const info = await fetchCustomerCreditInfo(db, cart.customer.id);
      let exposure: string | null = null;
      let limitHit = false;
      if (info.creditLimit !== null && d(info.creditLimit).gt(0)) {
        let rate = d(1);
        try {
          const resolved = await resolveRate(
            db,
            cart.currencyId ?? defaults?.baseCurrencyId ?? 1,
            todayISO(),
          );
          rate = d(resolved.rate);
        } catch {
          rate = d(1); // العرض تحذيري فقط — الحفظ سيتحقق ويرفض عند اللزوم
        }
        const thisBase = d(totals.total).times(rate);
        const used = d(info.openingBase).plus(d(info.dueBase)).plus(thisBase);
        exposure = used.toFixed(4);
        limitHit = used.gt(d(info.creditLimit));
      }
      setCreditInfo(info);
      setCreditExposure(exposure);
      setCreditLimitHit(limitHit);
      setCreditSheet(true);
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.sales.errors.saveFailed });
    }
  };

  /* ============ Park / المعلّقات ============ */

  const onPark = () => {
    const parked = cart.parkCart();
    if (!parked) {
      feedback.show({ message: ar.sales.errors.emptyCart });
      return;
    }
    setPickerAdded(0);
    feedback.show({
      message: ar.sales.feedback.parked.replace('{n}', String(useCart.getState().parked.length)),
    });
  };

  const restoreParkedFlow = (id: string) => {
    if (cart.lines.length > 0) {
      setReplaceParkedId(id);
      return;
    }
    const restored = cart.restoreParked(id);
    if (restored) {
      feedback.show({ message: ar.sales.feedback.unparked });
      void refreshAvailability();
    }
    setParkedSheet(false);
  };

  /* ============ شيت سعر الصرف (NumberPad — FR-08-09) ============ */

  const saveRate = async () => {
    if (!rateCtx) return;
    if (!d(rateValue).gt(0)) {
      feedback.show({ message: ar.sales.rate.invalid });
      return;
    }
    try {
      const db = await getDb();
      await upsertDailyRate(db, rateCtx.currencyId, todayISO(), rateValue);
      const onSaved = rateCtx.onSaved;
      setRateCtx(null);
      onSaved();
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.sales.rate.invalid });
    }
  };

  /* ============ حرّم الجلسة ============ */

  if (!session.ready || session.locked || !session.company) {
    return (
      <SafeScreen scroll={false} offline={false}>
        <AppCard noPadding>
          <LoadingState variant="list" rows={3} />
        </AppCard>
      </SafeScreen>
    );
  }

  const cashbox = cashboxes.find((c) => c.id === cart.cashboxId);
  const cashboxLabel = cashbox?.name ?? '—';
  const emptyCart = cart.lines.length === 0;

  return (
    <SafeScreen scroll={false} padded={false} offline>
      <View style={styles.screen}>
        {/* ——— الرأس: العنوان + قائمة الفواتير ——— */}
        <View style={styles.header}>
          <View style={styles.headerTitles}>
            <Text style={styles.headerTitle}>{ar.sales.newTitle}</Text>
            <Text style={styles.headerSubtitle}>
              {`${cartQtyCount} ${ar.sales.totals.itemsCount} · ${formatAmount(totals.total, currencyDecimals)} ${currencySymbol(currencyCode)}`}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.sales.list.title}
            onPress={() => router.push('/sales')}
            style={({ pressed }) => [styles.headerIcon, pressed && styles.headerIconPressed]}
            testID="sales-open-invoices"
          >
            <ClipboardList size={22} color={colors.textMuted} />
          </Pressable>
        </View>

        {/* ——— شريط الميتا القابل للطي (§6.5) ——— */}
        {metaCollapsed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.sales.meta.expand}
            onPress={() => setMetaCollapsed(false)}
            style={styles.collapsedBar}
          >
            <Text style={styles.collapsedText} numberOfLines={1}>
              {`${cart.customer ? cart.customer.name : ar.sales.meta.cashCustomer} · ${cashboxLabel} · ${currencyCode ?? '—'}`}
            </Text>
            <ChevronUp size={18} color={colors.textMuted} />
          </Pressable>
        ) : (
          <AppCard style={styles.metaCard}>
            <View style={styles.metaRow}>
              <MetaChip
                label={ar.sales.meta.customer}
                value={cart.customer ? cart.customer.name : ar.sales.meta.cashCustomer}
                iconText="👤"
                onPress={() => setCustomerSheet(true)}
                testID="sales-meta-customer"
              />
              <MetaChip
                label={ar.sales.meta.cashbox}
                value={cashboxLabel}
                iconText="🏦"
                onPress={cashboxes.length > 1 ? () => setCashboxSheet(true) : undefined}
                testID="sales-meta-cashbox"
              />
              <MetaChip
                label={ar.sales.meta.currency}
                value={currencyCode ?? '—'}
                iconText="₩"
                onPress={() => setCurrencySheet(true)}
                testID="sales-meta-currency"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ar.sales.meta.collapse}
                onPress={() => setMetaCollapsed(true)}
                hitSlop={6}
                style={styles.collapseBtn}
              >
                <ChevronDown size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          </AppCard>
        )}

        {/* ——— شريط المعلّقات (Chip ظاهر عند وجود معلّقات — FR-02-13) ——— */}
        {cart.parked.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.sales.parked.chip}
            onPress={() => setParkedSheet(true)}
            style={({ pressed }) => [styles.parkedChip, pressed && styles.parkedChipPressed]}
            testID="sales-parked-chip"
          >
            <Pause size={16} color={colors.warning} />
            <Text style={styles.parkedChipText}>
              {`${ar.sales.parked.chip} (${cart.parked.length})`}
            </Text>
          </Pressable>
        ) : null}

        {/* ——— بنود الفاتورة الحية ——— */}
        <FlatList
          data={cart.lines}
          keyExtractor={(l) => l.key}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <AppCard noPadding>
              <EmptyState
                title={ar.sales.cart.addFirst}
                message={ar.sales.cart.addFirstHint}
                actionLabel={ar.sales.cart.addItem}
                onAction={() => setPickerVisible(true)}
              />
            </AppCard>
          }
          renderItem={({ item }) => (
            <CartLineRow
              line={item}
              lineTotal={lineTotalByKey.get(item.key) ?? '0'}
              currencyCode={currencyCode}
              decimals={currencyDecimals}
              onQtyChange={(qty) => cart.setQty(item.key, qty)}
              onPriceChange={(price) => cart.setPrice(item.key, price)}
              onDelete={() => deleteLine(item)}
              onOpenEdit={() => setEditLineKey(item.key)}
              testID={`cart-line-${item.key}`}
            />
          )}
        />

        {/* ——— إضافة صنف + الإجماليات الثابتة + الأزرار الرباعية (LDR-1) ——— */}
        <View style={styles.bottomBar}>
          <View style={styles.addRow}>
            <PrimaryButton
              label={ar.sales.cart.addItem}
              tone="ghost"
              onPress={() => {
                setPickerAdded(0);
                setPickerVisible(true);
              }}
              style={styles.addBtn}
              testID="sales-add-item"
            />
            <Text style={styles.itemsHint}>
              {`${cartQtyCount} ${ar.sales.totals.itemsCount}`}
            </Text>
          </View>

          <View style={styles.totalsCard}>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>{ar.sales.totals.subtotal}</Text>
              <AmountDisplay
                value={totals.subtotal}
                decimals={currencyDecimals}
                currencyCode={currencyCode}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={ar.sales.totals.discount}
              onPress={() => setDiscountSheet(true)}
              style={({ pressed }) => [styles.totalsRow, pressed && styles.totalsRowPressed]}
              testID="sales-discount-row"
            >
              <View style={styles.discountLabelWrap}>
                <Text style={styles.totalsLabel}>{ar.sales.totals.discount}</Text>
                <Pencil size={12} color={colors.textFaint} />
              </View>
              <AmountDisplay
                value={d(totals.linesDiscount).plus(d(totals.invoiceDiscount)).toFixed(4)}
                decimals={currencyDecimals}
                currencyCode={currencyCode}
                tone={d(totals.linesDiscount).plus(d(totals.invoiceDiscount)).gt(0) ? 'warning' : undefined}
              />
            </Pressable>
            {d(totals.taxAmount).gt(0) ? (
              <View style={styles.totalsRow}>
                <Text style={styles.totalsLabel}>{`${ar.sales.totals.tax} (${formatQty(totals.taxRate)}%)`}</Text>
                <AmountDisplay
                  value={totals.taxAmount}
                  decimals={currencyDecimals}
                  currencyCode={currencyCode}
                />
              </View>
            ) : null}
            <View style={[styles.totalsRow, styles.totalRow]}>
              <Text style={styles.totalLabel}>{ar.sales.totals.total}</Text>
              <AmountDisplay
                value={totals.total}
                decimals={currencyDecimals}
                currencyCode={currencyCode}
                size="display"
                tone={totals.netInvalid ? 'warning' : 'neutral'}
              />
            </View>
          </View>

          {/* الشريط الرباعي الملزم (LDR-1) */}
          <View style={styles.actionsRow}>
            <ActionButton
              label={ar.sales.actions.cash}
              tone="success"
              onPress={onCashPress}
              disabled={emptyCart || saving}
              flex={1.5}
              testID="sales-save-cash"
            />
            <ActionButton
              label={ar.sales.actions.credit}
              tone="warning"
              onPress={() => void onCreditPress()}
              disabled={emptyCart || saving}
              flex={1.5}
              testID="sales-save-credit"
            />
            <ActionButton
              label={ar.sales.actions.park}
              icon={Pause}
              tone="ghost"
              onPress={onPark}
              disabled={emptyCart || saving}
              flex={0.9}
              testID="sales-park"
            />
            <ActionButton
              label={ar.sales.actions.extras}
              icon={MoreHorizontal}
              tone="ghost"
              onPress={() => setExtrasSheet(true)}
              flex={0.9}
              testID="sales-extras"
            />
          </View>
        </View>
      </View>

      {/* ============ الشيتات ============ */}

      {/* منتقي الأصناف (FR-02-02) */}
      <ItemPickerSheet
        visible={pickerVisible}
        onClose={() => {
          setPickerVisible(false);
          void refreshAvailability();
        }}
        currencyId={cart.currencyId}
        currencyCode={currencyCode}
        decimals={currencyDecimals}
        onPick={pickProduct}
        addedCount={pickerAdded}
        cartCount={cartQtyCount}
        onScanToast={() => feedback.show({ message: ar.sales.picker.scanToast })}
      />

      {/* شيت تعديل البند */}
      <LineEditSheet
        visible={editLine !== null}
        onClose={() => setEditLineKey(null)}
        line={editLine}
        lineTotal={editLine ? lineTotalByKey.get(editLine.key) ?? '0' : '0'}
        currencyCode={currencyCode}
        decimals={currencyDecimals}
        onQtyChange={(qty) => editLine && cart.setQty(editLine.key, qty)}
        onPriceChange={(price) => editLine && cart.setPrice(editLine.key, price)}
        onDiscountChange={(kind, value) => editLine && cart.setLineDiscount(editLine.key, kind, value)}
      />

      {/* خصم الفاتورة (NumberPad) */}
      <BottomSheet
        visible={discountSheet}
        onClose={() => setDiscountSheet(false)}
        title={ar.sales.totals.discount}
      >
        <NumberPad
          value={cart.invoiceDiscount}
          onChange={cart.setInvoiceDiscount}
          allowDecimal={currencyDecimals > 0}
          decimals={currencyDecimals}
          label={`${ar.sales.totals.discount} — ${ar.sales.totals.subtotal} ${formatAmount(totals.subtotal, currencyDecimals)}`}
          onDone={() => setDiscountSheet(false)}
        />
      </BottomSheet>

      {/* منتقي العميل (بحث + عميل نقدي + عميل جديد) */}
      <BottomSheet
        visible={customerSheet}
        onClose={() => setCustomerSheet(false)}
        title={ar.sales.meta.pickCustomer}
      >
        <SearchBar
          value={customerSearch}
          onChangeText={setCustomerSearch}
          placeholder={ar.sales.meta.searchCustomer}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ar.sales.meta.walkIn}
          onPress={() => {
            const prev = cart.customer;
            cart.setCustomer(null);
            setCustomerSheet(false);
            if (prev) {
              feedback.show({
                message: `${ar.sales.meta.customer}: ${ar.sales.meta.cashCustomer}`,
                actionLabel: ar.common.undo,
                onAction: () => cart.setCustomer(prev),
              });
            }
          }}
          style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
        >
          <Text style={styles.partyRowTitle}>{ar.sales.meta.walkIn}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ar.sales.meta.addCustomer}
          onPress={() => {
            setCustomerSheet(false);
            router.push('/parties/party-edit?kind=customer');
          }}
          style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
        >
          <Text style={[styles.partyRowTitle, { color: colors.accent }]}>
            {ar.sales.meta.addCustomer}
          </Text>
        </Pressable>
        {customers.map((c) => (
          <Pressable
            key={c.id}
            accessibilityRole="button"
            accessibilityLabel={c.name}
            onPress={() => {
              const prev = cart.customer;
              cart.setCustomer({ id: c.id, name: c.name });
              setCustomerSheet(false);
              if (!prev || prev.id !== c.id) {
                feedback.show({
                  message: `${ar.sales.meta.customer}: ${c.name}`,
                  actionLabel: prev ? ar.common.undo : undefined,
                  onAction: prev ? () => cart.setCustomer(prev) : undefined,
                });
              }
            }}
            style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
            testID={`customer-row-${c.id}`}
          >
            <Text style={styles.partyRowTitle}>{c.name}</Text>
            {c.phone ? <Text style={styles.partyRowSub}>{c.phone}</Text> : null}
          </Pressable>
        ))}
      </BottomSheet>

      {/* منتقي الصندوق (متعدد فقط) */}
      <OptionPicker
        visible={cashboxSheet}
        title={ar.sales.meta.pickCashbox}
        options={cashboxes.map((c) => ({ id: c.id, label: c.name }))}
        selectedId={cart.cashboxId}
        onSelect={(id) => id !== null && cart.setCashbox(id)}
        onClose={() => setCashboxSheet(false)}
      />

      {/* منتقي العملة */}
      <OptionPicker
        visible={currencySheet}
        title={ar.sales.meta.pickCurrency}
        options={currencies.map((c) => ({ id: c.id, label: c.name, detail: c.code }))}
        selectedId={cart.currencyId}
        onSelect={(id) => void onSelectCurrency(id)}
        onClose={() => setCurrencySheet(false)}
      />

      {/* لوحة الدفع (DS-40) */}
      {payVisible ? (
        <PaymentSheet
          visible
          total={totals.total}
          currencyCode={currencyCode ?? undefined}
          decimals={currencyDecimals}
          onConfirm={onPayConfirm}
          onClose={() => setPayVisible(false)}
          testID="sales-payment-sheet"
        />
      ) : null}

      {/* تأكيد الحفظ الآجل + تحذير حد الائتمان */}
      <BottomSheet
        visible={creditSheet}
        onClose={() => setCreditSheet(false)}
        title={ar.sales.credit.title}
      >
        <Text style={styles.creditMessage}>{ar.sales.credit.message}</Text>
        <View style={styles.creditInfoCard}>
          <InfoRow label={ar.sales.meta.customer} value={cart.customer?.name ?? '—'} />
          <InfoRow
            label={ar.sales.totals.total}
            value={`${formatAmount(totals.total, currencyDecimals)} ${currencySymbol(currencyCode)}`}
          />
          {creditInfo && creditInfo.creditLimit !== null && d(creditInfo.creditLimit).gt(0) ? (
            <>
              <InfoRow
                label={ar.sales.credit.limitLabel}
                value={`${formatAmount(creditInfo.creditLimit, 0)} ${currencySymbol(defaults?.baseCurrencyCode)}`}
              />
              <InfoRow
                label={ar.sales.credit.exposure}
                value={`${formatAmount(creditExposure ?? '0', 0)} ${currencySymbol(defaults?.baseCurrencyCode)}`}
              />
            </>
          ) : null}
        </View>
        {creditLimitHit ? (
          <View style={styles.creditWarn}>
            <Text style={styles.creditWarnTitle}>{ar.sales.credit.limitExceeded}</Text>
            <Text style={styles.creditWarnHint}>{ar.sales.credit.limitExceededHint}</Text>
          </View>
        ) : null}
        <PrimaryButton
          label={ar.sales.credit.confirm}
          tone="warning"
          disabled={saving}
          onPress={() => {
            setCreditSheet(false);
            void doSave({ payStatus: 'credit' });
          }}
          testID="credit-confirm-save"
        />
        <PrimaryButton
          label={ar.common.cancel}
          tone="ghost"
          onPress={() => setCreditSheet(false)}
        />
      </BottomSheet>

      {/* المعلّقات */}
      <BottomSheet
        visible={parkedSheet}
        onClose={() => setParkedSheet(false)}
        title={ar.sales.parked.title}
      >
        {cart.parked.length === 0 ? (
          <Text style={styles.parkedEmpty}>{ar.sales.parked.emptyHint}</Text>
        ) : (
          cart.parked.map((p) => (
            <View key={p.id} style={styles.parkedRow}>
              <View style={styles.parkedRowTexts}>
                <Text style={styles.parkedRowTitle}>
                  {p.cart.customer ? p.cart.customer.name : ar.sales.meta.cashCustomer}
                </Text>
                <Text style={styles.parkedRowSub}>
                  {`${p.cart.lines.length} ${ar.sales.parked.lines} · ${formatDateAr(p.at.slice(0, 10))} · ${formatAmount(
                    p.cart.lines
                      .reduce((acc, l) => acc + Number(l.qty) * Number(l.unitPrice), 0)
                      .toFixed(4),
                    currencyDecimals,
                  )}`}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ar.sales.parked.restore}
                onPress={() => restoreParkedFlow(p.id)}
                style={({ pressed }) => [styles.parkedAction, pressed && styles.parkedActionPressed]}
              >
                <Text style={styles.parkedActionRestore}>{ar.sales.parked.restore}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ar.sales.parked.delete}
                onPress={() => {
                  cart.deleteParked(p.id);
                  feedback.show({ message: ar.sales.feedback.parkedDeleted });
                }}
                style={({ pressed }) => [styles.parkedAction, pressed && styles.parkedActionPressed]}
              >
                <Text style={styles.parkedActionDelete}>{ar.sales.parked.delete}</Text>
              </Pressable>
            </View>
          ))
        )}
      </BottomSheet>

      {/* إضافات: الملاحظات + مسح السلة */}
      <BottomSheet
        visible={extrasSheet}
        onClose={() => setExtrasSheet(false)}
        title={ar.sales.extras.title}
      >
        <TextField
          label={ar.sales.extras.notesPrinted}
          value={cart.notesPrinted}
          onChangeText={(v) => cart.setNotes(v, cart.notesInternal)}
          placeholder={ar.sales.extras.notesPrintedPh}
          multiline
        />
        <TextField
          label={ar.sales.extras.notesInternal}
          value={cart.notesInternal}
          onChangeText={(v) => cart.setNotes(cart.notesPrinted, v)}
          placeholder={ar.sales.extras.notesInternalPh}
          multiline
        />
        <PrimaryButton
          label={ar.sales.extras.clear}
          tone="danger"
          disabled={emptyCart}
          onPress={() => {
            setExtrasSheet(false);
            setClearSheet(true);
          }}
          testID="extras-clear-cart"
        />
      </BottomSheet>

      {/* تأكيد مسح السلة (كلمة «مسح») */}
      <ConfirmSheet
        visible={clearSheet}
        title={ar.sales.extras.clearTitle}
        message={ar.sales.extras.clearBody}
        confirmWord={ar.sales.extras.clearWord}
        danger
        onConfirm={() => {
          cart.clearCart();
          setPickerAdded(0);
          setClearSheet(false);
          feedback.show({ message: ar.sales.feedback.cleared });
        }}
        onCancel={() => setClearSheet(false)}
        testID="clear-cart-confirm"
      />

      {/* استعادة معلّقة فوق سلة حالية → تعليق الحالية أولاً */}
      <ConfirmSheet
        visible={replaceParkedId !== null}
        title={ar.sales.parked.replaceTitle}
        message={ar.sales.parked.replaceBody}
        danger={false}
        onConfirm={() => {
          const id = replaceParkedId;
          setReplaceParkedId(null);
          if (id === null) return;
          cart.parkCart();
          const restored = cart.restoreParked(id);
          setParkedSheet(false);
          if (restored) {
            feedback.show({ message: ar.sales.feedback.unparked });
            void refreshAvailability();
          }
        }}
        onCancel={() => setReplaceParkedId(null)}
        testID="replace-parked-confirm"
      />

      {/* تأكيد التأريخ الرجعي (كلمة «متابعة») */}
      <ConfirmSheet
        visible={backdateSheet}
        title={ar.sales.backdate.title}
        message={backdateMessage ?? undefined}
        confirmWord={ar.sales.backdate.confirmWord}
        danger={false}
        onConfirm={() => {
          setBackdateSheet(false);
          saveRetryRef.current?.();
        }}
        onCancel={() => setBackdateSheet(false)}
        testID="backdate-confirm"
      />

      {/* شيت سعر صرف اليوم (قرار 3) */}
      <BottomSheet
        visible={rateCtx !== null}
        title={`${ar.sales.rate.title} — ${rateCtx?.name ?? ''} (${rateCtx?.code ?? ''})`}
      >
        <NumberPad
          value={rateValue}
          onChange={setRateValue}
          allowDecimal
          decimals={4}
          label={ar.sales.rate.label}
        />
        <Text style={styles.rateHint}>{ar.sales.rate.hint}</Text>
        <PrimaryButton label={ar.sales.rate.save} onPress={() => void saveRate()} testID="rate-save" />
      </BottomSheet>

      {feedback.host}
    </SafeScreen>
  );
}

/* ============ عناصر محلية ============ */

function AmountDisplay({
  value,
  decimals,
  currencyCode,
  size = 'md',
  tone,
}: {
  value: string;
  decimals: number;
  currencyCode: string | null;
  size?: 'md' | 'lg' | 'display';
  tone?: 'neutral' | 'warning';
}) {
  return (
    <View style={styles.amountWrap}>
      <Text
        style={[
          size === 'display' ? styles.amountDisplay : styles.amountValue,
          tone === 'warning' ? { color: colors.warning } : null,
        ]}
        numberOfLines={1}
        adjustsFontSizeToFit={size === 'display'}
      >
        {`${formatAmount(value, decimals)}${currencyCode ? ` ${currencySymbol(currencyCode)}` : ''}`}
      </Text>
    </View>
  );
}

function MetaChip({
  label,
  value,
  iconText,
  onPress,
  testID,
}: {
  label: string;
  value: string;
  iconText: string;
  onPress?: () => void;
  testID?: string;
}) {
  const body = (
    <View style={styles.metaChip}>
      <Text style={styles.metaChipLabel}>{label}</Text>
      <Text style={styles.metaChipValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
  if (!onPress) {
    return (
      <View style={styles.metaChipWrapStatic} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      style={({ pressed }) => [styles.metaChipWrap, pressed && styles.metaChipPressed]}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function ActionButton({
  label,
  icon,
  tone,
  onPress,
  disabled,
  flex,
  testID,
}: {
  label: string;
  icon?: React.ComponentType<{ size?: number; color?: string }>;
  tone: 'success' | 'warning' | 'ghost';
  onPress: () => void;
  disabled?: boolean;
  flex: number;
  testID?: string;
}) {
  const TONES: Record<typeof tone, { bg: string; fg: string; border?: string }> = {
    success: { bg: colors.success, fg: colors.onAccent },
    warning: { bg: colors.warning, fg: colors.onAccent },
    ghost: { bg: 'transparent', fg: colors.textMuted, border: colors.border },
  };
  const t = TONES[tone];
  const Icon = icon;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.actionBtn,
        { flex, backgroundColor: t.bg },
        t.border ? { borderWidth: 1, borderColor: t.border } : null,
        pressed && !disabled && styles.actionBtnPressed,
        disabled && styles.actionBtnDisabled,
      ]}
    >
      {Icon ? <Icon size={17} color={t.fg} /> : null}
      <Text style={[styles.actionBtnLabel, { color: t.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** منتقي خيارات محلي (OptionPickerSheet بلا «بدون») — سلوك مطابق */
function OptionPicker({
  visible,
  title,
  options,
  selectedId,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: { id: number; label: string; detail?: string }[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title}>
      {options.map((opt) => (
        <Pressable
          key={opt.id}
          accessibilityRole="button"
          accessibilityLabel={opt.label}
          onPress={() => {
            onSelect(opt.id);
            onClose();
          }}
          style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
        >
          <Text style={styles.partyRowTitle}>{opt.label}</Text>
          {opt.detail ? <Text style={styles.partyRowSub}>{opt.detail}</Text> : null}
          {opt.id === selectedId ? (
            <Text style={styles.optionCheck}>✓</Text>
          ) : (
            <Text style={styles.optionCheckPlaceholder}> </Text>
          )}
        </Pressable>
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerTitles: {
    flex: 1,
  },
  headerTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 20,
    lineHeight: 28,
  },
  headerSubtitle: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  headerIcon: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
  metaCard: {
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  metaChipWrap: {
    flex: 1,
  },
  metaChipWrapStatic: {
    flex: 1,
    opacity: 0.85,
  },
  metaChipPressed: {
    opacity: 0.75,
  },
  metaChip: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 0,
  },
  metaChipLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 15,
  },
  metaChipValue: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  collapseBtn: {
    width: 36,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapsedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  collapsedText: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  parkedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  parkedChipPressed: {
    opacity: 0.75,
  },
  parkedChipText: {
    color: colors.warning,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  list: {
    flex: 1,
  },
  listContent: {
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  bottomBar: {
    gap: spacing.sm,
    paddingBottom: spacing.xs,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  addBtn: {
    flex: 1,
  },
  itemsHint: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  totalsCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: 2,
  },
  totalsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 30,
  },
  totalsRowPressed: {
    opacity: 0.7,
  },
  discountLabelWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  totalsLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  totalRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: 4,
    paddingTop: 8,
    minHeight: 40,
  },
  totalLabel: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  amountWrap: {
    maxWidth: '70%',
  },
  amountValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'left',
  },
  amountDisplay: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 26,
    lineHeight: 34,
    textAlign: 'left',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: touch.min,
    borderRadius: radius.md,
    paddingHorizontal: 8,
  },
  actionBtnPressed: {
    opacity: 0.82,
  },
  actionBtnDisabled: {
    opacity: 0.45,
  },
  actionBtnLabel: {
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  partyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touch.min + 8,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  partyRowPressed: {
    borderColor: colors.accent,
    backgroundColor: '#24334A',
  },
  partyRowTitle: {
    flex: 1,
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  partyRowSub: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  optionCheck: {
    color: colors.accent,
    fontSize: 16,
  },
  optionCheckPlaceholder: {
    color: 'transparent',
    fontSize: 16,
  },
  creditMessage: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  creditInfoCard: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 6,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  infoLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  infoValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'left',
  },
  creditWarn: {
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.45)',
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 2,
  },
  creditWarnTitle: {
    color: colors.warning,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  creditWarnHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  parkedEmpty: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  parkedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  parkedRowTexts: {
    flex: 1,
    gap: 2,
  },
  parkedRowTitle: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  parkedRowSub: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  parkedAction: {
    minHeight: 44,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  parkedActionPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
  parkedActionRestore: {
    color: colors.accent,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
  },
  parkedActionDelete: {
    color: colors.danger,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
  },
  rateHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
