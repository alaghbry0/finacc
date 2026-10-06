/**
 * LineEditSheet — شيت تعديل بند السلة (§6.5): الكمية وسعر الوحدة وخصم البند
 * (نسبة/مبلغ بتبويب) — كل القيم عبر NumberPad داخل شيت داخلي (DS-38، بلا لوحة
 * نظام)، والتحرير مباشر (كما في QtyStepper) مع إظهار المتاح للبنود المخزنية.
 * variant='purchase': التسمية «تكلفة الشراء للوحدة» و«المتوفر حالياً: N» محايد.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Pencil } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { formatAmount, formatQty, currencySymbol } from '@/utils/format';
import type { CartLine } from '@/store/cart';
import AmountText from '@/components/ui/AmountText';
import BottomSheet from '@/components/ui/BottomSheet';
import NumberPad from '@/components/ui/NumberPad';
import TagChip from '@/components/ui/TagChip';

export type LineEditSheetProps = {
  visible: boolean;
  onClose: () => void;
  line: CartLine | null;
  /** 'sale' (افتراضي): سعر الوحدة/المتاح — 'purchase': تكلفة الشراء/المتوفر حالياً */
  variant?: 'sale' | 'purchase';
  /** إجمالي السطر الحالي (خام نصياً) */
  lineTotal: string;
  currencyCode: string | null;
  decimals: number;
  onQtyChange: (qty: string) => void;
  onPriceChange: (price: string) => void;
  onDiscountChange: (kind: 'percent' | 'amount', value: string) => void;
  testID?: string;
};

type PadTarget = 'qty' | 'price' | 'discount' | null;

