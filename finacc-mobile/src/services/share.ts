/**
 * share.ts — مشاركة الفاتورة عبر واتساب (FR-10-02 — نسخة V1 نصية).
 *
 * V1 (المرصود هنا): رسالة نصية جاهزة (رقم الفاتورة/التاريخ/الطرف/الإجمالي/
 * المتبقي + تذييل المنشأة) تُفتح في محادثة العميل عبر رابط wa.me — يعمل
 * على الويب (Linking.openURL → window.open بتبويب جديد) والأصلي
 * (Linking.openURL → تطبيق واتساب إن كان مثبتاً).
 *
 * رقم الواتساب: يُفضَّل حقل whatsapp الخاص بالطرف ثم هاتفه، ويُطبَّع
 * للصيغة الدولية (waNumber) — لا رقم → رسالة «لا يوجد رقم واتساب».
 *
 * مؤجل إلى مسار EAS الأصلي (موثق): توليد PDF (expo-print printToFileAsync)
 * + كتابته للقرص + expo-sharing.shareAsync لإرفاقه — يتطلب كوداً أصلياً
 * وملفات مؤقتة خارج نطاق المعاينة الحالية (FR-10-02 كاملة).
 */
import { Linking } from 'react-native';
import type { SqliteAdapter } from '@/db/adapter';
import { ar } from '@/i18n/ar';
import { domainErrorMessage } from '@/utils/validation';
import { loadInvoicePrintData } from './invoice-data';
import { buildWhatsAppMessage, waLink, waNumber } from './share-text';
import type { PrintResult } from './print';

/**
 * مشاركة فاتورة: يفتح محادثة واتساب مع الطرف برسالة ملخص.
 * لا يرمي أبداً — ok:false برسالة عربية (لا رقم / تعذر فتح الرابط).
 */
export async function shareInvoice(
  adapter: SqliteAdapter,
  invoiceId: number,
): Promise<PrintResult> {
  try {
    const data = await loadInvoicePrintData(adapter, invoiceId);
    const rawPhone = data.party?.whatsapp ?? data.party?.phone ?? null;
    const phone = rawPhone !== null ? waNumber(rawPhone) : null;
    if (!phone) {
      return { ok: false, message: ar.sales.print.noWhatsapp };
    }
    const url = waLink(phone, buildWhatsAppMessage(data));
    await Linking.openURL(url);
    return { ok: true, message: ar.sales.print.shared };
  } catch (err) {
    return { ok: false, message: domainErrorMessage(err) ?? ar.sales.print.shareFailed };
  }
}
