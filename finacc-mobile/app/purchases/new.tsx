/**
 * purchases/new.tsx — شاشة فاتورة الشراء ⭐ (Task 8 — FR-02-08، بنية §6.5 نفسها):
 *
 *  نفس نمط الكاشير (sales/new) بإعادة استخدام المكونات لا بتشعيب الملف:
 *  - أعلى: شريط ميتا قابل للطي (**المورّد** [بحث + مورّد نقدي + مورّد جديد]
 *    + صندوق + عملة بنفس تدفق فحص سعر اليوم — قرار 3).
 *  - منتصف: بنود حية (QtyStepper + **تكلفة الشراء للوحدة** بNumberPad — ليست
 *    سعر البيع) + «المتوفر حالياً: N» محايد (الشراء يزيد المخزون — لا قيد متاح)
 *    + منتقي أصناف variant='purchase' (الأكثر شراءً + تكلفة).
 *  - أسفل (ثابت): المجموع/الخصم (مستوى الفاتورة — توزيعه pro-rata على البنود
 *    قبل تحديث WAC حكر الدومين 5.4-3)/الضريبة/الإجمالي + شريط الأزرار الرباعي:
 *    **حفظ نقدي (أخضر — دفع من الصندوق فوراً)** / **حفظ آجل (كهرماني — على
 *    حساب المورّد)** / تعليق (نفس آلية Park بمفاتيح purchase مستقلة) / إضافات (…).
 *  - لا PaymentSheet للشراء في V1 (لوحة الدفع DS-40 هي تدفق البيع): النقدي يدفع
 *    الإجمالي كاملاً، والآجل كله على الحساب. **الشراء المختلط (جزء نقدي) مؤجَّل
 *    V1.1 موثَّقاً** — الدومين يدعمه (paidAmount) لكن الواجهة تُبقي زرّين.
 *  - الحفظ عبر domain.saveInvoice (Transaction ذرّية) → تفاصيل + «اطبع بعد
 *    الحفظ؟» (print_on_save=ask) — القالب يدعم «فاتورة شراء» أصلاً (المهمة 7).
 *  - مسودة سلة الشراء ومعلّقاتها بمفاتيح purchase-cart-draft/parked مستقلة
 *    عن البيع (FR-02-13 — تعايش بلا تزاحم).
 *  - أخطاء الدومين: MissingRateError → شيت سعر اليوم ثم إعادة الحفظ تلقائياً؛
 *    BackdateConfirmationRequired → تأكيد «متابعة»؛ الباقي FeedbackBar.
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
  fetchPurchasableProductsByIds,
  listActiveCurrencies,
  listCashboxes,
  type CashboxLite,
  type CurrencyLite,
} from '@/db/queries';
import { saveInvoice } from '@/domain/invoicing';
import { resolveRate, upsertDailyRate } from '@/domain/currency';
import { getSetting } from '@/domain/settings';
import { listSuppliers, type PartyRow } from '@/domain/parties';
import {
  BackdateConfirmationRequiredError,
  MissingRateError,
} from '@/domain/errors';
import { useSession } from '@/store/session';
import { computeCartTotals, usePurchaseCart, type CartLine } from '@/store/cart';
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
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
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

export default function NewPurchaseScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const session = useSession();
  const cart = usePurchaseCart();

  /* ——— إعدادات الشاشة ——— */
  const [cashboxes, setCashboxes] = useState<CashboxLite[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyLite[]>([]);
  const [metaCollapsed, setMetaCollapsed] = useState(false);
  /** سعر عملة السلة بالأساس (الأساس='1') — لتحويل التكلفة في المنتقي */
  const [cartRate, setCartRate] = useState('1');

  /* ——— الشيتات ——— */
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerAdded, setPickerAdded] = useState(0);
  const [editLineKey, setEditLineKey] = useState<string | null>(null);
  const [discountSheet, setDiscountSheet] = useState(false);
  const [extrasSheet, setExtrasSheet] = useState(false);
  const [clearSheet, setClearSheet] = useState(false);
  const [parkedSheet, setParkedSheet] = useState(false);
  const [replaceParkedId, setReplaceParkedId] = useState<string | null>(null);
  const [supplierSheet, setSupplierSheet] = useState(false);
  const [supplierSearch, setSupplierSearch] = useState('');
  const [suppliers, setSuppliers] = useState<PartyRow[]>([]);
  const [cashboxSheet, setCashboxSheet] = useState(false);
  const [currencySheet, setCurrencySheet] = useState(false);
  const [creditSheet, setCreditSheet] = useState(false);
  const [backdateSheet, setBackdateSheet] = useState(false);
  const [backdateMessage, setBackdateMessage] = useState<string | null>(null);
  const [rateCtx, setRateCtx] = useState<RateSheetCtx | null>(null);
  const [rateValue, setRateValue] = useState('0');

  const [saving, setSaving] = useState(false);
  const hydratedOnce = useRef(false);
  const supplierSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRetryRef = useRef<(() => void) | null>(null);

  const defaults = session.defaults;
  const company = session.company;
  const taxRate = company?.taxRate ?? '0';
  const currencyDecimals =
    currencies.find((c) => c.id === cart.currencyId)?.decimals ?? 0;
  const currencyCode = cart.currencyCode;
  const isBaseCurrency =
    cart.currencyId === null || cart.currencyId === defaults?.baseCurrencyId;

  /* ——— التهيئة: ميتا + إعدادات + مسودة الشراء (مرة واحدة) ——— */
  useEffect(() => {
    if (hydratedOnce.current || !session.ready || session.locked) return;
    hydratedOnce.current = true;
    cart.hydrate({
      cashboxId: defaults?.cashboxId ?? null,
      currencyId: defaults?.baseCurrencyId ?? null,
      currencyCode: defaults?.baseCurrencyCode ?? null,
    });
    const state = usePurchaseCart.getState();
    if (state.restored && state.lines.length > 0) {
      feedback.show({ message: ar.purchases.feedback.restored, durationMs: 9000 });
      state.markRestoredSeen();
    }
    (async () => {
      try {
        const db = await getDb();
        const [boxes, curs] = await Promise.all([
          listCashboxes(db),
          listActiveCurrencies(db),
        ]);
        setCashboxes(boxes);
        setCurrencies(curs);
      } catch {
        // دفاعي: القوائم فارغة تعني منتقي أضيق — لا يوقف الشاشة
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.ready, session.locked]);

  /* ——— تحديث «المتوفر حالياً» + تكلفة WAC عند العودة للشاشة ——— */
  const refreshLines = useCallback(async () => {
    const state = usePurchaseCart.getState();
    const ids = state.lines
      .filter((l) => !l.isService && l.productId !== null)
      .map((l) => l.productId!);
    if (ids.length === 0) return;
    try {
      const db = await getDb();
      const prods = await fetchPurchasableProductsByIds(db, ids, cartRate);
      const stocks = new Map<number, string>();
      for (const [id, p] of prods) stocks.set(id, p.stockTotal);
      state.refreshAvailability(stocks);
    } catch {
      // عرض فقط — نتجاهل
    }
  }, [cartRate]);

  useFocusEffect(
    useCallback(() => {
      void refreshLines();
    }, [refreshLines]),
  );

  /* ——— بحث المورّدين داخل الشيت ——— */
  useEffect(() => {
    if (!supplierSheet) return;
    if (supplierSearchTimer.current) clearTimeout(supplierSearchTimer.current);
    supplierSearchTimer.current = setTimeout(async () => {
      try {
        const db = await getDb();
        setSuppliers(await listSuppliers(db, { search: supplierSearch, limit: 50 }));
      } catch {
        setSuppliers([]);
      }
    }, 200);
    return () => {
      if (supplierSearchTimer.current) clearTimeout(supplierSearchTimer.current);
    };
  }, [supplierSheet, supplierSearch]);

  /* ============ المجاميع — مطابقة للدومين حرفياً ============ */

  const totals = computeCartTotals(
    { lines: cart.lines, invoiceDiscount: cart.invoiceDiscount },
    taxRate,
    'on_total',
  );
  const lineTotalByKey = new Map(totals.lines.map((l) => [l.key, l.total]));
  const cartQtyCount = cart.lines.length;
  const editLine = cart.lines.find((l) => l.key === editLineKey) ?? null;

  /* ============ إضافة/تعديل البنود (السعر = تكلفة الشراء) ============ */

  const pickProduct = (p: PickableProduct) => {
    tapHaptic();
    const cost = 'cost' in p ? p.cost : '0';
    const stock = p.isService ? '' : p.stockTotal;
    const existing = cart.lines.find((l) => l.productId === p.id);
    if (existing) {
      // موجود مسبقاً → +1 (سلوك الكاشير) دون مس السعر المُحرَّر يدوياً
      cart.setQty(existing.key, d(existing.qty).plus(1).toFixed(3));
    } else {
      cart.addItem({
        productId: p.id,
        name: p.name,
        isService: p.isService,
        price: cost,
        available: stock,
      });
    }
    setPickerAdded((n) => n + 1);
  };

  const deleteLine = (line: CartLine) => {
    const removed = cart.removeLine(line.key);
    if (!removed) return;
    feedback.show({
      message: ar.purchases.cart.lineDeleted,
      actionLabel: ar.common.undo,
      onAction: () => cart.insertLineAt(removed.line, removed.index),
    });
  };

  /* ============ اختيار العملة + سعر اليوم (قرار 3 / FR-08-09) ============ */

  const applyCurrency = async (id: number, code: string, rate: string) => {
    const prevRate = cartRate;
    cart.setCurrency(id, code);
    setCartRate(rate);
    // إعادة تسعير السلة بتكلفة العملة الجديدة + تحديث المتوفر
    const ids = cart.lines.map((l) => l.productId).filter((x): x is number => x !== null);
    if (ids.length > 0) {
      try {
        const db = await getDb();
        const prods = await fetchPurchasableProductsByIds(db, ids, rate);
        const prices = new Map<number, string>();
        const stocks = new Map<number, string>();
        for (const [pid, p] of prods) {
          prices.set(pid, p.cost);
          stocks.set(pid, p.stockTotal);
        }
        // إعادة التسعير: تكلفة من الأساس بالسعر الجديد (لا التحويل النسبي)
        cart.repriceLines(prices, stocks);
      } catch {
        // دفاعي
      }
    }
    if (prevRate !== rate) {
      feedback.show({ message: ar.purchases.feedback.currencyChanged });
    }
  };

  const onSelectCurrency = async (id: number | null) => {
    if (id === null || id === cart.currencyId) return;
    const cur = currencies.find((c) => c.id === id);
    if (!cur) return;
    if (cur.isBase || cur.id === defaults?.baseCurrencyId) {
      await applyCurrency(id, cur.code, '1');
      return;
    }
    // عملة غير الأساس → فحص سعر اليوم الآن (قرار 3)
    try {
      const db = await getDb();
      const resolved = await resolveRate(db, id, todayISO());
      await applyCurrency(id, cur.code, resolved.rate);
    } catch (err) {
      if (err instanceof MissingRateError) {
        setRateValue('0');
        setRateCtx({
          currencyId: id,
          code: err.currencyCode,
          name: err.currencyName,
          onSaved: () => {
            void (async () => {
              const db = await getDb();
              const resolved = await resolveRate(db, id, todayISO());
              await applyCurrency(id, cur.code, resolved.rate);
            })();
          },
        });
        return;
      }
      feedback.show({ message: domainErrorMessage(err) ?? ar.purchases.errors.saveFailed });
    }
  };

  /* ============ الحفظ (saveInvoice docType='purchase' — ذرّية) ============ */

  const doSave = async (pay: SavePay, confirmBackdate = false) => {
    if (cart.lines.length === 0) {
      feedback.show({ message: ar.purchases.errors.emptyCart });
      return;
    }
    if (totals.netInvalid) {
      feedback.show({ message: ar.purchases.errors.netInvalid });
      return;
    }
    if (!defaults || !company) {
      feedback.show({ message: ar.purchases.errors.saveFailed });
      return;
    }
    const db = await getDb();
    setSaving(true);
    try {
      const result = await saveInvoice(
        db,
        {
          docType: 'purchase',
          payStatus: pay.payStatus,
          status: 'completed',
          issuedAt: todayISO(),
          supplierId: cart.customer?.id,
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
        message: ar.purchases.feedback.saved.replace('{no}', result.invoiceNo ?? '—'),
        durationMs: 6000,
      });
      // الطباعة عند الحفظ (FR-02-14): إعداد invoicing.print_on_save يُقرأ لحظة الحفظ
      const printOnSave = await getSetting(
        db,
        'invoicing.print_on_save',
        z.enum(['print', 'no', 'ask']),
        'ask' as const,
      );
      const query = printOnSave === 'no' ? '' : `?print=${printOnSave}`;
      router.push(`/purchases/${result.invoiceId}${query}`);
    } catch (err) {
      if (err instanceof MissingRateError) {
        // قرار 3: شيت سعر اليوم ثم إعادة المحاولة تلقائياً
        setRateValue('0');
        setRateCtx({
          currencyId: cart.currencyId ?? defaults.baseCurrencyId,
          code: err.currencyCode,
          name: err.currencyName,
          onSaved: () => {
            feedback.show({ message: ar.purchases.rate.saved });
            void doSave(pay, confirmBackdate);
          },
        });
      } else if (err instanceof BackdateConfirmationRequiredError) {
        saveRetryRef.current = () => void doSave(pay, true);
        setBackdateMessage(err.message);
        setBackdateSheet(true);
      } else {
        feedback.show({ message: domainErrorMessage(err) ?? ar.purchases.errors.saveFailed });
      }
    } finally {
      setSaving(false);
    }
  };

  /* ============ الحفظ الآجل (تأكيد على حساب المورّد) ============ */

  const onCreditPress = () => {
    if (cart.lines.length === 0) {
      feedback.show({ message: ar.purchases.errors.emptyCart });
      return;
    }
    if (totals.netInvalid) {
      feedback.show({ message: ar.purchases.errors.netInvalid });
      return;
    }
    if (!cart.customer) {
      feedback.show({ message: ar.purchases.credit.needSupplier });
      setSupplierSheet(true);
      return;
    }
    setCreditSheet(true);
  };

  /* ============ Park / معلّقات الشراء (نفس الآلية — نطاق مستقل) ============ */

  const onPark = () => {
    const parked = cart.parkCart();
    if (!parked) {
      feedback.show({ message: ar.purchases.errors.emptyCart });
      return;
    }
    setPickerAdded(0);
    feedback.show({
      message: ar.purchases.feedback.parked.replace(
        '{n}',
        String(usePurchaseCart.getState().parked.length),
      ),
    });
  };

  const restoreParkedFlow = (id: string) => {
    if (cart.lines.length > 0) {
      setReplaceParkedId(id);
      return;
    }
    const restored = cart.restoreParked(id);
    if (restored) {
      feedback.show({ message: ar.purchases.feedback.unparked });
      void refreshLines();
    }
    setParkedSheet(false);
  };

  /* ============ شيت سعر الصرف (NumberPad — FR-08-09) ============ */

  const saveRate = async () => {
    if (!rateCtx) return;
    if (!d(rateValue).gt(0)) {
      feedback.show({ message: ar.purchases.rate.invalid });
      return;
    }
    try {
      const db = await getDb();
      await upsertDailyRate(db, rateCtx.currencyId, todayISO(), rateValue);
      const onSaved = rateCtx.onSaved;
      setRateCtx(null);
      onSaved();
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.purchases.rate.invalid });
    }
  };

  /* ============ حرّم الجلسة ============ */

  if (!session.ready || session.locked || !session.company) {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.purchases.newTitle} onBack={() => router.back()} />
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
        {/* ——— الرأس ——— */}
        <View style={styles.headerRow}>
          <View style={styles.headerTitles}>
            <Text style={styles.headerTitle}>{ar.purchases.newTitle}</Text>
            <Text style={styles.headerSubtitle}>
              {`${cartQtyCount} ${ar.purchases.totals.itemsCount} · ${formatAmount(totals.total, currencyDecimals)} ${currencySymbol(currencyCode)}`}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.sales.list.title}
            onPress={() => router.push('/sales')}
            style={({ pressed }) => [styles.headerIcon, pressed && styles.headerIconPressed]}
            testID="purchase-open-invoices"
          >
            <ClipboardList size={22} color={colors.textMuted} />
          </Pressable>
        </View>

        {/* ——— شريط الميتا القابل للطي (§6.5) ——— */}
        {metaCollapsed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.purchases.meta.expand}
            onPress={() => setMetaCollapsed(false)}
            style={styles.collapsedBar}
          >
            <Text style={styles.collapsedText} numberOfLines={1}>
              {`${cart.customer ? cart.customer.name : ar.purchases.meta.cashSupplier} · ${cashboxLabel} · ${currencyCode ?? '—'}`}
            </Text>
            <ChevronUp size={18} color={colors.textMuted} />
          </Pressable>
        ) : (
          <AppCard style={styles.metaCard}>
            <View style={styles.metaRow}>
              <MetaChip
                label={ar.purchases.meta.supplier}
                value={cart.customer ? cart.customer.name : ar.purchases.meta.cashSupplier}
                onPress={() => setSupplierSheet(true)}
                testID="purchase-meta-supplier"
                accent
              />
              <MetaChip
                label={ar.purchases.meta.cashbox}
                value={cashboxLabel}
                onPress={cashboxes.length > 1 ? () => setCashboxSheet(true) : undefined}
                testID="purchase-meta-cashbox"
              />
              <MetaChip
                label={ar.purchases.meta.currency}
                value={currencyCode ?? '—'}
                onPress={() => setCurrencySheet(true)}
                testID="purchase-meta-currency"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ar.purchases.meta.collapse}
                onPress={() => setMetaCollapsed(true)}
                hitSlop={6}
                style={styles.collapseBtn}
              >
                <ChevronDown size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          </AppCard>
        )}

        {/* ——— شريط معلّقات الشراء ——— */}
        {cart.parked.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.purchases.parked.chip}
            onPress={() => setParkedSheet(true)}
            style={({ pressed }) => [styles.parkedChip, pressed && styles.parkedChipPressed]}
            testID="purchase-parked-chip"
          >
            <Pause size={16} color={colors.warning} />
            <Text style={styles.parkedChipText}>
              {`${ar.purchases.parked.chip} (${cart.parked.length})`}
            </Text>
          </Pressable>
        ) : null}

        {/* ——— بنود فاتورة الشراء الحية ——— */}
        <FlatList
          data={cart.lines}
          keyExtractor={(l) => l.key}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <AppCard noPadding>
              <EmptyState
                title={ar.purchases.cart.addFirst}
                message={ar.purchases.cart.addFirstHint}
                actionLabel={ar.purchases.cart.addItem}
                onAction={() => setPickerVisible(true)}
              />
            </AppCard>
          }
          renderItem={({ item }) => (
            <CartLineRow
              variant="purchase"
              line={item}
              lineTotal={lineTotalByKey.get(item.key) ?? '0'}
              currencyCode={currencyCode}
              decimals={currencyDecimals}
              onQtyChange={(qty) => cart.setQty(item.key, qty)}
              onPriceChange={(price) => cart.setPrice(item.key, price)}
              onDelete={() => deleteLine(item)}
              onOpenEdit={() => setEditLineKey(item.key)}
              testID={`purchase-line-${item.key}`}
            />
          )}
        />

        {/* ——— إضافة صنف + الإجماليات الثابتة + الأزرار الرباعية ——— */}
        <View style={styles.bottomBar}>
          <View style={styles.addRow}>
            <PrimaryButton
              label={ar.purchases.cart.addItem}
              tone="ghost"
              onPress={() => {
                setPickerAdded(0);
                setPickerVisible(true);
              }}
              style={styles.addBtn}
              testID="purchase-add-item"
            />
            <Text style={styles.itemsHint}>
              {`${cartQtyCount} ${ar.purchases.totals.itemsCount}`}
            </Text>
          </View>

          <View style={styles.totalsCard}>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>{ar.purchases.totals.subtotal}</Text>
              <AmountDisplay
                value={totals.subtotal}
                decimals={currencyDecimals}
                currencyCode={currencyCode}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={ar.purchases.totals.discount}
              onPress={() => setDiscountSheet(true)}
              style={({ pressed }) => [styles.totalsRow, pressed && styles.totalsRowPressed]}
              testID="purchase-discount-row"
            >
              <View style={styles.discountLabelWrap}>
                <Text style={styles.totalsLabel}>{ar.purchases.totals.discount}</Text>
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
                <Text style={styles.totalsLabel}>{`${ar.purchases.totals.tax} (${formatQty(totals.taxRate)}%)`}</Text>
                <AmountDisplay
                  value={totals.taxAmount}
                  decimals={currencyDecimals}
                  currencyCode={currencyCode}
                />
              </View>
            ) : null}
            <View style={[styles.totalsRow, styles.totalRow]}>
              <Text style={styles.totalLabel}>{ar.purchases.totals.total}</Text>
              <AmountDisplay
                value={totals.total}
                decimals={currencyDecimals}
                currencyCode={currencyCode}
                size="display"
                tone={totals.netInvalid ? 'warning' : 'neutral'}
              />
            </View>
          </View>

          {/* الشريط الرباعي (نفس LDR-1) — نقدي/آجل/تعليق/إضافات */}
          <View style={styles.actionsRow}>
            <ActionButton
              label={ar.purchases.actions.cash}
              tone="success"
              onPress={() => void doSave({ payStatus: 'cash' })}
              disabled={emptyCart || saving}
              flex={1.5}
              testID="purchase-save-cash"
            />
            <ActionButton
              label={ar.purchases.actions.credit}
              tone="warning"
              onPress={onCreditPress}
              disabled={emptyCart || saving}
              flex={1.5}
              testID="purchase-save-credit"
            />
            <ActionButton
              label={ar.purchases.actions.park}
              icon={Pause}
              tone="ghost"
              onPress={onPark}
              disabled={emptyCart || saving}
              flex={0.9}
              testID="purchase-park"
            />
            <ActionButton
              label={ar.purchases.actions.extras}
              icon={MoreHorizontal}
              tone="ghost"
              onPress={() => setExtrasSheet(true)}
              flex={0.9}
              testID="purchase-extras"
            />
          </View>
        </View>
      </View>

      {/* ============ الشيتات ============ */}

      {/* منتقي أصناف الشراء (الأكثر شراءً + التكلفة) */}
      <ItemPickerSheet
        visible={pickerVisible}
        variant="purchase"
        onClose={() => {
          setPickerVisible(false);
          void refreshLines();
        }}
        currencyId={cart.currencyId}
        rate={isBaseCurrency ? '1' : cartRate}
        currencyCode={currencyCode}
        decimals={currencyDecimals}
        onPick={pickProduct}
        addedCount={pickerAdded}
        cartCount={cartQtyCount}
        onScanToast={() => feedback.show({ message: ar.purchases.picker.scanToast })}
      />

      {/* شيت تعديل البند (تكلفة الشراء للوحدة) */}
      <LineEditSheet
        variant="purchase"
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

      {/* خصم رأس الفاتورة (NumberPad — توزيعه pro-rata حكر الدومين) */}
      <BottomSheet
        visible={discountSheet}
        onClose={() => setDiscountSheet(false)}
        title={ar.purchases.totals.discount}
      >
        <NumberPad
          value={cart.invoiceDiscount}
          onChange={cart.setInvoiceDiscount}
          allowDecimal={currencyDecimals > 0}
          decimals={currencyDecimals}
          label={`${ar.purchases.totals.discount} — ${ar.purchases.totals.subtotal} ${formatAmount(totals.subtotal, currencyDecimals)}`}
          onDone={() => setDiscountSheet(false)}
        />
        <Text style={styles.discountHint}>{ar.purchases.totals.discountHint}</Text>
      </BottomSheet>

      {/* منتقي المورّد (بحث + مورّد نقدي + مورّد جديد) */}
      <BottomSheet
        visible={supplierSheet}
        onClose={() => setSupplierSheet(false)}
        title={ar.purchases.meta.pickSupplier}
      >
        <SearchBar
          value={supplierSearch}
          onChangeText={setSupplierSearch}
          placeholder={ar.purchases.meta.searchSupplier}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ar.purchases.meta.walkIn}
          onPress={() => {
            const prev = cart.customer;
            cart.setCustomer(null);
            setSupplierSheet(false);
            if (prev) {
              feedback.show({
                message: `${ar.purchases.meta.supplier}: ${ar.purchases.meta.cashSupplier}`,
                actionLabel: ar.common.undo,
                onAction: () => cart.setCustomer(prev),
              });
            }
          }}
          style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
          testID="supplier-cash-row"
        >
          <Text style={styles.partyRowTitle}>{ar.purchases.meta.walkIn}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ar.purchases.meta.addSupplier}
          onPress={() => {
            setSupplierSheet(false);
            router.push('/parties/party-edit?kind=supplier');
          }}
          style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
          testID="supplier-add-new"
        >
          <Text style={[styles.partyRowTitle, styles.supplierAccent]}>
            {ar.purchases.meta.addSupplier}
          </Text>
        </Pressable>
        {suppliers.map((s) => (
          <Pressable
            key={s.id}
            accessibilityRole="button"
            accessibilityLabel={s.name}
            onPress={() => {
              const prev = cart.customer;
              cart.setCustomer({ id: s.id, name: s.name });
              setSupplierSheet(false);
              if (!prev || prev.id !== s.id) {
                feedback.show({
                  message: `${ar.purchases.meta.supplier}: ${s.name}`,
                  actionLabel: prev ? ar.common.undo : undefined,
                  onAction: prev ? () => cart.setCustomer(prev) : undefined,
                });
              }
            }}
            style={({ pressed }) => [styles.partyRow, pressed && styles.partyRowPressed]}
            testID={`supplier-row-${s.id}`}
          >
            <Text style={styles.partyRowTitle}>{s.name}</Text>
            {s.phone ? <Text style={styles.partyRowSub}>{s.phone}</Text> : null}
          </Pressable>
        ))}
      </BottomSheet>

      {/* منتقي الصندوق (متعدد فقط) */}
      <OptionPicker
        visible={cashboxSheet}
        title={ar.purchases.meta.pickCashbox}
        options={cashboxes.map((c) => ({ id: c.id, label: c.name }))}
        selectedId={cart.cashboxId}
        onSelect={(id) => id !== null && cart.setCashbox(id)}
        onClose={() => setCashboxSheet(false)}
      />

      {/* منتقي العملة */}
      <OptionPicker
        visible={currencySheet}
        title={ar.purchases.meta.pickCurrency}
        options={currencies.map((c) => ({ id: c.id, label: c.name, detail: c.code }))}
        selectedId={cart.currencyId}
        onSelect={(id) => void onSelectCurrency(id)}
        onClose={() => setCurrencySheet(false)}
      />

      {/* تأكيد الحفظ الآجل على المورّد */}
      <BottomSheet
        visible={creditSheet}
        onClose={() => setCreditSheet(false)}
        title={ar.purchases.credit.title}
      >
        <Text style={styles.creditMessage}>{ar.purchases.credit.message}</Text>
        <View style={styles.creditInfoCard}>
          <InfoRow label={ar.purchases.meta.supplier} value={cart.customer?.name ?? '—'} />
          <InfoRow
            label={ar.purchases.totals.total}
            value={`${formatAmount(totals.total, currencyDecimals)} ${currencySymbol(currencyCode)}`}
          />
        </View>
        <PrimaryButton
          label={ar.purchases.credit.confirm}
          tone="warning"
          disabled={saving}
          onPress={() => {
            setCreditSheet(false);
            void doSave({ payStatus: 'credit' });
          }}
          testID="purchase-credit-confirm"
        />
        <PrimaryButton
          label={ar.common.cancel}
          tone="ghost"
          onPress={() => setCreditSheet(false)}
        />
      </BottomSheet>

      {/* معلّقات الشراء */}
      <BottomSheet
        visible={parkedSheet}
        onClose={() => setParkedSheet(false)}
        title={ar.purchases.parked.title}
      >
        {cart.parked.length === 0 ? (
          <Text style={styles.parkedEmpty}>{ar.purchases.parked.empty}</Text>
        ) : (
          cart.parked.map((p) => (
            <View key={p.id} style={styles.parkedRow}>
              <View style={styles.parkedRowTexts}>
                <Text style={styles.parkedRowTitle}>
                  {p.cart.customer ? p.cart.customer.name : ar.purchases.meta.cashSupplier}
                </Text>
                <Text style={styles.parkedRowSub}>
                  {`${p.cart.lines.length} ${ar.purchases.parked.lines} · ${formatDateAr(p.at.slice(0, 10))} · ${formatAmount(
                    p.cart.lines
                      .reduce((acc, l) => acc + Number(l.qty) * Number(l.unitPrice), 0)
                      .toFixed(4),
                    currencyDecimals,
                  )}`}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ar.purchases.parked.restore}
                onPress={() => restoreParkedFlow(p.id)}
                style={({ pressed }) => [styles.parkedAction, pressed && styles.parkedActionPressed]}
              >
                <Text style={styles.parkedActionRestore}>{ar.purchases.parked.restore}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ar.purchases.parked.delete}
                onPress={() => {
                  cart.deleteParked(p.id);
                  feedback.show({ message: ar.purchases.feedback.parkedDeleted });
                }}
                style={({ pressed }) => [styles.parkedAction, pressed && styles.parkedActionPressed]}
              >
                <Text style={styles.parkedActionDelete}>{ar.purchases.parked.delete}</Text>
              </Pressable>
            </View>
          ))
        )}
      </BottomSheet>

      {/* إضافات: الملاحظات + مسح السلة */}
      <BottomSheet
        visible={extrasSheet}
        onClose={() => setExtrasSheet(false)}
        title={ar.purchases.extras.title}
      >
        <TextField
          label={ar.purchases.extras.notesPrinted}
          value={cart.notesPrinted}
          onChangeText={(v) => cart.setNotes(v, cart.notesInternal)}
          placeholder={ar.purchases.extras.notesPrintedPh}
          multiline
        />
        <TextField
          label={ar.purchases.extras.notesInternal}
          value={cart.notesInternal}
          onChangeText={(v) => cart.setNotes(cart.notesPrinted, v)}
          placeholder={ar.purchases.extras.notesInternalPh}
          multiline
        />
        <PrimaryButton
          label={ar.purchases.extras.clear}
          tone="danger"
          disabled={emptyCart}
          onPress={() => {
            setExtrasSheet(false);
            setClearSheet(true);
          }}
          testID="purchase-extras-clear"
        />
      </BottomSheet>

      {/* تأكيد مسح السلة (كلمة «مسح») */}
      <ConfirmSheet
        visible={clearSheet}
        title={ar.purchases.extras.clearTitle}
        message={ar.purchases.extras.clearBody}
        confirmWord={ar.purchases.extras.clearWord}
        danger
        onConfirm={() => {
          cart.clearCart();
          setPickerAdded(0);
          setClearSheet(false);
          feedback.show({ message: ar.purchases.feedback.cleared });
        }}
        onCancel={() => setClearSheet(false)}
        testID="purchase-clear-confirm"
      />

      {/* استعادة معلّقة فوق سلة حالية → تعليق الحالية أولاً */}
      <ConfirmSheet
        visible={replaceParkedId !== null}
        title={ar.purchases.parked.replaceTitle}
        message={ar.purchases.parked.replaceBody}
        danger={false}
        onConfirm={() => {
          const id = replaceParkedId;
          setReplaceParkedId(null);
          if (id === null) return;
          cart.parkCart();
          const restored = cart.restoreParked(id);
          setParkedSheet(false);
          if (restored) {
            feedback.show({ message: ar.purchases.feedback.unparked });
            void refreshLines();
          }
        }}
        onCancel={() => setReplaceParkedId(null)}
        testID="purchase-replace-parked-confirm"
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
        testID="purchase-backdate-confirm"
      />

      {/* شيت سعر صرف اليوم (قرار 3) */}
      <BottomSheet
        visible={rateCtx !== null}
        title={`${ar.purchases.rate.title} — ${rateCtx?.name ?? ''} (${rateCtx?.code ?? ''})`}
      >
        <NumberPad
          value={rateValue}
          onChange={setRateValue}
          allowDecimal
          decimals={4}
          label={ar.purchases.rate.label}
        />
        <Text style={styles.rateHint}>{ar.purchases.rate.hint}</Text>
        <PrimaryButton label={ar.purchases.rate.save} onPress={() => void saveRate()} testID="purchase-rate-save" />
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
  onPress,
  testID,
  accent,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  testID?: string;
  /** المورّد: تمييز cyan أعمق عن عميل البيع (نفس عائلة DS — بلا ألوان جديدة) */
  accent?: boolean;
}) {
  const body = (
    <View style={[styles.metaChip, accent && styles.metaChipAccent]}>
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

/** منتقي خيارات محلي (سلوك مطابق للشاشة الأم) */
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
    paddingTop: spacing.xs,
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xs,
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
  /** شريحة المورّد — تمييز cyan أعمق (نفس عائلة DS-03 بلا لون جديد) */
  metaChipAccent: {
    borderColor: 'rgba(34, 211, 238, 0.55)',
    backgroundColor: 'rgba(34, 211, 238, 0.1)',
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
    borderColor: 'rgba(34, 211, 238, 0.55)',
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
  supplierAccent: {
    color: colors.accent,
  },
  optionCheck: {
    color: colors.accent,
    fontSize: 16,
  },
  optionCheckPlaceholder: {
    color: 'transparent',
    fontSize: 16,
  },
  discountHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    paddingBottom: spacing.xs,
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
