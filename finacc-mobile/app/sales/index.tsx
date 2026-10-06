/**
 * sales/index.tsx — قائمة المستندات بأنواعها (بيع/شراء/مرتجعات + الكل):
 *  - الدخول: أيقونة قائمة الفواتير برأس شاشة البيع/الشراء + بلاطة «فواتير
 *    اليوم» في الداشبورد.
 *  - **+ شراء** (زر بجانب البحث — Task 8): مدخل فاتورة الشراء من هنا.
 *  - فلاتر شرائح + بحث بالرقم/اسم الطرف، أحدث المستندات أولاً (سقف 100).
 *  - الصف: الرقم بخط IBM Plex + أيقونة النوع (بيع=سلة/شراء=طرد/مرتجعا
 *    البيع=رجوع/مرتجع الشراء=دوران) + الطرف + التاريخ + الإجمالي + شريحة
 *    الحالة — **والنقرة توجه حسب النوع** (/sales/[id] أو /purchases/[id]).
 *  - الشريحة النشطة: تعبئة cyan بنص داكن (DS-04) مقابل المخطط للخامل.
 *  - الحالات: Skeleton / EmptyState (لكل فلتر نصه) / NoResults (فلترة) / ErrorState.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  ChevronLeft,
  FileText,
  Package,
  RotateCcw,
  ShoppingCart,
  Undo2,
  Truck,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import { listInvoices, type InvoiceDocType, type InvoiceListRow } from '@/db/queries';
import { ar, pluralAr } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { currencySymbol, formatAmount, formatDayShortAr } from '@/utils/format';
import { technicalText } from '@/utils/validation';
import { invoiceRoute } from '@/utils/doc-routes';
import AppCard from '@/components/ui/AppCard';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import NoResultsState from '@/components/ui/NoResultsState';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import SearchBar from '@/components/ui/SearchBar';
import StatusChip, { type ChipKind } from '@/components/ui/StatusChip';

type Filter = InvoiceDocType | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: ar.sales.list.all },
  { key: 'sale', label: ar.sales.doc.sale },
  { key: 'purchase', label: ar.sales.doc.purchase },
  { key: 'sale_return', label: ar.sales.doc.sale_return },
  { key: 'purchase_return', label: ar.sales.doc.purchase_return },
];

const PAY_CHIP: Record<string, ChipKind> = {
  cash: 'cash',
  credit: 'credit',
  mixed: 'mixed',
};

/** أيقونة النوع — بيع=سلة، شراء=طرد، مرتجع بيع=رجوع، مرتجع شراء=دوران */
const DOC_ICON: Record<string, typeof ShoppingCart> = {
  sale: ShoppingCart,
  purchase: Package,
  sale_return: Undo2,
  purchase_return: RotateCcw,
};

/** نص الحالة الفارغة حسب الفلتر النشط */
function emptyStateFor(filter: Filter): { title: string; message: string } {
  switch (filter) {
    case 'purchase':
      return {
        title: ar.sales.doc.purchase,
        message: ar.purchases.cart.addFirstHint,
      };
    case 'sale_return':
    case 'purchase_return':
      return {
        title: ar.sales.list.empty,
        message: ar.returns.subtitle,
      };
    default:
      return { title: ar.sales.list.empty, message: ar.sales.list.emptyHint };
  }
}

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'data'; rows: InvoiceListRow[] };

