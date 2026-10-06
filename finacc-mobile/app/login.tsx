/**
 * app/login.tsx — شاشة الدخول برمز PIN (FR-12-03/06 — قرار 4).
 *
 * ترحيب باسم المنشأة (من متجر الجلسة) + نقاط ● + لوحة أرقام داخلية (بلا لوحة
 * نظام — DS-38) + حالات: رمز خاطئ (محاولات متبقية قبل القفل)، مقفل (عدّاد
 * ثوانٍ حي «أعد المحاولة بعد N ثانية»)، وبعد 10 محاولات خيار **المسح الكامل**
 * بتأكيد مزدوج بكلمة «مسح» (FR-12-06) ثم العودة إلى التهيئة.
 *
 * البصمة/البيومترية خارج نطاق V1 (اختيارية في SRS) — موثَّق في سجل العمل.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Store, Trash2 } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { wipeAllData } from '@/domain/auth';
import { PinLockedError, PinWrongError, DomainError } from '@/domain/errors';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import ConfirmSheet from '@/components/ui/ConfirmSheet';
import NumberPad from '@/components/ui/NumberPad';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';

type LoginState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'wrong'; message: string; needsHardReset: boolean }
  | { kind: 'locked'; message: string; remainingSeconds: number; needsHardReset: boolean };

export default function LoginScreen() {
  const session = useSession();
  const company = session.company;

  const [pin, setPin] = useState('0');
  const [state, setState] = useState<LoginState>({ kind: 'idle' });
  const [wipeVisible, setWipeVisible] = useState(false);
  const [wiping, setWiping] = useState(false);

  // عدّاد القفل الحي (تحديث كل ثانية)
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (state.kind !== 'locked') {
      if (tick.current) clearInterval(tick.current);
      tick.current = null;
      return;
    }
    tick.current = setInterval(() => {
      setState((s) => {
        if (s.kind !== 'locked') return s;
        const next = s.remainingSeconds - 1;
        if (next <= 0) return { kind: 'idle' };
        return { ...s, remainingSeconds: next, message: ar.login.lockedNow.replace('{seconds}', String(next)) };
      });
    }, 1000);
    return () => {
      if (tick.current) clearInterval(tick.current);
      tick.current = null;
    };
  }, [state.kind]);

  const submit = useCallback(
    async (rawPin: string) => {
      const value = rawPin === '0' ? '' : rawPin;
      if (value.length < 4) return; // الرمز 4-6 خانات — زر الدخول يفحص الطول
      setState({ kind: 'busy' });
      try {
        await session.login(value);
        setPin('0');
        setState({ kind: 'idle' });
        // الجذر يعيد التوجيه تلقائياً عند locked=false
      } catch (err) {
        if (err instanceof PinLockedError) {
          setState({
            kind: 'locked',
            message: ar.login.lockedNow.replace('{seconds}', String(err.remainingSeconds)),
            remainingSeconds: err.remainingSeconds,
            needsHardReset: err.needsHardReset,
          });
        } else if (err instanceof PinWrongError) {
          setState({ kind: 'wrong', message: err.message, needsHardReset: err.needsHardReset });
        } else if (err instanceof DomainError) {
          setState({ kind: 'wrong', message: err.message, needsHardReset: false });
        } else {
          setState({
            kind: 'wrong',
            message: 'تعذّر التحقق من الرمز — أعد المحاولة',
            needsHardReset: false,
          });
        }
      }
    },
    [session],
  );

  const doWipe = useCallback(async () => {
    setWiping(true);
    try {
      const db = await getDb();
      await wipeAllData(db);
      await session.boot(); // onboarded=false → الجذر يعيد التوجيه إلى التهيئة
    } finally {
      setWiping(false);
      setWipeVisible(false);
    }
  }, [session]);

  const value = pin === '0' ? '' : pin;
  const locked = state.kind === 'locked';
  const busy = state.kind === 'busy' || wiping;
  const hardReset =
    (state.kind === 'wrong' || state.kind === 'locked') && state.needsHardReset;
  const canSubmit = value.length >= 4 && !locked && !busy;

  return (
    <SafeScreen scroll={false} offline={false}>
      <View style={styles.wrap}>
        {/* الترحيب */}
        <View style={styles.brandRow}>
          <View style={styles.brandIcon}>
            <Store size={30} color={colors.accent} />
          </View>
          <Text style={styles.companyName}>{company?.name ?? ar.app.name}</Text>
          <Text style={styles.greeting}>{ar.login.greeting}</Text>
          <Text style={styles.sub}>{ar.login.enterPin}</Text>
        </View>

        {/* النقاط */}
        <View style={styles.dotsCard} accessibilityLabel={ar.onboarding.pin.dotsLabel}>
          <View style={styles.dotsRow}>
            {Array.from({ length: 6 }, (_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  i < Math.min(value.length, 6) && styles.dotFilled,
                  i >= 4 && styles.dotExtra,
                ]}
              />
            ))}
          </View>
        </View>

        {/* حالة الخطأ/القفل */}
        {state.kind === 'wrong' || state.kind === 'locked' ? (
          <View style={[styles.statusCard, locked ? styles.statusLocked : styles.statusWrong]}>
            <Text style={locked ? styles.statusLockedText : styles.statusWrongText}>
              {state.message}
            </Text>
          </View>
        ) : null}

        {/* لوحة الأرقام — معطّلة أثناء القفل/الانتظار */}
        <View pointerEvents={locked || busy ? 'none' : 'auto'} style={styles.padWrap}>
          <NumberPad
            value={pin}
            onChange={(v) => {
              setPin(v);
              if (state.kind === 'wrong') setState({ kind: 'idle' });
            }}
            allowDecimal={false}
            decimals={0}
            hideDisplay
            testID="login-pad"
          />
        </View>

        <PrimaryButton
          label={ar.login.enter}
          disabled={!canSubmit}
          loading={busy && !wiping}
          onPress={() => void submit(pin)}
          testID="login-submit"
        />

        {/* مسار FR-12-06: بعد 10 محاولات خاطئة — مسح كامل بتأكيد مزدوج */}
        {hardReset ? (
          <PrimaryButton
            label={ar.login.wipeAction}
            tone="danger"
            icon={Trash2}
            disabled={wiping}
            onPress={() => setWipeVisible(true)}
            style={styles.wipeBtn}
          />
        ) : null}

        <Text style={styles.foot}>{ar.app.tagline}</Text>
      </View>

      <ConfirmSheet
        visible={wipeVisible}
        title={ar.login.wipeTitle}
        message={ar.login.wipeBody}
        confirmWord="مسح"
        danger
        onConfirm={() => void doWipe()}
        onCancel={() => setWipeVisible(false)}
        testID="wipe-sheet"
      />
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    gap: spacing.lg,
  },
  brandRow: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingTop: spacing.xl,
  },
  brandIcon: {
    width: 68,
    height: 68,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
    marginBottom: spacing.sm,
  },
  companyName: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 22,
    lineHeight: 30,
    textAlign: 'center',
  },
  greeting: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  sub: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  dotsCard: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  dot: {
    width: 15,
    height: 15,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  dotFilled: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  dotExtra: {
    opacity: 0.5,
  },
  statusCard: {
    alignSelf: 'stretch',
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  statusWrong: {
    borderColor: 'rgba(248, 113, 113, 0.55)',
    backgroundColor: 'rgba(248, 113, 113, 0.10)',
  },
  statusWrongText: {
    color: colors.danger,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  statusLocked: {
    borderColor: 'rgba(251, 191, 36, 0.55)',
    backgroundColor: 'rgba(251, 191, 36, 0.10)',
  },
  statusLockedText: {
    color: colors.warning,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  padWrap: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  wipeBtn: {
    marginTop: spacing.sm,
  },
  foot: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
