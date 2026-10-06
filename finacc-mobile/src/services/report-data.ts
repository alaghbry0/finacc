/**
 * report-data.ts — محمّل بيانات تقرير الأرباح والخسائر للطباعة والمشاركة (FR-09-02/10).
 *
 * يجمع في نداء واحد: قائمة الأرباح من الدومين (domain/reports.getProfitAndLoss —
 * المشتقة حصراً عبر خريطة الترحيل ملحق و) + المنشأة + **عملة الأساس** بمنازلها
 * (كل بنود القائمة بالأساس — قرار 3: الأساس = 1) ثم يهيّئ عقد القالب النقي
 * (PnlPrintData) الذي يستهلكه:
 *  - report-html.ts → ورقة التقرير المطبوعة (420px RTL).
 *  - report-share.ts → رسالة الواتساب المختصرة.
 *
 * نقية بلا React Native (نفس شروط statement-data.ts) — قابلة للاختبار بـ bun
 * عبر test-adapter وقابلة للاستهلاك من شاشات RN عبر أي SqliteAdapter.
 */
import type { SqliteAdapter } from '../db/adapter';
import { getProfitAndLoss, type PnlReport } from '../domain/reports';
import { ar } from '../i18n/ar';
import { formatDateAr } from '../utils/format';

/* ============ عقد البيانات ============ */

/** بيانات ورقة تقرير الأرباح — يبنيها هذا الملف ويستهلكها القالب */
export interface PnlPrintData {
  company: {
    name: string;
    phone: string | null;
    footerText: string;
  };
  /** عملة الأساس (كل بنود القائمة بها) */
  currency: {
    code: string;
    decimals: number;
  };
  period: {
    from: string;
    to: string;
    /** نص الفترة جاهز للعرض («من … حتى …») */
    text: string;
  };
  /** القائمة بالكامل (بنود الصيغة المصححة + الختاميان) */
  pnl: PnlReport;
  /** ISO كامل — لطابع «وُلِّدت» في التذييل */
  generatedAt: string;
}

/* ============ نص الفترة ============ */

/** «من الأربعاء 01 يناير 2026 حتى الخميس 08 أكتوبر 2026» */
export function reportPeriodText(from: string, to: string): string {
  const p = ar.reports.paper;
  return `${p.fromWord} ${formatDateAr(from)} ${p.toWord} ${formatDateAr(to)}`;
}

/* ============ المحمّل ============ */

/**
 * يحمّل تقرير الأرباح والخسائر لفترة [from, to] ويهيّئ عقد الطباعة/المشاركة.
 * يرمي أخطاء الدومين (تواريخ غير صالحة/مقلوبة) كما هي — المستدعي يعرض
 * رسالتها العربية.
 */
export async function loadPnlPrintData(
  adapter: SqliteAdapter,
  opts: { from: string; to: string },
): Promise<PnlPrintData> {
  const pnl = await getProfitAndLoss(adapter, opts);
  const [companyRows, currencyRows] = await Promise.all([
    adapter.all<{ name: string; phone: string | null; footer_text: string | null; currency_id: number }>(
      'SELECT name, phone, footer_text, currency_id FROM company ORDER BY id LIMIT 1',
    ),
    adapter.all<{ code: string; decimals: number; is_base: number }>(
      'SELECT code, decimals, is_base FROM currency WHERE is_base = 1 ORDER BY id LIMIT 1',
    ),
  ]);

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
    period: {
      from: opts.from,
      to: opts.to,
      text: reportPeriodText(opts.from, opts.to),
    },
    pnl,
    generatedAt: new Date().toISOString(),
  };
}
