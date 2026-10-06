/**
 * invoice-data.ts — محمّل بيانات الفاتورة للطباعة (من القاعدة → InvoicePrintData).
 *
 * يجمع في استعلام واحد منطقي: الفاتورة ببنودها (domain.getInvoiceWithItems)
 * + بيانات المنشأة + الطرف (عميل/مورد حسب نوع المستند) + العملة
 * (الرمز وعدد المنازل) + أسماء الأصناف — ثم يهيّئ عقد القالب النقي.
 *
 * نقية بلا React Native (نفس شروط invoice-html.ts) — قابلة للاختبار بـ bun
 * عبر test-adapter، وقابلة للاستهلاك من شاشات RN عبر أي SqliteAdapter.
 */
import type { SqliteAdapter } from '../db/adapter';
import { fetchProductDisplay } from '../db/queries';
import { getInvoiceWithItems } from '../domain/invoicing';
import { getCustomer, getSupplier } from '../domain/parties';
import { ar } from '../i18n/ar';
import type { InvoicePrintData, InvoicePrintItem, PrintDocType } from './invoice-html';

interface CompanyPrintRow {
  name: string;
  phone: string | null;
  address: string | null;
  footer_text: string | null;
}

interface CurrencyPrintRow {
  code: string;
  decimals: number;
}

/**
 * يحمّل فاتورة بمعرّفها ويهيّئ بيانات القالب.
 * يرمي أخطاء الدومين كما هي (فاتورة غير موجودة…) — المستدعي يعرض رسالتها.
 */
export async function loadInvoicePrintData(
  adapter: SqliteAdapter,
  invoiceId: number,
): Promise<InvoicePrintData> {
  const { invoice, items } = await getInvoiceWithItems(adapter, invoiceId);

  const productIds = items
    .map((it) => (it.product_id !== null ? Number(it.product_id) : 0))
    .filter((n) => Number.isInteger(n) && n > 0);

  const [companyRows, currencyRows, products, party] = await Promise.all([
    adapter.all<CompanyPrintRow>(
      'SELECT name, phone, address, footer_text FROM company ORDER BY id LIMIT 1',
    ),
    adapter.all<CurrencyPrintRow>('SELECT code, decimals FROM currency WHERE id = ?', [
      invoice.currency_id,
    ]),
    fetchProductDisplay(adapter, productIds),
    invoice.customer_id !== null
      ? getCustomer(adapter, Number(invoice.customer_id))
      : invoice.supplier_id !== null
        ? getSupplier(adapter, Number(invoice.supplier_id))
        : Promise.resolve(null),
  ]);

  const company = companyRows[0];
  const currency = currencyRows[0];
  const isPurchaseSide = invoice.doc_type === 'purchase' || invoice.doc_type === 'purchase_return';

  const printItems: InvoicePrintItem[] = items.map((it) => {
    const prod = it.product_id !== null ? products.get(Number(it.product_id)) : undefined;
    const name = prod ? prod.name : (it.line_desc ?? '');
    const isService = (prod?.isService ?? false) || it.product_id === null;
    return {
      name,
      isService,
      qty: it.qty,
      unitPrice: it.unit_price,
      discount: it.discount_amount,
      lineTotal: it.line_total,
    };
  });

  return {
    company: {
      name: company?.name ?? '',
      phone: company?.phone ?? null,
      address: company?.address ?? null,
      footerText:
        company?.footer_text && company.footer_text.trim() !== ''
          ? company.footer_text.trim()
          : ar.sales.print.tpl.defaultFooter,
    },
    docType: invoice.doc_type as PrintDocType,
    payStatus: invoice.pay_status as InvoicePrintData['payStatus'],
    status: invoice.status as InvoicePrintData['status'],
    invoiceNo: invoice.invoice_no,
    issuedAt: invoice.issued_at,
    party: party
      ? { name: party.name, phone: party.phone, whatsapp: party.whatsapp ?? null }
      : null,
    partyLabel: isPurchaseSide ? ar.sales.print.tpl.supplier : ar.sales.print.tpl.customer,
    currency: {
      code: currency?.code ?? '—',
      decimals: Number.isFinite(Number(currency?.decimals)) ? Number(currency?.decimals) : 2,
    },
    exchangeRate: invoice.exchange_rate,
    rateIsFallback: Number(invoice.rate_is_fallback) === 1,
    items: printItems,
    totals: {
      subtotal: invoice.subtotal,
      discount: invoice.discount_amount,
      tax: invoice.tax_amount,
      total: invoice.total,
      paid: invoice.paid_amount,
      due: invoice.due_amount,
    },
    notesPrinted: invoice.notes_printed,
    generatedAt: new Date().toISOString(),
  };
}
