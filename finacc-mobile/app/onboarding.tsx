/**
 * app/onboarding.tsx — إعداد أول تشغيل (FR-13-01 / AC-24: ≤5 دقائق).
 *
 * المسار: 4 شرائح ترحيب صادقة (Scroll أفقي + نقاط) → 4 خطوات:
 *  بيانات المنشأة → العملة الأساسية (4 بطاقات) → رمز PIN (لوحة داخل شيت:
 *  إدخال ثم تأكيد) → مراجعة و«إنهاء التهيئة» → completeOnboarding (معاملة
 *  واحدة تنشئ المخزن/الصندوق/العملات/المدير) → دخول تلقائي بالرمز الذي
 *  اختاره → لوحة المعلومات حية.
 *
 * أخطاء زود تُعرض داخلية لكل خانة (FieldError حمراء)؛ فشل الحفظ → ErrorState
 * بإعادة محاولة — لا شيء يُكتب ناقصاً (ذرّية المعاملة).
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import {
  BadgeCheck,
  Check,
  ChevronRight,
  Coins,
  Home,
  ShoppingCart,
  Smartphone,
  WifiOff,
  Zap,
  type LucideIcon,
} from 'lucide-react-native';
import { getDb } from '@/db/client';
import { completeOnboarding } from '@/domain/onboarding';
import { OnboardingInputSchema } from '@/domain/onboarding';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing, touch } from '@/theme';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import ErrorState from '@/components/ui/ErrorState';
import LoadingState from '@/components/ui/LoadingState';
import NumberPad from '@/components/ui/NumberPad';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import TextField, { FieldError } from '@/components/ui/TextField';
import type { ZodIssue } from 'zod';

type CurrencyCode = 'YER' | 'SAR' | 'USD' | 'AED';

type Phase =
  | { kind: 'welcome' }
  | { kind: 'steps'; step: number } // 0..3
  | { kind: 'saving' }
  | { kind: 'failed'; technical?: string };

const TOTAL_STEPS = 4;

const SLIDES: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: WifiOff, title: ar.onboarding.slide1Title, body: ar.onboarding.slide1Body },
  { icon: Smartphone, title: ar.onboarding.slide2Title, body: ar.onboarding.slide2Body },
  { icon: Zap, title: ar.onboarding.slide3Title, body: ar.onboarding.slide3Body },
  { icon: BadgeCheck, title: ar.onboarding.slide4Title, body: ar.onboarding.slide4Body },
];

const CURRENCIES: { code: CurrencyCode; icon: LucideIcon }[] = [
  { code: 'YER', icon: Coins },
  { code: 'SAR', icon: Coins },
  { code: 'USD', icon: Coins },
  { code: 'AED', icon: Coins },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const session = useSession();

  const [phase, setPhase] = useState<Phase>({ kind: 'welcome' });

  // الخطوة 1: بيانات المنشأة
  const [companyName, setCompanyName] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [address, setAddress] = useState('');
  // الخطوة 2: العملة
  const [currency, setCurrency] = useState<CurrencyCode>('YER');
  // الخطوة 3: الرمز
  const [pin, setPin] = useState('');

  // أخطاء الزود لكل خانة (مفتاح = مسار الحقل الأول)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSheetVisible, setPinSheetVisible] = useState(false);

  const [dot, setDot] = useState(0);
  const clearErrors = () => {
    setFieldErrors({});
    setPinError(null);
  };

  /** تحقق زود أمامي برسائل عربية — يبني خريطة خطأ لكل خانة */
  const validateAll = (): boolean => {
    const parsed = OnboardingInputSchema.safeParse({
      companyName,
      phone: phone || undefined,
      whatsapp: whatsapp || undefined,
      address: address || undefined,
      baseCurrencyCode: currency,
      pin,
    });
    if (parsed.success) {
      clearErrors();
      return true;
    }
    const map: Record<string, string> = {};
    for (const issue of parsed.error.issues as ZodIssue[]) {
      const key = String(issue.path[0] ?? 'form');
      if (!map[key]) map[key] = issue.message;
    }
    setFieldErrors(map);
    if (map.pin) setPinError(map.pin);
    return false;
  };

  const nextFrom = (step: number) => {
    // التحقق تدريجي: الاسم قبل مغادرة الخطوة 1، الرمز قبل مغادرة الخطوة 3
    if (step === 0 && companyName.trim() === '') {
      setFieldErrors({ companyName: 'اسم المتجر مطلوب' });
      return;
    }
    if (step === 2 && !/^\d{4,6}$/.test(pin)) {
      setPinError(ar.onboarding.pin.tooShort);
      return;
    }
    clearErrors();
    setPhase({ kind: 'steps', step: Math.min(step + 1, TOTAL_STEPS - 1) });
  };

  const finish = async () => {
    if (!validateAll()) {
      // أعد المستخدم لأول خطوة ناقصة
      if (fieldErrors.companyName) setPhase({ kind: 'steps', step: 0 });
      else if (fieldErrors.pin) setPhase({ kind: 'steps', step: 2 });
      return;
    }
    setPhase({ kind: 'saving' });
    try {
      const db = await getDb();
      await completeOnboarding(db, {
        companyName: companyName.trim(),
        phone: phone.trim() || undefined,
        whatsapp: whatsapp.trim() || undefined,
        address: address.trim() || undefined,
        baseCurrencyCode: currency,
        pin,
      });
      // إقلاع الجلسة الجديد ثم دخول مباشر بالرمز الذي اختاره (AC-24: بلا خطوة دخول إضافية)
      await session.boot();
      await session.login(pin);
      session.showFlash(ar.onboarding.success);
      router.replace('/');
    } catch (err) {
      setPhase({
        kind: 'failed',
        technical: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  };

  const retrySave = () => {
    if (!validateAll()) {
      setPhase({ kind: 'steps', step: 0 });
      return;
    }
    void finish();
  };

  return (
    <SafeScreen scroll={phase.kind !== 'welcome'} offline>
      {phase.kind === 'welcome' ? (
        <WelcomeSlides
          dot={dot}
          onDot={setDot}
          onStart={() => setPhase({ kind: 'steps', step: 0 })}
        />
      ) : phase.kind === 'saving' ? (
        <AppCard>
          <LoadingState variant="report" rows={4} label={ar.onboarding.saving} />
        </AppCard>
      ) : phase.kind === 'failed' ? (
        <AppCard noPadding>
          <ErrorState
            message={ar.errors.onboardingSave}
            technical={phase.technical}
            onRetry={retrySave}
          />
        </AppCard>
      ) : (
        <StepBody
          step={phase.step}
          companyName={companyName}
          phone={phone}
          whatsapp={whatsapp}
          address={address}
          currency={currency}
          pin={pin}
          fieldErrors={fieldErrors}
          pinError={pinError}
          setCompanyName={(v) => {
            setCompanyName(v);
            if (fieldErrors.companyName) clearErrors();
          }}
          setPhone={setPhone}
          setWhatsapp={setWhatsapp}
          setAddress={setAddress}
          setCurrency={(c) => setCurrency(c)}
          onOpenPinSheet={() => {
            setPinError(null);
            setPinSheetVisible(true);
          }}
          onPinChange={(p) => {
            setPin(p);
            if (pinError) setPinError(null);
          }}
          onNext={() => nextFrom(phase.step)}
          onBack={() => setPhase({ kind: 'steps', step: Math.max(phase.step - 1, 0) })}
          onFinish={finish}
        />
      )}

      {/* شيت إدخال الرمز: إدخال ثم تأكيد داخل نفس اللوحة */}
      <PinSheet
        visible={pinSheetVisible}
        existingPin={pin}
        onClose={() => setPinSheetVisible(false)}
        onDone={(finalPin) => {
          setPin(finalPin);
          setPinSheetVisible(false);
          setPinError(null);
        }}
      />
    </SafeScreen>
  );
}

/* ============================ شرائح الترحيب ============================ */

function WelcomeSlides({
  dot,
  onDot,
  onStart,
}: {
  dot: number;
  onDot: (i: number) => void;
  onStart: () => void;
}) {
  const { width: winW } = useWindowDimensions();
  // عرض الشريحة = عرض الشاشة − حشوة SafeScreen (16×2) حتى تطابق صفحات التمرير
  const slideWidth = Math.max(280, winW - 32);
  return (
    <View style={styles.welcomeWrap}>
      {/* الهيدر */}
      <View style={styles.brandRow}>
        <View style={styles.brandIcon}>
          <ShoppingCart size={28} color={colors.accent} />
        </View>
        <Text style={styles.brandTitle}>{ar.onboarding.welcomeTitle}</Text>
        <Text style={styles.brandSub}>{ar.onboarding.welcomeSub}</Text>
      </View>

      {/* الشرائح */}
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => {
          const i = Math.round(e.nativeEvent.contentOffset.x / slideWidth);
          onDot(Math.max(0, Math.min(SLIDES.length - 1, i)));
        }}
        style={styles.slidesScroll}
        contentContainerStyle={styles.slidesContent}
      >
        {SLIDES.map((s, i) => (
          <View key={s.title} style={[styles.slide, { width: slideWidth }]}>
            <View style={styles.slideIcon}>
              <s.icon size={34} color={colors.accent} />
            </View>
            <Text style={styles.slideTitle}>{s.title}</Text>
            <Text style={styles.slideBody}>{s.body}</Text>
          </View>
        ))}
      </ScrollView>

      {/* النقاط */}
      <View style={styles.dotsRow} accessibilityRole="adjustable">
        {SLIDES.map((s, i) => (
          <View
            key={s.title}
            style={[styles.dot, i === dot && styles.dotActive, i > dot && styles.dotFuture]}
          />
        ))}
      </View>

      <PrimaryButton label={ar.onboarding.start} icon={ChevronRight} onPress={onStart} />
      <Text style={styles.welcomeFoot}>{ar.app.tagline}</Text>
    </View>
  );
}

/* ============================ جسم الخطوات ============================ */

function StepBody(props: {
  step: number;
  companyName: string;
  phone: string;
  whatsapp: string;
  address: string;
  currency: CurrencyCode;
  pin: string;
  fieldErrors: Record<string, string>;
  pinError: string | null;
  setCompanyName: (v: string) => void;
  setPhone: (v: string) => void;
  setWhatsapp: (v: string) => void;
  setAddress: (v: string) => void;
  setCurrency: (c: CurrencyCode) => void;
  onOpenPinSheet: () => void;
  onPinChange: (p: string) => void;
  onNext: () => void;
  onBack: () => void;
  onFinish: () => void;
}) {
  const step = props.step;
  const titles = [
    ar.onboarding.steps.company,
    ar.onboarding.steps.currency,
    ar.onboarding.steps.pin,
    ar.onboarding.steps.review,
  ];
  const hints = [
    ar.onboarding.steps.companyHint,
    ar.onboarding.steps.currencyHint,
    ar.onboarding.steps.pinNote,
    ar.onboarding.steps.reviewHint,
  ];

  return (
    <View style={styles.stepsWrap}>
      {/* رأس الخطوات */}
      <View style={styles.stepperRow}>
        <PrimaryButton
          label={ar.onboarding.back}
          tone="ghost"
          compact
          disabled={step === 0}
          onPress={props.onBack}
          style={styles.stepBackBtn}
        />
        <Text style={styles.stepperLabel}>
          {ar.onboarding.stepOf.replace('{n}', String(step + 1)).replace('{total}', String(TOTAL_STEPS))}
        </Text>
        <View style={styles.stepperSpacer} />
      </View>

      <AppCard>
        <Text style={styles.stepTitle}>{titles[step]}</Text>
        <Text style={styles.stepHint}>{hints[step]}</Text>

        {step === 0 ? (
          <View style={styles.fieldsCol}>
            <TextField
              label={ar.onboarding.fields.companyName}
              value={props.companyName}
              onChangeText={props.setCompanyName}
              placeholder={ar.onboarding.fields.companyNamePh}
              error={props.fieldErrors.companyName}
              autoFocus
              testID="onboarding-company-name"
              returnKeyType="next"
            />
            <TextField
              label={ar.onboarding.fields.phone}
              value={props.phone}
              onChangeText={props.setPhone}
              placeholder={ar.onboarding.fields.phonePh}
              keyboardType="phone-pad"
              testID="onboarding-phone"
            />
            <TextField
              label={ar.onboarding.fields.whatsapp}
              value={props.whatsapp}
              onChangeText={props.setWhatsapp}
              placeholder={ar.onboarding.fields.whatsappPh}
              keyboardType="phone-pad"
              hint={props.fieldErrors.whatsapp ?? null}
            />
            <TextField
              label={ar.onboarding.fields.address}
              value={props.address}
              onChangeText={props.setAddress}
              placeholder={ar.onboarding.fields.addressPh}
            />
          </View>
        ) : step === 1 ? (
          <View style={styles.currencyGrid}>
            {CURRENCIES.map((c) => (
              <CurrencyCard
                key={c.code}
                code={c.code}
                selected={props.currency === c.code}
                onPress={() => props.setCurrency(c.code)}
              />
            ))}
            <Text style={styles.currencyNote}>{ar.onboarding.steps.currencyNote}</Text>
          </View>
        ) : step === 2 ? (
          <View style={styles.pinStepCol}>
            <Text style={styles.pinNote}>{ar.onboarding.steps.pinNote}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={ar.onboarding.pin.openPad}
              onPress={props.onOpenPinSheet}
              style={({ pressed }) => [styles.pinBox, pressed && styles.pressed]}
            >
              <Text style={styles.pinBoxLabel}>{ar.onboarding.pin.dotsLabel}</Text>
              <View style={styles.pinDotsRow}>
                {Array.from({ length: 6 }, (_, i) => (
                  <View
                    key={i}
                    style={[
                      styles.pinDot,
                      i < props.pin.length && styles.pinDotFilled,
                      i >= 4 && styles.pinDotExtra,
                    ]}
                  />
                ))}
              </View>
              <Text style={styles.pinBoxAction}>{ar.onboarding.pin.openPad}</Text>
            </Pressable>
            <FieldError message={props.pinError} />
          </View>
        ) : (
          <ReviewList
            companyName={props.companyName}
            phone={props.phone}
            whatsapp={props.whatsapp}
            address={props.address}
            currency={props.currency}
            pin={props.pin}
          />
        )}
      </AppCard>

      {/* زر التنقل */}
      {step < TOTAL_STEPS - 1 ? (
        <PrimaryButton
          label={ar.onboarding.next}
          icon={ChevronRight}
          onPress={props.onNext}
          testID="onboarding-next"
        />
      ) : (
        <PrimaryButton
          label={ar.onboarding.finish}
          tone="success"
          icon={Check}
          onPress={props.onFinish}
          testID="onboarding-finish"
        />
      )}
    </View>
  );
}

/* ============================ بطاقة عملة ============================ */

function CurrencyCard({
  code,
  selected,
  onPress,
}: {
  code: CurrencyCode;
  selected: boolean;
  onPress: () => void;
}) {
  const names = ar.onboarding.currencyNames;
  const label =
    code === 'YER' ? names.YER : code === 'SAR' ? names.SAR : code === 'USD' ? names.USD : names.AED;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.currencyCard,
        selected && styles.currencyCardActive,
        pressed && styles.pressed,
      ]}
      testID={`currency-${code}`}
    >
      <Coins size={22} color={selected ? colors.accent : colors.textMuted} />
      <Text style={[styles.currencyName, selected && styles.currencyNameActive]}>{label}</Text>
      <Text style={styles.currencyCode}>{code}</Text>
      {selected ? (
        <View style={styles.currencyCheck}>
          <Check size={14} color={colors.onAccent} />
        </View>
      ) : null}
    </Pressable>
  );
}

