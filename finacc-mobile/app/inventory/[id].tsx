/**
 * inventory/[id].tsx — بطاقة الصنف (§6.5): رأس (حرف أول + اسم + باركود IBM Plex +
 * شريحة «QR لاحقاً» الصادقة) + شبكة أرصدة لكل مخزن + الإجمالي + بطاقة سعر لكل
 * عملة (الأساس أولاً) + آخر 10 حركات (تسمية عربية + كمية موقعة ملونة بعلامة +/−
 * + تكلفة الوحدة) + معلومات (الحد، الخدمية، الملاحظات، تاريخ الإضافة) + تعديل/أرشفة.
 * الحالات: Skeleton / صنف بلا حركات (EmptyState داخل القسم) / Error(retry).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Archive, ClipboardList, Pencil } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { archiveProduct, getProduct, type ProductFull } from '@/domain/products';
import {
  fetchBaseCurrency,
  fetchProductMeta,
  fetchProductMovements,
  fetchProductStockByWarehouse,
  type CurrencyLite,
  type MovementRow,
  type ProductMeta,
  type WarehouseStock,
} from '@/db/queries';
import { ar, t, type ArPath } from '@/i18n/ar';
import { useSession } from '@/store/session';
import { colors, font, radius, spacing, type AmountTone } from '@/theme';
import { formatAmount, currencySymbol, formatDateAr, formatQty } from '@/utils/format';
import { d } from '@/utils/money';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import ConfirmSheet from '@/components/ui/ConfirmSheet';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import ListRow from '@/components/ui/ListRow';
import LoadingState from '@/components/ui/LoadingState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import TagChip from '@/components/ui/TagChip';
import { useFeedback } from '@/components/ui/feedback';

/** تسميات أنواع الحركات (ز-4: أرقام مسار ديناميكية عبر t) */
const MOVEMENT_PATHS: Record<string, ArPath> = {
  purchase: 'inventory.movement.purchase',
  sale: 'inventory.movement.sale',
  sale_return: 'inventory.movement.sale_return',
  purchase_return: 'inventory.movement.purchase_return',
  opening: 'inventory.movement.opening',
  stocktake_adjust: 'inventory.movement.stocktake_adjust',
  manual_adjust: 'inventory.movement.manual_adjust',
  transfer_in: 'inventory.movement.transfer_in',
  transfer_out: 'inventory.movement.transfer_out',
};

function movementLabel(type: string): string {
  const path = MOVEMENT_PATHS[type];
  return path ? t(path) : type;
}

type CardState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'ready'; data: ProductData };

interface ProductData {
  product: ProductFull;
  stock: WarehouseStock[];
  movements: MovementRow[];
  meta: ProductMeta;
  base: CurrencyLite;
}

