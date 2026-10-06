/**
 * purchases/[id].tsx — تفاصيل مستند الشراء (شراء/مرتجع شراء):
 *  توجيه رفيع إلى InvoiceDetailsScreen المشترك (Task 8) بعائلة 'purchase':
 *  - «فاتورة شراء» + المورّد + شارة «حدّثت التكلفة المرجحة تلقائياً» (WAC)
 *    للشراء المكتمل — الأثر يقع داخل معاملة saveInvoice نفسها.
 *  - الطباعة/المشاركة (القالب يدعم فاتورة الشراء منذ المهمة 7) + الإلغاء
 *    (حركات معاكسة عبر الدومين) + **زر المرتجع** → ReturnFlow
 *    (/sales/[id]/return — يستنتج العائلة من doc_type الأصلي).
 */
import InvoiceDetailsScreen from '@/components/invoices/InvoiceDetailsScreen';

export default function PurchaseInvoiceDetailsRoute() {
  return <InvoiceDetailsScreen family="purchase" />;
}
