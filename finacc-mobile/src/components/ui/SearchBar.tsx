/**
 * SearchBar (DS-21) — حقل بحث بأيقونة بحث بادئة + زر مسح باركود مدمج (onScan).
 * زر الباركود يُبنى الآن والكاميرا تُوصَل لاحقاً (المهمة القادمة) — الهدف ≥ 48×48.
 */
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { ScanBarcode, Search } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, touch } from '@/theme';

export type SearchBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  /** تفعيل زر المسح — يظهر فقط عند تمريره */
  onScan?: () => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
  editable?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function SearchBar({
  value,
  onChangeText,
  placeholder = ar.components.search.placeholder,
  onScan,
  onSubmit,
  autoFocus = false,
  editable = true,
  style,
  testID,
}: SearchBarProps) {
  return (
    <View style={[styles.bar, !editable && styles.disabled, style]} testID={testID}>
      <Search size={20} color={colors.textMuted} style={styles.searchIcon} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        onSubmitEditing={onSubmit}
        autoFocus={autoFocus}
        editable={editable}
        returnKeyType="search"
        accessibilityLabel={ar.common.search}
        textAlign="right"
      />
      {onScan ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ar.common.scanBarcode}
          onPress={onScan}
          style={({ pressed }) => [styles.scanBtn, pressed && styles.scanPressed]}
          hitSlop={4}
        >
          <ScanBarcode size={22} color={colors.accent} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 52,
    paddingHorizontal: 8,
    gap: 4,
  },
  disabled: {
    opacity: 0.6,
  },
  searchIcon: {
    marginHorizontal: 6,
  },
  input: {
    flex: 1,
    minHeight: 48,
    color: colors.text,
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    paddingVertical: 8,
  },
  scanBtn: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  scanPressed: {
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
  },
});