export default function ProductCardScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const params = useLocalSearchParams<{ id?: string }>();
  const productId = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;

  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [reload, setReload] = useState(0);
  const firstLoad = useRef(true);

  const load = useCallback(() => {
    void reload; // إعادة تشغيل مقصودة عند العودة من شاشة التعديل/الأرشفة
    if (productId === null) {
      setState({ kind: 'error', technical: 'INVALID_ID' });
      return;
    }
    setState((prev) => (firstLoad.current || prev.kind === 'error' ? { kind: 'loading' } : prev));
    firstLoad.current = false;
    let alive = true;
    (async () => {
      const db = await getDb();
      const [product, base] = await Promise.all([getProduct(db, productId), fetchBaseCurrency(db)]);
      if (!alive) return;
      if (!product || !base) {
        setState({ kind: 'error', technical: ar.inventory.card.notFound });
        return;
      }
      const [stock, movements, meta] = await Promise.all([
        fetchProductStockByWarehouse(db, productId),
        fetchProductMovements(db, productId, 10),
        fetchProductMeta(db, productId),
      ]);
      if (!alive) return;
      setState({ kind: 'ready', data: { product, stock, movements, meta, base } });
    })().catch((err: unknown) => {
      if (alive) setState({ kind: 'error', technical: technicalText(err) });
    });
    return () => {
      alive = false;
    };
  }, [productId, reload]);

  useEffect(load, [load]);

  /* تحديث عند العودة من شاشة التعديل */
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

  const doArchive = async () => {
    setConfirmArchive(false);
    if (productId === null) return;
    try {
      const db = await getDb();
      await archiveProduct(db, productId);
      useSession.getState().showFlash(ar.inventory.form.archivedFeedback);
      setReload((r) => r + 1);
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.components.errorState.title });
    }
  };

  if (state.kind === 'loading') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.inventory.title} onBack={() => router.back()} />
        <LoadingState variant="card" />
      </SafeScreen>
    );
  }
  if (state.kind === 'error') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.inventory.title} onBack={() => router.back()} />
        <ErrorState
          message={ar.inventory.card.errorLoad}
          technical={state.technical}
          onRetry={() => setReload((r) => r + 1)}
        />
      </SafeScreen>
    );
  }

  const { product, stock, movements, meta, base } = state.data;
  const below = !product.isService && d(product.stockTotal).lt(d(product.minStock));

  return (
    <SafeScreen offline={false}>
      <ScreenHeader
        title={product.name}
        onBack={() => router.back()}
        actions={[
          {
            icon: Pencil,
            label: ar.inventory.card.edit,
            onPress: () =>
              router.push({ pathname: '/inventory/edit', params: { productId: String(product.id) } }),
          },
        ]}
      />

      {/* رأس البطاقة — الحرف الأول + الاسم + الباركود + QR لاحقاً */}
      <AppCard>
        <View style={styles.headRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarLetter}>{product.name.slice(0, 1)}</Text>
          </View>
          <View style={styles.headTexts}>
            <View style={styles.headChips}>
              {product.isService ? (
                <TagChip label={ar.inventory.serviceChip} color={colors.textMuted} />
              ) : null}
              {product.isArchived ? (
                <TagChip label={ar.inventory.archivedChip} color={colors.warning} />
              ) : null}
              <TagChip label={ar.inventory.card.qrLater} color={colors.textFaint} />
            </View>
            {product.barcode ? (
              <Text style={styles.barcode} selectable>
                {product.barcode}
              </Text>
            ) : null}
            {product.isArchived ? (
              <Text style={styles.archivedNote}>{ar.inventory.card.archivedNote}</Text>
            ) : null}
          </View>
        </View>
      </AppCard>

      {/* شبكة الأرصدة */}
      {!product.isService ? (
        <AppCard>
          <Text style={styles.sectionTitle}>{ar.inventory.card.balances}</Text>
          <View style={styles.stockGrid}>
            <StockCard
              label={ar.inventory.card.total}
              qty={product.stockTotal}
              below={below}
              unitName={meta.unitName ?? undefined}
              total
            />
            {stock.map((w) => (
              <StockCard
                key={w.warehouseId}
                label={w.warehouseName}
                qty={w.qty}
                below={below}
                unitName={meta.unitName ?? undefined}
              />
            ))}
          </View>
          {below ? (
            <Text style={styles.lowNote}>{`${ar.inventory.belowMin}: ${formatQty(product.minStock)}`}</Text>
          ) : null}
        </AppCard>
      ) : (
        <AppCard>
          <Text style={styles.sectionTitle}>{ar.inventory.card.serviceNote}</Text>
        </AppCard>
      )}

      {/* الأسعار — العملة الأساسية أولاً */}
      <AppCard>
        <Text style={styles.sectionTitle}>{ar.inventory.card.prices}</Text>
        <View style={styles.priceGrid}>
          {[...product.prices]
            .sort((a, b) => (a.currencyId === base.id ? -1 : b.currencyId === base.id ? 1 : 0))
            .map((p) => {
              const isBase = p.currencyId === base.id;
              const pDec = isBase ? base.decimals : 2;
              return (
                <View key={`${p.currencyId}-${p.priceLevel}`} style={styles.priceCard}>
                  <View style={styles.priceHead}>
                    <Text style={styles.priceCurrency}>{p.currencyCode}</Text>
                    {isBase ? (
                      <TagChip label={ar.parties.file.baseUnit} color={colors.accent} />
                    ) : null}
                  </View>
                  <Text style={styles.priceValue}>
                    {`${formatAmount(p.price, pDec)} ${currencySymbol(p.currencyCode)}`}
                  </Text>
                  <Text style={styles.priceLevel}>{ar.inventory.card.retailLevel}</Text>
                </View>
              );
            })}
        </View>
      </AppCard>

      {/* آخر الحركات */}
      <AppCard noPadding>
        <View style={styles.movementsHead}>
          <Text style={styles.sectionTitle}>{ar.inventory.card.movements}</Text>
        </View>
        {movements.length === 0 ? (
          <EmptyState
            title={ar.inventory.card.noMovements}
            actionLabel={undefined}
            style={styles.movementsEmpty}
          />
        ) : (
          movements.map((m, i) => <MovementItem key={m.id} m={m} divider={i < movements.length - 1} />)
        )}
      </AppCard>

      {/* معلومات */}
      <AppCard>
        <Text style={styles.sectionTitle}>{ar.inventory.card.info}</Text>
        <InfoRow label={ar.inventory.card.categoryLabel} value={meta.categoryName ?? ar.inventory.form.noCategory} />
        <InfoRow label={ar.inventory.card.unitLabel} value={meta.unitName ?? '—'} />
        {!product.isService ? (
          <InfoRow label={ar.inventory.card.minStockLabel} value={formatQty(product.minStock)} />
        ) : null}
        <InfoRow
          label={ar.inventory.card.costLabel}
          value={`${formatAmount(product.costPrice, base.decimals)} ${currencySymbol(base.code)}`}
        />
        {meta.createdAt ? (
          <InfoRow label={ar.inventory.card.createdAtLabel} value={formatDateAr(meta.createdAt)} />
        ) : null}
        {product.notes ? (
          <View style={styles.notesBox}>
            <Text style={styles.notesLabel}>{ar.inventory.card.notesLabel}</Text>
            <Text style={styles.notesText}>{product.notes}</Text>
          </View>
        ) : null}
      </AppCard>

      {/* الإجراءات */}
      <View style={styles.actions}>
        <PrimaryButton
          label={ar.inventory.card.edit}
          icon={Pencil}
          onPress={() =>
            router.push({ pathname: '/inventory/edit', params: { productId: String(product.id) } })
          }
          style={styles.actionBtn}
          testID="card-edit-btn"
        />
        {!product.isArchived ? (
          <PrimaryButton
            label={ar.inventory.form.archive}
            tone="warning"
            icon={Archive}
            onPress={() => setConfirmArchive(true)}
            style={styles.actionBtn}
            testID="card-archive-btn"
          />
        ) : null}
      </View>

      {/* بطاقة حركات الصنف — تقرير FR-09-03 */}
      <AppCard noPadding>
        <ListRow
          title={ar.analytics.navItemCard}
          subtitle={ar.analytics.navItemCardHint}
          divider={false}
          onPress={() =>
            router.push({ pathname: '/reports/item-card', params: { id: String(product.id) } })
          }
          leading={
            <View style={styles.cardIcon}>
              <ClipboardList size={20} color={colors.teal} />
            </View>
          }
          testID="card-item-report-btn"
        />
      </AppCard>

      <ConfirmSheet
        visible={confirmArchive}
        title={ar.inventory.form.archiveTitle}
        message={ar.inventory.form.archiveBody}
        confirmWord={ar.inventory.form.archive}
        danger={false}
        onConfirm={doArchive}
        onCancel={() => setConfirmArchive(false)}
      />

      {feedback.host}
    </SafeScreen>
  );
}

