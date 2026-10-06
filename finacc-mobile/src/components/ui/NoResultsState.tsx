/**
 * NoResultsState (DS-35) — «لا توجد نتائج ضمن هذه المعايير» + زر مسح الفلاتر.
 * للبحث والفلاتر الفارغة (نتائج موجودة لكن مقيَّدة) — مختلف عن EmptyState (لا بيانات أصلاً).
 */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SearchX } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import PrimaryButton from './PrimaryButton';

export type NoResultsStateProps = {
  title?: string;
  message?: string;
  onClearFilters?: () => void;
  clearLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function NoResultsState({
  title = ar.components.noResults.title,
  message,
  onClearFilters,
  clearLabel = ar.components.noResults.clear,
  style,
  testID,
}: NoResultsStateProps) {
  return (
    <View style={[styles.wrap, style]} testID={testID}>
      <View style={styles.iconWrap}>
        <SearchX size={28} color={colors.textMuted} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {onClearFilters ? (
        <PrimaryButton label={clearLabel} tone="ghost" onPress={onClearFilters} style={styles.clear} />
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
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
  },
  message: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  clear: {
    alignSelf: 'center',
    marginTop: spacing.md,
    minWidth: 170,
  },
});
