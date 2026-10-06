/**
 * voucher-data.ts — محمّل بيانات سند القبض/الصرف للطباعة (FR-04-10).
 *
 * يجمع في نداء واحد منطقياً: صف cash_tx + المنشأة + الطرف (عميل/مورد) +
 * العملة + التخصيصات (payment_allocation بأرقام فواتيرها) — ثم يهيّئ عقد
 * القالب النقي (VoucherPrintData).
 *
 * **ترقيم كسول عند أول طباعة (FR-04-10 حرفياً)**: voucher_no يُستهلك هنا عبر
 * domain.ensureVoucherNo إن كان فارغاً (الصفوف القديمة مثل نقدية الفواتير
 * المحفوظة بلا رقم)، وإلا يُعاد المخزن كما هو (خامل). الرقم لا يُعاد أبداً.
 *
 * نقية بلا React Native (نفس شروط invoice-data.ts) — قابلة للاختبار بـ bun
 * عبر test-adapter، وقابلة للاستهلاك من شاشات RN عبر أي SqliteAdapter.
 */
import type { SqliteAdapter } from '../db/adapter';
import { ensureVoucherNo } from '../domain/cash';
import { getCustomer, getSupplier } from '../domain/parties';
import { ar } from '../i18n/ar';
import { d, f4, sumD } from '../utils/money';
import type { VoucherAllocationPrint, VoucherPrintData } from './invoice-html';

interface CompanyPrintRow {
  name: string;
  phone: string | null;
  footer_text: string | null;
}

interface CashTxPrintRow {
  id: number;
  tx_type: string;
  cashbox_id: number;
  currency_id: number;
  amount: string;
  fx_gain_loss: string;
  voucher_no: string | null;
  tx_date: string;
  ref_type: string | null;
  ref_id: number | null;
  customer_id: number | null;
  supplier_id: number | null;
  is_voided: number;
  reversal_of: number | null;
  description: string | null;
}

/**
 * يحمّل حركة قبض/صرف بمعرّفها ويهيّئ بيانات قالب السند — مع استهلاك رقم
 * السند (RVT-/PMT-) عند أول طباعة. يرمي أخطاء الدومين كما هي (حركة غير
 * موجودة/نوع غير قابل للترقيم/ملغاة) — المستدعي يعرض رسالتها العربية.
 */
