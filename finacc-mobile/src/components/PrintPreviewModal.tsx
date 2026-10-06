/**
 * PrintPreviewModal — معاينة الطباعة (الويب) — نافذة جذرية فوق كل شيء.
 *
 * يستمع لمتجر المعاينة (store/print): عند open() يعرض مستند الفاتورة
 * (HTML مستقل) داخل iframe srcDoc كمَلَفّة ورقية بيضاء بظل — «هذه هي
 * الورقة كما ستخرج من الطابعة». زر «طباعة» يستدعي print() على نافذة
 * الـ iframe نفسها فيطبع المستند وحده (لا قشرة التطبيق)، و«إغلاق» يُرجع
 * المستخدم حيث كان.
 *
 * حصري للويب: على الأصلي (expo-print حوار النظام) لا يُستعمل إطلاقاً —
 * يُرجع null مبكراً حتى لا يدخل عنصر iframe (خاص بالويب) مسار الرسم.
 */
import { useRef, type CSSProperties } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Printer, X } from 'lucide-react-native';
import { usePrintPreview } from '@/store/print';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import PrimaryButton from '@/components/ui/PrimaryButton';

/** عرض الورقة — نفس عرض قالب invoice-html.ts (A5- تقريبي) */
const PAPER_WIDTH = 420;

export default function PrintPreviewModal() {
  const visible = usePrintPreview((s) => s.visible);
  const html = usePrintPreview((s) => s.html);
  const title = usePrintPreview((s) => s.title);
  const close = usePrintPreview((s) => s.close);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const { width: winW } = useWindowDimensions();

  if (Platform.OS !== 'web') return null; // الأصلي: حوار طباعة النظام مباشرة
  if (!visible || html === null) return null;

  /** الورقة تتقلص للشاشات الضيقة (القالب سائل داخل 420) — بلا قصّ */
  const paperWidth = Math.min(PAPER_WIDTH, Math.max(winW - 24, 240));

  const onPrint = () => {
    try {
      const win = frameRef.current?.contentWindow;
      win?.focus();
      win?.print();
    } catch {
      // طباعة المتصفح مرفوضة/غير متاحة — أثر جانبي بلا انهيار
    }
  };

  return (
    <Modal transparent={false} visible animationType="fade" onRequestClose={close} testID="print-preview-modal">
      <View style={styles.root}>
        {/* الرأس */}
        <View style={styles.header}>
          <View style={styles.headerTexts}>
            <Text style={styles.headerTitle}>{ar.sales.print.previewTitle}</Text>
            <Text style={styles.headerSub} numberOfLines={1}>
              {title !== '' ? title : ar.sales.print.previewPaperHint}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ar.common.close}
            onPress={close}
            hitSlop={6}
            style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
            testID="print-preview-close-x"
          >
            <X size={22} color={colors.textMuted} />
          </Pressable>
        </View>

        {/* الورقة */}
        <View style={styles.paperWrap}>
          <View style={[styles.paper, { width: paperWidth }]}>
            <iframe
              ref={frameRef}
              title={ar.sales.print.previewTitle}
              srcDoc={html}
              style={paperFrameStyle}
            />
          </View>
        </View>

        {/* الأزرار */}
        <View style={styles.footer}>
          <PrimaryButton
            label={ar.sales.print.button}
            icon={Printer}
            tone="primary"
            onPress={onPrint}
            style={styles.btn}
            testID="print-preview-print"
          />
          <PrimaryButton
            label={ar.common.close}
            tone="ghost"
            onPress={close}
            style={styles.btn}
            testID="print-preview-close"
          />
        </View>
      </View>
    </Modal>
  );
}

/** نمط iframe خام (CSS DOM) — خارج StyleSheet لأنه ليس نمط RN */
const paperFrameStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  border: 'none',
  display: 'block',
  backgroundColor: '#FFFFFF',
  borderTopLeftRadius: 8,
  borderTopRightRadius: 8,
  borderBottomLeftRadius: 8,
  borderBottomRightRadius: 8,
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  headerTexts: {
    flex: 1,
    gap: 1,
  },
  headerTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 20,
    lineHeight: 28,
  },
  headerSub: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  closeBtn: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  pressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
  paperWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  paper: {
    height: '92%',
    backgroundColor: '#FFFFFF',
    borderRadius: radius.sm,
    shadowColor: '#000000',
    shadowOpacity: 0.55,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 4 },
    elevation: 16,
    overflow: 'hidden',
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  btn: {
    flex: 1,
  },
});
