/**
 * ErrorState (DS-33) — أيقونة + «ماذا حدث» بكلمات المستخدم + زر إعادة المحاولة
 * + تفاصيل تقنية قابلة للتوسيع. الرسالة تُصاغ خارجياً بنموذج §6.3
 * (ماذا حدث + ما الحل) — هذا المكون يعرضها ويضيف الطبقة التقنية.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ChevronDown, ChevronUp, RefreshCw, TriangleAlert } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import PrimaryButton from './PrimaryButton';

export type ErrorStateProps = {
  /** سطر «ماذا حدث + ما الحل» بكلمات المستخدم */
  message: string;
  /** عنوان قصير — افتراضياً «تعذّر إتمام الخطوة» */
  title?: string;
  /** نص تقني خام (err.message / stack مختصر) — قابل للتوسيع */
  technical?: string;
  onRetry?: () => void;
  retryLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function ErrorState({
  message,
  title = ar.components.errorState.title,
  technical,
  onRetry,
  retryLabel = ar.common.retry,
  style,
  testID,
}: ErrorStateProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={[styles.wrap, style]} testID={testID}>
      <View style={styles.iconWrap}>
        <TriangleAlert size={28} color={colors.danger} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
      {onRetry ? (
        <PrimaryButton label={retryLabel} onPress={onRetry} icon={RefreshCw} style={styles.retry} />
      ) : null}
      {technical ? (
        <View style={styles.techBox}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setExpanded((v) => !v)}
            style={({ pressed }) => [styles.techToggle, pressed && styles.techPressed]}
          >
            {expanded ? (
              <ChevronUp size={16} color={colors.textFaint} />
            ) : (
              <ChevronDown size={16} color={colors.textFaint} />
            )}
            <Text style={styles.techLabel}>
              {expanded ? ar.components.errorState.technicalHide : ar.components.errorState.technical}
            </Text>
          </Pressable>
          {expanded ? <Text style={styles.techText} selectable>{technical}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(248, 113, 113, 0.12)',
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
  retry: {
    alignSelf: 'center',
    marginTop: spacing.md,
    minWidth: 180,
  },
  techBox: {
    alignSelf: 'stretch',
    marginTop: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(15, 23, 42, 0.7)',
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  techToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 48,
  },
  techPressed: {
    opacity: 0.7,
  },
  techLabel: {
    color: colors.textFaint,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  techText: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'left',
  },
});
