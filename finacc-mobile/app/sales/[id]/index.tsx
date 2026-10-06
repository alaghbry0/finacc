/**
 * sales/[id]/index.tsx — تفاصيل مستند البيع (بيع/مرتجع بيع):
 *  توجيه رفيع إلى InvoiceDetailsScreen المشترك (Task 8) — كل المنطق
 *  والعرض في src/components/invoices/InvoiceDetailsScreen.tsx (family='sale'
 *  يشاركه مسار /purchases/[id] بعائلة 'purchase').
 */
import InvoiceDetailsScreen from '@/components/invoices/InvoiceDetailsScreen';

export default function SaleInvoiceDetailsRoute() {
  return <InvoiceDetailsScreen family="sale" />;
}
