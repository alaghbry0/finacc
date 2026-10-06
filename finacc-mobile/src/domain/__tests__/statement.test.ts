/**
 * statement.test.ts — كشف حساب الطرف: معادلة FR-03-02 الحرفية + AC-02 + AC-18
 * + الفصل لكل عملة (قرار 8) + الرصيد المتحرك (FR-03-04).
 */
import { describe, expect, test } from 'bun:test';
import type { SqliteAdapter } from '../../db/adapter';
import { d } from '../../utils/money';
import { recordOpeningStock } from '../inventory';
import { createLinkedReturn, saveInvoice, voidInvoice } from '../invoicing';
import { upsertDailyRate } from '../currency';
import { recordVoucher, voidCashTx } from '../cash';
import { DomainRuleError, ValidationError } from '../errors';
import { getPartyBalanceByCurrency, getStatementLines } from '../statement';
import { daysAgoISO, seededDb } from './seed';
import type { Seed } from './seed';
import type { LineInput } from '../invoicing';

const TODAY = daysAgoISO(0);
const YEAR = TODAY.slice(0, 4);

/* ============================ مساعدات ============================ */

async function openMilk(db: SqliteAdapter, seed: Seed, qty = '100', cost = '90'): Promise<void> {
  await recordOpeningStock(db, {
    productId: seed.milkId,
    warehouseId: seed.warehouseId,
    qty: d(qty),
    unitCost: d(cost),
    movedAt: daysAgoISO(45),
  });
}

async function newCustomerWithOpening(
  db: SqliteAdapter,
  seed: Seed,
  opening: string,
  dateISO: string,
  name = 'سالم',
): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO customer (name, opening_balance, opening_balance_currency_id, opening_balance_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [name, opening, seed.yerId, dateISO, now, now],
  );
  return Number(rows[0]!.id);
}

async function newSupplierWithOpening(
  db: SqliteAdapter,
  seed: Seed,
  opening: string,
  dateISO: string,
): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO supplier (name, opening_balance, opening_balance_currency_id, opening_balance_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    ['مورد الرياض', opening, seed.yerId, dateISO, now, now],
  );
  return Number(rows[0]!.id);
}


async function customerBalance(
  db: SqliteAdapter,
  partyId: number,
  currencyId: number,
): Promise<string> {
  const list = await getPartyBalanceByCurrency(db, 'customer', partyId);
  const hit = list.find((b) => b.currencyId === currencyId);
  return hit ? hit.balance : '0.0000';
}

async function supplierBalance(
  db: SqliteAdapter,
  partyId: number,
  currencyId: number,
): Promise<string> {
  const list = await getPartyBalanceByCurrency(db, 'supplier', partyId);
  const hit = list.find((b) => b.currencyId === currencyId);
  return hit ? hit.balance : '0.0000';
}

/** سيناريو FR-03-02 الكامل: افتتاحي 5000 + آجلة 230 − تحصيل 100 − مرتجع آجل 23 */
async function fr0302Scenario(db: SqliteAdapter, seed: Seed): Promise<{
  customerId: number;
  invoiceNo: string;
  invoiceId: number;
  voucherId: number;
  returnNo: string;
}> {
  const customerId = await newCustomerWithOpening(db, seed, '5000', daysAgoISO(40));
  await openMilk(db, seed);
  const inv = await saveInvoice(db, {
    docType: 'sale',
    payStatus: 'credit',
    issuedAt: daysAgoISO(25),
    customerId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
  });
  const voucher = await recordVoucher(db, {
    txType: 'receipt',
    cashboxId: seed.cashboxId,
    currencyId: seed.yerId,
    amount: '100',
    exchangeRate: '1',
    txDate: daysAgoISO(20),
    customerId,
  });
  const ret = await createLinkedReturn(db, {
    docType: 'sale_return',
    originalInvoiceId: inv.invoiceId,
    issuedAt: daysAgoISO(10),
    returnPayDirection: 'account',
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.milkId, qty: '0.2', unitPrice: '115' }],
  });
  return {
    customerId,
    invoiceId: inv.invoiceId,
    invoiceNo: inv.invoiceNo!,
    voucherId: voucher.cashTxId,
    returnNo: ret.invoiceNo!,
  };
}

/* ==================== معادلة FR-03-02 (قرار 8) ==================== */

