/**
 * currency.test.ts — سياسة سعر الصرف المفقود (قرار 3 / FR-08-09 / AC-13)
 * + Snapshot + تحقق سعر > 0 (SRS §10.2: currency).
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { MissingRateError, ValidationError } from '../errors';
import { getRate, resolveRate, upsertDailyRate } from '../currency';
import {
  getDatingPolicy,
  getFxPolicy,
  getInvoicingSettings,
  getSalePolicy,
  getSetting,
  setSetting,
} from '../settings';
import { seededDb, todayISO, daysAgoISO } from './seed';

describe('resolveRate — سياسة السعر المفقود (قرار 3)', () => {
  test('AC-13: بلا سعر لليوم والسياسة off → MissingRateError برسالة عربية (يُمنع الحفظ)', async () => {
    const { db, seed } = await seededDb();
    let err: unknown;
    try {
      await resolveRate(db, seed.sarId, todayISO());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingRateError);
    const e = err as MissingRateError;
    expect(e.message).toContain('لا يوجد سعر صرف لليوم');
    expect(e.message).toContain('ريال سعودي');
    expect(e.message).toContain('SAR');
    expect(e.message).toContain('أدخل سعر اليوم للمتابعة');
    expect(e.currencyCode).toBe('SAR');
    expect(e.dateISO).toBe(todayISO());
  });

  test('السياسة last_known → آخر سعر قبل التاريخ مع rateIsFallback=1 (شارة تقديري FR-02-20)', async () => {
    const { db, seed } = await seededDb();
    await setSetting(db, 'fx.fallback', 'last_known');
    await upsertDailyRate(db, seed.sarId, daysAgoISO(3), '530');
    const res = await resolveRate(db, seed.sarId, todayISO());
    expect(res.rate).toBe('530.000000');
    expect(res.rateIsFallback).toBe(1);
  });

  test('last_known لكن لا سعر إطلاقاً → MissingRateError (لا مسار بسعر 1)', async () => {
    const { db, seed } = await seededDb();
    await setSetting(db, 'fx.fallback', 'last_known');
    await expect(resolveRate(db, seed.sarId, todayISO())).rejects.toBeInstanceOf(MissingRateError);
  });

  test('العملة الأساسية → 1.000000 دائماً بلا fallback وبلا صف', async () => {
    const { db, seed } = await seededDb();
    const res = await resolveRate(db, seed.yerId, todayISO());
    expect(res.rate).toBe('1.000000');
    expect(res.rateIsFallback).toBe(0);
    const rows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM exchange_rate');
    expect(Number(rows[0]!.n)).toBe(0);
  });

  test('سعر اليوم مُدخل → يُستخدم كما هو بلا fallback (AC-13 بعد الإدخال)', async () => {
    const { db, seed } = await seededDb();
    await upsertDailyRate(db, seed.sarId, todayISO(), '528.5');
    const res = await resolveRate(db, seed.sarId, todayISO());
    expect(res.rate).toBe('528.500000');
    expect(res.rateIsFallback).toBe(0);
  });

  test('آخر سعر معروف *بعد* التاريخ لا يُستخدم (strictly before)', async () => {
    const { db, seed } = await seededDb();
    await setSetting(db, 'fx.fallback', 'last_known');
    await upsertDailyRate(db, seed.sarId, daysAgoISO(-5), '530'); // مستقبل
    await expect(resolveRate(db, seed.sarId, todayISO())).rejects.toBeInstanceOf(MissingRateError);
  });

  test('عملة غير موجودة → DomainRuleError واضحة', async () => {
    const { db } = await seededDb();
    await expect(resolveRate(db, 999, todayISO())).rejects.toThrow('عملة غير موجودة');
  });

  test('تاريخ غير صالح → رفض واضح', async () => {
    const { db, seed } = await seededDb();
    await expect(resolveRate(db, seed.sarId, '2026/01/01')).rejects.toThrow('تاريخ غير صالح');
  });
});

describe('upsertDailyRate — إدخال سعر اليوم', () => {
  test('سعر ≤ 0 أو غير رقمي → ValidationError عربية', async () => {
    const { db, seed } = await seededDb();
    await expect(upsertDailyRate(db, seed.sarId, todayISO(), '0')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(upsertDailyRate(db, seed.sarId, todayISO(), '-5')).rejects.toThrow(
      'أكبر من الصفر',
    );
    await expect(upsertDailyRate(db, seed.sarId, todayISO(), 'abc')).rejects.toThrow(
      'سعر الصرف',
    );
  });

  test('Upsert: إدخال ثانٍ لنفس اليوم يحدّث ولا يكرر (سجل تاريخي لكل عملة)', async () => {
    const { db, seed } = await seededDb();
    await upsertDailyRate(db, seed.sarId, todayISO(), '530');
    await upsertDailyRate(db, seed.sarId, todayISO(), '531');
    const rows = await db.all<{ rate: string }>(
      'SELECT rate FROM exchange_rate WHERE currency_id = ? AND rate_date = ?',
      [seed.sarId, todayISO()],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.rate).toBe('531.000000');
    const res = await resolveRate(db, seed.sarId, todayISO());
    expect(res.rate).toBe('531.000000');
  });
});

describe('getRate — صارم بلا fallback (مسارات التسوية)', () => {
  test('لا سعر اليوم لكن يوجد سابق ولا fallback → MissingRateError', async () => {
    const { db, seed } = await seededDb();
    await setSetting(db, 'fx.fallback', 'last_known');
    await upsertDailyRate(db, seed.sarId, daysAgoISO(3), '530');
    await expect(getRate(db, seed.sarId, todayISO())).rejects.toBeInstanceOf(MissingRateError);
  });

  test('العملة الأساسية → 1 دائماً', async () => {
    const { db, seed } = await seededDb();
    expect(await getRate(db, seed.yerId, todayISO())).toBe('1.000000');
  });
});

describe('settings — القيم الافتراضية والكتابة (ملحق هـ)', () => {
  test('الافتراضات الحرفية عند غياب الصفوف', async () => {
    const { db } = await seededDb();
    const raw = await getSetting(db, 'fx.fallback', z.enum(['off', 'last_known']), 'off' as const);
    expect(raw).toBe('off');
    expect((await getFxPolicy(db)).fallback).toBe('off');
    expect((await getDatingPolicy(db)).maxBackdateDays).toBe(30);
    expect((await getInvoicingSettings(db)).taxMode).toBe('on_total');
    expect((await getInvoicingSettings(db)).discountBelowMargin).toBe('off');
    expect((await getSalePolicy(db)).overAvailPolicy).toBe('warn');
  });

  test('قيمة تالفة → الافتراضي بلا انهيار (دفاعية)', async () => {
    const { db } = await seededDb();
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [
      'dating.max_backdate_days',
      'ليس رقمًا',
    ]);
    expect((await getDatingPolicy(db)).maxBackdateDays).toBe(30);
  });

  test('setSetting: مفتاح مجهول → رفض؛ قيمة غير صالحة → رفض عربي؛ الكتابة تعمل', async () => {
    const { db } = await seededDb();
    await expect(setSetting(db, 'unknown.key', 'x')).rejects.toThrow('مفتاح إعداد غير معروف');
    await expect(setSetting(db, 'dating.max_backdate_days', 999)).rejects.toThrow(
      'قيمة غير صالحة',
    );
    await setSetting(db, 'dating.max_backdate_days', 15);
    expect((await getDatingPolicy(db)).maxBackdateDays).toBe(15);
  });
});
