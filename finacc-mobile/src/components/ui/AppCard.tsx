/**
 * AppCard (DS-17) — أساس كل شاشة: بطاقة #1E293B نصف قطر 16، حشوة 16، ظل خفيف.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius, shadow, spacing } from '@/theme';

export type AppCardProps = {
  children: ReactNode;
  /** حشوة/هوامش إضافية من الخارج */
  style?: StyleProp<ViewStyle>;
  /** بطاقة قابلة للنقر (حالة ضغط فاتحة) */
  onPress?: () => void;
  /** إلغاء الحشوة الداخلية (المحتوى يديرها) */
  noPadding?: boolean;
  testID?: string;
};

export default function AppCard({ children, style, onPress, noPadding, testID }: AppCardProps) {
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
          styles.card,
          noPadding && styles.noPadding,
          pressed && styles.pressed,
          style,
        ]}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View testID={testID} style={[styles.card, noPadding && styles.noPadding, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...shadow.card,
  },
  noPadding: {
    padding: 0,
  },
  pressed: {
    backgroundColor: '#24334A',
  },
});
