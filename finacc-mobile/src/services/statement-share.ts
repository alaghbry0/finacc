/**
 * statement-share.ts — رسالة الواتساب لكشف الحساب (نقي — بلا React Native).
 *
 * FR-03-04 (نسخة V1 نصية): يُرسل ملخص الكشف نصاً عبر wa.me — العنوان والفترة
 * والعملة + رصيد أول المدة + آخر 10 سطور مختصرة + الرصيد الختامي + تذييل
 * اسم التطبيق. المرفق (PDF) مؤجل لمسار EAS الأصلي (موثق في سجل العمل).
 *
 * النقاوة لاختبار bun: استيرادات نسبية فقط، بلا RN.
 */
import { ar } from '../i18n/ar';
import { currencySymbol, formatAmount } from '../utils/format';
import { d } from '../utils/money';
import { statementShortDate } from './statement-html';
import type { StatementPrintData } from './statement-data';

/** أقصى عدد سطور تُرسم في الرسالة — الباقي «و{n} حركة أخرى…» */
const MAX_LINES = 10;

/**
 * رسالة واتساب جاهزة لكشف الحساب: عنوان بالطرف والمنشأة + الفترة والعملة +
 * رصيد أول المدة + آخر الحركات (10 كحد أقصى) بإشارة الاتجاه + الرصيد الختامي
 * + تذييل اسم التطبيق. نص عادي (WhatsApp لا يفهم HTML).
 */
export function buildStatementWhatsAppMessage(data: StatementPrintData): string {
  const s = ar.statement.shareText;
  const isCustomer = data.partyType === 'customer';
  const title = isCustomer ? s.titleCustomer : s.titleSupplier;
  const dec = data.currency.decimals >= 0 ? data.currency.decimals : 2;
  const symbol = currencySymbol(data.currency.code);
  const money = (v: string) => `${formatAmount(v, dec)}${symbol ? ` ${symbol}` : ''}`;

  const closingVal = d(data.closingBalance);
  const closingText = closingVal.isZero()
    ? s.balanced
    : `${money(closingVal.abs().toString())} ${
        isCustomer
          ? closingVal.gt(0)
            ? ar.statement.customerDebit
            : ar.statement.customerCredit
          : closingVal.gt(0)
            ? ar.statement.supplierDebit
            : ar.statement.supplierCredit
      }`;

  const lines: string[] = [];
  lines.push(`${title}: ${data.partyName} — ${data.company.name}`);
  lines.push(`${ar.statement.paper.period}: ${data.period.text}`);
  lines.push(`${ar.statement.paper.currency}: ${data.currency.code}`);
  lines.push('');
  lines.push(`${s.opening}: ${money(data.openingBalance)}`);

  const financial = data.lines.filter((l) => l.direction !== 'none');
  if (financial.length > 0) {
    lines.push(`${s.lastMoves}:`);
    const shown = financial.slice(-MAX_LINES);
    for (const line of shown) {
      const date =
        line.date && line.date !== '0000-00-00' ? statementShortDate(line.date) : '—';
      const sign = line.direction === 'debit' ? '+' : '-';
      const label =
        line.docNo ?? ar.statement.docLabels[line.docKind] ?? line.docKind;
      lines.push(`• ${date} — ${label}: ${sign}${formatAmount(line.amount, dec)}`);
    }
    const rest = financial.length - shown.length;
    if (rest > 0) {
      lines.push(s.more.replace('{n}', String(rest)));
    }
  }

  lines.push('');
  lines.push(`${s.closing}: ${closingText}`);
  lines.push('');
  lines.push(ar.app.name);
  return lines.join('\n');
}
