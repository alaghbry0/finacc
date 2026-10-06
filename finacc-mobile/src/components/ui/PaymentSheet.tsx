/**
 * PaymentSheet (DS-40) — لوحة الدفق/القبض الكاملة (مواصفة §6.3):
 *  1. المستحق كبيراً في الأعلى بعملة الفاتورة.
 *  2. «المستلم» يُحرَّر بلوحة NumberPad داخل شيت داخلي، مع حساب الباقي
 *     لحظياً بخط كبير (أخضر موجب + إشارة غير لونية).
 *  3. شبكة فئات سريعة (500 / 1,000 / 2,000 / 5,000) **تُضاف** للمستلم
 *     (استعارة عدّ الأوراق: 500+1,000…) + زر «المبلغ بالضبط».
 *  4. «تحويل المتبقي آجلاً» عند 0 < المستلم < المستحق (FR-02-10 → mixed).
 *  5. «إتمام الدفع» مفعّل عند اكتمال المبلغ (cash مع الباقي) — والإعداد
 *     invoicing.payment_sheet=off يتجاوز الشيت كله (يقرره المستدعي لا المكون).
 *  6. شريط إجماليات مصغّر في تذييل شيت الأرقام — فوق أي «لوحة» دائماً (DS-40-6).
 *
 * مكوّن مضبوط (controlled): الأب يملك visible وonConfirm — شاشة البيع (المهمة 6)
 * تستدعيه بعد «حفظ نقدي». النتائج نصوص f4 جاهزة لطبقة Domain.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Banknote, Pencil, Plus } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { formatAmount } from '@/utils/format';
import { d, f4 } from '@/utils/money';
import AmountText from './AmountText';
import BottomSheet from './BottomSheet';
import NumberPad, { addToRawValue } from './NumberPad';
import PrimaryButton from './PrimaryButton';

export type PaymentResult = {
  /** المبلغ المستلم فعلاً (f4) */
  received: string;
  /** الباقي للعميل (f4) — صفر في الحالة المختلطة */
  change: string;
  /** cash = اكتمل الدفع (مع باقٍ)، mixed = حُوِّل المتبقي آجلاً */
  mode: 'cash' | 'mixed';
};

export type PaymentSheetProps = {
  visible: boolean;
  /** الإجمالي المستحق خاماً نصياً */
  total: string;
  /** رمز عملة الفاتورة (YER/SAR/…) */
  currencyCode?: string;
  /** منازل العملة — YER=0 */
  decimals?: number;
  onConfirm: (r: PaymentResult) => void;
  /** إغلاق بلا دفع (اختياري — يظهر زر X) */
  onClose?: () => void;
  /** الفئات السريعة — افتراضي 500/1000/2000/5000 */
  quickAmounts?: string[];
  testID?: string;
};