/* ============================ قائمة المراجعة ============================ */

function ReviewList(props: {
  companyName: string;
  phone: string;
  whatsapp: string;
  address: string;
  currency: CurrencyCode;
  pin: string;
}) {
  const names = ar.onboarding.currencyNames;
  const currencyName =
    props.currency === 'YER'
      ? names.YER
      : props.currency === 'SAR'
        ? names.SAR
        : props.currency === 'USD'
          ? names.USD
          : names.AED;
  const rows: { label: string; value: string }[] = [
    { label: ar.onboarding.review.company, value: props.companyName || '—' },
    ...(props.phone ? [{ label: ar.onboarding.review.phone, value: props.phone }] : []),
    ...(props.whatsapp ? [{ label: ar.onboarding.review.whatsapp, value: props.whatsapp }] : []),
    ...(props.address ? [{ label: ar.onboarding.review.address, value: props.address }] : []),
    { label: ar.onboarding.review.currency, value: `${currencyName} (${props.currency})` },
    { label: ar.onboarding.review.pin, value: '●'.repeat(Math.min(props.pin.length, 6)) },
    { label: ar.onboarding.review.tax, value: ar.onboarding.review.taxValue },
  ];
  return (
    <View style={styles.reviewCol}>
      {rows.map((r) => (
        <View key={r.label} style={styles.reviewRow}>
          <Text style={styles.reviewLabel}>{r.label}</Text>
          <Text style={styles.reviewValue} numberOfLines={1}>
            {r.value}
          </Text>
        </View>
      ))}
      <View style={styles.reviewAuto}>
        <Home size={16} color={colors.teal} />
        <Text style={styles.reviewAutoText}>{ar.onboarding.review.autoCreates}</Text>
      </View>
    </View>
  );
}

