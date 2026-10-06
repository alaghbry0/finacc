/**
 * statement-html.test.ts — اختبارات كشف حساب الطرف المطبوع (المهمة 11 — FR-03-04).
 *
 * القسم النقي: بناء ورقة الكشف (buildStatementHtml) بعينات بيانات — الاتجاه RTL،
 * عنوان «كشف حساب عميل/مورد»، الملخص (أول المدة/عدد الحركات/الختامي)، جدول
 * السطور برصيد متحرك وإشارات الاتجاه +/−، سطر الإرشاد، تذييل قرار 8، التهريب،
 * والتاريخ القصير. + رسالة الواتساب (شكلها وحدّ 10 سطور) + أعمار الديون النقية.
 * القسم التكاملي: القاعدة → افتتاحي + فاتورة آجلة + سند قبض →
 * loadStatementPrintData → القالب (وفترة from بسطر «رصيد أول المدة»).
 */
import { describe, expect, test } from 'bun:test';
import { buildStatementHtml, statementShortDate } from '../statement-html';
import {
  computeAgingBuckets,
  loadStatementPrintData,
  type StatementPrintData,
} from '../statement-data';
import { buildStatementWhatsAppMessage } from '../statement-share';
import { recordOpeningStock } from '../../domain/inventory';
import { saveInvoice, type SaveInvoiceInput } from '../../domain/invoicing';
import { recordVoucher } from '../../domain/cash';
import { getOpenInvoicesForParty } from '../../db/queries';
import { daysAgoISO, seededDb } from '../../domain/__tests__/seed';
import { d } from '../../utils/money';
import type { StatementLine } from '../../domain/statement';

const TODAY = new Date().toISOString().slice(0, 10);
const YEAR = new Date().getUTCFullYear();

/** عينة كشف عميل: متجر النور — أحمد صالح، افتتاحي 5000 + فاتورة 230 − قبض 100 */
function sampleStatement(overrides: Partial<StatementPrintData> = {}): StatementPrintData {
  const lines: StatementLine[] = [
    {
      date: '0000-00-00',
      docKind: 'opening',
      docNo: null,
      description: 'رصيد افتتاحي',
      direction: 'debit',
      amount: '5000.0000',
      runningBalance: '5000.0000',
    },
    {
      date: '2026-10-07',
      docKind: 'invoice',
      docNo: 'INV-2026-00002',
      description: 'فاتورة بيع آجلة INV-2026-00002',
      direction: 'debit',
      amount: '230.0000',
      runningBalance: '5230.0000',
    },
    {
      date: '2026-10-08',
      docKind: 'receipt',
      docNo: 'RVT-2026-00001',
      description: 'سند قبض RVT-2026-00001 — تخصيص لفاتورة INV-2026-00002',
      direction: 'credit',
      amount: '100.0000',
      runningBalance: '5130.0000',
    },
  ];
  return {
    company: { name: 'متجر النور', phone: '712345678', footerText: 'شكراً لتعاملكم معنا' },
    partyType: 'customer',
    partyName: 'أحمد صالح',
    partyLabel: 'العميل',
    partyPhone: '733221100',
    currency: { code: 'YER', decimals: 0 },
    period: { from: '2026-01-01', to: '2026-10-08', text: 'من 01 يناير 2026 حتى 08 أكتوبر 2026' },
    openingBalance: '5000.0000',
    closingBalance: '5130.0000',
    lineCount: lines.length,
    lines,
    generatedAt: '2026-10-08T10:20:00.000Z',
    ...overrides,
  };
}

