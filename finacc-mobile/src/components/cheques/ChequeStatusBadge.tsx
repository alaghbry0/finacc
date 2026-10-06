/**
 * ChequeStatusBadge — شريحة حالة الشيك (FR-14-02) بنقطة + نص دائماً (§6.1):
 * pending كهرماني بتسمية تتبع الاتجاه (قيد التحصيل للوارد / قيد السحب
 * للصادر) · deposited سماوي · cleared أخضر · bounced أحمر · void رمادي.
 */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius } from '@/theme';
import type { ChequeListRow } from '@/db/queries';

type ChequeStatus = ChequeListRow['status'];
type ChequeDirection = ChequeListRow['direction'];

interface BadgeStyle {
  label: string;
  fg: string;
  bg: string;
}

/** خريطة الحالة → تسمية/ألوان (pending حسب الاتجاه — بقية الحالات موحدة) */
export function chequeBadge(status: ChequeStatus, direction: ChequeDirection): BadgeStyle {
  switch (status) {
    case 'pending':
      return direction === 'in'
        ? { label: ar.cheques.status.pendingIn, fg: colors.warning, bg: 'rgba(251, 191, 36, 0.14)' }
        : { label: ar.cheques.status.pendingOut, fg: colors.warning, bg: 'rgba(251, 191, 36, 0.14)' };
    case 'deposited':
      return { label: ar.cheques.status.deposited, fg: colors.accent, bg: 'rgba(34, 211, 238, 0.14)' };
    case 'cleared':
      return { label: ar.cheques.status.cleared, fg: colors.success, bg: 'rgba(52, 211, 153, 0.14)' };
    case 'bounced':
      return { label: ar.cheques.status.bounced, fg: colors.danger, bg: 'rgba(248, 113, 113, 0.12)' };
    case 'void':
    default:
      return { label: ar.cheques.status.void, fg: colors.textMuted, bg: 'rgba(148, 163, 184, 0.14)' };
  }
}

export type ChequeStatusBadgeProps = {
  status: ChequeStatus;
  direction: ChequeDirection;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function ChequeStatusBadge({ status, direction, style, testID }: ChequeStatusBadgeProps) {
  const m = chequeBadge(status, direction);
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
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
});