export default function InvoicesListScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('sale');
  const [search, setSearch] = useState('');
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setState((prev) => (prev.kind === 'data' ? prev : { kind: 'loading' }));
    try {
      const db = await getDb();
      const rows = await listInvoices(db, {
        docType: filter,
        search: search.trim() === '' ? undefined : search,
        limit: 100,
      });
      setState({ kind: 'data', rows });
    } catch (err) {
      setState({ kind: 'error', technical: technicalText(err) });
    }
  }, [filter, search]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(), search.trim() === '' ? 0 : 220);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [load, search]);

  const rows = state.kind === 'data' ? state.rows : [];
  const countLabel = pluralAr(rows.length, ar.sales.list.countForms);
  const empty = emptyStateFor(filter);

  return (
    <SafeScreen scroll={false} offline={false}>
      <ScreenHeader title={ar.sales.list.title} subtitle={ar.sales.list.subtitle} onBack={() => router.back()} />

      <View style={styles.controls}>
        <View style={styles.searchRow}>
          <View style={styles.searchWrap}>
            <SearchBar
              value={search}
              onChangeText={setSearch}
              placeholder={ar.sales.list.searchPh}
              testID="invoices-search"
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.purchases.newTitle}
            onPress={() => router.push('/purchases/new')}
            style={({ pressed }) => [styles.purchaseBtn, pressed && styles.purchaseBtnPressed]}
            testID="invoices-new-purchase"
          >
            <Truck size={20} color={colors.accent} />
          </Pressable>
        </View>
        <View style={styles.chipsRow}>
          {FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <Pressable
                key={f.key}
                accessibilityRole="button"
                accessibilityLabel={f.label}
                accessibilityState={{ selected: active }}
                onPress={() => setFilter(f.key)}
                style={[styles.filterChip, active && styles.filterChipActive]}
                testID={`invoices-filter-${f.key}`}
              >
                <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {state.kind === 'data' ? <Text style={styles.countLabel}>{countLabel}</Text> : null}
      </View>

      {state.kind === 'loading' ? (
        <AppCard noPadding>
          <LoadingState variant="list" rows={6} />
        </AppCard>
      ) : state.kind === 'error' ? (
        <AppCard noPadding>
          <ErrorState message={ar.sales.list.errorLoad} technical={state.technical} onRetry={load} />
        </AppCard>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.id)}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            search.trim() !== '' ? (
              <NoResultsState
                message={ar.sales.list.noResultsHint}
                onClearFilters={() => setSearch('')}
              />
            ) : (
              <AppCard noPadding>
                <EmptyState
                  icon={FileText}
                  title={empty.title}
                  message={empty.message}
                  actionLabel={
                    filter === 'purchase' ? ar.purchases.cart.addItem : ar.sales.list.emptyAction
                  }
                  onAction={() =>
                    filter === 'purchase'
                      ? router.push('/purchases/new')
                      : router.push('/sales/new')
                  }
                />
              </AppCard>
            )
          }
          renderItem={({ item }) => (
            <InvoiceRow
              item={item}
              onPress={() => router.push(invoiceRoute(item.id, item.docType))}
            />
          )}
        />
      )}
    </SafeScreen>
  );
}

/* ============ صف المستند — الرقم بخط IBM Plex (DS-18n) ============ */

function InvoiceRow({ item, onPress }: { item: InvoiceListRow; onPress: () => void }) {
  const partyName = item.customerName ?? item.supplierName ?? ar.sales.list.cashCustomer;
  const chip: ChipKind =
    item.status === 'void' ? 'void' : (PAY_CHIP[item.payStatus] ?? 'pending');
  const symbol = currencySymbol(item.currencyCode);
  const Icon = DOC_ICON[item.docType] ?? FileText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.invoiceNo ?? ar.sales.details.draftNote}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`invoices-row-${item.id}`}
    >
      <View style={styles.docIconWrap}>
        <Icon size={19} color={colors.accent} />
      </View>
      <View style={styles.rowTexts}>
        <Text style={styles.rowNo}>{item.invoiceNo ?? ar.sales.details.draftNote}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {`${partyName} · ${formatDayShortAr(item.issuedAt)}`}
        </Text>
      </View>
      <View style={styles.rowTrailing}>
        <Text style={styles.rowAmount}>
          {`${formatAmount(item.total, item.currencyDecimals)}${symbol ? ` ${symbol}` : ''}`}
        </Text>
        <StatusChip kind={chip} />
        <ChevronLeft size={18} color={colors.textFaint} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  controls: {
    paddingHorizontal: spacing.lg,
    gap: 8,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchWrap: {
    flex: 1,
  },
  purchaseBtn: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(34, 211, 238, 0.45)',
    backgroundColor: 'rgba(34, 211, 238, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  purchaseBtnPressed: {
    opacity: 0.75,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  filterChip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** النشطة: تعبئة cyan + نص داكن (DS-04) مقابل المخطط الخامل + توهج لمسي */
  filterChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  filterChipText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  filterChipTextActive: {
    color: colors.onAccent,
    fontFamily: font.bold,
  },
  countLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touch.min + 16,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.07)',
  },
  docIconWrap: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: 'rgba(34, 211, 238, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(34, 211, 238, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTexts: {
    flex: 1,
    gap: 2,
    alignItems: 'flex-start',
  },
  rowNo: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 16,
    lineHeight: 23,
  },
  rowSub: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  rowTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rowAmount: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'left',
  },
});
