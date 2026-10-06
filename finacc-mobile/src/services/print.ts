/**
 * print.ts — خدمة الطباعة الحقيقية (المهمة 7 — تحل محل الكعب؛ المهمة 10
 * أضافت سندات القبض/الصرف المطبوعة عبر voucher-data + buildVoucherHtml؛
 * المهمة 11 أضافت كشف حساب الطرف عبر statement-data + buildStatementHtml؛
 * المهمة 13 أضافت تقرير الأرباح والخسائر عبر report-data + buildPnlHtml).
 *
 * التدفق: تحميل بيانات المستند من القاعدة (invoice-data / voucher-data) →
 * بناء مستند HTML العربي RTL الكامل (invoice-html) → تسليمه للمنصة:
 *  - الويب: معاينة داخل التطبيق (PrintPreviewModal عبر متجر الحالة) ثم
 *    طباعة الـ iframe وحده.
 *  - الأصلي: expo-print.printAsync({ html }) — حوار طباعة أندرويد
 *    (يعمل مع طابعات البلوتوث/الشبكة المضبوطة في النظام).
 *
 * التوقيع ملزم من المهمة 6-b: (adapter, invoiceId) → PrintResult —
 * المستدعون (تفاصيل الفاتورة، تدفق «اطبع بعد الحفظ؟») بلا تعديل.
 *
 * مؤجّلات موثقة (V1.1+): QR (FR-10-01)، الرستر ESC/POS عبر BLE
 * (SRS 3.5-1 — يتطلب Dev/EAS Build)، PDF ملف مرفق (expo-sharing + كتابة ملف).
 */
import type { SqliteAdapter } from '@/db/adapter';
import type { PartyType } from '@/domain/statement';
import { ar } from '@/i18n/ar';
import { domainErrorMessage } from '@/utils/validation';
import { loadInvoicePrintData } from './invoice-data';
import { buildInvoiceHtml, buildVoucherHtml } from './invoice-html';
import { loadVoucherPrintData } from './voucher-data';
import { loadStatementPrintData } from './statement-data';
import { buildStatementHtml } from './statement-html';
import { loadPnlPrintData } from './report-data';
import { buildPnlHtml } from './report-html';
import { deliverPrint } from './print-platform';

export interface PrintResult {
  ok: boolean;
  /** رسالة جاهزة للعرض (FeedbackBar) — نجاح أو عربية ودّية عند !ok */
  message: string;
}

/**
 * طباعة فاتورة (أي نوع مستند — حتى الملغاة للأرشيف بعلامتها المائية).
 * لا يرمي أبداً — كل فشل يعود ok:false برسالة عربية.
 */
export async function printInvoice(
  adapter: SqliteAdapter,
  invoiceId: number,
): Promise<PrintResult> {
  try {
    const data = await loadInvoicePrintData(adapter, invoiceId);
    const html = buildInvoiceHtml(data);
    const title = data.invoiceNo ?? '';
    await deliverPrint(html, title);
    return { ok: true, message: ar.sales.print.sent };
  } catch (err) {
    // أخطاء الدومين (مثل «فاتورة غير موجودة») تُعرض برسالتها الأصلية
    return { ok: false, message: domainErrorMessage(err) ?? ar.sales.print.failed };
  }
}

/**
 * طباعة سند قبض/صرف مرقّم (FR-04-10) — نفس نمط printInvoice:
 * التحميل (مع استهلاك الرقم RVT-/PMT- عند أول طباعة عبر ensureVoucherNo)
 * → بناء ورقة السند (320px حراري) → تسليم المنصة (ويب: معاينة؛ أصلي: نظام).
 * لا يرمي أبداً — كل فشل يعود ok:false برسالة عربية.
 */
export async function printVoucher(
  adapter: SqliteAdapter,
  cashTxId: number,
  opts: { createdBy?: number } = {},
): Promise<PrintResult> {
  try {
    const data = await loadVoucherPrintData(adapter, cashTxId, opts);
    const html = buildVoucherHtml(data);
    await deliverPrint(html, data.voucherNo);
    return { ok: true, message: ar.sales.print.sent };
  } catch (err) {
    return { ok: false, message: domainErrorMessage(err) ?? ar.cash.detail.printFailed };
  }
}

/**
 * طباعة كشف حساب طرف (FR-03-04) — نفس نمط printVoucher:
 * التحميل (سطور الدومين بعملة الكشف وفترتها) → بناء ورقة الكشف (420px)
 * → تسليم المنصة (ويب: معاينة؛ أصلي: نظام).
 * لا يرمي أبداً — كل فشل يعود ok:false برسالة عربية.
 */
export async function printStatement(
  adapter: SqliteAdapter,
  partyType: PartyType,
  partyId: number,
  currencyId: number,
  opts: { from?: string; to?: string } = {},
): Promise<PrintResult> {
  try {
    const data = await loadStatementPrintData(
      adapter,
      partyType,
      partyId,
      currencyId,
      opts,
    );
    const html = buildStatementHtml(data);
    await deliverPrint(html, `${data.partyName} — ${data.currency.code}`);
    return { ok: true, message: ar.statement.printSent };
  } catch (err) {
    return { ok: false, message: domainErrorMessage(err) ?? ar.statement.printFailed };
  }
}

/**
 * طباعة تقرير الأرباح والخسائر (FR-09-02/10) — نفس نمط printStatement:
 * التحميل (قائمة الدومين المشتقة حصراً من خريطة الترحيل لفترة [from, to]) →
 * بناء ورقة التقرير (420px RTL) → تسليم المنصة (ويب: معاينة؛ أصلي: نظام).
 * لا يرمي أبداً — كل فشل يعود ok:false برسالة عربية.
 */
export async function printPnl(
  adapter: SqliteAdapter,
  opts: { from: string; to: string },
): Promise<PrintResult> {
  try {
    const data = await loadPnlPrintData(adapter, opts);
    const html = buildPnlHtml(data);
    await deliverPrint(html, data.period.text);
    return { ok: true, message: ar.reports.printSent };
  } catch (err) {
    return { ok: false, message: domainErrorMessage(err) ?? ar.reports.printFailed };
  }
}
