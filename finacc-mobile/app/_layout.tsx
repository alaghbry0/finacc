/**
 * الجذر — الخطوط + RTL + PaperProvider + بوابة الإقلاع (قاعدة + جلسة) +
 * حارس التوجيه (تهيئة/دخول/تبويبات) + القفل التلقائي (FR-12-05) + وميض النجاح.
 *
 * آلة التوجيه (بعد session.boot):
 *  - !onboarded            → /onboarding (تهيئة أولى — FR-13-01)
 *  - onboarded && locked   → /login      (دخول PIN — FR-12-03)
 *  - onboarded && !locked  → (tabs)      — والوجود على onboarding/login يُصحَّح إلى /
 * القفل التلقائي: مؤقت كل 30 ثانية يقارن الخمول مع security.autolock_minutes،
 * وtouch() عند عودة التطبيق إلى الواجهة (AppState active) وعند أي تفاعل
 * (TouchOnInteraction على الجذر — إصلاح «خمول» FR-12-05).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { AppState, I18nManager } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Tajawal_400Regular,
  Tajawal_500Medium,
  Tajawal_700Bold,
} from '@expo-google-fonts/tajawal';
import { IBMPlexSansArabic_600SemiBold } from '@expo-google-fonts/ibm-plex-sans-arabic';
import { dbReady } from '@/db/client';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, paperTheme } from '@/theme';
import ErrorState from '@/components/ui/ErrorState';
import FeedbackBar from '@/components/ui/feedback';
import LoadingState from '@/components/ui/LoadingState';
import PrintPreviewModal from '@/components/PrintPreviewModal';

// RTL للوثيقة كلها — قبل أي رسم (قد يحذّر على الويب؛ بلا أثر)
try {
  I18nManager.forceRTL(true);
} catch {
  // ignore (web)
}

/** بوابة الإقلاع: قاعدة + جلسة — لا تُرسم التطبيق قبل جهوزيتهما */
function BootGate({ children }: { children: ReactNode }) {
  const boot = useSession((s) => s.boot);
  const ready = useSession((s) => s.ready);
  const bootError = useSession((s) => s.bootError);
  const [dbError, setDbError] = useState<string | null>(null);

  const run = () => {
    setDbError(null);
    dbReady()
      .then(() => boot())
      .then(async () => {
        // نسخة تلقائية صامتة عند الفتح إذا مضى المحدد (FR-11-04) — بلا انتظار:
        // تبني وتسجّل في سجل النسخ؛ الإشعار المحلي أصلي → مؤجل مع EAS (موثّق).
        try {
          const { getDb } = await import('@/db/client');
          const { maybeAutoBackup } = await import('@/services/backup');
          void maybeAutoBackup(await getDb());
        } catch {
          // صامتة بصدق — فشلها لا يعطل الإقلاع أبداً
        }
      })
      .catch((err: unknown) => {
        setDbError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      });
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(run, []);

  if (!ready) {
    return (
      <SafeAreaView style={styles.boot} edges={['top', 'bottom', 'left', 'right']}>
        <Text style={styles.bootTitle}>{ar.app.name}</Text>
        <Text style={styles.bootTagline}>{ar.app.tagline}</Text>
        <LoadingState variant="card" label={ar.common.loading} style={styles.bootSkeleton} />
      </SafeAreaView>
    );
  }
  const error = dbError ?? bootError;
  if (error) {
    return (
      <SafeAreaView style={styles.boot} edges={['top', 'bottom', 'left', 'right']}>
        <ErrorState message={ar.errors.dbBoot} technical={error} onRetry={run} />
      </SafeAreaView>
    );
  }
  return <>{children}</>;
}

/** حارس التوجيه — يعيد المستخدم إلى المسار الصحيح لحالة الجلسة */
function RouteGuard() {
  const router = useRouter();
  const segments = useSegments();
  const ready = useSession((s) => s.ready);
  const onboarded = useSession((s) => s.onboarded);
  const locked = useSession((s) => s.locked);

  useEffect(() => {
    if (!ready) return;
    const seg = segments[0] ?? '';
    if (!onboarded) {
      if (seg !== 'onboarding') router.replace('/onboarding');
    } else if (locked) {
      if (seg !== 'login') router.replace('/login');
    } else if (seg === 'onboarding' || seg === 'login') {
      router.replace('/');
    }
  }, [ready, onboarded, locked, segments, router]);

  return null;
}

/** القفل التلقائي + لمس النشاط عند العودة للتطبيق (FR-12-05) */
function AutolockWatcher() {
  useEffect(() => {
    const interval = setInterval(() => {
      const s = useSession.getState();
      if (s.ready && s.onboarded && !s.locked) {
        const idleMs = Date.now() - s.lastActivity;
        if (idleMs > s.autolockMinutes * 60_000) s.lock();
      }
    }, 30_000);
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') useSession.getState().touch();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, []);
  return null;
}

/**
 * TouchOnInteraction — إصلاح FR-12-05: «خمول» يعني غياب التفاعل لا مرور الوقت.
 * أي لمسة/نقرة في أي مكان بالتطبيق (مراقبة التقاط الاستجابة على الجذر — لا تسرق
 * الأحداث: تُعيد false دائماً) تُنعش lastActivity فيبقى التاجر يعمل بلا قفل
 * كل 5 دقائق. يبقى القفل بعد X دقيقة من آخر تفاعل حقيقي،AppState للعودة من الخلفية.
 */
function TouchOnInteraction({ children }: { children: ReactNode }) {
  const touch = useSession((s) => s.touch);
  return (
    <View
      style={styles.touchShell}
      onStartShouldSetResponderCapture={() => {
        touch();
        return false; // مراقب فقط — لا يعترض اللمسة
      }}
    >
      {children}
    </View>
  );
}

/** وميض النجاح عبر حدود التنقل (شريط DS-37 في الجذر) */
function RootFlash() {
  const flash = useSession((s) => s.flash);
  const clearFlash = useSession((s) => s.clearFlash);
  if (!flash) return null;
  return <FeedbackBar message={flash} onDismiss={clearFlash} durationMs={4500} />;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Tajawal_400Regular,
    Tajawal_500Medium,
    Tajawal_700Bold,
    IBMPlexSansArabic_600SemiBold,
  });

  if (!fontsLoaded) return null; // شاشة الإقلاع الأصلية للمضيف تظل ظاهرة هنا

  return (
    <PaperProvider theme={paperTheme}>
      <StatusBar style="light" />
      <BootGate>
        <RouteGuard />
        <AutolockWatcher />
        <TouchOnInteraction>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.bg },
              animation: 'fade_from_bottom',
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="onboarding" />
            <Stack.Screen name="login" />
            <Stack.Screen name="stub/[name]" />
          </Stack>
        </TouchOnInteraction>
        <RootFlash />
        {/* معاينة الطباعة (الويب) — فوق كل شيء، تفتحها خدمة الطباعة (المهمة 7) */}
        <PrintPreviewModal />
      </BootGate>
    </PaperProvider>
  );
}

const styles = StyleSheet.create({
  touchShell: {
    flex: 1,
  },
  boot: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 6,
  },
  bootTitle: {
    color: colors.text,
    fontFamily: 'Tajawal_700Bold',
    fontSize: 28,
    lineHeight: 38,
    textAlign: 'center',
  },
  bootTagline: {
    color: colors.textMuted,
    fontFamily: 'Tajawal_400Regular',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 12,
  },
  bootSkeleton: {
    alignSelf: 'stretch',
  },
});
