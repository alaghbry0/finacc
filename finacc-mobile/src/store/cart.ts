/**
 * store/cart.ts — متجر سلة الفاتورة (بيع + شراء — zustand) — FR-02-13:
 *  - **مسودة السلة تُحفظ تلقائياً** عند كل تغيير (debounce 500ms) في storage
 *    محلي وتُستعاد بعد أي انهيار/إعادة تحميل مع علم `restored` (AC-23).
 *  - **Park (تعليق)**: السلة تُحفظ جانباً في storage محلي — ليست مستنداً
 *    (لا رقم ولا صف invoice — قرار 2) وتُستعاد من شريط «المعلّقات».
 *  - **نطاقان مستقلان (`scope`)**: سلة البيع (useCart) وسلة الشراء
 *    (usePurchaseCart) — كل واحدة بمفاتيح تخزين خاصة بها ومعلّقاتها
 *    الخاصة (مميّزة بـ `mode`) فيتعايشان جنباً إلى جنب دون تزاحم.
 *    حقل «الطرف» واحد (customer) يحمل العميل للبيع والمورّد للشراء —
 *    نفس الشكل {id, name}.
 *  - الحساب المعروض `computeCartTotals` يطابق رياضياً domain.computeInvoiceTotals
 *    حرفياً (نفس الترتيب والتقريب 4dp) — عرض فقط؛ **الدومين مصدر الحقيقة عند
 *    الحفظ** ويُعاد الحساب هناك داخل المعاملة.
 *
 *  - **نطاقان مستقلان (factory بنطاق scope)**: سلة البيع (useCart) وسلة
 *    الشراء (usePurchaseCart) — كل واحدة بمفاتيح تخزين مستقلة ومعلّقات
 *    خاصة بها (مميّزة بـ mode) فيتعايشان جنباً إلى جنب دون تزاحم. حقل
 *    «الطرف» (customer) يحمل العميل للبيع والمورّد للشراء — نفس {id, name}.
 * نقاء الحساب: decimal.js فقط. المتجر لا يستورد react-native.
 */
import { create } from 'zustand';
import { Decimal, d, f3, roundTo, sumD } from '@/utils/money';
import { STORE_KEYS, getItem, removeItem, setItem } from '@/services/local-store';

/* ============ الأنواع ============ */

/** سطر السلة — القيم خام نصي عشري كما تتوقعها Domain */
export interface CartLine {
  /** مفتاح مستقر للسطر (FlatList/التراجع) */
  key: string;
  productId: number | null;
  name: string;
  isService: boolean;
  unitPrice: string;
  qty: string;
  lineDiscountPercent: string;
  lineDiscountAmount: string;
  /** '' للبنود الخدمية؛ غيرها المتاح للعرض (يُنعش من القاعدة) */
  available: string;
  /** وصف حر للسطر الخدمي (productId=null) */
  lineDesc?: string;
}

/** الطرف في السلة (عميل للبيع / مورّد للشراء — نفس الشكل) */
export interface CartCustomer {
  id: number;
  name: string;
}

/** نطاق السلة — يميّز المعلّقات والمسودات بين البيع والشراء */
export type CartScope = 'sale' | 'purchase';

/** الصورة المُدمَّة للمسودة/المعلّقة (JSON في local-store) */
export interface CartSnapshot {
  customer: CartCustomer | null;
  cashboxId: number | null;
  currencyId: number | null;
  currencyCode: string | null;
  lines: CartLine[];
  invoiceDiscount: string;
  notesPrinted: string;
  notesInternal: string;
  savedAt: string;
}

export interface ParkedCart {
  id: string;
  at: string;
  cart: CartSnapshot;
  /** مميّز النطاق — سلال شراء معلّقة لا تظهر في شاشة البيع والعكس (V1.2) */
  mode: CartScope;
}

/** افتراضيات الجلسة الممررة من الشاشة (من store/session) */
export interface CartDefaults {
  cashboxId: number | null;
  currencyId: number | null;
  currencyCode: string | null;
}

export type CartTotals = {
  /** إجمالي كل سطر (صافي + ضريبة per_item) للعرض بجانب السطر */
  lines: {
    key: string;
    gross: string;
    discount: string;
    net: string;
    total: string;
  }[];
  subtotal: string;
  linesDiscount: string;
  invoiceDiscount: string;
  taxRate: string;
  taxAmount: string;
  total: string;
  /** true عندما صافي الفاتورة ≤ 0 — Domain سيرفض الحفظ (FR-02-05) */
  netInvalid: boolean;
};

/* ============ مساعدات ============ */

