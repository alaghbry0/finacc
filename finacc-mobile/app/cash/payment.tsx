/**
 * cash/payment.tsx — سند صرف (دفع لمورّد) (Task 10 — FR-04-03/10):
 *
 * مرآة كاملة لسند القبض للموردين: نفس VoucherScreen (شريط الميتا بالمورّد +
 * فحص سعر اليوم + معاينة FIFO لفواتير الشراء المفتوحة + الحفظ عبر
 * recordVoucher بtxType='payment' + رقم PMT- + طباعة السند) — التنفيذ
 * المشترك يعيش في receipt.tsx وتُمرَّر kind='payment' فقط.
 */
import { VoucherScreen } from './receipt';

export default function PaymentScreen() {
  return <VoucherScreen kind="payment" />;
}
