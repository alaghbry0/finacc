/**
 * analytics-print.ts — ورقة بطاقة الصنف المطبوعة + رسائل واتساب التحليلات
 * (Task 17 — FR-09-03/06 مع FR-09-10).
 *
 * نمط statement-* وreport-* حرفياً: محمّل بيانات نقياً يجمع (المنشأة + عملة
 * الأساس بمنازلها + تقرير الدومين) → قالب HTML عربي RTL «ورقة بيضاء» 420px
 * (حبر أسود على أبيض — نفس أساس الفاتورة/الكشف/الأرباح) → تسليم المنصة:
 *  - الويب: معاينة داخل التطبيق ثم طباعة الإطار وحده.
 *  - الأصلي: حوار طباعة أندرويد.
 *
 * قرار Task 17 الموثق: **بطاقة الصنف تُطبع** (التجار يطبعون بطاقات الأصناف
 * للمزامنة مع الرفوف) أما تجزئة المبيعات وحركة المخزون وتحت الحد الأدنى
 * فمشاركتها النصية عبر واتساب (wa.me) في V1 — ورقتهما مؤجلة بلا خسارة
 * (نفس قرار تقرير الأرباح النصي أولاً).
 *
 * نقاوة الوحدة لاختبار bun: استيرادات نسبية فقط، بلا React Native.
 */
import type { SqliteAdapter } from '../db/adapter';
import {
  getItemCard,
  getSalesBreakdown,
  type ItemCardReport,
  type SalesBreakdown,
  type SalesBreakdownRow,
} from '../domain/analytics';
import { ar } from '../i18n/ar';
import { currencySymbol, formatAmount, formatDateAr, formatTimeAr, formatQty } from '../utils/format';
import { d } from '../utils/money';
import { reportPeriodText } from './report-data';
import { deliverPrint } from './print-platform';
import { domainErrorMessage } from '../utils/validation';

export interface PrintResult {
  ok: boolean;
  /** رسالة جاهزة للعرض (FeedbackBar) — نجاح أو عربية ودّية عند !ok */
  message: string;
}

/* ============ عقد البيانات ============ */

export interface ItemCardPrintData {
  company: { name: string; phone: string | null; footerText: string };
  currency: { code: string; decimals: number };
  /** بطاقة الدومين (الصفوف بالباقي التراكمي والمجاميع) */
  card: ItemCardReport;
  /** اسم المخزن المفلتر — null لكل المخازن */
  warehouseName: string | null;
  period: { from: string; to: string; text: string };
  generatedAt: string;
}

/** بيانات رسالة واتساب تجزئة المبيعات (خفيفة — بلا قالب ورقي) */
export interface SalesByShareData {
  companyName: string;
  currency: { code: string; decimals: number };
  breakdown: SalesBreakdown;
}

/* ============ المحمّل ============ */

/**
 * يحمّل بطاقة صنف لفترة/مخزن ويهيّئ عقد الطباعة والمشاركة. يرمي أخطاء
 * الدومين (تواريخ/صنف غير موجود) كما هي — المستدعي يعرض رسالتها العربية.
 */
export async function loadItemCardPrintData(
  adapter: SqliteAdapter,
  opts: { productId: number; from: string; to: string; warehouseId?: number | null },
): Promise<ItemCardPrintData> {
  const [card, companyRows, currencyRows] = await Promise.all([
    getItemCard(adapter, opts),
    adapter.all<{ name: string; phone: string | null; footer_text: string | null }>(
      'SELECT name, phone, footer_text FROM company ORDER BY id LIMIT 1',
    ),
    adapter.all<{ code: string; decimals: number; is_base: number }>(
      'SELECT code, decimals, is_base FROM currency WHERE is_base = 1 ORDER BY id LIMIT 1',
    ),
  ]);
  let warehouseName: string | null = null;
  if (opts.warehouseId != null) {
    const wh = await adapter.all<{ name: string }>('SELECT name FROM warehouse WHERE id = ?', [
      opts.warehouseId,
    ]);
    warehouseName = wh[0]?.name ?? null;
  }
  const company = companyRows[0];
  const base = currencyRows[0];
  return {
    company: {
      name: company?.name ?? '',
      phone: company?.phone ?? null,
      footerText:
        company?.footer_text && company.footer_text.trim() !== ''
          ? company.footer_text.trim()
          : ar.reports.paper.defaultFooter,
    },
    currency: {
      code: base?.code ?? '',
      decimals: Number.isFinite(Number(base?.decimals)) ? Number(base?.decimals) : 2,
    },
    card,
    warehouseName,
    period: {
      from: opts.from,
      to: opts.to,
      text: reportPeriodText(opts.from, opts.to),
    },
    generatedAt: new Date().toISOString(),
  };
}

