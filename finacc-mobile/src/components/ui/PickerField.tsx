/**
 * PickerField — حقل منتقي مرجعية (فئة/وحدة/مخزن/عملة): خانة بأسلوب TextField
 * تعرض المختار الحالي، والضغط يفتح OptionPickerSheet (BottomSheet + ListRow بعلامة صح).
 * لا لوحة نظام ولا قوائم منسدلة منصة-خاصة — نمط DS موحّد يعمل على المنصات الثلاث.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Check } from 'lucide-react-native';
import { colors, font, radius, touch } from '@/theme';
import OptionPickerSheet, { type PickerOption } from './OptionPickerSheet';

export type PickerFieldProps = {
  label: string;
  /** عنوان شيت المنتقي */
  title: string;
  options: PickerOption[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
  error?: string | null;
  hint?: string | null;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function PickerField({
  label,
  title,
  options,
  selectedId,
  onSelect,
  allowNone = false,
  noneLabel,
  error,
  hint,
  disabled = false,
  style,
  testID,
}: PickerFieldProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === selectedId) ?? null;
  const valueText = selected
    ? selected.detail
      ? `${selected.label} — ${selected.detail}`
      : selected.label
    : (noneLabel ?? '—');

  return (
    <View style={[styles.wrap, style]} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${valueText}`}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.input,
          disabled && styles.disabled,
          { borderColor: error ? colors.danger : pressed ? colors.accent : colors.border },
        ]}
      >
        <Text
          style={[styles.value, !selected && !allowNone && styles.placeholder]}
          numberOfLines={1}
        >
          {valueText}
        </Text>
        {selected ? <Check size={18} color={colors.accent} /> : null}
      </Pressable>
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
      <OptionPickerSheet
        visible={open}
        title={title}
        options={options}
        selectedId={selectedId}
        onSelect={onSelect}
        onClose={() => setOpen(false)}
        allowNone={allowNone}
        noneLabel={noneLabel}
        disabled={disabled}
      />
    </View>
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
    gap: 8,
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
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'right',
  },
  placeholder: {
    color: colors.textFaint,
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
