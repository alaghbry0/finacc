/**
 * NumberPad (DS-38) — لوحة رقمية داخلية موحدة (0-9 + فاصل عشري + تراجع/تصفير)
 * مع تجميع آلاف لحظي في العرض — **بلا لوحة نظام**.
 * تُستخدم للكمية والسعر والخصم والجرد وPaymentSheet — الأصل محتوى خام
 * يلفّه الأب في BottomSheet (أو يعرضه مستقلاً).
 *
 * سياقان للرموز السرية (PIN): `secure` يحجب العرض بنقاط ● (لا يكشف الرقم
 * ولا يجمعه بفواصل)، و`hideDisplay` يخفي صندوق العرض كاملاً عندما يعرض
 * الأب مؤشره الخاص (شاشة الدخول بنقاطها) — الرقم نفسه لا يظهر أبداً.
 *
 * الارتجاز (haptic): نقطة جاهزة `tapHaptic()` — لا-op الآن؛ تُوصَل expo-haptics
 * على المنصات الأصلية لاحقاً دون تغيير أي مستدعٍ.
 */
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Delete } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, touch } from '@/theme';
import { formatAmountLive } from '@/utils/format';
import { d, Decimal } from '@/utils/money';

/** نقطة الارتجاز — لا-op على الويب (تُوصل expo-haptics لاحقاً) */
export function tapHaptic(): void {
  /* جاهزة للوص */
}