describe('getPartyBalanceByCurrency — معادلة FR-03-02 المصححة (قرار 8)', () => {
  test('Σ(آجل) − Σ(تحصيلات) − Σ(مرتجع آجل) + افتتاحي = 5107 بالضبط', async () => {
    const { db, seed } = await seededDb();
    const { customerId } = await fr0302Scenario(db, seed);
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('5107.0000');
  });

  test('الفصل لكل عملة: فاتورة SAR لا تتسرب لرصيد YER (FR-08-11)', async () => {
    const { db, seed } = await seededDb();
    const customerId = await newCustomerWithOpening(db, seed, '5000', daysAgoISO(40));
    await upsertDailyRate(db, seed.sarId, daysAgoISO(10), '530');
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(10),
      customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.sarId,
      lines: [{ productId: seed.deliveryId, qty: '1', unitPrice: '50' }],
    });
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('5000.0000');
    expect(await customerBalance(db, customerId, seed.sarId)).toBe('50.0000');
    const list = await getPartyBalanceByCurrency(db, 'customer', customerId);
    expect(list.length).toBe(2);
    expect(list.map((b) => b.currencyCode).sort()).toEqual(['SAR', 'YER']);
  });

  test('نقدي بلا آجل: صفر أثر على الرصيد (due=0) — القائمة فارغة', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'cash',
      issuedAt: TODAY,
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      cashboxId: seed.cashboxId,
      lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
    });
    expect(await getPartyBalanceByCurrency(db, 'customer', seed.customerId)).toEqual([]);
  });

  test('مختلطة: الرصيد = الجزء الآجل فقط (500 نقدي 200 → 300)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'mixed',
      issuedAt: TODAY,
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      cashboxId: seed.cashboxId,
      paidAmount: '200',
      lines: [{ productId: seed.milkId, qty: '5', unitPrice: '100' }],
    });
    expect(await customerBalance(db, seed.customerId, seed.yerId)).toBe('300.0000');
  });

  test('سداد يتجاوز المستحق: رصيد دائن لصالح العميل (−10)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const customerId = await newCustomerWithOpening(db, seed, '0', daysAgoISO(5));
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(3),
      customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
    });
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '240',
      exchangeRate: '1',
      txDate: daysAgoISO(1),
      customerId,
    });
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('-10.0000');
  });

  test('قبض على الحساب بلا فواتير: رصيد دائن كامل (−500)', async () => {
    const { db, seed } = await seededDb();
    const customerId = await newCustomerWithOpening(db, seed, '0', daysAgoISO(5));
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '500',
      exchangeRate: '1',
      txDate: TODAY,
      customerId,
    });
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('-500.0000');
  });

  test('مرتجع بعد دفع نقدي = رصيد دائن لصالح العميل (FR-03-02 توثيق الحالة)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'cash',
      issuedAt: daysAgoISO(5),
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      cashboxId: seed.cashboxId,
      lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
    });
    expect(await customerBalance(db, seed.customerId, seed.yerId)).toBe('0.0000');
    await createLinkedReturn(db, {
      docType: 'sale_return',
      originalInvoiceId: inv.invoiceId,
      issuedAt: TODAY,
      returnPayDirection: 'account',
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
    });
    expect(await customerBalance(db, seed.customerId, seed.yerId)).toBe('-230.0000');
  });

  test('سند ملغى يعيد الرصيد تلقائياً (is_voided/reversal_of خارج الأرصدة)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const customerId = await newCustomerWithOpening(db, seed, '0', daysAgoISO(5));
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(3),
      customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
    });
    const voucher = await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '100',
      exchangeRate: '1',
      txDate: daysAgoISO(1),
      customerId,
    });
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('130.0000');
    await voidCashTx(db, voucher.cashTxId, { createdBy: 1 });
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('230.0000');
  });

  test('فاتورة تُلغى بعد تحصيلها: التحصيل يتحول «على الحساب» (دائن للعميل)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const customerId = await newCustomerWithOpening(db, seed, '0', daysAgoISO(5));
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(3),
      customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
    });
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '100',
      exchangeRate: '1',
      txDate: daysAgoISO(2),
      customerId,
    });
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('130.0000');
    await voidInvoice(db, inv.invoiceId, { createdBy: 1 });
    // الفاتورة زالت (−230) وتخصيصها لم يعد محسوباً → السند كله «على الحساب»
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('-100.0000');
  });

  test('معادلة المورد المرآة: افتتاحي 2000 + شراء 500 − دفع 300 − مرتجع آجل 100 = 2100', async () => {
    const { db, seed } = await seededDb();
    const supplierId = await newSupplierWithOpening(db, seed, '2000', daysAgoISO(40));
    const inv = await saveInvoice(db, {
      docType: 'purchase',
      payStatus: 'credit',
      issuedAt: daysAgoISO(25),
      supplierId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '500' }],
    });
    await recordVoucher(db, {
      txType: 'payment',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '300',
      exchangeRate: '1',
      txDate: daysAgoISO(20),
      supplierId,
    });
    await createLinkedReturn(db, {
      docType: 'purchase_return',
      originalInvoiceId: inv.invoiceId,
      issuedAt: daysAgoISO(10),
      returnPayDirection: 'account',
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '0.2', unitPrice: '500' }],
    });
    expect(await supplierBalance(db, supplierId, seed.yerId)).toBe('2100.0000');
  });

  test('دفع على الحساب للمورد بلا فواتير: رصيد دائن لصالحنا (−200)', async () => {
    const { db, seed } = await seededDb();
    const supplierId = await newSupplierWithOpening(db, seed, '0', daysAgoISO(5));
    await recordVoucher(db, {
      txType: 'payment',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '200',
      exchangeRate: '1',
      txDate: TODAY,
      supplierId,
    });
    expect(await supplierBalance(db, supplierId, seed.yerId)).toBe('-200.0000');
  });
});

