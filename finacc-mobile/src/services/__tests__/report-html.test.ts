/**
 * report-html.test.ts — اختبارات ورقة تقرير الأرباح والخسائر (Task 13 — FR-09-02/10).
 *
 * القسم النقي: بناء الورقة (buildPnlHtml) بعينة بيانات — الاتجاه RTL وعرض
 * 420px، الرأس والعنوان، نص الفترة، المقاطع المجمّعة (الإيرادات/التكلفة/
 * الجرد/المصاريف/الفروق) بإشارات +/− غير لونية (DS-18)، الربح بصندوق مُبرز،
 * مسحوبات المالك بمقطع مستقل خارج المصاريف، «صافي ما بقي للمالك» بالصندوق
 * الختامي بتسميته الصادقة، تذييل «مشتق حصراً من خريطة الترحيل — ملحق و»،
 * طابع «وُلِّدت»، التهريب، وحالة الصفر المتوازنة. + رسالة الواتساب المختصرة
 * (شكلها وخطوطها الختامية وحالة الخسارة/التوازن).
 * القسم التكاملي: القاعدة → سيناريو حي → loadPnlPrintData → الورقة بأرقام
 * القاعدة وعملة الأساس.
 */
import { describe, expect, test } from 'bun:test';
import { buildPnlHtml } from '../report-html';
import { loadPnlPrintData, reportPeriodText, type PnlPrintData } from '../report-data';
import { buildPnlWhatsAppMessage } from '../report-share';
import { recordOpeningStock } from '../../domain/inventory';
import { saveInvoice } from '../../domain/invoicing';
import { recordExpense, recordOwnerTx } from '../../domain/cash';
import { daysAgoISO, seededDb } from '../../domain/__tests__/seed';
import { d } from '../../utils/money';
import type { PnlReport } from '../../domain/reports';

const TODAY = daysAgoISO(0);

/** عينة قائمة الأرباح — نفس أرقام السيناريو اليدوي في reports.test.ts */
function samplePnl(overrides: Partial<PnlReport> = {}): PnlReport {
  return {
    period: { from: '2026-09-26', to: '2026-10-06' },
    sales: '53830.0000',
    salesReturns: '115.0000',
    netSales: '53715.0000',
    cogs: '270.0000',
    returnsCost: '90.0000',
    netCogs: '180.0000',
    stockSurplus: '180.0000',
    stockShortage: '90.0000',
    expenses: '10760.0000',
    fxGainLoss: '2954.0000',
    profit: '45819.0000',
    ownerDraw: '200.0000',
    netRemainingToOwner: '45619.0000',
    ...overrides,
  };
}

function samplePrintData(overrides: Partial<PnlPrintData> = {}): PnlPrintData {
  return {
    company: { name: 'متجر النور', phone: '712345678', footerText: 'شكراً لتعاملكم معنا' },
    currency: { code: 'YER', decimals: 0 },
    period: {
      from: '2026-09-26',
      to: '2026-10-06',
      text: 'من السبت 26 سبتمبر 2026 حتى الثلاثاء 06 أكتوبر 2026',
    },
    pnl: samplePnl(),
    generatedAt: '2026-10-06T10:20:00.000Z',
    ...overrides,
  };
}

