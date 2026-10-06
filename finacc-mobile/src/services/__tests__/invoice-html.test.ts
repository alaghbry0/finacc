/**
 * invoice-html.test.ts — اختبارات قالب الفاتورة المطبوعة (نقية — bun).
 *
 * القلب النقي للمهمة 7: يُغذّى بعينات بيانات مطبوعة ويُتحقق من المستند
 * الناتج: الاتجاه RTL، العنوان، الرقم، البنود، حساب الإجماليات، العلامة
 * المائية للملغاة، التذييل، التهريب، وشارة السعر التقديري.
 * + اختبارات تكامل عبر القاعدة (seed → saveInvoice → load → build).
 */
import { describe, expect, test } from 'bun:test';
import { buildInvoiceHtml, type InvoicePrintData } from '../invoice-html';
import { loadInvoicePrintData } from '../invoice-data';
import { recordOpeningStock } from '../../domain/inventory';
import { saveInvoice, type LineInput, type SaveInvoiceInput } from '../../domain/invoicing';
import { daysAgoISO, seededDb } from '../../domain/__tests__/seed';
import { d } from '../../utils/money';

const TODAY = new Date().toISOString().slice(0, 10);

/** عينة بيع نقدي: متجر النور، حليب 115 + توصيل خدمي 500 = 615 */
function sampleSale(overrides: Partial<InvoicePrintData> = {}): InvoicePrintData {
  return {
    company: {
      name: 'متجر النور',
      phone: '712345678',
      address: 'صنعاء — شارع الستين',
      footerText: 'شكراً لتعاملكم معنا',
    },
    docType: 'sale',
    payStatus: 'cash',
    status: 'completed',
    invoiceNo: 'INV-2026-00003',
    issuedAt: '2026-10-07',
    party: { name: 'أحمد صالح', phone: '733221100', whatsapp: '733221100' },
    partyLabel: 'العميل',
    currency: { code: 'YER', decimals: 0 },
    exchangeRate: '1.000000',
    rateIsFallback: false,
    items: [
      { name: 'حليب المراعي لتر', isService: false, qty: '1.000', unitPrice: '115.0000', discount: '0.0000', lineTotal: '115.0000' },
      { name: 'توصيل طلب', isService: true, qty: '1.000', unitPrice: '500.0000', discount: '0.0000', lineTotal: '500.0000' },
    ],
    totals: {
      subtotal: '615.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '615.0000',
      paid: '615.0000',
      due: '0.0000',
    },
    notesPrinted: 'البضاعة تباع بلا ضمان بعد الفحص',
    generatedAt: '2026-10-07T14:35:00.000Z',
    ...overrides,
  };
}

