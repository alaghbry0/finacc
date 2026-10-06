/**
 * SegmentedControl — صف إعداد بمقاطع اختيار (FR-13 شاشات الإعدادات):
 * تسمية + وصف + أزرار مقاطع (2-3 خيارات) — المختار بمينا سماوي.
 * يستخدم مفاتيح سجل الإعدادات (ملحق هـ) حصراً — لا قيم حرة.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '@/theme';

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
};

export type SegmentedControlProps<T extends string> = {
  label: string;
  description?: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onSelect: (value: T) => void;
  disabled?: boolean;
  testID?: string;
};

export default function SegmentedControl<T extends string>({
  label,
  description,
  options,
  value,
  onSelect,
  disabled = false,
  testID,
}: SegmentedControlProps<T>) {
  return (
    <View style={styles.wrap} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      {description ? <Text style={styles.desc}>{description}</Text> : null}
      <View style={styles.row}>
        {options.map((opt) => {
          const selected = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              accessibilityRole="button"
              accessibilityLabel={opt.label}
              disabled={disabled}
              onPress={() => onSelect(opt.value)}
              style={({ pressed }) => [
                styles.segment,
                selected && styles.segmentActive,
                pressed && !disabled && styles.segmentPressed,
                disabled && styles.segmentDisabled,
              ]}
              testID={testID ? `${testID}-${opt.value}` : undefined}
            >
              <Text style={[styles.segmentText, selected && styles.segmentTextActive]} numberOfLines={1}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
    paddingVertical: spacing.md,
  },
  label: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 21,
  },
  desc: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 18,
  },
  row: {
    flexDirection: 'row-reverse', // RTL: الخيار الأول يميناً
    gap: spacing.sm,
    marginTop: 2,
  },
  segment: {
    flex: 1,
    minHeight: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    backgroundColor: 'transparent',
  },
  segmentActive: {
    borderColor: colors.accent,
    backgroundColor: `${colors.accent}1F`,
  },
  segmentPressed: {
    opacity: 0.75,
  },
  segmentDisabled: {
    opacity: 0.45,
  },
  segmentText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  segmentTextActive: {
    color: colors.accent,
    fontFamily: font.bold,
  },
});
