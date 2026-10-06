/**
 * errors.ts — أصناف أخطاء طبقة Domain (مشتركة لكل الوحدات).
 *
 * قاعدة صياغة الرسائل (SRS §6.3 — ملزمة): (ماذا حدث بكلمات المستخدم) + (ما الحل).
 * كل صنف يحمل `.code` نصياً ثابتاً لتصنيف الأخطاء برمجياً في الواجهات لاحقاً.
 */
import type { ZodIssue } from 'zod';
import { d, f3 } from '../utils/money';

/** الصنف الأصل: خطأ منطق أعمال برمز */
export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** خطأ قاعدة عمل عام (يُرمى برمز محدد + رسالة عربية) */
export class DomainRuleError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'DomainRuleError';
  }
}

/**
 * فشل التحقق من المدخلات (زود) — الرسالة عربية، والمشاكل الأصلية مرفقة
 * في `.issues` للعرض التقني التفصيلي (DS-33).
 */
export class ValidationError extends DomainError {
  readonly issues: ZodIssue[];
  constructor(message: string, issues: ZodIssue[] = []) {
    super('VALIDATION', message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * لا يوجد سعر صرف لليوم — قرار 3: يُمنع الحفظ ويفتح BottomSheet لإدخال سعر اليوم.
 * النموذج: «لا يوجد سعر صرف لليوم للريال السعودي (SAR). أدخل سعر اليوم للمتابعة»
 */
export class MissingRateError extends DomainError {
  readonly currencyCode: string;
  readonly currencyName: string;
  readonly dateISO: string;
  constructor(currencyCode: string, currencyName: string, dateISO: string) {
    super(
      'MISSING_RATE',
      `لا يوجد سعر صرف لليوم لل${currencyName} (${currencyCode}). أدخل سعر اليوم للمتابعة`,
    );
    this.name = 'MissingRateError';
    this.currencyCode = currencyCode;
    this.currencyName = currencyName;
    this.dateISO = dateISO;
  }
}

/**
 * رصيد مخزوني لا يكفي — قرار 9: منع السالب مطلقاً في المخزون.
 * الرسالة تسمّي الصنف والمتاح والنقص (FR-02-18 + نموذج §6.3):
 * «كمية «حليب المراعي» المتوفرة 5.000 فقط — النقص 3.000. خفّض الكمية أو احذف الزيادة»
 */
export class NegativeStockError extends DomainError {
  readonly productName: string;
  readonly available: string;
  readonly requested: string;
  readonly missing: string;
  constructor(productName: string, available: string, requested: string) {
    const avail = f3(available);
    const req = f3(requested);
    const miss = d(requested).gt(d(available)) ? f3(d(requested).minus(d(available))) : '0.000';
    super(
      'NEGATIVE_STOCK',
      `كمية «${productName}» المتوفرة ${avail} فقط — النقص ${miss}. خفّض الكمية أو احذف الزيادة`,
    );
    this.name = 'NegativeStockError';
    this.productName = productName;
    this.available = avail;
    this.requested = req;
    this.missing = miss;
  }
}

/** التأريخ الرجعي أبعد من الحد — يتطلب تأكيد المدير + قيد audit (FR-02-19) */
export class BackdateConfirmationRequiredError extends DomainError {
  readonly dateISO: string;
  readonly maxDays: number;
  constructor(dateISO: string, maxDays: number) {
    super(
      'BACKDATE_CONFIRM_REQUIRED',
      `تاريخ الفاتورة رجعي أكثر من الحد المسموح (${maxDays} يوماً). أكّد من المدير للحفظ`,
    );
    this.name = 'BackdateConfirmationRequiredError';
    this.dateISO = dateISO;
    this.maxDays = maxDays;
  }
}

/** عملية غير صالحة على حالة المستند الحالية (آلة حالات 5.4-2) */
export class InvoiceStateError extends DomainError {
  constructor(message: string) {
    super('INVOICE_STATE', message);
    this.name = 'InvoiceStateError';
  }
}

/* ============ سياسة PIN (FR-12-06 — قرار 4) ============ */

/** عدد المحاولات الخاطئة التي تبدأ بعدها التأخير المتصاعد */
export const PIN_LOCK_THRESHOLD = 5;
/** عدد المحاولات التي يظهر بعدها خيار المسح الكامل */
export const PIN_HARD_RESET_THRESHOLD = 10;

/** التأخير المتصاعد (ثوانٍ) بعد المحاولة الخاطئة رقم n — سقف 900 ثانية (15 دقيقة) */
export function pinLockDelaySeconds(failedAttempts: number): number {
  if (failedAttempts < PIN_LOCK_THRESHOLD) return 0;
  if (failedAttempts >= PIN_HARD_RESET_THRESHOLD) return 900;
  // 5→30، 6→60، 7→120، 8→240، 9→480
  return 30 * 2 ** (failedAttempts - PIN_LOCK_THRESHOLD);
}

/** رمز PIN خاطئ ولم يُقفل بعد — الرسالة تخبر بالمحاولات المتبقية قبل القفل */
export class PinWrongError extends DomainError {
  readonly failedAttempts: number;
  readonly attemptsLeftBeforeLock: number;
  readonly needsHardReset: boolean;
  constructor(failedAttempts: number) {
    const left = Math.max(PIN_LOCK_THRESHOLD - failedAttempts, 0);
    super(
      'PIN_WRONG',
      `رمز PIN غير صحيح — بقيت ${left} ${left === 1 ? 'محاولة' : 'محاولات'} قبل القفل المؤقت. تحقّق من الرمز وأعد المحاولة`,
    );
    this.name = 'PinWrongError';
    this.failedAttempts = failedAttempts;
    this.attemptsLeftBeforeLock = left;
    this.needsHardReset = failedAttempts >= PIN_HARD_RESET_THRESHOLD;
  }
}

/** الدخول مقفل مؤقتاً — الرسالة تُظهر الثواني المتبقية (عرض عدّاد في الواجهة) */
export class PinLockedError extends DomainError {
  readonly remainingSeconds: number;
  readonly needsHardReset: boolean;
  constructor(remainingSeconds: number, needsHardReset: boolean) {
    super(
      'PIN_LOCKED',
      `تم قفل الدخول مؤقتاً بعد محاولات خاطئة متكررة — أعد المحاولة بعد ${remainingSeconds} ثانية`,
    );
    this.name = 'PinLockedError';
    this.remainingSeconds = remainingSeconds;
    this.needsHardReset = needsHardReset;
  }
}

/** إعادة تصدير حرس الفترات من fiscal.ts (وحدة واحدة للحقن في الواجهات) */
export { FiscalPeriodClosedError } from './fiscal';
