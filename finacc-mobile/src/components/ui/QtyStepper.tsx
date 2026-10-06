/**
 * QtyStepper (DS-39) — أزرار − / القيمة / + بق ≥ 48×48:
 *  - النقر على الرقم يفتح NumberPad داخل شيت.
 *  - الضغط المطوّل يتسارع (كمية 20 ≠ 19 ضغطة): سلسلة مؤقتات تبدأ 240ms
 *    وتتقارب هندسياً حتى 60ms (تُنفَّذ وتُوثَّق — يصعب إثباتها آلياً headless).
 *  - ترتيب RTL: «−» في أقصى اليمين ثم القيمة ثم «+» في اليسار (انعكاس الصف تلقائي).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Minus, Plus } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, touch } from '@/theme';
import { formatQty } from '@/utils/format';
import { d, f3 } from '@/utils/money';
import BottomSheet from './BottomSheet';
import NumberPad from './NumberPad';

export type QtyStepperProps = {
  /** الكمية خاماً نصياً (f3 من Domain) */
  value: string;
  onChange: (v: string) => void;
  /** الحد الأدنى — افتراضي 0 */
  min?: string;
  /** الحد الأقصى (المتاح مثلاً) — اختياري */
  max?: string;
  /** خطوة النقر — افتراضي 1 */
  step?: string;
  /** سماح كسور عشرية — افتراضي true */
  allowDecimal?: boolean;
  disabled?: boolean;
  /** عنوان شيت لوحة الأرقام */
  sheetTitle?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const HOLD_START_MS = 240;
const HOLD_MIN_MS = 60;
const HOLD_ACCEL = 0.8;

export default function QtyStepper({
  value,
  onChange,
  min = '0',
  max,
  step = '1',
  allowDecimal = true,
  disabled = false,
  sheetTitle,
  style,
  testID,
}: QtyStepperProps) {
  const [padOpen, setPadOpen] = useState(false);
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedRef = useRef(HOLD_START_MS);

  const stopHold = useCallback(() => {
    if (holdRef.current) {
      clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  }, []);

  useEffect(() => stopHold, [stopHold]);

  const bump = (dir: 1 | -1) => {
    let next = d(value).plus(d(step).times(dir));
    if (next.lt(d(min))) next = d(min);
    if (max && next.gt(d(max))) next = d(max);
    if (next.lt(0)) next = d(0);
    onChange(allowDecimal ? f3(next) : next.trunc().toFixed(0));
  };

  const startHold = (dir: 1 | -1) => {
    stopHold();
    speedRef.current = HOLD_START_MS;
    const tick = () => {
      bump(dir);
      speedRef.current = Math.max(HOLD_MIN_MS, Math.round(speedRef.current * HOLD_ACCEL));
      holdRef.current = setTimeout(tick, speedRef.current);
    };
    holdRef.current = setTimeout(tick, HOLD_START_MS);
  };

  return (
    <View style={[styles.wrap, disabled && styles.disabled, style]} testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="إنقاص الكمية"
        disabled={disabled}
        onPressIn={() => startHold(-1)}
        onPressOut={stopHold}
        onPress={() => bump(-1)}
        style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
      >
        <Minus size={22} color={colors.text} />
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="تعديل الكمية بلوحة الأرقام"
        disabled={disabled}
        onPress={() => setPadOpen(true)}
        style={({ pressed }) => [styles.value, pressed && styles.valuePressed]}
      >
        <Text style={styles.valueText} numberOfLines={1} adjustsFontSizeToFit>
          {formatQty(value)}
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="زيادة الكمية"
        disabled={disabled}
        onPressIn={() => startHold(1)}
        onPressOut={stopHold}
        onPress={() => bump(1)}
        style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
      >
        <Plus size={22} color={colors.text} />
      </Pressable>

      <BottomSheet
        visible={padOpen}
        onClose={() => setPadOpen(false)}
        title={sheetTitle ?? ar.components.numberPad.title}
      >
        <NumberPad
          value={value}
          onChange={onChange}
          allowDecimal={allowDecimal}
          decimals={3}
          label={sheetTitle}
          onDone={() => setPadOpen(false)}
        />
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  disabled: {
    opacity: 0.45,
  },
  btn: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPressed: {
    backgroundColor: '#24334A',
    borderColor: colors.accent,
  },
  value: {
    minWidth: 64,
    height: touch.min,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  valuePressed: {
    borderColor: colors.accent,
  },
  valueText: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 17,
    lineHeight: 24,
  },
});
