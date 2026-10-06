/**
 * invoicing.test.ts — آلة حالات الفاتورة الكاملة (SRS 5.4-2 / قرار 2 + §10.1 AC-01/02/03/11/13/16/20/21).
 */
import { describe, expect, test } from 'bun:test';
import type { SqliteAdapter } from '../../db/adapter';
import { d } from '../../utils/money';
import { recordOpeningStock, getStockLevel } from '../inventory';
import {
  BackdateConfirmationRequiredError,
  DomainRuleError,
  FiscalPeriodClosedError,
  InvoiceStateError,
  NegativeStockError,
  ValidationError,
} from '../errors';
import { setSetting } from '../settings';
import { upsertDailyRate } from '../currency';
import {
  computeInvoiceTotals,
  convertDraft,
  createLinkedReturn,
  deleteDraft,
  distributeInvoiceDiscount,
  getInvoiceWithItems,
  saveInvoice,
  voidInvoice,
} from '../invoicing';
import type { LineInput, LinkedReturnInput, SaveInvoiceInput } from '../invoicing';
import { daysAgoISO, seededDb } from './seed';
import type { Seed } from './seed';

const TODAY = daysAgoISO(0);

/* ============================ مساعدات ============================ */

async function openMilk(db: SqliteAdapter, seed: Seed, qty = '10', cost = '90'): Promise<void> {
  await recordOpeningStock(db, {
    productId: seed.milkId,
    warehouseId: seed.warehouseId,
    qty: d(qty),
    unitCost: d(cost),
    movedAt: daysAgoISO(6),
  });
}

function milkLine(qty: string, price: string, extra: Partial<LineInput> = {}): LineInput {
  return { productId: null, qty, unitPrice: price, ...extra };
}

function saleInput(
  seed: Seed,
  lines: LineInput[],
  overrides: Partial<SaveInvoiceInput> = {},
): SaveInvoiceInput {
  return {
    docType: 'sale',
    payStatus: 'credit',
    issuedAt: TODAY,
    customerId: seed.customerId,
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines,
    ...overrides,
  };
}

async function invoiceRow(db: SqliteAdapter, id: number) {
  const rows = await db.all<Record<string, string | number | null>>(
    'SELECT * FROM invoice WHERE id = ?',
    [id],
  );
  return rows[0];
}

async function movementsFor(db: SqliteAdapter, refType: string, refId: number) {
  return db.all<{
    id: number;
    movement_type: string;
    qty: string;
    unit_cost: string;
    ref_type: string;
    ref_id: number;
  }>('SELECT id, movement_type, qty, unit_cost, ref_type, ref_id FROM stock_movement WHERE ref_type = ? AND ref_id = ? ORDER BY id', [refType, refId]);
}

async function cashFor(db: SqliteAdapter, refType: string, refId: number) {
  return db.all<{
    id: number;
    tx_type: string;
    amount: string;
    exchange_rate: string;
    is_voided: number;
    reversal_of: number | null;
    description: string;
    currency_id: number;
  }>(
    'SELECT id, tx_type, amount, exchange_rate, is_voided, reversal_of, description, currency_id FROM cash_tx WHERE ref_type = ? AND ref_id = ? ORDER BY id',
    [refType, refId],
  );
}

function linkedReturnInput(
  seed: Seed,
  originalInvoiceId: number,
  lines: LineInput[],
  overrides: Partial<LinkedReturnInput> = {},
): LinkedReturnInput {
  return {
    docType: 'sale_return',
    originalInvoiceId,
    issuedAt: TODAY,
    returnPayDirection: 'account',
    warehouseId: seed.warehouseId,
    currencyId: seed.yerId,
    lines,
    ...overrides,
  };
}

/* ==================== آلة الحالات (جدول 5.4-2) ==================== */

