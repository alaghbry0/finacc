/**
 * EmptyState (DS-25) — رسمة/أيقونة + جملة + زر إجراء.
 * «لا فواتير بعد — أنشئ أول فاتورة» — كل شيء قابل للضبط من الخارج.
 */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { Inbox } from 'lucide-react-native';
import PrimaryButton from './PrimaryButton';
import { colors, font, radius, spacing } from '@/theme';

export type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** زر موجود لكن غير مفعّل (ميزة قادمة) */
  actionDisabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function EmptyState({
  icon: Icon = Inbox,
  title,
  message,
  actionLabel,
  onAction,
  actionDisabled = false,
  style,
  testID,
}: EmptyStateProps) {
  return (
    <View style={[styles.wrap, style]} testID={testID}>
      <View style={styles.iconWrap}>
        <Icon size={30} color={colors.accent} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {actionLabel ? (
        <PrimaryButton
          label={actionLabel}
          onPress={onAction}
          disabled={actionDisabled || !onAction}
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(34, 211, 238, 0.10)',
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 18,
    lineHeight: 26,
    textAlign: 'center',
  },
  message: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  action: {
    alignSelf: 'center',
    marginTop: spacing.md,
    minWidth: 180,
  },
});