/* ==================== AC-02 حرفياً (SRS 1313: FR-03-02 ↔ AC-02) ==================== */

describe('AC-01/AC-02 حرفياً — بيع آجل بحد ائتمان ثم مرتجع كامل', () => {
  test('AC-01: بيع 15 بنداً آجلاً → الرصيد زاد بالإجمالي بعملة الفاتورة (1725)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const now = new Date().toISOString();
    const rows = await db.all<{ id: number }>(
      `INSERT INTO customer (name, credit_limit, created_at, updated_at)
       VALUES ('عميل الحد', '100000', ?, ?) RETURNING id`,
      [now, now],
    );
    const customerId = Number(rows[0]!.id);
    const lines: LineInput[] = Array.from({ length: 15 }, () => ({
      productId: seed.milkId,
      qty: '1',
      unitPrice: '115',
    }));
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: TODAY,
      customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines,
    });
    expect(inv.invoiceNo).toBe(`INV-${YEAR}-00001`);
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('1725.0000');
  });

  test('AC-02: مرتجع كامل للفاتورة → الرصيد نقص بالكامل وعاد إلى ما قبلها (صفر)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const now = new Date().toISOString();
    const rows = await db.all<{ id: number }>(
      `INSERT INTO customer (name, credit_limit, created_at, updated_at)
       VALUES ('عميل الحد', '100000', ?, ?) RETURNING id`,
      [now, now],
    );
    const customerId = Number(rows[0]!.id);
    const lines: LineInput[] = Array.from({ length: 15 }, () => ({
      productId: seed.milkId,
      qty: '1',
      unitPrice: '115',
    }));
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(2),
      customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines,
    });
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('1725.0000');
    await createLinkedReturn(db, {
      docType: 'sale_return',
      originalInvoiceId: inv.invoiceId,
      issuedAt: daysAgoISO(1),
      returnPayDirection: 'account',
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '15', unitPrice: '115' }],
    });
    // الرصيد نقص بمقدار مرتجع كامل — يغطي FR-03-02 حرفياً
    expect(await customerBalance(db, customerId, seed.yerId)).toBe('0.0000');
    expect(await getPartyBalanceByCurrency(db, 'customer', customerId)).toEqual([]);
  });
});

/* ==================== سطور الكشف والرصيد المتحرك (FR-03-04) ==================== */

