/**
 * TagChip — شريحة نصية صغيرة عامة (RN خالصة من توكنز DS):
 * لوسوم لا تغطيها StatusChip المعرفة مسبقاً: «خدمة»، «مؤرشف»، «QR لاحقاً»،
 * «حد ائتمان: X»، «كشف الحساب — مرحلة قادمة»… نص دائماً (قاعدة §6.1).
 */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, font, radius } from '@/theme';

export type TagChipProps = {
  label: string;
  /** لون النص (أحد ألوان DS الدلالية) — افتراضي النص الثانوي */
  color?: string;
  /** خلفية الشريحة — افتراضياً شفافية 14% من اللون نفسه */
  background?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function TagChip({ label, color, background, style, testID }: TagChipProps) {
  const fg = color ?? colors.textMuted;
  const bg = background ?? 'rgba(148, 163, 184, 0.14)';
  return (
    <View style={[styles.chip, { backgroundColor: bg }, style]} testID={testID}>
      <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radius.full,
    paddingVertical: 3,
    paddingHorizontal: 10,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  label: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
});
