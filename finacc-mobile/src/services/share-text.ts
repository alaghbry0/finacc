/**
 * share-text.ts — بناء رسالة الواتساب ورابط wa.me (نقي — بلا React Native).
 *
 * FR-10-02 (نسخة V1 نصية): يُرسل ملخص الفاتورة نصاً عبر wa.me — المرفق
 * (PDF) مؤجل إلى مسار EAS الأصلي (يتطلب كتابة ملف + expo-sharing) — موثق
 * في سجل العمل.
 *
 * النقاوة لاختبار bun: استيرادات نسبية فقط، بلا RN.
 */
import { ar } from '../i18n/ar';
import { d } from '../utils/money';
import { currencySymbol, formatAmount, formatDateAr } from '../utils/format';
import type { InvoicePrintData } from './invoice-html';

/**
 * رسالة واتساب جاهزة: نوع المستند ورقمه والتاريخ والطرف والإجمالي والمتبقي
 * + تذييل المنشأة. نص عادي (WhatsApp لا يفهم HTML) — بأسلوب تجاري مباشر.
 */
export function buildWhatsAppMessage(data: InvoicePrintData): string {
  const title = ar.sales.print.docTitles[data.docType] ?? data.docType;
  const dec = data.currency.decimals >= 0 ? data.currency.decimals : 2;
  const symbol = currencySymbol(data.currency.code);
  const money = (v: string) => `${formatAmount(v, dec)}${symbol ? ` ${symbol}` : ''}`;

  const lines: string[] = [];
  lines.push(`${title} ${data.invoiceNo ?? '—'} — ${data.company.name}`);
  lines.push(`${ar.sales.print.tpl.date}: ${formatDateAr(data.issuedAt)}`);
  if (data.party) {
    lines.push(`${data.partyLabel}: ${data.party.name}`);
  }
  lines.push(`${ar.sales.totals.total}: ${money(data.totals.total)}`);
  if (d(data.totals.due).gt(0)) {
    lines.push(`${ar.sales.print.tpl.due}: ${money(data.totals.due)}`);
  }
  lines.push('');
  lines.push(data.company.footerText);
  return lines.join('\n');
}

/**
 * تطبيع رقم هاتف لصيغة wa.me (أرقام دولية بلا «+»):
 *  - «+9677xxxxxxx» → 9677xxxxxxx
 *  - «00967…» → 967…
 *  - «967…» → كما هو
 *  - «7xxxxxxxx» (جوال يمني 9 أرقام يبدأ بـ7) → 967 + الرقم
 *  - أي صيغة أخرى → أرقامه كما هي (wa.me يقرر)
 * يُرجع null للفراغ التام.
 */
export function waNumber(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-()·.]/g, '').trim();
  if (cleaned === '') return null;
  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1).replace(/\D/g, '');
    return digits !== '' ? digits : null;
  }
  const digits = cleaned.replace(/\D/g, '');
  if (digits === '') return null;
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('967')) return digits;
  if (/^7\d{8}$/.test(digits)) return `967${digits}`;
  return digits;
}

/** رابط wa.me الكامل مع الرسالة المُرمَّزة */
export function waLink(phone: string, message: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}
