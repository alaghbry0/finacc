/**
 * statement-data.ts — محمّل بيانات كشف الحساب للطباعة والمشاركة (FR-03-04).
 *
 * يجمع في نداء واحد: سطور الكشف (domain.getStatementLines — العملة الواحدة
 * المتوازنة دائماً بقرار 8) + المنشأة + الطرف + عملة الكشف بمنازلها، ثم يهيّئ
 * عقد القالب النقي (StatementPrintData) الذي يستهلكه:
 *  - statement-html.ts → ورقة الكشف المطبوعة.
 *  - statement-share.ts → رسالة الواتساب.
 *
 * كذلك يضم «أعمار الديون» (FR-03-03) كدالة نقية صرفة: توزيع الفواتير الآجلة
 * المفتوحة على أربع شرائح عمرية من تاريخ إصدارها بالمتبقي غير المسدد
 * (نفس دلالة getOpenInvoicesForParty في db/queries — المتبقي مشتق لا مخزن).
 *
 * نقية بلا React Native (نفس شروط invoice-data.ts) — قابلة للاختبار بـ bun
 * عبر test-adapter وقابلة للاستهلاك من شاشات RN عبر أي SqliteAdapter.
 */
import type { SqliteAdapter } from '../db/adapter';
import { getCustomer, getSupplier } from '../domain/parties';
import { getStatementLines, type PartyType, type StatementLine } from '../domain/statement';
import { ar } from '../i18n/ar';
import { formatDateAr } from '../utils/format';
import { d, Decimal, f4 } from '../utils/money';

/* ============ عقد البيانات ============ */

/** بيانات ورقة الكشف المطبوعة — يبنيها هذا الملف ويستهلكها القالب */
export interface StatementPrintData {
  company: {
    name: string;
    phone: string | null;
    footerText: string;
  };
  partyType: PartyType;
  partyName: string;
  /** «العميل» / «المورد» حسب نوع الطرف */
  partyLabel: string;
  partyPhone: string | null;
  currency: { code: string; decimals: number };
  period: {
    /** YYYY-MM-DD أو null عند بلا حد */
    from: string | null;
    to: string | null;
    /** نص الفترة جاهز للعرض («من … حتى …» / «كل الفترات») */
    text: string;
  };
  /** رصيد أول المدة بعملة الكشف (4dp) */
  openingBalance: string;
  /** الرصيد الختامي بعملة الكشف (4dp) */
  closingBalance: string;
  /** عدد سطور الحركات (بسطر الإرشاد) */
  lineCount: number;
  lines: StatementLine[];
  /** ISO كامل — لطابع «وُلِّدت» في التذييل */
  generatedAt: string;
}

/* ============ نص الفترة ============ */

/** «من الخميس 01 يناير 2026 حتى الخميس 08 أكتوبر 2026» — أو «كل الفترات» */
export function statementPeriodText(from?: string, to?: string): string {
  const p = ar.statement.paper;
  if (from && to) {
    return `${p.fromWord} ${formatDateAr(from)} ${p.toWord} ${formatDateAr(to)}`;
  }
  if (from) return `${p.fromWord} ${formatDateAr(from)}`;
  if (to) return `${p.toWord} ${formatDateAr(to)}`;
  return p.periodAll;
}

/* ============ المحمّل ============ */

/**
 * يحمّل كشف حساب الطرف بعملة واحدة (وفترة اختيارية) ويهيّئ عقد الطباعة.
 * يرمي أخطاء الدومين كما هي (طرف/عملة غير موجودة) — المستدعي يعرض
 * رسالتها العربية.
 */