/** يحمّل تجزئة المبيعات + المنشأة + عملة الأساس لرسالة الواتساب */
export async function loadSalesByShareData(
  adapter: SqliteAdapter,
  opts: { from: string; to: string; by: SalesBreakdown['by'] },
): Promise<SalesByShareData> {
  const [breakdown, companyRows, currencyRows] = await Promise.all([
    getSalesBreakdown(adapter, opts),
    adapter.all<{ name: string }>('SELECT name FROM company ORDER BY id LIMIT 1'),
    adapter.all<{ code: string; decimals: number; is_base: number }>(
      'SELECT code, decimals, is_base FROM currency WHERE is_base = 1 ORDER BY id LIMIT 1',
    ),
  ]);
  return {
    companyName: companyRows[0]?.name ?? '',
    currency: {
      code: currencyRows[0]?.code ?? '',
      decimals: Number(currencyRows[0]?.decimals ?? 2),
    },
    breakdown,
  };
}

/* ============ ورقة بطاقة الصنف (420px RTL) ============ */

/** تهريب HTML لكل مدخلات المستخدم — القالب لا يثق بأحد (نمط report-html) */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** كمية موقّعة للورقة: «+50» / «−20» (علامة غير لونية DS-18 — الطباعة أحادية) */
function signedQty(qty: string): string {
  const v = d(qty);
  if (v.isZero()) return formatQty(qty);
  return v.gt(0) ? `+${formatQty(qty)}` : `−${formatQty(v.abs().toString())}`;
}

/** تسمية نوع الحركة بالعربية من قاموس المخزون نفسه (لا ثانية) */
function movementLabel(type: string): string {
  const labels = ar.inventory.movement as Record<string, string>;
  return labels[type] ?? type;
}