/* ============================ شيت الرمز ============================ */

/** إدخال PIN على مرحلتين داخل BottomSheet: كتابة ثم تأكيد */
function PinSheet({
  visible,
  existingPin,
  onClose,
  onDone,
}: {
  visible: boolean;
  /** رمز مثبت مسبقاً — يفتح مباشرة على مرحلة التأكيد */
  existingPin: string;
  onClose: () => void;
  onDone: (pin: string) => void;
}) {
  const [stage, setStage] = useState<'first' | 'confirm'>('first');
  const [value, setValue] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const first = useRef('');

  // عند الفتح: نبدأ من الصفر — أو على مرحلة التأكيد مباشرة إن وُجد رمز مثبّت
  useEffect(() => {
    if (visible) {
      const hasPin = existingPin.length >= 4;
      setStage(hasPin ? 'confirm' : 'first');
      setValue('0');
      setError(null);
      first.current = hasPin ? existingPin : '';
    }
  }, [visible, existingPin]);

  const label =
    stage === 'first' ? ar.onboarding.pin.chooseLabel : ar.onboarding.pin.confirmLabel;

  const done = () => {
    const v = value === '0' ? '' : value;
    if (!/^\d{4,6}$/.test(v)) {
      setError(ar.onboarding.pin.tooShort);
      return;
    }
    if (stage === 'first') {
      first.current = v;
      setStage('confirm');
      setValue('0');
      setError(null);
      return;
    }
    if (v !== first.current) {
      setError(ar.onboarding.pin.mismatch);
      setStage('first');
      setValue('0');
      first.current = '';
      return;
    }
    onDone(v);
    // إعادة تهيئة للفتح القادم
    setStage('first');
    setValue('0');
    setError(null);
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={ar.onboarding.steps.pin}
      testID="pin-sheet"
    >
      <Text style={styles.pinSheetNote}>{ar.onboarding.steps.pinNote}</Text>
      <NumberPad
        value={value}
        onChange={setValue}
        allowDecimal={false}
        decimals={0}
        label={label}
        secure
        onDone={done}
      />
      {error ? <FieldError message={error} /> : null}
    </BottomSheet>
  );
}

