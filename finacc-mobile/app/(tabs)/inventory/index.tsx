/**
 * (tabs)/inventory/index.tsx — شاشة المخزون (§6.5 / FR-01-01/04/06/16):
 * بحث فوري (اسم/باركود عبر domain.listProducts — debounce 200ms) + عدّاد
 * + زر «صنف جديد» + زر «الجرد» (ClipboardCheck — FR-01-08) + قائمة ListRow
 * (اسم + باركود IBM Plex + رصيد ملون بعلامة نصية «متاح/تحت الحد» + سعر
 * التجزئة بعملة الأساس) + شريحة «خدمة» للأصناف الخدمية.
 * الحالات: Skeleton / Empty / NoResults (بحث) / Error(retry) — وزر مسح عائم (DS-24)
 * يفتح توست «المسح بالكاميرا متاح على الجهاز الفعلي» حتى توصيل الكاميرا.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ClipboardCheck, Package, Plus, ScanBarcode } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { listProducts, type ProductRow } from '@/domain/products';
import {
  fetchBaseCurrency,
  fetchProductListDetails,
  type CurrencyLite,
} from '@/db/queries';
import { ar, pluralAr } from '@/i18n/ar';
import { colors, font, radius, shadow, spacing } from '@/theme';
import { formatQty } from '@/utils/format';
import { d } from '@/utils/money';
import { technicalText } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import ListRow from '@/components/ui/ListRow';
import LoadingState from '@/components/ui/LoadingState';
import NoResultsState from '@/components/ui/NoResultsState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import SearchBar from '@/components/ui/SearchBar';
import TagChip from '@/components/ui/TagChip';
import { useFeedback } from '@/components/ui/feedback';

interface ProductListItem {
  row: ProductRow;
  stockTotal: string;
  basePrice: string | null;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'ready'; items: ProductListItem[] };

const SEARCH_DEBOUNCE_MS = 200;

export default function InventoryScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const insets = useSafeAreaInsets();

  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [base, setBase] = useState<CurrencyLite | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [reload, setReload] = useState(0);
  const hasData = useRef(false);

  /* بحث فوري بمرَدان (debounce) — LIKE عبر domain.listProducts */
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(() => {
    void reload; // إعادة تشغيل مقصودة عند العودة من شاشة الإضافة/التعديل
    if (!hasData.current) setState({ kind: 'loading' });
    let alive = true;
    (async () => {
      const db = await getDb();
      const baseCur = await fetchBaseCurrency(db);
      const rows = await listProducts(db, { search: debounced.trim() });
      const details = baseCur
        ? await fetchProductListDetails(
            db,
            rows.map((r) => r.id),
            baseCur.id,
          )
        : new Map<number, { stockTotal: string; basePrice: string | null }>();
      if (!alive) return;
      hasData.current = true;
      setBase(baseCur);
      setState({
        kind: 'ready',
        items: rows.map((row) => ({
          row,
          stockTotal: details.get(row.id)?.stockTotal ?? '0',
          basePrice: details.get(row.id)?.basePrice ?? null,
        })),
      });
    })().catch((err: unknown) => {
      if (alive) setState({ kind: 'error', technical: technicalText(err) });
    });
    return () => {
      alive = false;
    };
  }, [debounced, reload]);

  useEffect(load, [load]);

  /* إعادة التحميل عند العودة من شاشة الإضافة/التعديل (لا في الدخول الأول) */
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

  const scanToast = () => feedback.show({ message: ar.inventory.scanToast });
  const items = state.kind === 'ready' ? state.items : [];
  const isSearching = debounced.trim() !== '';

  return (
    <SafeScreen scroll={false} padded={false}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{ar.inventory.title}</Text>
          <Text style={styles.count}>{pluralAr(items.length, ar.inventory.countForms)}</Text>
        </View>
        <View style={styles.actionsRow}>
          {/* جرد المخزن (FR-01-08 — Task 16) */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.more.stocktake}
            onPress={() => router.push('/inventory/stocktake')}
            style={({ pressed }) => [styles.stocktakeBtn, pressed && styles.stocktakeBtnPressed]}
            testID="inventory-stocktake-btn"
          >
            <ClipboardCheck size={20} color={colors.success} />
          </Pressable>
          <PrimaryButton
            label={ar.inventory.addProduct}
            icon={Plus}
            onPress={() => router.push('/inventory/edit')}
            style={[styles.addButton, styles.addAction]}
            testID="inventory-add-btn"
          />
        </View>
      </View>

      <View style={styles.searchWrap}>
        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder={ar.inventory.searchPh}
          onScan={scanToast}
          testID="inventory-search"
        />
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={state.kind === 'ready' ? state.items : []}
        keyExtractor={(item) => String(item.row.id)}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <ProductRowItem item={item} base={base} onOpen={() => router.push(`/inventory/${item.row.id}`)} />
        )}
        ListEmptyComponent={
          state.kind === 'loading' ? (
            <LoadingState variant="list" rows={6} />
          ) : state.kind === 'error' ? (
            <AppCard noPadding>
              <ErrorState
                message={ar.inventory.errorLoad}
                technical={state.technical}
                onRetry={() => setReload((r) => r + 1)}
              />
            </AppCard>
          ) : isSearching ? (
            <NoResultsState
              message={ar.inventory.noResultsHint}
              onClearFilters={() => setSearch('')}
            />
          ) : (
            <AppCard noPadding>
              <EmptyState
                icon={Package}
                title={ar.inventory.empty}
                message={ar.inventory.emptyHint}
                actionLabel={ar.inventory.addFirst}
                onAction={() => router.push('/inventory/edit')}
              />
            </AppCard>
          )
        }
        ListFooterComponent={
          state.kind === 'ready' && items.length > 0 ? (
            <View style={{ height: insets.bottom + 96 }} />
          ) : null
        }
      />

      {/* زر المسح العائم (DS-24) — أسفل يسار بإزاحة فوق شريط التبويبات */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ar.inventory.scanFabLabel}
        onPress={scanToast}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        testID="inventory-scan-fab"
      >
        <ScanBarcode size={26} color={colors.onAccent} />
      </Pressable>

      {feedback.host}
    </SafeScreen>
  );
}