/** مفتاح فريد قصير (nanoid-بسيط بلا اعتمادية) */
function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function snapshotOf(s: CartStore): CartSnapshot {
  return {
    customer: s.customer,
    cashboxId: s.cashboxId,
    currencyId: s.currencyId,
    currencyCode: s.currencyCode,
    lines: s.lines,
    invoiceDiscount: s.invoiceDiscount,
    notesPrinted: s.notesPrinted,
    notesInternal: s.notesInternal,
    savedAt: new Date().toISOString(),
  };
}

/** هل السلة «فارغة» فعلاً؟ (لا شيء يستحق مسودة) */
function isEmptySnap(snap: CartSnapshot): boolean {
  return (
    snap.lines.length === 0 &&
    snap.customer === null &&
    d(snap.invoiceDiscount).isZero() &&
    snap.notesPrinted.trim() === '' &&
    snap.notesInternal.trim() === ''
  );
}

/* ============ الحساب المعروض — يطابق Domain حرفياً ============ */

/**
 * computeCartTotals — نسخة عرض من domain.computeInvoiceTotals:
 * نفس ترتيب العمليات والتقريب (roundTo 4dp، خصم البند مقيد بقيمته،
 * الضريبة on_total على القاعدة الصافية) حتى يطابق الرقم المعروض المحفوظ.
 */
export function computeCartTotals(
  cart: { lines: CartLine[]; invoiceDiscount: string },
  taxRate: string,
  taxMode: 'per_item' | 'on_total',
): CartTotals {
  // محاكاة computeLine (Domain) — سطر السلة لا يضبط ضريبة بند (taxPercent=0 دائماً
  // كما في LineInput الافتراضي)، فlineTax صفر في الوضعين والدومين يحسب نفس الشيء.
  const rows = cart.lines.map((l) => {
    const qty = d(l.qty);
    const unitPrice = d(l.unitPrice);
    const gross = roundTo(qty.times(unitPrice), 4);
    const pct = d(l.lineDiscountPercent === '' ? '0' : l.lineDiscountPercent);
    const amt = d(l.lineDiscountAmount === '' ? '0' : l.lineDiscountAmount);
    const pctAmt = roundTo(gross.times(pct).div(100), 4);
    const raw = pctAmt.plus(amt);
    const lineDiscount = raw.gt(gross) ? gross : raw;
    const lineNet = gross.minus(lineDiscount);
    const lineTax = new Decimal(0);
    return { key: l.key, gross, lineDiscount, lineNet, lineTotal: lineNet.plus(lineTax) };
  });

  const subtotal = roundTo(sumD(rows.map((r) => r.gross)), 4);
  const linesDiscount = roundTo(sumD(rows.map((r) => r.lineDiscount)), 4);
  const invoiceDiscount = roundTo(cart.invoiceDiscount === '' ? '0' : cart.invoiceDiscount, 4);
  const sumNet = sumD(rows.map((r) => r.lineNet));
  const taxableBase = sumNet.minus(invoiceDiscount);
  const netInvalid = taxableBase.lte(0);
  const taxAmount =
    taxMode === 'on_total'
      ? roundTo(taxableBase.times(d(taxRate)).div(100), 4)
      : roundTo(sumD(rows.map(() => new Decimal(0))), 4);
  const total = taxableBase.plus(taxAmount);

  return {
    lines: rows.map((r) => ({
      key: r.key,
      gross: r.gross.toFixed(4),
      discount: r.lineDiscount.toFixed(4),
      net: r.lineNet.toFixed(4),
      total: r.lineTotal.toFixed(4),
    })),
    subtotal: subtotal.toFixed(4),
    linesDiscount: linesDiscount.toFixed(4),
    invoiceDiscount: invoiceDiscount.toFixed(4),
    taxRate,
    taxAmount: taxAmount.toFixed(4),
    total: total.toFixed(4),
    netInvalid,
  };
}

/* ============ المتجر (عقد الواجهة) ============ */

export interface CartStore {
  hydrated: boolean;
  /** استُعيدت مسودة غير محفوظة — الشاشة تعرض Banner الاستعادة (AC-23) */
  restored: boolean;
  customer: CartCustomer | null;
  cashboxId: number | null;
  currencyId: number | null;
  currencyCode: string | null;
  lines: CartLine[];
  invoiceDiscount: string;
  notesPrinted: string;
  notesInternal: string;
  parked: ParkedCart[];

