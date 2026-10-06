/**
 * ScreenHeader — رأس موحّد لكل الشاشات المدفوعة (pushed):
 * عنوان Tajawal 700 + زر رجوع RTL (شيفرون يشير يميناً — رجوع في RTL) +
 * أزرار أيقونية تالية (تظهر في جهة النهاية/اليسار في RTL).
 * الشاشات التابعة للتبويبات ترسم رؤوسها الخاصة ولا تستخدم هذا.
 */
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { I18nManager, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ar } from '@/i18n/ar';
import { colors, font, spacing, touch } from '@/theme';

export type HeaderAction = {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  onPress: () => void;
};

export type ScreenHeaderProps = {
  title: string;
  subtitle?: string;
  /** يربط زر الرجوع — عادة router.back() */
  onBack?: () => void;
  /** أزرار أيقونية في نهاية الرأس */
  actions?: HeaderAction[];
  leading?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function ScreenHeader({
  title,
  subtitle,
  onBack,
  actions,
  leading,
  style,
  testID,
}: ScreenHeaderProps) {
  // رجوع RTL: الشاشة تتدفق من اليمين، فالعودة تشير يميناً (RTL-flipped)
  const BackIcon = I18nManager.isRTL ? ChevronRight : ChevronLeft;

  return (
    <View style={[styles.wrap, style]} testID={testID}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ar.common.back}
          onPress={onBack}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          hitSlop={2}
        >
          <BackIcon size={24} color={colors.text} />
        </Pressable>
      ) : null}
      {leading}
      <View style={styles.titles}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {actions ? (
        <View style={styles.actions}>
          {actions.map((a) => {
            const Icon = a.icon;
            return (
              <Pressable
                key={a.label}
                accessibilityRole="button"
                accessibilityLabel={a.label}
                onPress={a.onPress}
                style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
                hitSlop={2}
              >
                <Icon size={22} color={colors.textMuted} />
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 56,
    paddingHorizontal: spacing.sm,
  },
  titles: {
    flex: 1,
    gap: 0,
  },
  title: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 20,
    lineHeight: 28,
  },
  subtitle: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  iconBtn: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  pressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
});
