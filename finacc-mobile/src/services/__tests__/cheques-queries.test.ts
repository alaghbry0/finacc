/**
 * cheques-queries.test.ts — استعلامات قراءة الشيكات (Task 12 — FR-14):
 *
 * القسم التكاملي فوق القاعدة الحقيقية (bun:sqlite في الذاكرة):
 *  - listCheques: الترتيب بتاريخ الاستحقاق تصاعدياً + ضم اسم الطرف حسب
 *    نوعه (عميل/مورّد) ورمز العملة + الفلاتر (اتجاه/حالة/طرف/نافذة
 *    استحقاق بالحية فقط).
 *  - getChequeById: الضمات الكاملة — الفاتورة المرجعية (رقمها وعائلتها)
 *    وحركة التحصيل بعد cleared (رقم السند RVT-/PMT- والتاريخ والصندوق).
 *  - fetchAlerts عبر loadDashboard: عدّاد الشيكات المرتدة (FR-14-04).
 */
import { describe, expect, test } from 'bun:test';
import {
  bounceCheque,
  clearCheque,
  depositCheque,
  recordCheque,
  voidCheque,
} from '../../domain/cheques';
import { saveInvoice } from '../../domain/invoicing';
import { recordOpeningStock } from '../../domain/inventory';
import { getChequeById, listCheques, loadDashboard } from '../../db/queries';
import { daysAgoISO, seededDb } from '../../domain/__tests__/seed';
import { d } from '../../utils/money';

const TODAY = daysAgoISO(0);

interface ChequeSeedInput {
  direction?: 'in' | 'out';
  amount?: string;
  dueInDays?: number;
  chequeNo?: string;
  /** تاريخ الإصدار قبل N يوماً (لخلق شيك متأخر قانونياً: إصدار واستحقاق في الماضي) */
  issueDaysAgo?: number;
}

/** شيك وارد أساسي بالأساس (YER) */
async function chequeIn(
  db: Parameters<typeof recordCheque>[0],
  seed: Parameters<typeof recordCheque>[0] extends never ? never : { customerId: number; yerId: number },
  input: ChequeSeedInput = {},
) {
  return recordCheque(db, {
    direction: input.direction ?? 'in',
    partyId: seed.customerId,
    chequeNo: input.chequeNo ?? 'CHQ-A1',
    amount: input.amount ?? '500',
    currencyId: seed.yerId,
    exchangeRate: '1',
    issueDate: daysAgoISO(input.issueDaysAgo ?? 0),
    dueDate: daysAgoISO(-(input.dueInDays ?? 30)),
  });
}

describe('listCheques — قائمة الشيكات (FR-14-05)', () => {
  test('مرتبة بتاريخ الاستحقاق تصاعدياً مع اسم الطرف ورمز العملة', async () => {
    const { db, seed } = await seededDb();
    const later = await chequeIn(db, seed, { dueInDays: 40, chequeNo: 'CHQ-LATER' });
    const sooner = await chequeIn(db, seed, { dueInDays: 5, chequeNo: 'CHQ-SOON' });
    const rows = await listCheques(db);
    expect(rows.map((r) => r.chequeNo)).toEqual(['CHQ-SOON', 'CHQ-LATER']);
    const first = rows[0]!;
    expect(first.id).toBe(sooner.chequeId);
    expect(first.partyName).toBe('أحمد'); // ضم اسم العميل
    expect(first.partyType).toBe('customer');
    expect(first.currencyCode).toBe('YER');
    expect(first.status).toBe('pending');
    void later;
  });

  test('اسم المورّد يُضم للصادرة (party_type=supplier)', async () => {
    const { db, seed } = await seededDb();
    await recordCheque(db, {
      direction: 'out',
      partyId: seed.supplierId,
      chequeNo: 'CHQ-OUT1',
      amount: '300',
      currencyId: seed.yerId,
      exchangeRate: '1',
      issueDate: TODAY,
      dueDate: daysAgoISO(-20),
    });
    const rows = await listCheques(db, { direction: 'out' });
    expect(rows.length).toBe(1);
    expect(rows[0]!.partyName).toBe('مورد النور');
    expect(rows[0]!.partyType).toBe('supplier');
  });

  test('فلاتر الحالة والطرف تعمل (pending فقط / طرف بعينه)', async () => {
    const { db, seed } = await seededDb();
    const live = await chequeIn(db, seed, { chequeNo: 'CHQ-LIVE' });
    const dead = await chequeIn(db, seed, { chequeNo: 'CHQ-DEAD' });
    await voidCheque(db, dead.chequeId);
    const pendingRows = await listCheques(db, { status: 'pending' });
    expect(pendingRows.map((r) => r.chequeNo)).toEqual(['CHQ-LIVE']);
    const voidRows = await listCheques(db, { status: 'void' });
    expect(voidRows.map((r) => r.chequeNo)).toEqual(['CHQ-DEAD']);
    const byParty = await listCheques(db, { partyType: 'customer', partyId: seed.customerId });
    expect(byParty.length).toBe(2);
    void live;
  });

  test('dueWithinDays: الحية المستحقة داخل النافذة فقط', async () => {
    const { db, seed } = await seededDb();
    await chequeIn(db, seed, { dueInDays: 3, chequeNo: 'CHQ-IN-WINDOW' });
    await chequeIn(db, seed, { dueInDays: 30, chequeNo: 'CHQ-OUTSIDE' });
    // متأخر قانونياً: صدر قبل 10 أيام واستحق قبل يومين (الاستحقاق ≥ الإصدار)
    const overdue = await chequeIn(db, seed, {
      dueInDays: -2,
      issueDaysAgo: 10,
      chequeNo: 'CHQ-PAST',
    });
    const cleared = await chequeIn(db, seed, { dueInDays: 1, chequeNo: 'CHQ-DONE' });
    await clearCheque(db, cleared.chequeId, { cashboxId: seed.cashboxId });
    const rows = await listCheques(db, { dueWithinDays: 7 });
    // الماضي خارج النافذة (متأخر لا «قريب») والمحصَّل ليس حياً
    expect(rows.map((r) => r.chequeNo)).toEqual(['CHQ-IN-WINDOW']);
    void overdue;
  });
});

