/**
 * inventory/edit.tsx — نموذج الصنف (إنشاء + تعديل في ملف واحد — FR-01-01/02/15/16):
 * ملف واحد بمعامل `productId` اختياري (expo-router query param) — غيابه = إنشاء.
 *
 * القواعد المطبقة:
 *  - كل مبالغ/كميات عبر NumberPad في BottomSheet (MoneyField — DS-38، بلا لوحة نظام).
 *  - أخطاء زود تُعرض Inline لكل حقل (mapErrorToFields) + أخطاء قواعد Domain ترتبط
 *    بحقلها (BARCODE_TAKEN → الباركود، COST_WAC_LOCKED → التكلفة…).
 *  - الكمية الافتتاحية عند الإنشاء فقط (Domain يرفضها في التعديل).
 *  - التكلفة مقفلة بعد أول حركة (WAC يملكها) وقلب الخدمية ممنوع مع الحركات.
 *  - أرشفة عبر ConfirmSheet بكلمة «أرشفة»؛ حذف يظهر فقط لصنف بلا حركات (قراءة مسبقة).
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Archive, Save, Trash2 } from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  archiveProduct,
  createProduct,
  deleteProduct,
  getProduct,
  updateProduct,
} from '@/domain/products';
import {
  fetchAllBarcodes,
  fetchBaseCurrency,
  fetchProductMeta,
  fetchProductStockByWarehouse,
  listCategories,
  listUnits,
  listWarehouses,
  type CurrencyLite,
  type ProductMeta,
  type RefRow,
  type WarehouseStock,
} from '@/db/queries';
import { generateEan13 } from '@/utils/ean13';
import { ar } from '@/i18n/ar';
import { useSession } from '@/store/session';
import { colors, font, spacing } from '@/theme';
import { formatQty } from '@/utils/format';
import { d } from '@/utils/money';
import {
  domainErrorMessage,
  mapErrorToFields,
  technicalText,
  type FieldErrors,
} from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import ConfirmSheet from '@/components/ui/ConfirmSheet';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import MoneyField from '@/components/ui/MoneyField';
import PickerField from '@/components/ui/PickerField';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import TagChip from '@/components/ui/TagChip';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

/** أكواد Domain → حقل النموذج (Inline بدل FeedbackBar) */
const CODE_FIELD: Record<string, string> = {
  BARCODE_TAKEN: 'barcode',
  OPENING_QTY_IMMUTABLE: 'openingQty',
  COST_WAC_LOCKED: 'costPrice',
  SERVICE_FLIP_BLOCKED: 'isService',
  PRICE_BASE_REQUIRED: 'salePrice',
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'ready' };

