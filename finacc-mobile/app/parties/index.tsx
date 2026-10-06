/**
 * parties/index.tsx — قائمة الأطراف بمفتاح تبديل (العملاء | الموردون):
 * شاشة واحدة لطرفي المهمة (routes نظيفة) — معامل `tab` اختياري (افتراضي العملاء).
 * بحث فوري بالاسم/الهاتف عبر domain.listCustomers/listSuppliers (LIKE — debounce 200ms)
 * + صف ListRow: الاسم + الهاتف، وتالٍ مخصص: شريحة حد الائتمان الثلاثي الحالات
 * (0 = «آجل ممنوع» حمراء، قيمة = «حد ائتمان: X» كهرمانية، NULL = بلا شريحة)
 * + الرصيد الافتتاحي AmountText موسوماً «افتتاحي» (الرصيد الحسابي الكامل مع كشف
 * الحساب في المهمة 3-b — صادقة).
 * الحالات: Skeleton / Empty / NoResults (بحث) / Error(retry).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { UserRoundPlus, Users } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { listCustomers, listSuppliers, type PartyRow } from '@/domain/parties';
import { listActiveCurrencies, type CurrencyLite } from '@/db/queries';
import { ar, pluralAr } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { formatAmount } from '@/utils/format';
import { d } from '@/utils/money';
import { technicalText } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import AmountText from '@/components/ui/AmountText';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import ListRow from '@/components/ui/ListRow';
import LoadingState from '@/components/ui/LoadingState';
import NoResultsState from '@/components/ui/NoResultsState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import SearchBar from '@/components/ui/SearchBar';
import TagChip from '@/components/ui/TagChip';

export type PartyKind = 'customer' | 'supplier';

const SEARCH_DEBOUNCE_MS = 200;

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'ready'; items: PartyRow[] };

export default function PartiesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const tab: PartyKind = params.tab === 'suppliers' ? 'supplier' : 'customer';

  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [currencies, setCurrencies] = useState<CurrencyLite[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [reload, setReload] = useState(0);
  const hasData = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(() => {
    void reload; // إعادة تشغيل مقصودة عند العودة من شاشة النموذج/الملف
    if (!hasData.current) setState({ kind: 'loading' });
    let alive = true;
    (async () => {
      const db = await getDb();
      const [rows, currenciesRows] = await Promise.all([
        tab === 'customer'
          ? listCustomers(db, { search: debounced.trim() })
          : listSuppliers(db, { search: debounced.trim() }),
        listActiveCurrencies(db),
      ]);
      if (!alive) return;
      hasData.current = true;
      setCurrencies(currenciesRows);
      setState({ kind: 'ready', items: rows });
    })().catch((err: unknown) => {
      if (alive) setState({ kind: 'error', technical: technicalText(err) });
    });
    return () => {
      alive = false;
    };
  }, [tab, debounced, reload]);

  useEffect(load, [load]);

  /* إعادة التحميل عند العودة من النموذج/الملف */
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

  const switchTab = (next: PartyKind) => {
    if (next === tab) return;
    hasData.current = false;
    setState({ kind: 'loading' });
    setSearch('');
    setDebounced('');
    router.replace({
      pathname: '/parties',
      params: { tab: next === 'supplier' ? 'suppliers' : 'customers' },
    });
  };

  const items = state.kind === 'ready' ? state.items : [];
  const isCustomer = tab === 'customer';
  const isSearching = debounced.trim() !== '';
  const countForms = isCustomer ? ar.parties.customerCountForms : ar.parties.supplierCountForms;

  return (
    <SafeScreen scroll={false} padded={false} offline={false}>
      <ScreenHeader
        title={ar.parties.listTitle}
        subtitle={pluralAr(items.length, countForms)}
        onBack={() => router.back()}
      />

      {/* مفتاح التبديل العملاء | الموردون — هدفان ≥48 */}
      <View style={styles.segmentWrap}>
        <Segmented
          labels={[ar.parties.customersSeg, ar.parties.suppliersSeg]}
          active={isCustomer ? 0 : 1}
          onSelect={(i) => switchTab(i === 0 ? 'customer' : 'supplier')}
        />
      </View>

      <View style={styles.searchWrap}>
        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder={ar.parties.searchPh}
          testID="parties-search"
        />
      </View>

      <View style={styles.addWrap}>
        <PrimaryButton
          label={isCustomer ? ar.parties.addCustomer : ar.parties.addSupplier}
          icon={UserRoundPlus}
          onPress={() =>
            router.push({ pathname: '/parties/party-edit', params: { kind: tab } })
          }
          style={styles.addButton}
          testID="parties-add-btn"
        />
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={items}
        keyExtractor={(item) => String(item.id)}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <PartyRowItem
            item={item}
            kind={tab}
            currencies={currencies}
            onOpen={() =>
              router.push({
                pathname: '/parties/party-file',
                params: { kind: tab, id: String(item.id) },
              })
            }
          />
        )}
        ListEmptyComponent={
          state.kind === 'loading' ? (
            <LoadingState variant="list" rows={6} />
          ) : state.kind === 'error' ? (
            <AppCard noPadding>
              <ErrorState
                message={ar.parties.errorLoad}
                technical={state.technical}
                onRetry={() => setReload((r) => r + 1)}
              />
            </AppCard>
          ) : isSearching ? (
            <NoResultsState
              message={ar.parties.noResultsHint}
              onClearFilters={() => setSearch('')}
            />
          ) : (
            <AppCard noPadding>
              <EmptyState
                icon={Users}
                title={isCustomer ? ar.parties.emptyCustomers : ar.parties.emptySuppliers}
                message={isCustomer ? ar.parties.emptyCustomersHint : ar.parties.emptySuppliersHint}
                actionLabel={isCustomer ? ar.parties.addCustomer : ar.parties.addSupplier}
                onAction={() =>
                  router.push({ pathname: '/parties/party-edit', params: { kind: tab } })
                }
              />
            </AppCard>
          )
        }
        ListFooterComponent={
          state.kind === 'ready' && items.length > 0 ? <View style={{ height: 24 }} /> : null
        }
      />
    </SafeScreen>
  );
}

