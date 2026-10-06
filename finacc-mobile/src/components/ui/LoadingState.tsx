/**
 * LoadingState (DS-32) — هيكل Skeleton بنبض شفافية (shimmer خفيف) للقوائم
 * والبطاقات والتقارير — **لا شاشة بيضاء أبداً**.
 * «SkeletonLine» هي كتل الأسطر الداخلية (line70/line40/…) — غير مصدَّرة،
 * كل الأشكال تُطلب عبر variant.
 */
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';

export type LoadingVariant = 'list' | 'card' | 'report';

export type LoadingStateProps = {
  variant?: LoadingVariant;
  rows?: number;
  label?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function LoadingState({
  variant = 'list',
  rows = 5,
  label = ar.components.loading.label,
  style,
  testID,
}: LoadingStateProps) {
  const pulse = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 620, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0.35, duration: 620, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const opacity = { opacity: pulse } as const;

  return (
    <View style={[styles.wrap, style]} testID={testID} accessibilityLabel={label}>
      {variant === 'list' ? (
        <View style={styles.stack}>
          {Array.from({ length: rows }, (_, i) => (
            <View key={i} style={styles.listRow}>
              <Animated.View style={[styles.avatar, opacity]} />
              <View style={styles.listLines}>
                <Animated.View style={[styles.line70, opacity]} />
                <Animated.View style={[styles.line40, opacity]} />
              </View>
            </View>
          ))}
        </View>
      ) : variant === 'card' ? (
        <View style={styles.stack}>
          <Animated.View style={[styles.cardBlock, opacity]} />
          <Animated.View style={[styles.line60, opacity]} />
          <Animated.View style={[styles.line40, opacity]} />
        </View>
      ) : (
        <View style={styles.stack}>
          <Animated.View style={[styles.headerBlock, opacity]} />
          <View style={styles.reportGrid}>
            {Array.from({ length: 4 }, (_, i) => (
              <Animated.View key={i} style={[styles.reportCell, opacity]} />
            ))}
          </View>
          <Animated.View style={[styles.line70, opacity]} />
          <Animated.View style={[styles.line40, opacity]} />
        </View>
      )}
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  stack: {
    gap: spacing.md,
  },
  skeleton: {
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 64,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
  },
  listLines: {
    flex: 1,
    gap: 8,
  },
  line70: {
    height: 15,
    borderRadius: 6,
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
    width: '70%',
  },
  line60: {
    height: 15,
    borderRadius: 6,
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
    width: '60%',
  },
  line40: {
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
    width: '40%',
  },
  cardBlock: {
    height: 120,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
  },
  headerBlock: {
    height: 24,
    borderRadius: 6,
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
    width: '45%',
  },
  reportGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  reportCell: {
    flexBasis: '47%',
    flexGrow: 1,
    height: 64,
    borderRadius: radius.md,
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
  },
  label: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
