/**
 * cheques.test.ts — دورة حياة الشيكات (SRS FR-14-01..06 + خريطة الترحيل ملحق و).
 *
 * الجوهر المختبر (FR-14-02): الشيك في pending **لا يمس الصندوق ولا كشف
 * الطرف** — لا cash_tx ولا payment_allocation — ثم عند cleared فقط:
 * حركة الصندوق (recordVoucherTx) + التخصيص FIFO/الصريح + فروق الصرف
 * (مرآة AC-18) + إنقاص كشف الطرف. وعند bounced: الدين يرتد طبيعياً
 * بلا أي كتابة عكسية + الرسم مصروف اختياري.
 */
import { describe, expect, test } from 'bun:test';
import type { SqliteAdapter } from '../../db/adapter';
import { d } from '../../utils/money';
import { recordOpeningStock } from '../inventory';
import { saveInvoice } from '../invoicing';
import { recordVoucher } from '../cash';
import { upsertDailyRate } from '../currency';
import { getPartyBalanceByCurrency } from '../statement';
import { DomainRuleError, MissingRateError, ValidationError } from '../errors';
import {
  bounceCheque,
  clearCheque,
  depositCheque,
  getDueSoonCheques,
  isDueSoon,
  isOverdue,
  recordCheque,
  voidCheque,
} from '../cheques';
import { daysAgoISO, seededDb } from './seed';
import type { Seed } from './seed';

const TODAY = daysAgoISO(0);

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
  return saveInvoice(db, {
    docType: 'sale',
    payStatus: 'credit',
    issuedAt,
    customerId: seed.customerId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines: [{ productId: seed.milkId, qty, unitPrice: price }],
    ...overrides,
  });
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

/** شيك وارد من العميل بالأساس (YER) — الإصدار اليوم والاستحقاق +30 يوماً */
function inChequeInput(
  seed: Seed,
  amount: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    direction: 'in' as const,
    partyId: seed.customerId,
    chequeNo: 'CHQ-1001',
    bankName: 'بنك التضامن',
    amount,
    currencyId: seed.yerId,
    exchangeRate: '1',
    issueDate: TODAY,
    dueDate: daysAgoISO(-30),
    ...overrides,
  };
}

function outChequeInput(
  seed: Seed,
  amount: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    direction: 'out' as const,
    partyId: seed.supplierId,
    chequeNo: 'CHQ-2001',
    bankName: 'بنك الكريمي',
    amount,
    currencyId: seed.yerId,
    exchangeRate: '1',
    issueDate: TODAY,
    dueDate: daysAgoISO(-30),
    ...overrides,
  };
}

async function chequeRow(db: SqliteAdapter, id: number) {
  const rows = await db.all<Record<string, string | number | null>>(
    'SELECT * FROM cheque WHERE id = ?',
    [id],
  );
  return rows[0];
}

async function auditActions(db: SqliteAdapter, entity: string, entityId: number) {
  const rows = await db.all<{ action: string }>(
    'SELECT action FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id',
    [entity, entityId],
  );
  return rows.map((r) => r.action);
}

/** عدد حركات الصندوق الحية (غير الملغاة/المعاكسة) */
async function liveCashTxCount(db: SqliteAdapter): Promise<number> {
  const rows = await db.all<{ c: number }>(
    'SELECT COUNT(*) AS c FROM cash_tx WHERE is_voided = 0 AND reversal_of IS NULL',
  );
  return Number(rows[0]?.c ?? 0);
}

/** عدد التخصيصات كلها (يجب أن يبقى 0 أثناء pending — FR-14-02) */
async function allocationCount(db: SqliteAdapter): Promise<number> {
  const rows = await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM payment_allocation');
  return Number(rows[0]?.c ?? 0);
}