describe('saveInvoice — نقدي/آجل/مختلط/مسودة (جدول 5.4-2)', () => {
  test('حفظ نقدي: completed + INV-2026-00001 + خصم المخزون + حركة صندوق كاملة بالمبلغ', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const res = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], {
        payStatus: 'cash',
        cashboxId: seed.cashboxId,
      }),
    );
    expect(res.invoiceNo).toBe(`INV-${new Date().getUTCFullYear()}-00001`);
    const inv = await invoiceRow(db, res.invoiceId);
    expect(inv!.status).toBe('completed');
    expect(inv!.pay_status).toBe('cash');
    expect(inv!.total).toBe('230.0000');
    expect(inv!.paid_amount).toBe('230.0000');
    expect(inv!.due_amount).toBe('0.0000');
    expect(inv!.cost_total).toBe('180.0000'); // 2 × 90 (WAC Snapshot)
    expect(inv!.total_base).toBe('230.0000');
    // خصم المخزون
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('8.000');
    const mvs = await movementsFor(db, 'invoice', res.invoiceId);
    expect(mvs.length).toBe(1);
    expect(mvs[0]!.movement_type).toBe('sale');
    expect(mvs[0]!.qty).toBe('-2.000');
    expect(mvs[0]!.unit_cost).toBe('90.0000');
    // حركة صندوق receipt بالمبلغ الكامل
    const cash = await cashFor(db, 'invoice', res.invoiceId);
    expect(cash.length).toBe(1);
    expect(cash[0]!.tx_type).toBe('receipt');
    expect(cash[0]!.amount).toBe('230.0000');
    expect(cash[0]!.exchange_rate).toBe('1.000000');
    expect(cash[0]!.description).toContain('تحصيل فاتورة INV-');
    expect(cash[0]!.is_voided).toBe(0);
  });

  test('AC-01: حفظ آجل بثلاثة بنود: رقم مستهلك + بلا حركة صندوق + due = total + سلامة البنود', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const res = await saveInvoice(
      db,
      saleInput(seed, [
        milkLine('2', '115', { productId: seed.milkId }),
        milkLine('1', '110', { productId: seed.milkId }),
        milkLine('1', '25', { productId: seed.deliveryId }),
      ]),
    );
    const inv = await invoiceRow(db, res.invoiceId);
    expect(inv!.pay_status).toBe('credit');
    expect(inv!.total).toBe('365.0000');
    expect(inv!.due_amount).toBe('365.0000');
    expect(inv!.paid_amount).toBe('0.0000');
    expect(inv!.cost_total).toBe('270.0000'); // (2+1)×90 + خدمة 0
    const cash = await cashFor(db, 'invoice', res.invoiceId);
    expect(cash.length).toBe(0); // آجل: لا صندوق
    const items = await db.all('SELECT product_id, line_total, line_cost FROM invoice_item WHERE invoice_id = ?', [res.invoiceId]);
    expect(items.length).toBe(3);
    expect((items[0] as Record<string, string>).line_total).toBe('230.0000');
    expect((items[1] as Record<string, string>).line_total).toBe('110.0000');
    expect((items[2] as Record<string, string>).line_cost).toBe('0.0000');
    const seq = await db.all<{ last_no: number }>(
      'SELECT last_no FROM doc_sequence WHERE doc_type = ? AND year = ?',
      ['INV', new Date().getUTCFullYear()],
    );
    expect(Number(seq[0]!.last_no)).toBe(1);
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('7.000');
  });

  test('حفظ مختلط: جزء نقدي + الباقي آجل', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const res = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], {
        payStatus: 'mixed',
        paidAmount: '100',
        cashboxId: seed.cashboxId,
      }),
    );
    const inv = await invoiceRow(db, res.invoiceId);
    expect(inv!.pay_status).toBe('mixed');
    expect(inv!.paid_amount).toBe('100.0000');
    expect(inv!.due_amount).toBe('130.0000');
    const cash = await cashFor(db, 'invoice', res.invoiceId);
    expect(cash.length).toBe(1);
    expect(cash[0]!.amount).toBe('100.0000');
    expect(cash[0]!.description).toContain('تحصيل جزئي');
  });

  test('مختلط بمدفوع ≥ الإجمالي أو ≤ 0 → رفض عربي', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], {
          payStatus: 'mixed',
          paidAmount: '230',
          cashboxId: seed.cashboxId,
        }),
      ),
    ).rejects.toThrow('أقل من إجمالي الفاتورة');
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], {
          payStatus: 'mixed',
          paidAmount: '0',
          cashboxId: seed.cashboxId,
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('نقدي بلا صندوق → رفض «يتطلب اختيار الصندوق»', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expect(
      saveInvoice(db, saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { payStatus: 'cash' })),
    ).rejects.toThrow('يتطلب اختيار الصندوق');
  });

  test('مسودة: لا رقم، لا مخزون، لا صندوق، لا استهلاك docseq (قرار 2)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const res = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { status: 'draft', payStatus: 'credit' }),
    );
    expect(res.invoiceNo).toBeNull();
    const inv = await invoiceRow(db, res.invoiceId);
    expect(inv!.status).toBe('draft');
    expect(inv!.invoice_no).toBeNull();
    expect(inv!.total).toBe('230.0000');
    expect(inv!.cost_total).toBe('180.0000'); // Snapshot بالتكلفة الحالية
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('10.000');
    const seqRows = await db.all('SELECT * FROM doc_sequence');
    expect(seqRows.length).toBe(0);
    const cashRows = await db.all('SELECT * FROM cash_tx');
    expect(cashRows.length).toBe(0);
    const mvRows = await db.all('SELECT * FROM stock_movement WHERE ref_type = ?', ['invoice']);
    expect(mvRows.length).toBe(0);
  });
});

