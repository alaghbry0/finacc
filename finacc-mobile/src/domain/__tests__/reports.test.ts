/**
 * reports.test.ts — تقارير الوحدة 09 على خريطة الترحيل (FR-09-02/09/13/14).
 *
 * سيناريو كامل مبذور بيده (أرقام محسوبة يدوياً حرفياً) يغطي كل بند من بنود
 * قائمة الأرباح والخسائر بالصيغة المصححة (قرار 7) + الاستبعادات الموحدة
 * (ملغاة/معاكسة/مسودة) + حدود الفترة الشاملة + تحويل فاتورة أجنبية بسعر 530
 * + فروق الصرف من fx_gain_loss (قرار 8) + الفترات الجاهزة (FR-09-09)
 * + تقرير الشيكات (FR-09-13) + الأرصدة الدائنة للعملاء (FR-09-14).
 */
import { describe, expect, test } from 'bun:test';
import type { SqliteAdapter } from '../../db/adapter';
import { d } from '../../utils/money';
import { ValidationError } from '../errors';
import { applyMovement, recordOpeningStock } from '../inventory';
import { saveInvoice, createLinkedReturn, voidInvoice } from '../invoicing';
import { upsertDailyRate } from '../currency';
import {
  recordBoxTransfer,
  recordExpense,
  recordOwnerTx,
  recordVoucher,
  voidCashTx,
} from '../cash';
import {
  getChequesReport,
  getCustomerCreditBalances,
  getProfitAndLoss,
  resolveReportPeriod,
} from '../reports';
import { daysAgoISO, seededDb } from './seed';
import type { Seed } from './seed';

const TODAY = daysAgoISO(0);
const D1 = daysAgoISO(1);
const D2 = daysAgoISO(2);
const D3 = daysAgoISO(3);
const D4 = daysAgoISO(4);
const D5 = daysAgoISO(5);
const D6 = daysAgoISO(6);
const D7 = daysAgoISO(7);
const D8 = daysAgoISO(8);
const D9 = daysAgoISO(9);
const D10 = daysAgoISO(10);
const D11 = daysAgoISO(11);
const D12 = daysAgoISO(12);

async function addExpenseCategory(db: SqliteAdapter, name = 'عام'): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO expense_category (name, is_archived, created_at, updated_at)
     VALUES (?, 0, ?, ?) RETURNING id`,
    [name, now, now],
  );
  return Number(rows[0]!.id);
}

async function addSarCashbox(db: SqliteAdapter, seed: Seed): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO cashbox (name, currency_id, is_default, created_at, updated_at)
     VALUES ('صندوق السعودي', ?, 0, ?, ?) RETURNING id`,
    [seed.sarId, now, now],
  );
  return Number(rows[0]!.id);
}

/**
 * السيناريو الكامل — كل الأرقام اليدوية أدناه:
 *  - المبيعات: 230 (INV آجل 2×115) + 600 (INV نقدي بخصم بند: 100+500) + 53,000
 *    (فاتورة SAR 100×530) = 53,830 — المسودة والملغاة خارج الحساب.
 *  - مرتجع المبيعات: 115 (SRN نقدي 1×115).
 *  - COGS: 180 (INV1: 2×90) + 90 (INV2: 1×90) = 270 (الخصم لا يمس التكلفة).
 *  - تكلفة المرتجع: 90.
 *  - زيادة الجرد: +2×90 = 180 — العجز: 1×90 = 90.
 *  - المصاريف: 150 (YER) + 10,600 (20 SAR×530) + 10 (حد from) = 10,760
 *    (الملغى 99 ومصروف ما قبل الفترة 25 خارجان).
 *  - فروق الصرف: +3,000 (تحصيل SAR@560 لدين @530) − 46 (تحويل بين صندوقين) = 2,954.
 *  - مسحوبات المالك: 200 — إيداع رأس المال 5,000 لا يظهر إطلاقاً.
 *  - الربح = 53,715 − 180 + 180 − 90 − 10,760 + 2,954 = 45,819
 *  - صافي ما بقي للمالك = 45,819 − 200 = 45,619.
 */