  /** تهيئة مرة واحدة (من شاشة البيع): تحميل المسودة والمعلّقات */
  hydrate: (defaults: CartDefaults) => void;
  markRestoredSeen: () => void;
  setCustomer: (c: CartCustomer | null) => void;
  setCashbox: (id: number) => void;
  setCurrency: (id: number, code: string) => void;
  /** إضافة صنف: موجود مسبقاً → +1 (سلوك الكاشير)؛ جديد → سطر كمية 1 */
  addItem: (p: {
    productId: number;
    name: string;
    isService: boolean;
    price: string;
    available?: string;
  }) => void;
  /** إعادة تسعير كل السطور من product_price بعد تغيير العملة */
  repriceLines: (prices: Map<number, string>, availability: Map<number, string>) => void;
  /** تحديث المتاح المعروض للبنود المخزنية */
  refreshAvailability: (availability: Map<number, string>) => void;
  setQty: (key: string, qty: string) => void;
  setPrice: (key: string, price: string) => void;
  setLineDiscount: (key: string, kind: 'percent' | 'amount', value: string) => void;
  /** يرجع السطر المحذوف وموضعه — للتراجع (DS-37) */
  removeLine: (key: string) => { line: CartLine; index: number } | null;
  insertLineAt: (line: CartLine, index: number) => void;
  setInvoiceDiscount: (v: string) => void;
  setNotes: (printed: string, internal: string) => void;
  /** مسح السلة كاملة (بعد الحفظ أو «مسح السلة») — يمحو المسودة */
  clearCart: () => void;
  /** تعليق السلة الحالية — يرجع المعلّقة الجديدة أو null إذا السلة فارغة */
  parkCart: () => ParkedCart | null;
  restoreParked: (id: string) => ParkedCart | null;
  deleteParked: (id: string) => void;
}

/* ============ المصنع — نطاقان بمفاتيح تخزين منفصلة ============ */

const PERSIST_DEBOUNCE_MS = 500;

