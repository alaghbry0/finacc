/**
 * report-share.ts — رسالة الواتساب لتقرير الأرباح والخسائر (نقي — بلا React Native).
 *
 * FR-09-10 (نسخة V1 نصية): ملخص مختصر عبر wa.me — الفترة والعملة + صافي
 * المبيعات + صافي التكلفة + المصاريف + فروق الصرف + الربح + مسحوبات المالك
 * + «صافي ما بقي للمالك» + تذييل اسم التطبيق. المرفق (PDF) مؤجل لمسار EAS
 * الأصلي (موثق في سجل العمل).
 *
 * النقاوة لاختبار bun: استيرادات نسبية فقط، بلا RN.
 */
import { ar } from '../i18n/ar';
import { currencySymbol, formatAmount } from '../utils/format';
import { d } from '../utils/money';
import type { PnlPrintData } from './report-data';

/** مبلغ مجرد بعملة الأساس (قيمة موجبة) */
function money(value: string, dec: number, symbol: string): string {
  return `${formatAmount(d(value).abs().toString(), dec)}${symbol ? ` ${symbol}` : ''}`;
}

/** مبلغ بإشارته: سالب يظهر «−» والموجب بلا إشارة (صافي الخطوط الختامية) */
function finalMoney(value: string, dec: number, symbol: string): string {
  const v = d(value);
  const prefix = v.lt(0) ? '−' : '';
  return `${prefix}${money(value, dec, symbol)}`;
}

/** مبلغ بند خصم: «−x» (الصفر بلا إشارة) — للمصاريف والمسحوبات */
function negMoney(value: string, dec: number, symbol: string): string {
  const v = d(value);
  if (v.isZero()) return money(value, dec, symbol);
  return `−${money(value, dec, symbol)}`;
}

/** مبلغ بإشارته (+ ربح / − خسارة) — للفروق فقط */
function signedMoney(value: string, dec: number, symbol: string): string {
  const v = d(value);
  if (v.isZero()) return money(value, dec, symbol);
  return `${v.gt(0) ? '+' : '−'}${money(value, dec, symbol)}`;
}

/**
 * رسالة واتساب مختصرة لتقرير الأرباح: العنوان بالمنشأة + الفترة والعملة +
 * البنود السبع المفصلية (صافي المبيعات/صافي التكلفة/المصاريف/فروق الصرف/
 * الربح/المسحوبات/صافي ما بقي للمالك) + تذييل اسم التطبيق.
 * نص عادي (WhatsApp لا يفهم HTML).
 */
export function buildPnlWhatsAppMessage(data: PnlPrintData): string {
  const s = ar.reports.shareText;
  const dec = data.currency.decimals >= 0 ? data.currency.decimals : 2;
  const symbol = currencySymbol(data.currency.code);
  const pnl = data.pnl;

  const lines: string[] = [];
  lines.push(`${s.title} — ${data.company.name}`);
  lines.push(`${s.period}: ${data.period.text}`);
  lines.push(`${s.currency}: ${data.currency.code}`);
  lines.push('');
  lines.push(`${s.netSales}: ${money(pnl.netSales, dec, symbol)}`);
  lines.push(`${s.netCogs}: ${money(pnl.netCogs, dec, symbol)}`);
  lines.push(`${s.expenses}: ${negMoney(pnl.expenses, dec, symbol)}`);
  lines.push(`${s.fx}: ${signedMoney(pnl.fxGainLoss, dec, symbol)}`);
  lines.push('');
  lines.push(`${s.profit}: ${finalMoney(pnl.profit, dec, symbol)}`);
  lines.push(`${s.ownerDraw}: ${negMoney(pnl.ownerDraw, dec, symbol)}`);
  lines.push(`${s.netRemaining}: ${finalMoney(pnl.netRemainingToOwner, dec, symbol)}`);
  lines.push('');
  lines.push(ar.app.name);
  return lines.join('\n');
}
