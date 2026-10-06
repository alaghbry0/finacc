/**
 * SafeScreen — غلاف كل شاشة: SafeAreaView + خلفية DS-01 + شريط أوفلاين (DS-34)
 * + تمرير/بلا تمرير + تجنّب لوحة المفاتيح + محتوى قابل للاستبدال (FlatList عبر children).
 */
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import OfflineBanner from './OfflineBanner';
import { colors, spacing } from '@/theme';

export type SafeScreenProps = {
  children: ReactNode;
  /** تمرير المحتوى (افتراضي true) — false للقوائم الافتراضية (FlatList) */
  scroll?: boolean;
  /** حشوة أفقية 16 وفجوات — افتراضي true */
  padded?: boolean;
  /** تجنّب لوحة المفاتيح (للشاشات ذات إدخال) */
  avoidKeyboard?: boolean;
  /** إظهار شريط أوفلاين — افتراضي true */
  offline?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function SafeScreen({
  children,
  scroll = true,
  padded = true,
  avoidKeyboard = false,
  offline = true,
  style,
  contentStyle,
  testID,
}: SafeScreenProps) {
  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[padded && styles.padded, contentStyle]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, padded && styles.padded, contentStyle]}>{children}</View>
  );

  return (
    <SafeAreaView style={[styles.safe, style]} edges={['top', 'bottom', 'left', 'right']} testID={testID}>
      {offline ? <OfflineBanner /> : null}
      {avoidKeyboard ? (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {body}
        </KeyboardAvoidingView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  padded: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
});
