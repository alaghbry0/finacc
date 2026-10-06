/**
 * docseq.ts — الترقيم الذري للمستندات (SRS §5.4-1 + ملحق د — قرار 6).
 *
 * الصيغة: PREFIX-YYYY-NNNNN (5 أرقام مملوءة بأصفار).
 * الأنواع: INV/PUR/SRN/PRN/RVT/PMT (QTE تُضاف في V1.1).
 *
 * الاستهلاك عبر UPSERT ذري واحد:
 *   INSERT INTO doc_sequence(doc_type, year, last_no) VALUES(?, ?, 1)
 *     ON CONFLICT(doc_type, year) DO UPDATE SET last_no = last_no + 1
 *     RETURNING last_no;
 *
 * ⚠️ MAX+1 محرَّم قطعياً (SRS 5.4-1) — يتكرر عند الكتابة المتوازية/الضغط المزدوج.
 *
 * الذرّية: الاستهلاك جزء من transaction حفظ المستند (المستود + البنود + الحركات +
 * الرقم) — فشل أي خطوة يرجع الرقم مع الكل (الرقم لم «يصدر» بعد فلا يُخالف
 * «لا إعادة استخدام»). عند النداء المستقل: جملة UPSERT واحدة = وحدة كتابة واحدة
 * ذرّية في SQLite — آمنة حتى مع نداءات متوازية (المحرّك يُسلّم الكتابات).
 */
import type { SqliteAdapter } from '../db/adapter';

export type DocType = 'INV' | 'PUR' | 'SRN' | 'PRN' | 'RVT' | 'PMT';

export const DOC_TYPES: readonly DocType[] = ['INV', 'PUR', 'SRN', 'PRN', 'RVT', 'PMT'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** تنسيق الرقم النهائي: PREFIX-YYYY-NNNNN (ملحق د) */
export function formatDocNo(prefix: string, year: number, lastNo: number): string {
  return `${prefix}-${year}-${String(lastNo).padStart(5, '0')}`;
}

/**
 * يستهلك الرقم التالي للمستند ويعيد صيغته النهائية «PREFIX-YYYY-NNNNN».
 *
 * @param adapter   مهايئ القاعدة (ضمن transaction الحفظ عند الاستخدام الفعلي)
 * @param docType   نوع المستند (INV/PUR/SRN/PRN/RVT/PMT)
 * @param dateISO   تاريخ المستند YYYY-MM-DD — السنة تُشتق منه (عدّاد لكل سنة)
 * @param prefix    بادئة الترقيم (من إعدادات المخزن، مثل 'INV')
 */
export async function nextDocNo(
  adapter: SqliteAdapter,
  docType: DocType,
  dateISO: string,
  prefix: string,
): Promise<string> {
  if (!DOC_TYPES.includes(docType)) {
    throw new Error(`نوع مستند غير معروف: ${docType}`);
  }
  if (!DATE_RE.test(dateISO)) {
    throw new Error(`تاريخ غير صالح (المتوقع YYYY-MM-DD): ${dateISO}`);
  }
  const year = Number(dateISO.slice(0, 4));

  const rows = await adapter.all<{ last_no: number | string }>(
    `INSERT INTO doc_sequence(doc_type, year, last_no) VALUES(?, ?, 1)
     ON CONFLICT(doc_type, year) DO UPDATE SET last_no = last_no + 1
     RETURNING last_no`,
    [docType, year],
  );
  const row = rows[0];
  if (!row) {
    // نظرياً مستحيل مع RETURNING — حماية نوعية
    throw new Error('فشل استهلاك رقم المستند (لا نتيجة من UPSERT)');
  }
  return formatDocNo(prefix, year, Number(row.last_no));
}
