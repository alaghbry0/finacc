/**
 * print.ts (متجر الحالة) — معاينة الطباعة على الويب (zustand).
 *
 * printInvoice على الويب لا تفتح نافذة نظام — بل ترفع مستند HTML إلى هذا
 * المتجر، والجذر يرسم <PrintPreviewModal/> فوق كل شيء (ورقة بيضاء داخل
 * iframe srcDoc + زر طباعة يستدعي print() على نافذة الـ iframe نفسها،
 * فيطبع المستند وحده لا التطبيق كله).
 *
 * الأصلي (Android/iOS) لا يمر من هنا إطلاقاً — print-platform.ts يستدعي
 * expo-print.printAsync (حوار طباعة النظام — يعمل مع طابعات البلوتوث/الشبكة
 * المضبوطة في أندرويد).
 */
import { create } from 'zustand';

export interface PrintPreviewState {
  /** مستند الفاتورة الكامل (HTML مستقل) — null عند الإغلاق */
  html: string | null;
  /** عنوان نافذة المعاينة (رقم الفاتورة عادة) */
  title: string;
  visible: boolean;

  open: (html: string, title: string) => void;
  close: () => void;
}

export const usePrintPreview = create<PrintPreviewState>((set) => ({
  html: null,
  title: '',
  visible: false,
  open: (html, title) => set({ html, title, visible: true }),
  close: () => set({ visible: false, html: null, title: '' }),
}));