/* ============ بطاقة رصيد مخزن ============ */

function StockCard({
  label,
  qty,
  below,
  unitName,
  total = false,
}: {
  label: string;
  qty: string;
  below: boolean;
  unitName?: string;
  total?: boolean;
}) {
  // علامة نصية إلزامية مع اللون (§6.1): «متاح/تحت الحد» + الكمية
  const text = below
    ? `${ar.inventory.belowMin}: ${formatQty(qty)}`
    : `${ar.inventory.available}: ${formatQty(qty)}`;
  return (
    <View style={[styles.stockCard, total && styles.stockCardTotal]}>
      <Text style={styles.stockCardLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.stockCardQty, { color: below ? colors.danger : colors.success }]}>
        {text}
      </Text>
      {unitName ? <Text style={styles.stockCardUnit}>{unitName}</Text> : null}
    </View>
  );
}

/* ============ صف حركة ============ */

function MovementItem({ m, divider }: { m: MovementRow; divider: boolean }) {
  const qty = d(m.qty);
  const tone: AmountTone = qty.gt(0) ? 'in' : 'out';
  const sign = qty.gt(0) ? '+' : '−';
  return (
    <ListRow
      title={`${movementLabel(m.movementType)} — ${m.warehouseName}`}
      divider={divider}
      subtitleNode={
        <Text style={styles.moveDate}>{formatDateAr(m.movedAt)}</Text>
      }
      trailing={
        <View style={styles.moveTrailing}>
          <Text style={[styles.moveQty, { color: tone === 'in' ? colors.success : colors.danger }]}>
            {`${sign} ${formatQty(m.qty.replace('-', ''))}`}
          </Text>
          <Text style={styles.moveCost}>
            {`${ar.inventory.card.unitCost}: ${formatAmount(m.unitCost, 2)}`}
          </Text>
        </View>
      }
    />
  );
}

/* ============ صف معلومة ============ */

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: colors.accent,
    fontFamily: font.bold,
    fontSize: 26,
    lineHeight: 36,
  },
  headTexts: {
    flex: 1,
    gap: 4,
  },
  headChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  barcode: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'right',
  },
  archivedNote: {
    color: colors.warning,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  sectionTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
  stockGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  stockCard: {
    flexBasis: '47%',
    flexGrow: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: spacing.md,
    gap: 4,
  },
  stockCardTotal: {
    borderColor: colors.accent,
  },
  stockCardLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  stockCardQty: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 17,
    lineHeight: 24,
  },
  stockCardUnit: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  lowNote: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  priceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  priceCard: {
    flexBasis: '47%',
    flexGrow: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: spacing.md,
    gap: 4,
  },
  priceHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  priceCurrency: {
    color: colors.textMuted,
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  priceValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 18,
    lineHeight: 26,
  },
  priceLevel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  movementsHead: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  movementsEmpty: {
    paddingVertical: spacing.md,
  },
  moveDate: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  moveTrailing: {
    alignItems: 'flex-end',
    gap: 2,
  },
  moveQty: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
  },
  moveCost: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
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
  notesBox: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
    gap: 4,
  },
  notesLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  notesText: {
    color: colors.text,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'right',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  actionBtn: {
    flex: 1,
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(45, 212, 191, 0.12)',
  },
});
