/**
 * StatTile (DS-19) — بلاطة إحصائية: عنوان صغير + رقم كبير (IBM Plex + tabular-nums)
 * + وحدة + سهم نسبة تغيّر اختياري بدلالة موقّتة (صعود/هبوط).
 * القيمة نص عشري يُنسَّق عبر AmountText — لا Float أبداً.
 */
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { TrendingDown, TrendingUp } from 'lucide-react-native';
import AmountText from '@/components/ui/AmountText';
import { colors, font, radius, spacing, type AmountTone } from '@/theme';
import { formatCount } from '@/utils/format';

export type StatTileProps = {
  /** التسمية العربية للمؤشر */
  title: string;
  /** القيمة الرقمية (نص عشري أو عدد صحيح) */
  value: string;
  /** وحدة القياس (ر.ي / فاتورة…) */
  unit?: string;
  /** درجة الدلالة المحاسبية */
  tone?: AmountTone;
  /** منازل العرض (من العملة) */
  decimals?: number;
  /** سهم نسبة التغيّر مع نص النسبة (علامة غير لونية + النص نفسه) */
  trend?: { dir: 'up' | 'down'; label: string };
  onPress?: () => void;
  /** القيمة عدد عدّادات (فواتير اليوم) بدل مبلغ */
  isCount?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function StatTile({
  title,
  value,
  unit,
  tone = 'neutral',
  decimals = 2,
  trend,
  onPress,
  isCount = false,
  style,
  testID,
}: StatTileProps) {
  const TrendIcon = trend?.dir === 'up' ? TrendingUp : TrendingDown;
  const trendColor = trend?.dir === 'up' ? colors.success : colors.danger;

  const tile = (
    <View style={[styles.tile, style]}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.valueRow}>
        {isCount ? (
          <Text style={styles.valueText}>{formatCount(Number(value) || 0)}</Text>
        ) : (
          <AmountText value={value} tone={tone} size="xl" decimals={decimals} sign={tone === 'in' || tone === 'out' ? true : undefined} />
        )}
        {unit ? <Text style={styles.unit}>{unit}</Text> : null}
      </View>
      {trend ? (
        <View style={styles.trendRow}>
          <TrendIcon size={13} color={trendColor} />
          <Text style={[styles.trendText, { color: trendColor }]}>{trend.label}</Text>
        </View>
      ) : null}
    </View>
  );

  if (onPress) {
    return (
      <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={({ pressed }) => (pressed ? styles.pressed : null)}>
        {tile}
      </Pressable>
    );
  }
  return <View testID={testID}>{tile}</View>;
}

const styles = StyleSheet.create({
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: 6,
    minHeight: 96,
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.8,
  },
  title: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'right',
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: 6,
  },
  valueText: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 22,
    lineHeight: 30,
    textAlign: 'right',
  },
  unit: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  trendText: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
});
