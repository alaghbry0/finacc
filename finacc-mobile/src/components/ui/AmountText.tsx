/**
 * AmountText (DS-18 + DS-18n) — عرض مبلغ بخط IBM Plex Sans Arabic 600 مع
 * tabular-nums وفواصل آلاف، ودلالة لونية + **علامة غير لونية إلزامية** (سهم ↓/↑ أو +/−)
 * كلما كانت الدرجة in/out (قاعدة §6.1 — دالّة ألوان بلا علامة = خطأ).
 *
 * الأمثلة:
 *   <AmountText value="12500" tone="in" currency="YER" />      → «+ 12,500 ر.ي»
 *   <AmountText value="4500" tone="out" arrow="up" />          → «↑ 4,500.00»
 */
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { ArrowDown, ArrowUp } from 'lucide-react-native';
import { formatAmount, currencySymbol } from '@/utils/format';
import { font, type AmountTone, toneColor } from '@/theme';

export type AmountTextSize = 'micro' | 'sm' | 'md' | 'lg' | 'xl' | 'display';

export type AmountTextProps = {
  /** القيمة نصاً عشرياً (كما تُخزَّن في القاعدة) */
  value: string | number;
  /** درجة الدلالة المحاسبية */
  tone?: AmountTone;
  /** إضافة إشارة +/− أمام الرقم (تُفرَض تلقائياً لدرجات in/out بلا سهم) */
  sign?: boolean;
  /** علامة السهم غير اللونية — تُقلب تلقائياً كاتجاه محايد عمودي (↓ وارد / ↑ صادر) */
  arrow?: 'down' | 'up';
  /** حجم الخط */
  size?: AmountTextSize;
  /** رمز عملة يُلاحق الرقم (ر.ي / ر.س / $…) */
  currency?: string;
  /** عدد المنازل العشرية (من العملة: YER=0) */
  decimals?: number;
  /** عرض نصي إضافي */
  hint?: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
};

const SIZES: Record<AmountTextSize, { fontSize: number; lineHeight: number; icon: number }> = {
  micro: { fontSize: 12, lineHeight: 17, icon: 12 },
  sm: { fontSize: 13, lineHeight: 19, icon: 14 },
  md: { fontSize: 15, lineHeight: 22, icon: 16 },
  lg: { fontSize: 18, lineHeight: 26, icon: 18 },
  xl: { fontSize: 22, lineHeight: 30, icon: 20 },
  display: { fontSize: 28, lineHeight: 38, icon: 24 },
};

export default function AmountText({
  value,
  tone = 'neutral',
  sign,
  arrow,
  size = 'md',
  currency,
  decimals,
  hint,
  style,
  testID,
}: AmountTextProps) {
  const s = SIZES[size];
  const isDirectional = tone === 'in' || tone === 'out';
  // العلامة غير اللونية إلزامية لدرجات الاتجاه: سهم أو إشارة (قاعدة §6.1)
  const effectiveSign = sign ?? (isDirectional && !arrow ? true : false);
  const formatted = formatAmount(value, decimals ?? 2);
  const signChar =
    effectiveSign && isDirectional ? (tone === 'in' ? '+' : '-') : '';
  // القيمة المخزنة قد تكون سالبة أصلاً («-73») — سالب القيمة هو الحقيقة النهائية:
  //  • إشارة اتجاه «-» + قيمة سالبة → نُجرد سالب القيمة (لا «--73»).
  //  • إشارة اتجاه «+» + قيمة سالبة → سالب القيمة يغلب («-73» لا «+-73»).
  //  • بلا إشارة اتجاه → سالب القيمة يظهر كما خُزّن.
  let magnitude = formatted;
  let dirChar = signChar;
  if (formatted.startsWith('-')) {
    magnitude = formatted.slice(1);
    if (dirChar === '+') dirChar = '-';
  }
  const symbol = currencySymbol(currency);
  const text = `${dirChar}${magnitude}${symbol ? ` ${symbol}` : ''}${hint ? ` ${hint}` : ''}`;
  const color = toneColor(tone);

  return (
    <View style={styles.wrap} testID={testID}>
      {arrow ? (
        arrow === 'down' ? (
          <ArrowDown size={s.icon} color={color} style={styles.arrow} />
        ) : (
          <ArrowUp size={s.icon} color={color} style={styles.arrow} />
        )
      ) : null}
      <Text
        style={[
          styles.text,
          {
            color,
            fontSize: s.fontSize,
            lineHeight: s.lineHeight,
          },
          style,
        ]}
        numberOfLines={1}
        adjustsFontSizeToFit={false}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  arrow: {
    marginTop: 1,
  },
  text: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
});
