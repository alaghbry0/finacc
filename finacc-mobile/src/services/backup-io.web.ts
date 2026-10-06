/**
 * backup-io.web.ts — تسليم ملفات النسخة على الويب (Blob download + file input).
 *
 *  - downloadBackupFile: Blob من نوع application/json + <a download> — يحفظ في
 *    مجلد تنزيلات المتصفح/النظام، ومنه يشاركه التاجر عبر واتساب/درايف/بلوتوث
 *    (FR-11-08 — بديل V1 المجاني للسحابة).
 *  - pickBackupFileText: <input type="file" accept=".json"> مخفي يُفتح برمجياً —
 *    بلا أي حزمة منتقي ملفات (قانون البيئة: لا حزم جديدة).
 */
export async function downloadBackupFile(fileName: string, json: string): Promise<void> {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // نمنح المتصفح لحظة لبدء التنزيل قبل تحرير الرابط
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export async function pickBackupFileText(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    let settled = false;
    const finish = (text: string | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(text);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      file
        .text()
        .then((text) => finish(text))
        .catch(() => finish(null));
    });
    // إلغاء المنتقي (المستخدم أغلقه بلا اختيار)
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
