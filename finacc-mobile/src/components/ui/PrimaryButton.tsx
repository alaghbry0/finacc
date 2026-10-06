/**
 * PrimaryButton (DS-20) — الزر الرئيس: خلفية سماوية #22D3EE بنص داكن عريض،
 * نصف قطر 12، ارتفاع 48، حالتا ضغط وتعطيل، أيقونة اختيارية، وحمْل (spinner).
 * الدرجات: primary (سماوي) / success / warning / danger / ghost (شفاف بحد).
 */
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { colors, font, radius, touch } from '@/theme';

export type ButtonTone = 'primary' | 'success' | 'warning' | 'danger' | 'ghost';

export type PrimaryButtonProps = {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  /** يعرض مؤشر انتظار ويعطّل الضغط */
  loading?: boolean;
  icon?: LucideIcon;
  tone?: ButtonTone;
  /** ارتفاع مضغوط 40 (فقط حيث لا هدف لمس مباشر — التفاعلات الرئيسة تبقى 48) */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children?: ReactNode;
};

const TONES: Record<ButtonTone, { bg: string; fg: string; border?: string }> = {
  primary: { bg: colors.accent, fg: colors.onAccent },
  success: { bg: colors.success, fg: colors.onAccent },
  warning: { bg: colors.warning, fg: colors.onAccent },
  danger: { bg: colors.danger, fg: colors.onAccent },
  ghost: { bg: 'transparent', fg: colors.accent, border: colors.border },
};

export default function PrimaryButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  icon: Icon,
  tone = 'primary',
  compact = false,
  style,
  testID,
  children,
}: PrimaryButtonProps) {
  const t = TONES[tone];
  const blocked = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: loading }}
      onPress={blocked ? undefined : onPress}
      style={({ pressed }) => [
        styles.base,
        compact ? styles.compact : styles.regular,
        { backgroundColor: t.bg },
        t.border ? { borderWidth: 1, borderColor: t.border } : null,
        pressed && !blocked && styles.pressed,
        blocked && styles.blocked,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={t.fg} size="small" />
      ) : Icon ? (
        <Icon size={20} color={t.fg} />
      ) : null}
      <Text style={[styles.label, { color: t.fg }]} numberOfLines={1}>
        {label}
      </Text>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.md,
    alignSelf: 'stretch',
    paddingHorizontal: 16,
  },
  regular: {
    minHeight: touch.min,
  },
  compact: {
    minHeight: 40,
  },
  pressed: {
    opacity: 0.82,
  },
  blocked: {
    opacity: 0.45,
  },
  label: {
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
});
