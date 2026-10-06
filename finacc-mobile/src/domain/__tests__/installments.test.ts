/**
 * installments.test.ts — خطة التقسيط ودورتها (SRS FR-05-01..07 نطاق V1).
 *
 * الجوهر المختبر:
 *  - قاعدة التقريب (5.4-9): أقساط متساوية مقربة لأقرب وحدة عملة والفرق
 *    على القسط الأخير (YER=0: 333/333/334 — SAR=2: 33.33/33.33/33.34).
 *  - الحرس (FR-05-01): آجلة فقط (لا نقدي/مختلط/ملغاة/مسودة) + خطة واحدة
 *    لكل فاتورة + دفعة أولى ≤ المتبقي + أصل موجب.
 *  - الدفعة الأولى والتحصيل سندات قبض حقيقية (recordVoucherTx) بتخصيص
 *    صريح للفاتورة — الصندوق يتحرك وكشف الطرف ينقص (بعملة الخطة).
 *  - التعجيل قبل الاستحقاق مسموح (FR-05-07) وإعادة الجدولة تلمس التاريخ
 *    فقط (FR-05-04) والتصنيف late/due مشتق لا مخزَّن.
 */
import { describe, expect, test } from 'bun:test';
import type { SqliteAdapter } from '../../db/adapter';
import { d } from '../../utils/money';
import { recordOpeningStock } from '../inventory';
import { saveInvoice, voidInvoice } from '../invoicing';
import { recordVoucher } from '../cash';
import { upsertDailyRate } from '../currency';
import { getPartyBalanceByCurrency } from '../statement';
import { DomainRuleError, MissingRateError, ValidationError } from '../errors';
import {
  addCycleMonths,
  addCycleWeeks,
  computeSchedule,
  createInstallmentPlan,
  daysLate,
  getInstallmentsDue,
  isLate,
  payInstallment,
  planProgress,
  rescheduleInstallment,
} from '../installments';
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

/** مدخل خطة قياسي — أول قسط بعد 30 يوماً بلا دفعة أولى */
function planInput(invoiceId: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    invoiceId,
    months: 3,
    cycle: 'monthly' as const,
    firstDue: daysAgoISO(-30),
    downPayment: '0',
    ...overrides,
  };
}

async function planRow(db: SqliteAdapter, id: number) {
  const rows = await db.all<Record<string, string | number | null>>(
    'SELECT * FROM installment_plan WHERE id = ?',
    [id],
  );
  return rows[0];
}

async function instRows(db: SqliteAdapter, planId: number) {
  const rows = await db.all<Record<string, string | number | null>>(
    'SELECT * FROM installment WHERE plan_id = ? ORDER BY seq',
    [planId],
  );
  return rows;
}

async function auditActions(db: SqliteAdapter, entity: string, entityId: number) {
  const rows = await db.all<{ action: string }>(
    'SELECT action FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id',
    [entity, entityId],
  );
  return rows.map((r) => r.action);
}

