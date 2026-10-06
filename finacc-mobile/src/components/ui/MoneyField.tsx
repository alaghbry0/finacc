/**
 * MoneyField — حقل مبلغ بأسلوب TextField لكن **بلا لوحة نظام إطلاقاً** (DS-38):
 * الضغط على الخانة يفتح BottomSheet بداخله NumberPad (نمط QtyStepper).
 * العرض: المبلغ بخط IBM Plex مع فواصل آلاف + رمز العملة — والقيمة خاماً نصياً
 * عشرياً ('90'، '115.5'…) كما تتوقعه دوال Domain.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, font, radius, spacing, touch } from '@/theme';
import { formatAmount, currencySymbol } from '@/utils/format';
import BottomSheet from './BottomSheet';
import NumberPad from './NumberPad';

export type MoneyFieldProps = {
  label: string;
  /** القيمة الخام (نص عشري — '0' افتراضياً) */
  value: string;
  onChange: (v: string) => void;
  /** رمز العملة المعروض بجوار القيمة (YER → ر.ي) */
  currencyCode?: string | null;
  /** منازل الكسور (من العملة: YER=0) — تُمرَّر إلى NumberPad */
  decimals?: number;
  error?: string | null;
  hint?: string | null;
  /** للحقول المقفلة (تكلفة WAC بعد وجود حركات) */
  disabled?: boolean;
  /** سطر التسمية داخل شيت اللوحة */
  sheetTitle?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function MoneyField({
  label,
  value,
  onChange,
  currencyCode,
  decimals = 2,
  error,
  hint,
  disabled = false,
  sheetTitle,
  style,
  testID,
}: MoneyFieldProps) {
  const [open, setOpen] = useState(false);
  const shown = formatAmount(value === '' ? '0' : value, decimals);
  const symbol = currencySymbol(currencyCode);

  const field = (
    <View style={styles.wrap} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} — ${shown}`}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.input,
          disabled && styles.disabled,
          { borderColor: error ? colors.danger : pressed ? colors.accent : colors.border },
        ]}
      >
        <Text
          style={[styles.value, error ? { color: colors.danger } : null]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {shown}
        </Text>
        {symbol ? <Text style={styles.currency}>{symbol}</Text> : null}
      </Pressable>
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );

  return (
    <>
      {field}
      <BottomSheet
        visible={open}
        onClose={() => setOpen(false)}
        title={sheetTitle ?? label}
      >
        <NumberPad
          value={value === '' ? '0' : value}
          onChange={onChange}
          allowDecimal={decimals > 0}
          decimals={decimals}
          label={sheetTitle ?? label}
          onDone={() => setOpen(false)}
        />
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
  },
  label: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'right',
  },
  input: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: touch.min,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  disabled: {
    opacity: 0.55,
  },
  value: {
    flex: 1,
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 17,
    lineHeight: 24,
    textAlign: 'right',
  },
  currency: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  error: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  hint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
});
