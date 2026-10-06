/**
 * settings-ext.ts — إعدادات المنشأة وبدء الترقيم (FR-13-01 لاحقاً / FR-13-02 — قرار 6).
 *
 * ما هذه الوحدة (نقية: adapter + zod فقط — NFR-09/11):
 *  1. updateCompanyProfile: تعديل بيانات المنشأة (اسم/هاتف/واتساب/عنوان/رقم ضريبي/
 *     تذييل الفاتورة/بادئة الترقيم) — تحقق + updated_at + قيد audit «company_update».
 *     ⚠️ رفع الشعار (logo) يتطلب image-picker أصلي → مؤجل V1.1 وموثّق (ملء
 *     logo_path من هذه الوحدة عند توفر المسار الأصلي لاحقاً).
 *  2. setDocSequenceStart: رقم البداية لكل نوع مستند — **يُعدَّل فقط قبل أول مستند
 *     من نوعه** (FR-13-02 / قرار 6): أي last_no > 0 = مرفوض برسالة صادقة.
 *     الترقيم 1-based: startNo ≥ 1 → يُخزَّن last_no = startNo − 1.
 *  3. listDocSequences: عدّادات السنة الجارية لكل الأنواع مع عدد المستندات الصادرة
 *     فعلاً (الفواتير المكتملة/الملغاة + السندات المرقّمة) لعرضها في شاشة الترقيم.
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { DomainRuleError, ValidationError } from './errors';
import { DOC_TYPES, type DocType } from './docseq';

/* ============================ 1) بيانات المنشأة ============================ */

export const CompanyProfileUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'اسم المنشأة مطلوب — لا يُحفظ اسم فارغ').optional(),
    phone: z.string().trim().optional().nullable(),
    whatsapp: z.string().trim().optional().nullable(),
    address: z.string().trim().optional().nullable(),
    taxNumber: z.string().trim().optional().nullable(),
    footerText: z.string().trim().optional().nullable(),
    invoicePrefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{2,6}$/, 'بادئة الترقيم: 2-6 أحرف لاتينية كبيرة أو أرقام (مثل INV أو FA2)')
      .optional(),
  })
  .strict();

export type CompanyProfileUpdate = z.input<typeof CompanyProfileUpdateSchema>;

interface CompanyCols {
  id: number;
  name: string;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
  tax_number: string | null;
  footer_text: string | null;
  invoice_prefix: string | null;
}

/** يعيد صف بيانات المنشأة (الأول) كما هو مخزَّن — لشاشة company.tsx */
export async function getCompanyProfile(
  adapter: SqliteAdapter,
): Promise<CompanyCols | null> {
  const rows = await adapter.all<CompanyCols>(
    'SELECT id, name, phone, whatsapp, address, tax_number, footer_text, invoice_prefix FROM company ORDER BY id LIMIT 1',
  );
  return rows[0] ?? null;
}

/**
 * يعدّل بيانات المنشأة (patch دلالي): الحقل غير المُرسل (undefined) يبقى كما هو،
 * وnull/'' تفرغ الحقل القابل للفراغ (الهاتف/العنوان/الضريبي/التذييل/واتساب).
 */
