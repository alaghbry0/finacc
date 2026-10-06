/**
 * voucher.test.ts — اختبارات سند القبض/الصرف المطبوع (المهمة 10 — FR-04-10).
 *
 * القسم النقي: بناء ورقة السند (buildVoucherHtml) بعينات بيانات — الاتجاه RTL،
 * العنوان والرقم RVT-/PMT-، المبلغ الكبير، جدول التخصيصات، الباقي على الحساب،
 * فرق الصرف، التهريب، وعرض الورقة الحرارية 320px.
 * القسم التكاملي: القاعدة → recordVoucher → loadVoucherPrintData (ترقيم كسول
 * عبر ensureVoucherNo لنقدية الفواتير القديمة) → القالب، + استعلامات قراءة
 * شاشة النقدية (الأرصدة/السجل/الفواتير المفتوحة).
 */
import { describe, expect, test } from 'bun:test';
import { buildVoucherHtml, type VoucherPrintData } from '../invoice-html';
import { loadVoucherPrintData } from '../voucher-data';
import { recordVoucher, recordExpense, recordBoxTransfer } from '../../domain/cash';
import { saveInvoice, type SaveInvoiceInput, type LineInput } from '../../domain/invoicing';
import { recordOpeningStock } from '../../domain/inventory';
import {
  getCashboxBalances,
  listCashMovements,
  getOpenInvoicesForParty,
} from '../../db/queries';
import { daysAgoISO, seededDb } from '../../domain/__tests__/seed';
import { d } from '../../utils/money';

const TODAY = new Date().toISOString().slice(0, 10);

/** عينة سند قبض: متجر النور يحصّل 730 من أحمد صالح يغطي فاتورتين */
function sampleReceipt(overrides: Partial<VoucherPrintData> = {}): VoucherPrintData {
  return {
    company: { name: 'متجر النور', phone: '712345678', footerText: 'شكراً لتعاملكم معنا' },
    docType: 'receipt',
    voucherNo: 'RVT-2026-00001',
    txDate: '2026-10-08',
    partyName: 'أحمد صالح',
    partyLabel: 'العميل',
    partyPhone: '733221100',
    cashboxName: 'الصندوق الرئيسي',
    currency: { code: 'YER', decimals: 0 },
    amount: '730.0000',
    onAccount: '30.0000',
    allocations: [
      { invoiceNo: 'INV-2026-00001', amount: '600.0000' },
      { invoiceNo: 'INV-2026-00002', amount: '100.0000' },
    ],
    fxGainLoss: '0.0000',
    description: 'دفعة شهرية',
    generatedAt: '2026-10-08T10:20:00.000Z',
    ...overrides,
  };
}

