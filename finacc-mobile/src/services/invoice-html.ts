/**
 * invoice-html.ts — قالب الفاتورة المطبوعة (نقي — بلا أي استيراد React Native).
 *
 * الدور: يبني مستند HTML كاملاً مستقلاً (RTL، lang=ar، CSS مضمّن) لفاتورة
 * عربية جاهزة للطباعة الورقية. المستند «ورقة بيضاء» بحكم القانون البصري:
 * ألوان الواجهة الداكنة لا تنطبق هنا — الطباعة حبر أسود على أبيض
 * (SRS §6 — DS-14: خط الفواتير؛ العرض A5- تقريباً 420px).
 *
 * نقاوة الوحدة شرط اختبارها بـ bun (القالب هو قلب المهمة 7) — لذا:
 *  - الاستيرادات نسبية فقط (bun لا يعرف alias @/).
 *  - لا استيراد react-native إطلاقاً.
 *  - كل نص مستخرج من i18n (NFR-10) وكل أرقام عبر format.ts (نصية بلا Float).
 *
 * مؤجّلات موثقة (V1.1+):
 *  - QR (FR-10-01): يحتاج مُرمِّز QR نقياً بلا حزم — مؤجل.
 *  - خط Cairo المضمّن (DS-14): خطوط النظام العربية كافية أوفلاين (قانون 0.3)
 *    — 'Segoe UI', 'Noto Kufi Arabic', 'Tajawal', sans-serif.
 */
import { ar } from '../i18n/ar';
import { d } from '../utils/money';
import { formatAmount, formatQty, formatDateAr, formatTimeAr } from '../utils/format';

/* ============ عقد البيانات ============ */

/** بند مطبوع: اسم الصنف أو وصف السطر الخدمي */
export interface InvoicePrintItem {
  name: string;
  isService: boolean;
  /** نصوص عشرية من القاعدة (TEXT) كما هي */
  qty: string;
  unitPrice: string;
  discount: string;
  lineTotal: string;
}

/**
 * اسم الطرف النقدي عند غياب طرف مسجّل — حسب جهة المستند:
 * «عميل نقدي» لجهة البيع و«مورّد نقدي» لجهة الشراء (تجانس فواتير الشراء والسندات).
 */
function cashPartyName(partyLabel: string): string {
  return partyLabel === ar.sales.print.tpl.supplier
    ? ar.purchases.meta.cashSupplier
    : ar.sales.meta.cashCustomer;
}

/** بيانات الطرف (عميل/مورد) — null = طرف نقدي بلا حساب */
export interface InvoicePrintParty {
  name: string;
  phone: string | null;
  /** رقم الواتساب المخصص إن وُجد — يُفضَّل على الهاتف عند المشاركة */
  whatsapp: string | null;
}

export type PrintDocType = 'sale' | 'purchase' | 'sale_return' | 'purchase_return';

/** مدخلات القالب — يبنيها محمّل invoice-data.ts من القاعدة */
export interface InvoicePrintData {
  company: {
    name: string;
    phone: string | null;
    address: string | null;
    /** نص تذييل الفاتورة — المُحمِّل يطبّق الافتراضي عند الفراغ */
    footerText: string;
  };
  docType: PrintDocType;
  payStatus: 'cash' | 'credit' | 'mixed';
  /** 'void' يضيف علامة «ملغاة» المائية — الملغاة تطبع للأرشيف */
  status: 'completed' | 'void' | 'draft';
  invoiceNo: string | null;
  /** YYYY-MM-DD (أو ISO كامل) */
  issuedAt: string;
  party: InvoicePrintParty | null;
  /** «العميل» / «المورد» حسب نوع المستند */
  partyLabel: string;
  currency: { code: string; decimals: number };
  exchangeRate: string;
  rateIsFallback: boolean;
  items: InvoicePrintItem[];
  totals: {
    subtotal: string;
    discount: string;
    tax: string;
    total: string;
    paid: string;
    due: string;
  };
  notesPrinted: string | null;
  /** ISO كامل — لطابع «وُلِّدت» في التذييل */
  generatedAt: string;
}

/* ============ القالب ============ */