/** رصيد الصندوق بعملته (وارد − صادر على الحية) — مرآة getCashboxBalances */
async function boxBalance(db: SqliteAdapter, cashboxId: number): Promise<string> {
  const rows = await db.all<{ tx_type: string; amount: string }>(
    'SELECT tx_type, amount FROM cash_tx WHERE cashbox_id = ? AND is_voided = 0 AND reversal_of IS NULL',
    [cashboxId],
  );
  let net = d(0);
  for (const r of rows) {
    const amt = d(r.amount);
    if (
      r.tx_type === 'receipt' ||
      r.tx_type === 'capital_in' ||
      r.tx_type === 'opening' ||
      r.tx_type === 'bank_deposit'
    ) {
      net = net.plus(amt);
    } else if (
      r.tx_type === 'payment' ||
      r.tx_type === 'expense' ||
      r.tx_type === 'owner_draw' ||
      r.tx_type === 'bank_withdraw'
    ) {
      net = net.minus(amt);
    }
  }
  return net.toFixed(4);
}

/** رصيد الطرف بعملة (أول سطر للعملة المطلوبة) — FR-03-02 */
async function partyBalance(
  db: SqliteAdapter,
  partyType: 'customer' | 'supplier',
  partyId: number,
  currencyId: number,
): Promise<string> {
  const rows = await getPartyBalanceByCurrency(db, partyType, partyId);
  const hit = rows.find((r) => r.currencyId === currencyId);
  return hit ? hit.balance : '0.0000';
}

async function insertExpenseCategory(db: SqliteAdapter, name: string): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db.all<{ id: number }>(
    `INSERT INTO expense_category (name, is_archived, created_at, updated_at)
     VALUES (?, 0, ?, ?) RETURNING id`,
    [name, now, now],
  );
  return Number(rows[0]!.id);
}

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown = null;
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    caught = err;
  }
  expect(threw).toBe(true); // توقع رمي الخطأ ولم يُرمَ
  expect(caught).toBeInstanceOf(DomainRuleError);
  expect((caught as DomainRuleError).code).toBe(code);
}

/** ثلاث فواتير آجلة مفتوحة: A=230 (أقدم) B=115 C=345 — المجموع 690 */
async function threeOpenInvoices(db: SqliteAdapter, seed: Seed) {
  const a = await creditSale(db, seed, '2', '115', daysAgoISO(5));
  const b = await creditSale(db, seed, '1', '115', daysAgoISO(3));
  const c = await creditSale(db, seed, '3', '115', daysAgoISO(1));
  return { a, b, c };
}

/* ==================== التسجيل (FR-14-01) ==================== */

