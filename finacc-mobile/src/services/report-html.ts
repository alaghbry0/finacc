/**
 * report-html.ts — قالب تقرير الأرباح والخسائر المطبوع (نقي — بلا React Native).
 *
 * الدور: يبني مستند HTML كاملاً مستقلاً (RTL، lang=ar، CSS مضمّن) لتقرير
 * الأرباح والخسائر بالصيغة المصححة (قرار 7 / FR-09-02) جاهزاً للطباعة الورقية
 * (FR-09-10). المستند «ورقة بيضاء» بحكم القانون البصري: حبر أسود على أبيض
 * (نفس أساس الفاتورة والكشف — عرض 420px).
 *
 * البنية: رأس المنشأة + عنوان «تقرير الأرباح والخسائر» + ميتا (الفترة/عملة
 * الأساس) + مقاطع مجمعّة:
 *  - الإيرادات: المبيعات (+) / مرتجع المبيعات (−) / **صافي المبيعات**
 *  - تكلفة المبيعات: COGS / تكلفة المرتجع (−) / **صافي التكلفة**
 *  - تسويات الجرد: زيادة الجرد (+) / عجز الجرد (−)
 *  - المصاريف (−) · فروق الصرف المحققة (±)
 *  - **= الربح** (صندوق مُبرز)
 *  - مسحوبات المالك — **بند مستقل خارج المصاريف** (مقطع منفصل بتظليل خفيف
 *    ونص توثيقي صريح)
 *  - **= صافي ما بقي للمالك** (الصندوق الختامي الأبرز)
 * + إشارات +/− غير لونية إلزامية (DS-18 — الطباعة أحادية) + ملاحظة الصيغة
 * + تذييل «مشتق حصراً من خريطة الترحيل — ملحق و» + طابع «وُلِّدت».
 *
 * نقاوة الوحدة شرط اختبارها بـ bun — لذا: استيرادات نسبية فقط ولا RN.
 */
import { ar } from '../i18n/ar';
import { d } from '../utils/money';
import { formatAmount, formatDateAr, formatTimeAr } from '../utils/format';
import type { PnlPrintData } from './report-data';

/* ============ مساعدات عرض ============ */

/** مبلغ بإشارة الاتجاه: «+12,500» / «−115» / «0» بلا إشارة */
function signed(value: string, decimals: number): string {
  const v = d(value);
  if (v.isZero()) return formatAmount(value, decimals);
  const formatted = formatAmount(v.abs().toString(), decimals);
  return v.gt(0) ? `+${formatted}` : `−${formatted}`;
}

/** مبلغ بند خصم: «−115» دائماً (الصفر بلا إشارة) — للمرتجع/المصاريف/العجز/المسحوبات */
function negSigned(value: string, decimals: number): string {
  const v = d(value);
  if (v.isZero()) return formatAmount(value, decimals);
  return `−${formatAmount(v.abs().toString(), decimals)}`;
}

/** مبلغ مجرد بلا إشارة (المجاميع الفرعية والختامية) */
function plain(value: string, decimals: number): string {
  return formatAmount(d(value).abs().toString(), decimals);
}

/* ============ القالب ============ */

