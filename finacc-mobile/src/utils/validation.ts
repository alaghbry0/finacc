/**
 * validation.ts — تحويل أخطاء Domain/زود إلى رسائل مرتبطة بالحقول للعرض Inline.
 *
 * القاعدة: الشاشات لا تفكّ أخطاء زود يدوياً — هذا المساعد هو المسار الموحد:
 *  - ValidationError (زود) → خريطة { حقل: رسالة } عبر مسارات المشاكل.
 *  - DomainRuleError → رسالة عامة + ربط اختياري بحقل عبر خريطة أكواد (لكل شاشة
 *    أكوادها الخاصة: BARCODE_TAKEN → barcode مثلاً).
 *
 * وحدة نقية (لا react-native) — قابلة للاختبار.
 */
import { DomainError, ValidationError } from '@/domain/errors';

/** حقل → رسالة خطأ (مفتاح '_form' = رسالة عامة خارج حقول معينة) */
export type FieldErrors = Record<string, string>;

/**
 * mapZodError — يحوّل خطأ تحقق زود إلى خريطة حقل → رسالة.
 * أول مشكلة لكل حقل تفوز (زود قد ينتج عدة مشاكل للحقل الواحد).
 * أي خطأ آخر (قاعدة عمل/برمجي) → خريطة فارغة (استعمل domainErrorMessage).
 */
export function mapZodError(err: unknown): FieldErrors {
  if (!(err instanceof ValidationError)) return {};
  const out: FieldErrors = {};
  for (const issue of err.issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : '_form';
    if (out[field] === undefined) out[field] = issue.message;
  }
  return out;
}

/**
 * fieldError — رسالة حقل واحد من الخريطة (null عند غيابها).
 */
export function fieldError(fields: FieldErrors, field: string): string | null {
  return fields[field] ?? null;
}

/**
 * domainErrorMessage — الرسالة العربية الجاهزة للعرض لأي خطأ Domain
 * ( ValidationError رسالته العامة، DomainRuleError رسالته المبنية §6.3 ).
 */
export function domainErrorMessage(err: unknown): string | null {
  if (err instanceof DomainError) return err.message;
  if (err instanceof Error) return err.message;
  return null;
}

/**
 * mapErrorToFields — المسار الكامل الموحد للشاشات:
 *  1. زود → خريطة الحقول (inline).
 *  2. DomainRuleError مرتبط بحقل عبر codeField → خريطة أيضاً
 *     (مثل BARCODE_TAKEN على خانة الباركود).
 *  3. ما سواه → رسالة عامة تحت '_form' (تُعرض في FeedbackBar).
 */
export function mapErrorToFields(err: unknown, codeField: Record<string, string> = {}): FieldErrors {
  const zod = mapZodError(err);
  if (Object.keys(zod).length > 0) return zod;
  if (err instanceof DomainError) {
    const field = codeField[err.code];
    if (field) return { [field]: err.message };
    return { _form: err.message };
  }
  return {};
}

/** الخطأ التقني للعرض في ErrorState (اسم الصنف: رسالة) */
export function technicalText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