describe('recordCheque — تسجيل الشيك (FR-14-01)', () => {
  test('وارد من عميل: صف pending كامل + قيد audit + سعر مخزَّن 6 منازل', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(db, inChequeInput(seed, '500', { notes: 'شيك ضمان' }));
    const row = await chequeRow(db, res.chequeId);
    expect(row!.status).toBe('pending');
    expect(row!.direction).toBe('in');
    expect(row!.party_type).toBe('customer');
    expect(row!.party_id).toBe(seed.customerId);
    expect(row!.cheque_no).toBe('CHQ-1001');
    expect(row!.bank_name).toBe('بنك التضامن');
    expect(row!.amount).toBe('500.0000');
    expect(row!.exchange_rate).toBe('1.000000');
    expect(row!.issue_date).toBe(TODAY);
    expect(row!.ref_invoice_id).toBeNull();
    expect(row!.cleared_cash_tx_id).toBeNull();
    expect(row!.notes).toBe('شيك ضمان');
    expect(await auditActions(db, 'cheque', res.chequeId)).toEqual(['cheque_create']);
  });

  test('صادر لمورّد: party_type=supplier + مرجع فاتورة شراء مفتوحة', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const pur = await creditPurchase(db, seed, '2', '115', daysAgoISO(2));
    const res = await recordCheque(
      db,
      outChequeInput(seed, '230', { refInvoiceId: pur.invoiceId }),
    );
    const row = await chequeRow(db, res.chequeId);
    expect(row!.party_type).toBe('supplier');
    expect(row!.ref_invoice_id).toBe(pur.invoiceId);
    expect(await auditActions(db, 'cheque', res.chequeId)).toEqual(['cheque_create']);
  });

  test('تعارض الاتجاه ونوع الطرف مرفوض (in مع supplier)', async () => {
    const { db, seed } = await seededDb();
    await expectDomainError(
      recordCheque(db, inChequeInput(seed, '100', { partyType: 'supplier' })),
      'CHEQUE_PARTY_DIRECTION_MISMATCH',
    );
    await expectDomainError(
      recordCheque(db, outChequeInput(seed, '100', { partyType: 'customer' })),
      'CHEQUE_PARTY_DIRECTION_MISMATCH',
    );
    // ولا تظهر أنصاف سجلات
    const rows = await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM cheque');
    expect(Number(rows[0]!.c)).toBe(0);
  });

  test('مبلغ غير موجب مرفوض (زود) + الاستحقاق قبل الإصدار مرفوض', async () => {
    const { db, seed } = await seededDb();
    await expect(recordCheque(db, inChequeInput(seed, '0'))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(recordCheque(db, inChequeInput(seed, '-5'))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expectDomainError(
      recordCheque(db, inChequeInput(seed, '100', { dueDate: daysAgoISO(3) })),
      'CHEQUE_DUE_BEFORE_ISSUE',
    );
  });

  test('عملة أجنبية بلا سعر يوم الإصدار → MissingRateError (قرار 3)', async () => {
    const { db, seed } = await seededDb();
    await expect(
      recordCheque(
        db,
        inChequeInput(seed, '100', { currencyId: seed.sarId, exchangeRate: undefined }),
      ),
    ).rejects.toBeInstanceOf(MissingRateError);
  });

  test('عملة أجنبية بسعر Snapshot صريح → يُخزَّن كما هو', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(
      db,
      inChequeInput(seed, '100', { currencyId: seed.sarId, exchangeRate: '530' }),
    );
    const row = await chequeRow(db, res.chequeId);
    expect(row!.exchange_rate).toBe('530.000000');
  });

  test('الأساس بسعر غير 1 مرفوض (نفس قاعدة السندات)', async () => {
    const { db, seed } = await seededDb();
    await expectDomainError(
      recordCheque(db, inChequeInput(seed, '100', { exchangeRate: '530' })),
      'BASE_CURRENCY_RATE_IS_ONE',
    );
  });

  test('الفاتورة المرجعية: عائلة خاطئة / طرف آخر / ملغاة / مسددة → مرفوضة', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const pur = await creditPurchase(db, seed, '1', '115', daysAgoISO(2)); // شراء (عائلة خاطئة للوارد)
    await expectDomainError(
      recordCheque(db, inChequeInput(seed, '100', { refInvoiceId: pur.invoiceId })),
      'CHEQUE_REF_FAMILY_MISMATCH',
    );

    // طرف آخر: فاتورة لعميل ثانٍ
    const other = await db.all<{ id: number }>(
      `INSERT INTO customer (name, created_at, updated_at) VALUES ('سالم', ?, ?) RETURNING id`,
      [new Date().toISOString(), new Date().toISOString()],
    );
    const otherInv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(2),
      customerId: Number(other[0]!.id),
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    });
    await expectDomainError(
      recordCheque(db, inChequeInput(seed, '100', { refInvoiceId: otherInv.invoiceId })),
      'CHEQUE_REF_PARTY_MISMATCH',
    );

    // ملغاة
    const { voidInvoice } = await import('../invoicing');
    const live = await creditSale(db, seed, '1', '115', daysAgoISO(2));
    await voidInvoice(db, live.invoiceId);
    await expectDomainError(
      recordCheque(db, inChequeInput(seed, '100', { refInvoiceId: live.invoiceId })),
      'CHEQUE_REF_NOT_LIVE',
    );

    // مسددة بالكامل (سند قبض يغلقها)
    const paid = await creditSale(db, seed, '1', '115', daysAgoISO(2));
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '115',
      exchangeRate: '1',
      txDate: TODAY,
      customerId: seed.customerId,
      allocations: [{ invoiceId: paid.invoiceId, amount: '115' }],
    });
    await expectDomainError(
      recordCheque(db, inChequeInput(seed, '100', { refInvoiceId: paid.invoiceId })),
      'CHEQUE_REF_FULLY_PAID',
    );
  });

  test('FR-14-02 (الجوهر): pending لا يمس الصندوق ولا كشف الطرف إطلاقاً', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await threeOpenInvoices(db, seed); // دين العميل 690

    const cashBefore = await liveCashTxCount(db);
    const allocBefore = await allocationCount(db);
    const boxBefore = await boxBalance(db, seed.cashboxId);
    const balanceBefore = await partyBalance(db, 'customer', seed.customerId, seed.yerId);
    expect(balanceBefore).toBe('690.0000');

    await recordCheque(db, inChequeInput(seed, '400'));

    expect(await liveCashTxCount(db)).toBe(cashBefore); // لا حركة صندوق
    expect(await allocationCount(db)).toBe(allocBefore); // لا تخصيص
    expect(await boxBalance(db, seed.cashboxId)).toBe(boxBefore); // الرصيد كما هو
    // الدين ما يزال ظاهراً كاملاً في الكشف (AR→CHQ إعادة تبويب فقط)
    expect(await partyBalance(db, 'customer', seed.customerId, seed.yerId)).toBe('690.0000');
  });
});

