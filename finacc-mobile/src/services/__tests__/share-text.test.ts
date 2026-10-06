/**
 * share-text.test.ts — اختبارات رسالة الواتساب وتطبيع رقمه (نقية — bun).
 */
import { describe, expect, test } from 'bun:test';
import { buildWhatsAppMessage, waLink, waNumber } from '../share-text';
import type { InvoicePrintData } from '../invoice-html';

function sample(overrides: Partial<InvoicePrintData> = {}): InvoicePrintData {
  return {
    company: {
      name: 'متجر النور',
      phone: '712345678',
      address: null,
      footerText: 'شكراً لتعاملكم معنا',
    },
    docType: 'sale',
    payStatus: 'credit',
    status: 'completed',
    invoiceNo: 'INV-2026-00005',
    issuedAt: '2026-10-07',
    party: { name: 'أحمد صالح', phone: '733221100', whatsapp: '733221100' },
    partyLabel: 'العميل',
    currency: { code: 'YER', decimals: 0 },
    exchangeRate: '1.000000',
    rateIsFallback: false,
    items: [],
    totals: {
      subtotal: '5000.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '5000.0000',
      paid: '1000.0000',
      due: '4000.0000',
    },
    notesPrinted: null,
    generatedAt: '2026-10-07T14:35:00.000Z',
    ...overrides,
  };
}

describe('buildWhatsAppMessage', () => {
  test('الملخص: العنوان + الرقم + التاريخ + العميل + الإجمالي + المتبقي + التذييل', () => {
    const msg = buildWhatsAppMessage(sample());
    expect(msg).toContain('فاتورة مبيعات INV-2026-00005 — متجر النور');
    expect(msg).toContain('التاريخ: الأربعاء 07 أكتوبر 2026');
    expect(msg).toContain('العميل: أحمد صالح');
    expect(msg).toContain('الإجمالي: 5,000 ر.ي');
    expect(msg).toContain('المتبقي: 4,000 ر.ي');
    expect(msg).toContain('شكراً لتعاملكم معنا');
  });

  test('المتبقي يسقط عند صفره (نقدي مسدد)', () => {
    const msg = buildWhatsAppMessage(
      sample({ payStatus: 'cash', totals: { subtotal: '115.0000', discount: '0.0000', tax: '0.0000', total: '115.0000', paid: '115.0000', due: '0.0000' } }),
    );
    expect(msg).not.toContain('المتبقي');
    expect(msg).toContain('الإجمالي: 115 ر.ي');
  });
});

describe('waNumber — تطبيع الأرقام لصيغة wa.me', () => {
  test('يمني محلي 7xxxxxxxx → 967 + الرقم، والفواصل تُنظف', () => {
    expect(waNumber('733221100')).toBe('967733221100');
    expect(waNumber('733 221 100')).toBe('967733221100');
    expect(waNumber('733-221-100')).toBe('967733221100');
  });
  test('دولي بصيغ + أو 00 أو 967 كما هو', () => {
    expect(waNumber('+967733221100')).toBe('967733221100');
    expect(waNumber('00967733221100')).toBe('967733221100');
    expect(waNumber('967733221100')).toBe('967733221100');
  });
  test('الفراغ التام → null', () => {
    expect(waNumber('')).toBeNull();
    expect(waNumber('   ')).toBeNull();
  });
});

describe('waLink', () => {
  test('رابط wa.me مع الرسالة مُرمَّزة', () => {
    const link = waLink('967733221100', 'فاتورة 115');
    expect(link.startsWith('https://wa.me/967733221100?text=')).toBe(true);
    expect(link).toContain(encodeURIComponent('فاتورة 115'));
  });
});
