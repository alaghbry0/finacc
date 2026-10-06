/**
 * ItemPickerSheet — منتقي أصناف الفاتورة (بيع/شراء — FR-02-02): BottomSheet ~85%:
 *  - SearchBar بأيقونة مسح (توست الكاميرا على الجهاز الفعلي).
 *  - variant='sale' (افتراضي): «الأكثر مبيعاً» + سعر التجزئة + «المتاح: N» تحذيري.
 *  - variant='purchase': «الأكثر شراءً» + **تكلفة الشراء للوحدة** + «المتوفر حالياً: N»
 *    محايد (لا قيد متاح في الشراء — SRS Task 8).
 *  - نتائج البحث بالاسم/الباركود (قائمة).
 *  - نقرة واحدة = إضافة بكمية 1 (تُدمج مع سطر موجود) — الشيت يبقى مفتوحاً
 *    لإضافة متتابعة (سلوك الكاشير)، مع عدّاد «تم (N)» وزر إغلاق في التذييل.
 *
 * البيانات عبر db/queries (قراءة فقط) — لا كتابة هنا.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Plus } from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  listPurchasableProducts,
  listSellableProducts,
  listTopPurchasedProducts,
  listTopSoldProducts,
  type PurchasableProduct,
  type SellableProduct,
} from '@/db/queries';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { formatAmount, formatQty, currencySymbol } from '@/utils/format';
import { d } from '@/utils/money';
import BottomSheet from '@/components/ui/BottomSheet';
import EmptyState from '@/components/ui/EmptyState';
import ListRow from '@/components/ui/ListRow';
import NoResultsState from '@/components/ui/NoResultsState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SearchBar from '@/components/ui/SearchBar';
import TagChip from '@/components/ui/TagChip';

/** منتج قابل للإضافة (بيع: سعر تجزئة / شراء: تكلفة وحدة) */
export type PickableProduct = SellableProduct | PurchasableProduct;

export type ItemPickerSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** 'sale' (افتراضي) — أسعار تجزئة/الأكثر مبيعاً؛ 'purchase' — تكلفة/الأكثر شراءً */
  variant?: 'sale' | 'purchase';
  /** عملة السلة — أسعار المنتقي بهذه العملة (الشراء: سعر التحويل rate) */
  currencyId: number | null;
  /** للشراء غير الأساس: سعر الوحدة بالأساس (تكلفة ÷ rate) — افتراضي '1' */
  rate?: string;
  currencyCode: string | null;
  decimals: number;
  /** نقرة صنف → الأب يضيفه للسلة (كمية 1) */
  onPick: (p: PickableProduct) => void;
  /** عدد الإضافات في هذه الجلسة (لزر «تم (N)») */
  addedCount: number;
  /** إجمالي عدد البنود في السلة (شارة مصغّرة) */
  cartCount: number;
  /** توست المسح بالكاميرا */
  onScanToast: () => void;
  testID?: string;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; top: PickableProduct[]; results: PickableProduct[] };