/* ==================== الإيداع (FR-14-02) ==================== */

describe('depositCheque — الإيداع بالبنك', () => {
  test('pending → deposited + audit، وبلا أي أثر مالي', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(db, inChequeInput(seed, '100'));
    const cashBefore = await liveCashTxCount(db);
    await depositCheque(db, res.chequeId);
    const row = await chequeRow(db, res.chequeId);
    expect(row!.status).toBe('deposited');
    expect(await liveCashTxCount(db)).toBe(cashBefore);
    expect(await auditActions(db, 'cheque', res.chequeId)).toEqual([
      'cheque_create',
      'cheque_deposit',
    ]);
  });

  test('من deposited مرفوض (الإيداع من pending فقط)', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(db, inChequeInput(seed, '100'));
    await depositCheque(db, res.chequeId);
    await expectDomainError(depositCheque(db, res.chequeId), 'CHEQUE_DEPOSIT_STATE');
  });
});

/* ==================== التحصيل/الصرف (FR-14-03) ==================== */

describe('clearCheque — التحصيل والصرف (FR-14-03)', () => {
  test('وارد → سند قبض بعملة الشيك: الصندوق يزيد وكشف الطرف ينقص', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const { a, b, c } = await threeOpenInvoices(db, seed);
    const res = await recordCheque(db, inChequeInput(seed, '400'));
    await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });

    const row = await chequeRow(db, res.chequeId);
    expect(row!.status).toBe('cleared');
    expect(Number(row!.cleared_cash_tx_id)).toBeGreaterThan(0);

    // الصندوق +400 (عملة الشيك = الأساس)
    expect(await boxBalance(db, seed.cashboxId)).toBe('400.0000');
    // سند القبض برقم RVT- ووصف الشيك
    const tx = await db.all<Record<string, string | number | null>>(
      'SELECT * FROM cash_tx WHERE id = ?',
      [row!.cleared_cash_tx_id],
    );
    expect(tx[0]!.tx_type).toBe('receipt');
    expect(tx[0]!.voucher_no).toMatch(/^RVT-\d{4}-\d{5}$/);
    expect(String(tx[0]!.description)).toContain('CHQ-1001');
    // FIFO الأقدم أولاً: A=230 ثم B=115 ثم C=55
    const allocs = await db.all<{ invoice_id: number; allocated_amount: string }>(
      'SELECT invoice_id, allocated_amount FROM payment_allocation WHERE cash_tx_id = ? ORDER BY invoice_id',
      [row!.cleared_cash_tx_id],
    );
    expect(allocs).toEqual([
      { invoice_id: a.invoiceId, allocated_amount: '230.0000' },
      { invoice_id: b.invoiceId, allocated_amount: '115.0000' },
      { invoice_id: c.invoiceId, allocated_amount: '55.0000' },
    ]);
    // FR-14-02 اكتمل: الكشف نقص من 690 إلى 290
    expect(await partyBalance(db, 'customer', seed.customerId, seed.yerId)).toBe('290.0000');
    expect(await auditActions(db, 'cheque', res.chequeId)).toContain('cheque_clear');
  });

  test('الفائض عن الفواتير المفتوحة يبقى «على الحساب» (700 → 690 + 10)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await threeOpenInvoices(db, seed);
    const res = await recordCheque(db, inChequeInput(seed, '700'));
    const cleared = await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });
    expect(cleared.onAccountAmount).toBe('10.0000');
    expect(await boxBalance(db, seed.cashboxId)).toBe('700.0000');
    // الكشف: 690 − 690 = 0 (الباقي دائن يظهر سالباً في عملة السند)
    expect(await partyBalance(db, 'customer', seed.customerId, seed.yerId)).toBe('-10.0000');
  });

  test('الفاتورة المرجعية تُخصص أولاً صريحاً قبل FIFO (مرجع C=345 ثم A=55)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const { a, c } = await threeOpenInvoices(db, seed);
    const res = await recordCheque(
      db,
      inChequeInput(seed, '400', { refInvoiceId: c.invoiceId }),
    );
    const cleared = await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });
    // المرجعية أولاً بمتبقيها كاملاً ثم الأقدم (A) لما تبقى
    expect(cleared.allocations).toEqual([
      { invoiceId: c.invoiceId, invoiceNo: c.invoiceNo, allocatedAmount: '345.0000' },
      { invoiceId: a.invoiceId, invoiceNo: a.invoiceNo, allocatedAmount: '55.0000' },
    ]);
  });

  test('مرآة AC-18: دين SAR 1000@530 يُحصَّل بشيك YER@560 → فرق صرف +30000 والكشف بالسعودي صفر', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await upsertDailyRate(db, seed.sarId, daysAgoISO(5), '530');
    await upsertDailyRate(db, seed.sarId, TODAY, '560');
    const inv = await creditSale(db, seed, '1', '1000', daysAgoISO(5), {
      currencyId: seed.sarId,
    });
    // شيك وارد بالأساس يغطي الدين السعودي (560000 يمني)
    const res = await recordCheque(
      db,
      inChequeInput(seed, '560000', { refInvoiceId: inv.invoiceId }),
    );
    const cleared = await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });
    // التخصيص الصريح للفاتورة السعودية بالكامل
    expect(cleared.allocations).toEqual([
      { invoiceId: inv.invoiceId, invoiceNo: inv.invoiceNo, allocatedAmount: '1000.0000' },
    ]);
    expect(cleared.settlementRate).toBe('560.000000');
    // 1000 × (560 − 530) = +30000 ربح صرف محقق
    expect(cleared.fxGainLoss).toBe('30000.0000');
    expect(cleared.onAccountAmount).toBe('0.0000');
    // الكشف بالريال السعودي يتوازن صفراً تماماً (قرار 8)
    expect(await partyBalance(db, 'customer', seed.customerId, seed.sarId)).toBe('0.0000');
    // الصندوق استلم 560000 يمني
    expect(await boxBalance(db, seed.cashboxId)).toBe('560000.0000');
  });

  test('صادر لمورد → سند صرف PMT- يخفض التزامه', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await creditPurchase(db, seed, '2', '115', daysAgoISO(4)); // 230 على المورد
    expect(await partyBalance(db, 'supplier', seed.supplierId, seed.yerId)).toBe('230.0000');
    const res = await recordCheque(db, outChequeInput(seed, '230'));
    await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });
    const row = await chequeRow(db, res.chequeId);
    expect(row!.status).toBe('cleared');
    expect(await boxBalance(db, seed.cashboxId)).toBe('-230.0000');
    const tx = await db.all<Record<string, string | number | null>>(
      'SELECT tx_type, voucher_no, supplier_id FROM cash_tx WHERE id = ?',
      [row!.cleared_cash_tx_id],
    );
    expect(tx[0]!.tx_type).toBe('payment');
    expect(String(tx[0]!.voucher_no)).toMatch(/^PMT-\d{4}-\d{5}$/);
    expect(Number(tx[0]!.supplier_id)).toBe(seed.supplierId);
    expect(await partyBalance(db, 'supplier', seed.supplierId, seed.yerId)).toBe('0.0000');
  });

  test('من deposited يجوز التحصيل (pending|deposited → cleared)', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(db, inChequeInput(seed, '100'));
    await depositCheque(db, res.chequeId);
    const cleared = await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });
    expect(cleared.voucherNo).toMatch(/^RVT-/);
    const row = await chequeRow(db, res.chequeId);
    expect(row!.status).toBe('cleared');
  });

  test('من cleared مرفوض برسالة توجه لإلغاء حركة الصندوق', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(db, inChequeInput(seed, '100'));
    await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });
    await expectDomainError(
      clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId }),
      'CHEQUE_CLEAR_STATE',
    );
  });

  test('غياب سعر يوم التحصيل → MissingRateError (قرار 8 الصارم)', async () => {
    const { db, seed } = await seededDb();
    // شيك بالسعودي بسعر إصدار صريح، لكن لا سعر لليوم
    const res = await recordCheque(
      db,
      inChequeInput(seed, '100', { currencyId: seed.sarId, exchangeRate: '530' }),
    );
    await expect(
      clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId }),
    ).rejects.toBeInstanceOf(MissingRateError);
    // وبعد إدخال سعر اليوم ينجو التحصيل (التراجع لا يترك أثراً)
    await upsertDailyRate(db, seed.sarId, TODAY, '540');
    const cleared = await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });
    expect(cleared.voucherNo).toMatch(/^RVT-/);
  });
});

