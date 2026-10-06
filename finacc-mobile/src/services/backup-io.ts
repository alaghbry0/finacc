/**
 * backup-io.ts — تسليم ملفات النسخة على المنصات الأصلية (الملف الأساس).
 *
 * ⚠️ مسار الجهاز (Android/iOS): تنزيل/اختيار الملفات يتطلب expo-file-system
 * وexpo-document-picker (وحدات أصلية غير مثبتة في هذا المستودع — قانون «لا
 * حزم جديدة») → **مسار EAS Build الأصلي مؤجَّل إلى V1.1 وموثَّق في سجل العمل**.
 * حتى إصدار EAS: هذه الدوال ترمي رسالة عربية صادقة (لا تُخفي الفشل ولا
 * تدّعي النجاح) — والويب (backup-io.web.ts) يعمل كاملاً الآن: تنزيل Blob
 * + منتقي ملفات، والمشاركة عبر النظام (FR-11-08) من الملف المُنزَّل.
 *
 * metro يحل الامتداد .web.ts قبل هذا الملف على الويب — نفس استراتيجية
 * print-platform.ts (المهمة 7).
 */
import { DomainRuleError } from '@/domain/errors';

const NATIVE_PENDING_MESSAGE =
  'حفظ ملف النسخة على الجهاز يصل مع إصدار التطبيق الأصلي (EAS Build) — ' +
  'استخدم التطبيق على الويب الآن: النسخ والاستعادة يعملان كاملين هناك';

/** تنزيل نص JSON كملف — الأصلي: مؤجَّل (يرمي رسالة صادقة) */
export async function downloadBackupFile(_fileName: string, _json: string): Promise<void> {
  void _fileName;
  void _json;
  throw new DomainRuleError('BACKUP_NATIVE_PENDING', NATIVE_PENDING_MESSAGE);
}

/** فتح منتقي ملفات وقراءة النسخة كنص — الأصلي: مؤجَّل (يرمي رسالة صادقة) */
export async function pickBackupFileText(): Promise<string> {
  throw new DomainRuleError('BACKUP_NATIVE_PENDING', NATIVE_PENDING_MESSAGE);
}