describe('convertDraft — التحويل الذرّي (FR-02-18)', () => {
  test('التحويل: الرقم يُستهلك الآن + الخصم + الصندوق حسب payStatus + converted_at', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const draft = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { status: 'draft', payStatus: 'credit' }),
    );
    const res = await convertDraft(db, draft.invoiceId, { payStatus: 'cash', cashboxId: seed.cashboxId });
    expect(res.invoiceNo).toBe(`INV-${new Date().getUTCFullYear()}-00001`);
    const inv = await invoiceRow(db, draft.invoiceId);
    expect(inv!.status).toBe('completed');
    expect(inv!.converted_at).toBeTruthy();
    expect(inv!.pay_status).toBe('cash');
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('8.000');
    const cash = await cashFor(db, 'invoice', draft.invoiceId);
    expect(cash.length).toBe(1);
    expect(cash[0]!.tx_type).toBe('receipt');
  });

  test('التحول يعيد حساب line_cost بتكلفة اليوم (WAC قد يتغير بين الإنشاء والتحويل)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed, '10', '90'); // WAC 90
    const draft = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { status: 'draft', payStatus: 'credit' }),
    );
    // شراء لاحق يرفع WAC إلى (10×90+10×130)/20 = 110
    await saveInvoice(
      db,
      {
        docType: 'purchase',
        payStatus: 'credit',
        issuedAt: TODAY,
        supplierId: seed.supplierId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [milkLine('10', '130', { productId: seed.milkId })],
      },
    );
    await convertDraft(db, draft.invoiceId, { payStatus: 'credit' });
    const inv = await invoiceRow(db, draft.invoiceId);
    expect(inv!.cost_total).toBe('220.0000'); // 2 × 110 (تكلفة وقت التحويل)
    const items = await db.all<{ line_cost: string }>(
      'SELECT line_cost FROM invoice_item WHERE invoice_id = ?',
      [draft.invoiceId],
    );
    expect(items[0]!.line_cost).toBe('220.0000');
  });

  test('AC-09/FR-02-18: تحويل بنقص مخزون → رفض بتسمية الصنف والنقص وعدم تطبيق أي شيء', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed, '10', '90');
    const draft = await saveInvoice(
      db,
      saleInput(seed, [milkLine('5', '115', { productId: seed.milkId })], { status: 'draft', payStatus: 'credit' }),
    );
    // بيع فعلي يستهلك 8 → المتاح 2 فقط
    const other = await saveInvoice(
      db,
      saleInput(seed, [milkLine('8', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    void other;
    let err: unknown;
    try {
      await convertDraft(db, draft.invoiceId, { payStatus: 'credit' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NegativeStockError);
    expect((err as Error).message).toContain('حليب المراعي');
    expect((err as Error).message).toContain('النقص 3.000');
    // ذرّية كاملة: المسودة بقيت مسودة بلا رقم والرصيد لم يتغير ولا صندوق
    const inv = await invoiceRow(db, draft.invoiceId);
    expect(inv!.status).toBe('draft');
    expect(inv!.invoice_no).toBeNull();
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('2.000');
    const cash = await db.all('SELECT * FROM cash_tx');
    expect(cash.length).toBe(0);
    // الرقم 00002 لم يُصدر — الفاتورة التالية تأخذه
    const next = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    expect(next.invoiceNo).toBe(`INV-${new Date().getUTCFullYear()}-00002`);
  });

  test('تحويل غير المسودة → InvoiceStateError «ليست مسودة»', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const inv = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    await expect(convertDraft(db, inv.invoiceId)).rejects.toBeInstanceOf(InvoiceStateError);
  });
});

describe('voidInvoice — الإلغاء بحركات معاكسة (FR-02-15 / AC-11)', () => {
  test('إلغاء مكتملة: void + حركات معاكسة تعيد الرصيد + عكس الصندوق + رقم لا يُعاد', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const res = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], {
        payStatus: 'cash',
        cashboxId: seed.cashboxId,
      }),
    );
    await voidInvoice(db, res.invoiceId, { createdBy: 1 });
    const inv = await invoiceRow(db, res.invoiceId);
    expect(inv!.status).toBe('void');
    expect(inv!.invoice_no).toBe(`INV-${new Date().getUTCFullYear()}-00001`); // الرقم باقٍ
    // الرصيد عاد بالحركة المعاكسة (نفس النوع، كمية معكوسة، مرجع invoice_void)
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('10.000');
    const voidMv = await movementsFor(db, 'invoice_void', res.invoiceId);
    expect(voidMv.length).toBe(1);
    expect(voidMv[0]!.movement_type).toBe('sale');
    expect(voidMv[0]!.qty).toBe('2.000');
    expect(voidMv[0]!.unit_cost).toBe('90.0000');
    // الصندوق: الأصل is_voided=1 + معاكسة receipt↔payment مع reversal_of = الأصل
    const orig = await db.all<{ id: number; is_voided: number }>(
      'SELECT id, is_voided FROM cash_tx WHERE ref_type = ? AND ref_id = ?',
      ['invoice', res.invoiceId],
    );
    expect(orig.length).toBe(1);
    expect(orig[0]!.is_voided).toBe(1);
    const rev = await db.all<{ tx_type: string; amount: string; reversal_of: number; description: string }>(
      'SELECT tx_type, amount, reversal_of, description FROM cash_tx WHERE ref_type = ? AND ref_id = ?',
      ['invoice_void', res.invoiceId],
    );
    expect(rev.length).toBe(1);
    expect(rev[0]!.tx_type).toBe('payment');
    expect(rev[0]!.amount).toBe('230.0000'); // CHECK amount > 0 — المبلغ موجب والنوع معكوس
    expect(Number(rev[0]!.reversal_of)).toBe(Number(orig[0]!.id));
    // audit
    const aud = await db.all<{ action: string }>(
      'SELECT action FROM audit_log WHERE action = ? AND entity_id = ?',
      ['void_invoice', res.invoiceId],
    );
    expect(aud.length).toBe(1);
    // الرقم لا يُعاد: الفاتورة التالية 00002
    const next = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    expect(next.invoiceNo).toBe(`INV-${new Date().getUTCFullYear()}-00002`);
  });

  test('إلغاء شراء نقدي: عكس الحركة والصندوق والرصيد يعود صفراً', async () => {
    const { db, seed } = await seededDb();
    const res = await saveInvoice(
      db,
      {
        docType: 'purchase',
        payStatus: 'cash',
        issuedAt: TODAY,
        supplierId: seed.supplierId,
        cashboxId: seed.cashboxId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [milkLine('10', '100', { productId: seed.milkId })],
      },
    );
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('10.000');
    const prod = await db.all<{ cost_price: string }>('SELECT cost_price FROM product WHERE id = ?', [seed.milkId]);
    expect(prod[0]!.cost_price).toBe('100.0000'); // WAC من الشراء
    await voidInvoice(db, res.invoiceId);
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('0.000');
    const rev = await db.all<{ tx_type: string; amount: string }>(
      'SELECT tx_type, amount FROM cash_tx WHERE ref_type = ? AND ref_id = ?',
      ['invoice_void', res.invoiceId],
    );
    expect(rev.length).toBe(1);
    expect(rev[0]!.tx_type).toBe('receipt'); // عكس payment
    expect(rev[0]!.amount).toBe('1000.0000');
  });

  test('إلغاء مسودة → خطأ حالة', async () => {
    const { db, seed } = await seededDb();
    const draft = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { status: 'draft' }),
    );
    await expect(voidInvoice(db, draft.invoiceId)).rejects.toThrow('مسودة');
  });

  test('إلغاء ملغاة سابقاً → خطأ حالة', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const res = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    await voidInvoice(db, res.invoiceId);
    await expect(voidInvoice(db, res.invoiceId)).rejects.toThrow('ملغاة سابقاً');
  });

  test('إلغاء فاتورة لها مرتجع مرتبط → «ألغِ المرتجع أولاً» (FR-02-15)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const sale = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    await createLinkedReturn(
      db,
      linkedReturnInput(seed, sale.invoiceId, [milkLine('1', '115', { productId: seed.milkId })]),
    );
    await expect(voidInvoice(db, sale.invoiceId)).rejects.toThrow('ألغِ المرتجع أولاً');
  });
});

/* ==================== المرتجع المرتبط (FR-02-07/08 + AC-02/AC-21) ==================== */

