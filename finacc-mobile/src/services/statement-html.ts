/**
 * statement-html.ts — قالب كشف الحساب المطبوع (نقي — بلا أي استيراد React Native).
 *
 * الدور: يبني مستند HTML كاملاً مستقلاً (RTL، lang=ar، CSS مضمّن) لكشف حساب
 * عميل/مورد عربي جاهز للطباعة الورقية (FR-03-04). المستند «ورقة بيضاء»
 * بحكم القانون البصري: حبر أسود على أبيض (نفس أساس الفاتورة — عرض 420px).
 *
 * البنية: رأس المنشأة + عنوان «كشف حساب عميل/مورد» + ميتا (الطرف/الفترة/
 * العملة) + سطر الملخص (رصيد أول المدة · عدد الحركات · الرصيد الختامي) +
 * جدول (التاريخ/البيان/المستند/المبلغ/الرصيد) بسطور zebra وصف ختامي مميز +
 * تذييل القرار 8: «الكشف بعملة واحدة ويتوازن دائماً — فرق الصرف يُعرض بنداً
 * مستقلاً في الأرباح» (FR-08-10) + طابع «وُلِّدت».
 *
 * الاتجاهات: مدين (+ يزيد رصيد الطرف) يظهر بإشارة «+» ودائن (− ينقصه)
 * بإشارة «−» — علامة غير لونية إلزامية (DS-18) لأن الطباعة أبيض/أسود.
 * سطر الإرشاد (note) يظهر كصف مميز بلا مبلغ.
 *
 * نقاوة الوحدة شرط اختبارها بـ bun — لذا: استيرادات نسبية فقط ولا RN.
 */
import { ar } from '../i18n/ar';
import { d } from '../utils/money';
import { formatAmount, formatDateAr, formatTimeAr } from '../utils/format';
import type { StatementLine } from '../domain/statement';
import type { StatementPrintData } from './statement-data';

/* ============ مساعدات عرض ============ */

const MONTHS_AR = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
] as const;

/**
 * تاريخ قصير لسطور الكشف: «08 أكتوبر» (بلا سنة — السنة في رأس الورقة
 * عند «وُلِّدت» وفي نص الفترة). «0000-00-00» (افتتاحي بلا تاريخ) → «—».
 */
export function statementShortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? '').trim());
  if (!m) return iso ?? '';
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return '—';
  return `${m[3]} ${MONTHS_AR[mo - 1]}`;
}

/** تسمية نوع السطر كما تُطبع — من قاموس i18n */
function docKindLabel(kind: StatementLine['docKind']): string {
  return ar.statement.docLabels[kind] ?? kind;
}

/* ============ القالب ============ */

