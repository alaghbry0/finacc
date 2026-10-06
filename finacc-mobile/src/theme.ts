/**
 * theme.ts — توكنز نظام التصميم الكاملة (SRS §6.1/§6.2 — DS-01→DS-15) + ثيم Paper MD3.
 *
 * المصدر الوحيد للحقيقة البصرية: كل مكون يقرأ الألوان/الحشوات/الأنصاف من هنا.
 * دلالات الألوان المحاسبية إلزامية (§6.1): أخضر=وارد/قبض/ربح، أحمر=صادر/دفع،
 * كهرماني=آجل/مستحق، رمادي=معلّق — وتقترن دائماً بعلامة غير لونية (سهم/إشارة/نص).
 */
import { MD3DarkTheme, type MD3Theme } from 'react-native-paper';

/* ============ الألوان — الداكن الافتراضي (DS-01→DS-10) ============ */
export const colors = {
  /** خلفية الشاشة (DS-01) */
  bg: '#0F172A',
  /** خلفية البطاقات (DS-02) */
  card: '#1E293B',
  /** حدود/فواصل (DS-03) */
  border: '#334155',
  /** اللون التمييزي الأساسي (DS-04) */
  accent: '#22D3EE',
  /** نص على اللون التمييزي — داكن دائماً */
  onAccent: '#0F172A',
  /** تدرّج الهيدر/الشعار (DS-05) */
  gradientFrom: '#06B6D4',
  gradientTo: '#0EA5E9',
  /** نجاح/قبض/وارد (DS-06) */
  success: '#34D399',
  /** خطأ/صرف/منتهي (DS-07) */
  danger: '#F87171',
  /** تحذير/آجل/مستحق (DS-08) */
  warning: '#FBBF24',
  /** مختلط (حالة نقد+آجل) — تيل فاتح */
  teal: '#2DD4BF',
  /** نص أساسي (DS-09) */
  text: '#F1F5F9',
  /** نص ثانوي/تسميات (DS-10 — رُفع في v1.2 لتباين ≥ 7:1) */
  textMuted: '#CBD5E1',
  /** نص خافت — العناصر المعطلة والتفاصيل التقنية (فوق الحد الأدنى 12px فقط) */
  textFaint: '#94A3B8',
  /** معلّق/مسودة (قاعدة دلالة §6.1) */
  pending: '#64748B',
} as const;

export type AppColors = typeof colors;

/* ============ الثيم الفاتح (DS-11 — «يتبع النظام» يُفعَّل لاحقاً) ============ */
export const lightColors = {
  bg: '#F8FAFC',
  card: '#FFFFFF',
  border: '#E2E8F0',
  accent: '#0891B2',
  onAccent: '#FFFFFF',
  gradientFrom: '#06B6D4',
  gradientTo: '#0EA5E9',
  success: '#059669',
  danger: '#DC2626',
  warning: '#D97706',
  teal: '#0D9488',
  text: '#0F172A',
  textMuted: '#334155',
  textFaint: '#64748B',
  pending: '#64748B',
} as const;

/* ============ الحشوات والأنصاف ============ */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
} as const;

/** أنصاف الأقطار: بطاقة 16 (DS-17) / زر 12 (DS-20) / شيت 20 (DS-23) */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
} as const;

/** الحد الأدنى لأهداف اللمس (DS-29) */
export const touch = { min: 48 } as const;

/* ============ الخطوط (DS-12/DS-13) — أسماء الأسرة كما حُمّلت في الجذر ============ */
export const font = {
  /** Tajawal 400 — النص العادي */
  regular: 'Tajawal_400Regular',
  /** Tajawal 500 — التسميات والأزرار الثانوية */
  medium: 'Tajawal_500Medium',
  /** Tajawal 700 — العناوين */
  bold: 'Tajawal_700Bold',
  /** IBM Plex Sans Arabic 600 — المبالغ والأرقام (DS-18n) */
  numeric: 'IBMPlexSansArabic_600SemiBold',
} as const;

/* ============ المقياس الطباعي (DS-15) — الحد الأدنى المطلق 12px ============ */
export const type = {
  display: { fontSize: 28, lineHeight: 38 },
  title: { fontSize: 20, lineHeight: 28 },
  body: { fontSize: 15, lineHeight: 22 },
  caption: { fontSize: 13, lineHeight: 19 },
  micro: { fontSize: 12, lineHeight: 17 },
} as const;

