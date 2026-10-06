/**
 * services/local-store.ts — مخزن محلي مفتاح/قيمة **متزامن** (Sync KV).
 *
 * الغرض (FR-02-13 / قرار 2): تخزين صور JSON صغيرة تخص الجلسة/الجهاز لا مستندات
 * القاعدة — مسودة سلة الفاتورة (استعادة الانهيار AC-23) والسلال المعلّقة (Park).
 * القاعدة (SQLite) مصدر حقيقة المستندات؛ هذا المخزن **مكمّل جهازي فقط**:
 *  - لا يُكتب فيه شيء لا يمكن فقدانه بأمان (المسودة/المعلّقات بيانات مؤقتة).
 *  - الفشل في الكتابة (نفاد الحصة مثلاً) لا يكسر التدفق — أفضل جهد.
 *
 * البيئة (قرار معاينة الويب): `localStorage` المتزامن هو الخلفية الطبيعية
 * على الويب؛ وفوق الأجهزة (مستقبلاً EAS) يُستبدل الخلف بـ MMKV/AsyncStorage
 * من داخل `getBackend()` وحدها — بقية الملف لا تعرف المنصة (NFR-09/11).
 * عند غياب أي خلفية (اختبارات bun بلا DOM) يعمل خلف ذاكرة مؤقت مع تحذير
 * واحد — حتى تُختبر الدوال مباشرة.
 *
 * نقاء: بلا react-native — قابل للاختبار بـ bun test مباشرة.
 * كل قيمة تُخزن JSON.stringify داخل مفتاح مسبوق «finacc.» لعزل التطبيق.
 */
import type { CartSnapshot, ParkedCart } from '@/store/cart';

/** مفاتيح المخزن — التطبيق كله يمر من هنا (لا نصوص سحرية خارج الملف) */
export const STORE_KEYS = {
  /** مسودة سلة البيع (استعادة الانهيار AC-23) */
  saleCartDraft: 'finacc.sale-cart.draft',
  /** سلال البيع المعلّقة (Park — قرار 2: ليست مستنداً) */
  saleCartParked: 'finacc.sale-cart.parked',
  /** مسودة سلة الشراء (نطاق مستقل — V1.2) */
  purchaseCartDraft: 'finacc.purchase-cart.draft',
  /** سلال الشراء المعلّقة (بنمط purchase مميّز) */
  purchaseCartParked: 'finacc.purchase-cart.parked',
} as const;

/** الخلفية الصغرى التي يحتاجها المخزن — localStorage فقط */
interface KvBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** خلف الذاكرة — احتياط الاختبارات/البيئات بلا DOM */
class MemoryBackend implements KvBackend {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let warnedOnce = false;

function getBackend(): KvBackend {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch {
    /* الوصول قد يرمي في سياقات مقفلة — نسقط للاحتياط */
  }
  if (!warnedOnce) {
    warnedOnce = true;
    // بلا console.error كي لا يظهر أخطاءً زائفة في معاينة الويب
    console.warn('[local-store] لا يوجد localStorage — خلف ذاكرة مؤقت (بيئة اختبار؟)');
  }
  return fallback;
}

/** الخلف الاحتياطي الوحيد للجلسة (حتى لا تُفقد الكتابات بين النداءين) */
const fallback = new MemoryBackend();

/* ============ الواجهة المتزامنة ============ */

/**
 * يقرأ قيمة JSON ويحلّها — null عند الغياب أو الفساد (يُنظّف المفتاح
 * الفاسد كي لا يبقى يحجب مسودة سليمة قادمة).
 */
export function getItem<T>(key: string): T | null {
  let raw: string | null = null;
  try {
    raw = getBackend().getItem(key);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    removeItem(key);
    return null;
  }
}

/** يكتب قيمة كـ JSON — أفضل جهد: فشل الكتابة لا يرمي (المسودة ليست حرجة) */
export function setItem(key: string, value: unknown): void {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return;
  }
  try {
    getBackend().setItem(key, raw);
  } catch {
    /* نفاد الحصة/وضع خاص — تجاهل صامت (موثق في الرأس) */
  }
}

/** يحذف مفتاحاً — لا يرمي أبداً */
export function removeItem(key: string): void {
  try {
    getBackend().removeItem(key);
  } catch {
    /* تجاهل */
  }
}

/* ============ مساعدات نمطية مطبَّعة ============ */

/** قراءة مسودة سلة بنطاقها — سكر نحوي فوق getItem */
export function readCartDraft(scope: 'sale' | 'purchase'): CartSnapshot | null {
  return getItem<CartSnapshot>(
    scope === 'sale' ? STORE_KEYS.saleCartDraft : STORE_KEYS.purchaseCartDraft,
  );
}

/** قراءة معلّقات سلة بنطاقها — تُرشَّح بنمطها كخط دفاع ثانٍ */
export function readParkedCarts(scope: 'sale' | 'purchase'): ParkedCart[] {
  const all = getItem<ParkedCart[]>(
    scope === 'sale' ? STORE_KEYS.saleCartParked : STORE_KEYS.purchaseCartParked,
  );
  if (!Array.isArray(all)) return [];
  return all.filter((p) => p && p.mode === scope && p.cart && Array.isArray(p.cart.lines));
}