/* ============================ الأنماط ============================ */

const styles = StyleSheet.create({
  welcomeWrap: {
    flex: 1,
    paddingTop: spacing.xxl,
    gap: spacing.lg,
  },
  brandRow: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  brandIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(34, 211, 238, 0.12)',
  },
  brandTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 26,
    lineHeight: 36,
    textAlign: 'center',
  },
  brandSub: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  slidesScroll: {
    flexGrow: 0,
  },
  slidesContent: {
    flexDirection: 'row', // RTL: تنقلب الجهة تلقائياً
  },
  slide: {
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
  },
  slideIcon: {
    width: 84,
    height: 84,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(34, 211, 238, 0.10)',
    marginBottom: spacing.sm,
  },
  slideTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 20,
    lineHeight: 28,
    textAlign: 'center',
  },
  slideBody: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
  },
  dotActive: {
    backgroundColor: colors.accent,
    width: 22,
  },
  dotFuture: {
    opacity: 0.6,
  },
  welcomeFoot: {
    color: colors.textFaint,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },

  stepsWrap: {
    gap: spacing.lg,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touch.min,
  },
  stepBackBtn: {
    flex: 0,
    minWidth: 92,
  },
  stepperLabel: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  stepperSpacer: {
    minWidth: 92,
  },
  stepTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 18,
    lineHeight: 26,
  },
  stepHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
    marginBottom: spacing.md,
  },
  fieldsCol: {
    gap: spacing.md,
  },
  currencyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  currencyCard: {
    width: '48%',
    flexGrow: 1,
    minHeight: 92,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: spacing.md,
  },
  currencyCardActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(34, 211, 238, 0.10)',
  },
  currencyName: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  currencyNameActive: {
    color: colors.accent,
    fontFamily: font.bold,
  },
  currencyCode: {
    color: colors.textFaint,
    fontFamily: font.numeric,
    fontVariant: ['tabular-nums'],
    fontSize: 12,
    lineHeight: 17,
  },
  currencyCheck: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  currencyNote: {
    flexBasis: '100%',
    color: colors.warning,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    paddingTop: spacing.xs,
  },
  pinStepCol: {
    gap: spacing.md,
  },
  pinNote: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  pinBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  pinBoxLabel: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  pinDotsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  pinDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  pinDotFilled: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  pinDotExtra: {
    opacity: 0.55,
  },
  pinBoxAction: {
    color: colors.accent,
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 19,
  },
  reviewCol: {
    gap: spacing.sm,
  },
  reviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 40,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.xs,
  },
  reviewLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  reviewValue: {
    flex: 1,
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'left',
  },
  reviewAuto: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    backgroundColor: 'rgba(45, 212, 191, 0.10)',
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  reviewAutoText: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  pinSheetNote: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.8,
  },
});