describe('createLinkedReturn — مرتجع البيع', () => {
  test('AC-02: مرتجع كامل لبيع آجل: الكمية تعاد بتكلفة line_cost الأصلية والرصيد والWAC لا يتغيران', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const sale = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('8.000');
    const ret = await createLinkedReturn(
      db,
      linkedReturnInput(seed, sale.invoiceId, [milkLine('2', '115', { productId: seed.milkId })]),
    );
    expect(ret.invoiceNo).toBe(`SRN-${new Date().getUTCFullYear()}-00001`);
    const retInv = await invoiceRow(db, ret.invoiceId);
    expect(retInv!.doc_type).toBe('sale_return');
    expect(retInv!.pay_status).toBe('credit'); // اتجاه الحساب
    expect(retInv!.original_invoice_id).toBe(sale.invoiceId);
    expect(retInv!.total).toBe('230.0000');
    expect(retInv!.cost_total).toBe('180.0000'); // بتكلفة الأصل (لا WAC الجاري)
    // الكمية عادت بتكلفة line_cost الأصلية (Snapshot 5.4-3)
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('10.000');
    const mvs = await movementsFor(db, 'invoice', ret.invoiceId);
    expect(mvs.length).toBe(1);
    expect(mvs[0]!.movement_type).toBe('sale_return');
    expect(mvs[0]!.qty).toBe('2.000');
    expect(mvs[0]!.unit_cost).toBe('90.0000'); // line_cost الأصلي للوحدة
    // WAC لم يتغير بمرتجع البيع
    const prod = await db.all<{ cost_price: string }>('SELECT cost_price FROM product WHERE id = ?', [seed.milkId]);
    expect(prod[0]!.cost_price).toBe('90.0000');
    // اتجاه الحساب: لا صندوق
    const cash = await cashFor(db, 'invoice', ret.invoiceId);
    expect(cash.length).toBe(0);
  });

  test('AC-21: مرتجع يتجاوز المتبقي → رفض بالكمية القابلة للإرجاع + مرتجعان جزئيان لا يتجاوزان', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const sale = await saveInvoice(
      db,
      saleInput(seed, [milkLine('5', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    // تجاوز (6 > 5) → رفض
    await expect(
      createLinkedReturn(
        db,
        linkedReturnInput(seed, sale.invoiceId, [milkLine('6', '115', { productId: seed.milkId })]),
      ),
    ).rejects.toThrow('تتجاوز المتبقي القابل للإرجاع (5.000)');
    // مرتجع جزئي 2
    const r1 = await createLinkedReturn(
      db,
      linkedReturnInput(seed, sale.invoiceId, [milkLine('2', '115', { productId: seed.milkId })]),
    );
    expect(r1.invoiceNo).toBe(`SRN-${new Date().getUTCFullYear()}-00001`);
    // 4 > المتبقي 3 → رفض
    await expect(
      createLinkedReturn(
        db,
        linkedReturnInput(seed, sale.invoiceId, [milkLine('4', '115', { productId: seed.milkId })]),
      ),
    ).rejects.toThrow('تتجاوز المتبقي القابل للإرجاع (3.000)');
    // 3 = المتبقي بالضبط → نجاح
    const r2 = await createLinkedReturn(
      db,
      linkedReturnInput(seed, sale.invoiceId, [milkLine('3', '115', { productId: seed.milkId })]),
    );
    expect(r2.invoiceNo).toBe(`SRN-${new Date().getUTCFullYear()}-00002`);
    // المتبقي الآن صفر — أي مرتجع آخر يُرفض
    await expect(
      createLinkedReturn(
        db,
        linkedReturnInput(seed, sale.invoiceId, [milkLine('1', '115', { productId: seed.milkId })]),
      ),
    ).rejects.toThrow('المتبقي القابل للإرجاع (0.000)');
  });

  test('مرتجع لفاتورة ملغاة/مسودة → «لا يمكن المرتجع لفاتورة ملغاة أو مسودة»', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const sale = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    await voidInvoice(db, sale.invoiceId);
    await expect(
      createLinkedReturn(
        db,
        linkedReturnInput(seed, sale.invoiceId, [milkLine('1', '115', { productId: seed.milkId })]),
      ),
    ).rejects.toThrow('لا يمكن المرتجع لفاتورة ملغاة أو مسودة');
    const draft = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { status: 'draft' }),
    );
    await expect(
      createLinkedReturn(
        db,
        linkedReturnInput(seed, draft.invoiceId, [milkLine('1', '115', { productId: seed.milkId })]),
      ),
    ).rejects.toThrow('لا يمكن المرتجع لفاتورة ملغاة أو مسودة');
  });

  test('مرتجع بيع نقدي الاتجاه: صرف للعميل من الصندوق', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const sale = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], {
        payStatus: 'cash',
        cashboxId: seed.cashboxId,
      }),
    );
    const ret = await createLinkedReturn(
      db,
      linkedReturnInput(seed, sale.invoiceId, [milkLine('1', '115', { productId: seed.milkId })], {
        returnPayDirection: 'cash',
        cashboxId: seed.cashboxId,
      }),
    );
    const retInv = await invoiceRow(db, ret.invoiceId);
    expect(retInv!.pay_status).toBe('cash');
    expect(retInv!.paid_amount).toBe('115.0000');
    const cash = await cashFor(db, 'invoice', ret.invoiceId);
    expect(cash.length).toBe(1);
    expect(cash[0]!.tx_type).toBe('payment'); // خروج نقدي للعميل
    expect(cash[0]!.amount).toBe('115.0000');
    expect(cash[0]!.description).toContain('إرجاع نقدي');
  });
});

