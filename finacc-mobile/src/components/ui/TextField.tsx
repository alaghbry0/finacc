/**
 * TextField — خانة إدخال موحدة داكنة RTL (DS): تسمية + إدخال ارتفاع 48 +
 * خطأ تحقق أحمر أسفلها (caption). أساس كل الشاشات ذات إدخال نصي
 * (التهيئة/الأصناف/الأطراف لاحقاً) — TextInput خام منسَّق بلا Paper.
 *
 * FieldError: تسمية خطأ صغيرة حمراء تُستعمل أسفل أي خانة أو مجموعة.
 */
import { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { colors, font, radius } from '@/theme';

export type TextFieldProps = {
  /** التسمية فوق الخانة */
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  /** رسالة خطأ تحقق تُعرض بالأحمر أسفل الخانة وتُحمرّ حدودها */
  error?: string | null;
  /** تلميح صغير أسفل الخانة (بلا أحمر) */
  hint?: string | null;
  placeholder?: string;
  /** مثال لوحة المفاتيح: numeric/phone-pad/default */
  keyboardType?: TextInputProps['keyboardType'];
  maxLength?: number;
  autoFocus?: boolean;
  /** إخفاء النص (PIN/كلمات سر) */
  secureTextEntry?: boolean;
  /** إدخال متعدد الأسطر (الملاحظات) */
  multiline?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
} & Pick<TextInputProps, 'onSubmitEditing' | 'returnKeyType' | 'autoCapitalize'>;

export default function TextField({
  label,
  value,
  onChangeText,
  error,
  hint,
  placeholder,
  keyboardType = 'default',
  maxLength,
  autoFocus,
  secureTextEntry,
  multiline,
  testID,
  style,
  onSubmitEditing,
  returnKeyType,
  autoCapitalize,
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.wrap, style]} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[
          styles.input,
          multiline && styles.multiline,
          { borderColor: error ? colors.danger : focused ? colors.accent : colors.border },
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        keyboardType={keyboardType}
        maxLength={maxLength}
        autoFocus={autoFocus}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        textAlign="right"
        accessible
        accessibilityLabel={label}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        autoCapitalize={autoCapitalize}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        selectionColor={colors.accent}
        underlineColorAndroid="transparent"
      />
      {error ? <FieldError message={error} /> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

/** تسمية خطأ تحقق حمراء (DS-15 caption) — تصفّرها الواجهة عند إعادة المحاولة */
export function FieldError({ message }: { message?: string | null }) {
  if (!message) return null;
  return <Text style={styles.error}>{message}</Text>;
}

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
  },
  label: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'right',
  },
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
    paddingHorizontal: 14,
    textAlign: 'right',
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
    paddingTop: 12,
  },
  error: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
  hint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'right',
  },
});