export async function loadStatementPrintData(
  adapter: SqliteAdapter,
  partyType: PartyType,
  partyId: number,
  currencyId: number,
  opts: { from?: string; to?: string } = {},
): Promise<StatementPrintData> {
  const result = await getStatementLines(adapter, partyType, partyId, currencyId, opts);
  const isCustomer = partyType === 'customer';
  const [companyRows, party, currencyRows] = await Promise.all([
    adapter.all<{ name: string; phone: string | null; footer_text: string | null }>(
      'SELECT name, phone, footer_text FROM company ORDER BY id LIMIT 1',
    ),
    isCustomer ? getCustomer(adapter, partyId) : getSupplier(adapter, partyId),
    adapter.all<{ code: string; decimals: number }>(
      'SELECT code, decimals FROM currency WHERE id = ?',
      [currencyId],
    ),
  ]);

  const company = companyRows[0];
  const currency = currencyRows[0];
  return {
    company: {
      name: company?.name ?? '',
      phone: company?.phone ?? null,
      footerText:
        company?.footer_text && company.footer_text.trim() !== ''
          ? company.footer_text.trim()
          : ar.statement.paper.defaultFooter,
    },
    partyType,
    partyName: result.partyName,
    partyLabel: isCustomer ? ar.statement.paper.party : ar.statement.paper.partySupplier,
    partyPhone: party?.phone ?? null,
    currency: {
      code: currency?.code ?? result.currencyCode,
      decimals: Number.isFinite(Number(currency?.decimals)) ? Number(currency?.decimals) : 2,
    },
    period: {
      from: opts.from ?? null,
      to: opts.to ?? null,
      text: statementPeriodText(opts.from, opts.to),
    },
    openingBalance: result.openingBalance,
    closingBalance: result.closingBalance,
    lineCount: result.lines.length,
    lines: result.lines,
    generatedAt: new Date().toISOString(),
  };
}

/* ============ أعمار الديون (FR-03-03) — نقية صرفة ============ */

/** فاتورة مفتوحة للمحاسبة العمرية: تاريخ إصدارها ومتبقيها غير المسدد */
export interface AgingInvoiceInput {
  issuedAt: string;
  remaining: string;
}

/** شريحة عمرية: 0=0-30 يوم، 1=31-60، 2=61-90، 3=أكثر من 90 */
export interface AgingBucket {
  index: 0 | 1 | 2 | 3;
  /** مجموع متبقي الفواتير بالشريحة (4dp بعملتها) */
  amount: string;
  count: number;
}

export interface AgingSummary {
  buckets: [AgingBucket, AgingBucket, AgingBucket, AgingBucket];
  /** مجموع المتأخرات القائمة = مجموع الشرائح */
  total: string;
}

const DAY_MS = 86_400_000;

/** عمر الفاتورة بالأيام (سالب/صفر يوم الإصدار → 0) — من issued_at حتى اليوم */
function ageDays(issuedAt: string, today: string): number {
  const a = Date.parse(`${issuedAt}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

/**
 * يوزّع الفواتير المفتوحة على شرائح العمر الأربع (FR-03-03) — نقية صرفة.
 * الدلالة: متبقي كل فاتورة آجلة مفتوحة (due_amount − Σ تخصيصات السندات
 * الحية — كما يعيدها getOpenInvoicesForParty) يُحسب عمره من issued_at.
 * العملة مسؤولية المستدعي: مرّر فواتير عملة واحدة فقط (قرار 8 — لا خلط).
 */
export function computeAgingBuckets(
  invoices: AgingInvoiceInput[],
  today: string,
): AgingSummary {
  const amounts = [new Decimal(0), new Decimal(0), new Decimal(0), new Decimal(0)];
  const counts = [0, 0, 0, 0];
  for (const inv of invoices) {
    const age = ageDays(inv.issuedAt, today);
    const idx = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3;
    amounts[idx] = amounts[idx]!.plus(d(inv.remaining));
    counts[idx] = counts[idx]! + 1;
  }
  const buckets = [0, 1, 2, 3].map((i) => ({
    index: i as 0 | 1 | 2 | 3,
    amount: f4(amounts[i]!),
    count: counts[i]!,
  })) as [AgingBucket, AgingBucket, AgingBucket, AgingBucket];
  return {
    buckets,
    total: f4(
      amounts.reduce((acc, x) => acc.plus(x), new Decimal(0)),
    ),
  };
}