describe('createLinkedReturn — مرتجع الشراء (FR-02-08)', () => {
  test('AC-03: شراء SAR بخصم رأس 10% → التكلفة الفعلية موزّعة pro-rata وتخزن بالعملة الأساسية بسعر اليوم', async () => {
    const { db, seed } = await seededDb();
    await upsertDailyRate(db, seed.sarId, TODAY, '530');
    const res = await saveInvoice(
      db,
      {
        docType: 'purchase',
        payStatus: 'credit',
        issuedAt: TODAY,
        supplierId: seed.supplierId,
        warehouseId: seed.warehouseId,
        currencyId: seed.sarId,
        lines: [milkLine('10', '100', { productId: seed.milkId })],
        discountAmount: '100', // خصم رأس 10% — يوزَّع قبل WAC (5.4-3)
      },
    );
    expect(res.invoiceNo).toBe(`PUR-${new Date().getUTCFullYear()}-00001`);
    const inv = await invoiceRow(db, res.invoiceId);
    expect(inv!.total).toBe('900.0000'); // 1000 − 100
    expect(inv!.total_base).toBe('477000.0000'); // 900 × 530
    expect(inv!.rate_is_fallback).toBe(0);
    expect(inv!.exchange_rate).toBe('530.000000');
    // WAC = 90 SAR/وحدة × 530 = 47700 أساس (لا 100×530 — الخصم وُزِّع)
    const prod = await db.all<{ cost_price: string }>('SELECT cost_price FROM product WHERE id = ?', [seed.milkId]);
    expect(prod[0]!.cost_price).toBe('47700.0000');
    const mvs = await movementsFor(db, 'invoice', res.invoiceId);
    expect(mvs[0]!.qty).toBe('10.000');
    expect(mvs[0]!.unit_cost).toBe('47700.0000');
    const items = await db.all<{ line_cost: string }>('SELECT line_cost FROM invoice_item WHERE invoice_id = ?', [res.invoiceId]);
    expect(items[0]!.line_cost).toBe('477000.0000');
  });

  test('توزيع الخصم pro-rata بين بنود بقيم مختلفة (5.4-3 حرفياً)', async () => {
    const { db, seed } = await seededDb();
    // بندان: 10@100 (1000) و5@60 (300) — خصم رأس 130 → الحصص 100 و30
    const res = await saveInvoice(
      db,
      {
        docType: 'purchase',
        payStatus: 'credit',
        issuedAt: TODAY,
        supplierId: seed.supplierId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [
          milkLine('10', '100', { productId: seed.milkId }),
          milkLine('5', '60', { productId: seed.milkId }),
        ],
        discountAmount: '130',
      },
    );
    const items = await db.all<{ qty: string; line_cost: string }>(
      'SELECT qty, line_cost FROM invoice_item WHERE invoice_id = ? ORDER BY id',
      [res.invoiceId],
    );
    // البند الأول: (1000−100)=900؛ الثاني: (300−30)=270
    expect(items[0]!.line_cost).toBe('900.0000');
    expect(items[1]!.line_cost).toBe('270.0000');
    // WAC = (900 + 270)/15 = 78
    const prod = await db.all<{ cost_price: string }>('SELECT cost_price FROM product WHERE id = ?', [seed.milkId]);
    expect(prod[0]!.cost_price).toBe('78.0000');
  });

  test('مرتجع شراء: يخرج بسعر حركة الشراء الأصلية ويعاد حساب WAC على المتبقي', async () => {
    const { db, seed } = await seededDb();
    // شراء أول 10@100 ثم ثانٍ 10@130 → WAC = (10×100+10×130)/20 = 115 ومستوى 20
    const p1 = await saveInvoice(
      db,
      {
        docType: 'purchase',
        payStatus: 'credit',
        issuedAt: TODAY,
        supplierId: seed.supplierId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [milkLine('10', '100', { productId: seed.milkId })],
      },
    );
    await saveInvoice(
      db,
      {
        docType: 'purchase',
        payStatus: 'credit',
        issuedAt: TODAY,
        supplierId: seed.supplierId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [milkLine('10', '130', { productId: seed.milkId })],
      },
    );
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('20.000');
    // مرتجع 5 من فاتورة الشراء الأولى (Snapshot 100):
    // newWac = (20×115 − 5×100)/(20−5) = 1800/15 = 120 — يطابق المتقي المتبقي (10@130 + 5@100)/15
    const ret = await createLinkedReturn(
      db,
      {
        docType: 'purchase_return',
        originalInvoiceId: p1.invoiceId,
        issuedAt: TODAY,
        returnPayDirection: 'account',
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [milkLine('5', '100', { productId: seed.milkId })],
      },
    );
    expect(ret.invoiceNo).toBe(`PRN-${new Date().getUTCFullYear()}-00001`);
    expect((await getStockLevel(db, seed.milkId, seed.warehouseId)).toFixed(3)).toBe('15.000');
    const prod = await db.all<{ cost_price: string }>('SELECT cost_price FROM product WHERE id = ?', [seed.milkId]);
    expect(prod[0]!.cost_price).toBe('120.0000');
    const mvs = await movementsFor(db, 'invoice', ret.invoiceId);
    expect(mvs[0]!.movement_type).toBe('purchase_return');
    expect(mvs[0]!.qty).toBe('-5.000');
    expect(mvs[0]!.unit_cost).toBe('100.0000'); // سعر حركة الشراء الأصلية (Snapshot)
    // اتجاه الحساب: لا صندوق
    const cash = await cashFor(db, 'invoice', ret.invoiceId);
    expect(cash.length).toBe(0);
  });

  test('مرتجع شراء نقدي الاتجاه: قبض من المورّد', async () => {
    const { db, seed } = await seededDb();
    const p1 = await saveInvoice(
      db,
      {
        docType: 'purchase',
        payStatus: 'cash',
        issuedAt: TODAY,
        supplierId: seed.supplierId,
        cashboxId: seed.cashboxId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [milkLine('10', '100', { productId: seed.milkId })],
      },
    );
    const ret = await createLinkedReturn(
      db,
      {
        docType: 'purchase_return',
        originalInvoiceId: p1.invoiceId,
        issuedAt: TODAY,
        returnPayDirection: 'cash',
        cashboxId: seed.cashboxId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [milkLine('2', '100', { productId: seed.milkId })],
      },
    );
    const cash = await cashFor(db, 'invoice', ret.invoiceId);
    expect(cash.length).toBe(1);
    expect(cash[0]!.tx_type).toBe('receipt'); // استرداد من المورّد
    expect(cash[0]!.amount).toBe('200.0000');
    expect(cash[0]!.description).toContain('استرداد نقدي');
  });
});

