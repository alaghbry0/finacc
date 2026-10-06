/**
 * CartLineRow — سطر سلة الفاتورة (§6.5 / FR-02-02):
 *  - الاسم + «المتاح: N» بلون تحذيري عند تجاوز الكمية (مع نص دائماً — قاعدة §6.1).
 *  - QtyStepper (DS-39) + سعر الوحدة (نقرة → NumberPad) + إجمالي السطر AmountText.
 *  - زر حذف ≥48×48 — الحذف نفسه عند الأب (مع «تراجع» DS-37).
 *  - النقر على جسد السطر (خارج عناصر التحكم) → شيت تعديل البند الكامل.
 *  - variant='purchase': السعر = تكلفة الشراء للوحدة والعرض «المتوفر حالياً: N»
 *    محايد بلا تحذير (الشراء يزيد المخزون — لا قيد متاح).
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Pencil, Trash2 } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import { formatAmount, currencySymbol, formatQty } from '@/utils/format';
import { d } from '@/utils/money';
import type { CartLine } from '@/store/cart';
import AmountText from '@/components/ui/AmountText';
import BottomSheet from '@/components/ui/BottomSheet';
import NumberPad from '@/components/ui/NumberPad';
import QtyStepper from '@/components/ui/QtyStepper';
import TagChip from '@/components/ui/TagChip';

export type CartLineRowProps = {
  line: CartLine;
  /** 'sale' (افتراضي): المتاح التحذيري — 'purchase': «المتوفر حالياً» محايد */
  variant?: 'sale' | 'purchase';
  /** إجمالي السطر المحسوب (من computeCartTotals) خاماً نصياً */
  lineTotal: string;
  currencyCode: string | null;
  decimals: number;
  onQtyChange: (qty: string) => void;
  onPriceChange: (price: string) => void;
  onDelete: () => void;
  onOpenEdit: () => void;
  testID?: string;
};

export default function CartLineRow({
  line,
  variant = 'sale',
  lineTotal,
  currencyCode,
  decimals,
  onQtyChange,
  onPriceChange,
  onDelete,
  onOpenEdit,
  testID,
}: CartLineRowProps) {
  const [pricePad, setPricePad] = useState(false);
  const isPurchase = variant === 'purchase';
  const overAvail =
    !isPurchase &&
    !line.isService &&
    line.productId !== null &&
    d(line.qty).gt(d(line.available === '' ? '0' : line.available));
  const symbol = currencySymbol(currencyCode);
  const priceLabel = isPurchase ? ar.purchases.cart.costCaption : ar.sales.cart.unitPrice;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={line.name}
        onPress={onOpenEdit}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        testID={testID}
      >
        {/* السطر الأول: الاسم + الحذف */}
        <View style={styles.headRow}>
          <View style={styles.nameWrap}>
            <Text style={styles.name} numberOfLines={1}>
              {line.name}
            </Text>
            {line.isService ? (
              <TagChip label={ar.sales.cart.serviceChip} color={colors.textMuted} />
            ) : isPurchase ? (
              <Text style={[styles.avail, styles.availNeutral]}>
                {`${ar.purchases.cart.currentStock}: ${formatQty(line.available)}`}
              </Text>
            ) : (
              <Text style={[styles.avail, overAvail && styles.availOver]}>
                {overAvail
                  ? `${ar.sales.cart.available}: ${formatQty(line.available)} — ${ar.sales.cart.overAvail}`
                  : `${ar.sales.cart.available}: ${formatQty(line.available)}`}
              </Text>
            )}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${ar.common.remove} — ${line.name}`}
            onPress={onDelete}
            hitSlop={2}
            style={({ pressed }) => [styles.deleteBtn, pressed && styles.deletePressed]}
            testID={`cart-line-delete-${line.key}`}
          >
            <Trash2 size={20} color={colors.danger} />
          </Pressable>
        </View>

        {/* السطر الثاني: الكمية + السعر + إجمالي السطر */}
        <View style={styles.controlsRow}>
          <QtyStepper
            value={line.qty}
            onChange={onQtyChange}
            min="1"
            sheetTitle={`${ar.sales.cart.qty} — ${line.name}`}
            testID={`cart-line-qty-${line.key}`}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${ar.sales.cart.unitPrice} — ${formatAmount(line.unitPrice, decimals)}`}
            onPress={() => setPricePad(true)}
            style={({ pressed }) => [styles.priceBox, pressed && styles.pricePressed]}
          >
            <Text style={styles.priceValue} numberOfLines={1} adjustsFontSizeToFit>
              {formatAmount(line.unitPrice, decimals)}
            </Text>
            {symbol ? <Text style={styles.priceSymbol}>{symbol}</Text> : null}
            <Pencil size={14} color={colors.textFaint} />
          </Pressable>
          <View style={styles.totalWrap}>
            <AmountText value={lineTotal} decimals={decimals} size="lg" currency={currencyCode ?? undefined} />
          </View>
        </View>
      </Pressable>

      {/* شيت تعديل سعر الوحدة (NumberPad — DS-38) */}
      <BottomSheet
        visible={pricePad}
        onClose={() => setPricePad(false)}
        title={`${priceLabel} — ${line.name}`}
      >
        <NumberPad
          value={line.unitPrice}
          onChange={onPriceChange}
          allowDecimal={decimals > 0}
          decimals={decimals}
          label={priceLabel}
          onDone={() => setPricePad(false)}
        />
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 10,
  },
  rowPressed: {
    backgroundColor: '#24334A',
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  nameWrap: {
    flex: 1,
    gap: 2,
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
  /** الشراء: «المتوفر حالياً» محايد — لا قيد متاح في الشراء */
  availNeutral: {
    color: colors.textMuted,
  },
  availOver: {
    color: colors.danger,
    fontFamily: font.medium,
  },
  deleteBtn: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  deletePressed: {
    backgroundColor: 'rgba(248, 113, 113, 0.14)',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  priceBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: touch.min,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pricePressed: {
    borderColor: colors.accent,
  },
  priceValue: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
  },
  priceSymbol: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
  },
  totalWrap: {
    flex: 1,
    alignItems: 'flex-end',
  },
});