export type NumberPadProps = {
  /** القيمة الخام (نص عشري مثل '1234.5') */
  value: string;
  onChange: (v: string) => void;
  /** زر «تم» — يظهر فقط عند تمريره */
  onDone?: () => void;
  /** السماح بالفاصل العشري — افتراضي true */
  allowDecimal?: boolean;
  /** عدد المنازل العشرية المسموحة (من العملة: YER=0 يخفي الفاصل) — افتراضي 2 */
  decimals?: number;
  /** سطر تسمية فوق العرض */
  label?: string;
  /** سياق PIN: يحجب العرض بنقاط ● بدل الأرقام (لا تجميع آلاف) */
  secure?: boolean;
  /** يخفي صندوق العرض كاملاً (الأب يعرض مؤشره الخاص — نقاط الدخول مثلاً) */
  hideDisplay?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const MAX_INT_DIGITS = 12;

export default function NumberPad({
  value,
  onChange,
  onDone,
  allowDecimal = true,
  decimals = 2,
  label,
  secure = false,
  hideDisplay = false,
  style,
  testID,
}: NumberPadProps) {
  const allowDot = allowDecimal && decimals > 0;
  const raw = value === '' ? '0' : value;
  // في السياق السري: نقاط ● بعدد الخانات الصحيحة (بلا فاصل ولا تجميع)
  const display = secure
    ? '●'.repeat(Math.max(raw.replace(/[^0-9]/g, '').length, 0)) || '٠'
    : formatAmountLive(raw);

  const pressDigit = (n: number) => {
    tapHaptic();
    let v = value;
    if (v === '0') v = '';
    const dotAt = v.indexOf('.');
    if (dotAt >= 0) {
      if (v.length - dotAt - 1 >= decimals) return; // اكتفينا منازل الكسر
    } else if (v.replace('-', '').length >= MAX_INT_DIGITS) {
      return; // اكتفينا خانات الصحيح
    }
    const next = `${v}${n}`;
    onChange(next === '' ? '0' : next);
  };

  const pressDot = () => {
    tapHaptic();
    if (!allowDot) return;
    if (value.includes('.')) return;
    onChange(value === '' ? '0.' : `${value}.`);
  };

  const pressBackspace = () => {
    tapHaptic();
    if (value.length <= 1) {
      onChange('0');
      return;
    }
    onChange(value.slice(0, -1));
  };

  const pressClear = () => {
    tapHaptic();
    onChange('0');
  };

  // شبكة الأرقام — صفوف ثلاثية (تنعكس تلقائياً في RTL: 1 في أقصى اليمين)
  type PadKey =
    | { kind: 'digit'; n: number }
    | { kind: 'dot' }
    | { kind: 'backspace' }
    | { kind: 'skip' };
  const keys: PadKey[] = [
    { kind: 'digit', n: 1 },
    { kind: 'digit', n: 2 },
    { kind: 'digit', n: 3 },
    { kind: 'digit', n: 4 },
    { kind: 'digit', n: 5 },
    { kind: 'digit', n: 6 },
    { kind: 'digit', n: 7 },
    { kind: 'digit', n: 8 },
    { kind: 'digit', n: 9 },
    allowDot ? { kind: 'dot' } : { kind: 'skip' },
    { kind: 'digit', n: 0 },
    { kind: 'backspace' },
  ];

  return (
    <View style={[styles.pad, style]} testID={testID}>
      {hideDisplay ? null : (
        <View style={styles.displayWrap}>
          {label ? <Text style={styles.displayLabel}>{label}</Text> : null}
          <Text
            style={secure ? [styles.display, styles.displaySecure] : styles.display}
            selectable={false}
            adjustsFontSizeToFit
            numberOfLines={1}
          >
            {display}
          </Text>
        </View>
      )}
      <View style={styles.grid}>
        {keys.map((k, i) => {
          if (k.kind === 'skip') return <View key={`skip-${i}`} style={styles.keySpace} />;
          if (k.kind === 'digit') {
            return (
              <Pressable
                key={`d-${k.n}`}
                accessibilityLabel={String(k.n)}
                onPress={() => pressDigit(k.n)}
                style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
              >
                <Text style={styles.keyDigit}>{k.n}</Text>
              </Pressable>
            );
          }
          if (k.kind === 'dot') {
            return (
              <Pressable
                key="dot"
                accessibilityLabel={ar.components.numberPad.decimalSeparator}
                onPress={pressDot}
                style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
              >
                <Text style={styles.keyDigit}>.</Text>
              </Pressable>
            );
          }
          return (
            <Pressable
              key="back"
              accessibilityLabel={ar.components.numberPad.backspace}
              onLongPress={pressClear}
              delayLongPress={550}
              onPress={pressBackspace}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            >
              <Delete size={24} color={colors.danger} />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.footerRow}>
        <Pressable
          accessibilityLabel={ar.components.numberPad.clear}
          onPress={pressClear}
          style={({ pressed }) => [styles.auxBtn, pressed && styles.keyPressed]}
        >
          <Text style={styles.auxText}>{ar.components.numberPad.clear}</Text>
        </Pressable>
        {onDone ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.components.numberPad.done}
            onPress={onDone}
            style={({ pressed }) => [styles.doneBtn, pressed && styles.donePressed]}
          >
            <Text style={styles.doneText}>{ar.components.numberPad.done}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** تحويل قيمة خام إلى قيمة خام مكافئة بعد جمع سريع (تستخدمها الفئات السريعة) */
export function addToRawValue(current: string, add: string, decimals = 2): string {
  const sum = d(current || '0').plus(d(add || '0'));
  return sum.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
}

const styles = StyleSheet.create({
  pad: {
    gap: 10,
  },
  displayWrap: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 2,
  },
  displayLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  display: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 28,
    lineHeight: 38,
    textAlign: 'right',
  },
  displaySecure: {
    fontFamily: font.regular,
    fontSize: 26,
    letterSpacing: 10,
    textAlign: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  key: {
    width: '31.5%',
    flexGrow: 1,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: {
    backgroundColor: '#24334A',
    borderColor: colors.accent,
  },
  keyDigit: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 22,
    lineHeight: 30,
  },
  keySpace: {
    width: '31.5%',
    flexGrow: 1,
    height: 56,
  },
  footerRow: {
    flexDirection: 'row',
    gap: 8,
  },
  auxBtn: {
    flexGrow: 1,
    minHeight: touch.min,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  auxText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  doneBtn: {
    flexGrow: 2,
    minHeight: touch.min,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  donePressed: {
    opacity: 0.82,
  },
  doneText: {
    color: colors.onAccent,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
});