async function fullScenario(): Promise<{ db: SqliteAdapter; seed: Seed }> {
  const { db, seed } = await seededDb();
  // صندوق سعودي ثانٍ للتحويل بين عملتين + فئة مصاريف
  await addSarCashbox(db, seed);
  const catId = await addExpenseCategory(db, 'نقل');

  // مخزون افتتاحي: 100 حليب @ 90 (خارج الفترة — لكنه بلا بند أرباح أصلاً)
  await recordOpeningStock(db, {
    productId: seed.milkId,
    warehouseId: seed.warehouseId,
    qty: d('100'),
    unitCost: d('90'),
    movedAt: D12,
  });

  // INV1 آجل: 2 حليب @ 115 = 230 — COGS 2×90 = 180
  await saveInvoice(db, {
    docType: 'sale',
    payStatus: 'credit',
    issuedAt: D9,
    customerId: seed.customerId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
  });

  // INV2 نقدي: حليب @115 بخصم 15 (=100) + توصيل 500 = 600 — COGS 1×90 = 180
  await saveInvoice(db, {
    docType: 'sale',
    payStatus: 'cash',
    issuedAt: D8,
    customerId: seed.customerId,
    cashboxId: seed.cashboxId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [
      { productId: seed.milkId, qty: '1', unitPrice: '115', discountAmount: '15' },
      { productId: seed.deliveryId, qty: '1', unitPrice: '500' },
    ],
  });

  // فاتورة SAR آجلة: توصيل 100 SAR بسعر 530 → total_base = 53,000 (بلا COGS — خدمي)
  await upsertDailyRate(db, seed.sarId, D7, '530');
  const sarInv = await saveInvoice(db, {
    docType: 'sale',
    payStatus: 'credit',
    issuedAt: D7,
    customerId: seed.customerId,
    warehouseId: seed.warehouseId,
    currencyId: seed.sarId,
    lines: [{ productId: seed.deliveryId, qty: '1', unitPrice: '100' }],
  });

  // مسودة (قرار 2: بلا رقم/أثر) — يجب ألا تدخل القائمة
  await saveInvoice(db, {
    docType: 'sale',
    payStatus: 'cash',
    status: 'draft',
    issuedAt: D4,
    customerId: seed.customerId,
    cashboxId: seed.cashboxId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.milkId, qty: '1', unitPrice: '100' }],
  });

  // مرتجع بيع نقدي لـINV1: 1 حليب @ 115 = 115 — تكلفة 90 (يخصم من COGS)
  const inv1 = await db.all<{ id: number }>(
    "SELECT id FROM invoice WHERE doc_type = 'sale' AND issued_at = ? ORDER BY id LIMIT 1",
    [D9],
  );
  await createLinkedReturn(db, {
    docType: 'sale_return',
    originalInvoiceId: Number(inv1[0]!.id),
    issuedAt: D6,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    returnPayDirection: 'cash',
    cashboxId: seed.cashboxId,
    lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
  });

  // شراء نقدي: 20 حليب @ 80 — أصل لا بند أرباح (والحركة بتكلفة 80)
  await saveInvoice(db, {
    docType: 'purchase',
    payStatus: 'cash',
    issuedAt: D5,
    supplierId: seed.supplierId,
    cashboxId: seed.cashboxId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.milkId, qty: '20', unitPrice: '80' }],
  });

  // تسوية بعملة مختلفة (قرار 8): تحصيل دين SAR بسعر يوم الدفع 560 → fx +3,000
  await upsertDailyRate(db, seed.sarId, D5, '560');
  await recordVoucher(db, {
    txType: 'receipt',
    cashboxId: seed.cashboxId,
    currencyId: seed.yerId,
    amount: '56000',
    exchangeRate: '1',
    txDate: D5,
    customerId: seed.customerId,
    allocations: [{ invoiceId: sarInv.invoiceId, amount: '100' }],
  });

  // تسويات جرد: زيادة +2 @ 90 = 180 وعجز −1 @ 90 = 90 (بعد 118 بالمخزون)
  await applyMovement(db, {
    productId: seed.milkId,
    warehouseId: seed.warehouseId,
    movementType: 'stocktake_adjust',
    qty: d('2'),
    unitCost: d('90'),
    refType: 'stocktake',
    refId: 1,
    movedAt: D4,
  });
  await applyMovement(db, {
    productId: seed.milkId,
    warehouseId: seed.warehouseId,
    movementType: 'stocktake_adjust',
    qty: d('-1'),
    unitCost: d('90'),
    refType: 'stocktake',
    refId: 1,
    movedAt: D4,
  });

  // فاتورة نقدية ثم إلغاؤها: 115 لا تدخل المبيعات ولا COGS (ولا سنداتها)
  const voidedInv = await saveInvoice(db, {
    docType: 'sale',
    payStatus: 'cash',
    issuedAt: D3,
    customerId: seed.customerId,
    cashboxId: seed.cashboxId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
  });
  await voidInvoice(db, voidedInv.invoiceId);

  // مصروف ملغى: 99 — الأصل is_voided=1 والمعاكسة reversal_of → كلاهما خارج
  const voidedExp = await recordExpense(db, {
    cashboxId: seed.cashboxId,
    currencyId: seed.yerId,
    amount: '99',
    exchangeRate: '1',
    txDate: D2,
    expenseCategoryId: catId,
  });
  await voidCashTx(db, voidedExp.cashTxId);

  // مصروف قبل بداية الفترة (D11) — خارجها
  await recordExpense(db, {
    cashboxId: seed.cashboxId,
    currencyId: seed.yerId,
    amount: '25',
    exchangeRate: '1',
    txDate: D11,
    expenseCategoryId: catId,
  });

  // مصروف عند حد from بالضبط (D10) — داخلها (شاملة الطرفين)
  await recordExpense(db, {
    cashboxId: seed.cashboxId,
    currencyId: seed.yerId,
    amount: '10',
    exchangeRate: '1',
    txDate: D10,
    expenseCategoryId: catId,
  });

  // مصروف عادي YER: 150
  await recordExpense(db, {
    cashboxId: seed.cashboxId,
    currencyId: seed.yerId,
    amount: '150',
    exchangeRate: '1',
    txDate: D4,
    expenseCategoryId: catId,
  });

  // مصروف بعملة أجنبية: 20 SAR بسعر 530 → 10,600 بالأساس
  await upsertDailyRate(db, seed.sarId, D1, '530');
  await recordExpense(db, {
    cashboxId: seed.cashboxId,
    currencyId: seed.sarId,
    amount: '20',
    exchangeRate: '530',
    txDate: D1,
    expenseCategoryId: catId,
  });

  // مسحوبات مالك 200 + إيداع رأس مال 5,000 (لا يدخل الأرباح أبداً)
  await recordOwnerTx(db, {
    txKind: 'owner_draw',
    cashboxId: seed.cashboxId,
    currencyId: seed.yerId,
    amount: '200',
    exchangeRate: '1',
    txDate: D2,
  });
  await recordOwnerTx(db, {
    txKind: 'capital_in',
    cashboxId: seed.cashboxId,
    currencyId: seed.yerId,
    amount: '5000',
    exchangeRate: '1',
    txDate: D1,
  });

  // تحويل بين صندوقين بعملتين: 1,000 YER → 1.8 SAR (×530 = 954) → fx −46
  const sarBox = await db.all<{ id: number }>(
    "SELECT id FROM cashbox WHERE currency_id = ? AND is_default = 0",
    [seed.sarId],
  );
  await recordBoxTransfer(db, {
    fromCashboxId: seed.cashboxId,
    toCashboxId: Number(sarBox[0]!.id),
    amount: '1000',
    exchangeRate: '1',
    toAmount: '1.8',
    txDate: D1,
  });

  return { db, seed };
}