describe('buildPnlHtml — ورقة تقرير الأرباح النقية', () => {
  test('مستند RTL عربي كامل: DOCTYPE وlang=ar وdir=rtl وcharset', () => {
    const html = buildPnlHtml(samplePrintData());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('<meta charset="utf-8">');
  });

  test('عرض الورقة 420px مثل الكشف والفاتورة', () => {
    const html = buildPnlHtml(samplePrintData());
    expect(html).toContain('width: 420px');
  });

  test('الرأس: المنشأة والهاتف + عنوان «تقرير الأرباح والخسائر» + الفترة وعملة الأساس', () => {
    const html = buildPnlHtml(samplePrintData());
    expect(html).toContain('متجر النور');
    expect(html).toContain('هاتف: 712345678');
    expect(html).toContain('تقرير الأرباح والخسائر');
    expect(html).toContain('من السبت 26 سبتمبر 2026 حتى الثلاثاء 06 أكتوبر 2026');
    expect(html).toContain('YER');
  });

  test('المقاطع المجمّعة: الإيرادات/تكلفة المبيعات/تسويات الجرد/المصاريف/فروق الصرف', () => {
    const html = buildPnlHtml(samplePrintData());
    for (const section of [
      'الإيرادات',
      'تكلفة المبيعات',
      'تسويات الجرد',
      'المصاريف',
      'فروق الصرف المحققة',
    ]) {
      expect(html).toContain(section);
    }
  });

  test('البنود بإشاراتها غير اللونية (DS-18): المبيعات + والمرتجع − والمصاريف − والفروق ±', () => {
    const html = buildPnlHtml(samplePrintData());
    expect(html).toContain('+53,830'); // المبيعات
    expect(html).toContain('−115'); // مرتجع المبيعات
    expect(html).toContain('−10,760'); // المصاريف
    expect(html).toContain('+2,954'); // فروق الصرف (ربح)
    expect(html).toContain('−90'); // تكلفة المرتجع/عجز الجرد
  });

  test('المجاميع الفرعية: صافي المبيعات وصافي التكلفة بحد علوي عريض', () => {
    const html = buildPnlHtml(samplePrintData());
    expect(html).toContain('صافي المبيعات');
    expect(html).toContain('53,715');
    expect(html).toContain('صافي التكلفة');
    expect(html).toContain('180');
    expect(html).toContain('subtotal');
  });

  test('الربح بصندوق مُبرز (grand) بقيمته 45,819 بعملة الأساس', () => {
    const html = buildPnlHtml(samplePrintData());
    expect(html).toContain('الربح');
    expect(html).toContain('45,819');
    expect(html).toContain('YER');
    expect(html).toContain('class="grand"');
  });

  test('مسحوبات المالك بمقطع مستقل خارج المصاريف + توثيق «بند مستقل»', () => {
    const html = buildPnlHtml(samplePrintData());
    expect(html).toContain('مسحوبات المالك');
    expect(html).toContain('−200');
    expect(html).toContain('بند مستقل خارج المصاريف');
    // المسحوبات بعد صندوق الربح لا داخل مقطع المصاريف
    expect(html.indexOf('class="grand"')).toBeLessThan(html.indexOf('مسحوبات المالك'));
  });

  test('«صافي ما بقي للمالك» بالصندوق الختامي الأبرز (final) بتسميته الصادقة', () => {
    const html = buildPnlHtml(samplePrintData());
    expect(html).toContain('صافي ما بقي للمالك');
    expect(html).toContain('45,619');
    expect(html).toContain('class="final"');
    expect(html).toContain('الربح بعد المسحوبات — ليس ربح العملية نفسها');
  });

  test('التذييل: ملاحظة الصيغة + «مشتق حصراً من خريطة الترحيل — ملحق و» + طابع وُلِّدت', () => {
    const html = buildPnlHtml(samplePrintData());
    expect(html).toContain('الصيغة المصححة (قرار 7)');
    expect(html).toContain('مشتق حصراً من خريطة الترحيل — ملحق و');
    expect(html).toContain('طُبعت بواسطة المُحاسِب الشخصي');
    expect(html).toContain('شكراً لتعاملكم معنا');
    expect(html).toMatch(/وُلِّدت|06 أكتوبر 2026/);
    expect(html).toContain('10:20');
  });

  test('التهريب: اسم منشأة بحقن HTML يظهر مهرباً ولا سكربت ينفذ', () => {
    const html = buildPnlHtml(
      samplePrintData({ company: { name: '<script>alert(1)</script>&"', phone: null, footerText: 'سلام <b>غامق</b>' } }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>غامق</b>');
  });

  test('حالة الصفر المتوازنة: كل البنود 0 والصيغة سليمة بلا إشارات زائفة', () => {
    const zero = samplePnl({
      sales: '0.0000',
      salesReturns: '0.0000',
      netSales: '0.0000',
      cogs: '0.0000',
      returnsCost: '0.0000',
      netCogs: '0.0000',
      stockSurplus: '0.0000',
      stockShortage: '0.0000',
      expenses: '0.0000',
      fxGainLoss: '0.0000',
      profit: '0.0000',
      ownerDraw: '0.0000',
      netRemainingToOwner: '0.0000',
    });
    const html = buildPnlHtml(samplePrintData({ pnl: zero }));
    expect(html).toContain('>0<');
    expect(html).not.toContain('+0');
    expect(html).not.toContain('−0');
    expect(html).toContain('صافي ما بقي للمالك');
  });

  test('خسارة: الربح السالب يظهر بإشارة − (علامة غير لونية)', () => {
    const html = buildPnlHtml(
      samplePrintData({
        pnl: samplePnl({
          profit: '-120.0000',
          netRemainingToOwner: '-320.0000',
          fxGainLoss: '-500.0000',
        }),
      }),
    );
    expect(html).toContain('−120');
    expect(html).toContain('−320');
    expect(html).toContain('−500');
  });
});

describe('reportPeriodText — نص الفترة', () => {
  test('«من <تاريخ عربي> حتى <تاريخ عربي>»', () => {
    const text = reportPeriodText('2026-01-01', '2026-10-06');
    expect(text.startsWith('من ')).toBe(true);
    expect(text).toContain(' حتى ');
    expect(text).toContain('01 يناير 2026');
    expect(text).toContain('06 أكتوبر 2026');
  });
});

describe('buildPnlWhatsAppMessage — رسالة الواتساب المختصرة', () => {
  test('الشكل: العنوان بالمنشأة + الفترة والعملة + البنود السبعة + تذييل التطبيق', () => {
    const msg = buildPnlWhatsAppMessage(samplePrintData());
    const lines = msg.split('\n');
    expect(lines[0]).toBe('تقرير الأرباح والخسائر — متجر النور');
    expect(msg).toContain('الفترة: من السبت 26 سبتمبر 2026 حتى الثلاثاء 06 أكتوبر 2026');
    expect(msg).toContain('العملة: YER');
    expect(msg).toContain('صافي المبيعات: 53,715 ر.ي');
    expect(msg).toContain('صافي التكلفة: 180 ر.ي');
    expect(msg).toContain('المصاريف: −10,760 ر.ي');
    expect(msg).toContain('فروق الصرف: +2,954 ر.ي');
    expect(msg).toContain('الربح: 45,819 ر.ي');
    expect(msg).toContain('مسحوبات المالك: −200 ر.ي');
    expect(msg).toContain('صافي ما بقي للمالك: 45,619 ر.ي');
    expect(lines[lines.length - 1]).toBe('المُحاسِب الشخصي');
    // ترتيب الختاميين: الربح ثم المسحوبات ثم صافي ما بقي
    expect(msg.indexOf('الربح:')).toBeLessThan(msg.indexOf('مسحوبات المالك:'));
    expect(msg.indexOf('مسحوبات المالك:')).toBeLessThan(msg.indexOf('صافي ما بقي للمالك:'));
  });

  test('متوازنة صفرية: الأصفار بلا إشارات زائفة والتذييل حاضر', () => {
    const zero = samplePnl({
      sales: '0.0000',
      salesReturns: '0.0000',
      netSales: '0.0000',
      cogs: '0.0000',
      returnsCost: '0.0000',
      netCogs: '0.0000',
      stockSurplus: '0.0000',
      stockShortage: '0.0000',
      expenses: '0.0000',
      fxGainLoss: '0.0000',
      profit: '0.0000',
      ownerDraw: '0.0000',
      netRemainingToOwner: '0.0000',
    });
    const msg = buildPnlWhatsAppMessage(samplePrintData({ pnl: zero }));
    expect(msg).toContain('الربح: 0 ر.ي');
    expect(msg).toContain('صافي ما بقي للمالك: 0 ر.ي');
    expect(msg).not.toContain('+0');
    expect(msg).not.toContain('−0');
  });

  test('خسارة: الربح وصافي ما بقي بإشارة − والفروق سالبة', () => {
    const msg = buildPnlWhatsAppMessage(
      samplePrintData({
        pnl: samplePnl({
          profit: '-900.0000',
          netRemainingToOwner: '-1100.0000',
          fxGainLoss: '-46.0000',
        }),
      }),
    );
    expect(msg).toContain('الربح: −900 ر.ي');
    expect(msg).toContain('صافي ما بقي للمالك: −1,100 ر.ي');
    expect(msg).toContain('فروق الصرف: −46 ر.ي');
  });
});

describe('التكامل: القاعدة → loadPnlPrintData → الورقة', () => {
  test('سيناريو حي: فاتورة + مصروف + مسحوبات → أرقام القاعدة بعملة الأساس في القالب', async () => {
    const { db, seed } = await seededDb();
    const from = daysAgoISO(5);
    await recordOpeningStock(db, {
      productId: seed.milkId,
      warehouseId: seed.warehouseId,
      qty: d('50'),
      unitCost: d('90'),
      movedAt: daysAgoISO(6),
    });
    // بيع نقدي: 2 حليب @ 115 = 230 (COGS 180)
    await saveInvoice(db, {
      docType: 'sale',
      payStatus: 'cash',
      issuedAt: daysAgoISO(4),
      customerId: seed.customerId,
      cashboxId: seed.cashboxId,
      warehouseId: seed.warehouseId,
      currencyId: seed.yerId,
      lines: [{ productId: seed.milkId, qty: '2', unitPrice: '115' }],
    });
    // مصروف 60 + مسحوبات 40
    const now = new Date().toISOString();
    const cat = await db.all<{ id: number }>(
      `INSERT INTO expense_category (name, is_archived, created_at, updated_at)
       VALUES ('عام', 0, ?, ?) RETURNING id`,
      [now, now],
    );
    await recordExpense(db, {
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '60',
      exchangeRate: '1',
      txDate: daysAgoISO(3),
      expenseCategoryId: Number(cat[0]!.id),
    });
    await recordOwnerTx(db, {
      txKind: 'owner_draw',
      cashboxId: seed.cashboxId,
      currencyId: seed.yerId,
      amount: '40',
      exchangeRate: '1',
      txDate: daysAgoISO(2),
    });

    const data = await loadPnlPrintData(db, { from, to: TODAY });
    expect(data.currency.code).toBe('YER');
    expect(data.company.name).toBe('متجر الاختبار');
    expect(data.pnl.sales).toBe('230.0000');
    expect(data.pnl.cogs).toBe('180.0000');
    expect(data.pnl.expenses).toBe('60.0000');
    expect(data.pnl.profit).toBe('-10.0000'); // 230 − 180 − 60
    expect(data.pnl.netRemainingToOwner).toBe('-50.0000'); // −10 − 40

    const html = buildPnlHtml(data);
    expect(html).toContain('متجر الاختبار');
    expect(html).toContain('230');
    expect(html).toContain('−10');
    expect(html).toContain('−50');
    expect(html).toContain('مشتق حصراً من خريطة الترحيل — ملحق و');
    // رسالة الواتساب بأرقام القاعدة نفسها
    const msg = buildPnlWhatsAppMessage(data);
    expect(msg).toContain('الربح: −10 ر.ي');
    expect(msg).toContain('صافي ما بقي للمالك: −50 ر.ي');
  });
});
