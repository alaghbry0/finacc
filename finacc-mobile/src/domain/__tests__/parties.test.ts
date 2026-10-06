/**
 * parties.test.ts — العملاء والموردون: حد الائتمان ثلاثي الحالات (FR-03-01) +
 * الرصيد الافتتاحي بعملته وسعره (قرار 7/قرار 3) + الحذف/الأرشفة (FR-03-09).
 */
import { describe, expect, test } from 'bun:test';
import {
  archiveCustomer,
  createCustomer,
  createSupplier,
  deleteCustomer,
  getCustomer,
  getSupplier,
  listCustomers,
  updateCustomer,
} from '../parties';
import { DomainRuleError, MissingRateError } from '../errors';
import { seededDb, todayISO } from './seed';

async function seedSarRate(db: Parameters<typeof createCustomer>[0], sarId: number) {
  await db.run(
    `INSERT INTO exchange_rate (currency_id, rate_date, rate, source, created_at)
     VALUES (?, ?, '56.25', 'manual', ?)`,
    [sarId, todayISO(), new Date().toISOString()],
  );
}

describe('حد الائتمان — ثلاثي الحالات حرفياً (FR-03-01)', () => {
  test('undefined/null/\"\" → NULL (بلا حد)؛ \"0\" → منع الآجل؛ قيمة → حد f4', async () => {
    const { db } = await seededDb();
    const a = await createCustomer(db, { name: 'بلا حد صريح' }); // undefined
    const b = await createCustomer(db, { name: 'منع الآجل', creditLimit: '0' });
    const c = await createCustomer(db, { name: 'حد 500', creditLimit: '500' });
    const d = await createCustomer(db, { name: 'فارغ', creditLimit: '' });
    const e = await createCustomer(db, { name: 'null صريح', creditLimit: null });
    expect((await getCustomer(db, a.id))!.creditLimit).toBeNull();
    expect((await getCustomer(db, b.id))!.creditLimit).toBe('0.0000');
    expect((await getCustomer(db, c.id))!.creditLimit).toBe('500.0000');
    expect((await getCustomer(db, d.id))!.creditLimit).toBeNull();
    expect((await getCustomer(db, e.id))!.creditLimit).toBeNull();
  });

  test('التعديل: undefined = إبقاء الحالي؛ null = بلا حد؛ \"0\" = منع الآجل', async () => {
    const { db } = await seededDb();
    const p = await createCustomer(db, { name: 'حد متغير', creditLimit: '300' });
    await updateCustomer(db, p.id, { name: 'حد متغير' }); // undefined → يبقى 300
    expect((await getCustomer(db, p.id))!.creditLimit).toBe('300.0000');
    await updateCustomer(db, p.id, { name: 'حد متغير', creditLimit: null });
    expect((await getCustomer(db, p.id))!.creditLimit).toBeNull();
    await updateCustomer(db, p.id, { name: 'حد متغير', creditLimit: '0' });
    expect((await getCustomer(db, p.id))!.creditLimit).toBe('0.0000');
  });

  test('قيمة سالبة → رفض زود عربي', async () => {
    const { db } = await seededDb();
    let err: unknown;
    try {
      await createCustomer(db, { name: 'سالب', creditLimit: '-5' });
    } catch (e) {
      err = e;
    }
    expect((err as DomainRuleError).name).toBe('ValidationError');
    expect((err as DomainRuleError).message).toContain('العميل');
  });
});