describe('buildVoucherHtml — ورقة السند النقية', () => {
  test('مستند RTL عربي كامل: DOCTYPE وlang=ar وdir=rtl وcharset', () => {
    const html = buildVoucherHtml(sampleReceipt());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('<meta charset="utf-8">');
  });

  test('عرض الورقة الحرارية 320px (58/80مم — FR-04-10)', () => {
    const html = buildVoucherHtml(sampleReceipt());
    expect(html).toContain('width: 320px');
  });

  test('الرأس: المنشأة + الهاتف + عنوان «سند قبض» والرقم RVT- بخط أحادي', () => {
    const html = buildVoucherHtml(sampleReceipt());
    expect(html).toContain('متجر النور');
    expect(html).toContain('هاتف: 712345678');
    expect(html).toContain('سند قبض');
    expect(html).toContain('RVT-2026-00001');
    expect(html).toContain('voucher-no');
  });

  test('سند الصرف: عنوان «سند صرف» + الرقم PMT- + «المبلغ المدفوع»', () => {
    const html = buildVoucherHtml(
      sampleReceipt({ docType: 'payment', voucherNo: 'PMT-2026-00007' }),
    );
    expect(html).toContain('سند صرف');
    expect(html).toContain('PMT-2026-00007');
    expect(html).toContain('المبلغ المدفوع');
    expect(html).not.toContain('المبلغ المستلم');
  });

  test('الميتا: التاريخ العربي + الصندوق + العميل بهاتفه', () => {
    const html = buildVoucherHtml(sampleReceipt());
    expect(html).toContain('الخميس 08 أكتوبر 2026');
    expect(html).toContain('الصندوق الرئيسي');
    expect(html).toContain('أحمد صالح');
    expect(html).toContain('733221100');
  });

  test('المبلغ الكبير بعملته + جدول التخصيصات بأرقام الفواتير + الباقي على الحساب', () => {
    const html = buildVoucherHtml(sampleReceipt());
    expect(html).toContain('المبلغ المستلم');
    expect(html).toContain('730');
    expect(html).toContain('YER');
    expect(html).toContain('سُدّد عن الفواتير');
    expect(html).toContain('INV-2026-00001');
    expect(html).toContain('INV-2026-00002');
    expect(html).toContain('والباقي على الحساب');
    expect(html).toContain('30');
  });

  test('الباقي صفري → لا سطر «على الحساب»؛ جدول التخصيصات يغيب بلا بنود', () => {
    const html = buildVoucherHtml(
      sampleReceipt({ onAccount: '0.0000', allocations: [] }),
    );
    expect(html).not.toContain('والباقي على الحساب');
    expect(html).not.toContain('سُدّد عن الفواتير');
  });

  test('فرق الصرف: بند مستقل عند ≠0 ويغيب عند صفره', () => {
    const withFx = buildVoucherHtml(sampleReceipt({ fxGainLoss: '30000.0000' }));
    expect(withFx).toContain('فرق صرف محقق');
    expect(withFx).toContain('30,000');
    const flat = buildVoucherHtml(sampleReceipt());
    expect(flat).not.toContain('فرق صرف محقق');
  });

  test('البيان + التذييل: نص الشكر و«طُبعت بواسطة المُحاسِب الشخصي»', () => {
    const html = buildVoucherHtml(sampleReceipt());
    expect(html).toContain('دفعة شهرية');
    expect(html).toContain('شكراً لتعاملكم معنا');
    expect(html).toContain('طُبعت بواسطة المُحاسِب الشخصي');
  });

  test('التهريب: اسم/بيان يحملان HTML لا يكسران المستند', () => {
    const html = buildVoucherHtml(
      sampleReceipt({
        partyName: 'أحمد <b>&"تاجر"</b>',
        description: '<script>alert(1)</script>',
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('أحمد &lt;b&gt;&amp;&quot;تاجر&quot;&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('التكامل: القاعدة → السند المطبوع (FR-04-10)', () => {
  test('سند قبض حقيقي بتخصيص FIFO: الرقم والطرف والتخصيصات والباقي على الحساب', async () => {
    const { db, seed } = await seededDb();
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('20'),
      unitCost: d('90'),
      movedAt: daysAgoISO(3),
    });
    // فاتورتان آجلستان: 115 و230 → مستحق 345
    for (const qty of ['1', '2']) {
      await saveInvoice(db, {
        docType: 'sale',
        payStatus: 'credit',
        issuedAt: daysAgoISO(2),
        customerId: seed.customerId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [{ productId: seed.milkId, qty, unitPrice: '115' }],
      } satisfies SaveInvoiceInput);
    }
    const res = await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '400',
      exchangeRate: '1',
      txDate: TODAY,
      customerId: seed.customerId,
    });
    expect(res.voucherNo).toBe(`RVT-${new Date().getUTCFullYear()}-00001`);
    expect(res.onAccountAmount).toBe('55.0000');

    const data = await loadVoucherPrintData(db, res.cashTxId);
    expect(data.voucherNo).toBe(res.voucherNo); // خامل بعد الحفظ
    expect(data.partyName).toBe('أحمد');
    expect(data.partyLabel).toBe('العميل');
    expect(data.company.name).toBe('متجر الاختبار');
    expect(data.cashboxName).toBe('الصندوق الرئيسي');
    expect(data.allocations.map((a) => a.invoiceNo)).toEqual([
      `INV-${new Date().getUTCFullYear()}-00001`,
      `INV-${new Date().getUTCFullYear()}-00002`,
    ]);
    expect(d(data.onAccount).toFixed(4)).toBe('55.0000');

    const html = buildVoucherHtml(data);
    expect(html).toContain(res.voucherNo);
    expect(html).toContain('أحمد');
    expect(html).toContain('سند قبض');
    expect(html).toContain('والباقي على الحساب');
  });

  test('ترقيم كسول: نقدية فاتورة قديمة بلا voucher_no تُمنح رقماً عند أول طباعة', async () => {
    const { db, seed } = await seededDb();
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('10'),
      unitCost: d('90'),
      movedAt: daysAgoISO(2),
    });
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'cash',
      cashboxId: seed.cashboxId,
      issuedAt: TODAY,
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    } satisfies SaveInvoiceInput);
    // حركة النقدية المولّدة من الفاتورة: ref_type='invoice' وبلا رقم سند
    const rows = await db.all<{ id: number; voucher_no: string | null; ref_type: string }>(
      "SELECT id, voucher_no, ref_type FROM cash_tx WHERE ref_type = 'invoice' AND reversal_of IS NULL",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.voucher_no).toBeNull();

    // أول طباعة → الرقم يُستهلك (FR-04-10) ثم يصبح خاملاً
    const first = await loadVoucherPrintData(db, Number(rows[0]!.id));
    expect(first.voucherNo).toMatch(/^RVT-\d{4}-\d{5}$/);
    const second = await loadVoucherPrintData(db, Number(rows[0]!.id));
    expect(second.voucherNo).toBe(first.voucherNo);
    expect(second.partyName).toBe('أحمد');
    const html = buildVoucherHtml(first);
    expect(html).toContain(first.voucherNo);
    expect(inv.invoiceNo).toBeDefined();
  });

  test('السند يرفض غير القبض/الصرف (المصروف مثلاً) برسالة عربية', async () => {
    const { db, seed } = await seededDb();
    const cat = await db.all<{ id: number }>(
      `INSERT INTO expense_category (name) VALUES ('رواتب') RETURNING id`,
    );
    const res = await recordExpense(db, {
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '50',
      exchangeRate: '1',
      txDate: TODAY,
      expenseCategoryId: Number(cat[0]!.id),
    });
    await expect(loadVoucherPrintData(db, res.cashTxId)).rejects.toThrow(
      'طباعة السند للقبض والصرف فقط',
    );
  });
});

