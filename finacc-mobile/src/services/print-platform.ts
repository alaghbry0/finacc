/**
 * print-platform.ts — تسليم الطباعة على الأصلي (Android/iOS) — الملف الأساس.
 *
 * استراتيجية المنصات (نفس وضع expo-sqlite في المهمة 2 — انقسام metro):
 *  - هذا الملف (الأساس) يستهلك expo-print ويُستعمل على Android/iOS فقط:
 *    printAsync({ html }) يفتح حوار طباعة النظام — يطبع عبر أي طابعة
 *    مضبوطة في أندرويد (بلوتوث/شبكة/خدمات الطباعة الافتراضية).
 *  - الويب يستخدم print-platform.web.ts (معاينة داخل التطبيق) — metro يحل
 *    الامتداد .web.ts قبل هذا الملف فلا يدخل expo-print حزمة الويب.
 *
 * expo-print مثبّت أصلاً في هذا المستودع (المهمة 1 — npx expo install
 * expo-print@~15.0.8) — الأوامر المرجعية لبناء جهاز المستخدم:
 *   npx expo install expo-print expo-sharing
 *
 * وضع الرستر ESC/POS (موديول BLE react-native-thermal-printer) هو خطوة
 * Dev/EAS Build أصلية بحسب SRS 3.5-1/AC-10 — مؤجل إلى V1.1 وموثّق.
 */
import { printAsync } from 'expo-print';

/**
 * يسلّم مستند HTML إلى طباعة النظام (الأصلي).
 * title للسياق فقط — حوار النظام لا يحتاجه.
 * يرمي عند فشل فتح حوار الطباعة — المستدعي (print.ts) يحوّلها لرسالة عربية.
 */
export async function deliverPrint(html: string, _title: string): Promise<void> {
  await printAsync({ html });
}