describe('getProfitAndLoss — الصيغة المصححة عبر الخريطة (FR-09-02)', () => {
  test('السيناريو الكامل: كل بند + الربح + صافي ما بقي للمالك بأرقام يدوية', async () => {
    const { db } = await fullScenario();
    const pnl = await getProfitAndLoss(db, { from: D10, to: TODAY });

    // الإيرادات
    expect(pnl.sales).toBe('53830.0000'); // 230 + 600 + 53,000 (تحويل بسعر 530)
    expect(pnl.salesReturns).toBe('115.0000');
    expect(pnl.netSales).toBe('53715.0000');
    // التكلفة
    expect(pnl.cogs).toBe('270.0000'); // 180 (2×90) + 90 (1×90) — الخصم لا يمس التكلفة
    expect(pnl.returnsCost).toBe('90.0000');
    expect(pnl.netCogs).toBe('180.0000');
    // الجرد
    expect(pnl.stockSurplus).toBe('180.0000');
    expect(pnl.stockShortage).toBe('90.0000');
    // المصاريف (شاملة الأجنبية بسعر صفها + حد from — والملغى/الخارجي مستبعدان)
    expect(pnl.expenses).toBe('10760.0000'); // 150 + 10,600 + 10
    // فروق الصرف: +3,000 (تسوية) − 46 (تحويل) = 2,954
    expect(pnl.fxGainLoss).toBe('2954.0000');
    // الصيغة المصححة (قرار 7)
    expect(pnl.profit).toBe('45819.0000');
    // المسحوبات بند مستقل خارج المصاريف
    expect(pnl.ownerDraw).toBe('200.0000');
    // صافي ما بقي للمالك = الربح − المسحوبات
    expect(pnl.netRemainingToOwner).toBe('45619.0000');
    expect(pnl.period).toEqual({ from: D10, to: TODAY });
  });

  test('إيداع المالك لا يظهر في أي بند: رصيد الصندوق زاد 5,000 والقائمة لم تتغير', async () => {
    const { db, seed } = await fullScenario();
    const before = await getProfitAndLoss(db, { from: D10, to: TODAY });
    await recordOwnerTx(db, {
      txKind: 'capital_in',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '777',
      exchangeRate: '1',
      txDate: TODAY,
    });
    const after = await getProfitAndLoss(db, { from: D10, to: TODAY });
    // لا بند تغيّر — لا المبيعات ولا المصاريف ولا الربح ولا صافي ما بقي للمالك
    for (const key of [
      'sales',
      'salesReturns',
      'netSales',
      'cogs',
      'returnsCost',
      'netCogs',
      'stockSurplus',
      'stockShortage',
      'expenses',
      'fxGainLoss',
      'profit',
      'ownerDraw',
      'netRemainingToOwner',
    ] as const) {
      expect(after[key]).toBe(before[key]);
    }
  });

  test('فترة أضيق تستبعد ما قبلها: [D9, TODAY] تسقط مصروف حد from والافتتاحي', async () => {
    const { db } = await fullScenario();
    const pnl = await getProfitAndLoss(db, { from: D9, to: TODAY });
    expect(pnl.expenses).toBe('10750.0000'); // 150 + 10,600 (مصروف D10 خارج)
    expect(pnl.sales).toBe('53830.0000'); // كل الفواتير داخل D9..اليوم
    expect(pnl.profit).toBe('45829.0000'); // 45,819 + 10 (المصروف المستبعد)
  });

  test('حدود الفترة شاملة الطرفين: from وto محسوبان وما قبلهما/بعدهما مستبعد', async () => {
    const { db, seed } = await seededDb();
    const catId = await addExpenseCategory(db);
    // مصاريف: D3 خارج / D2=from داخل / D1=to داخل
    for (const [day, amount] of [
      [D3, '25'],
      [D2, '20'],
      [D1, '30'],
    ] as const) {
      await recordExpense(db, {
        cashboxId: seed.cashboxId,
        currencyId: seed.yerId,
        amount,
        exchangeRate: '1',
        txDate: day,
        expenseCategoryId: catId,
      });
    }
    // فواتير بيع خدمية (بلا COGS): D2=from داخل / D1=to داخل / TODAY خارج
    for (const [day, price] of [
      [D2, '115'],
      [D1, '230'],
      [TODAY, '345'],
    ] as const) {
      await saveInvoice(db, {
        docType: 'sale',
        payStatus: 'cash',
        issuedAt: day,
        customerId: seed.customerId,
        cashboxId: seed.cashboxId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [{ productId: seed.deliveryId, qty: '1', unitPrice: price }],
      });
    }
    const pnl = await getProfitAndLoss(db, { from: D2, to: D1 });
    expect(pnl.sales).toBe('345.0000'); // 115 + 230
    expect(pnl.expenses).toBe('50.0000'); // 20 + 30
    expect(pnl.profit).toBe('295.0000');
    expect(pnl.ownerDraw).toBe('0.0000');
    expect(pnl.netRemainingToOwner).toBe('295.0000');
  });

  test('رفض التواريخ غير الصالحة والفترة المقلوبة (ValidationError عربية)', async () => {
    const { db } = await seededDb();
    await expect(getProfitAndLoss(db, { from: '2026-13-01', to: TODAY })).rejects.toThrow(
      ValidationError,
    );
    await expect(getProfitAndLoss(db, { from: TODAY, to: D1 })).rejects.toThrow(ValidationError);
  });

  test('قاعدة فارغة: كل البنود صفر والصيغة سليمة', async () => {
    const { db } = await seededDb();
    const pnl = await getProfitAndLoss(db, { from: D10, to: TODAY });
    expect(pnl.sales).toBe('0.0000');
    expect(pnl.profit).toBe('0.0000');
    expect(pnl.netRemainingToOwner).toBe('0.0000');
  });
});