/* ==================== الارتداد (FR-14-04) ==================== */

describe('bounceCheque — الارتداد (FR-14-04)', () => {
  test('بلا رسم: الحالة bounced + bounced_at + الكشف لم يتغير (الدين ارتد طبيعياً)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await creditSale(db, seed, '2', '115', daysAgoISO(4)); // 230
    const res = await recordCheque(db, inChequeInput(seed, '230'));
    expect(await partyBalance(db, 'customer', seed.customerId, seed.yerId)).toBe('230.0000');
    const cashBefore = await liveCashTxCount(db);

    const out = await bounceCheque(db, res.chequeId, {});
    expect(out.expenseCashTxId).toBeNull();
    expect(out.bounceFee).toBe('0.0000');

    const row = await chequeRow(db, res.chequeId);
    expect(row!.status).toBe('bounced');
    expect(row!.bounced_at).toBe(TODAY);
    expect(row!.bounce_fee).toBe('0.0000');
    // لا مصروف ولا أي حركة
    expect(await liveCashTxCount(db)).toBe(cashBefore);
    // FR-14-04: الدين عاد للعميل بلا أي كتابة عكسية (لم يُخصَّص شيء أصلاً)
    expect(await partyBalance(db, 'customer', seed.customerId, seed.yerId)).toBe('230.0000');
    expect(await auditActions(db, 'cheque', res.chequeId)).toContain('cheque_bounce');
  });

  test('برسم: مصروف بفئة الشيك وبعملة الشيك (CASH → EXP للرسم فقط)', async () => {
    const { db, seed } = await seededDb();
    const catId = await insertExpenseCategory(db, 'رسوم بنكية');
    const res = await recordCheque(db, inChequeInput(seed, '230'));
    const out = await bounceCheque(db, res.chequeId, {
      fee: '1500',
      categoryId: catId,
      cashboxId: seed.cashboxId,
    });
    expect(out.bounceFee).toBe('1500.0000');
    expect(out.expenseCashTxId).not.toBeNull();

    const tx = await db.all<Record<string, string | number | null>>(
      'SELECT * FROM cash_tx WHERE id = ?',
      [out.expenseCashTxId],
    );
    expect(tx[0]!.tx_type).toBe('expense');
    expect(tx[0]!.amount).toBe('1500.0000');
    expect(Number(tx[0]!.expense_category_id)).toBe(catId);
    expect(String(tx[0]!.description)).toContain('CHQ-1001');
    expect(await boxBalance(db, seed.cashboxId)).toBe('-1500.0000');
    // الكشف لم يمس (الرسم مصروف منشأة لا دين طرف)
    expect(await partyBalance(db, 'customer', seed.customerId, seed.yerId)).toBe('0.0000');
  });

  test('رسم بلا فئة أو بلا صندوق → مرفوض', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(db, inChequeInput(seed, '100'));
    await expectDomainError(
      bounceCheque(db, res.chequeId, { fee: '500', cashboxId: seed.cashboxId }),
      'CHEQUE_FEE_CATEGORY_REQUIRED',
    );
    const catId = await insertExpenseCategory(db, 'رسوم بنكية');
    await expectDomainError(
      bounceCheque(db, res.chequeId, { fee: '500', categoryId: catId }),
      'CHEQUE_FEE_CASHBOX_REQUIRED',
    );
  });

  test('من cleared مرفوض (أثره المالي وقع)', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(db, inChequeInput(seed, '100'));
    await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });
    await expectDomainError(bounceCheque(db, res.chequeId, {}), 'CHEQUE_BOUNCE_STATE');
  });
});