/* ==================== AC-20 + الذرّية ==================== */

describe('AC-20 — بيع يتجاوز المتاح: رفض كامل بلا أي أثر', () => {
  test('NegativeStockError باسم الصنف + لا مستند ولا حركات ولا رقم مستهلك', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed, '5', '90');
    let err: unknown;
    try {
      await saveInvoice(
        db,
        saleInput(seed, [milkLine('8', '115', { productId: seed.milkId })], {
          payStatus: 'cash',
          cashboxId: seed.cashboxId,
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NegativeStockError);
    expect((err as Error).message).toContain('حليب المراعي');
    expect((err as Error).message).toContain('النقص 3.000');
    // لا أثر إطلاقاً (AC-09أ)
    const invRows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM invoice');
    expect(Number(invRows[0]!.n)).toBe(0);
    const mvRows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM stock_movement WHERE ref_type = ?', ['invoice']);
    expect(Number(mvRows[0]!.n)).toBe(0);
    const cashRows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM cash_tx');
    expect(Number(cashRows[0]!.n)).toBe(0);
    const seqRows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM doc_sequence');
    expect(Number(seqRows[0]!.n)).toBe(0);
    // الرقم لم يستهلك — الفاتورة التالية 00001
    const next = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    expect(next.invoiceNo).toBe(`INV-${new Date().getUTCFullYear()}-00001`);
  });
});

/* ==================== الخصومات والضريبة (FR-02-04/05) ==================== */

describe('الخصومات والضريبة — computeInvoiceTotals (نقية)', () => {
  test('FR-02-05: خصم يجعل الصافي ≤ 0 → ValidationError عربية', () => {
    expect(() =>
      computeInvoiceTotals(
        { lines: [milkLine('2', '115', { productId: 1 })], discountAmount: '300' },
        'on_total',
        '0',
      ),
    ).toThrow('صافي الفاتورة بعد الخصم لا يمكن أن يكون صفراً أو أقل');
  });

  test('خصم البند نسبة + مبلغ معاً ويُقيد بقيمة البند + خصم الرأس', () => {
    const t = computeInvoiceTotals(
      {
        lines: [
          { productId: 1, lineDesc: undefined, qty: '3', unitPrice: '100', discountPercent: '10', discountAmount: '20' },
        ],
        discountAmount: '50',
      },
      'on_total',
      '0',
    );
    // gross 300، خصم البند 30+20=50، صافي 250، خصم الرأس 50 → 200
    expect(t.lines[0]!.lineGross.toFixed(4)).toBe('300.0000');
    expect(t.lines[0]!.lineDiscount.toFixed(4)).toBe('50.0000');
    expect(t.lines[0]!.lineNet.toFixed(4)).toBe('250.0000');
    expect(t.subtotal.toFixed(4)).toBe('300.0000');
    expect(t.taxableBase.toFixed(4)).toBe('200.0000');
    expect(t.total.toFixed(4)).toBe('200.0000');
  });

  test('خصم البند الأكبر من قيمته يُقيد بقيمة البند (لا سالب)', () => {
    const t = computeInvoiceTotals(
      {
        lines: [
          { productId: 1, lineDesc: undefined, qty: '1', unitPrice: '100', discountPercent: '50', discountAmount: '80' },
          { productId: 2, lineDesc: undefined, qty: '1', unitPrice: '100' },
        ],
      },
      'on_total',
      '0',
    );
    expect(t.lines[0]!.lineDiscount.toFixed(4)).toBe('100.0000'); // مقيد
    expect(t.lines[0]!.lineNet.toFixed(4)).toBe('0.0000');
    expect(t.taxableBase.toFixed(4)).toBe('100.0000');
  });

  test('الضريبة على الإجمالي (on_total): بنسبة الشركة أو نسبة صريحة', () => {
    const t = computeInvoiceTotals(
      { lines: [{ productId: 1, lineDesc: undefined, qty: '2', unitPrice: '100' }] },
      'on_total',
      '5',
    );
    expect(t.taxAmount.toFixed(4)).toBe('10.0000');
    expect(t.total.toFixed(4)).toBe('210.0000');
    const t2 = computeInvoiceTotals(
      { lines: [{ productId: 1, lineDesc: undefined, qty: '2', unitPrice: '100' }], taxRate: '10' },
      'on_total',
      '5',
    );
    expect(t2.taxRate.toFixed(4)).toBe('10.0000');
    expect(t2.total.toFixed(4)).toBe('220.0000');
  });

  test('الضريبة لكل بند (per_item): على صافي كل بند بنسبته — والمخزنة بالنسبة الصحيحة', () => {
    const t = computeInvoiceTotals(
      {
        lines: [
          { productId: 1, lineDesc: undefined, qty: '2', unitPrice: '100', taxPercent: '5' },
          { productId: 2, lineDesc: undefined, qty: '1', unitPrice: '100', taxPercent: '5' },
        ],
      },
      'per_item',
      '0',
    );
    // صافي 300 + ض 5% = 15
    expect(t.taxAmount.toFixed(4)).toBe('15.0000');
    expect(t.total.toFixed(4)).toBe('315.0000');
    expect(t.lines[0]!.lineTax.toFixed(4)).toBe('10.0000');
    expect(t.lines[0]!.lineTotal.toFixed(4)).toBe('210.0000');
  });

  test('وضع الضريبة من الإعدادات يغير حساب الفاتورة المحفوظة (invoicing.tax_mode)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await setSetting(db, 'invoicing.tax_mode', 'per_item');
    const res = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId, taxPercent: '5' })], {
        payStatus: 'cash',
        cashboxId: seed.cashboxId,
      }),
    );
    const inv = await invoiceRow(db, res.invoiceId);
    expect(inv!.tax_amount).toBe('11.5000'); // 230 × 5%
    expect(inv!.total).toBe('241.5000');
  });

  test('distributeInvoiceDiscount: الأسهم جمعها = الخصم بالضبط (فرق التقريب على الأخير)', () => {
    const lines = [
      { productId: 1, lineDesc: undefined, qty: '1', unitPrice: '100' },
      { productId: 2, lineDesc: undefined, qty: '1', unitPrice: '100' },
      { productId: 3, lineDesc: undefined, qty: '1', unitPrice: '100.0001' },
    ];
    const t = computeInvoiceTotals({ lines }, 'on_total', '0');
    const shares = distributeInvoiceDiscount(t.lines, '100');
    const sum = shares.reduce((a, b) => a.plus(b), d('0'));
    expect(sum.toFixed(4)).toBe('100.0000');
  });
});