export async function loadVoucherPrintData(
  adapter: SqliteAdapter,
  cashTxId: number,
  opts: { createdBy?: number } = {},
): Promise<VoucherPrintData> {
  const txRows = await adapter.all<CashTxPrintRow>(
    'SELECT id, tx_type, cashbox_id, currency_id, amount, fx_gain_loss, voucher_no, tx_date, ref_type, ref_id, customer_id, supplier_id, is_voided, reversal_of, description FROM cash_tx WHERE id = ?',
    [cashTxId],
  );
  const tx = txRows[0];
  if (!tx) {
    throw new Error(`حركة الصندوق غير موجودة (معرّف ${cashTxId})`);
  }
  if (tx.tx_type !== 'receipt' && tx.tx_type !== 'payment') {
    throw new Error('طباعة السند للقبض والصرف فقط — هذه الحركة من نوع آخر');
  }

  // FR-04-10: الرقم يُستهلك عند أول طباعة (كسولاً) — الملغاة/المعاكسة يرفضها الدومين
  const voucherNo = await ensureVoucherNo(adapter, cashTxId, opts);

  const isReceipt = tx.tx_type === 'receipt';
  const [companyRows, currencyRows, cashboxRows, party, allocationRows, refInvoiceRows] = await Promise.all([
    adapter.all<CompanyPrintRow>(
      'SELECT name, phone, footer_text FROM company ORDER BY id LIMIT 1',
    ),
    adapter.all<{ code: string; decimals: number }>(
      'SELECT code, decimals FROM currency WHERE id = ?',
      [tx.currency_id],
    ),
    adapter.all<{ name: string }>('SELECT name FROM cashbox WHERE id = ?', [tx.cashbox_id]),
    tx.customer_id !== null
      ? getCustomer(adapter, Number(tx.customer_id))
      : tx.supplier_id !== null
        ? getSupplier(adapter, Number(tx.supplier_id))
        : Promise.resolve(null),
    adapter.all<{ invoice_no: string | null; allocated_amount: string }>(
      `SELECT i.invoice_no, pa.allocated_amount
       FROM payment_allocation pa JOIN invoice i ON i.id = pa.invoice_id
       WHERE pa.cash_tx_id = ?
       ORDER BY i.issued_at ASC, i.id ASC`,
      [cashTxId],
    ),
    // مستند المصدر عند حركات الفواتير — لتحديد جهة الطرف الصحيحة عند غياب
    // طرف مسجّل (مرتجع بيع نقدي لـ«عميل نقدي» يبقى عميلاً لا مورّداً).
    tx.ref_type === 'invoice' || tx.ref_type === 'invoice_void'
      ? adapter.all<{ doc_type: string; customer_name: string | null; supplier_name: string | null }>(
          `SELECT i.doc_type, c.name AS customer_name, s.name AS supplier_name
           FROM invoice i
           LEFT JOIN customer c ON c.id = i.customer_id
           LEFT JOIN supplier s ON s.id = i.supplier_id
           WHERE i.id = ?`,
          [tx.ref_id],
        )
      : Promise.resolve([] as { doc_type: string; customer_name: string | null; supplier_name: string | null }[]),
  ]);

  const company = companyRows[0];
  const currency = currencyRows[0];
  const allocatedSum = sumD(allocationRows.map((r) => r.allocated_amount));
  const allocations: VoucherAllocationPrint[] = allocationRows.map((r) => ({
    invoiceNo: r.invoice_no ?? String(r.allocated_amount),
    amount: f4(r.allocated_amount),
  }));
  // «الباقي على الحساب» دلالتها للسندات الحرة فقط (ref_type='on_account') —
  // نقدية الفواتير (ref_type='invoice') مربوطة بمستندها فلا «باقي» يُطبع.
  const isInvoiceTx = tx.ref_type === 'invoice' || tx.ref_type === 'invoice_void';
  // مستند المصدر (فواتير): يحدد جهة الطرف عند غياب طرف مسجّل — عائلة البيع
  // (INV/SRN) عميل دائماً وعائلة الشراء (PUR/PRN) مورّد دائماً، بمعزل عن
  // اتجاه النقد (مرتجع بيع نقدي = صرف لعميل، لا دفع مورّد).
  const refInvoice = refInvoiceRows[0] ?? null;
  const refIsPurchaseSide =
    refInvoice !== null &&
    (refInvoice.doc_type === 'purchase' || refInvoice.doc_type === 'purchase_return');
  // الطرف المسجّل من أعمدة السند، وإلا جهة مستند المصدر، وإلا استنتاج القبض/الصرف
  const partyLabel =
    tx.customer_id !== null
      ? ar.sales.print.tpl.customer
      : tx.supplier_id !== null
        ? ar.sales.print.tpl.supplier
        : refInvoice !== null
          ? refIsPurchaseSide
            ? ar.sales.print.tpl.supplier
            : ar.sales.print.tpl.customer
          : isReceipt
            ? ar.sales.print.tpl.customer
            : ar.sales.print.tpl.supplier;

  return {
    company: {
      name: company?.name ?? '',
      phone: company?.phone ?? null,
      footerText:
        company?.footer_text && company.footer_text.trim() !== ''
          ? company.footer_text.trim()
          : ar.cash.voucher.paper.defaultFooter,
    },
    docType: isReceipt ? 'receipt' : 'payment',
    voucherNo,
    txDate: tx.tx_date,
    // الطرف المسجّل أولاً، وإلا طرف مستند المصدر إن وُجد، وإلا يسمّيه القالب نقدياً
    partyName: party ? party.name : (refInvoice?.customer_name ?? refInvoice?.supplier_name ?? null),
    partyLabel,
    partyPhone: party?.phone ?? null,
    cashboxName: cashboxRows[0]?.name ?? '—',
    currency: {
      code: currency?.code ?? '—',
      decimals: Number.isFinite(Number(currency?.decimals)) ? Number(currency?.decimals) : 2,
    },
    amount: tx.amount,
    // الباقي «على الحساب» بعملة السند = المبلغ − Σ التخصيصات (بعملة السند عند
    // نفس العملة؛ التخصيص بعملة مختلفة يبقى بمبلغه الاسمي — عرض تقريبي فقط
    // والدومين صاحب الحساب الدقيق fx) — صفر مربوط بنقدية الفواتير.
    onAccount: isInvoiceTx ? '0.0000' : f4(d(tx.amount).minus(allocatedSum)),
    allocations,
    fxGainLoss: tx.fx_gain_loss,
    description: tx.description,
    generatedAt: new Date().toISOString(),
  };
}