/* ============ صف الطرف ============ */

function PartyRowItem({
  item,
  kind,
  currencies,
  onOpen,
}: {
  item: PartyRow;
  kind: PartyKind;
  currencies: CurrencyLite[];
  onOpen: () => void;
}) {
  const openingCurrency = currencies.find((c) => c.id === item.openingCurrencyId) ?? null;
  const hasOpening = d(item.openingBalance).gt(0);
  const credit = item.creditLimit;
  const isZero = credit !== null && d(credit).isZero();
  const isValue = credit !== null && !d(credit).isZero();

  return (
    <ListRow
      title={item.name}
      onPress={onOpen}
      divider
      subtitleNode={
        item.phone ? <Text style={styles.phone}>{item.phone}</Text> : undefined
      }
      trailing={
        <View style={styles.trailing}>
          <View style={styles.trailingChips}>
            {isZero ? (
              <TagChip
                label={ar.parties.creditBlocked}
                color={colors.danger}
                background="rgba(248, 113, 113, 0.12)"
              />
            ) : null}
            {isValue ? (
              <TagChip
                label={`${ar.parties.creditLimitPrefix}: ${formatAmount(credit, 0)}`}
                color={colors.warning}
                background="rgba(251, 191, 36, 0.14)"
              />
            ) : null}
          </View>
          {hasOpening ? (
            <AmountText
              value={item.openingBalance}
              currency={openingCurrency?.code}
              decimals={openingCurrency?.decimals ?? 2}
              hint={ar.parties.openingLabel}
              size="sm"
              testID={`party-opening-${item.id}`}
            />
          ) : null}
        </View>
      }
      testID={`party-row-${kind}-${item.id}`}
    />
  );
}

/* ============ مفتاح تبديل ثنائي ============ */

function Segmented({
  labels,
  active,
  onSelect,
}: {
  labels: [string, string];
  active: 0 | 1;
  onSelect: (index: 0 | 1) => void;
}) {
  return (
    <View style={styles.segment}>
      {labels.map((label, i) => {
        const isActive = i === active;
        return (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: isActive }}
            onPress={() => onSelect(i as 0 | 1)}
            style={[styles.segBtn, isActive && styles.segBtnActive]}
            testID={`parties-seg-${i === 0 ? 'customers' : 'suppliers'}`}
          >
            <Text style={[styles.segText, isActive && styles.segTextActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  segmentWrap: {
    paddingHorizontal: spacing.lg,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    gap: 4,
  },
  segBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  segBtnActive: {
    backgroundColor: colors.accent,
  },
  segText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  segTextActive: {
    color: colors.onAccent,
    fontFamily: font.bold,
  },
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  addWrap: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  addButton: {
    alignSelf: 'stretch',
  },
  list: {
    flex: 1,
  },
  listContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
  },
  phone: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    lineHeight: 19,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: 6,
    flexShrink: 1,
  },
  trailingChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    justifyContent: 'flex-end',
  },
});