export default function ItemPickerSheet({
  visible,
  onClose,
  variant = 'sale',
  currencyId,
  rate = '1',
  currencyCode,
  decimals,
  onPick,
  addedCount,
  cartCount,
  onScanToast,
  testID,
}: ItemPickerSheetProps) {
  const [search, setSearch] = useState('');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  /** تحميل متزامن: الأكثر مبيعاً/شراءً + نتائج البحث الحالية */
  const load = useCallback(
    async (q: string) => {
      if (currencyId === null) return;
      const mySeq = (seq.current += 1);
      setState((prev) => (prev.kind === 'data' ? prev : { kind: 'loading' }));
      try {
        const db = await getDb();
        if (variant === 'purchase') {
          const [top, results] = await Promise.all([
            q.trim() === ''
              ? listTopPurchasedProducts(db, { rate, limit: 20 })
              : Promise.resolve([] as PurchasableProduct[]),
            listPurchasableProducts(db, {
              search: q.trim() === '' ? undefined : q,
              rate,
              limit: 60,
            }),
          ]);
          if (mySeq !== seq.current) return; // جاء طلب أحدث
          setState({ kind: 'data', top, results });
          return;
        }
        const [top, results] = await Promise.all([
          q.trim() === ''
            ? listTopSoldProducts(db, { currencyId, limit: 20 })
            : Promise.resolve([] as SellableProduct[]),
          listSellableProducts(db, {
            search: q.trim() === '' ? undefined : q,
            currencyId,
            limit: 60,
          }),
        ]);
        if (mySeq !== seq.current) return; // جاء طلب أحدث
        setState({ kind: 'data', top, results });
      } catch {
        if (mySeq === seq.current) setState({ kind: 'error' });
      }
    },
    [currencyId, variant, rate],
  );

  useEffect(() => {
    if (!visible) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(search), search.trim() === '' ? 0 : 220);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [visible, search, load]);

  // تصفير البحث عند فتح جديد
  useEffect(() => {
    if (visible) setSearch('');
  }, [visible]);

  const footer = (
    <View style={styles.footerRow}>
      <View style={variant === 'purchase' ? styles.cartBadgePurchase : styles.cartBadge}>
        <Text style={styles.cartBadgeLabel}>{ar.sales.cart.addItem}</Text>
        <Text style={styles.cartBadgeCount}>{`${cartCount} ${ar.sales.totals.itemsCount}`}</Text>
      </View>
      <PrimaryButton
        label={addedCount > 0 ? `${ar.sales.picker.done} (${addedCount})` : ar.sales.picker.addedZero}
        onPress={onClose}
        compact
        style={styles.doneBtn}
      />
    </View>
  );

  const symbol = currencySymbol(currencyCode);
  const topTitle = variant === 'purchase' ? ar.purchases.picker.topPurchased : ar.sales.picker.topSold;

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={ar.sales.picker.title}
      footer={footer}
      testID={testID}
    >
      <SearchBar
        value={search}
        onChangeText={setSearch}
        placeholder={ar.sales.picker.searchPh}
        onScan={onScanToast}
        autoFocus={false}
        testID="item-picker-search"
      />

      {state.kind === 'loading' ? (
        <Text style={styles.hint}>{ar.common.loading}</Text>
      ) : state.kind === 'error' ? (
        <Text style={styles.errorHint}>{ar.sales.list.errorLoad}</Text>
      ) : (
        <>
          {search.trim() === '' && state.top.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{topTitle}</Text>
              <View style={styles.grid}>
                {state.top.map((p) => (
                  <ProductTile
                    key={p.id}
                    product={p}
                    variant={variant}
                    decimals={decimals}
                    symbol={symbol}
                    onPress={() => onPick(p)}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {search.trim() !== '' && state.results.length === 0 ? (
            <NoResultsState
              title={ar.sales.picker.noResults}
              message={ar.sales.picker.noResultsHint}
              onClearFilters={() => setSearch('')}
            />
          ) : state.results.length === 0 && search.trim() === '' ? (
            <EmptyState
              icon={Plus}
              title={ar.inventory.empty}
              message={ar.inventory.emptyHint}
            />
          ) : (
            <View style={styles.section}>
              {search.trim() !== '' ? (
                <Text style={styles.sectionTitle}>{ar.common.search}</Text>
              ) : null}
              {state.results.map((p) => (
                <ProductListRow
                  key={p.id}
                  product={p}
                  variant={variant}
                  decimals={decimals}
                  currencyCode={currencyCode}
                  onPress={() => onPick(p)}
                />
              ))}
            </View>
          )}
        </>
      )}
    </BottomSheet>
  );
}

/* ============ بلاطة «الأكثر مبيعاً/شراءً» ============ */

/** السعر المعروض للبيع: سعر التجزئة (قد يغيب) — للشراء: التكلفة (دائماً) */
function pickPrice(product: PickableProduct): string | null {
  return 'price' in product ? product.price : product.cost;
}

function ProductTile({
  product,
  variant,
  decimals,
  symbol,
  onPress,
}: {
  product: PickableProduct;
  variant: 'sale' | 'purchase';
  decimals: number;
  symbol: string;
  onPress: () => void;
}) {
  const price = pickPrice(product);
  const over = variant === 'sale' && !product.isService && d(product.stockTotal).lte(0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={product.name}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
    >
      <Text style={styles.tileName} numberOfLines={1}>
        {product.name}
      </Text>
      <Text style={[styles.tilePrice, price === null && styles.tileNoPrice]}>
        {price === null
          ? ar.sales.picker.priceMissing
          : `${formatAmount(price, decimals)}${symbol ? ` ${symbol}` : ''}`}
      </Text>
      <Text style={[styles.tileStock, over && styles.tileStockOver]}>
        {variant === 'purchase'
          ? product.isService
            ? ar.sales.cart.serviceChip
            : `${ar.purchases.cart.currentStock}: ${formatQty(product.stockTotal)}`
          : product.isService
            ? ar.sales.cart.serviceChip
            : `${ar.sales.cart.available}: ${formatQty(product.stockTotal)}`}
      </Text>
    </Pressable>
  );
}

/* ============ صف نتيجة بحث ============ */

function ProductListRow({
  product,
  variant,
  decimals,
  currencyCode,
  onPress,
}: {
  product: PickableProduct;
  variant: 'sale' | 'purchase';
  decimals: number;
  currencyCode: string | null;
  onPress: () => void;
}) {
  const stockColor =
    variant === 'purchase'
      ? colors.textMuted
      : product.isService
        ? colors.textMuted
        : d(product.stockTotal).lte(0)
          ? colors.danger
          : colors.success;
  return (
    <ListRow
      title={product.name}
      subtitleNode={
        <View style={styles.rowSub}>
          {product.barcode ? <Text style={styles.barcode}>{product.barcode}</Text> : null}
          {product.isService ? (
            <TagChip label={ar.sales.cart.serviceChip} color={colors.textMuted} />
          ) : (
            <Text style={[styles.rowStock, { color: stockColor }]}>
              {variant === 'purchase'
                ? `${ar.purchases.cart.currentStock}: ${formatQty(product.stockTotal)}`
                : `${ar.sales.cart.available}: ${formatQty(product.stockTotal)}`}
            </Text>
          )}
        </View>
      }
      amount={pickPrice(product) ?? '0'}
      amountCurrency={currencyCode ?? undefined}
      amountDecimals={decimals}
      onPress={onPress}
      divider
      testID={`item-picker-row-${product.id}`}
    />
  );
}

const styles = StyleSheet.create({
  hint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },
  errorHint: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },
  section: {
    gap: 6,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tile: {
    flexBasis: '31.5%',
    flexGrow: 1,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    gap: 3,
    minHeight: 84,
    justifyContent: 'center',
  },
  tilePressed: {
    backgroundColor: '#24334A',
    borderColor: colors.accent,
  },
  tileName: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 18,
  },
  tilePrice: {
    color: colors.accent,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
  },
  tileNoPrice: {
    color: colors.textFaint,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: font.regular,
  },
  tileStock: {
    color: colors.success,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  tileStockOver: {
    color: colors.danger,
  },
  rowSub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  barcode: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  rowStock: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  cartBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  /** شارة السلة في وضع الشراء — نفس عائلة cyan بلمسة أعمق (تمييز المورّد) */
  cartBadgePurchase: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(34, 211, 238, 0.2)',
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  cartBadgeLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  cartBadgeCount: {
    color: colors.accent,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  doneBtn: {
    flexGrow: 1,
    flexBasis: 0,
    minHeight: touch.min,
  },
});