export type TypeScale = typeof type;

/* ============ الظلال ============ */
export const shadow = {
  /** ظل البطاقة الخفيف (DS-17) */
  card: {
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  /** ظل الشيت/العائم (DS-23/DS-24) */
  floating: {
    shadowColor: '#000000',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
} as const;

/* ============ ثيم Paper MD3 (داكن) موزّع على ألوان DS ============ */
type PaperFontWeight = '400' | '500' | '700';

function paperFont(
  family: string,
  weight: PaperFontWeight,
  fontSize: number,
  lineHeight: number,
  letterSpacing = 0,
) {
  return { fontFamily: family, fontWeight: weight, fontSize, lineHeight, letterSpacing } as const;
}


/** مقاييس Paper كلها على عائلات التطبيق — لا حجم تحت 12 (DS-15) */
const paperFonts: MD3Theme['fonts'] = {
  default: { fontFamily: font.regular, fontWeight: '400', letterSpacing: 0 },
  displayLarge: paperFont(font.bold, '700', 28, 38),
  displayMedium: paperFont(font.bold, '700', 24, 32),
  displaySmall: paperFont(font.bold, '700', 22, 30),
  headlineLarge: paperFont(font.bold, '700', 24, 32),
  headlineMedium: paperFont(font.bold, '700', 20, 28),
  headlineSmall: paperFont(font.bold, '700', 18, 26),
  titleLarge: paperFont(font.bold, '700', 20, 28),
  titleMedium: paperFont(font.medium, '500', 17, 24),
  titleSmall: paperFont(font.medium, '500', 14, 20),
  bodyLarge: paperFont(font.regular, '400', 15, 22),
  bodyMedium: paperFont(font.regular, '400', 15, 22),
  bodySmall: paperFont(font.regular, '400', 12, 17),
  labelLarge: paperFont(font.medium, '500', 13, 18),
  labelMedium: paperFont(font.medium, '500', 12, 17),
  labelSmall: paperFont(font.regular, '400', 12, 17),
};

/** MD3 داكن بألوان DS — يُمرَّر إلى PaperProvider في جذر التطبيق */
export const paperTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: colors.accent,
    onPrimary: colors.onAccent,
    primaryContainer: 'rgba(34, 211, 238, 0.16)',
    onPrimaryContainer: colors.accent,
    secondary: colors.teal,
    onSecondary: colors.onAccent,
    secondaryContainer: 'rgba(45, 212, 191, 0.16)',
    onSecondaryContainer: colors.teal,
    tertiary: colors.warning,
    onTertiary: colors.onAccent,
    tertiaryContainer: 'rgba(251, 191, 36, 0.16)',
    onTertiaryContainer: colors.warning,
    error: colors.danger,
    onError: colors.onAccent,
    errorContainer: 'rgba(248, 113, 113, 0.16)',
    onErrorContainer: colors.danger,
    background: colors.bg,
    onBackground: colors.text,
    surface: colors.card,
    onSurface: colors.text,
    surfaceVariant: '#24334A',
    onSurfaceVariant: colors.textMuted,
    outline: colors.border,
    outlineVariant: colors.border,
    inverseSurface: colors.text,
    inverseOnSurface: colors.bg,
    inversePrimary: colors.accent,
    surfaceDisabled: 'rgba(30, 41, 59, 0.55)',
    onSurfaceDisabled: 'rgba(241, 245, 249, 0.35)',
    backdrop: 'rgba(2, 6, 23, 0.6)',
  },
  fonts: paperFonts,
};

/** خلفية معتمة فوق الشيت (BottomSheet) */
export const scrim = 'rgba(2, 6, 23, 0.65)';

/** أنواع درجات المبالغ (تُستخدم في AmountText/StatusChip) */
export type AmountTone = 'in' | 'out' | 'warning' | 'neutral' | 'success';

/** لون الدرجة — درجات in/out/out تُقرن دائماً بعلامة غير لونية في المكونات */
export function toneColor(tone: AmountTone): string {
  switch (tone) {
    case 'in':
    case 'success':
      return colors.success;
    case 'out':
      return colors.danger;
    case 'warning':
      return colors.warning;
    default:
      return colors.text;
  }
}