describe('resolveReportPeriod — الفترات الجاهزة (FR-09-09)', () => {
  test('اليوم: from = to = اليوم', () => {
    expect(resolveReportPeriod('today', { today: '2026-10-08' })).toEqual({
      preset: 'today',
      from: '2026-10-08',
      to: '2026-10-08',
    });
  });

  test('الأسبوع يبدأ السبت (نظام يمني): الخميس 2026-10-08 → من السبت 2026-10-03', () => {
    expect(resolveReportPeriod('week', { today: '2026-10-08' })).toEqual({
      preset: 'week',
      from: '2026-10-03',
      to: '2026-10-08',
    });
  });

  test('الأسبوع يوم السبت نفسه: from = اليوم', () => {
    expect(resolveReportPeriod('week', { today: '2026-10-10' })).toEqual({
      preset: 'week',
      from: '2026-10-10',
      to: '2026-10-10',
    });
  });

  test('الأسبوع يوم الأحد: من سـبت الأمس', () => {
    expect(resolveReportPeriod('week', { today: '2026-02-15' })).toEqual({
      preset: 'week',
      from: '2026-02-14',
      to: '2026-02-15',
    });
  });

  test('الشهر: أول يوم من شهر اليوم', () => {
    expect(resolveReportPeriod('month', { today: '2026-02-15' })).toEqual({
      preset: 'month',
      from: '2026-02-01',
      to: '2026-02-15',
    });
  });

  test('الربع: بداية ربع السنة (يناير/أبريل/يوليو/أكتوبر)', () => {
    expect(resolveReportPeriod('quarter', { today: '2026-02-15' }).from).toBe('2026-01-01');
    expect(resolveReportPeriod('quarter', { today: '2026-05-20' }).from).toBe('2026-04-01');
    expect(resolveReportPeriod('quarter', { today: '2026-11-30' }).from).toBe('2026-10-01');
  });

  test('السنة: أول يناير', () => {
    expect(resolveReportPeriod('year', { today: '2026-11-30' })).toEqual({
      preset: 'year',
      from: '2026-01-01',
      to: '2026-11-30',
    });
  });

  test('مخصص: from/to كما مرّا — والرفض عند الفراغ/القلب/الصيغة', () => {
    expect(
      resolveReportPeriod('custom', { today: '2026-10-08', from: '2026-09-01', to: '2026-10-08' }),
    ).toEqual({ preset: 'custom', from: '2026-09-01', to: '2026-10-08' });
    expect(() => resolveReportPeriod('custom', { today: '2026-10-08' })).toThrow(ValidationError);
    expect(() =>
      resolveReportPeriod('custom', { today: '2026-10-08', from: '2026-10-08', to: '2026-10-01' }),
    ).toThrow(ValidationError);
    expect(() =>
      resolveReportPeriod('custom', { today: '2026-10-08', from: '2026-9-1', to: '2026-10-08' }),
    ).toThrow(ValidationError);
  });
});