describe('استعلامات قراءة شاشة النقدية (المهمة 10)', () => {
  test('الأرصدة: وارد − صادر بعملة كل صندوق؛ الملغاة والمعاكسة خارج؛ التحويل شطران', async () => {
    const { db, seed } = await seededDb();
    // صندوق سعودي إضافي للتحويل بين عملتين
    const sarBox = await db.all<{ id: number }>(
      `INSERT INTO cashbox (name, currency_id) VALUES ('صندوق السعودي', ?) RETURNING id`,
      [seed.sarId],
    );
    await db.run(
      `INSERT INTO exchange_rate (currency_id, rate_date, rate) VALUES (?, ?, '530')`,
      [seed.sarId, TODAY],
    );
    const voucher = await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '1000',
      exchangeRate: '1',
      txDate: TODAY,
      customerId: seed.customerId,
    });
    await recordExpense(db, {
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '150',
      exchangeRate: '1',
      txDate: TODAY,
      expenseCategoryId: (
        await db.all<{ id: number }>(`INSERT INTO expense_category (name) VALUES ('نقل ومواصلات') RETURNING id`)
      )[0]!.id,
    });
    // تحويل 100 يمني دفترياً بالقيمة → 100/530 = 0.1887 سعودي بلا فرق
    await recordBoxTransfer(db, {
      fromCashboxId: seed.cashboxId,
      toCashboxId: Number(sarBox[0]!.id),
      amount: '100',
      txDate: TODAY,
    });
    // إلغاء سند القبض → يجب أن يخرج من الرصيد (معاكسة)
    const { voidCashTx } = await import('../../domain/cash');
    await voidCashTx(db, voucher.cashTxId);

    const balances = await getCashboxBalances(db);
    expect(balances.map((b) => b.name)).toEqual(['الصندوق الرئيسي', 'صندوق السعودي']);
    const main = balances[0]!;
    expect(main.currencyCode).toBe('YER');
    // 1000 (قبض أُلغي) − 150 (مصروف) − 100 (تحويل صادر) = -250 — سالب مسموح (قرار 9)
    expect(main.balance).toBe('-250.0000');
    const sar = balances[1]!;
    expect(sar.currencyCode).toBe('SAR');
    expect(sar.balance).toBe('0.1887');
  });

  test('سجل الحركات: اتجاهات صحيحة + فلترة المصروف + الملغاة والمعاكسة حاضرتان', async () => {
    const { db, seed } = await seededDb();
    const catId = (
      await db.all<{ id: number }>(`INSERT INTO expense_category (name) VALUES ('رواتب') RETURNING id`)
    )[0]!.id;
    const voucher = await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '500',
      exchangeRate: '1',
      txDate: TODAY,
      customerId: seed.customerId,
    });
    await recordExpense(db, {
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '80',
      exchangeRate: '1',
      txDate: TODAY,
      expenseCategoryId: catId,
    });
    const { voidCashTx } = await import('../../domain/cash');
    await voidCashTx(db, voucher.cashTxId);

    const all = await listCashMovements(db, {});
    // سند + مصروف + معاكسة السند = 3
    expect(all.length).toBe(3);
    const receipt = all.find((r) => r.txType === 'receipt')!;
    expect(receipt.direction).toBe('in');
    expect(receipt.isVoided).toBe(true);
    expect(receipt.voucherNo).toBe(voucher.voucherNo);
    expect(receipt.customerName).toBe('أحمد');
    const reversal = all.find((r) => r.reversalOf !== null)!;
    expect(reversal.txType).toBe('payment');
    expect(reversal.direction).toBe('out');
    const expense = all.find((r) => r.txType === 'expense')!;
    expect(expense.direction).toBe('out');
    expect(expense.expenseCategoryName).toBe('رواتب');

    const onlyExpense = await listCashMovements(db, { filter: 'expense' });
    expect(onlyExpense.length).toBe(1);
    expect(onlyExpense[0]!.txType).toBe('expense');
  });

  test('الفواتير المفتوحة: المتبقي مشتق من due_amount − Σ تخصيصات السندات الحية', async () => {
    const { db, seed } = await seededDb();
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('10'),
      unitCost: d('90'),
      movedAt: daysAgoISO(4),
    });
    const lines: LineInput[] = [{ productId: seed.milkId, qty: '2', unitPrice: '115' }];
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(3),
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines,
    } satisfies SaveInvoiceInput);

    const before = await getOpenInvoicesForParty(db, { customerId: seed.customerId });
    expect(before.length).toBe(1);
    expect(before[0]!.remaining).toBe('230.0000');

    const res = await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '100',
      exchangeRate: '1',
      txDate: TODAY,
      customerId: seed.customerId,
    });
    const after = await getOpenInvoicesForParty(db, { customerId: seed.customerId });
    expect(after.length).toBe(1);
    expect(after[0]!.remaining).toBe('130.0000');
    expect(res.allocations[0]!.allocatedAmount).toBe('100.0000');

    // إلغاء السند → التخصيص يفك والمتبقي يعود 230
    const { voidCashTx } = await import('../../domain/cash');
    await voidCashTx(db, res.cashTxId);
    const restored = await getOpenInvoicesForParty(db, { customerId: seed.customerId });
    expect(restored[0]!.remaining).toBe('230.0000');
  });
});