/* ============ صف الصنف ============ */

function ProductRowItem({
  item,
  base,
  onOpen,
}: {
  item: ProductListItem;
  base: CurrencyLite | null;
  onOpen: () => void;
}) {
  const { row } = item;
  const below = !row.isService && d(item.stockTotal).lt(d(row.minStock));
  const stockColor = below ? colors.danger : colors.success;
  const stockLabel = below
    ? `${ar.inventory.belowMin}: ${formatQty(item.stockTotal)}`
    : `${ar.inventory.available}: ${formatQty(item.stockTotal)}`;

  return (
    <ListRow
      title={row.name}
      onPress={onOpen}
      divider
      subtitleNode={
        <View style={styles.rowSub}>
          {row.barcode ? <Text style={styles.barcode}>{row.barcode}</Text> : null}
          {row.isService ? (
            <TagChip label={ar.inventory.serviceChip} color={colors.textMuted} />
          ) : (
            <Text style={[styles.stock, { color: stockColor }]}>{stockLabel}</Text>
          )}
        </View>
      }
      amount={item.basePrice ?? '0'}
      amountCurrency={base?.code}
      amountDecimals={base?.decimals ?? 2}
      testID={`inventory-row-${row.id}`}
    />
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  title: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 24,
    lineHeight: 32,
  },
  count: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  addButton: {
    alignSelf: 'stretch',
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  addAction: {
    flex: 1,
  },
  stocktakeBtn: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(52, 211, 153, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stocktakeBtnPressed: {
    opacity: 0.75,
  },
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  list: {
    flex: 1,
  },
  listContent: {
    flexGrow: 1,
  },
  rowSub: {
    gap: 3,
    alignItems: 'flex-start',
  },
  barcode: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  stock: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  fab: {
    position: 'absolute',
    left: spacing.lg,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.floating,
  },
  fabPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.97 }],
  },
});