export async function updateCompanyProfile(
  adapter: SqliteAdapter,
  input: CompanyProfileUpdate,
): Promise<void> {
  const parsed = CompanyProfileUpdateSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `تحقّق من بيانات المنشأة — ${parsed.error.issues[0]?.message ?? 'بعض الحقول غير صالحة'}`,
      parsed.error.issues,
    );
  }
  const data = parsed.data;

  await adapter.transaction(async () => {
    const curRows = await adapter.all<CompanyCols>(
      'SELECT id, name, phone, whatsapp, address, tax_number, footer_text, invoice_prefix FROM company ORDER BY id LIMIT 1',
    );
    const cur = curRows[0];
    if (!cur) {
      throw new DomainRuleError(
        'COMPANY_NOT_FOUND',
        'لا توجد بيانات منشأة بعد — أكمل الإعداد الأول أولاً',
      );
    }

    /** نص قابل للفراغ: undefined = أبقِ الحالي، null/'' = فراغ، وإلا القيمة */
    const optClear = (next: string | null | undefined, current: string | null): string | null =>
      next === undefined ? current : next === null || next === '' ? null : next;

    const changed: string[] = [];
    const name = data.name !== undefined ? data.name : cur.name;
    const phone = optClear(data.phone, cur.phone);
    const whatsapp = optClear(data.whatsapp, cur.whatsapp);
    const address = optClear(data.address, cur.address);
    const taxNumber = optClear(data.taxNumber, cur.tax_number);
    const footerText = optClear(data.footerText, cur.footer_text);
    const invoicePrefix =
      data.invoicePrefix !== undefined ? data.invoicePrefix : cur.invoice_prefix;

    if (name !== cur.name) changed.push('name');
    if (phone !== cur.phone) changed.push('phone');
    if (whatsapp !== cur.whatsapp) changed.push('whatsapp');
    if (address !== cur.address) changed.push('address');
    if (taxNumber !== cur.tax_number) changed.push('taxNumber');
    if (footerText !== cur.footer_text) changed.push('footerText');
    if (invoicePrefix !== cur.invoice_prefix) changed.push('invoicePrefix');

    await adapter.run(
      `UPDATE company SET name = ?, phone = ?, whatsapp = ?, address = ?, tax_number = ?,
         footer_text = ?, invoice_prefix = ?, updated_at = ?
       WHERE id = ?`,
      [
        name,
        phone,
        whatsapp,
        address,
        taxNumber,
        footerText,
        invoicePrefix,
        new Date().toISOString(),
        Number(cur.id),
      ],
    );

    await adapter.run(
      'INSERT INTO audit_log (user_id, action, entity, entity_id, details, at) VALUES (NULL, ?, ?, ?, ?, ?)',
      [
        'company_update',
        'company',
        Number(cur.id),
        JSON.stringify({ changed }),
        new Date().toISOString(),
      ],
    );
  });
}

/* ============================ 2) بدء الترقيم ============================ */

const YEAR_RE = /^\d{4}$/;

/**
 * يضبط رقم البداية لنوع مستند في سنة — **فقط قبل إصدار أول مستند من نوعه**
 * (FR-13-02 / قرار 6). startNo ≥ 1 (ترقيم 1-based) ويُخزَّن last_no = startNo − 1.
 */
export async function setDocSequenceStart(
  adapter: SqliteAdapter,
  docType: DocType,
  year: number,
  startNo: number,
): Promise<void> {
  if (!DOC_TYPES.includes(docType)) {
    throw new ValidationError(`نوع مستند غير معروف: ${docType}`);
  }
  if (!Number.isInteger(year) || !YEAR_RE.test(String(year)) || year < 2000 || year > 2100) {
    throw new ValidationError('السنة غير صالحة — أدخل سنة من 2000 إلى 2100');
  }
  if (!Number.isInteger(startNo) || startNo < 1) {
    throw new ValidationError('رقم البداية يجب أن يكون 1 أو أكبر — الترقيم يبدأ من 1');
  }

  await adapter.transaction(async () => {
    const rows = await adapter.all<{ last_no: number | string }>(
      'SELECT last_no FROM doc_sequence WHERE doc_type = ? AND year = ?',
      [docType, year],
    );
    const lastNo = rows[0] ? Number(rows[0].last_no) : 0;
    if (lastNo > 0) {
      throw new DomainRuleError(
        'DOCSEQ_STARTED',
        `صدرت مستندات من هذا النوع (${docType}-${year}) — الرقم لا يُعدَّل بعد الإصدار (قرار 6)`,
      );
    }

    await adapter.run(
      `INSERT INTO doc_sequence (doc_type, year, last_no) VALUES (?, ?, ?)
       ON CONFLICT(doc_type, year) DO UPDATE SET last_no = excluded.last_no`,
      [docType, year, startNo - 1],
    );

    await adapter.run(
      'INSERT INTO audit_log (user_id, action, entity, entity_id, details, at) VALUES (NULL, ?, ?, NULL, ?, ?)',
      [
        'docseq_start',
        'doc_sequence',
        JSON.stringify({ docType, year, startNo }),
        new Date().toISOString(),
      ],
    );
  });
}

