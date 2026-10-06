/**
 * posting-map.test.ts — خريطة الترحيل الملزمة (ملحق و — قرار 7 / FR-09-02).
 *
 * اختبار وحدة لكل صف من صفوف جدول ملحق و كما تفرضها القاعدة 5.4-8:
 * «لكل نوع حركة اختبار وحدة يطابق الجدول». لكل صف نثبّت:
 *  1) الحسابين المشاركين (الزوج الملزم) واتجاههما مدين/دائن،
 *  2) البند الذي يغذيه في قائمة الأرباح (أو لا شيء للأصول/التسويات)،
 *  3) تغذية FX عند وجود فرق صرف محقق.
 * + الأنواع الإضافية المشتقة بالمنطق نفسه (موثقة في bindingNote).
 */
import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_NATURE,
  PNL_FEED_EFFECT,
  POSTING_ACCOUNTS,
  POSTING_MAP,
  postCashTx,
  postChequeEvent,
  postInvoiceDoc,
  postStockMovement,
  type PostingAccount,
  type PostingClassification,
} from '../posting-map';

/** صف الخريطة بالمفتاح — يفشل الاختبار صراحة إن غاب المفتاح */
function mapRow(key: string) {
  const row = POSTING_MAP.find((r) => r.key === key);
  if (!row) throw new Error(`صف الخريطة مفقود: ${key}`);
  return row;
}

/** زوج الحسابات المشاركين في الترحيل (غير مرتب — للتحقق من الزوج الملزم) */
function pair(c: PostingClassification): PostingAccount[] {
  return [c.debit, c.credit].filter((x): x is PostingAccount => x !== null);
}

describe('POSTING_MAP — البنية الملزمة', () => {
  test('الحسابات التسعة حصراً (CASH/AR/AP/INV/COGS/EXP/EQ/FX/CHQ) وكل حساب بطبيعته', () => {
    expect(POSTING_ACCOUNTS).toHaveLength(9);
    for (const acc of POSTING_ACCOUNTS) {
      expect(ACCOUNT_NATURE[acc].length).toBeGreaterThan(3);
    }
  });

  test('كل صف يشارك حسابات من التسعة فقط (أو لا أحد لبيع مكتمل)', () => {
    for (const row of POSTING_MAP) {
      for (const acc of [row.debit, row.credit]) {
        if (acc !== null) {
          expect(POSTING_ACCOUNTS).toContain(acc);
        }
      }
    }
  });
});

