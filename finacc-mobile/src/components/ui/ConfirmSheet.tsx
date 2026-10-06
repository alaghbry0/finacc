/**
 * ConfirmSheet (DS-27) — تأكيد العمليات الخطرة:
 *  - زر إجراء أحمر (أو سماوي) + **كلمة تأكيد مطبوعة حرفياً** لكل عملية
 *    («إلغاء» للفاتورة، «استعادة» للنسخة…) — الزر يظل معطلاً حتى تطابق الكلمة.
 *  - خانة الكتابة تقبل اللصق القياسي؛ زر «لصق» إضافي على الويب
 *    (navigator.clipboard) — على المنصات الأصلية يختبئ (لا اعتماديات جديدة).
 */
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ClipboardPaste, TriangleAlert } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import BottomSheet from './BottomSheet';
import PrimaryButton from './PrimaryButton';

export type ConfirmSheetProps = {
  visible: boolean;
  title: string;
  /** الشرح بكلمات المستخدم (ماذا سيحدث + هل يمكن التراجع) */
  message?: string;
  /** كلمة التأكيد المطلوب كتابتها حرفياً — حذفها يجعل الزر مفعّلاً مباشرة */
  confirmWord?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** زر الإجراء أحمر (خطر) — افتراضي true */
  danger?: boolean;
  testID?: string;
};

async function readClipboard(): Promise<string | null> {
  if (Platform.OS !== 'web') return null;
  try {
    const nav = navigator as Navigator & { clipboard?: { readText(): Promise<string> } };
    if (!nav.clipboard?.readText) return null;
    return await nav.clipboard.readText();
  } catch {
    return null;
  }
}

export default function ConfirmSheet({
  visible,
  title,
  message,
  confirmWord,
  onConfirm,
  onCancel,
  danger = true,
  testID,
}: ConfirmSheetProps) {
  const [typed, setTyped] = useState('');
  const word = confirmWord?.trim() ?? null;
  const matched = word === null || typed.trim() === word;
  const prompt = word
    ? ar.components.confirmSheet.typePrompt.replace('{word}', word)
    : null;

  useEffect(() => {
    if (visible) setTyped('');
  }, [visible]);

  return (
    <BottomSheet visible={visible} onClose={onCancel} testID={testID}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
        <View style={styles.iconRow}>
          <View
            style={[styles.iconWrap, danger ? styles.iconDanger : styles.iconPrimary]}
          >
            <TriangleAlert size={24} color={danger ? colors.danger : colors.accent} />
          </View>
        </View>
        <Text style={styles.title}>{title}</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
        {prompt ? (
          <View style={styles.inputBox}>
            <Text style={styles.prompt}>{prompt}</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={typed}
                onChangeText={setTyped}
                placeholder={word ?? ''}
                placeholderTextColor={colors.textFaint}
                autoCorrect={false}
                accessibilityLabel={prompt}
                textAlign="right"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ar.common.paste}
                onPress={async () => {
                  const text = await readClipboard();
                  if (text !== null) setTyped(text.trim());
                }}
                style={({ pressed }) => [styles.pasteBtn, pressed && styles.pressed]}
                hitSlop={4}
              >
                <ClipboardPaste size={20} color={colors.accent} />
              </Pressable>
            </View>
          </View>
        ) : null}
        <PrimaryButton
          label={
            word ? ar.components.confirmSheet.confirm.replace('{word}', word) : ar.common.confirm
          }
          tone={danger ? 'danger' : 'primary'}
          disabled={!matched}
          onPress={onConfirm}
        />
        <PrimaryButton label={ar.common.cancel} tone="ghost" onPress={onCancel} />
      </KeyboardAvoidingView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing.md,
    paddingBottom: spacing.xs,
  },
  iconRow: {
    alignItems: 'center',
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconDanger: {
    backgroundColor: 'rgba(248, 113, 113, 0.12)',
  },
  iconPrimary: {
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
  },
  title: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 18,
    lineHeight: 26,
    textAlign: 'center',
  },
  message: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  inputBox: {
    gap: 8,
  },
  prompt: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
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
  },
  pasteBtn: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
  },
});
