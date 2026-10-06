/**
 * format.ts — أدوات تنسيق العرض (أرقام/عملات/تواريخ) — سلاسل فقط، بلا Float.
 *
 * كل الحساب عبر Decimal (من money.ts) بدقة 20 وتقريب HALF_UP.
 * نظام الأرقام (display.numerals — ملحق هـ): افتراضياً غربية (0-9)؛ عند اختيار
 * arabic_indic (الأرقام الهندية ٠-٩) تُطبّق على المبالغ والكميات والعدّادات
 * والتواريخ المعروضة.
 * أرقام مُعرّفات المستندات (INV-2026-00001) تبقى غربية دائماً — مُعرّف مخزّن
 * في القاعدة لا نص عرض. الجلسة (session.ts) تضبط النمط عند الإقلاع.
 * وحدة نقية: لا استيراد react-native (قابلة للاختبار والمشاركة مع Domain).
 */
import { d, Decimal } from './money';

/* ============ نظام الأرقام (display.numerals — ملحق هـ) ============ */

export type NumeralsMode = 'western' | 'arabic_indic';

let numeralsMode: NumeralsMode = 'western';

/** يضبط نظام الأرقام — يستدعيه الإقلاع (session.boot) وشاشة العرض عند التغيير */
export function setNumeralsMode(mode: NumeralsMode): void {
  numeralsMode = mode === 'arabic_indic' ? 'arabic_indic' : 'western';
}

export function getNumeralsMode(): NumeralsMode {
  return numeralsMode;
}

const INDIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;

/** يحوّل الأرقام الغربية إلى الهندية إن كان النمط مضبوطاً كذلك */
function maybeIndic(s: string): string {
  if (numeralsMode !== 'arabic_indic') return s;
  return s.replace(/[0-9]/g, (m) => INDIC_DIGITS[Number(m)]!);
}


/* ============ المبالغ ============ */

/**
 * تنسيق مبلغ عرض: فواصل آلاف (12,500.00) بمنازل ثابتة.
 * @param value نص/رقم عشري (مخزن TEXT في القاعدة)
 * @param decimals عدد المنازل (من العملة: YER=0، SAR=2…) — افتراضي 2
 */
export function formatAmount(value: string | number, decimals = 2): string {
  const x = toFinite(value);
  const fixed = x.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
  return groupThousands(fixed);
}

/** تنسيق مبلغ «حِي» أثناء الكتابة في NumberPad: يُجمّع الآلاف دون تثبيت المنازل */
export function formatAmountLive(raw: string): string {
  if (raw === '' || raw === '-') return '0';
  return groupThousands(raw);
}

/**
 * تنسيق كمية: حتى 3 منازل مع حذف الأصفار الذيلية («3.500» → «3.5»، «3.000» → «3»).
 */
export function formatQty(value: string | number, decimals = 3): string {
  const fixed = toFinite(value)
    .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
    .toFixed(decimals);
  const trimmed = fixed.includes('.')
    ? fixed.replace(/0+$/, '').replace(/\.$/, '')
    : fixed;
  return groupThousands(trimmed);
}

/** تنسيق عدد صحيح (عدّادات) بفواصل الآلاف */
export function formatCount(n: number): string {
  return groupThousands(String(Math.trunc(n)));
}

/* ============ العملات ============ */

/** رموز العملات العربية المعروفة — الباقي يُعرض برمزه */
const CURRENCY_SYMBOLS: Record<string, string> = {
  YER: 'ر.ي',
  SAR: 'ر.س',
  USD: '$',
  AED: 'د.إ',
};

export function currencySymbol(code?: string | null): string {
  if (!code) return '';
  return CURRENCY_SYMBOLS[code.toUpperCase()] ?? code;
}

/* ============ التواريخ — أرقام غربية وأسماء عربية ============ */

const WEEKDAYS = [
  'الأحد',
  'الاثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت',
] as const;

const MONTHS = [
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

/** «الأربعاء 07 أكتوبر 2026» — يقبل YYYY-MM-DD أو تاريخ ISO كاملاً */
export function formatDateAr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso ?? '').trim());
  if (!m) return iso ?? '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const dd = m[3];
  if (mo < 1 || mo > 12) return iso;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, Number(dd))).getUTCDay()];
  return maybeIndic(`${weekday} ${dd} ${MONTHS[mo - 1]} ${y}`);
}

/** «02:35 م» (12 ساعة بأرقام النمط المختار) — من تاريخ ISO كامل */
export function formatTimeAr(isoDateTime: string): string {
  const m = /T(\d{2}):(\d{2})/.exec((isoDateTime ?? '').trim());
  if (!m) return '';
  const h = Number(m[1]);
  const mm = m[2];
  if (h === 0) return maybeIndic(`12:${mm} ص`);
  if (h < 12) return maybeIndic(`${pad2(h)}:${mm} ص`);
  if (h === 12) return maybeIndic(`12:${mm} م`);
  return maybeIndic(`${pad2(h - 12)}:${mm} م`);
}

/** تاريخ اليوم المحلي (YYYY-MM-DD) — بتوقيت الجهاز لا UTC */
export function todayISO(): string {
  const n = new Date();
  return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
}

/** إزاحة أيام على تاريخ ISO (يومان موجب/سالب) بمنتصف UTC — دورة قياسية */
export function addDaysISO(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const base = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}-${pad2(base.getUTCDate())}`;
}

/** «الأحد 09» — تسمية مصغّرة لمحور الرسم البياني */
export function formatDayShortAr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const weekday = WEEKDAYS[new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  ).getUTCDay()];
  return maybeIndic(`${weekday} ${m[3]}`);
}

/* ============ مساعدات داخلية ============ */

function toFinite(value: string | number): Decimal {
  try {
    const x = d(value);
    return x.isFinite() ? x : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/** يجمع آلاف سلسلة رقمية نصية (يحترم الإشارة والكسر كما هما) */
function groupThousands(s: string): string {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [int, frac] = body.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = frac !== undefined ? `${grouped}.${frac}` : grouped;
  return maybeIndic(neg ? `-${out}` : out);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