describe('جدول ملحق و — صفٌ صفٌ (الترحيل + بند الأرباح)', () => {
  test('بيع مكتمل: يُقاس مباشرة من الفواتير — لا سطر ترحيل — يغذي المبيعات (+)', () => {
    const c = postInvoiceDoc('sale');
    expect(c.debit).toBeNull();
    expect(c.credit).toBeNull();
    expect(c.pnlFeed).toBe('sales');
    expect(PNL_FEED_EFFECT.sales).toBe('add');
    expect(c.row.key).toBe('sale_completed');
  });

  test('مرتجع بيع: INV ← COGS — مرتجع المبيعات (−) من المستند ويخصم COGS بتكلفة line_cost من الحركة', () => {
    const c = postStockMovement({ movementType: 'sale_return' });
    expect(c.debit).toBe('INV');
    expect(c.credit).toBe('COGS');
    // الجانب التكلفي للحركة: تكلفة المرتجع التي تُخصم من COGS (PNL_FEED_EFFECT=add)
    expect(c.pnlFeed).toBe('returnsCost');
    expect(PNL_FEED_EFFECT.returnsCost).toBe('add');
    // الجانب الإيرادي من صف المستند: مرتجع المبيعات (−)
    const inv = postInvoiceDoc('sale_return');
    expect([inv.debit, inv.credit]).toEqual(['INV', 'COGS']);
    expect(inv.pnlFeed).toBe('salesReturns');
    expect(PNL_FEED_EFFECT.salesReturns).toBe('subtract');
  });

  test('حركة مخزون بيع: INV → COGS — يغذي COGS (+)', () => {
    const c = postStockMovement({ movementType: 'sale' });
    expect(c.debit).toBe('COGS');
    expect(c.credit).toBe('INV');
    expect(c.pnlFeed).toBe('cogs');
    expect(PNL_FEED_EFFECT.cogs).toBe('subtract'); // تُخصم من الربح
  });

  test('شراء نقدي: CASH → INV — أصل، لا بند أرباح', () => {
    const c = postStockMovement({ movementType: 'purchase', purchasePayStatus: 'cash' });
    expect(pair(c).sort()).toEqual(['CASH', 'INV'].sort());
    expect(c.debit).toBe('INV');
    expect(c.credit).toBe('CASH');
    expect(c.pnlFeed).toBeNull();
    expect(mapRow('purchase_cash').bindingNote).toContain('أصل');
  });

  test('شراء آجل: AP → INV — أصل، لا بند أرباح', () => {
    const c = postStockMovement({ movementType: 'purchase', purchasePayStatus: 'credit' });
    expect(pair(c).sort()).toEqual(['AP', 'INV'].sort());
    expect(c.debit).toBe('INV');
    expect(c.credit).toBe('AP');
    expect(c.pnlFeed).toBeNull();
    const inv = postInvoiceDoc('purchase', { payStatus: 'credit' });
    expect([inv.debit, inv.credit]).toEqual(['INV', 'AP']);
  });

  test('مرتجع شراء: INV → CASH/AP — أصل، لا بند أرباح (نقدي CASH / آجل AP)', () => {
    const cash = postStockMovement({ movementType: 'purchase_return', purchaseReturnPayStatus: 'cash' });
    expect(pair(cash).sort()).toEqual(['CASH', 'INV'].sort());
    expect(cash.pnlFeed).toBeNull();
    const credit = postStockMovement({ movementType: 'purchase_return', purchaseReturnPayStatus: 'credit' });
    expect(pair(credit).sort()).toEqual(['AP', 'INV'].sort());
    expect(credit.pnlFeed).toBeNull();
  });

  test('تسوية جرد — زيادة: (adjustment) → INV — زيادة جرد (+)', () => {
    const c = postStockMovement({ movementType: 'stocktake_adjust', qty: '2' });
    expect(c.debit).toBe('INV');
    expect(c.credit).toBeNull();
    expect(c.pnlFeed).toBe('stockSurplus');
    expect(PNL_FEED_EFFECT.stockSurplus).toBe('add');
  });

  test('تسوية جرد — عجز: INV → (adjustment) — عجز جرد (−)', () => {
    const c = postStockMovement({ movementType: 'stocktake_adjust', qty: '-1' });
    expect(c.debit).toBeNull();
    expect(c.credit).toBe('INV');
    expect(c.pnlFeed).toBe('stockShortage');
    expect(PNL_FEED_EFFECT.stockShortage).toBe('subtract');
  });

  test('مصروف: CASH → EXP — مصاريف (−) شاملة الرواتب', () => {
    const c = postCashTx({ txType: 'expense' });
    expect(c.debit).toBe('EXP');
    expect(c.credit).toBe('CASH');
    expect(c.pnlFeed).toBe('expenses');
    expect(PNL_FEED_EFFECT.expenses).toBe('subtract');
  });

  test('مسحوبات مالك: CASH → EQ — بند مستقل خارج المصاريف', () => {
    const c = postCashTx({ txType: 'owner_draw' });
    expect(pair(c).sort()).toEqual(['CASH', 'EQ'].sort());
    expect(c.debit).toBe('EQ'); // المسحوبات تخصم من حقوق المالك
    expect(c.pnlFeed).toBe('ownerDraw');
    expect(PNL_FEED_EFFECT.ownerDraw).toBe('separate'); // خارج المصاريف حصراً
  });

  test('إيداع مالك (رأس مال): CASH → EQ — سطر رأس المال في حركة الشركة، ليس بند أرباح', () => {
    const c = postCashTx({ txType: 'capital_in' });
    expect(pair(c).sort()).toEqual(['CASH', 'EQ'].sort());
    expect(c.debit).toBe('CASH'); // الإيداع يزيد الصندوق وحقوق المالك
    expect(c.pnlFeed).toBeNull();
    expect(c.fxFeed).toBe(false);
  });

  test('قبض تحصيل من عميل: AR → CASH — تسوية دين ليست إيراداً', () => {
    const c = postCashTx({ txType: 'receipt' });
    expect(c.debit).toBe('CASH');
    expect(c.credit).toBe('AR');
    expect(c.pnlFeed).toBeNull();
    expect(c.fxFeed).toBe(false); // بلا فرق صرف
  });

  test('صرف دفع لمورد: AP → CASH — تسوية دين', () => {
    const c = postCashTx({ txType: 'payment' });
    expect(c.debit).toBe('AP');
    expect(c.credit).toBe('CASH');
    expect(c.pnlFeed).toBeNull();
    expect(c.fxFeed).toBe(false);
  });

  test('تسوية بعملة مختلفة: FX — فروق صرف ± (fx_gain_loss غير صفري يفعّل البند)', () => {
    const gain = postCashTx({ txType: 'receipt', fxGainLoss: '30000' });
    expect(gain.fxFeed).toBe(true);
    const loss = postCashTx({ txType: 'payment', fxGainLoss: '-500' });
    expect(loss.fxFeed).toBe(true);
    expect(PNL_FEED_EFFECT.fxGainLoss).toBe('signed');
    const row = mapRow('fx_settlement');
    expect([row.debit, row.credit]).toEqual(['FX', 'FX']);
    expect(row.pnlFeed).toBe('fxGainLoss');
  });

  test('تحويل بين صندوقين بعملتين: CASH → CASH + FX للفرق — فروق صرف ±', () => {
    const noFx = postCashTx({ txType: 'box_transfer' });
    expect(noFx.debit).toBe('CASH');
    expect(noFx.credit).toBe('CASH');
    expect(noFx.pnlFeed).toBeNull();
    expect(noFx.fxFeed).toBe(false); // نفس العملة: لا فرق
    const withFx = postCashTx({ txType: 'box_transfer', fxGainLoss: '-26500' });
    expect(withFx.fxFeed).toBe(true);
    expect(withFx.pnlFeed).toBeNull(); // الفرق يغذي بند FX المستقل لا البند الأصلي
  });

  test('استلام شيك وارد: AR → CHQ — حتى التحصيل، لا بند أرباح', () => {
    const c = postChequeEvent('in', 'pending');
    expect(c.debit).toBe('CHQ');
    expect(c.credit).toBe('AR');
    expect(c.pnlFeed).toBeNull();
    const deposited = postChequeEvent('in', 'deposited');
    expect(deposited.pnlFeed).toBeNull(); // deposited لا يزال تحت التحصيل
  });

  test('تحصيل شيك وارد (cleared): CHQ → CASH (+FX إن لزم) — ليس إيراداً', () => {
    const c = postChequeEvent('in', 'cleared');
    expect(c.debit).toBe('CASH');
    expect(c.credit).toBe('CHQ');
    expect(c.pnlFeed).toBeNull();
    expect(c.fxFeed).toBe(true); // FX إن لزم
  });

  test('ارتداد شيك وارد (bounced): CHQ → AR + CASH → EXP للرسم — مصاريف (−) للرسم فقط', () => {
    const c = postChequeEvent('in', 'bounced');
    expect(c.debit).toBe('AR');
    expect(c.credit).toBe('CHQ');
    expect(c.pnlFeed).toBe('expenses'); // الرسم فقط يغذي المصاريف
    const row = mapRow('cheque_in_bounced');
    expect(row.bindingNote).toContain('للرسم');
  });

  test('إصدار شيك صادر: CHQ → AP — حتى الصرف، لا بند أرباح', () => {
    const c = postChequeEvent('out', 'pending');
    expect(pair(c).sort()).toEqual(['AP', 'CHQ'].sort());
    expect(c.pnlFeed).toBeNull();
    const deposited = postChequeEvent('out', 'deposited');
    expect(deposited.pnlFeed).toBeNull();
  });

  test('صرف شيك صادر (cleared): CASH → CHQ — ليس مصروفاً', () => {
    const c = postChequeEvent('out', 'cleared');
    expect(c.debit).toBe('CHQ');
    expect(c.credit).toBe('CASH');
    expect(c.pnlFeed).toBeNull();
    expect(c.fxFeed).toBe(false);
  });
});

