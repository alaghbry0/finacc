/**
 * doc-routes.ts — توجيه شاشات المستندات حسب نوعها (Task 8):
 *  البيع ومردوده → /sales/[id]، الشراء ومردوده → /purchases/[id].
 * قائمة الفواتير وبطاقات «مرتجع مرتبط/الأصل» تشترك في هذا المسار الواحد.
 */
export type DocFamily = 'sale' | 'purchase';

/** عائلة المستند من doc_type (sale/sale_return → 'sale'؛ purchase/purchase_return → 'purchase') */
export function docFamilyOf(docType: string): DocFamily {
  return docType === 'purchase' || docType === 'purchase_return' ? 'purchase' : 'sale';
}

/** مسار تفاصيل المستند حسب نوعه */
export function invoiceRoute(id: number, docType: string): string {
  return docFamilyOf(docType) === 'purchase' ? `/purchases/${id}` : `/sales/${id}`;
}
