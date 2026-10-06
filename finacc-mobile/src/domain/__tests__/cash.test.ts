/**
 * cash.test.ts — سندات النقدية: تخصيص FIFO + فروق الصرف + الترقيم + الإلغاء
 * (SRS FR-04-01..10 / قرار 8 / §10.2 allocations).
 */
import { describe, expect, test } from 'bun:test';
import type { SqliteAdapter } from '../../db/adapter';
import { d } from '../../utils/money';
import { recordOpeningStock } from '../inventory';
import { saveInvoice } from '../invoicing';
import { upsertDailyRate } from '../currency';
import { FiscalPeriodClosedError, MissingRateError, ValidationError } from '../errors';
import {
  ensureVoucherNo,
  recordBoxTransfer,
  recordExpense,
  recordOwnerTx,
  recordVoucher,
  voidCashTx,
} from '../cash';
import type { RecordVoucherInput } from '../cash';
import { daysAgoISO, seededDb } from './seed';
import type { Seed } from './seed';

const TODAY = daysAgoISO(0);
const YEAR = TODAY.slice(0, 4);

/* ============================ مساعدات ============================ */

async function openMilk(db: SqliteAdapter, seed: Seed, qty = '100', cost = '90'): Promise<void> {
  await recordOpeningStock(db, {
    productId: seed.milkId,
    warehouseId: seed.warehouseId,
    qty: d(qty),
    unitCost: d(cost),
    movedAt: daysAgoISO(12),
  });
}

async function creditSale(
  db: SqliteAdapter,
  seed: Seed,
  qty: string,
  price: string,
  issuedAt: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const res = await saveInvoice(db, {
    docType: 'sale',
    payStatus: 'credit',
    issuedAt,
    customerId: seed.customerId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.milkId, qty, unitPrice: price }],
    ...overrides,
  });
  return res;
}

async function creditPurchase(
  db: SqliteAdapter,
  seed: Seed,
  qty: string,
  price: string,
  issuedAt: string,
) {
  return saveInvoice(db, {
    docType: 'purchase',
    payStatus: 'credit',
    issuedAt,
    supplierId: seed.supplierId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.milkId, qty, unitPrice: price }],
  });
}

function receiptInput(
  seed: Seed,
  amount: string,
  overrides: Partial<RecordVoucherInput> = {},
): RecordVoucherInput {
  return {
    txType: 'receipt',
    cashboxId: seed.cashboxId,
    currencyId: seed.yerId,
    amount,
    exchangeRate: '1',
    txDate: TODAY,
    customerId: seed.customerId,
    ...overrides,
  };
}

function paymentInput(
  seed: Seed,
  amount: string,
  overrides: Partial<RecordVoucherInput> = {},
): RecordVoucherInput {
  return {
    txType: 'payment',
    cashboxId: seed.cashboxId,
    currencyId: seed.yerId,
    amount,
    exchangeRate: '1',
    txDate: TODAY,
    supplierId: seed.supplierId,
    ...overrides,
  };
}

/** ثلاث فواتير آجلة مفتوحة: A=230 (أقدم) B=115 C=345 — المجموع 690 */
async function threeOpenInvoices(db: SqliteAdapter, seed: Seed) {
  const a = await creditSale(db, seed, '2', '115', daysAgoISO(5));
  const b = await creditSale(db, seed, '1', '115', daysAgoISO(3));
  const c = await creditSale(db, seed, '3', '115', daysAgoISO(1));
  return { a, b, c };
}

async function allocationsOf(db: SqliteAdapter, cashTxId: number) {
  return db.all<{ invoice_id: number; allocated_amount: string }>(
    'SELECT invoice_id, allocated_amount FROM payment_allocation WHERE cash_tx_id = ? ORDER BY invoice_id',
    [cashTxId],
  );
}

async function cashRow(db: SqliteAdapter, id: number) {
  const rows = await db.all<Record<string, string | number | null>>(
    'SELECT * FROM cash_tx WHERE id = ?',
    [id],
  );
  return rows[0];
}

async function insertExpenseCategory(
  db: SqliteAdapter,
  name: string,
  archived = false,
): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO expense_category (name, is_archived, created_at, updated_at)
     VALUES (?, ?, ?, ?) RETURNING id`,
    [name, archived ? 1 : 0, now, now],
  );
  return Number(rows[0]!.id);
}

async function insertCashbox(db: SqliteAdapter, name: string, currencyId: number): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO cashbox (name, currency_id, created_at, updated_at)
     VALUES (?, ?, ?, ?) RETURNING id`,
    [name, currencyId, now, now],
  );
  return Number(rows[0]!.id);
}