describe('buildInvoiceHtml — القالب النقي', () => {
  test('مستند RTL عربي كامل: lang=ar وdir=rtl وDOCTYPE وميتا charset', () => {
    const html = buildInvoiceHtml(sampleSale());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('<meta charset="utf-8">');
  });

  test('الرأس: اسم المنشأة كبيراً + الهاتف + العنوان + عنوان المستند «فاتورة مبيعات»', () => {
    const html = buildInvoiceHtml(sampleSale());
    expect(html).toContain('متجر النور');
    expect(html).toContain('هاتف: 712345678');
    expect(html).toContain('صنعاء — شارع الستين');
    expect(html).toContain('فاتورة مبيعات');
  });

  test('الميتا: الرقم INV والتاريخ العربي والعميل بهاتفه والعملة', () => {
    const html = buildInvoiceHtml(sampleSale());
    expect(html).toContain('INV-2026-00003');
    expect(html).toContain('الأربعاء 07 أكتوبر 2026');
    expect(html).toContain('أحمد صالح');
    expect(html).toContain('733221100');
    expect(html).toContain('YER');
  });

  test('الجدول: كل أسماء البنود + شارة خدمة + ترويسات الأعمدة', () => {
    const html = buildInvoiceHtml(sampleSale());
    expect(html).toContain('حليب المراعي لتر');
    expect(html).toContain('توصيل طلب');
    expect(html).toContain('خدمة');
    for (const head of ['الصنف', 'الكمية', 'السعر', 'الخصم', 'الإجمالي']) {
      expect(html).toContain(`>${head}<`);
    }
  });

  test('الإجماليات تطابق المدخلات: المجموع الفرعي والإجمالي والمدفوع (YER صفر منازل) — ولا صف ضريبة عند صفرها', () => {
    const html = buildInvoiceHtml(sampleSale());
    expect(html).toContain('المجموع الفرعي');
    expect(html).toContain('>615<');
    expect(html).toContain('المدفوع');
    expect(html).not.toContain('>الضريبة<');
  });

  test('الكسور تنسّق بمنازل العملة (SAR = 2): 1234.5 → 1,234.50 + صف الخصم والمتبقي', () => {
    const html = buildInvoiceHtml(
      sampleSale({
        currency: { code: 'SAR', decimals: 2 },
        totals: {
          subtotal: '1234.5000',
          discount: '34.5000',
          tax: '0.0000',
          total: '1200.0000',
          paid: '700.0000',
          due: '500.0000',
        },
      }),
    );
    expect(html).toContain('1,234.50');
    expect(html).toContain('34.50');
    expect(html).toContain('1,200.00');
    expect(html).toContain('الخصم');
    expect(html).toContain('المتبقي');
  });

  test('العلامة المائية «ملغاة» تظهر للملغاة فقط (الملغاة تطبع للأرشيف)', () => {
    const voided = buildInvoiceHtml(sampleSale({ status: 'void' }));
    expect(voided).toContain('void-mark');
    expect(voided).toContain('ملغاة');
    const active = buildInvoiceHtml(sampleSale());
    expect(active).not.toContain('void-mark');
    expect(active).not.toContain('>ملغاة<');
  });

  test('شارة «سعر تقديري» تظهر فقط عند rate_is_fallback', () => {
    const fb = buildInvoiceHtml(sampleSale({ rateIsFallback: true }));
    expect(fb).toContain('سعر تقديري');
    const plain = buildInvoiceHtml(sampleSale());
    expect(plain).not.toContain('سعر تقديري');
  });

  test('التذييل: نص الشكر + الملاحظة المطبوعة + «طُبعت بواسطة المُحاسِب الشخصي»', () => {
    const html = buildInvoiceHtml(sampleSale());
    expect(html).toContain('شكراً لتعاملكم معنا');
    expect(html).toContain('البضاعة تباع بلا ضمان بعد الفحص');
    expect(html).toContain('طُبعت بواسطة المُحاسِب الشخصي');
  });

  test('التهريب: أسماء/ملاحظات تحمل HTML لا تكسر المستند', () => {
    const html = buildInvoiceHtml(
      sampleSale({
        party: { name: 'أحمد <b>&"تاجر"</b>', phone: null, whatsapp: null },
        notesPrinted: '<script>alert(1)</script>',
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('أحمد &lt;b&gt;&amp;&quot;تاجر&quot;&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('التكامل: من القاعدة إلى الورقة (save → load → build)', () => {
  test('فاتورة نقدي حقيقية: الرقم والأصناف والإجمالي 730 واسم المتجر في المستند', async () => {
    const { db, seed } = await seededDb();
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('10'),
      unitCost: d('90'),
      movedAt: daysAgoISO(6),
    });
    const lines: LineInput[] = [
      { productId: seed.milkId, qty: '2', unitPrice: '115' },
      { productId: seed.deliveryId, qty: '1', unitPrice: '500' },
    ];
    const input: SaveInvoiceInput = {
      docType: 'sale',
      payStatus: 'cash',
      issuedAt: TODAY,
      customerId: seed.customerId,
      cashboxId: seed.cashboxId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines,
    };
    const res = await saveInvoice(db, input);
    expect(res.invoiceNo).toBe(`INV-${new Date().getUTCFullYear()}-00001`);

    const data = await loadInvoicePrintData(db, res.invoiceId);
    expect(data.company.name).toBe('متجر الاختبار');
    expect(data.party?.name).toBe('أحمد');
    expect(data.partyLabel).toBe('العميل');
    expect(data.items.map((i) => i.name)).toEqual(['حليب المراعي', 'توصيل']);
    expect(data.items[1]!.isService).toBe(true);
    expect(data.currency.decimals).toBe(0);

    const html = buildInvoiceHtml(data);
    expect(html).toContain(`INV-${new Date().getUTCFullYear()}-00001`);
    expect(html).toContain('متجر الاختبار');
    expect(html).toContain('حليب المراعي');
    expect(html).toContain('فاتورة مبيعات');
    expect(html).toContain('>730<');
    expect(html).toContain('شكراً لتعاملكم معنا'); // الافتراضي عند غياب footer_text
  });

  test('فاتورة آجل: المتبقي يظهر في بيانات الطباعة والقالب', async () => {
    const { db, seed } = await seededDb();
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('10'),
      unitCost: d('90'),
      movedAt: daysAgoISO(6),
    });
    const res = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: TODAY,
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    } satisfies SaveInvoiceInput);
    const data = await loadInvoicePrintData(db, res.invoiceId);
    expect(data.totals.due).toBe('115.0000');
    const html = buildInvoiceHtml(data);
    expect(html).toContain('المتبقي');
    expect(html).toContain('>115<');
  });
});