export default function PaymentSheet({
  visible,
  total,
  currencyCode,
  decimals = 2,
  onConfirm,
  onClose,
  quickAmounts = ['500', '1000', '2000', '5000'],
  testID,
}: PaymentSheetProps) {
  const [received, setReceived] = useState('0');
  const [padOpen, setPadOpen] = useState(false);

  const totalD = d(total);
  const receivedD = d(received);
  const diff = receivedD.minus(totalD); // موجب = باقٍ للعميل، سالب = متبقٍ على العميل
  const change = diff.gt(0) ? diff : d(0);
  const remaining = diff.lt(0) ? diff.negated() : d(0);
  const exactMode = receivedD.gt(0) && diff.gte(0);
  const mixedMode = receivedD.gt(0) && diff.lt(0);

  const openPad = () => {
    setPadOpen(true);
  };

  const confirmCash = () => {
    onConfirm({ received: f4(receivedD), change: f4(change), mode: 'cash' });
  };

  const confirmMixed = () => {
    onConfirm({ received: f4(receivedD), change: f4(d(0)), mode: 'mixed' });
  };

  const miniTotals = (
    <View style={styles.miniRow}>
      <View style={styles.miniCell}>
        <Text style={styles.miniLabel}>{ar.components.paymentSheet.totalDue}</Text>
        <Text style={[styles.miniValue, { color: colors.warning }]}>
          {formatAmount(total, decimals)}
        </Text>
      </View>
      <View style={styles.miniSep} />
      <View style={styles.miniCell}>
        <Text style={styles.miniLabel}>{ar.components.paymentSheet.received}</Text>
        <Text style={[styles.miniValue, { color: colors.text }]}>
          {formatAmount(received, decimals)}
        </Text>
      </View>
      <View style={styles.miniSep} />
      <View style={styles.miniCell}>
        <Text style={styles.miniLabel}>
          {exactMode ? ar.components.paymentSheet.change : ar.components.paymentSheet.remaining}
        </Text>
        <Text
          style={[
            styles.miniValue,
            exactMode ? { color: colors.success } : { color: colors.warning },
          ]}
        >
          {`${exactMode ? '+' : '-'}${formatAmount(
            (exactMode ? change : remaining).toFixed(decimals),
            decimals,
          )}`}
        </Text>
      </View>
    </View>
  );

  return (
    <>
      <BottomSheet visible={visible} onClose={onClose} title={onClose ? ar.components.paymentSheet.title : undefined} testID={testID}>
        <View style={styles.sheetBody}>
          {/* 1. المستحق كبيراً */}
          <View style={styles.dueBlock}>
            <Text style={styles.dueLabel}>{ar.components.paymentSheet.totalDue}</Text>
            <AmountText
              value={total}
              tone="warning"
              size="display"
              currency={currencyCode}
              decimals={decimals}
            />
          </View>

          {/* 2. المستلم — يحرَّر بلوحة الأرقام */}
          <Pressable onPress={openPad} style={({ pressed }) => [styles.receivedBox, pressed && styles.receivedPressed]}>
            <View style={styles.receivedTexts}>
              <Text style={styles.receivedLabel}>{ar.components.paymentSheet.received}</Text>
              <AmountText value={received} size="xl" decimals={decimals} />
              <Text style={styles.receivedHint}>{ar.components.paymentSheet.receivedHint}</Text>
            </View>
            <View style={styles.receivedIcon}>
              <Pencil size={18} color={colors.accent} />
            </View>
          </Pressable>

          {/* 3. الفئات السريعة + المبلغ بالضبط */}
          <View style={styles.quickBlock}>
            <Text style={styles.quickLabel}>{ar.components.paymentSheet.quickAmounts}</Text>
            <View style={styles.quickGrid}>
              {quickAmounts.map((q) => (
                <Pressable
                  key={q}
                  accessibilityLabel={`${ar.components.paymentSheet.quickAdd} ${formatAmount(q, 0)}`}
                  onPress={() => setReceived(addToRawValue(received, q, decimals))}
                  style={({ pressed }) => [styles.quickBtn, pressed && styles.quickPressed]}
                >
                  <Plus size={14} color={colors.accent} />
                  <Text style={styles.quickText}>{formatAmount(q, 0)}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityLabel={ar.components.paymentSheet.exactAmount}
                onPress={() => setReceived(totalD.toFixed(decimals))}
                style={({ pressed }) => [styles.quickBtn, styles.exactBtn, pressed && styles.quickPressed]}
              >
                <Banknote size={14} color={colors.warning} />
                <Text style={[styles.quickText, { color: colors.warning }]}>
                  {ar.components.paymentSheet.exactAmount}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* الباقي/المتبقي لحظياً */}
          <View style={styles.diffBlock}>
            {exactMode ? (
              <>
                <AmountText value={change.toFixed(decimals)} tone="in" sign size="lg" decimals={decimals} currency={currencyCode} />
                <Text style={styles.diffCaption}>{ar.components.paymentSheet.change}</Text>
                <Text style={styles.diffHint}>{ar.components.paymentSheet.changeHint}</Text>
              </>
            ) : mixedMode ? (
              <>
                <AmountText value={remaining.toFixed(decimals)} tone="warning" size="lg" decimals={decimals} />
                <Text style={styles.diffCaption}>{ar.components.paymentSheet.remaining}</Text>
              </>
            ) : (
              <Text style={styles.startHint}>{ar.components.paymentSheet.startHint}</Text>
            )}
          </View>

          {/* 4+5. الأزرار */}
          {mixedMode ? (
            <PrimaryButton
              label={ar.components.paymentSheet.convertToCredit}
              tone="warning"
              onPress={confirmMixed}
            />
          ) : null}
          <PrimaryButton
            label={ar.components.paymentSheet.complete}
            disabled={!exactMode}
            onPress={confirmCash}
          />
          {!exactMode ? (
            <Text style={styles.disabledHint}>{ar.components.paymentSheet.completeDisabledHint}</Text>
          ) : null}
        </View>
      </BottomSheet>

      {/* شيت اللوحة الداخلي — يعلو الشيت الأم؛ إجمالياته في التذييل (فوق اللوحة دائماً) */}
      <BottomSheet
        visible={padOpen}
        onClose={() => setPadOpen(false)}
        title={ar.components.paymentSheet.received}
        footer={miniTotals}
        key="payment-pad"
      >
        <NumberPad
          value={received}
          onChange={setReceived}
          allowDecimal
          decimals={decimals}
          label={ar.components.paymentSheet.received}
          onDone={() => setPadOpen(false)}
        />
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  sheetBody: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  dueBlock: {
    alignItems: 'center',
    gap: 2,
    paddingTop: spacing.xs,
  },
  dueLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  receivedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: spacing.md,
    minHeight: 88,
  },
  receivedPressed: {
    borderColor: colors.accent,
  },
  receivedTexts: {
    flex: 1,
    gap: 2,
  },
  receivedLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  receivedHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  receivedIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
  },
  quickBlock: {
    gap: 8,
  },
  quickLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    flexBasis: '48%',
    flexGrow: 1,
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  exactBtn: {
    flexBasis: '100%',
    borderColor: 'rgba(251, 191, 36, 0.45)',
  },
  quickPressed: {
    backgroundColor: '#24334A',
    borderColor: colors.accent,
  },
  quickText: {
    color: colors.text,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
  },
  diffBlock: {
    alignItems: 'center',
    gap: 2,
    minHeight: 74,
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    padding: spacing.sm,
  },
  diffCaption: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  diffHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  startHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  disabledHint: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  /* شريط الإجماليات المصغّر (تذييل شيت الأرقام) */
  miniRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.sm,
  },
  miniCell: {
    flex: 1,
    gap: 2,
  },
  miniSep: {
    width: 1,
    backgroundColor: colors.border,
  },
  miniLabel: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  miniValue: {
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'right',
  },
});