/* ==================== الترقيم والفشل الذرّي (5.4-1) ==================== */

describe('الترقيم (ملحق د)', () => {
  test('صيغة PREFIX-YYYY-NNNNN وعدادات مستقلة لكل نوع', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed, '20', '90');
    const s1 = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    const p1 = await saveInvoice(
      db,
      {
        docType: 'purchase',
        payStatus: 'credit',
        issuedAt: TODAY,
        supplierId: seed.supplierId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [milkLine('5', '100', { productId: seed.milkId })],
      },
    );
    const r1 = await createLinkedReturn(
      db,
      linkedReturnInput(seed, s1.invoiceId, [milkLine('1', '115', { productId: seed.milkId })]),
    );
    const year = new Date().getUTCFullYear();
    expect(s1.invoiceNo).toBe(`INV-${year}-00001`);
    expect(p1.invoiceNo).toBe(`PUR-${year}-00001`);
    expect(r1.invoiceNo).toBe(`SRN-${year}-00001`);
    const s2 = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    expect(s2.invoiceNo).toBe(`INV-${year}-00002`);
  });

  test('فشل المعاملة يرجع الرقم معها: صنف غير موجود → الرقم التالي متسلسل', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [{ productId: 999, lineDesc: undefined, qty: '1', unitPrice: '100' }], {
          payStatus: 'credit',
        }),
      ),
    ).rejects.toThrow('صنف غير موجود');
    const ok = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    expect(ok.invoiceNo).toBe(`INV-${new Date().getUTCFullYear()}-00001`);
  });

  test('saveInvoice بنوع مرتجع → توجيه إلى createLinkedReturn', async () => {
    const { db, seed } = await seededDb();
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], {
          docType: 'sale_return',
          originalInvoiceId: 1,
        }),
      ),
    ).rejects.toThrow('createLinkedReturn');
  });
});

/* ==================== الحرس الزمني (5.4-11 / AC-16) ==================== */

describe('التأريخ والفترات (FR-02-19)', () => {
  test('AC-16: رجعي 45 يوماً بلا تأكيد → BackdateConfirmationRequiredError', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], {
          issuedAt: daysAgoISO(45),
          payStatus: 'credit',
        }),
      ),
    ).rejects.toBeInstanceOf(BackdateConfirmationRequiredError);
  });

  test('AC-16: مع تأكيد المدير → حفظ + قيد audit «backdate»', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await db.run(
      'INSERT INTO app_user (id, username, display_name, role, created_at, updated_at) VALUES (7, ?, ?, ?, ?, ?)',
      ['m7', 'مدير', 'admin', new Date().toISOString(), new Date().toISOString()],
    );
    const res = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], {
        issuedAt: daysAgoISO(45),
        payStatus: 'credit',
      }),
      { confirmBackdate: true, createdBy: 7 },
    );
    const aud = await db.all<{ action: string; entity_id: number; user_id: number }>(
      'SELECT action, entity_id, user_id FROM audit_log WHERE action = ? AND entity_id = ?',
      ['backdate', res.invoiceId],
    );
    expect(aud.length).toBe(1);
    expect(Number(aud[0]!.user_id)).toBe(7);
  });

  test('تاريخ داخل سنة مغلقة → رفض قاطع (FiscalPeriodClosedError)', async () => {
    const { db, seed } = await seededDb();
    const year = new Date().getUTCFullYear();
    await db.run(
      'INSERT INTO fiscal_year (year, start_date, end_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [year, `${year}-01-01`, `${year}-12-31`, 'closed', new Date().toISOString(), new Date().toISOString()],
    );
    await openMilk(db, seed);
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
      ),
    ).rejects.toBeInstanceOf(FiscalPeriodClosedError);
  });

  test('رجعي 45 يوماً داخل سنة مغلقة → رفض الفترة أولاً (قاطع بلا تأكيد)', async () => {
    const { db, seed } = await seededDb();
    const old = daysAgoISO(45);
    const year = Number(old.slice(0, 4));
    await db.run(
      'INSERT INTO fiscal_year (year, start_date, end_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [year, `${year}-01-01`, `${year}-12-31`, 'closed', new Date().toISOString(), new Date().toISOString()],
    );
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], {
          issuedAt: old,
          payStatus: 'credit',
        }),
      ),
    ).rejects.toBeInstanceOf(FiscalPeriodClosedError);
  });
});

/* ==================== الخدمات والسطور الحرة (قرار 5 / FR-01-16) ==================== */