/* ==================== الإلغاء (FR-14-06) ==================== */

describe('voidCheque — الإلغاء (FR-14-06)', () => {
  test('pending → void: الصف باقٍ (لا حذف فيزيائي) + audit', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(db, inChequeInput(seed, '100'));
    await voidCheque(db, res.chequeId);
    const row = await chequeRow(db, res.chequeId);
    expect(row).toBeDefined(); // الصف موجود
    expect(row!.status).toBe('void');
    expect(await auditActions(db, 'cheque', res.chequeId)).toEqual([
      'cheque_create',
      'cheque_void',
    ]);
    // لا أثر مالي كان ولا صار
    expect(await liveCashTxCount(db)).toBe(0);
  });

  test('من cleared مرفوض برسالة واضحة (ألغِ حركة الصندوق)', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(db, inChequeInput(seed, '100'));
    await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });
    await expectDomainError(voidCheque(db, res.chequeId), 'CHEQUE_VOID_CLEARED');
  });

  test('double void مرفوض', async () => {
    const { db, seed } = await seededDb();
    const res = await recordCheque(db, inChequeInput(seed, '100'));
    await voidCheque(db, res.chequeId);
    await expectDomainError(voidCheque(db, res.chequeId), 'CHEQUE_ALREADY_VOIDED');
  });
});