describe('getChequeById — تفاصيل الشيك (ضمات كاملة)', () => {
  test('بلا ضمات لاحقة: الحقول الأساسية + null للمرجع والحركة', async () => {
    const { db, seed } = await seededDb();
    const res = await chequeIn(db, seed, { chequeNo: 'CHQ-PLAIN' });
    const row = await getChequeById(db, res.chequeId);
    expect(row).not.toBeNull();
    expect(row!.chequeNo).toBe('CHQ-PLAIN');
    expect(row!.refInvoiceId).toBeNull();
    expect(row!.refInvoiceNo).toBeNull();
    expect(row!.clearedCashTxId).toBeNull();
    expect(row!.clearedVoucherNo).toBeNull();
  });

  test('cleared: فاتورة مرجعية + حركة التحصيل برقم السند والصندوق', async () => {
    const { db, seed } = await seededDb();
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('100'),
      unitCost: d('90'),
      movedAt: daysAgoISO(12),
    });
    const inv = await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'credit',
      issuedAt: daysAgoISO(4),
      customerId: seed.customerId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '1', unitPrice: '230' }],
    });
    const res = await recordCheque(db, {
      direction: 'in',
      partyId: seed.customerId,
      chequeNo: 'CHQ-LINKED',
      amount: '230',
      currencyId: seed.yerId,
      exchangeRate: '1',
      issueDate: TODAY,
      dueDate: daysAgoISO(-10),
      refInvoiceId: inv.invoiceId,
    });
    await depositCheque(db, res.chequeId);
    await clearCheque(db, res.chequeId, { cashboxId: seed.cashboxId });

    const row = await getChequeById(db, res.chequeId);
    expect(row!.status).toBe('cleared');
    expect(row!.refInvoiceId).toBe(inv.invoiceId);
    expect(row!.refInvoiceNo).toBe(inv.invoiceNo);
    expect(row!.refInvoiceDocType).toBe('sale');
    expect(row!.refInvoiceTotal).toBe('230.0000');
    expect(row!.clearedCashTxId).not.toBeNull();
    expect(row!.clearedVoucherNo).toMatch(/^RVT-\d{4}-\d{5}$/);
    expect(row!.clearedTxType).toBe('receipt');
    expect(row!.clearedTxDate).toBe(TODAY);
    expect(row!.clearedTxAmount).toBe('230.0000');
    expect(row!.clearedCashboxName).toBe('الصندوق الرئيسي');
  });

  test('bounced: bouncedAt/bounceFee + لا حركة تحصيل', async () => {
    const { db, seed } = await seededDb();
    const res = await chequeIn(db, seed, { chequeNo: 'CHQ-BAD' });
    await bounceCheque(db, res.chequeId, {});
    const row = await getChequeById(db, res.chequeId);
    expect(row!.status).toBe('bounced');
    expect(row!.bouncedAt).toBe(TODAY);
    expect(row!.bounceFee).toBe('0.0000');
    expect(row!.clearedCashTxId).toBeNull();
  });

  test('غير موجود → null', async () => {
    const { db } = await seededDb();
    expect(await getChequeById(db, 99999)).toBeNull();
  });
});

describe('loadDashboard — عدّاد الشيكات المرتدة (FR-14-04)', () => {
  test('bouncedCheques يعدّ المرتدة فقط (لا تتأثر بالحية/الملغاة)', async () => {
    const { db, seed } = await seededDb();
    const before = await loadDashboard(db);
    expect(before.alerts.bouncedCheques).toBe(0);

    const b1 = await chequeIn(db, seed, { chequeNo: 'CHQ-B1' });
    const b2 = await chequeIn(db, seed, { chequeNo: 'CHQ-B2' });
    await bounceCheque(db, b1.chequeId, {});
    await bounceCheque(db, b2.chequeId, {});
    // الحية داخل نافذة الأسبوع (الافتراضي 30 يوم خارجها)
    const live = await chequeIn(db, seed, { dueInDays: 5, chequeNo: 'CHQ-LIVE2' });
    void live;

    const after = await loadDashboard(db);
    expect(after.alerts.bouncedCheques).toBe(2);
    expect(after.alerts.chequesDueSoon).toBe(1); // الحية فقط داخل الأسبوع
  });
});
