/**
 * ListRow (DS-22) — صف قائمة: عنوان + سطر ثانوي + مبلغ (اختياري)،
 * ارتفاع ≥ 64، فاصل #334155، سهم تقدّم RTL (الشيفرون يشير يساراً — الاتجاه الأمامي في RTL).
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import AmountText from './AmountText';
import { colors, font, spacing, touch, type AmountTone } from '@/theme';

export type ListRowProps = {
  title: string;
  subtitle?: string;
  /** عقدة سطر ثانٍ مخصصة تُعرض مكان subtitle النصية — لمزج الخطوط (باركود + رصيد ملون) */
  subtitleNode?: ReactNode;
  /** عنصر بادئ (أيقونة/صورة) في جهة البداية */
  leading?: ReactNode;
  /** عنصر تالٍ مخصص — يُلغي المبلغ والسهم معاً */
  trailing?: ReactNode;
  amount?: string;
  amountTone?: AmountTone;
  amountCurrency?: string;
  amountDecimals?: number;
  amountArrow?: 'down' | 'up';
  onPress?: () => void;
  disabled?: boolean;
  /** خط فاصل سفلي #334155 */
  divider?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function ListRow({
  title,
  subtitle,
  subtitleNode,
  leading,
  trailing,
  amount,
  amountTone,
  amountCurrency,
  amountDecimals,
  amountArrow,
  onPress,
  disabled = false,
  divider = false,
  style,
  testID,
}: ListRowProps) {
  const body = (
    <>
      {leading}
      <View style={styles.texts}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitleNode
          ? subtitleNode
          : subtitle
            ? (
              <Text style={styles.subtitle} numberOfLines={2}>
                {subtitle}
              </Text>
            )
            : null}
      </View>
      {trailing ? (
        trailing
      ) : amount !== undefined ? (
        <AmountText
          value={amount}
          tone={amountTone}
          currency={amountCurrency}
          decimals={amountDecimals}
          arrow={amountArrow}
          size="md"
        />
      ) : null}
      {onPress && !trailing ? (
        // اتجاه أمامي في RTL = يسار (الأيقونة موجهة فتُقلب هنا صراحة)
        <ChevronLeft size={20} color={colors.textFaint} />
      ) : null}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={disabled ? undefined : onPress}
        style={({ pressed }) => [
          styles.row,
          divider && styles.divider,
          pressed && !disabled && styles.pressed,
          disabled && styles.disabled,
          style,
        ]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View
      testID={testID}
      style={[styles.row, divider && styles.divider, disabled && styles.disabled, style]}
    >
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touch.min + 16, // ≥ 64
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: 'transparent',
  },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.07)',
  },
  disabled: {
    opacity: 0.5,
  },
  texts: {
    flex: 1,
    gap: 2,
    alignItems: 'flex-start',
  },
  title: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  subtitle: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
});