describe('buildStatementHtml — ورقة الكشف النقية', () => {
  test('مستند RTL عربي كامل: DOCTYPE وlang=ar وdir=rtl وcharset', () => {
    const html = buildStatementHtml(sampleStatement());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('<meta charset="utf-8">');
  });

  test('عرض الورقة 420px مثل الفاتورة (A5 تقريباً)', () => {
    const html = buildStatementHtml(sampleStatement());
    expect(html).toContain('width: 420px');
  });

  test('الرأس: المنشأة + الهاتف + عنوان «كشف حساب عميل» — والمورد يقلب العنوان والجهة', () => {
    const customer = buildStatementHtml(sampleStatement());
    expect(customer).toContain('متجر النور');
    expect(customer).toContain('هاتف: 712345678');
    expect(customer).toContain('كشف حساب عميل');
    expect(customer).toContain('العميل');
    const supplier = buildStatementHtml(
      sampleStatement({ partyType: 'supplier', partyLabel: 'المورد' }),
    );
    expect(supplier).toContain('كشف حساب مورد');
    expect(supplier).toContain('المورد');
    expect(supplier).not.toContain('كشف حساب عميل');
  });

  test('الميتا: الطرف بهاتفه + الفترة + العملة', () => {
    const html = buildStatementHtml(sampleStatement());
    expect(html).toContain('أحمد صالح');
    expect(html).toContain('733221100');
    expect(html).toContain('من 01 يناير 2026 حتى 08 أكتوبر 2026');
    expect(html).toContain('YER');
  });

  test('الملخص: رصيد أول المدة + عدد الحركات + الرصيد الختامي بتسمية اتجاهه', () => {
    const html = buildStatementHtml(sampleStatement());
    expect(html).toContain('رصيد أول المدة');
    expect(html).toContain('عدد الحركات');
    expect(html).toContain('3 حركة');
    expect(html).toContain('الرصيد الختامي');
    expect(html).toContain('5,000');
    expect(html).toContain('5,130');
    expect(html).toContain('مستحق عليه');
  });

  test('الجدول: ترويسات الأعمدة الخمسة (التاريخ/البيان/المستند/المبلغ/الرصيد)', () => {
    const html = buildStatementHtml(sampleStatement());
    for (const head of ['التاريخ', 'البيان', 'المستند', 'المبلغ', 'الرصيد']) {
      expect(html).toContain(`>${head}<`);
    }
  });

  test('السطور: أرقام المستندات + إشارات الاتجاه +/− + الرصيد المتحرك', () => {
    const html = buildStatementHtml(sampleStatement());
    expect(html).toContain('INV-2026-00002');
    expect(html).toContain('RVT-2026-00001');
    // مدين بإشارة + ودائن بإشارة − (علامة غير لونية DS-18 للطباعة الأحادية)
    expect(html).toContain('+230');
    expect(html).toContain('-100');
    // الرصيد المتحرك بعد القبض
    expect(html).toContain('5,230');
    expect(html).toContain('5,130');
  });

  test('سطر الإرشاد (عملات أخرى): صف note-row بلا مبلغ — والافتتاحي بلا تاريخ «—»', () => {
    const withNote = buildStatementHtml(
      sampleStatement({
        lines: [
          sampleStatement().lines[0]!,
          {
            date: '2026-10-08',
            docKind: 'note',
            docNo: null,
            description: 'لدى الطرف أرصدة بعملات أخرى (SAR)',
            direction: 'none',
            amount: '0.0000',
            runningBalance: '5000.0000',
          },
        ],
        lineCount: 2,
      }),
    );
    expect(withNote).toContain('note-row');
    expect(withNote).toContain('لدى الطرف أرصدة بعملات أخرى');
    // الافتتاحي 0000-00-00 يطبع «—» في خانة التاريخ
    expect(withNote).toContain('رصيد افتتاحي');
  });

  test('التذييل: ملاحظة قرار 8 (فرق الصرف بند مستقل) + طابع «طُبعت بواسطة» + الشكر', () => {
    const html = buildStatementHtml(sampleStatement());
    expect(html).toContain('الكشف بعملة واحدة ويتوازن دائماً');
    expect(html).toContain('فرق الصرف يُعرض بنداً مستقلاً في الأرباح');
    expect(html).toContain('طُبعت بواسطة المُحاسِب الشخصي');
    expect(html).toContain('شكراً لتعاملكم معنا');
  });

  test('التهريب: اسم/بيان يحملان HTML لا يكسران المستند', () => {
    const html = buildStatementHtml(
      sampleStatement({
        partyName: 'أحمد <b>&"تاجر"</b>',
        lines: [
          {
            date: '2026-10-07',
            docKind: 'invoice',
            docNo: 'INV-<1>',
            description: '<script>alert(1)</script>',
            direction: 'debit',
            amount: '10.0000',
            runningBalance: '10.0000',
          },
        ],
        lineCount: 1,
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('أحمد &lt;b&gt;&amp;&quot;تاجر&quot;&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;');
  });

  test('statementShortDate: «08 أكتوبر» — و0000-00-00 تُطبع «—»', () => {
    expect(statementShortDate('2026-10-08')).toBe('08 أكتوبر');
    expect(statementShortDate('0000-00-00')).toBe('—');
    expect(statementShortDate('2026-01-31')).toBe('31 يناير');
  });
});

describe('buildStatementWhatsAppMessage — رسالة الواتساب', () => {
  test('الشكل: العنوان بالطرف والمنشأة + الفترة والعملة + أول المدة + السطور + الختامي + التطبيق', () => {
    const msg = buildStatementWhatsAppMessage(sampleStatement());
    const lines = msg.split('\n');
    expect(lines[0]).toBe('كشف حساب عميل: أحمد صالح — متجر النور');
    expect(msg).toContain('من 01 يناير 2026 حتى 08 أكتوبر 2026');
    expect(msg).toContain('YER');
    expect(msg).toContain('رصيد أول المدة: 5,000 ر.ي');
    expect(msg).toContain('آخر الحركات');
    expect(msg).toContain('• 08 أكتوبر — RVT-2026-00001: -100');
    expect(msg).toContain('• 07 أكتوبر — INV-2026-00002: +230');
    expect(msg).toContain('الرصيد الختامي: 5,130 ر.ي مستحق عليه');
    expect(msg.endsWith('المُحاسِب الشخصي')).toBe(true);
  });

  test('حدّ 10 سطور: الباقي «و{n} حركة أخرى…» — والتوازن يعرض «الحساب متوازن»', () => {
    const many: StatementLine[] = Array.from({ length: 15 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      docKind: 'invoice',
      docNo: `INV-2026-${String(i + 1).padStart(5, '0')}`,
      description: `فاتورة بيع آجلة ${i + 1}`,
      direction: 'debit',
      amount: '10.0000',
      runningBalance: `${(i + 1) * 10}.0000`,
    }));
    const msg = buildStatementWhatsAppMessage(
      sampleStatement({ lines: many, lineCount: 15, closingBalance: '150.0000' }),
    );
    const bullets = msg.split('\n').filter((l) => l.startsWith('•'));
    expect(bullets.length).toBe(10);
    expect(msg).toContain('و5 حركة أخرى…');

    const balanced = buildStatementWhatsAppMessage(
      sampleStatement({ closingBalance: '0.0000' }),
    );
    expect(balanced).toContain('الحساب متوازن — لا مستحق');
  });

  test('المورد: العنوان والتسمية بالاتجاه المعكوس', () => {
    const msg = buildStatementWhatsAppMessage(
      sampleStatement({ partyType: 'supplier', partyLabel: 'المورد' }),
    );
    expect(msg).toContain('كشف حساب مورد');
    expect(msg).toContain('مستحق له علينا');
  });
});

describe('computeAgingBuckets — أعمار الديون النقية (FR-03-03)', () => {
  test('التوزيع على الشرائح الأربع بعمر issued_at + الإجمالي', () => {
    const aging = computeAgingBuckets(
      [
        { issuedAt: daysAgoISO(10), remaining: '100.0000' }, // 0-30
        { issuedAt: daysAgoISO(45), remaining: '50.0000' }, // 31-60
        { issuedAt: daysAgoISO(75), remaining: '30.0000' }, // 61-90
        { issuedAt: daysAgoISO(120), remaining: '20.0000' }, // +90
        { issuedAt: daysAgoISO(5), remaining: '70.0000' }, // 0-30
      ],
      TODAY,
    );
    expect(aging.buckets[0]!.amount).toBe('170.0000');
    expect(aging.buckets[0]!.count).toBe(2);
    expect(aging.buckets[1]!.amount).toBe('50.0000');
    expect(aging.buckets[2]!.amount).toBe('30.0000');
    expect(aging.buckets[3]!.amount).toBe('20.0000');
    expect(aging.total).toBe('270.0000');
  });

  test('فراغ: إجمالي صفر بلا انهيار', () => {
    const aging = computeAgingBuckets([], TODAY);
    expect(aging.total).toBe('0.0000');
    expect(aging.buckets.every((b) => b.count === 0)).toBe(true);
  });
});

describe('التكامل: القاعدة → ورقة كشف الحساب (FR-03-04)', () => {
  test('عميل بافتتاحي وفاتورة آجلة وسند قبض: سطور متوازنة ورصيد ختامي حقيقي', async () => {
    const { db, seed } = await seededDb();
    await db.run(
      `UPDATE customer SET opening_balance = '5000.0000', opening_balance_currency_id = ?, opening_balance_date = ? WHERE id = ?`,
      [seed.yerId, daysAgoISO(5), seed.customerId],
    );
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('10'),
      unitCost: d('90'),
      movedAt: daysAgoISO(3),
    });
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(2),
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
    } satisfies SaveInvoiceInput);
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '100',
      exchangeRate: '1',
      txDate: TODAY,
      customerId: seed.customerId,
    });

    const data = await loadStatementPrintData(db, 'customer', seed.customerId, seed.yerId);
    expect(data.partyName).toBe('أحمد');
    expect(data.partyLabel).toBe('العميل');
    expect(data.company.name).toBe('متجر الاختبار');
    expect(data.currency.code).toBe('YER');
    expect(data.currency.decimals).toBe(0);
    // بلا from: «الكل» — رصيد أول المدة صفر والافتتاحي سطر أول في السطور نفسها
    expect(data.openingBalance).toBe('0.0000');
    expect(data.closingBalance).toBe('5130.0000');
    expect(data.period.text).toBe('كل الفترات');
    expect(data.lines.length).toBe(3); // افتتاحي + فاتورة + قبض
    expect(data.lines[2]!.docKind).toBe('receipt');
    expect(data.lines[2]!.runningBalance).toBe('5130.0000');

    const html = buildStatementHtml(data);
    expect(html).toContain('كشف حساب عميل');
    expect(html).toContain('أحمد');
    expect(html).toContain(`INV-${YEAR}-00001`);
    expect(html).toContain('RVT-');
    expect(html).toContain('5,130');

    // أعمار الديون من الفواتير المفتوحة نفسها (المتبقي 130 بفتحة 0-30)
    const open = await getOpenInvoicesForParty(db, { customerId: seed.customerId });
    const aging = computeAgingBuckets(open, TODAY);
    expect(aging.total).toBe('130.0000');
    expect(aging.buckets[0]!.count).toBe(1);
  });

  test('فترة from: سطر «رصيد أول المدة» يجرّ ما قبلها والخاتمي يبقى صحيحاً', async () => {
    const { db, seed } = await seededDb();
    await db.run(
      `UPDATE customer SET opening_balance = '5000.0000', opening_balance_currency_id = ?, opening_balance_date = ? WHERE id = ?`,
      [seed.yerId, daysAgoISO(5), seed.customerId],
    );
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('10'),
      unitCost: d('90'),
      movedAt: daysAgoISO(4),
    });
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(2),
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
    } satisfies SaveInvoiceInput);
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '100',
      exchangeRate: '1',
      txDate: TODAY,
      customerId: seed.customerId,
    });

    const data = await loadStatementPrintData(db, 'customer', seed.customerId, seed.yerId, {
      from: TODAY,
    });
    expect(data.lines[0]!.docKind).toBe('brought_forward');
    expect(data.openingBalance).toBe('5230.0000'); // 5000 + 230 قبل الفترة
    expect(data.closingBalance).toBe('5130.0000');
    expect(data.period.text).toContain('من');

    const msg = buildStatementWhatsAppMessage(data);
    expect(msg).toContain('رصيد أول المدة: 5,230 ر.ي');
    expect(msg).toContain('RVT-');
  });
});
