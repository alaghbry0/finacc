/**
 * اختبارات الترقيم الذري (SRS §5.4-1 / ملحق د) — منطق الأعمال أولاً.
 */
import { describe, expect, test } from 'bun:test';
import { freshDb } from '../../db/test-setup';
import { nextDocNo } from '../docseq';

describe('nextDocNo — الترقيم الذري (doc_sequence)', () => {
  test('أول رقم: صيغة INV-2026-00001 (ملحق د: 5 أرقام مملوءة بأصفار)', async () => {
    const db = await freshDb();
    const no = await nextDocNo(db, 'INV', '2026-05-01', 'INV');
    expect(no).toBe('INV-2026-00001');
  });

  test('(أ) 100 نداء متسلسل: أرقام 1..100 كلها فريدة وبالصيغة الصحيحة', async () => {
    const db = await freshDb();
    const results: string[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(await nextDocNo(db, 'INV', '2026-05-01', 'INV'));
    }
    expect(results.length).toBe(100);
    expect(new Set(results).size).toBe(100);
    expect(results[0]).toBe('INV-2026-00001');
    expect(results[99]).toBe('INV-2026-00100');
    const rows = await db.all<{ last_no: number }>(
      'SELECT last_no FROM doc_sequence WHERE doc_type = ? AND year = ?',
      ['INV', 2026],
    );
    expect(Number(rows[0]!.last_no)).toBe(100);
  });

  test('(ب) دفعة «متوازية» من 100 نداء (Promise.all): لا تكرار وlast_no = 100 — سلوك UPSERT لا MAX+1', async () => {
    const db = await freshDb();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => nextDocNo(db, 'INV', '2026-06-01', 'INV')),
    );
    expect(new Set(results).size).toBe(100);
    const rows = await db.all<{ last_no: number }>(
      'SELECT last_no FROM doc_sequence WHERE doc_type = ? AND year = ?',
      ['INV', 2026],
    );
    expect(Number(rows[0]!.last_no)).toBe(100);
    // لو كان MAX+1 قيد الاستخدام لتكررت أرقام تحت الضغط — نتحقق من التطابق الحرفي مع 1..100
    const nums = results.map((r) => Number(r.split('-')[2])).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  test('(ب+) 20 معاملة حفظ متزامنة تحوي كل واحدة 5 استهلاكات: 100 رقم فريدة (ذرّية 5.4-4)', async () => {
    const db = await freshDb();
    const perTx = 5;
    const txCount = 20;
    const results = await Promise.all(
      Array.from({ length: txCount }, () =>
        db.transaction(async () => {
          const nos: string[] = [];
          for (let i = 0; i < perTx; i++) {
            nos.push(await nextDocNo(db, 'PMT', '2026-07-01', 'PMT'));
          }
          return nos;
        }),
      ),
    );
    const flat = results.flat();
    expect(flat.length).toBe(txCount * perTx);
    expect(new Set(flat).size).toBe(txCount * perTx);
    const rows = await db.all<{ last_no: number }>(
      'SELECT last_no FROM doc_sequence WHERE doc_type = ? AND year = ?',
      ['PMT', 2026],
    );
    expect(Number(rows[0]!.last_no)).toBe(txCount * perTx);
  });

  test('(ج) عدادات مستقلة لكل نوع مستند وكل سنة', async () => {
    const db = await freshDb();
    expect(await nextDocNo(db, 'INV', '2026-01-01', 'INV')).toBe('INV-2026-00001');
    expect(await nextDocNo(db, 'PUR', '2026-01-01', 'PUR')).toBe('PUR-2026-00001');
    expect(await nextDocNo(db, 'INV', '2027-03-01', 'INV')).toBe('INV-2027-00001');
    expect(await nextDocNo(db, 'INV', '2026-01-01', 'INV')).toBe('INV-2026-00002');
    expect(await nextDocNo(db, 'RVT', '2026-01-01', 'RVT')).toBe('RVT-2026-00001');
    expect(await nextDocNo(db, 'SRN', '2026-01-01', 'SRN')).toBe('SRN-2026-00001');
    expect(await nextDocNo(db, 'PRN', '2026-01-01', 'PRN')).toBe('PRN-2026-00001');
    const rows = await db.all<{ doc_type: string; year: number; last_no: number }>(
      'SELECT doc_type, year, last_no FROM doc_sequence ORDER BY doc_type, year',
    );
    expect(rows.length).toBe(6);
  });

  test('(د) سلوكياً: العدّاد لا يُشتق من صفوف المستندات (MAX+1) — البادئ يدوم حتى لو حُذفت المستندات', async () => {
    const db = await freshDb();
    // استهلاك 3 أرقام كأن 3 فواتير صدرت
    await nextDocNo(db, 'INV', '2026-02-01', 'INV');
    await nextDocNo(db, 'INV', '2026-02-01', 'INV');
    await nextDocNo(db, 'INV', '2026-02-01', 'INV');
    // حتى لو حُذفت كل المستندات (أو لم تُنشأ أصلاً) العدّاد يستمر — لا إعادة استخدام للأرقام الصادرة
    await db.run('DELETE FROM invoice');
    expect(await nextDocNo(db, 'INV', '2026-02-01', 'INV')).toBe('INV-2026-00004');
  });

  test('(هـ) الرقم يتراجع مع فشل معاملة الحفظ (لم يصدر بعد) — ذرّية قاعدة 5.4-4', async () => {
    const db = await freshDb();
    // استهلاك ناجح واحد خارج معاملة
    expect(await nextDocNo(db, 'INV', '2026-03-01', 'INV')).toBe('INV-2026-00001');
    // معاملة تفشل بعد استهلاك الرقم → ROLLBACK يرجع العدّاد
    await expect(
      db.transaction(async () => {
        await nextDocNo(db, 'INV', '2026-03-01', 'INV'); // 00002 (سيُتراجع)
        throw new Error('فشل متعمَّد — محاكاة فشل حفظ الفاتورة');
      }),
    ).rejects.toThrow('فشل متعمَّد');
    const rows = await db.all<{ last_no: number }>(
      'SELECT last_no FROM doc_sequence WHERE doc_type = ? AND year = ?',
      ['INV', 2026],
    );
    expect(Number(rows[0]!.last_no)).toBe(1);
    // الرقم 00002 لم يصدر أصلاً — إصداره الآن ليس «إعادة استخدام»
    expect(await nextDocNo(db, 'INV', '2026-03-01', 'INV')).toBe('INV-2026-00002');
  });

  test('رفض نوع مستند غير معروف وتاريخ غير صالح', async () => {
    const db = await freshDb();
    await expect(nextDocNo(db, 'XXX' as 'INV', '2026-01-01', 'XXX')).rejects.toThrow(
      'نوع مستند غير معروف',
    );
    await expect(nextDocNo(db, 'INV', '2026/01/01', 'INV')).rejects.toThrow('تاريخ غير صالح');
  });
});