/* ============================ 3) عرض العدّادات ============================ */

export interface DocSequenceRowInfo {
  docType: DocType;
  year: number;
  /** آخر رقم مستهلك (0 = لم يصدر شيء بعد — قابل لضبط البداية) */
  lastNo: number;
  /** عدد المستندات الصادرة فعلاً بهذا النوع هذه السنة */
  issuedCount: number;
  /** الرقم التالي بصيغته النهائية PREFIX-YYYY-NNNNN */
  nextNo: string;
  /** true = صدرت مستندات — البداية مقفلة (قرار 6) */
  locked: boolean;
}

/** خريطة النوع → نوع الفاتورة المقابل في جدول invoice (لسورت الأعداد) */
const INVOICE_DOC_MAP: Partial<Record<DocType, string>> = {
  INV: 'sale',
  PUR: 'purchase',
  SRN: 'sale_return',
  PRN: 'purchase_return',
};

/** سنة اليوم المحلية (YYYY) — عدّادات السنة الجارية */
function currentYear(): number {
  return new Date().getFullYear();
}

/**
 * عدّادات الترقيم لكل الأنواع الستة لسنة معيّنة (الافتراضي: السنة الجارية)،
 * مع عدد المستندات الصادرة فعلاً: الفواتير المكتملة/الملغاة (draft لا تستهلك
 * رقماً) والسندات التي استهلكت رقماً (voucher_no يبدأ بالنوع).
 */
export async function listDocSequences(
  adapter: SqliteAdapter,
  year = currentYear(),
): Promise<DocSequenceRowInfo[]> {
  // بادئة فواتير البيع من المنشأة (قرار 6: PREFIX-YYYY-NNNNN) — البقية بأنواعها
  const prefixRows = await adapter.all<{ invoice_prefix: string | null }>(
    'SELECT invoice_prefix FROM company ORDER BY id LIMIT 1',
  );
  const invPrefix = prefixRows[0]?.invoice_prefix ?? 'INV';

  const out: DocSequenceRowInfo[] = [];
  for (const docType of DOC_TYPES) {
    const seqRows = await adapter.all<{ last_no: number | string }>(
      'SELECT last_no FROM doc_sequence WHERE doc_type = ? AND year = ?',
      [docType, year],
    );
    const lastNo = seqRows[0] ? Number(seqRows[0].last_no) : 0;

    let issuedCount = 0;
    const invoiceType = INVOICE_DOC_MAP[docType];
    if (invoiceType) {
      const rows = await adapter.all<{ c: number | string }>(
        `SELECT COUNT(*) AS c FROM invoice
         WHERE doc_type = ? AND status IN ('completed','void') AND substr(issued_at, 1, 4) = ?`,
        [invoiceType, String(year)],
      );
      issuedCount = Number(rows[0]?.c ?? 0);
    } else {
      // RVT/PMT — السندات المرقّمة (الرقم يُستهلك كسولاً عند أول طباعة)
      const rows = await adapter.all<{ c: number | string }>(
        `SELECT COUNT(*) AS c FROM cash_tx
         WHERE voucher_no LIKE ? AND substr(tx_date, 1, 4) = ?`,
        [`${docType}-${year}-%`, String(year)],
      );
      issuedCount = Number(rows[0]?.c ?? 0);
    }

    out.push({
      docType,
      year,
      lastNo,
      issuedCount,
      nextNo: `${docType === 'INV' ? invPrefix : docType}-${year}-${String(lastNo + 1).padStart(5, '0')}`,
      locked: lastNo > 0,
    });
  }
  return out;
}