/** يبني مستند كشف الحساب كاملاً — نقية، حتمية، بلا آثار جانبية */
export function buildStatementHtml(data: StatementPrintData): string {
  const p = ar.statement.paper;
  const dec = data.currency.decimals >= 0 ? data.currency.decimals : 2;
  const isCustomer = data.partyType === 'customer';
  const title = isCustomer ? p.titleCustomer : p.titleSupplier;

  const companyMeta = data.company.phone
    ? `${esc(ar.sales.print.tpl.phone)}: ${esc(data.company.phone)}`
    : null;

  const generatedDate = formatDateAr(data.generatedAt);
  const generatedTime = formatTimeAr(data.generatedAt);

  /** المبلغ بإشارة الاتجاه: مدين «+» / دائن «−» / إرشاد «—» */
  const signedAmount = (line: StatementLine): string => {
    if (line.direction === 'none') return '—';
    const neg = line.direction === 'credit';
    const formatted = formatAmount(line.amount, dec);
    return neg && !formatted.startsWith('-') ? `-${formatted}` : `+${formatted}`;
  };

  const rows = data.lines
    .map((line) => {
      const isNote = line.direction === 'none';
      const balanceCell =
        isNote ? '—' : formatAmount(line.runningBalance, dec);
      return `<tr${isNote ? ' class="note-row"' : ''}>
  <td class="num">${esc(line.date && line.date !== '0000-00-00' ? statementShortDate(line.date) : '—')}</td>
  <td class="desc-cell">${esc(line.description)}</td>
  <td class="doc-cell">${line.docNo ? esc(line.docNo) : esc(docKindLabel(line.docKind))}</td>
  <td class="num${isNote ? '' : line.direction === 'debit' ? ' dr' : ' cr'}">${isNote ? '—' : esc(signedAmount(line))}</td>
  <td class="num strong">${esc(balanceCell)}</td>
</tr>`;
    })
    .join('\n');

  // الملخص: رصيد أول المدة · عدد الحركات · الرصيد الختامي
  const moves = String(data.lineCount);

  const closingLabel = isCustomer ? ar.statement.customerDebit : ar.statement.supplierDebit;
  const closingVal = d(data.closingBalance);
  const closingSign = closingVal.lt(0) ? '−' : '';
  const closingText = `${closingSign}${formatAmount(closingVal.abs().toString(), dec)}`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${esc(data.partyName)}</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #111827;
    font-family: 'Segoe UI', 'Noto Kufi Arabic', 'Tajawal', 'Noto Sans Arabic', sans-serif;
    font-size: 13px;
    line-height: 1.55;
  }
  .page {
    width: 420px;
    max-width: 100%;
    margin: 0 auto;
    padding: 18px 16px 14px;
    position: relative;
    overflow: hidden;
  }
  header.co {
    text-align: center;
    padding-bottom: 8px;
    border-bottom: 2px solid #111827;
  }
  .co-name {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.5px;
  }
  .co-meta {
    margin-top: 2px;
    font-size: 11.5px;
    color: #4b5563;
  }
  .doc-title {
    margin: 12px auto 10px;
    width: 62%;
    text-align: center;
    font-size: 17px;
    font-weight: 800;
    border: 2px solid #111827;
    border-radius: 6px;
    padding: 5px 8px;
    letter-spacing: 1px;
  }
  .meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px 14px;
    font-size: 12.5px;
    margin-bottom: 10px;
  }
  .meta .m-full { grid-column: 1 / -1; }
  .m-label { font-weight: 700; color: #374151; margin-inline-end: 4px; }
  .m-val { color: #111827; }
  .summary {
    display: flex;
    align-items: stretch;
    margin-bottom: 10px;
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 6px 10px;
  }
  .s-cell {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 11px;
    color: #4b5563;
    text-align: center;
  }
  .s-val {
    font-size: 13.5px;
    font-weight: 700;
    color: #111827;
    font-variant-numeric: tabular-nums;
  }
  .s-sep { width: 1px; background: #ddd; margin-inline-start: 8px; margin-inline-end: 8px; }
  .grand {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
    padding: 8px 10px;
    border: 2px solid #111827;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 800;
  }
  .grand .num { font-size: 17px; font-variant-numeric: tabular-nums; }
  table.lines {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  table.lines th {
    background: #f3f4f6;
    border: 1px solid #ddd;
    padding: 5px 4px;
    font-weight: 700;
    color: #374151;
    text-align: center;
  }
  table.lines td {
    border: 1px solid #ddd;
    padding: 4px 4px;
    vertical-align: top;
  }
  table.lines tbody tr:nth-child(even) td { background: #f9fafb; }
  tr.note-row td { background: #fefce8 !important; color: #6b7280; font-style: italic; }
  td.num, th.num { text-align: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.dr { font-weight: 700; }
  td.cr { color: #374151; }
  td.strong { font-weight: 700; }
  .desc-cell { color: #111827; }
  .doc-cell {
    font-family: 'IBM Plex Sans Arabic', 'Courier New', monospace;
    font-weight: 700;
    color: #374151;
    white-space: nowrap;
    text-align: center;
  }
  .fx-note {
    margin-top: 10px;
    font-size: 11px;
    color: #4b5563;
    border: 1px dashed #d1d5db;
    border-radius: 6px;
    padding: 5px 8px;
    text-align: center;
  }
  footer {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid #ddd;
    text-align: center;
    font-size: 11.5px;
    color: #4b5563;
  }
  .f-thanks { font-weight: 700; color: #111827; margin-bottom: 2px; }
  .f-gen { font-variant-numeric: tabular-nums; }
  @media print {
    @page { margin: 8mm; }
    html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { width: auto; }
    table.lines tr, .summary, .grand, .fx-note { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="co">
    <div class="co-name">${esc(data.company.name)}</div>
    ${companyMeta ? `<div class="co-meta">${companyMeta}</div>` : ''}
  </header>
  <div class="doc-title">${esc(title)}</div>
  <section class="meta">
    <div class="m-full"><span class="m-label">${esc(data.partyLabel)}:</span> <span class="m-val strong">${esc(data.partyName)}${data.partyPhone ? ` (${esc(data.partyPhone)})` : ''}</span></div>
    <div><span class="m-label">${esc(p.period)}:</span> <span class="m-val">${esc(data.period.text)}</span></div>
    <div><span class="m-label">${esc(ar.sales.print.tpl.currency)}:</span> <span class="m-val">${esc(data.currency.code)}</span></div>
  </section>
  <div class="summary">
    <div class="s-cell"><span>${esc(p.opening)}</span><span class="s-val">${esc(formatAmount(data.openingBalance, dec))}</span></div>
    <div class="s-sep"></div>
    <div class="s-cell"><span>${esc(p.movements)}</span><span class="s-val">${esc(moves)} ${esc(p.movementsUnit)}</span></div>
    <div class="s-sep"></div>
    <div class="s-cell"><span>${esc(p.closing)}</span><span class="s-val">${esc(closingText)}</span></div>
  </div>
  <table class="lines">
    <thead>
      <tr>
        <th class="num" style="width:64px">${esc(p.date)}</th>
        <th>${esc(p.desc)}</th>
        <th class="num" style="width:88px">${esc(p.doc)}</th>
        <th class="num" style="width:70px">${esc(p.amount)}</th>
        <th class="num" style="width:76px">${esc(p.balance)}</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <div class="grand">
    <span>${esc(p.closing)} (${esc(closingLabel)})</span>
    <span class="num">${esc(closingText)} ${esc(data.currency.code)}</span>
  </div>
  <div class="fx-note">${esc(p.fxNote)}</div>
  <footer>
    <div class="f-thanks">${esc(data.company.footerText)}</div>
    <div class="f-gen">${esc(generatedDate)}${generatedTime ? ` · ${esc(generatedTime)}` : ''}</div>
    <div>${esc(p.printedBy)}</div>
  </footer>
</div>
</body>
</html>`;
}

/* ============ مساعدات داخلية ============ */

/** تهريب HTML لكل مدخلات المستخدم (أسماء/بيانات/أرقام) — القالب لا يثق بأحد */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
