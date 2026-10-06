/**
 * queries-analytics.ts — استعلامات قراءة شاشات تقارير التحليلات (Task 17).
 *
 * قراءة فقط (لا كتابة ولا منطق أعمال — حكر Domain): أدوات مساندة لشاشات
 * app/reports/*: منتقي أصناف بطاقة الصنف (بحث بالاسم/الباركود مع الرصيد
 * الكلي عبر المخازن). المبالغ TEXT تُجمَع بـ Decimal في الذاكرة
 * (قاعدة queries.ts — لا SUM رقمي في SQL).
 *
 * queries.ts نفسه لم يُمس (ملكية موزعة): الفترات من domain/reports.ts
 * والعملات من queries.ts تُستورد مباشرة من مستهلكيها.
 */
import type { SqliteAdapter } from './adapter';
import { d, f3 } from '@/utils/money';

/* ============ منتقي أصناف بطاقة الصنف (FR-09-03) ============ */

export interface ProductPickerRow {
  id: number;
  name: string;
  barcode: string | null;
  unitName: string | null;
  isArchived: boolean;
  /** الرصيد الكلي عبر كل المخازن (3dp) — بلا فلتر مخزن: الأمانة أولى */
  stockQty: string;
}

/**
 * أصناف مخزنية (غير خدمية — الخدمي بلا بطاقة حركات) للبحث والانتقاء:
 * يطابق الاسم أو الباركود (احتواء)، بترتيب الاسم والنشيط أولاً. يشمل
 * المؤرشف (سجله يبقى في التقارير — FR-01-15) بعلامته للعرض الصادق.
 */
export async function searchStockProducts(
  adapter: SqliteAdapter,
  search: string,
  limit = 30,
): Promise<ProductPickerRow[]> {
  const trimmed = search.trim();
  const like = `%${trimmed}%`;
  const filter =
    trimmed === ''
      ? ''
      : 'AND (p.name LIKE ? OR (p.barcode IS NOT NULL AND p.barcode LIKE ?))';
  const params =
    trimmed === '' ? [] : [like, like];

  const rows = await adapter.all<{
    id: number;
    name: string;
    barcode: string | null;
    unit_name: string | null;
    is_archived: number;
  }>(
    `SELECT p.id, p.name, p.barcode, u.name AS unit_name, p.is_archived
     FROM product p
     LEFT JOIN unit u ON u.id = p.unit_id
     WHERE p.is_service = 0 ${filter}
     ORDER BY p.is_archived ASC, p.name ASC
     LIMIT ${Math.min(Math.max(limit, 1), 60)}`,
    params,
  );
  if (rows.length === 0) return [];

  // الرصيد الكلي عبر كل المخازن — Decimal في الذاكرة (لا SUM رقمي)
  const ids = rows.map((r) => Number(r.id));
  const levels = await adapter.all<{ product_id: number; qty: string }>(
    `SELECT product_id, qty FROM stock_level WHERE product_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  const totals = new Map<number, ReturnType<typeof d>>();
  for (const l of levels) {
    const pid = Number(l.product_id);
    totals.set(pid, (totals.get(pid) ?? d(0)).plus(d(l.qty)));
  }

  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    barcode: r.barcode,
    unitName: r.unit_name,
    isArchived: Number(r.is_archived) === 1,
    stockQty: f3(totals.get(Number(r.id)) ?? d(0)),
  }));
}