/** يبني مستند تقرير الأرباح كاملاً — نقية، حتمية، بلا آثار جانبية */
export function buildPnlHtml(data: PnlPrintData): string {
  const p = ar.reports.paper;
  const L = ar.reports.lines;
  const S = ar.reports.sections;
  const dec = data.currency.decimals >= 0 ? data.currency.decimals : 2;
  const pnl = data.pnl;

  const companyMeta = data.company.phone
    ? `${esc(ar.sales.print.tpl.phone)}: ${esc(data.company.phone)}`
    : null;

  const generatedDate = formatDateAr(data.generatedAt);
  const generatedTime = formatTimeAr(data.generatedAt);

  /** سطر بند داخل مقطع: التسمية يميناً والمبلغ بإشارته يساراً */
  const line = (label: string, value: string, cls = ''): string =>
    `<tr class="${cls}">
  <td class="lbl">${esc(label)}</td>
  <td class="num">${esc(value)}</td>
</tr>`;

  /** سطر توثيقي بعمود واحد (ملاحظة مقطع) */
  const noteRow = (text: string, cls: string): string =>
    `<tr class="${cls}"><td colspan="2">${esc(text)}</td></tr>`;

  /** سطر مجموع فرعي (حد علوي + عريض بلا إشارة) */
  const subtotal = (label: string, value: string): string =>
    `<tr class="subtotal">
  <td class="lbl">${esc(label)}</td>
  <td class="num">${esc(value)}</td>
</tr>`;

  /** عنوان مقطع */
  const sectionHead = (title: string): string =>
    `<tr class="sec"><td colspan="2">${esc(title)}</td></tr>`;

  // فروق الصرف: إشارة صريحة دائماً (±) لأنها قد تكون ربحاً أو خسارة
  const fxVal = d(pnl.fxGainLoss);
  const fxText = fxVal.isZero()
    ? formatAmount(pnl.fxGainLoss, dec)
    : fxVal.gt(0)
      ? `+${formatAmount(fxVal.abs().toString(), dec)}`
      : `−${formatAmount(fxVal.abs().toString(), dec)}`;

  const profitVal = d(pnl.profit);
  const profitSign = profitVal.isZero() ? '' : profitVal.lt(0) ? '−' : '';
  const profitText = `${profitSign}${formatAmount(profitVal.abs().toString(), dec)}`;

  const netRemVal = d(pnl.netRemainingToOwner);
  const netRemSign = netRemVal.isZero() ? '' : netRemVal.lt(0) ? '−' : '';
  const netRemText = `${netRemSign}${formatAmount(netRemVal.abs().toString(), dec)}`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)} — ${esc(data.company.name)}</title>
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
    width: 72%;
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
  .m-label { font-weight: 700; color: #374151; margin-inline-end: 4px; }
  table.pnl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  table.pnl td {
    border: 1px solid #ddd;
    padding: 5px 8px;
    vertical-align: middle;
  }
  table.pnl td.lbl { color: #111827; }
  table.pnl td.num {
    text-align: left;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    white-space: nowrap;
    direction: ltr;
  }
  tr.sec td {
    background: #f3f4f6;
    font-weight: 800;
    color: #374151;
    font-size: 12px;
    letter-spacing: 0.5px;
  }
  tr.subtotal td {
    border-top: 2px solid #111827;
    font-weight: 800;
    background: #f9fafb;
  }
  tr.subtotal td.num { font-size: 13.5px; }
  tr.owner-note td {
    background: #fefce8;
    color: #6b7280;
    font-size: 10.5px;
    font-style: italic;
    border-top: none;
    font-weight: 400;
  }
  .grand {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 10px;
    padding: 8px 10px;
    border: 2px solid #111827;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 800;
    background: #f9fafb;
  }
  .grand .num { font-size: 17px; font-variant-numeric: tabular-nums; direction: ltr; }
  .final {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
    padding: 10px 10px;
    border: 3px double #111827;
    border-radius: 6px;
    font-size: 15.5px;
    font-weight: 800;
  }
  .final .num { font-size: 19px; font-variant-numeric: tabular-nums; direction: ltr; }
  .final-note {
    margin-top: 4px;
    font-size: 10.5px;
    color: #6b7280;
    text-align: center;
    font-style: italic;
  }
  .formula-note {
    margin-top: 10px;
    font-size: 10.5px;
    color: #4b5563;
    border: 1px dashed #d1d5db;
    border-radius: 6px;
    padding: 5px 8px;
    text-align: center;
  }
  .map-note {
    margin-top: 6px;
    font-size: 11px;
    font-weight: 700;
    color: #374151;
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
    table.pnl tr, .grand, .final, .formula-note, .map-note { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="co">
    <div class="co-name">${esc(data.company.name)}</div>
    ${companyMeta ? `<div class="co-meta">${companyMeta}</div>` : ''}
  </header>
  <div class="doc-title">${esc(p.title)}</div>
  <section class="meta">
    <div style="grid-column: 1 / -1"><span class="m-label">${esc(p.period)}:</span> <span class="m-val">${esc(data.period.text)}</span></div>
    <div><span class="m-label">${esc(p.currency)}:</span> <span class="m-val">${esc(data.currency.code)}</span></div>
    <div><span class="m-label">${esc(ar.reports.baseCurrencyNote)}:</span> <span class="m-val">${esc(data.currency.code)}</span></div>
  </section>
  <table class="pnl">
    <tbody>
${sectionHead(S.revenues)}
${line(L.sales, signed(pnl.sales, dec))}
${line(L.salesReturns, negSigned(pnl.salesReturns, dec))}
${subtotal(L.netSales, plain(pnl.netSales, dec))}
${sectionHead(S.costs)}
${line(L.cogs, plain(pnl.cogs, dec))}
${line(L.returnsCost, negSigned(pnl.returnsCost, dec))}
${subtotal(L.netCogs, plain(pnl.netCogs, dec))}
${sectionHead(S.stock)}
${line(L.stockSurplus, signed(pnl.stockSurplus, dec))}
${line(L.stockShortage, negSigned(pnl.stockShortage, dec))}
    </tbody>
  </table>
  <table class="pnl" style="margin-top: 6px;">
    <tbody>
${sectionHead(S.expenses)}
${line(L.expenses, negSigned(pnl.expenses, dec))}
${sectionHead(S.fx)}
${line(L.fxGainLoss, fxText)}
    </tbody>
  </table>
  <div class="grand">
    <span>${esc(L.profit)}</span>
    <span class="num">${esc(profitText)} ${esc(data.currency.code)}</span>
  </div>
  <table class="pnl" style="margin-top: 10px;">
    <tbody>
${sectionHead(S.owner)}
${line(L.ownerDraw, negSigned(pnl.ownerDraw, dec))}
${noteRow(ar.reports.ownerSectionNote, 'owner-note')}
    </tbody>
  </table>
  <div class="final">
    <span>${esc(L.netRemaining)}</span>
    <span class="num">${esc(netRemText)} ${esc(data.currency.code)}</span>
  </div>
  <div class="final-note">${esc(ar.reports.netRemainingNote)}</div>
  <div class="formula-note">${esc(p.formulaNote)}</div>
  <div class="map-note">${esc(p.postingMapNote)}</div>
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