describe('الأنواع الإضافية (منطق DDL الموثق نفسه)', () => {
  test('حركة opening: أصل INV بلا أرباح — وtransfer_in/out: INV→INV بلا أرباح', () => {
    for (const movementType of ['opening', 'transfer_in', 'transfer_out'] as const) {
      const c = postStockMovement({ movementType });
      expect(c.pnlFeed).toBeNull();
      expect(pair(c).every((a) => a === 'INV')).toBe(true);
    }
  });

  test('تسوية يدوية manual_adjust: زيادة (+) / عجز (−) حسب إشارة الكمية', () => {
    const up = postStockMovement({ movementType: 'manual_adjust', qty: '3' });
    expect(up.pnlFeed).toBe('stockSurplus');
    const down = postStockMovement({ movementType: 'manual_adjust', qty: '-2' });
    expect(down.pnlFeed).toBe('stockShortage');
  });

  test('نقدية opening/bank_deposit/bank_withdraw: أصول وتنقّل داخلي بلا أرباح', () => {
    const opening = postCashTx({ txType: 'opening' });
    expect(pair(opening).sort()).toEqual(['CASH', 'EQ'].sort());
    expect(opening.pnlFeed).toBeNull();
    for (const txType of ['bank_deposit', 'bank_withdraw'] as const) {
      const c = postCashTx({ txType });
      expect(c.debit).toBe('CASH');
      expect(c.credit).toBe('CASH');
      expect(c.pnlFeed).toBeNull();
    }
  });

  test('سلفة موظف CASH→AR ليست مصروفاً — والعمولة/مسير الرواتب EXP (قرار 7)', () => {
    const advance = postCashTx({ txType: 'employee_advance' });
    expect(advance.debit).toBe('AR');
    expect(advance.pnlFeed).toBeNull();
    for (const txType of ['commission_payout', 'salary_batch'] as const) {
      const c = postCashTx({ txType });
      expect(c.debit).toBe('EXP');
      expect(c.pnlFeed).toBe('expenses');
    }
  });

  test('نوع غير معروف: لا حسابات ولا بند أرباح (حارس خارج الخريطة)', () => {
    const unknownCash = postCashTx({ txType: 'magic' });
    expect(unknownCash.debit).toBeNull();
    expect(unknownCash.pnlFeed).toBeNull();
    const unknownMove = postStockMovement({ movementType: 'magic' });
    expect(unknownMove.credit).toBeNull();
    expect(unknownMove.pnlFeed).toBeNull();
  });

  test('شراء مختلط: الشطر النقدي CASH (والآجل AP) — زوج INV/CASH أو INV/AP', () => {
    const mixed = postStockMovement({ movementType: 'purchase', purchasePayStatus: 'mixed' });
    expect(mixed.debit).toBe('INV');
    expect(mixed.credit).toBe('CASH'); // الشطر النقدي — التوثيق في bindingNote
    const inv = postInvoiceDoc('purchase', { payStatus: 'mixed' });
    expect(inv.credit).toBe('CASH');
  });
});
