/**
 * settings/reference.tsx — البيانات المرجعية (FR-13-06): فئات المصاريف والوحدات
 * والمخازن والصناديق والعملات. لا حذف لأي عنصر له تاريخ — التعطيل للفارغ فقط
 * (حرس الدومين)، والمخازن إعادة تسمية فقط، والعملة الأساسية محصّنة.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Info, Plus } from 'lucide-react-native';
import { getDb } from '@/db/client';
import {
  activateCurrency,
  archiveCashbox,
  archiveExpenseCategory,
  archiveUnit,
  createCashbox,
  createCurrency,
  createExpenseCategory,
  deactivateCurrency,
  listCashboxesDetailed,
  listCurrenciesDetailed,
  listExpenseCategories,
  listUnitsDetailed,
  listWarehousesDetailed,
  renameCashbox,
  renameExpenseCategory,
  renameUnit,
  renameWarehouse,
  type CashboxRow,
  type CurrencyRow,
  type ExpenseCategoryRow,
  type UnitRow,
  type WarehouseRow,
} from '@/domain/reference';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { domainErrorMessage, technicalText } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import EmptyState from '@/components/ui/EmptyState';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

type Tab = 'cats' | 'units' | 'warehouses' | 'boxes' | 'currencies';

const TABS: { key: Tab; label: string }[] = [
  { key: 'cats', label: ar.settings.reference.tabs.expenseCats },
  { key: 'units', label: ar.settings.reference.tabs.units },
  { key: 'warehouses', label: ar.settings.reference.tabs.warehouses },
  { key: 'boxes', label: ar.settings.reference.tabs.cashboxes },
  { key: 'currencies', label: ar.settings.reference.tabs.currencies },
];

type RefItem = {
  id: number;
  displayName: string;
  sub?: string;
  inactive: boolean;
  canRename: boolean;
  canToggle: boolean;
  toggleLabel: string;
};

type Sheet =
  | { kind: 'rename'; item: RefItem }
  | { kind: 'addCat' }
  | { kind: 'addBox' }
  | { kind: 'addCur' }
  | null;

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; technical: string }
  | { kind: 'ready'; items: RefItem[]; currencies: CurrencyRow[] };

export default function ReferenceSettingsScreen() {
  const router = useRouter();
  const feedback = useFeedback();

  const [tab, setTab] = useState<Tab>('cats');
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [sheet, setSheet] = useState<Sheet>(null);
  const [nameValue, setNameValue] = useState('');
  const [curCode, setCurCode] = useState('');
  const [curName, setCurName] = useState('');
  const [curDecimals, setCurDecimals] = useState('2');
  const [boxCurrencyId, setBoxCurrencyId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const db = await getDb();
      const currencies = await listCurrenciesDetailed(db);
      let items: RefItem[] = [];
      if (tab === 'cats') {
        const rows: ExpenseCategoryRow[] = await listExpenseCategories(db);
        items = rows.map((r) => ({
          id: r.id,
          displayName: r.name,
          inactive: r.isArchived,
          canRename: true,
          canToggle: true,
          toggleLabel: r.isArchived ? ar.settings.reference.activate : ar.settings.reference.deactivate,
        }));
      } else if (tab === 'units') {
        const rows: UnitRow[] = await listUnitsDetailed(db);
        items = rows.map((r) => ({
          id: r.id,
          displayName: r.name,
          sub: r.factor !== '1' ? `×${r.factor}` : undefined,
          inactive: r.isArchived,
          canRename: true,
          canToggle: true,
          toggleLabel: r.isArchived ? ar.settings.reference.activate : ar.settings.reference.deactivate,
        }));
      } else if (tab === 'warehouses') {
        const rows: WarehouseRow[] = await listWarehousesDetailed(db);
        items = rows.map((r) => ({
          id: r.id,
          displayName: r.name,
          sub: r.isDefault ? ar.settings.reference.defaultTag : (r.location ?? undefined),
          inactive: r.isArchived,
          canRename: true,
          canToggle: false, // المخازن: تسمية فقط في V1
          toggleLabel: '',
        }));
      } else if (tab === 'boxes') {
        const rows: CashboxRow[] = await listCashboxesDetailed(db);
        items = rows.map((r) => ({
          id: r.id,
          displayName: r.name,
          sub: r.isDefault
            ? `${ar.settings.reference.defaultTag} · ${r.currencyCode}`
            : r.currencyCode,
          inactive: r.isArchived,
          canRename: true,
          canToggle: !r.isDefault,
          toggleLabel: r.isArchived ? ar.settings.reference.activate : ar.settings.reference.deactivate,
        }));
      } else {
        items = currencies.map((r) => ({
          id: r.id,
          displayName: `${r.code} — ${r.name}`,
          sub: r.isBase ? ar.settings.reference.isBase : undefined,
          inactive: !r.isActive,
          canRename: true, // الاسم الحر — الرمز مُعرّف لا يُمس
          canToggle: !r.isBase,
          toggleLabel: r.isActive
            ? ar.settings.reference.deactivate
            : ar.settings.reference.activate,
        }));
      }
      setState({ kind: 'ready', items, currencies });
    } catch (err) {
      setState({ kind: 'error', technical: technicalText(err) });
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const canAdd = tab === 'cats' || tab === 'boxes' || tab === 'currencies';

  const openAdd = async (): Promise<void> => {
    setNameValue('');
    setCurCode('');
    setCurName('');
    setCurDecimals('2');
    if (state.kind === 'ready') {
      const active = state.currencies.filter((c) => c.isActive);
      setBoxCurrencyId(active[0]?.id ?? null);
    }
    setSheet(tab === 'cats' ? { kind: 'addCat' } : tab === 'boxes' ? { kind: 'addBox' } : { kind: 'addCur' });
  };

  const doRename = async (item: RefItem): Promise<void> => {
    if (saving || !nameValue.trim()) return;
    setSaving(true);
    try {
      const db = await getDb();
      if (tab === 'cats') await renameExpenseCategory(db, item.id, nameValue);
      else if (tab === 'units') await renameUnit(db, item.id, nameValue);
      else if (tab === 'warehouses') await renameWarehouse(db, item.id, nameValue);
      else if (tab === 'boxes') await renameCashbox(db, item.id, nameValue);
      else {
        // عملة: إعادة تسمية الاسم الحر
        await db.run('UPDATE currency SET name = ?, updated_at = ? WHERE id = ?', [
          nameValue.trim(),
          new Date().toISOString(),
          item.id,
        ]);
      }
      setSheet(null);
      await load();
      feedback.show({ message: ar.settings.saved });
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  const doAdd = async (): Promise<void> => {
    if (saving || sheet === null) return;
    setSaving(true);
    try {
      const db = await getDb();
      if (sheet.kind === 'addCat') await createExpenseCategory(db, nameValue);
      else if (sheet.kind === 'addBox') {
        if (boxCurrencyId === null) throw new Error('currency required');
        await createCashbox(db, { name: nameValue, currencyId: boxCurrencyId });
      } else if (sheet.kind === 'addCur') {
        await createCurrency(db, { code: curCode, name: curName, decimals: Number(curDecimals) });
      }
      setSheet(null);
      await load();
      feedback.show({ message: ar.settings.saved });
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  const doToggle = async (item: RefItem): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      const db = await getDb();
      const deactivate = item.toggleLabel === ar.settings.reference.deactivate;
      if (tab === 'cats' && deactivate) await archiveExpenseCategory(db, item.id);
      else if (tab === 'units' && deactivate) await archiveUnit(db, item.id);
      else if (tab === 'boxes' && deactivate) await archiveCashbox(db, item.id);
      else if (tab === 'currencies') {
        if (deactivate) await deactivateCurrency(db, item.id);
        else await activateCurrency(db, item.id);
      }
      await load();
      feedback.show({ message: ar.settings.saved });
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  const sheetTitle = useMemo(() => {
    switch (sheet?.kind) {
      case 'rename':
        return ar.settings.reference.rename;
      case 'addCat':
        return ar.settings.reference.addCatSheetTitle;
      case 'addBox':
        return ar.settings.reference.addBoxSheetTitle;
      case 'addCur':
        return ar.settings.reference.addCurSheetTitle;
      default:
        return '';
    }
  }, [sheet]);

  const items = state.kind === 'ready' ? state.items : [];
  const activeCurrencies = state.kind === 'ready' ? state.currencies.filter((c) => c.isActive) : [];

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.settings.sections.reference}
        subtitle={ar.settings.reference.subtitle}
        onBack={() => router.back()}
      />
      <View style={styles.body}>
        {/* تبويبات الأنواع */}
        <View style={styles.tabsRow}>
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <Pressable
                key={t.key}
                accessibilityRole="button"
                accessibilityLabel={t.label}
                accessibilityState={{ selected: active }}
                onPress={() => setTab(t.key)}
                style={[styles.tabChip, active && styles.tabChipActive]}
                testID={`reference-tab-${t.key}`}
              >
                <Text style={[styles.tabText, active && styles.tabTextActive]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {tab === 'units' ? (
          <View style={styles.noteRow}>
            <Info size={14} color={colors.textFaint} />
            <Text style={styles.noteText}>{ar.more.unitsNote}</Text>
          </View>
        ) : null}

        {state.kind === 'loading' ? (
          <AppCard noPadding>
            <LoadingState variant="list" rows={4} />
          </AppCard>
        ) : state.kind === 'error' ? (
          <AppCard noPadding>
            <ErrorState
              message={ar.settings.loadFailed}
              technical={state.technical}
              onRetry={() => void load()}
            />
          </AppCard>
        ) : items.length === 0 ? (
          <AppCard noPadding>
            <EmptyState
              icon={Plus}
              title={ar.settings.reference.add}
              message={ar.settings.reference.subtitle}
            />
          </AppCard>
        ) : (
          <ScrollView contentContainerStyle={styles.listContent}>
            <AppCard noPadding>
              {items.map((item, i) => (
                <View
                  key={item.id}
                  style={[styles.row, item.inactive && styles.rowInactive, i > 0 && styles.rowDivider]}
                >
                  <View style={styles.rowTexts}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {item.displayName}
                    </Text>
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {[
                        item.sub,
                        item.inactive ? ar.settings.reference.archived : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ') || ar.settings.reference.noUsage}
                    </Text>
                  </View>
                  {item.canRename ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={ar.settings.reference.rename}
                      onPress={() => {
                        setNameValue(item.displayName.split(' — ')[0] ?? '');
                        setSheet({ kind: 'rename', item });
                      }}
                      style={styles.miniBtn}
                      testID={`reference-rename-${item.id}`}
                    >
                      <Text style={styles.miniBtnText}>{ar.settings.reference.rename}</Text>
                    </Pressable>
                  ) : null}
                  {item.canToggle ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={item.toggleLabel}
                      onPress={() => void doToggle(item)}
                      style={[styles.miniBtn, !item.inactive && styles.miniBtnDanger]}
                      testID={`reference-toggle-${item.id}`}
                    >
                      <Text style={[styles.miniBtnText, !item.inactive && styles.miniBtnDangerText]}>
                        {item.toggleLabel}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </AppCard>
          </ScrollView>
        )}

        {canAdd ? (
          <PrimaryButton
            label={ar.settings.reference.add}
            icon={Plus}
            onPress={() => void openAdd()}
            style={styles.addBtn}
            testID="reference-add-btn"
          />
        ) : null}
        {feedback.host}
      </View>

      {/* ——— شيتات ——— */}
      <BottomSheet visible={sheet !== null} onClose={() => setSheet(null)} title={sheetTitle}>
        {sheet?.kind === 'rename' || sheet?.kind === 'addCat' ? (
          <>
            <TextField
              label={ar.settings.reference.nameSheetTitle}
              value={nameValue}
              onChangeText={setNameValue}
              testID="reference-name-input"
            />
            <PrimaryButton
              label={ar.common.save}
              onPress={() => (sheet.kind === 'rename' ? void doRename(sheet.item) : void doAdd())}
              loading={saving}
              style={styles.sheetBtn}
            />
          </>
        ) : sheet?.kind === 'addBox' ? (
          <>
            <TextField
              label={ar.settings.reference.nameSheetTitle}
              value={nameValue}
              onChangeText={setNameValue}
              testID="reference-box-name-input"
            />
            <Text style={styles.pickerLabel}>{ar.settings.reference.currencyPickTitle}</Text>
            <View style={styles.currencyChips}>
              {activeCurrencies.map((c) => {
                const active = c.id === boxCurrencyId;
                return (
                  <Pressable
                    key={c.id}
                    accessibilityRole="button"
                    accessibilityLabel={c.code}
                    accessibilityState={{ selected: active }}
                    onPress={() => setBoxCurrencyId(c.id)}
                    style={[styles.currencyChip, active && styles.currencyChipActive]}
                  >
                    <Text style={[styles.currencyChipText, active && styles.currencyChipTextActive]}>
                      {c.code}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <PrimaryButton
              label={ar.common.save}
              onPress={() => void doAdd()}
              loading={saving}
              style={styles.sheetBtn}
            />
          </>
        ) : sheet?.kind === 'addCur' ? (
          <>
            <TextField
              label={ar.settings.reference.code}
              value={curCode}
              onChangeText={(v) => setCurCode(v.toUpperCase())}
              placeholder={ar.settings.reference.codePh}
              maxLength={3}
              autoCapitalize="characters"
              testID="reference-cur-code-input"
            />
            <TextField
              label={ar.settings.reference.curName}
              value={curName}
              onChangeText={setCurName}
              placeholder={ar.settings.reference.curNamePh}
              testID="reference-cur-name-input"
            />
            <TextField
              label={ar.settings.reference.decimals}
              value={curDecimals}
              onChangeText={setCurDecimals}
              placeholder="0-4"
              keyboardType="number-pad"
              maxLength={1}
              hint={ar.settings.reference.decimalsHint}
              testID="reference-cur-decimals-input"
            />
            <Text style={styles.sheetHint}>{ar.settings.reference.currencyCodeNote}</Text>
            <PrimaryButton
              label={ar.common.save}
              onPress={() => void doAdd()}
              loading={saving}
              style={styles.sheetBtn}
            />
          </>
        ) : null}
      </BottomSheet>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  tabsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tabChip: {
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabChipActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(34, 211, 238, 0.16)',
  },
  tabText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  tabTextActive: {
    color: colors.accent,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.xs,
  },
  noteText: {
    flex: 1,
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 16,
  },
  listContent: {
    paddingBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 56,
  },
  rowDivider: {
    borderTopWidth: 1,
    borderTopColor: `${colors.border}88`,
  },
  rowInactive: {
    opacity: 0.55,
  },
  rowTexts: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  rowMeta: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  miniBtn: {
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.success,
    backgroundColor: 'rgba(52, 211, 153, 0.10)',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  miniBtnDanger: {
    borderColor: colors.danger,
    backgroundColor: 'rgba(248, 113, 113, 0.10)',
  },
  miniBtnText: {
    color: colors.success,
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
  },
  miniBtnDangerText: {
    color: colors.danger,
  },
  addBtn: {
    marginTop: spacing.xs,
  },
  pickerLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.sm,
    marginBottom: 6,
  },
  currencyChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  currencyChip: {
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  currencyChipActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(34, 211, 238, 0.16)',
  },
  currencyChipText: {
    color: colors.textMuted,
    fontFamily: font.numeric,
    fontSize: 12.5,
    lineHeight: 18,
  },
  currencyChipTextActive: {
    color: colors.accent,
  },
  sheetHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  sheetBtn: {
    marginTop: spacing.md,
  },
});