/** يبني مستند بطاقة الصنف كاملاً — نقية، حتمية، بلا آثار جانبية */
export function buildItemCardHtml(data: ItemCardPrintData): string {
  const p = ar.analytics.paper;
  const card = data.card;
  const dec = data.currency.decimals >= 0 ? data.currency.decimals : 2;

  // شريط الملخص: رصيد ما قبله · وارد · صادر · الختامي (نمط شريط الكشف)
  const openingCell = card.openingBalance !== null
    ? `<div class="s-cell"><span class="s-lbl">${esc(p.opening)}</span><span class="s-num">${esc(formatQty(card.openingBalance))}</span></div>`
    : '';
  const summary = `
  <div class="summary">
    ${openingCell}
    <div class="s-cell"><span class="s-lbl">${esc(p.inTotal)}</span><span class="s-num">${esc(formatQty(card.totals.inQty))}</span></div>
    <div class="s-cell"><span class="s-lbl">${esc(p.outTotal)}</span><span class="s-num">${esc(formatQty(card.totals.outQty))}</span></div>
    <div class="s-cell s-closing"><span class="s-lbl">${esc(p.closing)}</span><span class="s-num">${esc(formatQty(card.totals.endQty))}</span></div>
  </div>`;

  // صف «رصيد ما قبله» حين الفترة لا تبدأ من أول التاريخ
  const openingRow =
    card.openingBalance !== null
      ? `<tr class="opening"><td colspan="3">${esc(p.opening)}</td><td class="num">${esc(formatQty(card.openingBalance))}</td></tr>`
      : '';

  const rows = card.rows
    .map(
      (r, i) => `<tr class="${i % 2 === 1 ? 'alt' : ''}">
  <td class="date">${esc(formatDateAr(r.movedAt))}</td>
  <td class="mv">${esc(movementLabel(r.movementType))}${r.warehouseName && card.warehouseId === null ? `<span class="wh"> · ${esc(r.warehouseName)}</span>` : ''}</td>
  <td class="num">${esc(signedQty(r.qty))}</td>
  <td class="num run">${esc(formatQty(r.running))}</td>
</tr>`,
    )
    .join('\n');

  const generatedDate = formatDateAr(data.generatedAt);
  const generatedTime = formatTimeAr(data.generatedAt);
  const companyMeta = data.company.phone
    ? `${esc(ar.sales.print.tpl.phone)}: ${esc(data.company.phone)}`
    : null;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)} — ${esc(card.productName)}</title>
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
  .page { width: 420px; max-width: 100%; margin: 0 auto; padding: 18px 16px 14px; }
  header.co { text-align: center; padding-bottom: 8px; border-bottom: 2px solid #111827; }
  .co-name { font-size: 22px; font-weight: 800; letter-spacing: 0.5px; }
  .co-meta { margin-top: 2px; font-size: 11.5px; color: #4b5563; }
  .doc-title {
    margin: 12px auto 10px; width: 72%; text-align: center; font-size: 17px;
    font-weight: 800; border: 2px solid #111827; border-radius: 6px;
    padding: 5px 8px; letter-spacing: 1px;
  }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 14px; font-size: 12.5px; margin-bottom: 10px; }
  .m-label { font-weight: 700; color: #374151; margin-inline-end: 4px; }
  .summary { display: flex; gap: 6px; margin-bottom: 10px; }
  .s-cell {
    flex: 1; text-align: center; border: 1px solid #ddd; border-radius: 6px;
    padding: 5px 4px; display: flex; flex-direction: column; gap: 1px;
  }
  .s-closing { border: 2px solid #111827; background: #f9fafb; font-weight: 800; }
  .s-lbl { font-size: 10.5px; color: #4b5563; font-weight: 700; }
  .s-num { font-variant-numeric: tabular-nums; font-weight: 700; direction: ltr; }
  table.moves { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.moves th {
    background: #f3f4f6; border: 1px solid #ddd; padding: 4px 6px;
    font-weight: 800; color: #374151; font-size: 11px;
  }
  table.moves td { border: 1px solid #ddd; padding: 4px 6px; vertical-align: middle; }
  table.moves tr.alt td { background: #fafafa; }
  td.date { white-space: nowrap; color: #374151; font-size: 11px; }
  td.mv { color: #111827; }
  td.mv .wh { color: #6b7280; font-size: 10.5px; }
  td.num { text-align: left; font-variant-numeric: tabular-nums; font-weight: 700; white-space: nowrap; direction: ltr; }
  td.run { font-weight: 800; }
  tr.opening td { background: #fefce8; font-weight: 800; }
  tr.opening td.num { border-top: 2px solid #111827; }
  .totals { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding: 6px 10px; border: 2px solid #111827; border-radius: 6px; font-weight: 800; background: #f9fafb; }
  .totals .num { font-size: 15px; font-variant-numeric: tabular-nums; direction: ltr; }
  footer { margin-top: 12px; padding-top: 8px; border-top: 1px solid #ddd; text-align: center; font-size: 11.5px; color: #4b5563; }
  .f-thanks { font-weight: 700; color: #111827; margin-bottom: 2px; }
  .f-gen { font-variant-numeric: tabular-nums; }
  @media print {
    @page { margin: 8mm; }
    html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { width: auto; }
    table.moves tr, .summary, .totals { page-break-inside: avoid; }
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
    <div style="grid-column: 1 / -1"><span class="m-label">${esc(p.product)}:</span> ${esc(card.productName)}${card.unitName ? ` <span style="color:#6b7280">(${esc(card.unitName)})</span>` : ''}</div>
    <div style="grid-column: 1 / -1"><span class="m-label">${esc(ar.reports.paper.period)}:</span> ${esc(data.period.text)}</div>
    <div><span class="m-label">${esc(p.warehouse)}:</span> ${esc(data.warehouseName ?? p.allWarehouses)}</div>
    <div><span class="m-label">${esc(ar.reports.paper.currency)}:</span> ${esc(data.currency.code)}</div>
  </section>
  ${summary}
  <table class="moves">
    <thead>
      <tr><th>${esc(p.date)}</th><th>${esc(p.type)}</th><th>${esc(p.qty)}</th><th>${esc(p.running)}</th></tr>
    </thead>
    <tbody>
${openingRow}
${rows}
    </tbody>
  </table>
  <div class="totals">
    <span>${esc(p.closing)}</span>
    <span class="num">${esc(formatQty(card.totals.endQty))}${card.unitName ? ` ${esc(card.unitName)}` : ''}</span>
  </div>
  <footer>
    <div class="f-thanks">${esc(data.company.footerText)}</div>
    <div class="f-gen">${esc(generatedDate)}${generatedTime ? ` · ${esc(generatedTime)}` : ''}</div>
    <div>${esc(ar.reports.paper.printedBy)}</div>
  </footer>
</div>
</body>
</html>`;
}

/* ============ تسليم الطباعة ============ */

/**
 * طباعة بطاقة الصنف (FR-09-03/10) — نفس نمط printPnl: التحميل → بناء
 * الورقة 420px → تسليم المنصة (ويب: معاينة؛ أصلي: نظام). لا يرمي أبداً.
 */
export async function printItemCard(
  adapter: SqliteAdapter,
  opts: { productId: number; from: string; to: string; warehouseId?: number | null },
): Promise<PrintResult> {
  try {
    const data = await loadItemCardPrintData(adapter, opts);
    const html = buildItemCardHtml(data);
    await deliverPrint(html, data.card.productName);
    return { ok: true, message: ar.analytics.printSent };
  } catch (err) {
    // أخطاء الدومين (مثل «صنف غير موجود») تُعرض برسالتها الأصلية
    return { ok: false, message: domainErrorMessage(err) ?? ar.analytics.printFailed };
  }
}

/* ============ رسائل الواتساب ============ */

/** رسالة واتساب بطاقة صنف — الخلاصة وأول 8 حركات (نص عادي لا HTML) */
export function buildItemCardWhatsAppMessage(data: ItemCardPrintData): string {
  const s = ar.analytics.share;
  const card = data.card;
  const dec = data.currency.decimals >= 0 ? data.currency.decimals : 2;

  const lines: string[] = [];
  lines.push(`${s.cardTitle} — ${card.productName}`);
  lines.push(`${s.company}: ${data.company.name}`);
  lines.push(`${s.period}: ${data.period.text}`);
  lines.push(`${s.warehouse}: ${data.warehouseName ?? ar.analytics.paper.allWarehouses}`);
  if (card.openingBalance !== null) {
    lines.push(`${s.opening}: ${formatQty(card.openingBalance)}`);
  }
  lines.push(`${s.inTotal}: ${formatQty(card.totals.inQty)}`);
  lines.push(`${s.outTotal}: ${formatQty(card.totals.outQty)}`);
  lines.push('');
  for (const r of card.rows.slice(0, 8)) {
    lines.push(
      `${formatDateAr(r.movedAt)} · ${movementLabel(r.movementType)} ${signedQty(r.qty)} → ${formatQty(r.running)}`,
    );
  }
  if (card.rows.length > 8) lines.push(s.moreRows.replace('{n}', String(card.rows.length - 8)));
  lines.push('');
  lines.push(`${s.closing}: ${formatQty(card.totals.endQty)}`);
  lines.push('');
  lines.push(ar.app.name);
  return lines.join('\n');
}

/** تسمية المجموعات بلا اسم صريح — من قاموس الشاشة نفسه */
function fallbackGroupLabel(r: SalesBreakdownRow): string {
  if (r.refKind === 'customer') return ar.analytics.salesBy.cashCustomer;
  if (r.refKind === 'category') return ar.analytics.salesBy.noCategory;
  return ar.analytics.salesBy.freeLine;
}

/** رسالة واتساب تجزئة المبيعات — أعلى 6 مجموعات + الإجمالي ونسبته */
export function buildSalesByWhatsAppMessage(data: SalesByShareData): string {
  const s = ar.analytics.share;
  const b = data.breakdown;
  const dec = data.currency.decimals >= 0 ? data.currency.decimals : 2;
  const symbol = currencySymbol(data.currency.code);
  const money = (v: string): string => `${formatAmount(v, dec)}${symbol ? ` ${symbol}` : ''}`;
  const byLabel = ar.analytics.salesBy.segs[b.by];

  const lines: string[] = [];
  lines.push(`${s.salesByTitle} ${byLabel} — ${data.companyName}`);
  lines.push(`${s.period}: ${formatDateAr(b.period.from)} ${ar.reports.paper.fromWord} ${formatDateAr(b.period.to)}`);
  lines.push('');
  for (const r of b.rows.slice(0, 6)) {
    const change =
      r.changePct === null
        ? s.newLabel
        : `${r.changePct > 0 ? '+' : r.changePct < 0 ? '−' : ''}${Math.abs(r.changePct)}%`;
    const label = r.label === '' ? fallbackGroupLabel(r) : r.label;
    lines.push(`• ${label}: ${money(r.total)} (${change})`);
  }
  if (b.rows.length > 6) lines.push(s.moreRows.replace('{n}', String(b.rows.length - 6)));
  lines.push('');
  lines.push(`${s.total}: ${money(b.totals.total)}`);
  if (b.totals.changePct !== null) {
    const sign = b.totals.changePct > 0 ? '+' : b.totals.changePct < 0 ? '−' : '';
    lines.push(`${s.change}: ${sign}${Math.abs(b.totals.changePct)}%`);
  }
  lines.push('');
  lines.push(ar.app.name);
  return lines.join('\n');
}