describe('الخدمات والسطور الحرة', () => {
  test('سطر خدمة صنف + سطر حر بلا صنف: بلا حركات مخزون وتُحسب في الإجمالي', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const res = await saveInvoice(
      db,
      saleInput(seed, [
        milkLine('2', '115', { productId: seed.milkId }),
        milkLine('1', '25', { productId: seed.deliveryId }),
        { productId: null, lineDesc: 'خدمة توصيل سريع', qty: '1', unitPrice: '15' },
      ], { payStatus: 'cash', cashboxId: seed.cashboxId }),
    );
    const inv = await invoiceRow(db, res.invoiceId);
    expect(inv!.total).toBe('270.0000');
    // حركة واحدة فقط (للحليب)
    const mvs = await movementsFor(db, 'invoice', res.invoiceId);
    expect(mvs.length).toBe(1);
    const items = await db.all<{ product_id: number | null; line_desc: string | null }>(
      'SELECT product_id, line_desc FROM invoice_item WHERE invoice_id = ? ORDER BY id',
      [res.invoiceId],
    );
    expect(items.length).toBe(3);
    expect(items[2]!.product_id).toBeNull();
    expect(items[2]!.line_desc).toBe('خدمة توصيل سريع');
  });

  test('سطر حر بلا وصف → رفض زود', async () => {
    const { db, seed } = await seededDb();
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [{ productId: null, qty: '1', unitPrice: '10' }], { payStatus: 'credit' }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('شراء بسطر خدمي: بلا حركة مخزون له وبلا تكلفة', async () => {
    const { db, seed } = await seededDb();
    await saveInvoice(
      db,
      {
        docType: 'purchase',
        payStatus: 'credit',
        issuedAt: TODAY,
        supplierId: seed.supplierId,
        warehouseId: seed.warehouseId,
        currencyId: seed.yerId,
        lines: [milkLine('10', '100', { productId: seed.milkId }), milkLine('1', '50', { productId: seed.deliveryId })],
      },
    );
    const mvs = await db.all<{ product_id: number }>(
      'SELECT product_id FROM stock_movement WHERE ref_type = ?',
      ['invoice'],
    );
    expect(mvs.length).toBe(1); // الحليب فقط
    expect(Number(mvs[0]!.product_id)).toBe(seed.milkId);
  });
});

/* ==================== لقطة سعر الصرف (FR-08-05/02-20) ==================== */

describe('لقطة سعر الصرف على المستند', () => {
  test('سياسة last_known بلا سعر اليوم: المخزن آخر سعر + rate_is_fallback=1', async () => {
    const { db, seed } = await seededDb();
    await setSetting(db, 'fx.fallback', 'last_known');
    await upsertDailyRate(db, seed.sarId, daysAgoISO(3), '530');
    await openMilk(db, seed);
    const res = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '2', { productId: seed.milkId })], {
        payStatus: 'cash',
        cashboxId: seed.cashboxId,
        currencyId: seed.sarId,
      }),
    );
    const inv = await invoiceRow(db, res.invoiceId);
    expect(inv!.exchange_rate).toBe('530.000000');
    expect(Number(inv!.rate_is_fallback)).toBe(1); // شارة «سعر صرف تقديري»
    expect(inv!.total_base).toBe('1060.0000'); // 2 SAR × 530
  });

  test('AC-13: بلا سعر إطلاقاً والسياسة off → الحفظ ممنوع (MissingRateError) وبلا أي أثر', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [milkLine('1', '2', { productId: seed.milkId })], {
          payStatus: 'cash',
          cashboxId: seed.cashboxId,
          currencyId: seed.sarId,
        }),
      ),
    ).rejects.toThrow('لا يوجد سعر صرف لليوم');
    const invRows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM invoice');
    expect(Number(invRows[0]!.n)).toBe(0);
  });
});

/* ==================== حذف المسودة والقراءة ==================== */

describe('deleteDraft + getInvoiceWithItems', () => {
  test('حذف المسودة: صفوف البنود والفاتورة تُحذف؛ المكتملة لا تُحذف', async () => {
    const { db, seed } = await seededDb();
    const draft = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { status: 'draft' }),
    );
    await deleteDraft(db, draft.invoiceId);
    const invRows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM invoice');
    expect(Number(invRows[0]!.n)).toBe(0);
    const itemRows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM invoice_item');
    expect(Number(itemRows[0]!.n)).toBe(0);
    await openMilk(db, seed);
    const done = await saveInvoice(
      db,
      saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    await expect(deleteDraft(db, done.invoiceId)).rejects.toBeInstanceOf(InvoiceStateError);
  });

  test('getInvoiceWithItems يعيد الفاتورة وبنودها', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const res = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    const got = await getInvoiceWithItems(db, res.invoiceId);
    expect(got.invoice.invoice_no).toBe(res.invoiceNo);
    expect(got.items.length).toBe(1);
    expect(got.items[0]!.qty).toBe('2.000');
    expect(got.items[0]!.unit_price).toBe('115.0000');
  });
});

/* ==================== تحقق مدخلات عام ==================== */

describe('تحقق زود للمدخلات', () => {
  test('بنود فارغة → «بنداً واحداً على الأقل»', async () => {
    const { db, seed } = await seededDb();
    await expect(saveInvoice(db, saleInput(seed, []))).rejects.toThrow('بنداً واحداً');
  });

  test('كمية سالبة → رفض', async () => {
    const { db, seed } = await seededDb();
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [{ productId: seed.milkId, qty: '-1', unitPrice: '100' }]),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('عميل غير موجود → رسالة عربية', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [milkLine('1', '115', { productId: seed.milkId })], { customerId: 999 }),
      ),
    ).rejects.toThrow('العميل غير موجود');
    void seed;
  });

  test('نسبة خصم > 100 → رفض', async () => {
    const { db, seed } = await seededDb();
    await expect(
      saveInvoice(
        db,
        saleInput(seed, [milkLine('1', '115', { productId: seed.milkId, discountPercent: '150' })]),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('عملة المرتجع تخالف الأصل → رفض (قرار 8)', async () => {
    const { db, seed } = await seededDb();
    await openMilk(db, seed);
    const sale = await saveInvoice(
      db,
      saleInput(seed, [milkLine('2', '115', { productId: seed.milkId })], { payStatus: 'credit' }),
    );
    await upsertDailyRate(db, seed.sarId, TODAY, '530');
    await expect(
      createLinkedReturn(
        db,
        linkedReturnInput(seed, sale.invoiceId, [milkLine('1', '115', { productId: seed.milkId })], {
          currencyId: seed.sarId,
        }),
      ),
    ).rejects.toBeInstanceOf(DomainRuleError);
  });
});