/** رصيد الطرف بعملة (FR-03-02) */
async function partyBalance(
  db: SqliteAdapter,
  partyId: number,
  currencyId: number,
): Promise<string> {
  const rows = await getPartyBalanceByCurrency(db, 'customer', partyId);
  const hit = rows.find((r) => r.currencyId === currencyId);
  return hit ? hit.balance : '0.0000';
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

/** تخصيصات السندات الحية على فاتورة (SUM يعيد رقماً — يُطبَّع 4dp) */
async function allocatedOn(db: SqliteAdapter, invoiceId: number): Promise<string> {
  const rows = await db.all<{ a: string | number | null }>(
    `SELECT SUM(pa.allocated_amount) AS a FROM payment_allocation pa
     JOIN cash_tx ct ON ct.id = pa.cash_tx_id
     WHERE pa.invoice_id = ? AND ct.is_voided = 0 AND ct.reversal_of IS NULL`,
    [invoiceId],
  );
  return d(rows[0]?.a ?? 0).toFixed(4);
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
  expect(threw).toBe(true);
  expect(caught).toBeInstanceOf(DomainRuleError);
  expect((caught as DomainRuleError).code).toBe(code);
}

/* ==================== قاعدة التقريب (FR-05-01 / 5.4-9) ==================== */

describe('computeSchedule — قاعدة التقريب', () => {
  test('1000 يمني ÷ 3 → 333 / 333 / 334 (الفرق على الأخير)', () => {
    const s = computeSchedule(d(1000), 3, 0);
    expect(s.map((x) => x.amount.toFixed(4))).toEqual(['333.0000', '333.0000', '334.0000']);
    expect(s.map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  test('100 سعودي ÷ 3 → 33.33 / 33.33 / 33.34 (منازل العملة)', () => {
    const s = computeSchedule(d(100), 3, 2);
    expect(s.map((x) => x.amount.toFixed(4))).toEqual(['33.3300', '33.3300', '33.3400']);
  });

  test('القسمة المتساوية → أقساط كلها متساوية ومجموعها الأصل حرفياً', () => {
    const s = computeSchedule(d(900), 3, 0);
    expect(s.map((x) => x.amount.toFixed(4))).toEqual(['300.0000', '300.0000', '300.0000']);
    const sum = s.reduce((acc, x) => acc.plus(x.amount), d(0));
    expect(sum.toFixed(4)).toBe('900.0000');
  });

  test('التقريب لأقرب وحدة: 5 ÷ 2 يمني → 3 / 2 (HALF_UP ثم الفرق)', () => {
    const s = computeSchedule(d(5), 2, 0);
    expect(s.map((x) => x.amount.toFixed(4))).toEqual(['3.0000', '2.0000']);
  });

  test('مبلغ أدق من دقة العملة على عدد كبير من الأقساط → مرفوض', async () => {
    await expectDomainError(
      (async () => computeSchedule(d(1), 3, 0))(),
      'INSTALLMENT_MONTHS_TOO_MANY',
    );
  });
});

/* ==================== التواريخ (نقية) ==================== */

describe('حساب التواريخ — تثبيت نهاية الشهر والأسبوع', () => {
  test('31 يناير + شهر → 28 فبراير (2026 ليست كبيسة)', () => {
    expect(addCycleMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  test('31 يناير + شهر → 29 فبراير في السنة الكبيسة، + شهرين → 31 مارس', () => {
    expect(addCycleMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addCycleMonths('2024-01-31', 2)).toBe('2024-03-31');
  });

  test('30 نوفمبر + 3 أشهر → 28 فبراير (لا تسرب إلى مارس)', () => {
    expect(addCycleMonths('2025-11-30', 3)).toBe('2026-02-28');
  });

  test('الأسبوع: إزاحات 7 أيام صافية', () => {
    expect(addCycleWeeks('2026-01-01', 1)).toBe('2026-01-08');
    expect(addCycleWeeks('2026-01-01', 2)).toBe('2026-01-15');
  });
});

/* ==================== إنشاء الخطة (FR-05-01) ==================== */

describe('createInstallmentPlan — التسجيل والجدول', () => {
  test('فاتورة آجلة 1000 → خطة active + جدول 333/333/334 شهري + audit', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '10', '100', daysAgoISO(2)); // 1000
    const res = await createInstallmentPlan(db, planInput(inv.invoiceId));

    const plan = await planRow(db, res.planId);
    expect(plan!.status).toBe('active');
    expect(plan!.customer_id).toBe(seed.customerId);
    expect(plan!.invoice_id).toBe(inv.invoiceId);
    expect(plan!.currency_id).toBe(seed.yerId);
    expect(plan!.exchange_rate).toBe('1.000000'); // Snapshot الفاتورة
    expect(plan!.principal).toBe('1000.0000');
    expect(plan!.down_payment).toBe('0.0000');
    expect(plan!.down_payment_cash_tx_id).toBeNull();
    expect(plan!.months).toBe(3);
    expect(plan!.cycle).toBe('monthly');
    expect(plan!.first_due).toBe(daysAgoISO(-30));
    expect(plan!.total_paid).toBe('0.0000');

    const insts = await instRows(db, res.planId);
    expect(insts.map((x) => x.amount)).toEqual(['333.0000', '333.0000', '334.0000']);
    expect(insts.map((x) => x.due_date)).toEqual([
      daysAgoISO(-30),
      addCycleMonths(daysAgoISO(-30), 1),
      addCycleMonths(daysAgoISO(-30), 2),
    ]);
    expect(insts.every((x) => x.status === 'pending' && x.paid_amount === '0.0000')).toBe(true);

    expect(await auditActions(db, 'installment_plan', res.planId)).toEqual([
      'installment_plan_create',
    ]);
  });

  test('الدورية الأسبوعية: الاستحقاق كل 7 أيام', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '3', '100', daysAgoISO(2)); // 300
    const first = daysAgoISO(-7);
    const res = await createInstallmentPlan(
      db,
      planInput(inv.invoiceId, { months: 3, cycle: 'weekly', firstDue: first }),
    );
    const insts = await instRows(db, res.planId);
    expect(insts.map((x) => x.due_date)).toEqual([
      first,
      addCycleWeeks(first, 1),
      addCycleWeeks(first, 2),
    ]);
  });

  test('تثبيت نهاية الشهر: أول قسط 31 يناير → الثاني 28 فبراير والثالث 31 مارس', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '9', '100', daysAgoISO(2)); // 900
    const res = await createInstallmentPlan(
      db,
      planInput(inv.invoiceId, { firstDue: '2026-01-31' }),
    );
    const insts = await instRows(db, res.planId);
    expect(insts.map((x) => x.due_date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  test('عملة أجنبية (SAR): المنازل من عملة الفاتورة + Snapshot سعرها', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await upsertDailyRate(db, seed.sarId, daysAgoISO(2), '530');
    const inv = await creditSale(db, seed, '1', '100', daysAgoISO(2), { currencyId: seed.sarId });
    const res = await createInstallmentPlan(db, planInput(inv.invoiceId));
    const plan = await planRow(db, res.planId);
    expect(plan!.currency_id).toBe(seed.sarId);
    expect(plan!.exchange_rate).toBe('530.000000'); // لقطة سعر الفاتورة
    const insts = await instRows(db, res.planId);
    expect(insts.map((x) => x.amount)).toEqual(['33.3300', '33.3300', '33.3400']);
  });

  test('down=0: لا حركة صندوق ولا تخصيص — الدين ظاهر كما هو', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '4', '100', daysAgoISO(2)); // 400
    await createInstallmentPlan(db, planInput(inv.invoiceId));
    const cash = await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM cash_tx');
    const alloc = await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM payment_allocation');
    expect(Number(cash[0]!.c)).toBe(0);
    expect(Number(alloc[0]!.c)).toBe(0);
    expect(await partyBalance(db, seed.customerId, seed.yerId)).toBe('400.0000');
  });

  test('down>0: سند قبض مخصص للفاتورة + مرتبط + الصندوق والكشف ينقصان', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '9', '100', daysAgoISO(2)); // 900
    const res = await createInstallmentPlan(
      db,
      planInput(inv.invoiceId, { downPayment: '300', cashboxId: seed.cashboxId }),
    );
    expect(res.downPaymentVoucher).not.toBeNull();
    expect(res.downPaymentVoucher!.voucherNo).toMatch(/^RVT-\d{4}-\d{5}$/);
    expect(res.downPaymentVoucher!.allocations).toEqual([
      { invoiceId: inv.invoiceId, invoiceNo: inv.invoiceNo, allocatedAmount: '300.0000' },
    ]);

    const plan = await planRow(db, res.planId);
    expect(plan!.down_payment).toBe('300.0000');
    expect(Number(plan!.down_payment_cash_tx_id)).toBe(res.downPaymentVoucher!.cashTxId);
    expect(plan!.principal).toBe('600.0000');

    // تخصيص فعلي على الفاتورة + رصيد الصندوق + كشف الطرف
    expect(await allocatedOn(db, inv.invoiceId)).toBe('300.0000');
    expect(await boxBalance(db, seed.cashboxId)).toBe('300.0000');
    expect(await partyBalance(db, seed.customerId, seed.yerId)).toBe('600.0000');

    // الجدول على الأصل 600: 200/200/200
    const insts = await instRows(db, res.planId);
    expect(insts.map((x) => x.amount)).toEqual(['200.0000', '200.0000', '200.0000']);
  });

  test('الملاحظة تُحفظ في قيد audit (لا عمود notes في DDL v1.2)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '4', '100', daysAgoISO(2));
    const res = await createInstallmentPlan(
      db,
      planInput(inv.invoiceId, { notes: 'اتفاق مع العميل على قسط شهري' }),
    );
    const rows = await db.all<{ details: string }>(
      'SELECT details FROM audit_log WHERE entity = ? AND entity_id = ?',
      ['installment_plan', res.planId],
    );
    const details = JSON.parse(rows[0]!.details) as { notes?: string };
    expect(details.notes).toBe('اتفاق مع العميل على قسط شهري');
  });
});