export default function ProductEditScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const params = useLocalSearchParams<{ productId?: string }>();
  const productId =
    params.productId && /^\d+$/.test(params.productId) ? Number(params.productId) : null;
  const isEdit = productId !== null;

  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [base, setBase] = useState<CurrencyLite | null>(null);
  const [categories, setCategories] = useState<RefRow[]>([]);
  const [units, setUnits] = useState<RefRow[]>([]);
  const [warehouses, setWarehouses] = useState<RefRow[]>([]);
  const [meta, setMeta] = useState<ProductMeta | null>(null);
  const [stock, setStock] = useState<WarehouseStock[]>([]);
  const [isArchived, setIsArchived] = useState(false);
  const [stockTotal, setStockTotal] = useState('0');

  /* ——— حقول النموذج ——— */
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [unitId, setUnitId] = useState<number | null>(null);
  const [costPrice, setCostPrice] = useState('0');
  const [salePrice, setSalePrice] = useState('0');
  const [minStock, setMinStock] = useState('0');
  const [isService, setIsService] = useState(false);
  const [openingQty, setOpeningQty] = useState('0');
  const [openingWarehouseId, setOpeningWarehouseId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');

  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loadOnce = useRef(false);

  const clearField = (field: string) => {
    setErrors((prev) => {
      if (prev[field] === undefined) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  /* ——— التحميل (مرة واحدة لكل مثيل شاشة) ——— */
  useEffect(() => {
    if (loadOnce.current) return;
    loadOnce.current = true;
    let alive = true;
    (async () => {
      const db = await getDb();
      const [baseCur, cats, uns, whs] = await Promise.all([
        fetchBaseCurrency(db),
        listCategories(db),
        listUnits(db),
        listWarehouses(db),
      ]);
      if (!alive) return;
      if (!baseCur) {
        setLoadState({
          kind: 'error',
          technical: 'NO_BASE_CURRENCY — لا توجد عملة أساسية',
        });
        return;
      }
      setBase(baseCur);
      setCategories(cats);
      setUnits(uns);
      setWarehouses(whs);

      if (productId === null) {
        // إنشاء: الوحدة الافتراضية أول وحدة (تهيئة «قطعة»)، والمخزن الافتراضي الرئيسي
        setUnitId(uns[0]?.id ?? null);
        setOpeningWarehouseId(whs.find((w) => w.isDefault)?.id ?? whs[0]?.id ?? null);
        setLoadState({ kind: 'ready' });
        return;
      }
      const product = await getProduct(db, productId);
      if (!alive) return;
      if (!product) {
        setLoadState({ kind: 'error', technical: ar.inventory.card.notFound });
        return;
      }
      const [metaRow, stockRows] = await Promise.all([
        fetchProductMeta(db, productId),
        fetchProductStockByWarehouse(db, productId),
      ]);
      if (!alive) return;
      setMeta(metaRow);
      setStock(stockRows);
      setIsArchived(product.isArchived);
      const total = stockRows.reduce((acc, r) => acc.plus(d(r.qty)), d(0));
      setStockTotal(total.toFixed(3));
      const basePrice = product.prices.find((p) => p.currencyId === baseCur.id)?.price ?? '0';
      setName(product.name);
      setBarcode(product.barcode ?? '');
      setCategoryId(product.categoryId);
      setUnitId(product.unitId);
      setCostPrice(product.costPrice);
      setSalePrice(basePrice);
      setMinStock(product.minStock);
      setIsService(product.isService);
      setNotes(product.notes ?? '');
      setLoadState({ kind: 'ready' });
    })().catch((err: unknown) => {
      if (alive) setLoadState({ kind: 'error', technical: technicalText(err) });
    });
    return () => {
      alive = false;
    };
  }, [productId]);

  /* ——— توليد باركود EAN-13 داخلي (200…) مقابل المحجوزة كلها ——— */
  const generateBarcode = async () => {
    try {
      const db = await getDb();
      const existing = await fetchAllBarcodes(db);
      if (productId !== null) {
        const product = await getProduct(db, productId);
        if (product?.barcode) existing.delete(product.barcode); // باركوده الحالي ليس تعارضاً
      }
      setBarcode(generateEan13(existing));
      clearField('barcode');
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.components.errorState.title });
    }
  };

  /* ——— الحفظ ——— */
  const save = async () => {
    if (saving || !base) return;
    setSaving(true);
    setErrors({});
    try {
      const db = await getDb();
      const session = useSession.getState();
      const dec = base.decimals;
      const input = {
        name: name.trim(),
        barcode: barcode.trim(),
        categoryId: categoryId ?? undefined,
        unitId: unitId ?? undefined,
        costPrice: d(costPrice).toFixed(dec),
        minStock,
        isService,
        notes: notes.trim() === '' ? undefined : notes.trim(),
        prices: [
          {
            currencyId: base.id,
            price: d(salePrice).toFixed(dec),
          },
        ],
        ...(isEdit || isService
          ? {}
          : {
              openingQty: openingQty === '' ? '0' : openingQty,
              ...(d(openingQty).gt(0) && openingWarehouseId !== null
                ? { openingWarehouseId }
                : {}),
            }),
      };
      if (isEdit && productId !== null) {
        await updateProduct(db, productId, input);
        session.showFlash(ar.inventory.form.savedEdit);
      } else {
        await createProduct(db, input, { createdBy: session.user?.id });
        session.showFlash(ar.inventory.form.savedNew);
      }
      router.back();
    } catch (err) {
      const fields = mapErrorToFields(err, CODE_FIELD);
      setErrors(fields);
      const general = fields._form ?? null;
      if (general) {
        feedback.show({ message: general });
      } else if (Object.keys(fields).length === 0) {
        feedback.show({ message: domainErrorMessage(err) ?? ar.components.errorState.title });
      }
    } finally {
      setSaving(false);
    }
  };

  /* ——— الأرشفة والحذف ——— */
  const doArchive = async () => {
    setConfirmArchive(false);
    if (productId === null) return;
    try {
      const db = await getDb();
      await archiveProduct(db, productId);
      useSession.getState().showFlash(ar.inventory.form.archivedFeedback);
      router.back();
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.components.errorState.title });
    }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    if (productId === null) return;
    try {
      const db = await getDb();
      await deleteProduct(db, productId);
      useSession.getState().showFlash(ar.inventory.form.deletedFeedback);
      router.back();
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.components.errorState.title });
    }
  };

  const showOpeningFields = !isEdit && !isService;
  const costLocked = isEdit && (meta?.hasMovements ?? false);
  const serviceLocked = isEdit && (meta?.hasMovements ?? false) && !isService;
  const dec = base?.decimals ?? 2;
  const unitName = units.find((u) => u.id === unitId)?.name ?? '';

  if (loadState.kind === 'loading') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.inventory.form.newTitle} onBack={() => router.back()} />
        <LoadingState variant="card" />
      </SafeScreen>
    );
  }
  if (loadState.kind === 'error') {
    return (
      <SafeScreen scroll={false} offline={false}>
        <ScreenHeader title={ar.inventory.form.newTitle} onBack={() => router.back()} />
        <ErrorState
          message={ar.inventory.card.errorLoad}
          technical={loadState.technical}
          onRetry={() => router.back()}
          retryLabel={ar.common.back}
        />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen offline={false} avoidKeyboard>
      <ScreenHeader
        title={isEdit ? ar.inventory.form.editTitle : ar.inventory.form.newTitle}
        subtitle={isEdit ? name : ar.inventory.form.newSubtitle}
        onBack={() => router.back()}
      />

      {/* بطاقة المخزون الحالي (تعديل فقط — للاطلاع) */}
      {isEdit ? (
        <AppCard>
          <View style={styles.stockHead}>
            <Text style={styles.cardTitle}>{ar.inventory.form.stockNow}</Text>
            {isArchived ? (
              <TagChip label={ar.inventory.archivedChip} color={colors.warning} />
            ) : null}
          </View>
          {isService ? (
            <Text style={styles.stockNote}>{ar.inventory.card.serviceNote}</Text>
          ) : (
            <>
              <View style={styles.stockTotalRow}>
                <Text style={styles.stockLabel}>{ar.inventory.form.totalStock}</Text>
                <Text style={styles.stockValue}>
                  {`${formatQty(stockTotal)}${unitName ? ` ${unitName}` : ''}`}
                </Text>
              </View>
              {stock.map((w) => (
                <View key={w.warehouseId} style={styles.stockRow}>
                  <Text style={styles.stockLabel}>{w.warehouseName}</Text>
                  <Text style={styles.stockValue}>{formatQty(w.qty)}</Text>
                </View>
              ))}
            </>
          )}
        </AppCard>
      ) : null}

      <AppCard style={styles.formCard}>
        <TextField
          label={ar.inventory.form.name}
          value={name}
          onChangeText={(v) => {
            setName(v);
            clearField('name');
          }}
          placeholder={ar.inventory.form.namePh}
          error={errors.name ?? null}
          testID="product-name-input"
        />

        {/* الباركود + زر التوليد */}
        <View style={styles.barcodeRow}>
          <View style={styles.barcodeField}>
            <TextField
              label={ar.inventory.form.barcode}
              value={barcode}
              onChangeText={(v) => {
                setBarcode(v.replace(/[^\d]/g, '').slice(0, 13));
                clearField('barcode');
              }}
              placeholder={ar.inventory.form.barcodePh}
              keyboardType="number-pad"
              maxLength={13}
              error={errors.barcode ?? null}
              hint={barcode === '' ? ar.inventory.form.barcodeHint : null}
              testID="product-barcode-input"
            />
          </View>
          <PrimaryButton
            label={ar.inventory.form.barcodeGenerate}
            tone="ghost"
            onPress={generateBarcode}
            style={styles.generateBtn}
            testID="product-barcode-generate"
          />
        </View>
        {barcode !== '' ? (
          <Text style={styles.barcodeMono} testID="product-barcode-mono">
            {barcode}
          </Text>
        ) : null}

        <PickerField
          label={ar.inventory.form.category}
          title={ar.inventory.form.pickCategory}
          options={categories.map((c) => ({ id: c.id, label: c.name }))}
          selectedId={categoryId}
          onSelect={(id) => {
            setCategoryId(id);
            clearField('categoryId');
          }}
          allowNone
          noneLabel={ar.inventory.form.noCategory}
          testID="product-category-picker"
        />

        <PickerField
          label={ar.inventory.form.unit}
          title={ar.inventory.form.pickUnit}
          options={units.map((u) => ({ id: u.id, label: u.name }))}
          selectedId={unitId}
          onSelect={(id) => {
            setUnitId(id);
            clearField('unitId');
          }}
          allowNone
          noneLabel={ar.inventory.form.noCategory}
          testID="product-unit-picker"
        />

        <MoneyField
          label={ar.inventory.form.costPrice}
          value={costPrice}
          onChange={(v) => {
            setCostPrice(v);
            clearField('costPrice');
          }}
          currencyCode={base?.code}
          decimals={dec}
          disabled={costLocked}
          hint={costLocked ? ar.inventory.form.costWacLocked : ar.inventory.form.costHint}
          error={errors.costPrice ?? null}
          testID="product-cost-input"
        />

        <MoneyField
          label={ar.inventory.form.salePrice}
          value={salePrice}
          onChange={(v) => {
            setSalePrice(v);
            clearField('salePrice');
          }}
          currencyCode={base?.code}
          decimals={dec}
          error={
            errors.salePrice ?? errors['prices.0.price'] ?? errors['prices.0.currencyId'] ?? null
          }
          testID="product-price-input"
        />

        <MoneyField
          label={ar.inventory.form.minStock}
          value={minStock}
          onChange={(v) => {
            setMinStock(v);
            clearField('minStock');
          }}
          decimals={3}
          hint={ar.inventory.form.minStockHint}
          error={errors.minStock ?? null}
          testID="product-minstock-input"
        />

        {/* صنف خدمي */}
        <View style={styles.switchRow}>
          <View style={styles.switchTexts}>
            <Text style={styles.switchLabel}>{ar.inventory.form.isService}</Text>
            <Text style={styles.switchHint} numberOfLines={3}>
              {serviceLocked
                ? ar.inventory.form.costWacLocked
                : ar.inventory.form.isServiceHint}
            </Text>
          </View>
          <Switch
            value={isService}
            onValueChange={(v) => {
              if (serviceLocked) return;
              setIsService(v);
              clearField('isService');
            }}
            disabled={serviceLocked}
            trackColor={{ false: colors.border, true: colors.accent }}
            thumbColor={colors.text}
            accessibilityLabel={ar.inventory.form.isService}
            testID="product-service-switch"
          />
        </View>
        {errors.isService ? <Text style={styles.switchError}>{errors.isService}</Text> : null}

        {showOpeningFields ? (
          <>
            <MoneyField
              label={ar.inventory.form.openingQty}
              value={openingQty}
              onChange={(v) => {
                setOpeningQty(v);
                clearField('openingQty');
              }}
              decimals={3}
              hint={ar.inventory.form.openingQtyHint}
              error={errors.openingQty ?? null}
              testID="product-opening-input"
            />
            <PickerField
              label={ar.inventory.form.openingWarehouse}
              title={ar.inventory.form.pickWarehouse}
              options={warehouses.map((w) => ({ id: w.id, label: w.name }))}
              selectedId={openingWarehouseId}
              onSelect={(id) => {
                setOpeningWarehouseId(id);
                clearField('openingWarehouseId');
              }}
              error={errors.openingWarehouseId ?? null}
              testID="product-warehouse-picker"
            />
          </>
        ) : null}

        <TextField
          label={ar.inventory.form.notes}
          value={notes}
          onChangeText={setNotes}
          placeholder={ar.inventory.form.notesPh}
          multiline
          testID="product-notes-input"
        />

        <PrimaryButton
          label={isEdit ? ar.inventory.form.saveEdit : ar.inventory.form.saveNew}
          icon={Save}
          onPress={save}
          loading={saving}
          style={styles.saveBtn}
          testID="product-save-btn"
        />
      </AppCard>

      {/* الأرشفة/الحذف — تعديل فقط */}
      {isEdit ? (
        <AppCard style={styles.dangerCard}>
          {!isArchived ? (
            <PrimaryButton
              label={ar.inventory.form.archive}
              tone="warning"
              icon={Archive}
              onPress={() => setConfirmArchive(true)}
              style={styles.dangerBtn}
              testID="product-archive-btn"
            />
          ) : null}
          {!meta?.hasMovements && !isArchived ? (
            <PrimaryButton
              label={ar.inventory.form.delete}
              tone="danger"
              icon={Trash2}
              onPress={() => setConfirmDelete(true)}
              style={styles.dangerBtn}
              testID="product-delete-btn"
            />
          ) : null}
        </AppCard>
      ) : null}

      <ConfirmSheet
        visible={confirmArchive}
        title={ar.inventory.form.archiveTitle}
        message={ar.inventory.form.archiveBody}
        confirmWord={ar.inventory.form.archive}
        danger={false}
        onConfirm={doArchive}
        onCancel={() => setConfirmArchive(false)}
      />
      <ConfirmSheet
        visible={confirmDelete}
        title={ar.inventory.form.deleteTitle}
        message={ar.inventory.form.deleteBody}
        confirmWord={ar.inventory.form.delete}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      {feedback.host}
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  formCard: {
    gap: spacing.lg,
  },
  cardTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
  stockHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  stockNote: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  stockTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  stockRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  stockLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  stockValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
  },
  barcodeRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  barcodeField: {
    flex: 1,
  },
  generateBtn: {
    width: 96,
  },
  barcodeMono: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
    marginTop: -spacing.xs,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
  },
  switchTexts: {
    flex: 1,
    gap: 2,
  },
  switchLabel: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  switchHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  switchError: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
    marginTop: -spacing.sm,
  },
  saveBtn: {
    marginTop: spacing.xs,
  },
  dangerCard: {
    gap: spacing.md,
  },
  dangerBtn: {
    alignSelf: 'stretch',
  },
});
