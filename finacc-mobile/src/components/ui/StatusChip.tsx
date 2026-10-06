/**
 * StatusChip (DS-26) — شريحة حالة بنقطة + **نص دائماً** (لا لون فقط — §6.1):
 * نقدي أخضر / آجل كهرماني / مختلط تيل / مسودة رمادي / ملغاة أحمر باهت.
 * تُربط من invoice.pay_status أو invoice.status.
 */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius } from '@/theme';

export type ChipKind =
  | 'cash'
  | 'credit'
  | 'mixed'
  | 'draft'
  | 'void'
  | 'completed'
  | 'pending'
  | 'late'
  | 'partial'
  | 'cleared'
  | 'deposited'
  | 'bounced';

const KIND_MAP: Record<ChipKind, { label: string; fg: string; bg: string }> = {
  cash: { label: ar.invoice.statusCash, fg: colors.success, bg: 'rgba(52, 211, 153, 0.14)' },
  credit: { label: ar.invoice.statusCredit, fg: colors.warning, bg: 'rgba(251, 191, 36, 0.14)' },
  mixed: { label: ar.invoice.statusMixed, fg: colors.teal, bg: 'rgba(45, 212, 191, 0.14)' },
  draft: { label: ar.invoice.statusDraft, fg: colors.textMuted, bg: 'rgba(148, 163, 184, 0.14)' },
  void: { label: ar.invoice.statusVoid, fg: colors.danger, bg: 'rgba(248, 113, 113, 0.10)' },
  completed: { label: ar.invoice.statusCompleted, fg: colors.accent, bg: 'rgba(34, 211, 238, 0.14)' },
  pending: { label: ar.status.pending, fg: colors.textMuted, bg: 'rgba(148, 163, 184, 0.14)' },
  late: { label: ar.status.late, fg: colors.warning, bg: 'rgba(251, 191, 36, 0.14)' },
  partial: { label: ar.status.partial, fg: colors.warning, bg: 'rgba(251, 191, 36, 0.14)' },
  cleared: { label: ar.status.cleared, fg: colors.success, bg: 'rgba(52, 211, 153, 0.14)' },
  deposited: { label: ar.status.deposited, fg: colors.accent, bg: 'rgba(34, 211, 238, 0.14)' },
  bounced: { label: ar.status.bounced, fg: colors.danger, bg: 'rgba(248, 113, 113, 0.10)' },
};

export type StatusChipProps = {
  kind: ChipKind;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function StatusChip({ kind, style, testID }: StatusChipProps) {
  const m = KIND_MAP[kind] ?? KIND_MAP.pending;
  return (
    <View testID={testID} style={[styles.chip, { backgroundColor: m.bg }, style]}>
      <View style={[styles.dot, { backgroundColor: m.fg }]} />
      <Text style={[styles.label, { color: m.fg }]}>{m.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.full,
    paddingVertical: 3,
    paddingHorizontal: 10,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  label: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
});
