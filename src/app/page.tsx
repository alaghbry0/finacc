'use client';

import { useEffect, useState } from 'react';
import { Download, ShieldCheck, Smartphone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const PREVIEW_URL = '/rn/index.html';
const APK_URL = '/finacc-v1.0.0.apk';
const APK_META_URL = '/finacc-meta.json';
const PHONE_W = 430;
const PHONE_H = 932;

// FinAcc DS tokens (SRS §6.1)
const C = {
  bg: '#0F172A',
  card: '#1E293B',
  border: '#334155',
  accent: '#22D3EE',
  text: '#F1F5F9',
  muted: '#CBD5E1',
  success: '#34D399',
  warning: '#FBBF24',
};

type BuildState = 'checking' | 'ready' | 'missing';
type ApkMeta = { available: boolean; sizeMb?: number; builtAt?: string; version?: string };

export default function Page() {
  const [build, setBuild] = useState<BuildState>('checking');
  const [scale, setScale] = useState(1);
  const [apk, setApk] = useState<ApkMeta>({ available: false });

  // APK build status — يُقرأ من ملف تعريفي صغير بجانب الحزمة (يتحقّق كل 30 ثانية أثناء البناء)
  useEffect(() => {
    let alive = true;
    const check = () => {
      fetch(APK_META_URL, { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('no-meta'))))
        .then((meta: ApkMeta) => {
          if (alive) setApk(meta);
        })
        .catch(() => {
          if (alive) setApk({ available: false });
        });
    };
    check();
    const timer = window.setInterval(check, 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Build status — GET (not HEAD): the platform edge answers 403 to HEAD (skill law 1)
  useEffect(() => {
    let alive = true;
    fetch(PREVIEW_URL, { cache: 'no-store' })
      .then((res) => {
        if (alive) setBuild(res.ok ? 'ready' : 'missing');
      })
      .catch(() => {
        if (alive) setBuild('missing');
      });
    return () => {
      alive = false;
    };
  }, []);

  // Phone frame must always fit the viewport (transform scale, never crop)
  useEffect(() => {
    const fit = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const sidePanel = vw >= 1024 ? 336 + 24 : 0; // side panel + gap on lg+
      const reservedW = 48;
      const reservedH = 200; // header + footer + paddings
      const s = Math.min(
        1,
        (vh - reservedH) / PHONE_H,
        (vw - sidePanel - reservedW) / PHONE_W
      );
      setScale(Math.max(0.25, s));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const statusDot =
    build === 'ready' ? C.success : build === 'missing' ? C.warning : C.muted;

  return (
    <div
      dir="rtl"
      lang="ar"
      className="dark flex min-h-screen flex-col bg-[#0F172A]"
      style={{ color: C.text, fontFamily: 'system-ui, "Segoe UI", Tahoma, Arial, sans-serif' }}
    >
      {/* Sticky header */}
      <header className="sticky top-0 z-40 border-b bg-[#0F172A]/90 backdrop-blur" style={{ borderColor: C.border }}>
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold"
              style={{ background: `linear-gradient(135deg, #06B6D4, #0EA5E9)`, color: '#0F172A' }}
              aria-hidden
            >
              م
            </div>
            <div className="leading-tight">
              <h1 className="text-lg font-bold">المُحاسِب الشخصي</h1>
              <p className="text-xs" style={{ color: C.muted }}>
                FinAcc — نظام محاسبي ومخزون أوفلاين
              </p>
            </div>
          </div>
          <Badge
            className="gap-2 rounded-full px-3 py-1 text-xs"
            style={{ backgroundColor: 'rgba(34,211,238,0.12)', color: C.accent, border: `1px solid rgba(34,211,238,0.35)` }}
          >
            <span className="relative flex h-2 w-2" aria-hidden>
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                style={{ backgroundColor: C.accent }}
              />
              <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: C.accent }} />
            </span>
            معاينة مباشرة
          </Badge>
        </div>
      </header>

      {/* Main: phone frame + side panel */}
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center gap-6 p-4 lg:flex-row lg:p-6">
        {/* Phone frame (scales to viewport, never crops) */}
        <div
          className="relative shrink-0"
          style={{ width: PHONE_W * scale, height: PHONE_H * scale }}
          aria-label="إطار هاتف يحتوي معاينة التطبيق"
          role="img"
        >
          <div
            className="absolute top-0 left-0"
            style={{
              width: PHONE_W,
              height: PHONE_H,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          >
            <div
              className="relative rounded-[40px] p-2.5"
              style={{
                width: PHONE_W,
                height: PHONE_H,
                backgroundColor: '#020617',
                boxShadow:
                  '0 30px 60px -15px rgba(0,0,0,0.8), 0 0 0 1px rgba(51,65,85,0.6) inset',
              }}
            >
              {/* speaker bar / notch */}
              <div
                className="absolute top-[9px] left-1/2 z-10 h-[22px] w-[120px] -translate-x-1/2 rounded-full"
                style={{ backgroundColor: '#020617', boxShadow: '0 1px 0 rgba(51,65,85,0.8)' }}
                aria-hidden
              />
              {/* home indicator */}
              <div
                className="absolute bottom-[5px] left-1/2 z-10 h-[4px] w-[120px] -translate-x-1/2 rounded-full"
                style={{ backgroundColor: C.border }}
                aria-hidden
              />
              {/* screen */}
              <div
                className="relative h-full w-full overflow-hidden rounded-[32px]"
                style={{ backgroundColor: C.bg }}
              >
                <iframe
                  src={PREVIEW_URL}
                  title="معاينة تطبيق المُحاسِب الشخصي"
                  className="block h-full w-full border-0"
                />
                {build === 'missing' && (
                  <div
                    className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 p-6 text-center"
                    style={{ backgroundColor: C.bg }}
                  >
                    <p className="text-base font-bold" style={{ color: C.warning }}>
                      الحزمة غير مبنية بعد
                    </p>
                    <p className="text-sm" style={{ color: C.muted }}>
                      شغّل <code className="rounded px-1.5 py-0.5 text-xs" style={{ backgroundColor: C.card, color: C.accent }}>bash scripts/build-rn-web.sh</code> داخل
                      finacc-mobile ثم حدّث الصفحة
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Side info panel */}
        <aside className="order-2 w-full max-w-sm space-y-4 lg:order-1 lg:w-80">
          {/* ⬇︎ بطاقة تحميل APK — طلب المالك: رابط مباشر للتطبيق على أندرويد */}
          <Card
            className="rounded-2xl border"
            style={{
              backgroundColor: C.card,
              borderColor: apk.available ? 'rgba(52,211,153,0.45)' : C.border,
              color: C.text,
              boxShadow: apk.available ? '0 0 24px -8px rgba(52,211,153,0.35)' : undefined,
            }}
          >
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Smartphone size={18} style={{ color: C.success }} aria-hidden />
                تطبيق أندرويد (APK)
              </CardTitle>
              <CardDescription style={{ color: C.muted }}>
                {apk.available
                  ? `حزمة موقّعة جاهزة للتحميل والتثبيت المباشر${apk.version ? ` — الإصدار ${apk.version}` : ''}`
                  : 'جارٍ بناء حزمة أندرويد الموقّعة — تظهر هنا فور جهوزها'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {apk.available ? (
                <>
                  <Button
                    asChild
                    className="h-12 w-full gap-2 text-base font-bold"
                    style={{ backgroundColor: C.success, color: '#0F172A' }}
                  >
                    <a href={APK_URL} download="finacc-v1.0.0.apk">
                      <Download size={20} aria-hidden />
                      تحميل التطبيق الآن
                      {apk.sizeMb ? ` (~${apk.sizeMb} م.ب)` : ''}
                    </a>
                  </Button>
                  <div className="space-y-1.5 text-xs leading-5" style={{ color: C.muted }}>
                    <p className="flex items-center gap-1.5">
                      <ShieldCheck size={13} style={{ color: C.success }} aria-hidden />
                      متوافق مع Android 7.0 وأحدث · يعمل أوفلاين بالكامل
                    </p>
                    <p>
                      عند أول تثبيت فعّل «التثبيت من مصادر غير معروفة» من إعدادات الهاتف —
                      التطبيق لا يحتاج اتصالاً بالإنترنت إطلاقاً بعد التثبيت.
                    </p>
                    {apk.builtAt && (
                      <p dir="ltr" className="opacity-70">
                        Built: {apk.builtAt}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <div
                  className="flex items-center gap-3 rounded-xl border border-dashed p-3"
                  style={{ borderColor: C.border }}
                >
                  <span
                    className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-t-transparent"
                    style={{ borderColor: C.accent, borderTopColor: 'transparent' }}
                    aria-hidden
                  />
                  <p className="text-xs leading-5" style={{ color: C.muted }}>
                    حزمة AAB/APK قيد التجميع والتوقيع الآن — تُنشر الروابط هنا تلقائياً عند
                    الجهوزية (حدّث الصفحة أو انتظر لحظات).
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
          <Card
            className="rounded-2xl border"
            style={{ backgroundColor: C.card, borderColor: C.border, color: C.text }}
          >
            <CardHeader className="pb-3">
              <CardTitle className="text-base">حالة البناء</CardTitle>
              <CardDescription style={{ color: C.muted }}>
                فحص الحزمة المصدَّرة داخل public/rn
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-3">
              <span
                className={build === 'ready' ? 'animate-pulse h-3 w-3 rounded-full' : 'h-3 w-3 rounded-full'}
                style={{ backgroundColor: statusDot }}
                aria-hidden
              />
              <p className="text-sm font-medium">
                {build === 'ready' && 'الحزمة جاهزة'}
                {build === 'missing' && 'الحزمة غير مبنية بعد — شغّل build-rn-web.sh'}
                {build === 'checking' && 'جارٍ التحقق…'}
              </p>
            </CardContent>
          </Card>

          <Card
            className="rounded-2xl border"
            style={{ backgroundColor: C.card, borderColor: C.border, color: C.text }}
          >
            <CardHeader className="pb-3">
              <CardTitle className="text-base">روابط سريعة</CardTitle>
              <CardDescription style={{ color: C.muted }}>
                المعاينة الكاملة في تبويب مستقل
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                asChild
                className="w-full font-bold"
                style={{ backgroundColor: C.accent, color: '#0F172A' }}
              >
                <a href={PREVIEW_URL} target="_blank" rel="noreferrer">
                  فتح التطبيق في تبويب جديد
                </a>
              </Button>
              <p className="text-xs" style={{ color: C.muted }} dir="ltr">
                {PREVIEW_URL} · 430×932
              </p>
            </CardContent>
          </Card>

          <Card
            className="rounded-2xl border"
            style={{ backgroundColor: C.card, borderColor: C.border, color: C.text }}
          >
            <CardHeader className="pb-3">
              <CardTitle className="text-base">ملاحظات</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-7" style={{ color: C.muted }}>
                التطبيق يعمل أوفلاين 100% — المعاينة عبر اللوحة الجانبية، وزر «فتح في تبويب جديد»
                متاح أعلى اللوحة.
              </p>
            </CardContent>
          </Card>
        </aside>
      </main>

      {/* Footer pinned to bottom */}
      <footer
        className="mt-auto border-t bg-[#0F172A]/90"
        style={{ borderColor: C.border }}
      >
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 text-xs" style={{ color: C.muted }}>
          <span>FinAcc — المُحاسِب الشخصي · معاينة محلية بلا شبكة</span>
          <span dir="ltr">React Native + Expo · Expo SDK 54</span>
        </div>
      </footer>
    </div>
  );
}