describe('getStatementLines — سطور الكشف بالعملة الواحدة (FR-03-04)', () => {
  test('الترتيب الزمني + الرصيد المتحرك: 5000 → 5230 → 5130 → 5107', async () => {
    const { db, seed } = await seededDb();
    const { customerId } = await fr0302Scenario(db, seed);
    const res = await getStatementLines(db, 'customer', customerId, seed.yerId);
    expect(res.currencyCode).toBe('YER');
    expect(res.lines.map((l) => l.docKind)).toEqual(['opening', 'invoice', 'receipt', 'return']);
    expect(res.lines[0]!.runningBalance).toBe('5000.0000');
    expect(res.lines[1]!.runningBalance).toBe('5230.0000');
    expect(res.lines[2]!.runningBalance).toBe('5130.0000');
    expect(res.lines[3]!.runningBalance).toBe('5107.0000');
    expect(res.closingBalance).toBe('5107.0000');
    expect(res.openingBalance).toBe('0.0000');
  });

  test('اتجاهات السطور: فاتورة/افتتاحي مدين، تحصيل ومرتجع دائن، مع أرقام المستندات', async () => {
    const { db, seed } = await seededDb();
    const { customerId, invoiceNo, returnNo } = await fr0302Scenario(db, seed);
    const res = await getStatementLines(db, 'customer', customerId, seed.yerId);
    const [opening, invoice, receipt, ret] = res.lines;
    expect(opening!.direction).toBe('debit');
    expect(opening!.amount).toBe('5000.0000');
    expect(invoice!.direction).toBe('debit');
    expect(invoice!.docNo).toBe(invoiceNo);
    expect(invoice!.amount).toBe('230.0000');
    expect(receipt!.direction).toBe('credit');
    expect(receipt!.docNo).toBe(`RVT-${YEAR}-00001`);
    expect(receipt!.amount).toBe('100.0000');
    expect(ret!.direction).toBe('credit');
    expect(ret!.docNo).toBe(returnNo);
    expect(ret!.amount).toBe('23.0000');
  });

  test('سطر التحصيل المخصص يحمل وصف الفاتورة، وسطر «على الحساب» للباقي', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const customerId = await newCustomerWithOpening(db, seed, '0', daysAgoISO(5));
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(3),
      customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
    });
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '250',
      exchangeRate: '1',
      txDate: daysAgoISO(1),
      customerId,
    });
    const res = await getStatementLines(db, 'customer', customerId, seed.yerId);
    expect(res.lines.map((l) => l.docKind)).toEqual(['invoice', 'receipt', 'receipt']);
    expect(res.lines[1]!.description).toContain('تخصيص لفاتورة');
    expect(res.lines[1]!.amount).toBe('230.0000');
    expect(res.lines[2]!.description).toContain('على الحساب');
    expect(res.lines[2]!.amount).toBe('20.0000');
    expect(res.closingBalance).toBe('-20.0000');
  });

  test('نفس اليوم: الفاتورة قبل تحصيلها (ترتيب مستقر داخل اليوم)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const customerId = await newCustomerWithOpening(db, seed, '0', daysAgoISO(5));
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: TODAY,
      customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    });
    void inv;
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '115',
      exchangeRate: '1',
      txDate: TODAY,
      customerId,
    });
    const res = await getStatementLines(db, 'customer', customerId, seed.yerId);
    expect(res.lines[0]!.docKind).toBe('invoice');
    expect(res.lines[1]!.docKind).toBe('receipt');
  });

  test('from: سطر «رصيد أول المدة» يجُرّ كل ما قبله (5130) ثم مرتجع الفترة', async () => {
    const { db, seed } = await seededDb();
    const { customerId } = await fr0302Scenario(db, seed);
    const res = await getStatementLines(db, 'customer', customerId, seed.yerId, {
      from: daysAgoISO(15),
    });
    expect(res.lines.map((l) => l.docKind)).toEqual(['brought_forward', 'return']);
    expect(res.lines[0]!.description).toBe('رصيد أول المدة');
    expect(res.lines[0]!.amount).toBe('5130.0000');
    expect(res.lines[0]!.direction).toBe('debit');
    expect(res.openingBalance).toBe('5130.0000');
    expect(res.closingBalance).toBe('5107.0000');
  });

  test('to: الكشف يقفل عند تاريخه (إلى ما قبل المرتجع = 5130)', async () => {
    const { db, seed } = await seededDb();
    const { customerId } = await fr0302Scenario(db, seed);
    const res = await getStatementLines(db, 'customer', customerId, seed.yerId, {
      to: daysAgoISO(20),
    });
    expect(res.lines.map((l) => l.docKind)).toEqual(['opening', 'invoice', 'receipt']);
    expect(res.closingBalance).toBe('5130.0000');
  });

  test('كشف مورد: السطور والاتجاهات المرآة (شراء مدين، دفع/مرتجع دائن)', async () => {
    const { db, seed } = await seededDb();
    const supplierId = await newSupplierWithOpening(db, seed, '2000', daysAgoISO(40));
    const inv = await saveInvoice(db, {
      docType: 'purchase',
      payStatus: 'credit',
      issuedAt: daysAgoISO(25),
      supplierId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '500' }],
    });
    await recordVoucher(db, {
      txType: 'payment',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '300',
      exchangeRate: '1',
      txDate: daysAgoISO(20),
      supplierId,
    });
    await createLinkedReturn(db, {
      docType: 'purchase_return',
      originalInvoiceId: inv.invoiceId,
      issuedAt: daysAgoISO(10),
      returnPayDirection: 'account',
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '0.2', unitPrice: '500' }],
    });
    const res = await getStatementLines(db, 'supplier', supplierId, seed.yerId);
    expect(res.lines.map((l) => l.docKind)).toEqual(['opening', 'invoice', 'payment', 'return']);
    expect(res.lines.map((l) => l.direction)).toEqual(['debit', 'debit', 'credit', 'credit']);
    expect(res.closingBalance).toBe('2100.0000');
    expect(res.partyName).toBe('مورد الرياض');
  });

  test('أخطاء واضحة: طرف/عملة غير موجودة وتاريخ غير صالح', async () => {
    const { db, seed } = await seededDb();
    await expect(getPartyBalanceByCurrency(db, 'customer', 999)).rejects.toBeInstanceOf(DomainRuleError);
    await expect(getStatementLines(db, 'customer', 999, seed.yerId)).rejects.toThrow('غير موجود');
    await expect(
      getStatementLines(db, 'customer', seed.customerId, 999),
    ).rejects.toThrow('العملة غير موجودة');
    await expect(
      getStatementLines(db, 'customer', seed.customerId, seed.yerId, { from: '15-06-2026' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

/* ==================== AC-18 — التسوية بعملة مختلفة (قرار 8) ==================== */

describe('AC-18 — دين SAR حُصِّل بصندوق YER: كشف السعودي يتوازن صفراً', () => {
  test('الكشف بالريال السعودي: فاتورة 1000 وتخصيص 1000 → صفر تماماً + fx مستقل', async () => {
    const { db, seed } = await seededDb();
    await upsertDailyRate(db, seed.sarId, daysAgoISO(20), '530');
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(20),
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.sarId,
      lines: [{ productId: seed.deliveryId, qty: '1', unitPrice: '1000' }],
    });
    await upsertDailyRate(db, seed.sarId, daysAgoISO(5), '560');
    const voucher = await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '560000',
      exchangeRate: '1',
      txDate: daysAgoISO(5),
      customerId: seed.customerId,
      allocations: [{ invoiceId: inv.invoiceId, amount: '1000' }],
    });
    // فرق الصرف 30,000 سُجل في fx_gain_loss (بند مستقل — لا يُدفن في رصيد)
    expect(voucher.fxGainLoss).toBe('30000.0000');
    expect(voucher.onAccountAmount).toBe('0.0000');
    // الكشف بالسعودي: فاتورة مدين 1000 + تخصيص دائن 1000 → يتوازن تماماً
    const res = await getStatementLines(db, 'customer', seed.customerId, seed.sarId);
    expect(res.lines.map((l) => l.docKind)).toEqual(['invoice', 'receipt']);
    expect(res.lines[1]!.amount).toBe('1000.0000');
    expect(res.lines[1]!.description).toContain('تخصيص لفاتورة');
    expect(res.closingBalance).toBe('0.0000');
    expect(res.otherCurrencies).toEqual([]);
    // لا أرصدة بأي عملة (السعودي صفر واليمني بلا سطر «على الحساب»)
    expect(await getPartyBalanceByCurrency(db, 'customer', seed.customerId)).toEqual([]);
  });

  test('سطر إرشادي عند وجود أرصدة بعملات أخرى (بدّل عملة الكشف)', async () => {
    const { db, seed } = await seededDb();
    const customerId = await newCustomerWithOpening(db, seed, '1000', daysAgoISO(40));
    await upsertDailyRate(db, seed.sarId, daysAgoISO(10), '530');
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(10),
      customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.sarId,
      lines: [{ productId: seed.deliveryId, qty: '1', unitPrice: '50' }],
    });
    const res = await getStatementLines(db, 'customer', customerId, seed.sarId);
    expect(res.lines.map((l) => l.docKind)).toEqual(['invoice', 'note']);
    expect(res.lines[1]!.description).toContain('YER');
    expect(res.lines[1]!.amount).toBe('0.0000'); // السطر الإرشادي لا يغير الرصيد
    expect(res.lines[1]!.runningBalance).toBe('50.0000');
    expect(res.otherCurrencies).toEqual([
      { currencyId: seed.yerId, currencyCode: 'YER', balance: '1000.0000' },
    ]);
    expect(res.closingBalance).toBe('50.0000');
  });

  test('عملة الكشف بلا حركات: سطور فارغة ورصيد صفر (بلا تسريب من عملة أخرى)', async () => {
    const { db, seed } = await seededDb();
    const { customerId } = await fr0302Scenario(db, seed);
    const res = await getStatementLines(db, 'customer', customerId, seed.sarId);
    expect(res.lines.map((l) => l.docKind)).toEqual(['note']);
    expect(res.closingBalance).toBe('0.0000');
    expect(res.otherCurrencies.length).toBe(1);
    expect(res.otherCurrencies[0]!.currencyCode).toBe('YER');
    expect(res.otherCurrencies[0]!.balance).toBe('5107.0000');
  });
});
