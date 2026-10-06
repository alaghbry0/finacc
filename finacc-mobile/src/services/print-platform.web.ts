/**
 * print-platform.web.ts — تسليم الطباعة على الويب (معاينة داخل التطبيق).
 *
 * لا نافذة نظام على الويب: نرفع المستند إلى متجر المعاينة (zustand)
 * والجذر يرسم <PrintPreviewModal/> — ورقة بيضاء داخل iframe srcDoc وزر
 * «طباعة» يستدعي iframe.contentWindow.print() فيطبع مستند الفاتورة
 * وحده (لا واجهة التطبيق). window.print() من الصفحة الأم كان سيطبع
 * قشرة الهاتف كلها — لهذا iframe مستند مستقل.
 */
import { usePrintPreview } from '@/store/print';

/** يفتح نافذة معاينة الطباعة فوق كل شيء — يرجع فوراً (بلا انتظار المستخدم) */
export async function deliverPrint(html: string, title: string): Promise<void> {
  usePrintPreview.getState().open(html, title);
}