describe('createInstallmentPlan — الحرس', () => {
  test('نقدية مرفوضة (لا دين يُقسَّط) + مختلطة مرفوضة', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const cashInv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'cash',
      issuedAt: daysAgoISO(2),
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      cashboxId: seed.cashboxId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    });
    await expectDomainError(
      createInstallmentPlan(db, planInput(cashInv.invoiceId)),
      'INSTALLMENT_INVOICE_NOT_CREDIT',
    );

    const mixedInv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'mixed',
      paidAmount: '50',
      issuedAt: daysAgoISO(2),
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      cashboxId: seed.cashboxId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    });
    await expectDomainError(
      createInstallmentPlan(db, planInput(mixedInv.invoiceId)),
      'INSTALLMENT_INVOICE_NOT_CREDIT',
    );
  });

  test('ملغاة ومسودة مرفوضتان + فاتورة شراء مرفوضة', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const voided = await creditSale(db, seed, '1', '115', daysAgoISO(3));
    await voidInvoice(db, voided.invoiceId);
    await expectDomainError(
      createInstallmentPlan(db, planInput(voided.invoiceId)),
      'INSTALLMENT_INVOICE_NOT_LIVE',
    );

    const draft = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      status: 'draft',
      issuedAt: daysAgoISO(2),
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    });
    await expectDomainError(
      createInstallmentPlan(db, planInput(draft.invoiceId)),
      'INSTALLMENT_INVOICE_NOT_LIVE',
    );

    const pur = await saveInvoice(db, {
      docType: 'purchase',
      payStatus: 'credit',
      issuedAt: daysAgoISO(2),
      supplierId: seed.supplierId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '115' }],
    });
    await expectDomainError(
      createInstallmentPlan(db, planInput(pur.invoiceId)),
      'INSTALLMENT_INVOICE_NOT_SALE',
    );
  });

  test('فاتورة لها خطة قائمة مرفوضة — والخطة الملغاة لا تحجب', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '4', '100', daysAgoISO(2));
    await createInstallmentPlan(db, planInput(inv.invoiceId));
    await expectDomainError(
      createInstallmentPlan(db, planInput(inv.invoiceId)),
      'INSTALLMENT_PLAN_EXISTS',
    );

    // فاتورة ثانية بخطة «ملغاة» (صف يدوي — لا دالة إلغاء في V1) تقبل خطة جديدة
    const inv2 = await creditSale(db, seed, '4', '100', daysAgoISO(2));
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO installment_plan
         (customer_id, invoice_id, currency_id, exchange_rate, principal, months, cycle,
          first_due, status, created_at, updated_at)
       VALUES (?, ?, ?, '1.000000', '400.0000', 1, 'monthly', ?, 'cancelled', ?, ?)`,
      [seed.customerId, inv2.invoiceId, seed.yerId, daysAgoISO(-30), now, now],
    );
    const res = await createInstallmentPlan(db, planInput(inv2.invoiceId));
    expect((await planRow(db, res.planId))!.status).toBe('active');
  });

  test('فاتورة مسددة بالكامل مرفوضة (لا متبقي يُقسَّط)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '1', '115', daysAgoISO(3));
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '115',
      exchangeRate: '1',
      txDate: TODAY,
      customerId: seed.customerId,
      allocations: [{ invoiceId: inv.invoiceId, amount: '115' }],
    });
    await expectDomainError(
      createInstallmentPlan(db, planInput(inv.invoiceId)),
      'INSTALLMENT_NO_REMAINING',
    );
  });

  test('الدفعة الأولى فوق المتبقي مرفوضة، وتغطية الكامل مرفوضة (أصل صفري)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '4', '100', daysAgoISO(2)); // 400
    await expectDomainError(
      createInstallmentPlan(
        db,
        planInput(inv.invoiceId, { downPayment: '401', cashboxId: seed.cashboxId }),
      ),
      'INSTALLMENT_DOWN_EXCEEDS_REMAINING',
    );
    await expectDomainError(
      createInstallmentPlan(
        db,
        planInput(inv.invoiceId, { downPayment: '400', cashboxId: seed.cashboxId }),
      ),
      'INSTALLMENT_PRINCIPAL_ZERO',
    );
  });

  test('دفعة أولى بلا صندوق مرفوضة', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '4', '100', daysAgoISO(2));
    await expectDomainError(
      createInstallmentPlan(db, planInput(inv.invoiceId, { downPayment: '100' })),
      'INSTALLMENT_DOWN_CASHBOX_REQUIRED',
    );
  });

  test('أقساط كثيرة على مبلغ أدق من وحدة العملة مرفوضة (زود منطق التقريب)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '1', '1', daysAgoISO(2)); // 1 ريال
    await expectDomainError(
      createInstallmentPlan(db, planInput(inv.invoiceId, { months: 3 })),
      'INSTALLMENT_MONTHS_TOO_MANY',
    );
  });

  test('مدخل ناقص يُرفض بالتحقق (زود)', async () => {
    const { db } = await seededDb();
    await expect(
      createInstallmentPlan(db, planInput(0)),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createInstallmentPlan(
        db,
        planInput(-1, { firstDue: '31-01-2026' }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('ذرّية الفشل: صندوق غير موجود → لا خطة ولا أقساط ولا سند ولا تخصيص', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '9', '100', daysAgoISO(2)); // 900
    await expectDomainError(
      createInstallmentPlan(
        db,
        planInput(inv.invoiceId, { downPayment: '300', cashboxId: 999_999 }),
      ),
      'CASHBOX_NOT_FOUND',
    );
    for (const table of ['installment_plan', 'installment', 'cash_tx', 'payment_allocation']) {
      const rows = await db.all<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
      expect(Number(rows[0]!.c)).toBe(0);
    }
  });
});

/* ==================== تحصيل قسط (FR-05-02 + FR-05-07) ==================== */

describe('payInstallment — التحصيل', () => {
  /** فاتورة 900 بخطة شهرين (450/450) — أول استحقاق بعد 30 يوماً */
  async function plan900x2(db: SqliteAdapter, seed: Seed) {
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '9', '100', daysAgoISO(2));
    const res = await createInstallmentPlan(
      db,
      planInput(inv.invoiceId, { months: 2 }),
    );
    return { inv, planId: res.planId };
  }

  test('سداد كامل: سند RVT + تخصيص للفاتورة + قسط paid + totalPaid + الكشف ينقص', async () => {
    const { db, seed } = await seededDb();
    const { inv, planId } = await plan900x2(db, seed);
    const insts = await instRows(db, planId);
    const first = insts[0]!;

    const res = await payInstallment(db, {
      installmentId: Number(first.id),
      cashboxId: seed.cashboxId,
    });
    expect(res.paidAmount).toBe('450.0000');
    expect(res.remainingAfter).toBe('0.0000');
    expect(res.installmentStatus).toBe('paid');
    expect(res.planCompleted).toBe(false);
    expect(res.voucherNo).toMatch(/^RVT-\d{4}-\d{5}$/);
    expect(res.allocations).toEqual([
      { invoiceId: inv.invoiceId, invoiceNo: inv.invoiceNo, allocatedAmount: '450.0000' },
    ]);

    const after = (await instRows(db, planId))[0]!;
    expect(after.paid_amount).toBe('450.0000');
    expect(after.status).toBe('paid');
    expect(after.paid_at).toBe(TODAY);
    expect(Number(after.cash_tx_id)).toBe(res.cashTxId);

    const plan = await planRow(db, planId);
    expect(plan!.total_paid).toBe('450.0000');
    expect(plan!.status).toBe('active'); // لم تكتمل بعد

    expect(await boxBalance(db, seed.cashboxId)).toBe('450.0000');
    expect(await partyBalance(db, seed.customerId, seed.yerId)).toBe('450.0000');
    expect(await auditActions(db, 'installment', Number(first.id))).toEqual(['installment_pay']);
  });

  test('سداد جزئي ثم إتمام: partial ثم paid، والخطة لا تكتمل إلا بالكل', async () => {
    const { db, seed } = await seededDb();
    const { planId } = await plan900x2(db, seed);
    const first = (await instRows(db, planId))[0]!;
    const second = (await instRows(db, planId))[1]!;

    const part = await payInstallment(db, {
      installmentId: Number(first.id),
      cashboxId: seed.cashboxId,
      amount: '200',
    });
    expect(part.installmentStatus).toBe('partial');
    expect(part.remainingAfter).toBe('250.0000');
    expect((await instRows(db, planId))[0]!.status).toBe('partial');
    expect((await instRows(db, planId))[0]!.paid_at).toBeNull(); // paid_at عند الاكتمال فقط

    const done = await payInstallment(db, {
      installmentId: Number(first.id),
      cashboxId: seed.cashboxId,
      amount: '250',
    });
    expect(done.installmentStatus).toBe('paid');
    expect((await instRows(db, planId))[0]!.paid_amount).toBe('450.0000');

    // القسط الثاني لم يُسدد → الخطة نشطة، ثم تُسدد فيكتمل
    const mid = await planRow(db, planId);
    expect(mid!.status).toBe('active');
    expect(mid!.total_paid).toBe('450.0000');

    const last = await payInstallment(db, {
      installmentId: Number(second.id),
      cashboxId: seed.cashboxId,
    });
    expect(last.planCompleted).toBe(true);
    const fin = await planRow(db, planId);
    expect(fin!.status).toBe('completed');
    expect(fin!.total_paid).toBe('900.0000');
    // الكشف: 900 − 450 − 450 = صفر
    expect(await partyBalance(db, seed.customerId, seed.yerId)).toBe('0.0000');
    expect(await boxBalance(db, seed.cashboxId)).toBe('900.0000');
  });

  test('تعجيل قبل الاستحقاق مسموح (FR-05-07) — بلا إزاحة ولا إعادة توليد', async () => {
    const { db, seed } = await seededDb();
    const { planId } = await plan900x2(db, seed); // الاستحقاق بعد 30 يوماً
    const first = (await instRows(db, planId))[0]!;
    const before = (await instRows(db, planId)).map((x) => x.due_date);

    const res = await payInstallment(db, {
      installmentId: Number(first.id),
      cashboxId: seed.cashboxId,
    });
    expect(res.installmentStatus).toBe('paid');

    // الجدول لم يتغير — التواريخ كما ولّدت (تعجيل لا يسحب الموعد)
    expect((await instRows(db, planId)).map((x) => x.due_date)).toEqual(before);

    const audits = await db.all<{ details: string }>(
      'SELECT details FROM audit_log WHERE entity = ? AND entity_id = ?',
      ['installment', Number(first.id)],
    );
    const details = JSON.parse(audits[0]!.details) as { earlyPayment?: boolean };
    expect(details.earlyPayment).toBe(true);
  });

  test('تجاوز متبقي القسط مرفوض + السداد على قسط مسدد مرفوض', async () => {
    const { db, seed } = await seededDb();
    const { planId } = await plan900x2(db, seed);
    const first = (await instRows(db, planId))[0]!;
    await expectDomainError(
      payInstallment(db, {
        installmentId: Number(first.id),
        cashboxId: seed.cashboxId,
        amount: '451',
      }),
      'INSTALLMENT_OVERPAY',
    );
    await expectDomainError(
      payInstallment(db, {
        installmentId: Number(first.id),
        cashboxId: seed.cashboxId,
        amount: '0',
      }),
      'INSTALLMENT_PAY_NOT_POSITIVE',
    );
    await payInstallment(db, { installmentId: Number(first.id), cashboxId: seed.cashboxId });
    await expectDomainError(
      payInstallment(db, { installmentId: Number(first.id), cashboxId: seed.cashboxId }),
      'INSTALLMENT_ALREADY_PAID',
    );
  });

  test('خطة بعملة أجنبية: لا سعر ليوم الدفع → MissingRateError، وبالسعر يمر', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await upsertDailyRate(db, seed.sarId, daysAgoISO(2), '530');
    const inv = await creditSale(db, seed, '1', '90', daysAgoISO(2), { currencyId: seed.sarId });
    const res = await createInstallmentPlan(db, planInput(inv.invoiceId, { months: 2 }));
    const first = (await instRows(db, res.planId))[0]!;

    await expect(
      payInstallment(db, { installmentId: Number(first.id), cashboxId: seed.cashboxId }),
    ).rejects.toBeInstanceOf(MissingRateError);

    await upsertDailyRate(db, seed.sarId, TODAY, '560');
    const done = await payInstallment(db, {
      installmentId: Number(first.id),
      cashboxId: seed.cashboxId,
    });
    expect(done.installmentStatus).toBe('paid');
    // نفس العملة → لا فرق صرف
    expect(done.fxGainLoss).toBe('0.0000');
    // الكشف بالسعودي: 90 − 45 = 45
    expect(await partyBalance(db, seed.customerId, seed.sarId)).toBe('45.0000');
  });

  test('سداد أقساط فاتورة سُدّدت من سبيل آخر: الزيادة على الحساب (سلوك السند الحر)', async () => {
    const { db, seed } = await seededDb();
    const { inv, planId } = await plan900x2(db, seed);
    // سند حر بسعر يوم كامل يغلق الفاتورة (FIFO)
    await recordVoucher(db, {
      txType: 'receipt',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '900',
      exchangeRate: '1',
      txDate: TODAY,
      customerId: seed.customerId,
    });
    expect(await allocatedOn(db, inv.invoiceId)).toBe('900.0000');
    expect(await partyBalance(db, seed.customerId, seed.yerId)).toBe('0.0000');

    const first = (await instRows(db, planId))[0]!;
    const res = await payInstallment(db, {
      installmentId: Number(first.id),
      cashboxId: seed.cashboxId,
    });
    expect(res.installmentStatus).toBe('paid');
    expect(res.allocations).toEqual([]); // الفاتورة مغلقة — لا تخصيص
    expect(res.onAccountAmount).toBe('450.0000'); // القبض رصيد دائن للعميل
    expect(await partyBalance(db, seed.customerId, seed.yerId)).toBe('-450.0000');
  });
});

/* ==================== إعادة الجدولة (FR-05-04) ==================== */

describe('rescheduleInstallment — تعديل التاريخ فقط', () => {
  test('يتغير التاريخ + قيد audit + المبالغ لا تُمس', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '9', '100', daysAgoISO(2));
    const res = await createInstallmentPlan(db, planInput(inv.invoiceId, { months: 2 }));
    const first = (await instRows(db, res.planId))[0]!;
    const oldDue = String(first.due_date);

    await rescheduleInstallment(db, {
      installmentId: Number(first.id),
      newDueDate: daysAgoISO(-60),
      reason: 'طلب العميل تأخير القسط',
    });

    const after = (await instRows(db, res.planId))[0]!;
    expect(after.due_date).toBe(daysAgoISO(-60));
    expect(after.amount).toBe(first.amount); // المبالغ كما هي
    expect(after.paid_amount).toBe('0.0000');
    expect(after.status).toBe('pending');
    // بقية الأقساط لم تُزح تلقائياً (FR-05-04: لا إزاحة تلقائية)
    expect((await instRows(db, res.planId))[1]!.due_date).toBe(addCycleMonths(oldDue, 1));

    const rows = await db.all<{ details: string }>(
      'SELECT details FROM audit_log WHERE entity = ? AND entity_id = ? AND action = ?',
      ['installment', Number(first.id), 'installment_reschedule'],
    );
    const details = JSON.parse(rows[0]!.details) as {
      oldDueDate?: string;
      newDueDate?: string;
      reason?: string | null;
    };
    expect(details.oldDueDate).toBe(oldDue);
    expect(details.newDueDate).toBe(daysAgoISO(-60));
    expect(details.reason).toBe('طلب العميل تأخير القسط');
  });

  test('قسط مسدد لا يُعاد جدولته', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '9', '100', daysAgoISO(2));
    const res = await createInstallmentPlan(db, planInput(inv.invoiceId, { months: 2 }));
    const first = (await instRows(db, res.planId))[0]!;
    await payInstallment(db, { installmentId: Number(first.id), cashboxId: seed.cashboxId });
    await expectDomainError(
      rescheduleInstallment(db, { installmentId: Number(first.id), newDueDate: daysAgoISO(-90) }),
      'INSTALLMENT_RESCHEDULE_PAID',
    );
  });
});

/* ==================== التصنيف (FR-05-04) ==================== */

describe('isLate / daysLate / getInstallmentsDue — التصنيف المشتق', () => {
  test('isLate: المتأخر pending/partial قبل اليوم فقط', () => {
    expect(isLate({ dueDate: daysAgoISO(1), status: 'pending' })).toBe(true);
    expect(isLate({ dueDate: daysAgoISO(3), status: 'partial' })).toBe(true);
    expect(isLate({ dueDate: TODAY, status: 'pending' })).toBe(false); // اليوم ليس متأخراً
    expect(isLate({ dueDate: daysAgoISO(-1), status: 'pending' })).toBe(false);
    expect(isLate({ dueDate: daysAgoISO(5), status: 'paid' })).toBe(false);
    // 'late' قيمة عرض لا يكتبها الدومين قط (مشتقة — FR-05-04): التصنيف الرسمي pending/partial فقط
  });

  test('daysLate: فرق الأيام، و0 لغير المتأخر', () => {
    expect(daysLate({ dueDate: daysAgoISO(1), status: 'pending' })).toBe(1);
    expect(daysLate({ dueDate: daysAgoISO(10), status: 'pending' })).toBe(10);
    expect(daysLate({ dueDate: TODAY, status: 'pending' })).toBe(0);
    expect(daysLate({ dueDate: daysAgoISO(10), status: 'paid' })).toBe(0);
  });

  test('getInstallmentsDue: اليوم/خلال الأسبوع/متأخر داخل النافذة — وما بعدها أو المسدد خارجها', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);

    // خطة أسبوعية أول استحقاق اليوم: seq1 اليوم، seq2 +7 (حد النافذة)، seq3 +14 خارجها
    const invA = await creditSale(db, seed, '12', '100', daysAgoISO(2));
    const planA = await createInstallmentPlan(
      db,
      planInput(invA.invoiceId, { months: 3, cycle: 'weekly', firstDue: TODAY }),
    );
    // خطة أول استحقاق قبل 3 أيام → متأخر
    const invB = await creditSale(db, seed, '4', '100', daysAgoISO(2));
    const planB = await createInstallmentPlan(
      db,
      planInput(invB.invoiceId, { months: 1, firstDue: daysAgoISO(3) }),
    );
    // خطة قادمة بعيدة (بعد 40 يوماً) → خارج النافذة
    const invC = await creditSale(db, seed, '4', '100', daysAgoISO(2));
    await createInstallmentPlan(db, planInput(invC.invoiceId, { months: 1, firstDue: daysAgoISO(-40) }));

    const due = await getInstallmentsDue(db, { today: TODAY, withinDays: 7 });
    const ids = due.map((x) => x.id);
    const aInsts = await instRows(db, planA.planId);
    const bInsts = await instRows(db, planB.planId);

    expect(ids).toContain(Number(aInsts[0]!.id)); // اليوم
    expect(ids).toContain(Number(aInsts[1]!.id)); // +7 (حد النافذة داخل)
    expect(ids).not.toContain(Number(aInsts[2]!.id)); // +14 خارج
    expect(ids).toContain(Number(bInsts[0]!.id)); // متأخر 3 أيام

    // سداد قسط اليوم يخرجه من المستحق
    await payInstallment(db, {
      installmentId: Number(aInsts[0]!.id),
      cashboxId: seed.cashboxId,
    });
    const after = await getInstallmentsDue(db, { today: TODAY, withinDays: 7 });
    expect(after.map((x) => x.id)).not.toContain(Number(aInsts[0]!.id));

    // بيانات الضم صحيحة للعرض
    const late = after.find((x) => x.id === Number(bInsts[0]!.id))!;
    expect(late.seq).toBe(1);
    expect(late.invoiceId).toBe(invB.invoiceId);
    expect(late.customerId).toBe(seed.customerId);
    expect(late.currencyId).toBe(seed.yerId);
    expect(late.amount).toBe('400.0000');
  });
});

/* ==================== الأرقام من طرف إلى طرف ==================== */

describe('FR-05 من طرف إلى طرف: فاتورة 909 → دفعة 300 + قسطان', () => {
  test('فاتورة 900 آجلة → دفعة أولى 300 + شهران 300/300 → تحصيل الأول = متبقي 300', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await creditSale(db, seed, '9', '100', daysAgoISO(2)); // 900 آجلة

    const res = await createInstallmentPlan(
      db,
      planInput(inv.invoiceId, {
        months: 2,
        downPayment: '300',
        cashboxId: seed.cashboxId,
      }),
    );
    // الدفعة الأولى: قبض مخصص للفاتورة
    expect(await allocatedOn(db, inv.invoiceId)).toBe('300.0000');
    expect(await partyBalance(db, seed.customerId, seed.yerId)).toBe('600.0000');

    // الجدول: 300 / 300
    const insts = await instRows(db, res.planId);
    expect(insts.map((x) => x.amount)).toEqual(['300.0000', '300.0000']);

    // تحصيل القسط الأول
    await payInstallment(db, {
      installmentId: Number(insts[0]!.id),
      cashboxId: seed.cashboxId,
    });

    // الكشف = 900 − 300 − 300 = 300 متبقية
    expect(await partyBalance(db, seed.customerId, seed.yerId)).toBe('300.0000');
    // الصندوق استلم 600 (دفعة أولى + قسط)
    expect(await boxBalance(db, seed.cashboxId)).toBe('600.0000');

    // تقدّم الخطة: 1/2 ومتبقٍ 300
    const fresh = await instRows(db, res.planId);
    const progress = planProgress(
      fresh.map((x) => ({
        id: Number(x.id),
        plan_id: Number(x.plan_id),
        seq: Number(x.seq),
        due_date: String(x.due_date),
        amount: String(x.amount),
        paid_amount: x.paid_amount === null ? null : String(x.paid_amount),
        status: x.status === null ? null : String(x.status),
        paid_at: x.paid_at === null ? null : String(x.paid_at),
        cash_tx_id: x.cash_tx_id === null ? null : Number(x.cash_tx_id),
      })),
    );
    expect(progress.total).toBe(2);
    expect(progress.paidCount).toBe(1);
    expect(progress.remaining.toFixed(4)).toBe('300.0000');
  });
});
