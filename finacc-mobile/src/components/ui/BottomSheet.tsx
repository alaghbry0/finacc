/**
 * BottomSheet (DS-23 + DS-28) — شيت من الأسفل: نصف قطر أعلى 20، مقبض سحب،
 * ارتفاع أقصى ~85%، محتوى قابل للتمرير، يغلق بنقر الخلفية/زر الرجوع.
 * الحركة: fade+slide بـ 180ms (لا مبالغات).
 *
 * تنفيذ RN Modal + Animated — بلا اعتماديات خارجية، يعمل على المنصات الثلاث.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, scrim, shadow, spacing } from '@/theme';

const DURATION = 180;

export type BottomSheetProps = {
  visible: boolean;
  /** غلق الخلفية/X — غيابه = شيت إجباري (مثل الدفع: لا مفر منه) */
  onClose?: () => void;
  title?: string;
  children: ReactNode;
  /** شريط مثبَّت أسفل الشيت (شريط الإجماليات/الأزرار) — يبقى فوق أي لوحة أرقام */
  footer?: ReactNode;
  /** نسبة الارتفاع الأقصى من الشاشة — افتراضي 0.85 */
  maxHeightRatio?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function BottomSheet({
  visible,
  onClose,
  title,
  children,
  footer,
  maxHeightRatio = 0.85,
  style,
  testID,
}: BottomSheetProps) {
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(visible);
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(1)).current; // 1 = مخفي (نسبة من الانزلاق)
  const hideAnim = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      fade.setValue(0);
      slide.setValue(1);
      Animated.parallel([
        Animated.timing(fade, {
          toValue: 1,
          duration: DURATION,
          easing: Easing.out(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(slide, {
          toValue: 0,
          duration: DURATION,
          easing: Easing.out(Easing.ease),
          useNativeDriver: false,
        }),
      ]).start();
    } else if (mounted) {
      hideAnim.current = Animated.parallel([
        Animated.timing(fade, {
          toValue: 0,
          duration: DURATION,
          easing: Easing.in(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(slide, {
          toValue: 1,
          duration: DURATION,
          easing: Easing.in(Easing.ease),
          useNativeDriver: false,
        }),
      ]);
      hideAnim.current.start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    return () => {
      hideAnim.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted) return null;

  const dismiss = onClose;

  const translateY = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [0, Math.round(winH * 0.6)],
  });

  return (
    <Modal transparent visible animationType="none" onRequestClose={dismiss} testID={testID}>
      <View style={styles.layer}>
        <Animated.View style={[styles.backdrop, { opacity: fade }]}>
          <Pressable
            accessibilityLabel={ar.common.close}
            style={StyleSheet.absoluteFill}
            onPress={dismiss}
            disabled={!dismiss}
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            {
              maxHeight: Math.round(winH * maxHeightRatio),
              marginBottom: Math.max(insets.bottom, 10),
              opacity: fade,
              transform: [{ translateY }],
            },
            style,
          ]}
        >
          <View style={styles.handle} />
          {title ? (
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {dismiss ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={ar.common.close}
                  onPress={dismiss}
                  hitSlop={6}
                  style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
                >
                  <X size={20} color={colors.textMuted} />
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <Animated.ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </Animated.ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  layer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: scrim,
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: 8,
    ...shadow.floating,
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
    marginBottom: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: 4,
    paddingBottom: 8,
  },
  title: {
    flex: 1,
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 18,
    lineHeight: 26,
  },
  closeBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  pressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.card,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
});