/** يبني مستند الفاتورة كاملاً — نقية، حتمية، بلا آثار جانبية */
export function buildInvoiceHtml(data: InvoicePrintData): string {
  const t = ar.sales.print.tpl;
  const tot = ar.sales.totals;
  const dec = data.currency.decimals >= 0 ? data.currency.decimals : 2;
  const isVoid = data.status === 'void';
  const title = ar.sales.print.docTitles[data.docType] ?? data.docType;

  const companyMeta = [data.company.phone ? `${t.phone}: ${esc(data.company.phone)}` : null, data.company.address ? esc(data.company.address) : null]
    .filter((p): p is string => p !== null)
    .join(' · ');

  const docNo = data.invoiceNo ? esc(data.invoiceNo) : '—';
  const partyName = data.party ? esc(data.party.name) : esc(cashPartyName(data.partyLabel));
  const partyPhone = data.party?.phone ? esc(data.party.phone) : null;
  const rateText = formatQty(data.exchangeRate);
  const dateText = formatDateAr(data.issuedAt);
  const generatedDate = formatDateAr(data.generatedAt);
  const generatedTime = formatTimeAr(data.generatedAt);

  const rows = data.items
    .map((it, i) => {
      const discountCell = d(it.discount).gt(0) ? formatAmount(it.discount, dec) : '—';
      return `<tr>
  <td class="num">${i + 1}</td>
  <td class="name-cell">${esc(it.name)}${it.isService ? `<span class="svc">${esc(t.service)}</span>` : ''}</td>
  <td class="num">${formatQty(it.qty)}</td>
  <td class="num">${formatAmount(it.unitPrice, dec)}</td>
  <td class="num">${discountCell}</td>
  <td class="num strong">${formatAmount(it.lineTotal, dec)}</td>
</tr>`;
    })
    .join('\n');

  const discountRow = d(data.totals.discount).gt(0)
    ? `<div class="trow"><span>${esc(tot.discount)}</span><span class="num">${formatAmount(data.totals.discount, dec)}</span></div>`
    : '';
  const taxRow = d(data.totals.tax).gt(0)
    ? `<div class="trow"><span>${esc(tot.tax)}</span><span class="num">${formatAmount(data.totals.tax, dec)}</span></div>`
    : '';

  const hasPaidDue = d(data.totals.due).gt(0) || d(data.totals.paid).gt(0);
  const paidDueBlock = hasPaidDue
    ? `<div class="paid-due">
  <div class="pd-cell"><span>${esc(t.paid)}</span><span class="num">${formatAmount(data.totals.paid, dec)}</span></div>
  <div class="pd-sep"></div>
  <div class="pd-cell"><span>${esc(t.due)}</span><span class="num strong">${formatAmount(data.totals.due, dec)}</span></div>
</div>`
    : '';

  const noteBlock = data.notesPrinted && data.notesPrinted.trim() !== ''
    ? `<div class="note"><span class="note-label">${esc(t.note)}:</span> ${esc(data.notesPrinted)}</div>`
    : '';

  const fallbackBadge = data.rateIsFallback
    ? `<span class="badge">${esc(t.rateFallback)}</span>`
    : '';

  const watermark = isVoid
    ? `<div class="void-mark"><span>${esc(ar.invoice.statusVoid)}</span></div>`
    : '';
  const watermarkCss = isVoid
    ? `  .void-mark {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5;
    pointer-events: none;
  }
  .void-mark span {
    transform: rotate(-24deg);
    font-size: 58px;
    font-weight: 800;
    letter-spacing: 10px;
    color: rgba(153, 27, 27, 0.22);
    border: 4px solid rgba(153, 27, 27, 0.30);
    border-radius: 10px;
    padding: 2px 14px;
  }
`
    : '';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} ${docNo}</title>
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
  .doc-no {
    font-family: 'IBM Plex Sans Arabic', 'Courier New', monospace;
    font-weight: 700;
    letter-spacing: 0.4px;
  }
  .badge {
    display: inline-block;
    border: 1px solid #b45309;
    color: #b45309;
    font-size: 10.5px;
    font-weight: 700;
    border-radius: 4px;
    padding: 0 5px;
    margin-inline-start: 6px;
    vertical-align: 1px;
  }
  table.items {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  table.items th {
    background: #f3f4f6;
    border: 1px solid #ddd;
    padding: 5px 4px;
    font-weight: 700;
    color: #374151;
    text-align: center;
  }
  table.items td {
    border: 1px solid #ddd;
    padding: 5px 4px;
    vertical-align: top;
  }
  table.items tbody tr:nth-child(even) td { background: #f9fafb; }
  td.num, th.num { text-align: center; font-variant-numeric: tabular-nums; }
  .num { font-variant-numeric: tabular-nums; }
  .strong { font-weight: 700; }
  .name-cell { font-weight: 600; }
  .svc {
    display: inline-block;
    margin-inline-start: 5px;
    border: 1px solid #9ca3af;
    color: #6b7280;
    border-radius: 3px;
    font-size: 10px;
    padding: 0 4px;
    vertical-align: 1px;
  }
  .totals { margin-top: 10px; }
  .trow {
    display: flex;
    justify-content: space-between;
    padding: 2px 2px;
    font-size: 12.5px;
    color: #374151;
  }
  .trow .num { color: #111827; }
  .grand {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 6px;
    padding: 7px 10px;
    border: 2px solid #111827;
    border-radius: 6px;
    font-size: 16px;
    font-weight: 800;
  }
  .grand .num { font-size: 18px; }
  .paid-due {
    display: flex;
    align-items: stretch;
    margin-top: 8px;
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 6px 10px;
  }
  .pd-cell {
    flex: 1;
    display: flex;
    justify-content: space-between;
    font-size: 12.5px;
    color: #374151;
    gap: 8px;
  }
  .pd-sep { width: 1px; background: #ddd; margin-inline-start: 10px; margin-inline-end: 10px; }
  .note {
    margin-top: 10px;
    font-size: 12px;
    color: #374151;
    border: 1px dashed #d1d5db;
    border-radius: 6px;
    padding: 5px 8px;
  }
  .note-label { font-weight: 700; }
  footer {
    margin-top: 14px;
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
    table.items tr, .paid-due, .note, .grand { page-break-inside: avoid; }
  }
${watermarkCss}</style>
</head>
<body>
<div class="page">
  ${watermark}
  <header class="co">
    <div class="co-name">${esc(data.company.name)}</div>
    ${companyMeta ? `<div class="co-meta">${companyMeta}</div>` : ''}
  </header>
  <div class="doc-title">${esc(title)}</div>
  <section class="meta">
    <div><span class="m-label">${esc(t.no)}:</span> <span class="m-val doc-no">${docNo}</span></div>
    <div><span class="m-label">${esc(t.date)}:</span> <span class="m-val">${esc(dateText)}</span></div>
    <div class="m-full"><span class="m-label">${esc(data.partyLabel)}:</span> <span class="m-val strong">${partyName}${partyPhone ? ` (${partyPhone})` : ''}</span></div>
    <div><span class="m-label">${esc(t.currency)}:</span> <span class="m-val">${esc(data.currency.code)}</span>${fallbackBadge}</div>
    <div><span class="m-label">${esc(t.rate)}:</span> <span class="m-val num">${esc(rateText)}</span></div>
  </section>
  <table class="items">
    <thead>
      <tr>
        <th class="num" style="width:24px">${esc(t.hash)}</th>
        <th>${esc(t.item)}</th>
        <th class="num" style="width:44px">${esc(t.qty)}</th>
        <th class="num" style="width:64px">${esc(t.price)}</th>
        <th class="num" style="width:56px">${esc(t.discount)}</th>
        <th class="num" style="width:76px">${esc(t.lineTotal)}</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <section class="totals">
    <div class="trow"><span>${esc(tot.subtotal)}</span><span class="num">${formatAmount(data.totals.subtotal, dec)}</span></div>
    ${discountRow}
    ${taxRow}
    <div class="grand"><span>${esc(tot.total)}</span><span class="num">${formatAmount(data.totals.total, dec)}</span></div>
    ${paidDueBlock}
    ${noteBlock}
  </section>
  <footer>
    <div class="f-thanks">${esc(data.company.footerText)}</div>
    <div class="f-gen">${esc(generatedDate)}${generatedTime ? ` · ${esc(generatedTime)}` : ''}</div>
    <div>${esc(t.printedBy)}</div>
  </footer>
</div>
</body>
</html>`;
}

/* ============ مساعدات داخلية ============ */

/** تهريب HTML لكل مدخلات المستخدم (أسماء/ملاحظات/أرقام) — القالب لا يثق بأحد */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ================================================================
 *  سند القبض/الصرف المطبوع (FR-04-10 — المهمة 10)
 *  نفس أساس ورقة الفاتورة (أبيض أسود RTL) لكن بعرض حراري ~320px
 *  (58/80مم) — مستند قصير: رأس + عنوان ورقم RVT-/PMT- + الطرف +
 *  المبلغ كبيراً + التخصيصات + البيان + فرق الصرف + تذييل.
 * ================================================================ */

export type VoucherDocType = 'receipt' | 'payment';

/** بند تخصيص مطبوع على السند */
export interface VoucherAllocationPrint {
  invoiceNo: string;
  /** بعملة الفاتورة (4dp) */
  amount: string;
}

/** مدخلات قالب السند — يبنيها محمّل voucher-data.ts من القاعدة */
export interface VoucherPrintData {
  company: {
    name: string;
    phone: string | null;
    footerText: string;
  };
  docType: VoucherDocType;
  /** RVT-YYYY-NNNNN / PMT-YYYY-NNNNN — عبر ensureVoucherNo وقت الطباعة */
  voucherNo: string;
  /** YYYY-MM-DD */
  txDate: string;
  /** العميل للقبض / المورد للصرف — null = حر بلا طرف (دفعة على الحساب) */
  partyName: string | null;
  partyLabel: string;
  partyPhone: string | null;
  cashboxName: string;
  currency: { code: string; decimals: number };
  amount: string;
  /** الباقي «على الحساب» بعملة السند (4dp) — صفر إن لم يبقَ شيء */
  onAccount: string;
  /** التخصيصات على الفواتير (صريحة من payment_allocation) */
  allocations: VoucherAllocationPrint[];
  /** فرق الصرف المحقق بالعملة الأساسية (4dp) — + ربح / − خسارة */
  fxGainLoss: string;
  description: string | null;
  /** ISO كامل — لطابع «وُلِّدت» في التذييل */
  generatedAt: string;
}

/**
 * يبني مستند سند القبض/الصرف الكامل — نقية، حتمية، بلا آثار جانبية.
 * عرض الورقة 320px (حراري 58/80مم) بخط أساس أكبر قليلاً قياساً بالفاتورة.
 */
export function buildVoucherHtml(data: VoucherPrintData): string {
  const t = ar.cash.voucher.paper;
  const dec = data.currency.decimals >= 0 ? data.currency.decimals : 2;
  const isReceipt = data.docType === 'receipt';
  const title = isReceipt ? t.receiptTitle : t.paymentTitle;
  const amountLabel = isReceipt ? t.amountReceived : t.amountPaid;

  const companyMeta = data.company.phone
    ? `${esc(ar.sales.print.tpl.phone)}: ${esc(data.company.phone)}`
    : null;

  const dateText = formatDateAr(data.txDate);
  const generatedDate = formatDateAr(data.generatedAt);
  const generatedTime = formatTimeAr(data.generatedAt);

  const rows = data.allocations
    .map(
      (a) => `<tr>
  <td class="no-cell">${esc(a.invoiceNo)}</td>
  <td class="num strong">${formatAmount(a.amount, dec)}</td>
</tr>`,
    )
    .join('\n');

  const allocBlock = data.allocations.length > 0 ? `<table class="allocs">
  <thead>
    <tr><th>${esc(t.settledInvoices)}</th><th class="num">${esc(ar.sales.print.tpl.lineTotal)}</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>` : '';

  const onAccountRow =
    data.onAccount !== null && d(data.onAccount).gt(0)
      ? `<div class="on-account"><span>${esc(t.onAccount)}</span><span class="num strong">${formatAmount(data.onAccount, dec)}</span></div>`
      : '';

  const fxBlock =
    data.fxGainLoss !== null && d(data.fxGainLoss).abs().gt(0)
      ? `<div class="fx"><span>${esc(t.fxLine)}</span><span class="num strong">${formatAmount(data.fxGainLoss, 2)}</span></div>`
      : '';

  const noteBlock =
    data.description && data.description.trim() !== ''
      ? `<div class="note">${esc(data.description)}</div>`
      : '';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} ${esc(data.voucherNo)}</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #111827;
    font-family: 'Segoe UI', 'Noto Kufi Arabic', 'Tajawal', 'Noto Sans Arabic', sans-serif;
    font-size: 13.5px;
    line-height: 1.6;
  }
  .page {
    width: 320px;
    max-width: 100%;
    margin: 0 auto;
    padding: 14px 12px 10px;
    position: relative;
    overflow: hidden;
  }
  header.co {
    text-align: center;
    padding-bottom: 7px;
    border-bottom: 2px solid #111827;
  }
  .co-name {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: 0.5px;
  }
  .co-meta {
    margin-top: 2px;
    font-size: 11px;
    color: #4b5563;
  }
  .doc-title {
    margin: 10px auto 9px;
    width: 70%;
    text-align: center;
    font-size: 16px;
    font-weight: 800;
    border: 2px solid #111827;
    border-radius: 6px;
    padding: 4px 6px;
    letter-spacing: 1px;
  }
  .voucher-no {
    text-align: center;
    font-family: 'IBM Plex Sans Arabic', 'Courier New', monospace;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 0.6px;
    margin-bottom: 8px;
  }
  .meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px 10px;
    font-size: 12.5px;
    margin-bottom: 8px;
  }
  .meta .m-full { grid-column: 1 / -1; }
  .m-label { font-weight: 700; color: #374151; margin-inline-end: 3px; }
  .m-val { color: #111827; }
  .amount-box {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 4px;
    padding: 9px 10px;
    border: 2px solid #111827;
    border-radius: 8px;
  }
  .amount-box .lbl { font-weight: 800; font-size: 14px; }
  .amount-box .num {
    font-size: 20px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
  .on-account, .fx {
    display: flex;
    justify-content: space-between;
    padding: 3px 2px;
    font-size: 12.5px;
    color: #374151;
    margin-top: 5px;
  }
  .on-account .num, .fx .num { color: #111827; }
  table.allocs {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-top: 8px;
  }
  table.allocs th {
    background: #f3f4f6;
    border: 1px solid #ddd;
    padding: 4px 5px;
    font-weight: 700;
    color: #374151;
    text-align: center;
  }
  table.allocs td {
    border: 1px solid #ddd;
    padding: 4px 5px;
    vertical-align: top;
  }
  td.num, th.num { text-align: center; font-variant-numeric: tabular-nums; }
  .no-cell {
    font-family: 'IBM Plex Sans Arabic', 'Courier New', monospace;
    font-weight: 700;
  }
  .strong { font-weight: 700; }
  .note {
    margin-top: 8px;
    font-size: 12px;
    color: #374151;
    border: 1px dashed #d1d5db;
    border-radius: 6px;
    padding: 4px 7px;
  }
  .sig-row {
    display: flex;
    justify-content: space-between;
    margin-top: 14px;
    font-size: 12px;
    color: #374151;
  }
  .sig-row .sig-line { border-top: 1px dotted #6b7280; padding-top: 2px; min-width: 90px; text-align: center; }
  footer {
    margin-top: 10px;
    padding-top: 6px;
    border-top: 1px solid #ddd;
    text-align: center;
    font-size: 11px;
    color: #4b5563;
  }
  .f-thanks { font-weight: 700; color: #111827; margin-bottom: 2px; }
  .f-gen { font-variant-numeric: tabular-nums; }
  @media print {
    @page { margin: 6mm; }
    html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { width: auto; }
    .amount-box, table.allocs, .note, .on-account, .fx { page-break-inside: avoid; }
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
  <div class="voucher-no">${esc(data.voucherNo)}</div>
  <section class="meta">
    <div><span class="m-label">${esc(ar.sales.print.tpl.date)}:</span> <span class="m-val">${esc(dateText)}</span></div>
    <div><span class="m-label">${esc(t.cashbox)}:</span> <span class="m-val">${esc(data.cashboxName)}</span></div>
    <div class="m-full"><span class="m-label">${esc(data.partyLabel)}:</span> <span class="m-val strong">${esc(data.partyName ?? cashPartyName(data.partyLabel))}${data.partyPhone ? ` (${esc(data.partyPhone)})` : ''}</span></div>
  </section>
  <div class="amount-box">
    <span class="lbl">${esc(amountLabel)}</span>
    <span class="num">${formatAmount(data.amount, dec)} <span class="cur">${esc(data.currency.code)}</span></span>
  </div>
  ${allocBlock}
  ${onAccountRow}
  ${fxBlock}
  ${noteBlock}
  <div class="sig-row">
    <div class="sig-line">${esc(t.signature)}</div>
    <div class="sig-line">${esc(data.company.name)}</div>
  </div>
  <footer>
    <div class="f-thanks">${esc(data.company.footerText)}</div>
    <div class="f-gen">${esc(generatedDate)}${generatedTime ? ` · ${esc(generatedTime)}` : ''}</div>
    <div>${esc(t.printedBy)}</div>
  </footer>
</div>
</body>
</html>`;
}
