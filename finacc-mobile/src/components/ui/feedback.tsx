/**
 * FeedbackBar (DS-37) + useFeedback — Snackbar سفلي 5 ثوانٍ بزر «تراجع» اختياري.
 * تنفيذ محلي خفيف بلا مكتبات: hook يحمل الحالة ويُرجع عنصراً يُضمَّن أسفل الشاشة.
 *
 * الاستخدام:
 *   const feedback = useFeedback();
 *   feedback.show({ message: 'حُذف السطر', actionLabel: 'تراجع', onAction: undo });
 *   … وفي أسفل الشاشة: {feedback.host}
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, shadow, spacing } from '@/theme';

const DURATION_MS = 5000;
const ANIM_MS = 180;

export type FeedbackOptions = {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  /** مدة العرض بالمللي ثانية — افتراضي 5000 (DS-37) */
  durationMs?: number;
};

export type FeedbackApi = {
  show: (opts: FeedbackOptions) => void;
  /** عنصر يُرندَر مرة واحدة داخل الشاشة (أسفلها) */
  host: ReactNode;
};

export function useFeedback(): FeedbackApi {
  const [current, setCurrent] = useState<FeedbackOptions | null>(null);
  const seq = useRef(0);

  const show = useCallback((opts: FeedbackOptions) => {
    seq.current += 1;
    setCurrent(opts);
  }, []);

  const host = current ? (
    <FeedbackBar
      key={seq.current}
      message={current.message}
      actionLabel={current.actionLabel}
      onAction={current.onAction}
      onDismiss={() => setCurrent(null)}
      durationMs={current.durationMs ?? DURATION_MS}
    />
  ) : null;

  return { show, host };
}

export type FeedbackBarProps = {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  durationMs?: number;
  testID?: string;
};

export default function FeedbackBar({
  message,
  actionLabel,
  onAction,
  onDismiss,
  durationMs = DURATION_MS,
  testID,
}: FeedbackBarProps) {
  const anim = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: ANIM_MS,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();
    timer.current = setTimeout(() => onDismiss(), durationMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = () => {
    if (timer.current) clearTimeout(timer.current);
    Animated.timing(anim, {
      toValue: 0,
      duration: ANIM_MS,
      easing: Easing.in(Easing.ease),
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) onDismiss();
    });
  };

  return (
    <View style={styles.anchor} pointerEvents="box-none">
      <Animated.View
        testID={testID}
        style={[
          styles.bar,
          {
            opacity: anim,
            transform: [
              {
                translateY: anim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [28, 0],
                }),
              },
            ],
          },
        ]}
      >
        <Text style={styles.message} numberOfLines={3}>
          {message}
        </Text>
        {actionLabel ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${ar.common.undo} — ${actionLabel}`}
            onPress={() => {
              onAction?.();
              dismiss();
            }}
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
          >
            <Text style={styles.actionLabel}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    pointerEvents: 'box-none',
  },
  bar: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    marginBottom: 76, // فوق شريط التبويبات
    ...shadow.floating,
  },
  message: {
    flex: 1,
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'right',
  },
  action: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: radius.sm,
  },
  actionPressed: {
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
  },
  actionLabel: {
    color: colors.warning,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
  },
});