export default function LineEditSheet({
  visible,
  onClose,
  line,
  variant = 'sale',
  lineTotal,
  currencyCode,
  decimals,
  onQtyChange,
  onPriceChange,
  onDiscountChange,
  testID,
}: LineEditSheetProps) {
  const [pad, setPad] = useState<PadTarget>(null);
  const [discTab, setDiscTab] = useState<'percent' | 'amount'>('percent');

  useEffect(() => {
    if (visible) {
      setPad(null);
      setDiscTab('percent');
    }
  }, [visible]);

  if (!line) return null;
  const symbol = currencySymbol(currencyCode);
  const isPurchase = variant === 'purchase';
  const priceLabel = isPurchase ? ar.purchases.cart.costCaption : ar.sales.cart.price;
  const availText = isPurchase
    ? `${ar.purchases.cart.currentStock}: ${formatQty(line.available)}`
    : `${ar.sales.cart.available}: ${formatQty(line.available)}`;
  const hasDiscount =
    (discTab === 'percent' && line.lineDiscountPercent !== '0') ||
    (discTab === 'amount' && line.lineDiscountAmount !== '0');

  const padValue =
    pad === 'qty'
      ? line.qty
      : pad === 'price'
        ? line.unitPrice
        : discTab === 'percent'
          ? line.lineDiscountPercent
          : line.lineDiscountAmount;

  const onPadChange = (v: string) => {
    if (pad === 'qty') onQtyChange(v);
    else if (pad === 'price') onPriceChange(v);
    else onDiscountChange(discTab, v);
  };

  return (
    <>
      <BottomSheet visible={visible} onClose={onClose} title={ar.sales.cart.lineEdit} testID={testID}>
        {/* رأس: الاسم + المتاح/المتوفر (شراء) أو الخدمة */}
        <View style={styles.headCard}>
          <Text style={styles.name}>{line.name}</Text>
          {line.isService ? (
            <TagChip label={ar.sales.cart.serviceChip} color={colors.textMuted} />
          ) : (
            <Text style={[styles.avail, isPurchase && styles.availNeutral]}>{availText}</Text>
          )}
        </View>

        {/* الكمية */}
        <ValueRow
          label={ar.sales.cart.qty}
          value={formatQty(line.qty)}
          onPress={() => setPad('qty')}
        />

        {/* سعر الوحدة / تكلفة الشراء للوحدة */}
        <ValueRow
          label={`${priceLabel}${symbol ? ` (${symbol})` : ''}`}
          value={formatAmount(line.unitPrice, decimals)}
          onPress={() => setPad('price')}
        />

        {/* خصم البند — تبويب نسبة/مبلغ */}
        <View style={styles.discountBox}>
          <View style={styles.discountHead}>
            <Text style={styles.discountLabel}>{ar.sales.cart.lineDiscount}</Text>
            <View style={styles.tabRow}>
              <TabButton
                label={ar.sales.cart.percent}
                active={discTab === 'percent'}
                onPress={() => setDiscTab('percent')}
              />
              <TabButton
                label={ar.sales.cart.amount}
                active={discTab === 'amount'}
                onPress={() => setDiscTab('amount')}
              />
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.sales.cart.lineDiscount}
            onPress={() => setPad('discount')}
            style={({ pressed }) => [styles.discountValueRow, pressed && styles.pressed]}
          >
            <Text
              style={[
                styles.discountValue,
                hasDiscount ? { color: colors.warning } : null,
              ]}
            >
              {discTab === 'percent'
                ? `${formatQty(line.lineDiscountPercent)}%`
                : formatAmount(line.lineDiscountAmount, decimals)}
            </Text>
            <Pencil size={14} color={colors.textFaint} />
          </Pressable>
        </View>

        {/* إجمالي السطر */}
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>{ar.sales.cart.lineTotal}</Text>
          <AmountText value={lineTotal} size="xl" decimals={decimals} currency={currencyCode ?? undefined} />
        </View>
      </BottomSheet>

      {/* اللوحة الداخلية — تعلو الشيت الأم (نمط PaymentSheet) */}
      <BottomSheet
        visible={pad !== null}
        onClose={() => setPad(null)}
        title={
          pad === 'qty'
            ? ar.sales.cart.qty
            : pad === 'price'
              ? priceLabel
              : ar.sales.cart.lineDiscount
        }
        key="line-edit-pad"
      >
        <NumberPad
          value={padValue === '' ? '0' : padValue}
          onChange={onPadChange}
          allowDecimal={pad === 'qty' || decimals > 0}
          decimals={pad === 'qty' ? 3 : decimals}
          label={
            pad === 'qty'
              ? ar.sales.cart.qty
              : pad === 'price'
                ? priceLabel
                : ar.sales.cart.lineDiscount
          }
          onDone={() => setPad(null)}
        />
      </BottomSheet>
    </>
  );
}

/* ============ صف قيمة (تسمية + قيمة قابلة للتحرير بلوحة) ============ */

function ValueRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.valueRow, pressed && styles.pressed]}
    >
      <Text style={styles.valueLabel}>{label}</Text>
      <View style={styles.valueTrailing}>
        <Text style={styles.valueText}>{value}</Text>
        <Pencil size={14} color={colors.textFaint} />
      </View>
    </Pressable>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.tabBtn, active && styles.tabBtnActive]}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headCard: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 4,
  },
  name: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  avail: {
    color: colors.success,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  /** الشراء: «المتوفر حالياً» محايد (بلا تحذير تجاوز — الشراء يزيد المخزون) */
  availNeutral: {
    color: colors.textMuted,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touch.min,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  valueLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  valueTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  valueText: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 17,
    lineHeight: 24,
  },
  discountBox: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 8,
  },
  discountHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  discountLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  tabRow: {
    flexDirection: 'row',
    gap: 6,
  },
  tabBtn: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBtnActive: {
    borderColor: colors.warning,
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
  },
  tabText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  tabTextActive: {
    color: colors.warning,
  },
  discountValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  discountValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 17,
    lineHeight: 24,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  totalLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  pressed: {
    borderColor: colors.accent,
  },
});