async function insertClosedFiscalYear(db: SqliteAdapter, year: number): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO fiscal_year (year, start_date, end_date, status, created_at, updated_at)
     VALUES (?, ?, ?, 'closed', ?, ?)`,
    [year, `${year}-01-01`, `${year}-12-31`, now, now],
  );
}

/* ==================== التخصيص FIFO (FR-04-03) ==================== */

describe('recordVoucher — سند قبض/صرف + تخصيص FIFO (FR-04-03)', () => {
  test('FIFO عبر 3 فواتير: الأقدم أولاً بمبالغ جزئية (400 → 230+115+55)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const { a, b, c } = await threeOpenInvoices(db, seed);
    const res = await recordVoucher(db, receiptInput(seed, '400'));
    expect(res.voucherNo).toBe(`RVT-${YEAR}-00001`);
    expect(res.onAccountAmount).toBe('0.0000');
    expect(res.settlementRate).toBeNull();
    expect(res.fxGainLoss).toBe('0.0000');
    const allocs = await allocationsOf(db, res.cashTxId);
    expect(allocs.length).toBe(3);
    expect(allocs).toEqual([
      { invoice_id: a.invoiceId, allocated_amount: '230.0000' },
      { invoice_id: b.invoiceId, allocated_amount: '115.0000' },
      { invoice_id: c.invoiceId, allocated_amount: '55.0000' },
    ]);
  });

  test('FIFO جزئي يترك الأحدث مفتوحاً (300 → 230+70 فقط، بلا باقٍ)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const { a, b, c } = await threeOpenInvoices(db, seed);
    const res = await recordVoucher(db, receiptInput(seed, '300'));
    const allocs = await allocationsOf(db, res.cashTxId);
    expect(allocs).toEqual([
      { invoice_id: a.invoiceId, allocated_amount: '230.0000' },
      { invoice_id: b.invoiceId, allocated_amount: '70.0000' },
    ]);
    expect(c.invoiceId).toBeDefined();
    expect(res.onAccountAmount).toBe('0.0000');
  });

  test('سداد يتجاوز الفواتير المفتوحة: الباقي «على الحساب» (700 → 690 + 10 دائن)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await threeOpenInvoices(db, seed);
    const res = await recordVoucher(db, receiptInput(seed, '700'));
    expect(res.onAccountAmount).toBe('10.0000');
    // لا بنود تخصيص إضافية للباقي — قبض حر ref_type='on_account' فقط
    const allocs = await allocationsOf(db, res.cashTxId);
    const sum = allocs.reduce((acc, r) => acc.plus(d(r.allocated_amount)), d(0));
    expect(sum.toFixed(4)).toBe('690.0000');
    const row = await cashRow(db, res.cashTxId);
    expect(row!.ref_type).toBe('on_account');
    expect(row!.amount).toBe('700.0000');
  });

  test('قبض على الحساب بلا فواتير مفتوحة: رصيد دائن كامل للعميل (−500)', async () => {
    const { db, seed } = await seededDb();
    const res = await recordVoucher(db, receiptInput(seed, '500', { description: 'دفعة مقدمة' }));
    expect(res.allocations).toEqual([]);
    expect(res.onAccountAmount).toBe('500.0000');
    const allocs = await allocationsOf(db, res.cashTxId);
    expect(allocs.length).toBe(0);
    const row = await cashRow(db, res.cashTxId);
    expect(row!.ref_type).toBe('on_account');
    expect(row!.description).toBe('دفعة مقدمة');
  });

  test('تخصيص صريح يحل محل FIFO (100 على B و200 على C فقط)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const { a, b, c } = await threeOpenInvoices(db, seed);
    const res = await recordVoucher(
      db,
      receiptInput(seed, '300', {
        allocations: [
          { invoiceId: b.invoiceId, amount: '100' },
          { invoiceId: c.invoiceId, amount: '200' },
        ],
      }),
    );
    const allocs = await allocationsOf(db, res.cashTxId);
    expect(allocs).toEqual([
      { invoice_id: b.invoiceId, allocated_amount: '100.0000' },
      { invoice_id: c.invoiceId, allocated_amount: '200.0000' },
    ]);
    void a;
    expect(res.onAccountAmount).toBe('0.0000');
  });

  test('تخصيص صريح يتجاوز متبقي الفاتورة → رفض بتسمية المتبقي (AC-21 روحياً)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const { b } = await threeOpenInvoices(db, seed);
    await expect(
      recordVoucher(db, receiptInput(seed, '500', { allocations: [{ invoiceId: b.invoiceId, amount: '300' }] })),
    ).rejects.toThrow('يتجاوز المتبقي');
  });

  test('مجموع التخصيص يتجاوز مبلغ السند → رفض ALLOCATION_EXCEEDS_VOUCHER', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const { a } = await threeOpenInvoices(db, seed);
    await expect(
      recordVoucher(db, receiptInput(seed, '100', { allocations: [{ invoiceId: a.invoiceId, amount: '230' }] })),
    ).rejects.toThrow('يتجاوز مبلغ السند');
  });

  test('تخصيص لفاتورة طرف آخر → رفض', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const other = await db.all<{ id: number }>(
      `INSERT INTO customer (name, created_at, updated_at) VALUES ('سالم', ?, ?) RETURNING id`,
      [new Date().toISOString(), new Date().toISOString()],
    );
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: TODAY,
      customerId: Number(other[0]!.id),
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '50' }],
    });
    await expect(
      recordVoucher(
        db,
        receiptInput(seed, '50', { allocations: [{ invoiceId: inv.invoiceId, amount: '50' }] }),
      ),
    ).rejects.toThrow('تخص طرفاً آخر');
  });

  test('تخصيص سند قبض لفاتورة شراء (عائلة خاطئة) → رفض', async () => {
    const { db, seed } = await seededDb();
    const pur = await creditPurchase(db, seed, '2', '90', daysAgoISO(2));
    await expect(
      recordVoucher(
        db,
        receiptInput(seed, '180', { allocations: [{ invoiceId: pur.invoiceId, amount: '180' }] }),
      ),
    ).rejects.toThrow('فواتير البيع');
  });

  test('تخصيص لفاتورة ملغاة → رفض (لا تخصيص على ملغاة)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const { voidInvoice } = await import('../invoicing');
    const a = await creditSale(db, seed, '2', '115', daysAgoISO(5));
    await voidInvoice(db, a.invoiceId, { createdBy: 1 });
    await expect(
      recordVoucher(db, receiptInput(seed, '230', { allocations: [{ invoiceId: a.invoiceId, amount: '230' }] })),
    ).rejects.toThrow('ليست مفتوحة للتخصيص');
  });

  test('تكرار نفس الفاتورة في التخصيص → رفض (PK واحد لكل زوج)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const { a } = await threeOpenInvoices(db, seed);
    await expect(
      recordVoucher(
        db,
        receiptInput(seed, '120', {
          allocations: [
            { invoiceId: a.invoiceId, amount: '50' },
            { invoiceId: a.invoiceId, amount: '70' },
          ],
        }),
      ),
    ).rejects.toThrow('تكرار تخصيص');
  });

  test('سند صرف لمورّد يخصص FIFO فواتير الشراء المفتوحة', async () => {
    const { db, seed } = await seededDb();
    await creditPurchase(db, seed, '2', '200', daysAgoISO(4)); // 400
    await creditPurchase(db, seed, '1', '200', daysAgoISO(2)); // 200
    const res = await recordVoucher(db, paymentInput(seed, '500'));
    expect(res.voucherNo).toBe(`PMT-${YEAR}-00001`);
    const allocs = await allocationsOf(db, res.cashTxId);
    expect(allocs.length).toBe(2);
    expect(allocs[0]!.allocated_amount).toBe('400.0000');
    expect(allocs[1]!.allocated_amount).toBe('100.0000');
    expect(res.onAccountAmount).toBe('0.0000');
  });
});

/* ==================== أركان السند والتحقق ==================== */

describe('recordVoucher — أركان السند (قرار 3: لا سعر افتراضي)', () => {
  test('سند قبض بلا عميل → رفض؛ وسند صرف بلا مورد → رفض', async () => {
    const { db, seed } = await seededDb();
    await expect(recordVoucher(db, receiptInput(seed, '100', { customerId: undefined }))).rejects.toThrow(
      'يتطلب اختيار العميل',
    );
    await expect(recordVoucher(db, paymentInput(seed, '100', { supplierId: undefined }))).rejects.toThrow(
      'يتطلب اختيار المورّد',
    );
  });

  test('خلط الأطراف (قبض بمورد / صرف بعميل) → رفض', async () => {
    const { db, seed } = await seededDb();
    await expect(
      recordVoucher(db, receiptInput(seed, '100', { supplierId: seed.supplierId })),
    ).rejects.toThrow('سند القبض يخص العملاء');
    await expect(
      recordVoucher(db, paymentInput(seed, '100', { customerId: seed.customerId })),
    ).rejects.toThrow('سند الصرف يخص الموردين');
  });

  test('مبلغ صفر أو سالب → رفض قبل SQL (CHECK amount > 0)', async () => {
    const { db, seed } = await seededDb();
    await expect(recordVoucher(db, receiptInput(seed, '0'))).rejects.toBeInstanceOf(ValidationError);
    await expect(recordVoucher(db, receiptInput(seed, '-5'))).rejects.toBeInstanceOf(ValidationError);
  });

  test('سعر صرف العملة الأساسية يجب أن يكون 1 (لا مسار بسعر آخر)', async () => {
    const { db, seed } = await seededDb();
    await expect(recordVoucher(db, receiptInput(seed, '100', { exchangeRate: '530' }))).rejects.toThrow(
      'سعر صرفها 1 دائماً',
    );
    const res = await recordVoucher(db, receiptInput(seed, '100'));
    const row = await cashRow(db, res.cashTxId);
    expect(row!.exchange_rate).toBe('1.000000');
  });

  test('سعر صرف غائب/صفر → رفض (قرار 3: إدخال إلزامي)', async () => {
    const { db, seed } = await seededDb();
    await expect(recordVoucher(db, receiptInput(seed, '100', { exchangeRate: '0' }))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test('صندوق أو عملة أو طرف غير موجود → رفض واضح', async () => {
    const { db, seed } = await seededDb();
    await expect(recordVoucher(db, receiptInput(seed, '100', { cashboxId: 999 }))).rejects.toThrow(
      'الصندوق غير موجود',
    );
    await expect(recordVoucher(db, receiptInput(seed, '100', { currencyId: 999 }))).rejects.toThrow(
      'العملة غير موجودة',
    );
    await expect(recordVoucher(db, receiptInput(seed, '100', { customerId: 999 }))).rejects.toThrow(
      'العميل غير موجود',
    );
  });

  test('تاريخ داخل سنة مالية مغلقة → رفض قاطع (AC-16)', async () => {
    const { db, seed } = await seededDb();
    await insertClosedFiscalYear(db, 2026);
    await expect(
      recordVoucher(db, receiptInput(seed, '100', { txDate: '2026-06-15' })),
    ).rejects.toBeInstanceOf(FiscalPeriodClosedError);
    await expect(
      recordVoucher(db, paymentInput(seed, '100', { txDate: '2026-06-15' })),
    ).rejects.toBeInstanceOf(FiscalPeriodClosedError);
  });
});

/* ==================== فروق الصرف (FR-08-10 / قرار 8 / AC-18) ==================== */

describe('recordVoucher — فروق الصرف المحققة (FR-08-10 / AC-18)', () => {
  test('دين SAR 1000 بسعر 530 حُصِّل بصندوق YER بسعر 560 → fx +30,000', async () => {
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
    const res = await recordVoucher(
      db,
      receiptInput(seed, '560000', {
        txDate: daysAgoISO(5),
        allocations: [{ invoiceId: inv.invoiceId, amount: '1000' }],
      }),
    );
    expect(res.settlementRate).toBe('560.000000');
    expect(res.fxGainLoss).toBe('30000.0000');
    expect(res.onAccountAmount).toBe('0.0000');
    expect(res.allocations).toEqual([
      { invoiceId: inv.invoiceId, invoiceNo: inv.invoiceNo, allocatedAmount: '1000.0000' },
    ]);
    const row = await cashRow(db, res.cashTxId);
    expect(row!.settlement_rate).toBe('560.000000');
    expect(row!.fx_gain_loss).toBe('30000.0000');
    expect(row!.exchange_rate).toBe('1.000000');
  });

  test('دفع فاتورة شراء SAR بعملة مختلفة والسعر ارتفع → fx خسارة (−30,000)', async () => {
    const { db, seed } = await seededDb();
    await upsertDailyRate(db, seed.sarId, daysAgoISO(20), '530');
    const inv = await saveInvoice(db, {
      docType: 'purchase',
      payStatus: 'credit',
      issuedAt: daysAgoISO(20),
      supplierId: seed.supplierId,
      warehouseId: seed.warehouseId,
      currencyId: seed.sarId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '1000' }],
    });
    await upsertDailyRate(db, seed.sarId, daysAgoISO(5), '560');
    const res = await recordVoucher(
      db,
      paymentInput(seed, '560000', {
        txDate: daysAgoISO(5),
        allocations: [{ invoiceId: inv.invoiceId, amount: '1000' }],
      }),
    );
    expect(res.fxGainLoss).toBe('-30000.0000');
  });

  test('تسوية بنفس عملة الفاتورة → fx = 0 وsettlement_rate NULL', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const { a } = await threeOpenInvoices(db, seed);
    const res = await recordVoucher(
      db,
      receiptInput(seed, '230', { allocations: [{ invoiceId: a.invoiceId, amount: '230' }] }),
    );
    expect(res.fxGainLoss).toBe('0.0000');
    expect(res.settlementRate).toBeNull();
  });

  test('لا سعر ليوم الدفع لعملة الفاتورة → MissingRateError (صارم بلا fallback)', async () => {
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
    // لا سعر SAR بتاريخ السند (daysAgoISO(5))
    await expect(
      recordVoucher(
        db,
        receiptInput(seed, '560000', {
          txDate: daysAgoISO(5),
          allocations: [{ invoiceId: inv.invoiceId, amount: '1000' }],
        }),
      ),
    ).rejects.toBeInstanceOf(MissingRateError);
  });

  test('FIFO التلقائي لا يمس فواتير بعملة أخرى (نفس العملة حصراً)', async () => {
    const { db, seed } = await seededDb();
    await upsertDailyRate(db, seed.sarId, daysAgoISO(10), '530');
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(10),
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.sarId,
      lines: [{ productId: seed.deliveryId, qty: '1', unitPrice: '1000' }],
    });
    // سند YER بلا تخصيص صريح: لا يُخصص لفاتورة SAR (يحتاج تخصيصاً صريحاً)
    const res = await recordVoucher(db, receiptInput(seed, '500'));
    expect(res.allocations).toEqual([]);
    expect(res.onAccountAmount).toBe('500.0000');
  });
});

/* ==================== الترقيم RVT-/PMT- (FR-04-10) ==================== */

describe('ترقيم السندات RVT-/PMT- (FR-04-10)', () => {
  test('عدادات مستقلة: RVT-00001 ثم RVT-00002 وPMT-00001 حسب النوع', async () => {
    const { db, seed } = await seededDb();
    const r1 = await recordVoucher(db, receiptInput(seed, '100'));
    const r2 = await recordVoucher(db, receiptInput(seed, '50'));
    const p1 = await recordVoucher(db, paymentInput(seed, '70'));
    expect(r1.voucherNo).toBe(`RVT-${YEAR}-00001`);
    expect(r2.voucherNo).toBe(`RVT-${YEAR}-00002`);
    expect(p1.voucherNo).toBe(`PMT-${YEAR}-00001`);
  });

  test('الرقم لا يُعاد بعد الإلغاء — السند التالي يستهلك رقماً جديداً (AC-11)', async () => {
    const { db, seed } = await seededDb();
    const r1 = await recordVoucher(db, receiptInput(seed, '100'));
    await voidCashTx(db, r1.cashTxId, { createdBy: 1 });
    const r2 = await recordVoucher(db, receiptInput(seed, '100'));
    expect(r2.voucherNo).toBe(`RVT-${YEAR}-00002`);
    expect(r2.voucherNo).not.toBe(r1.voucherNo);
  });

  test('فشل معاملة الحفظ يرجع الرقم معها (ذرّية 5.4-4)', async () => {
    const { db, seed } = await seededDb();
    await expect(recordVoucher(db, receiptInput(seed, '0'))).rejects.toThrow();
    const res = await recordVoucher(db, receiptInput(seed, '100'));
    expect(res.voucherNo).toBe(`RVT-${YEAR}-00001`); // الرقم الصفري لم يُصدر
  });
});

/* ==================== المصروف ومالك (FR-04-05 / FR-04-02) ==================== */

describe('recordExpense / recordOwnerTx', () => {
  test('مصروف بفئة إلزامية: صف tx_type=expense + فئة مربوطة + بلا رقم سند', async () => {
    const { db, seed } = await seededDb();
    const catId = await insertExpenseCategory(db, 'نقل');
    const res = await recordExpense(db, {
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '1500',
      exchangeRate: '1',
      txDate: TODAY,
      expenseCategoryId: catId,
      description: 'أجرة نقل بضاعة',
    });
    const row = await cashRow(db, res.cashTxId);
    expect(row!.tx_type).toBe('expense');
    expect(row!.expense_category_id).toBe(catId);
    expect(row!.voucher_no).toBeNull();
    expect(row!.amount).toBe('1500.0000');
    expect(row!.fx_gain_loss).toBe('0.0000');
  });

  test('فئة غير موجودة أو مؤرشفة → رفض (FR-04-05)', async () => {
    const { db, seed } = await seededDb();
    await expect(
      recordExpense(db, {
        cashboxId: seed.cashboxId,
        currencyId: seed.yerId,
        amount: '10',
        exchangeRate: '1',
        txDate: TODAY,
        expenseCategoryId: 999,
      }),
    ).rejects.toThrow('فئة المصروف غير موجودة');
    const archivedId = await insertExpenseCategory(db, 'قديمة', true);
    await expect(
      recordExpense(db, {
        cashboxId: seed.cashboxId,
        currencyId: seed.yerId,
        amount: '10',
        exchangeRate: '1',
        txDate: TODAY,
        expenseCategoryId: archivedId,
      }),
    ).rejects.toThrow('مؤرشفة');
  });

  test('مسحوبات مالك وإيداع مالك: النوع والوصف والاتجاه من tx_type (AC-19)', async () => {
    const { db, seed } = await seededDb();
    const draw = await recordOwnerTx(db, {
      txKind: 'owner_draw',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '50000',
      exchangeRate: '1',
      txDate: TODAY,
    });
    const cap = await recordOwnerTx(db, {
      txKind: 'capital_in',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '20000',
      exchangeRate: '1',
      txDate: TODAY,
    });
    const drawRow = await cashRow(db, draw.cashTxId);
    const capRow = await cashRow(db, cap.cashTxId);
    expect(drawRow!.tx_type).toBe('owner_draw');
    expect(drawRow!.description).toBe('مسحوبات مالك');
    expect(capRow!.tx_type).toBe('capital_in');
    expect(capRow!.description).toBe('إيداع مالك');
  });

  test('مصروف بسنة مغلقة → رفض (5.4-11)', async () => {
    const { db, seed } = await seededDb();
    const catId = await insertExpenseCategory(db, 'نقل');
    await insertClosedFiscalYear(db, 2026);
    await expect(
      recordExpense(db, {
        cashboxId: seed.cashboxId,
        currencyId: seed.yerId,
        amount: '10',
        exchangeRate: '1',
        txDate: '2026-02-01',
        expenseCategoryId: catId,
      }),
    ).rejects.toBeInstanceOf(FiscalPeriodClosedError);
  });
});

/* ==================== التحويل بين صندوقين (FR-04-07) ==================== */

describe('recordBoxTransfer — تحويل بين صندوقين (FR-04-07)', () => {
  test('نفس العملة: صادر + وارد بنفس المبلغ وfx=0 وربط transfer', async () => {
    const { db, seed } = await seededDb();
    const box2 = await insertCashbox(db, 'صندوق الفرع', seed.yerId);
    const res = await recordBoxTransfer(db, {
      fromCashboxId: seed.cashboxId,
      toCashboxId: box2,
      amount: '500',
      txDate: TODAY,
    });
    expect(res.toAmount).toBe('500.0000');
    expect(res.fxGainLoss).toBe('0.0000');
    const out = await cashRow(db, res.outCashTxId);
    const inRow = await cashRow(db, res.inCashTxId);
    expect(out!.tx_type).toBe('box_transfer');
    expect(out!.cashbox_id).toBe(seed.cashboxId);
    expect(out!.to_cashbox_id).toBe(box2);
    expect(out!.amount).toBe('500.0000');
    expect(inRow!.cashbox_id).toBe(box2);
    expect(inRow!.to_cashbox_id).toBeNull();
    expect(inRow!.ref_type).toBe('transfer');
    expect(inRow!.ref_id).toBe(res.outCashTxId);
    expect(inRow!.amount).toBe('500.0000');
  });

  test('صندوقان بنفس العملة بمبالغ مختلفة → رفض', async () => {
    const { db, seed } = await seededDb();
    const box2 = await insertCashbox(db, 'صندوق الفرع', seed.yerId);
    await expect(
      recordBoxTransfer(db, {
        fromCashboxId: seed.cashboxId,
        toCashboxId: box2,
        amount: '500',
        toAmount: '490',
        txDate: TODAY,
      }),
    ).rejects.toThrow('يساوي مبلغ الصادر');
  });

  test('نفس الصندوق → رفض', async () => {
    const { db, seed } = await seededDb();
    await expect(
      recordBoxTransfer(db, {
        fromCashboxId: seed.cashboxId,
        toCashboxId: seed.cashboxId,
        amount: '100',
        txDate: TODAY,
      }),
    ).rejects.toThrow('نفس الصندوق');
  });

  test('عملتان مختلفتان: لقطة السعرين والفرق في fx_gain_loss (FR-04-07)', async () => {
    const { db, seed } = await seededDb();
    const sarBox = await insertCashbox(db, 'صندوق السعودي', seed.sarId);
    await upsertDailyRate(db, seed.sarId, daysAgoISO(1), '530');
    // مشتق: 530,000 YER ÷ 530 = 1,000 SAR — بلا فرق
    const derived = await recordBoxTransfer(db, {
      fromCashboxId: seed.cashboxId,
      toCashboxId: sarBox,
      amount: '530000',
      txDate: daysAgoISO(1),
    });
    expect(derived.toAmount).toBe('1000.0000');
    expect(derived.fxGainLoss).toBe('0.0000');
    // فعلي: وصل 950 SAR فقط → خسارة تحويل 950×530 − 530,000 = −26,500
    const actual = await recordBoxTransfer(db, {
      fromCashboxId: seed.cashboxId,
      toCashboxId: sarBox,
      amount: '530000',
      toAmount: '950',
      txDate: daysAgoISO(1),
    });
    expect(actual.fxGainLoss).toBe('-26500.0000');
    const out = await cashRow(db, actual.outCashTxId);
    expect(out!.settlement_rate).toBe('530.000000');
    expect(out!.fx_gain_loss).toBe('-26500.0000');
  });
});

/* ==================== الإلغاء بحركة معاكسة (FR-04-08) ==================== */

describe('voidCashTx — الإلغاء بحركة معاكسة (FR-04-08)', () => {
  test('إلغاء سند قبض: is_voided=1 + معاكسة صرف reversal_of + قيد audit + فك التخصيص', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await threeOpenInvoices(db, seed);
    const res = await recordVoucher(db, receiptInput(seed, '400'));
    await voidCashTx(db, res.cashTxId, { createdBy: 1 });

    const orig = await cashRow(db, res.cashTxId);
    expect(orig!.is_voided).toBe(1);
    expect(orig!.voucher_no).toBe(`RVT-${YEAR}-00001`); // الرقم باقٍ ولا يُعاد

    const reversals = await db.all<Record<string, string | number | null>>(
      'SELECT * FROM cash_tx WHERE reversal_of = ?',
      [res.cashTxId],
    );
    expect(reversals.length).toBe(1);
    const rev = reversals[0]!;
    expect(rev.tx_type).toBe('payment'); // قبض → معاكسة صرف
    expect(rev.amount).toBe('400.0000');
    expect(rev.voucher_no).toBeNull();
    expect(rev.customer_id).toBe(seed.customerId);
    expect(rev.ref_type).toBe('cash_void');
    expect(rev.is_voided).toBe(0);
    expect(rev.tx_date).toBe(TODAY);

    // لا بنود تخصيص للحركة المعاكسة (الاستعلامات تستبعد الأصل الملغى)
    const revAllocs = await allocationsOf(db, Number(rev.id));
    expect(revAllocs.length).toBe(0);

    // قيد audit
    const audits = await db.all<{ action: string; entity: string; entity_id: number }>(
      'SELECT action, entity, entity_id FROM audit_log WHERE entity = ? AND entity_id = ?',
      ['cash_tx', res.cashTxId],
    );
    expect(audits.some((a) => a.action === 'void_cash_tx')).toBe(true);

    // فك التخصيص: سند جديد يخصص FIFO من الصفر (الفواتير فتحت من جديد)
    const res2 = await recordVoucher(db, receiptInput(seed, '300'));
    const allocs2 = await allocationsOf(db, res2.cashTxId);
    expect(allocs2[0]!.allocated_amount).toBe('230.0000');
    expect(allocs2[1]!.allocated_amount).toBe('70.0000');
  });

  test('إلغاء معاكسة → رفض؛ وإلغاء ملغاة سابقاً → رفض', async () => {
    const { db, seed } = await seededDb();
    const res = await recordVoucher(db, receiptInput(seed, '100'));
    await voidCashTx(db, res.cashTxId);
    await expect(voidCashTx(db, res.cashTxId)).rejects.toThrow('ملغاة سابقاً');
    const rev = await db.all<{ id: number }>('SELECT id FROM cash_tx WHERE reversal_of = ?', [
      res.cashTxId,
    ]);
    await expect(voidCashTx(db, Number(rev[0]!.id))).rejects.toThrow('حركة معاكسة');
  });

  test('حركة تابعة لمستند (نقدية فاتورة) → الإلغاء من المستند نفسه فقط', async () => {
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
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    });
    const txs = await db.all<{ id: number }>(
      "SELECT id FROM cash_tx WHERE ref_type = 'invoice' AND reversal_of IS NULL",
    );
    await expect(voidCashTx(db, Number(txs[0]!.id))).rejects.toThrow('من المستند نفسه');
  });

  test('إلغاء مصروف → معاكسة receipt (استرداد نقدي)', async () => {
    const { db, seed } = await seededDb();
    const catId = await insertExpenseCategory(db, 'رواتب');
    const res = await recordExpense(db, {
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '7000',
      exchangeRate: '1',
      txDate: TODAY,
      expenseCategoryId: catId,
    });
    await voidCashTx(db, res.cashTxId);
    const rev = await db.all<{ tx_type: string; fx_gain_loss: string; expense_category_id: number }>(
      'SELECT tx_type, fx_gain_loss, expense_category_id FROM cash_tx WHERE reversal_of = ?',
      [res.cashTxId],
    );
    expect(rev[0]!.tx_type).toBe('receipt');
    expect(rev[0]!.fx_gain_loss).toBe('0.0000');
    expect(rev[0]!.expense_category_id).toBe(catId);
  });

  test('إلغاء سند بفرق صرف → معاكسته تحمل fx معكوساً (يُلغى أثر الأرباح)', async () => {
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
    const res = await recordVoucher(
      db,
      receiptInput(seed, '560000', {
        txDate: daysAgoISO(5),
        allocations: [{ invoiceId: inv.invoiceId, amount: '1000' }],
      }),
    );
    await voidCashTx(db, res.cashTxId);
    const rev = await db.all<{ fx_gain_loss: string; settlement_rate: string | null }>(
      'SELECT fx_gain_loss, settlement_rate FROM cash_tx WHERE reversal_of = ?',
      [res.cashTxId],
    );
    expect(rev[0]!.fx_gain_loss).toBe('-30000.0000');
    expect(rev[0]!.settlement_rate).toBe('560.000000');
  });

  test('إلغاء تحويل بين صندوقين → الشطران معاً + معاكسة لكل شطر', async () => {
    const { db, seed } = await seededDb();
    const box2 = await insertCashbox(db, 'صندوق الفرع', seed.yerId);
    const res = await recordBoxTransfer(db, {
      fromCashboxId: seed.cashboxId,
      toCashboxId: box2,
      amount: '500',
      txDate: TODAY,
    });
    await voidCashTx(db, res.outCashTxId);
    const out = await cashRow(db, res.outCashTxId);
    const inRow = await cashRow(db, res.inCashTxId);
    expect(out!.is_voided).toBe(1);
    expect(inRow!.is_voided).toBe(1);
    const revs = await db.all<{ id: number; ref_type: string; reversal_of: number }>(
      "SELECT id, ref_type, reversal_of FROM cash_tx WHERE ref_type = 'transfer_void'",
    );
    expect(revs.length).toBe(2);
    expect(new Set(revs.map((r) => Number(r.reversal_of))).size).toBe(2);
  });
});

/* ==================== ترقيم السند عند أول طباعة (FR-04-10) ==================== */

describe('ensureVoucherNo — الرقم عند أول طباعة (FR-04-10)', () => {
  test('يمنح RVT لنقدية فاتورة قديمة بلا رقم ثم يصبح خاملاً (لا استهلاك جديد)', async () => {
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
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    });
    const txs = await db.all<{ id: number; voucher_no: string | null }>(
      "SELECT id, voucher_no FROM cash_tx WHERE tx_type = 'receipt' AND ref_type = 'invoice'",
    );
    expect(txs[0]!.voucher_no).toBeNull();
    const no1 = await ensureVoucherNo(db, Number(txs[0]!.id), { createdBy: 1 });
    expect(no1).toBe(`RVT-${YEAR}-00001`);
    const row = await db.all<{ voucher_no: string }>('SELECT voucher_no FROM cash_tx WHERE id = ?', [
      txs[0]!.id,
    ]);
    expect(row[0]!.voucher_no).toBe(`RVT-${YEAR}-00001`);
    // خامل: النداء الثاني يعيد نفس الرقم
    const no2 = await ensureVoucherNo(db, Number(txs[0]!.id));
    expect(no2).toBe(`RVT-${YEAR}-00001`);
    // سند قبض جديد يستهل الرقم التالي (لا إعادة استخدام)
    const v = await recordVoucher(db, receiptInput(seed, '10'));
    expect(v.voucherNo).toBe(`RVT-${YEAR}-00002`);
  });

  test('PMT لسند الصرف القديم — التمييز بالنوع', async () => {
    const { db, seed } = await seededDb();
    await saveInvoice(db, {
      docType: 'purchase',
      payStatus: 'cash',
      issuedAt: TODAY,
      supplierId: seed.supplierId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      cashboxId: seed.cashboxId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '90' }],
    });
    const txs = await db.all<{ id: number }>(
      "SELECT id FROM cash_tx WHERE tx_type = 'payment' AND ref_type = 'invoice'",
    );
    const no = await ensureVoucherNo(db, Number(txs[0]!.id));
    expect(no).toBe(`PMT-${YEAR}-00001`);
  });

  test('غير القبض/الصرف → رفض؛ والملغاة/المعاكسة → رفض', async () => {
    const { db, seed } = await seededDb();
    const catId = await insertExpenseCategory(db, 'نقل');
    const exp = await recordExpense(db, {
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '10',
      exchangeRate: '1',
      txDate: TODAY,
      expenseCategoryId: catId,
    });
    await expect(ensureVoucherNo(db, exp.cashTxId)).rejects.toThrow('للقبض والصرف فقط');
    // ملغاة بلا رقم: نقدية فاتورة أُلغيت (is_voided=1 بلا voucher_no)
    await openMilk(db, seed);
    const { voidInvoice } = await import('../invoicing');
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'cash',
      issuedAt: TODAY,
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      cashboxId: seed.cashboxId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    });
    await voidInvoice(db, inv.invoiceId, { createdBy: 1 });
    const voidedTx = await db.all<{ id: number }>(
      "SELECT id FROM cash_tx WHERE ref_type = 'invoice' AND is_voided = 1",
    );
    await expect(ensureVoucherNo(db, Number(voidedTx[0]!.id))).rejects.toThrow('لا تُمنح رقم سند');
    // معاكسة سند ملغى: لا تحمل رقماً
    const v = await recordVoucher(db, receiptInput(seed, '10'));
    await voidCashTx(db, v.cashTxId);
    const rev = await db.all<{ id: number }>('SELECT id FROM cash_tx WHERE reversal_of = ?', [
      v.cashTxId,
    ]);
    await expect(ensureVoucherNo(db, Number(rev[0]!.id))).rejects.toThrow('لا تحمل رقم سند');
    // سند ملغى لكنه يحمل رقمه من الحفظ: يعيد رقمه للأرشفة (لا استهلاك جديد)
    const again = await ensureVoucherNo(db, v.cashTxId);
    expect(again).toBe(v.voucherNo);
  });

  test('سند حُفظ عبر recordVoucher يحمل رقمه أصلاً → يعيده دون استهلاك', async () => {
    const { db, seed } = await seededDb();
    const v = await recordVoucher(db, receiptInput(seed, '10'));
    const again = await ensureVoucherNo(db, v.cashTxId);
    expect(again).toBe(v.voucherNo);
    const seq = await db.all<{ last_no: number }>(
      "SELECT last_no FROM doc_sequence WHERE doc_type = 'RVT' AND year = ?",
      [Number(YEAR)],
    );
    expect(Number(seq[0]!.last_no)).toBe(1); // استُهلك رقم واحد فقط
  });
});
