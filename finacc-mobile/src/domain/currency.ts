/**
 * currency.ts — سياسة أسعار الصرف (قرار 3 + FR-08-03/05/09 + AC-13).
 *
 * القواعد الملزمة:
 *  - العملة الأساسية: سعرها 1 دائماً — بلا صف exchange_rate ولا fallback.
 *  - سعر اليوم المخزّن (manual لكل يوم — لا API): إن وُجد → استخدمه (fallback=0).
 *  - المفقود + fx.fallback='off' (الافتراضي): **يُمنع الحفظ** — MissingRateError
 *    برسالة عربية تفتح BottomSheet لإدخال سعر اليوم (قرار 3 / AC-13).
 *  - المفقود + 'last_known': آخر سعر معروف قبل التاريخ (fallback=1 → شارة «سعر صرف تقديري»
 *    على الفاتورة FR-02-20). لا سعر إطلاقاً → MissingRateError.
 *  - Snapshot (FR-08-05): السعر المحلول يُخزَّن على المستند وقت الحفظ ولا يُعاد حسابه أبداً.
 *  - getRate: صارم بلا fallback — لمسارات التسوية لاحقاً (قرار 8).
 *
 * صيغة السعر: 6 منازل (NUMERIC(12,6)).
 */
import { z } from 'zod';
import type { SqliteAdapter } from '../db/adapter';
import { f6, isDecimalString } from '../utils/money';
import { Decimal } from '../utils/money';
import { DomainRuleError, MissingRateError, ValidationError } from './errors';
import { getFxPolicy } from './settings';

export interface ResolvedRate {
  /** السعر المحلول (6dp نصاً) */
  rate: string;
  /** 1 إذا استُخدم آخر سعر معروف (شارة تقديري FR-02-20) */
  rateIsFallback: 0 | 1;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(dateISO: string): void {
  if (!DATE_RE.test(dateISO)) {
    throw new ValidationError(`تاريخ غير صالح (المتوقع YYYY-MM-DD): ${dateISO}`);
  }
}

/**
 * يحل سعر الصرف لعملة بتاريخ وفق سياسة fx.fallback (قرار 3).
 * النتيجة تُخزَّن Snapshot على المستند (FR-08-05).
 */
export async function resolveRate(
  adapter: SqliteAdapter,
  currencyId: number,
  dateISO: string,
): Promise<ResolvedRate> {
  assertDate(dateISO);

  // العملة الأساسية → 1 دائماً بلا صف ولا fallback
  const baseRows = await adapter.all<{ id: number }>(
    'SELECT id FROM currency WHERE is_base = 1',
  );
  if (baseRows[0] && Number(baseRows[0].id) === currencyId) {
    return { rate: '1.000000', rateIsFallback: 0 };
  }

  const curRows = await adapter.all<{ code: string; name: string }>(
    'SELECT code, name FROM currency WHERE id = ?',
    [currencyId],
  );
  const cur = curRows[0];
  if (!cur) {
    throw new DomainRuleError('CURRENCY_NOT_FOUND', `عملة غير موجودة (معرّف ${currencyId})`);
  }

  // سعر اليوم المخزّن → استخدمه كما هو
  const exactRows = await adapter.all<{ rate: string }>(
    'SELECT rate FROM exchange_rate WHERE currency_id = ? AND rate_date = ?',
    [currencyId, dateISO],
  );
  if (exactRows[0]) {
    return { rate: f6(exactRows[0].rate), rateIsFallback: 0 };
  }

  // المفقود → سياسة fx.fallback
  const policy = await getFxPolicy(adapter);
  if (policy.fallback === 'last_known') {
    const lastRows = await adapter.all<{ rate: string }>(
      `SELECT rate FROM exchange_rate
       WHERE currency_id = ? AND rate_date < ?
       ORDER BY rate_date DESC LIMIT 1`,
      [currencyId, dateISO],
    );
    if (lastRows[0]) {
      return { rate: f6(lastRows[0].rate), rateIsFallback: 1 };
    }
  }

  // لا مسار يحفظ بسعر 1 أبداً (قرار 3) — الرفض مع اسم العملة ورمزها
  throw new MissingRateError(cur.code, cur.name, dateISO);
}

/** سعر صارم ليوم بعينه — بلا fallback إطلاقاً (لمسارات التسوية، قرار 8) */
export async function getRate(
  adapter: SqliteAdapter,
  currencyId: number,
  dateISO: string,
): Promise<string> {
  assertDate(dateISO);
  const baseRows = await adapter.all<{ id: number }>(
    'SELECT id FROM currency WHERE is_base = 1',
  );
  if (baseRows[0] && Number(baseRows[0].id) === currencyId) {
    return '1.000000';
  }
  const rows = await adapter.all<{ rate: string }>(
    'SELECT rate FROM exchange_rate WHERE currency_id = ? AND rate_date = ?',
    [currencyId, dateISO],
  );
  if (rows[0]) {
    return f6(rows[0].rate);
  }
  const curRows = await adapter.all<{ code: string; name: string }>(
    'SELECT code, name FROM currency WHERE id = ?',
    [currencyId],
  );
  const cur = curRows[0];
  if (!cur) {
    throw new DomainRuleError('CURRENCY_NOT_FOUND', `عملة غير موجودة (معرّف ${currencyId})`);
  }
  throw new MissingRateError(cur.code, cur.name, dateISO);
}

const RateSchema = z.string().refine(
  (s) => {
    if (!isDecimalString(s)) return false;
    try {
      return new Decimal(s).gt(0);
    } catch {
      return false;
    }
  },
  { message: 'سعر الصرف يجب أن يكون رقماً أكبر من الصفر' },
);

/**
 * يُدخل/يحدّث سعر يوم لعملة (Upsert على currency_id + rate_date).
 * المصدر يدوي دائماً في V1 (لا API موثوق للريال اليمني — FR-08-03).
 */
export async function upsertDailyRate(
  adapter: SqliteAdapter,
  currencyId: number,
  dateISO: string,
  rate: string,
): Promise<void> {
  assertDate(dateISO);
  const parsed = RateSchema.safeParse(rate);
  if (!parsed.success) {
    throw new ValidationError(
      'سعر الصرف يجب أن يكون رقماً أكبر من الصفر — أدخل سعر اليوم للمتابعة',
      parsed.error.issues,
    );
  }
  const curRows = await adapter.all<{ id: number }>('SELECT id FROM currency WHERE id = ?', [
    currencyId,
  ]);
  if (!curRows[0]) {
    throw new DomainRuleError('CURRENCY_NOT_FOUND', `عملة غير موجودة (معرّف ${currencyId})`);
  }
  await adapter.run(
    `INSERT INTO exchange_rate (currency_id, rate_date, rate, source, created_at)
     VALUES (?, ?, ?, 'manual', ?)
     ON CONFLICT(currency_id, rate_date) DO UPDATE SET rate = excluded.rate`,
    [currencyId, dateISO, f6(rate), new Date().toISOString()],
  );
}