describe('الرصيد الافتتاحي بعملته وسعره وتاريخه (قرار 7 + قرار 3)', () => {
  test('بالعملة الأساسية → سعر 1 بلا صف سعر؛ بـ SAR → سعر اليوم المحلول', async () => {
    const { db, seed } = await seededDb();
    await seedSarRate(db, seed.sarId);
    const a = await createCustomer(db, { name: 'مدين أساسي', openingBalance: '1000' });
    const b = await createCustomer(db, {
      name: 'مدين بالسعودي',
      openingBalance: '100',
      openingCurrencyId: seed.sarId,
    });
    const ra = await getCustomer(db, a.id);
    expect(ra!.openingBalance).toBe('1000.0000');
    expect(ra!.openingRate).toBe('1.000000');
    expect(ra!.openingCurrencyId).toBe(seed.yerId);
    const rb = await getCustomer(db, b.id);
    expect(rb!.openingBalance).toBe('100.0000');
    expect(rb!.openingRate).toBe('56.250000');
    expect(rb!.openingCurrencyId).toBe(seed.sarId);
    expect(rb!.openingDate).toBe(todayISO());
  });

  test('SAR بلا سعر لليوم → MissingRateError (لا يُحفظ بسعر 1 أبداً — قرار 3)', async () => {
    const { db, seed } = await seededDb(); // بلا سعر
    let err: unknown;
    try {
      await createCustomer(db, {
        name: 'بلا سعر',
        openingBalance: '50',
        openingCurrencyId: seed.sarId,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingRateError);
    // لم يُنشأ أي عميل
    const rows = await db.all('SELECT id FROM customer WHERE name = ?', ['بلا سعر']);
    expect(rows.length).toBe(0);
  });

  test('المورد: موجب = دائن — يُخزَّن بنفس البنية', async () => {
    const { db, seed } = await seededDb();
    await seedSarRate(db, seed.sarId);
    const s = await createSupplier(db, {
      name: 'مورد بدين',
      openingBalance: '250',
      openingCurrencyId: seed.sarId,
    });
    const row = await getSupplier(db, s.id);
    expect(row!.openingBalance).toBe('250.0000');
    expect(row!.openingRate).toBe('56.250000');
    expect(row!.openingCurrencyId).toBe(seed.sarId);
  });
});

describe('الحذف والأرشفة (FR-03-09)', () => {
  test('الحذف محجوب مع فواتير/نقدية — رسالة «أرشفه بدلاً من الحذف»، والأرشفة هي المسار الناجح', async () => {
    const { db, seed } = await seededDb();
    const c = await createCustomer(db, { name: 'عميل له فاتورة' });
    await db.run(
      `INSERT INTO invoice (doc_type, pay_status, status, issued_at, customer_id, warehouse_id,
         currency_id, exchange_rate, total, created_at, updated_at)
       VALUES ('sale', 'cash', 'completed', ?, ?, ?, ?, '1', '100', ?, ?)`,
      [
        todayISO(),
        c.id,
        seed.warehouseId,
        seed.yerId,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    let err: unknown;
    try {
      await deleteCustomer(db, c.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainRuleError);
    expect((err as DomainRuleError).code).toBe('CUSTOMER_HAS_MOVEMENTS');
    expect((err as DomainRuleError).message).toContain('أرشفه بدلاً من الحذف');
    // البديل الآمن يعمل (هذا هو مسار FR-03-09)
    await archiveCustomer(db, c.id);
    const row = await getCustomer(db, c.id);
    expect(row!.isArchived).toBe(true);
  });

  test('عميل نظيف تماماً → الحذف يمر', async () => {
    const { db } = await seededDb();
    const c = await createCustomer(db, { name: 'نظيف' });
    await deleteCustomer(db, c.id);
    expect(await getCustomer(db, c.id)).toBeNull();
  });
});

describe('listCustomers — البحث', () => {
  test('LIKE بالاسم والهاتف + إخفاء المؤرشف', async () => {
    const { db } = await seededDb();
    await createCustomer(db, { name: 'عبدالله محمد', phone: '777123456' });
    await createCustomer(db, { name: 'سالم عبدالله', phone: '733999888' });
    const byName = await listCustomers(db, { search: 'عبدالله' });
    expect(byName.length).toBe(2);
    const byPhone = await listCustomers(db, { search: '733' });
    expect(byPhone.length).toBe(1);
    expect(byPhone[0]!.name).toBe('سالم عبدالله');
    // مؤرشف يختفي من النشطة ويظهر مع onlyActive=false
    const arch = await createCustomer(db, { name: 'عبدالله القديم' });
    await archiveCustomer(db, arch.id);
    const active = await listCustomers(db, { search: 'عبدالله' });
    expect(active.length).toBe(2);
    const all = await listCustomers(db, { search: 'عبدالله', onlyActive: false });
    expect(all.length).toBe(3);
  });
});