/* ==================== التصنيف (FR-14-05) ==================== */

describe('getDueSoonCheques / isOverdue — التصنيف', () => {
  const T = '2026-03-10';
  const mk = (dueDate: string, status: string) => ({ dueDate, status });

  test('isDueSoon: داخل النافذة نعم؛ الماضي لا (متأخر)؛ ما بعد النافذة لا', () => {
    expect(isDueSoon(mk(T, 'pending'), T)).toBe(true); // اليوم نفسه
    expect(isDueSoon(mk('2026-03-17', 'pending'), T)).toBe(true); // آخر النافذة
    expect(isDueSoon(mk('2026-03-18', 'pending'), T)).toBe(false); // بعدها
    expect(isDueSoon(mk('2026-03-09', 'pending'), T)).toBe(false); // الماضي
    expect(isDueSoon(mk(T, 'cleared'), T)).toBe(false); // ليست حية
    expect(isDueSoon(mk(T, 'deposited'), T)).toBe(true); // مودَع ما يزال تحت التحصيل
    expect(isDueSoon(mk(T, 'bounced'), T)).toBe(false);
    expect(isDueSoon(mk(T, 'void'), T)).toBe(false);
  });

  test('isOverdue: الماضي مع pending/deposited فقط', () => {
    expect(isOverdue(mk('2026-03-09', 'pending'), T)).toBe(true);
    expect(isOverdue(mk('2026-03-09', 'deposited'), T)).toBe(true);
    expect(isOverdue(mk(T, 'pending'), T)).toBe(false); // اليوم ليس متأخراً
    expect(isOverdue(mk('2026-03-01', 'cleared'), T)).toBe(false);
    expect(isOverdue(mk('2026-03-01', 'bounced'), T)).toBe(false);
    expect(isOverdue(mk('2026-03-01', 'void'), T)).toBe(false);
  });

  test('getDueSoonCheques: يرشّح الحية داخل النافذة ويحافظ على الكائنات', () => {
    const list = [
      { id: 1, ...mk('2026-03-12', 'pending') },
      { id: 2, ...mk('2026-03-09', 'pending') }, // متأخر
      { id: 3, ...mk('2026-03-16', 'deposited') },
      { id: 4, ...mk('2026-03-15', 'cleared') },
      { id: 5, ...mk('2026-03-25', 'pending') }, // خارج النافذة
    ];
    const due = getDueSoonCheques(list, T);
    expect(due.map((x) => x.id)).toEqual([1, 3]);
  });

  test('نافذة مخصصة (days) تُحترم', () => {
    const list = [mk('2026-03-13', 'pending'), mk('2026-03-20', 'pending')];
    expect(getDueSoonCheques(list, T, 3).length).toBe(1);
    expect(getDueSoonCheques(list, T, 10).length).toBe(2);
  });
});