describe('getChequesReport — الشيكات (FR-09-13)', () => {
  async function insertCheque(
    db: SqliteAdapter,
    seed: Seed,
    fields: {
      direction: 'in' | 'out';
      status: string;
      dueDate: string;
      amount: string;
      currencyId?: number;
      chequeNo?: string;
      partyType?: 'customer' | 'supplier';
      partyId?: number;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO cheque (direction, party_type, party_id, cheque_no, bank_name, amount,
                           currency_id, exchange_rate, issue_date, due_date, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '1', ?, ?, ?, ?, ?)`,
      [
        fields.direction,
        fields.partyType ?? 'customer',
        fields.partyId ?? seed.customerId,
        fields.chequeNo ?? `CH-${Math.floor(Math.random() * 100000)}`,
        'بنك التضامن',
        fields.amount,
        fields.currencyId ?? seed.yerId,
        D10,
        fields.dueDate,
        fields.status,
        now,
        now,
      ],
    );
  }

  test('تحت التحصيل/تحت السحب: pending+deposited فقط، مرتبة بالاستحقاق، بعملاتها وأطرافها', async () => {
    const { db, seed } = await seededDb();
    await insertCheque(db, seed, { direction: 'in', status: 'pending', dueDate: D5, amount: '5000' });
    await insertCheque(db, seed, {
      direction: 'in',
      status: 'deposited',
      dueDate: D3,
      amount: '120',
      currencyId: seed.sarId,
      partyId: seed.customerId,
    });
    await insertCheque(db, seed, { direction: 'in', status: 'cleared', dueDate: D1, amount: '999' });
    await insertCheque(db, seed, { direction: 'in', status: 'bounced', dueDate: D1, amount: '777' });
    await insertCheque(db, seed, { direction: 'out', status: 'pending', dueDate: D7, amount: '2300' });
    await insertCheque(db, seed, {
      direction: 'out',
      status: 'void',
      dueDate: D7,
      amount: '11',
      partyType: 'supplier',
      partyId: seed.supplierId,
    });

    const rep = await getChequesReport(db);
    // تحت التحصيل: الاثنان القائمان (pending + deposited) بترتيب الاستحقاق الأقرب
    expect(rep.underCollection).toHaveLength(2);
    // D5 أقدم من D3 → الصادر أولاً في الترتيب التصاعدي
    expect(rep.underCollection[0]!.dueDate).toBe(D5);
    expect(rep.underCollection[0]!.amount).toBe('5000');
    expect(rep.underCollection[0]!.status).toBe('pending');
    expect(rep.underCollection[1]!.dueDate).toBe(D3);
    expect(rep.underCollection[1]!.status).toBe('deposited');
    expect(rep.underCollection[1]!.currencyCode).toBe('SAR');
    expect(rep.underCollection[1]!.amount).toBe('120');
    // تحت السحب: الصادر القائم فقط
    expect(rep.underWithdrawal).toHaveLength(1);
    expect(rep.underWithdrawal[0]!.amount).toBe('2300');
    expect(rep.underWithdrawal[0]!.partyType).toBe('customer');
    // اسم الطرف من ملفه
    expect(rep.underCollection[0]!.partyName).toBe('أحمد');
  });

  test('قاعدة بلا شيكات: قائمتان فارغتان (فراغ صادق)', async () => {
    const { db } = await seededDb();
    const rep = await getChequesReport(db);
    expect(rep.underCollection).toEqual([]);
    expect(rep.underWithdrawal).toEqual([]);
  });
});

describe('getCustomerCreditBalances — الأرصدة الدائنة (FR-09-14)', () => {
  test('عميل دفع نقدياً ثم أعاد (مرتجع آجل) → رصيد لصالحه؛ المدين والصفر لا يظهران', async () => {
    const { db, seed } = await seededDb();
    const now = new Date().toISOString();
    // عميلان إضافيان: واحد صفر وواحد مدين
    await db.run(
      `INSERT INTO customer (name, phone, created_at, updated_at) VALUES ('صفر الرصيد', '700000000', ?, ?)`,
      [now, now],
    );
    await db.run(
      `INSERT INTO customer (name, phone, created_at, updated_at) VALUES ('عميل مدين', '711111111', ?, ?)`,
      [now, now],
    );
    const debtor = await db.all<{ id: number }>(
      "SELECT id FROM customer WHERE name = 'عميل مدين'",
    );
    const zeros = await db.all<{ id: number }>(
      "SELECT id FROM customer WHERE name = 'صفر الرصيد'",
    );

    // المدين: فاتورة آجلة 345
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: D5,
      customerId: Number(debtor[0]!.id),
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.deliveryId, qty: '1', unitPrice: '345' }],
    });

    // الدائن (أحمد): بيع نقدي 230 ثم مرتجع آجل 115 → رصيد −115 لصالحه
    const cashInv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'cash',
      issuedAt: D4,
      customerId: seed.customerId,
      cashboxId: seed.cashboxId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.deliveryId, qty: '2', unitPrice: '115' }],
    });
    await createLinkedReturn(db, {
      docType: 'sale_return',
      originalInvoiceId: cashInv.invoiceId,
      issuedAt: D2,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      returnPayDirection: 'account',
      lines: [{ productId: seed.deliveryId, qty: '1', unitPrice: '115' }],
    });

    const rows = await getCustomerCreditBalances(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customerId).toBe(seed.customerId);
    expect(rows[0]!.name).toBe('أحمد');
    expect(rows[0]!.balance).toBe('-115.0000');
    expect(rows[0]!.currencyCode).toBe('YER');
    // الصفري والمدين خارجان
    expect(rows.find((r) => r.customerId === Number(zeros[0]!.id))).toBeUndefined();
    expect(rows.find((r) => r.customerId === Number(debtor[0]!.id))).toBeUndefined();
  });

  test('رصيد دائن بعملة أجنبية يظهر بعملته مفصولاً (قرار 8)', async () => {
    const { db, seed } = await seededDb();
    await upsertDailyRate(db, seed.sarId, D5, '530');
    // فاتورة SAR آجلة 100 ثم تحصيل كامل بسعر يوم الدفع → الرصيد بالسعودي يصفّر
    // والقبض الحر الزائد (على الحساب) يجعل الرصيد دائناً بالعملة ذاتها:
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: D5,
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.sarId,
      lines: [{ productId: seed.deliveryId, qty: '1', unitPrice: '100' }],
    });
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.sarId,
      amount: '130',
      exchangeRate: '530',
      txDate: D2,
      customerId: seed.customerId,
      allocations: [{ invoiceId: inv.invoiceId, amount: '100' }],
    });
    const rows = await getCustomerCreditBalances(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.currencyCode).toBe('SAR');
    expect(rows[0]!.balance).toBe('-30.0000'); // 30 سعودياً لصالح العميل
  });

  test('قاعدة بلا عملاء دائنين: قائمة فارغة', async () => {
    const { db } = await seededDb();
    expect(await getCustomerCreditBalances(db)).toEqual([]);
  });
});