function createCartStore(scope: CartScope) {
  const KEYS =
    scope === 'sale'
      ? { draft: STORE_KEYS.saleCartDraft, parked: STORE_KEYS.saleCartParked }
      : { draft: STORE_KEYS.purchaseCartDraft, parked: STORE_KEYS.purchaseCartParked };
  const store = create<CartStore>()((set, get) => ({
    hydrated: false,
    restored: false,
    customer: null,
    cashboxId: null,
    currencyId: null,
    currencyCode: null,
    lines: [],
    invoiceDiscount: '0',
    notesPrinted: '',
    notesInternal: '',
    parked: [],

    hydrate: (defaults) => {
      if (get().hydrated) return;
      const parked = getItem<ParkedCart[]>(KEYS.parked) ?? [];
      const draft = getItem<CartSnapshot>(KEYS.draft);
      set({ hydrated: true, parked });
      if (draft && !isEmptySnap(draft)) {
        set({
          customer: draft.customer,
          cashboxId: draft.cashboxId ?? defaults.cashboxId,
          currencyId: draft.currencyId ?? defaults.currencyId,
          currencyCode: draft.currencyCode ?? defaults.currencyCode,
          lines: draft.lines.map((l) => ({ ...l, key: l.key || uid() })),
          invoiceDiscount: draft.invoiceDiscount || '0',
          notesPrinted: draft.notesPrinted ?? '',
          notesInternal: draft.notesInternal ?? '',
          restored: true,
        });
        return;
      }
      set({
        cashboxId: defaults.cashboxId,
        currencyId: defaults.currencyId,
        currencyCode: defaults.currencyCode,
      });
    },

    markRestoredSeen: () => set({ restored: false }),

    setCustomer: (customer) => set({ customer }),

    setCashbox: (id) => set({ cashboxId: id }),

    setCurrency: (id, code) => set({ currencyId: id, currencyCode: code }),

    addItem: (p) => {
      const { lines } = get();
      const existing = lines.findIndex((l) => l.productId === p.productId);
      if (existing >= 0) {
        const line = lines[existing]!;
        const next = [...lines];
        next[existing] = { ...line, qty: f3(d(line.qty).plus(1)) };
        set({ lines: next });
        return;
      }
      const line: CartLine = {
        key: uid(),
        productId: p.productId,
        name: p.name,
        isService: p.isService,
        unitPrice: p.price === '' ? '0' : p.price,
        qty: '1',
        lineDiscountPercent: '0',
        lineDiscountAmount: '0',
        available: p.isService ? '' : p.available ?? '0',
      };
      set({ lines: [...lines, line] });
    },

    repriceLines: (prices, availability) => {
      set({
        lines: get().lines.map((l) => {
          if (l.productId === null) return l;
          const price = prices.get(l.productId);
          const avail = availability.get(l.productId);
          return {
            ...l,
            unitPrice: price !== undefined ? price : '0',
            available: l.isService ? '' : avail !== undefined ? avail : l.available,
          };
        }),
      });
    },

    refreshAvailability: (availability) => {
      set({
        lines: get().lines.map((l) =>
          l.isService || l.productId === null
            ? l
            : { ...l, available: availability.get(l.productId) ?? l.available },
        ),
      });
    },

    setQty: (key, qty) => {
      set({ lines: get().lines.map((l) => (l.key === key ? { ...l, qty } : l)) });
    },

    setPrice: (key, price) => {
      set({ lines: get().lines.map((l) => (l.key === key ? { ...l, unitPrice: price } : l)) });
    },

    setLineDiscount: (key, kind, value) => {
      set({
        lines: get().lines.map((l) => {
          if (l.key !== key) return l;
          return kind === 'percent'
            ? { ...l, lineDiscountPercent: value, lineDiscountAmount: '0' }
            : { ...l, lineDiscountAmount: value, lineDiscountPercent: '0' };
        }),
      });
    },

    removeLine: (key) => {
      const { lines } = get();
      const index = lines.findIndex((l) => l.key === key);
      if (index < 0) return null;
      const line = lines[index]!;
      const next = [...lines];
      next.splice(index, 1);
      set({ lines: next });
      return { line, index };
    },

    insertLineAt: (line, index) => {
      const next = [...get().lines];
      const at = Math.min(Math.max(index, 0), next.length);
      next.splice(at, 0, line);
      set({ lines: next });
    },

    setInvoiceDiscount: (invoiceDiscount) => set({ invoiceDiscount }),

    setNotes: (notesPrinted, notesInternal) => set({ notesPrinted, notesInternal }),

    clearCart: () => {
      removeItem(STORE_KEYS.saleCartDraft);
      set((s) => ({
        customer: null,
        lines: [],
        invoiceDiscount: '0',
        notesPrinted: '',
        notesInternal: '',
        cashboxId: s.cashboxId,
        currencyId: s.currencyId,
        currencyCode: s.currencyCode,
        restored: false,
      }));
    },

    parkCart: () => {
      const s = get();
      if (s.lines.length === 0) return null;
      const snap = snapshotOf(s);
      const parked: ParkedCart = { id: uid(), at: new Date().toISOString(), cart: snap, mode: scope };
      const next = [parked, ...s.parked];
      setItem(KEYS.parked, next);
      removeItem(KEYS.draft);
      set({
        customer: null,
        lines: [],
        invoiceDiscount: '0',
        notesPrinted: '',
        notesInternal: '',
        parked: next,
        restored: false,
      });
      return parked;
    },

    restoreParked: (id) => {
      const s = get();
      const found = s.parked.find((p) => p.id === id);
      if (!found) return null;
      const next = s.parked.filter((p) => p.id !== id);
      setItem(KEYS.parked, next);
      set({
        customer: found.cart.customer,
        cashboxId: found.cart.cashboxId ?? s.cashboxId,
        currencyId: found.cart.currencyId ?? s.currencyId,
        currencyCode: found.cart.currencyCode ?? s.currencyCode,
        lines: found.cart.lines.map((l) => ({ ...l, key: l.key || uid() })),
        invoiceDiscount: found.cart.invoiceDiscount || '0',
        notesPrinted: found.cart.notesPrinted ?? '',
        notesInternal: found.cart.notesInternal ?? '',
        parked: next,
      });
      return found;
    },

    deleteParked: (id) => {
      const next = get().parked.filter((p) => p.id !== id);
      setItem(KEYS.parked, next);
      set({ parked: next });
    },
  }));

  /* المسودة التلقائية لهذا النطاق فقط (debounce 500ms — FR-02-13) */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  store.subscribe(() => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistNow(scope), PERSIST_DEBOUNCE_MS);
  });
  return store;
}

/* ============ النطاقان (بيع/شراء) ============ */

/** سلة البيع — مفاتيح sale-cart (مسودة + معلّقات) */
export const useCart = createCartStore('sale');

/** سلة الشراء — مفاتيح purchase-cart مستقلة (مسودة + معلّقات بنمط purchase) */
export const usePurchaseCart = createCartStore('purchase');

/* ============ المسودة التلقائية (persistNow — تُستدعى من اشتراك المصنع) ============ */

function persistNow(scope: CartScope): void {
  const s = (scope === 'sale' ? useCart : usePurchaseCart).getState();
  if (!s.hydrated) return;
  const snap = snapshotOf(s);
  const KEYS =
    scope === 'sale'
      ? { draft: STORE_KEYS.saleCartDraft }
      : { draft: STORE_KEYS.purchaseCartDraft };
  if (isEmptySnap(snap)) {
    removeItem(KEYS.draft);
    return;
  }
  setItem(KEYS.draft, snap);
}
