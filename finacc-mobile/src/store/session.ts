/**
 * session.ts — متجر الجلسة (zustand): حالة التهيئة/الدخول/القفل + بيانات
 * المنشأة والافتراضيات (FR-12-05 + FR-13-01).
 *
 * دورة الحياة:
 *  - boot(): تفتح القاعدة → isOnboarded → تحميل company/الافتراضيات/سياسة
 *    القفل → ready=true. تهيئة موجودة = locked=true (الدخول إلزامي بعد كل إقلاع).
 *  - login(pin): عبر domain.auth.login — الأخطاء العربية تُرمى للمستدعي
 *    (شاشة الدخول تعرضها: محاولات متبقية/عدّاد القفل).
 *  - lock()/touch(): القفل التلقائي يعمل من الجذر (مؤقت 30 ثانية يقارن
 *    lastActivity مع security.autolock_minutes — FR-12-05).
 *  - flash: رسالة نجاح عابرة عبر حدود التنقل (شريط DS-37 في الجذر).
 */
import { create } from 'zustand';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { isOnboarded } from '@/domain/onboarding';
import { login as domainLogin } from '@/domain/auth';
import { getSecuritySettings, getSetting } from '@/domain/settings';
import { setNumeralsMode } from '@/utils/format';

export interface CompanyInfo {
  id: number;
  name: string;
  currencyId: number;
  /** نسبة الضريبة نصاً (TEXT) */
  taxRate: string;
  invoicePrefix: string;
}

export interface DefaultsInfo {
  warehouseId: number;
  cashboxId: number;
  baseCurrencyId: number;
  baseCurrencyCode: string;
}

export interface UserInfo {
  id: number;
  displayName: string;
}

interface CompanyRow {
  id: number;
  name: string;
  currency_id: number;
  tax_rate: string;
  invoice_prefix: string | null;
}

interface DefaultsRow {
  warehouse_id: number | null;
  cashbox_id: number | null;
  base_currency_id: number | null;
  base_currency_code: string | null;
}

async function loadCompany(): Promise<CompanyInfo | null> {
  const db = await getDb();
  const rows = await db.all<CompanyRow>(
    'SELECT id, name, currency_id, tax_rate, invoice_prefix FROM company ORDER BY id LIMIT 1',
  );
  const r = rows[0];
  return r
    ? {
        id: Number(r.id),
        name: r.name,
        currencyId: Number(r.currency_id),
        taxRate: r.tax_rate ?? '0',
        invoicePrefix: r.invoice_prefix ?? 'INV',
      }
    : null;
}

async function loadDefaults(): Promise<DefaultsInfo | null> {
  const db = await getDb();
  const rows = await db.all<DefaultsRow>(
    `SELECT (SELECT id FROM warehouse WHERE is_default = 1 ORDER BY id LIMIT 1) AS warehouse_id,
            (SELECT id FROM cashbox WHERE is_default = 1 ORDER BY id LIMIT 1) AS cashbox_id,
            (SELECT id FROM currency WHERE is_base = 1 LIMIT 1) AS base_currency_id,
            (SELECT code FROM currency WHERE is_base = 1 LIMIT 1) AS base_currency_code`,
  );
  const r = rows[0];
  if (!r || r.warehouse_id === null || r.cashbox_id === null || r.base_currency_id === null) {
    return null;
  }
  return {
    warehouseId: Number(r.warehouse_id),
    cashboxId: Number(r.cashbox_id),
    baseCurrencyId: Number(r.base_currency_id),
    baseCurrencyCode: r.base_currency_code ?? '',
  };
}

/** يطبّق نظام الأرقام المختار (display.numerals — ملحق هـ) على منسّقات العرض */
async function applyDisplaySettings(): Promise<void> {
  const db = await getDb();
  const numerals = await getSetting(
    db,
    'display.numerals',
    z.enum(['western', 'arabic_indic']),
    'western' as const,
  );
  setNumeralsMode(numerals);
}

export interface SessionState {
  /** اكتمل الإقلاع (القاعدة + القراءة) — قبلها تُعرض شاشة تحميل */
  ready: boolean;
  /** خطأ الإقلاع (نص تقني لشاشة الخطأ) */
  bootError: string | null;
  onboarded: boolean;
  user: UserInfo | null;
  company: CompanyInfo | null;
  defaults: DefaultsInfo | null;
  locked: boolean;
  /** آخر نشاط (ms) — يُغذّى من AppState/التفاعلات */
  lastActivity: number;
  /** دقائق الخمول قبل القفل التلقائي (ملحق هـ — افتراضي 5) */
  autolockMinutes: number;
  /** رسالة نجاح عابرة تُعرض من الجذر (DS-37) */
  flash: string | null;

  boot: () => Promise<void>;
  login: (pin: string) => Promise<void>;
  lock: () => void;
  touch: () => void;
  refreshCompany: () => Promise<void>;
  showFlash: (message: string) => void;
  clearFlash: () => void;
}

export const useSession = create<SessionState>((set, get) => ({
  ready: false,
  bootError: null,
  onboarded: false,
  user: null,
  company: null,
  defaults: null,
  locked: false,
  lastActivity: Date.now(),
  autolockMinutes: 5,
  flash: null,

  boot: async () => {
    set({ ready: false, bootError: null });
    try {
      const db = await getDb();
      const onboarded = await isOnboarded(db);
      if (!onboarded) {
        set({
          onboarded: false,
          company: null,
          defaults: null,
          user: null,
          locked: false,
          ready: true,
        });
        return;
      }
      const [company, defaults, security] = await Promise.all([
        loadCompany(),
        loadDefaults(),
        getSecuritySettings(db),
      ]);
      await applyDisplaySettings();
      set({
        onboarded: true,
        company,
        defaults,
        autolockMinutes: security.autolockMinutes,
        user: null,
        locked: true, // كل إقلاع جديد = مقفل (الدخول برمز PIN)
        lastActivity: Date.now(),
        ready: true,
      });
    } catch (err) {
      set({
        ready: true,
        bootError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  },

  login: async (pin: string) => {
    const db = await getDb();
    const user = await domainLogin(db, pin); // يرمي PinWrong/PinLocked للمستدعي
    set({ user: { id: user.id, displayName: user.displayName }, locked: false, lastActivity: Date.now() });
  },

  lock: () => {
    if (get().locked) return;
    set({ locked: true, user: null });
  },

  touch: () => {
    set({ lastActivity: Date.now() });
  },

  refreshCompany: async () => {
    const db = await getDb();
    const [company, defaults, security] = await Promise.all([
      loadCompany(),
      loadDefaults(),
      getSecuritySettings(db),
    ]);
    await applyDisplaySettings();
    set({ company, defaults, autolockMinutes: security.autolockMinutes });
  },

  showFlash: (message: string) => set({ flash: message }),
  clearFlash: () => set({ flash: null }),
}));
