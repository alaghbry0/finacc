/**
 * posting-map.ts — خريطة الترحيل الملزمة (ملحق و — قرار 7 / FR-09-02).
 *
 * «الدفتر المشتق المصغّر»: كل tx_type (cash_tx) وmovement_type (stock_movement)
 * يُرسم حصراً إلى طرفيه ضمن **9 حسابات نظام**: CASH/AR/AP/INV/COGS/EXP/EQ/FX/CHQ.
 * لا CoA ولا قيود يدوية في V1 — تقرير الأرباح (reports.ts) يُشتق **حصراً** عبر
 * هذه الخريطة (قانون 5.4-8: «لا يجوز لأي تقرير أن يجمع الحركات بمنطق خاص»).
 *
 * جدول ملحق و (السطر الملزم لكل نوع حركة):
 *  | النوع                        | الترحيل (مدين ← دائن)         | بند الأرباح            |
 *  | بيع مكتمل                    | — (يُقاس من الفواتير المكتملة) | المبيعات (+)           |
 *  | مرتجع بيع                    | INV ← COGS + AR/CASH يعكس     | مرتجع المبيعات (−) + يخصم COGS بتكلفة line_cost |
 *  | حركة مخزون بيع               | INV → COGS                    | COGS (+)               |
 *  | شراء نقدي                    | CASH → INV                    | — (أصل)                |
 *  | شراء آجل                     | AP → INV                      | — (أصل)                |
 *  | مرتجع شراء                   | INV → CASH/AP                 | — (أصل)                |
 *  | تسوية جرد — زيادة            | (adjustment) → INV            | زيادة جرد (+)          |
 *  | تسوية جرد — عجز              | INV → (adjustment)            | عجز جرد (−)            |
 *  | مصروف                        | CASH → EXP                    | مصاريف (−) — شاملة رواتب |
 *  | مسحوبات مالك                 | CASH → EQ                     | بند مستقل خارج المصاريف |
 *  | إيداع مالك (رأس مال)         | CASH → EQ                     | — (سطر رأس المال في حركة الشركة) |
 *  | قبض تحصيل من عميل            | AR → CASH                     | — (تسوية دين)          |
 *  | صرف دفع لمورد                | AP → CASH                     | — (تسوية دين)          |
 *  | تسوية بعملة مختلفة           | FX                            | فروق صرف ±             |
 *  | تحويل بين صندوقين بعملتين    | CASH → CASH + FX للفرق        | فروق صرف ±             |
 *  | استلام شيك وارد              | AR → CHQ                      | — (حتى التحصيل)        |
 *  | تحصيل شيك وارد (cleared)     | CHQ → CASH (+FX إن لزم)       | —                      |
 *  | ارتداد شيك وارد (bounced)    | CHQ → AR + CASH → EXP للرسم   | مصاريف (−) للرسم فقط   |
 *  | إصدار شيك صادر               | CHQ → AP                      | — (حتى الصرف)          |
 *  | صرف شيك صادر (cleared)       | CASH → CHQ                    | —                      |
 *
 * أنواع إضافية في مخطط DDL لم تذكرها صفاً صفاً (تُرسم بالمنطق نفسه — موثق):
 *  - حركات: opening (→INV أصل افتتاحي) · transfer_in/out (INV→INV بين مخزنين)
 *    · manual_adjust (تسوية يدوية = معاملة تسوية الجرد: زيادة/عجز).
 *  - نقدية: opening (→CASH مقابل EQ) · bank_deposit/withdraw (CASH→CASH — البنك
 *    ضمن حساب الصندوق والبنك) · employee_advance (CASH→AR سلفة مدينة)
 *    · commission_payout/salary_batch (CASH→EXP — قرار 7: «شاملة الرواتب
 *    والعمولات المصروفة»).
 *
 * نقاء الوحدة (NFR-09/11): بلا adapter وبلا React Native — بيانات مصفوفية
 * ومصنِّفات خالصة قابلة للاختبار المباشر (اختبار وحدة لكل صف — §10).
 */

/* ============================ الحسابات التسعة ============================ */

/** رموز حسابات النظام المشتق التسعة (ملحق و) */
export const POSTING_ACCOUNTS = [
  'CASH',
  'AR',
  'AP',
  'INV',
  'COGS',
  'EXP',
  'EQ',
  'FX',
  'CHQ',
] as const;

export type PostingAccount = (typeof POSTING_ACCOUNTS)[number];

/** طبيعة الحساب (ملحق و) — للعرض والتوثيق فقط */
export const ACCOUNT_NATURE: Readonly<Record<PostingAccount, string>> = {
  CASH: 'أصل — الصندوق والبنك (كل الصناديق مجتمعة)',
  AR: 'أصل — المدينون (عملاء)، لكل عملة على حدة',
  AP: 'التزام — الدائنون (موردون)، لكل عملة على حدة',
  INV: 'أصل — المخزون بقيمة WAC',
  COGS: 'قائمة أرباح — تكلفة المبيعات',
  EXP: 'قائمة أرباح — المصاريف (بفئاتها)',
  EQ: 'حقوق المالك — رأس المال + المسحوبات',
  FX: 'قائمة أرباح ± — فروق الصرف المحققة',
  CHQ: 'أصل/التزام مذكّر — شيكات تحت التحصيل/السحب (ذمة لا نقود)',
};

/* ============================ بنود قائمة الأرباح ============================ */

/** مفاتيح بنود الأرباح التي تغذيها الخريطة (FR-09-02 — الصيغة المصححة) */
export const PNL_FEEDS = [
  'sales',
  'salesReturns',
  'cogs',
  'returnsCost',
  'stockSurplus',
  'stockShortage',
  'expenses',
  'fxGainLoss',
  'ownerDraw',
] as const;

export type PnlFeedKey = (typeof PNL_FEEDS)[number];

/**
 * علامة تغذية الأرباح: قيمة البند وأثره الحسابي في الصيغة المصححة
 * (قرار 7): الربح = (المبيعات − مرتجع المبيعات) − (COGS − تكلفة المرتجع)
 * + زيادة الجرد − عجز الجرد − المصاريف ± فروق الصرف — والمسحوبات بند
 * مستقل خارجها (صافي ما بقي للمالك = الربح − المسحوبات).
 */
export const PNL_FEED_EFFECT: Readonly<Record<PnlFeedKey, 'add' | 'subtract' | 'signed' | 'separate'>> = {
  sales: 'add',
  salesReturns: 'subtract',
  cogs: 'subtract',
  returnsCost: 'add',
  stockSurplus: 'add',
  stockShortage: 'subtract',
  expenses: 'subtract',
  fxGainLoss: 'signed',
  ownerDraw: 'separate',
};

/* ============================ عقد صف الخريطة ============================ */

/** المصدر الذي يُصنَّف منه الصف */
export type PostingSource =
  | 'invoice' // مستندات الفوترة (doc_type)
  | 'cash_tx' // حركات الصندوق (tx_type)
  | 'stock_movement' // حركات المخزون (movement_type)
  | 'cheque'; // أحداث الشيكات (دورة الحياة)

/** مدخل التصنيف لصف نقدي (الأعمدة التي تعتمد عليها الخريطة) */
export interface CashTxBasis {
  txType: string;
  /** فرق الصرف المحقق المخزَّن (غير صفري على القبض/الصرف/التحويل المختلط) */
  fxGainLoss?: string;
}

/** مدخل التصنيف لحركة مخزون */
export interface MovementBasis {
  movementType: string;
  /** كمية موقّعة (موجبة وارد/سالب صادر) — تُبَّت اتجاه التسويات */
  qty?: string;
  /** سياق مستند الشراء: نقدي CASH→INV / آجل AP→INV (مختلط = CASH للجزء النقدي) */
  purchasePayStatus?: 'cash' | 'credit' | 'mixed';
  /** سياق مستند مرتجع الشراء: نقدي INV→CASH / آجل INV→AP */
  purchaseReturnPayStatus?: 'cash' | 'credit';
}

/** صف واحد من جدول الترحيل الملزم */
export interface PostingRow {
  /** مفتاح مستقر للاختبارات والمرجعية */
  key: string;
  /** وصف النوع كما في جدول ملحق و (بالعربية) */
  label: string;
  source: PostingSource;
  /** المفسر الخام (doc_type / tx_type / movement_type / حدث الشيك) */
  discriminator: string;
  /** الحساب المدين */
  debit: PostingAccount | null;
  /** الحساب الدائن */
  credit: PostingAccount | null;
  /** البند الذي تغذيه في الأرباح — null = لا يغذي الأرباح (أصل/تسوية) */
  pnlFeed: PnlFeedKey | null;
  /** تغذية FX إضافية عند وجود فرق صرف محقق على الصف */
  fxFeed: boolean;
  /** ملاحظة الربط بالملزم (سطر الجدول) */
  bindingNote: string;
}

/* ============================ الجدول الملزم ============================ */

/**
 * POSTING_MAP — جدول الترحيل الملزم (ملحق و) كبيانات مطبوعة.
 * الترتيب حرفياً كترتيب صفوف الجدول في الوثيقة، ثم الأنواع الإضافية
 * المشتقة بالمنطق نفسه (موثقة في bindingNote).
 */
export const POSTING_MAP: readonly PostingRow[] = [
  {
    key: 'sale_completed',
    label: 'بيع مكتمل (إجمالي المبيعات)',
    source: 'invoice',
    discriminator: 'sale',
    debit: null,
    credit: null,
    pnlFeed: 'sales',
    fxFeed: false,
    bindingNote: 'يُقاس مباشرة من الفواتير المكتملة — لا سطر ترحيل مزدوج',
  },
  {
    key: 'sale_return',
    label: 'مرتجع بيع',
    source: 'invoice',
    discriminator: 'sale_return',
    debit: 'INV',
    credit: 'COGS',
    pnlFeed: 'salesReturns',
    fxFeed: false,
    bindingNote: 'INV ← COGS + AR/CASH يُعكس — مرتجع المبيعات (−) ويخصم COGS بتكلفة line_cost',
  },
  {
    key: 'stock_movement_sale',
    label: 'حركة مخزون بيع',
    source: 'stock_movement',
    discriminator: 'sale',
    debit: 'COGS',
    credit: 'INV',
    pnlFeed: 'cogs',
    fxFeed: false,
    bindingNote: 'INV → COGS — COGS (+)',
  },
  {
    key: 'purchase_cash',
    label: 'شراء نقدي',
    source: 'stock_movement',
    discriminator: 'purchase',
    debit: 'INV',
    credit: 'CASH',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'CASH → INV — أصل، لا بند أرباح',
  },
  {
    key: 'purchase_credit',
    label: 'شراء آجل',
    source: 'stock_movement',
    discriminator: 'purchase',
    debit: 'INV',
    credit: 'AP',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'AP → INV — أصل، لا بند أرباح',
  },
  {
    key: 'purchase_return',
    label: 'مرتجع شراء',
    source: 'stock_movement',
    discriminator: 'purchase_return',
    debit: 'CASH',
    credit: 'INV',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'INV → CASH/AP — أصل (نقدي: المدين CASH، آجل: المدين AP) — لا بند أرباح',
  },
  {
    key: 'stocktake_adjust_increase',
    label: 'تسوية جرد — زيادة',
    source: 'stock_movement',
    discriminator: 'stocktake_adjust',
    debit: 'INV',
    credit: null,
    pnlFeed: 'stockSurplus',
    fxFeed: false,
    bindingNote: '(adjustment) → INV — زيادة جرد (+)',
  },
  {
    key: 'stocktake_adjust_shortage',
    label: 'تسوية جرد — عجز',
    source: 'stock_movement',
    discriminator: 'stocktake_adjust',
    debit: null,
    credit: 'INV',
    pnlFeed: 'stockShortage',
    fxFeed: false,
    bindingNote: 'INV → (adjustment) — عجز جرد (−)',
  },
  {
    key: 'cash_expense',
    label: 'مصروف',
    source: 'cash_tx',
    discriminator: 'expense',
    debit: 'EXP',
    credit: 'CASH',
    pnlFeed: 'expenses',
    fxFeed: false,
    bindingNote: 'CASH → EXP — مصاريف (−) شاملة الرواتب (بديل V1 لرسمها التفصيلي)',
  },
  {
    key: 'owner_draw',
    label: 'مسحوبات مالك',
    source: 'cash_tx',
    discriminator: 'owner_draw',
    debit: 'EQ',
    credit: 'CASH',
    pnlFeed: 'ownerDraw',
    fxFeed: false,
    bindingNote: 'CASH → EQ — بند مستقل خارج المصاريف («صافي ما بقي للمالك»)',
  },
  {
    key: 'capital_in',
    label: 'إيداع مالك (رأس مال)',
    source: 'cash_tx',
    discriminator: 'capital_in',
    debit: 'CASH',
    credit: 'EQ',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'CASH → EQ — سطر «رأس المال/الإيداعات» في حركة الشركة، ليس بند أرباح',
  },
  {
    key: 'receipt_customer',
    label: 'قبض تحصيل من عميل',
    source: 'cash_tx',
    discriminator: 'receipt',
    debit: 'CASH',
    credit: 'AR',
    pnlFeed: null,
    fxFeed: true,
    bindingNote: 'AR → CASH — تسوية دين ليست إيراداً؛ فرق الصرف المحقق (إن وجد) بند FX مستقل',
  },
  {
    key: 'payment_supplier',
    label: 'صرف دفع لمورد',
    source: 'cash_tx',
    discriminator: 'payment',
    debit: 'AP',
    credit: 'CASH',
    pnlFeed: null,
    fxFeed: true,
    bindingNote: 'AP → CASH — تسوية دين؛ فرق الصرف المحقق (إن وجد) بند FX مستقل',
  },
  {
    key: 'fx_settlement',
    label: 'تسوية بعملة مختلفة',
    source: 'cash_tx',
    discriminator: 'receipt|payment',
    debit: 'FX',
    credit: 'FX',
    pnlFeed: 'fxGainLoss',
    fxFeed: true,
    bindingNote: 'FX — فروق صرف ± من fx_gain_loss (قرار 8) على سند التسوية',
  },
  {
    key: 'box_transfer_fx',
    label: 'تحويل بين صندوقين بعملتين',
    source: 'cash_tx',
    discriminator: 'box_transfer',
    debit: 'CASH',
    credit: 'CASH',
    pnlFeed: null,
    fxFeed: true,
    bindingNote: 'CASH → CASH + FX للفرق — فروق صرف ± من فرق التحويل (FR-04-07)',
  },
  {
    key: 'cheque_received',
    label: 'استلام شيك وارد',
    source: 'cheque',
    discriminator: 'in:pending',
    debit: 'CHQ',
    credit: 'AR',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'AR → CHQ — ذمة تحت التحصيل حتى تُصفّى',
  },
  {
    key: 'cheque_in_cleared',
    label: 'تحصيل شيك وارد (cleared)',
    source: 'cheque',
    discriminator: 'in:cleared',
    debit: 'CASH',
    credit: 'CHQ',
    pnlFeed: null,
    fxFeed: true,
    bindingNote: 'CHQ → CASH (+FX إن لزم) — ليس إيراداً',
  },
  {
    key: 'cheque_in_bounced',
    label: 'ارتداد شيك وارد (bounced)',
    source: 'cheque',
    discriminator: 'in:bounced',
    debit: 'AR',
    credit: 'CHQ',
    pnlFeed: 'expenses',
    fxFeed: false,
    bindingNote: 'CHQ → AR + CASH → EXP للرسم — مصاريف (−) لرسم الارتداد فقط',
  },
  {
    key: 'cheque_issued',
    label: 'إصدار شيك صادر',
    source: 'cheque',
    discriminator: 'out:pending',
    debit: 'AP',
    credit: 'CHQ',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'CHQ → AP — يسدّد الدائن بذمة شيك حتى الصرف (المدين AP)',
  },
  {
    key: 'cheque_out_cleared',
    label: 'صرف شيك صادر (cleared)',
    source: 'cheque',
    discriminator: 'out:cleared',
    debit: 'CHQ',
    credit: 'CASH',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'CASH → CHQ — ليس مصروفاً',
  },
  /* ——— أنواع إضافية من DDL بالمنطق نفسه (موثقة) ——— */
  {
    key: 'movement_opening',
    label: 'رصيد مخزون افتتاحي',
    source: 'stock_movement',
    discriminator: 'opening',
    debit: 'INV',
    credit: null,
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'إضافة منطقية: أصل افتتاحي — لا بند أرباح',
  },
  {
    key: 'movement_transfer_in',
    label: 'تحويل مخزون وارد',
    source: 'stock_movement',
    discriminator: 'transfer_in',
    debit: 'INV',
    credit: 'INV',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'إضافة منطقية: INV → INV بين مخزنين — لا بند أرباح',
  },
  {
    key: 'movement_transfer_out',
    label: 'تحويل مخزون صادر',
    source: 'stock_movement',
    discriminator: 'transfer_out',
    debit: 'INV',
    credit: 'INV',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'إضافة منطقية: INV → INV بين مخزنين — لا بند أرباح',
  },
  {
    key: 'manual_adjust',
    label: 'تسوية يدوية (زيادة/عجز)',
    source: 'stock_movement',
    discriminator: 'manual_adjust',
    debit: 'INV',
    credit: null,
    pnlFeed: 'stockSurplus',
    fxFeed: false,
    bindingNote: 'إضافة منطقية: تسوية يدوية = معاملة تسوية الجرد (زيادة + / عجز − حسب إشارة qty)',
  },
  {
    key: 'cash_opening',
    label: 'رصيد صندوق افتتاحي',
    source: 'cash_tx',
    discriminator: 'opening',
    debit: 'CASH',
    credit: 'EQ',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'إضافة منطقية: أصل نقدي مقابل حقوق مالك — لا بند أرباح',
  },
  {
    key: 'bank_deposit',
    label: 'إيداع بنكي',
    source: 'cash_tx',
    discriminator: 'bank_deposit',
    debit: 'CASH',
    credit: 'CASH',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'إضافة منطقية: البنك ضمن حساب CASH — تنقّل داخلي بلا أرباح',
  },
  {
    key: 'bank_withdraw',
    label: 'سحب بنكي',
    source: 'cash_tx',
    discriminator: 'bank_withdraw',
    debit: 'CASH',
    credit: 'CASH',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'إضافة منطقية: البنك ضمن حساب CASH — تنقّل داخلي بلا أرباح',
  },
  {
    key: 'employee_advance',
    label: 'سلفة موظف',
    source: 'cash_tx',
    discriminator: 'employee_advance',
    debit: 'AR',
    credit: 'CASH',
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'إضافة منطقية: سلفة مدينة (مدينون) — ليست مصروفاً حتى تُصرف',
  },
  {
    key: 'commission_payout',
    label: 'صرف عمولة',
    source: 'cash_tx',
    discriminator: 'commission_payout',
    debit: 'EXP',
    credit: 'CASH',
    pnlFeed: 'expenses',
    fxFeed: false,
    bindingNote: 'إضافة منطقية: قرار 7 — العمولات المصروفة ضمن المصاريف',
  },
  {
    key: 'salary_batch',
    label: 'مسير رواتب',
    source: 'cash_tx',
    discriminator: 'salary_batch',
    debit: 'EXP',
    credit: 'CASH',
    pnlFeed: 'expenses',
    fxFeed: false,
    bindingNote: 'إضافة منطقية: قرار 7 — الرواتب المصروفة ضمن المصاريف (بديل V1)',
  },
] as const;

/* ============================ المصنِّفات ============================ */

/** نتيجة تصنيف صف واحد عبر الخريطة */
export interface PostingClassification {
  /** صف الخريطة المطابق (مرجعية الجدول الملزم) */
  row: PostingRow;
  debit: PostingAccount | null;
  credit: PostingAccount | null;
  pnlFeed: PnlFeedKey | null;
  /** يغذي بند فروق الصرف (fx_gain_loss غير صفري أو صف FX أصيل) */
  fxFeed: boolean;
}

const NOT_IN_MAP = (kind: string, value: string): PostingClassification => ({
  row: {
    key: `unknown_${kind}`,
    label: `نوع غير معروف (${value})`,
    source: kind === 'cash_tx' ? 'cash_tx' : 'stock_movement',
    discriminator: value,
    debit: null,
    credit: null,
    pnlFeed: null,
    fxFeed: false,
    bindingNote: 'خارج خريطة الترحيل — يرفضه الدومين قبل الوصول هنا',
  },
  debit: null,
  credit: null,
  pnlFeed: null,
  fxFeed: false,
});

function rowByKey(key: string): PostingRow {
  const row = POSTING_MAP.find((r) => r.key === key);
  if (!row) {
    // مستحيل بحكم الثوابت أعلاه — حارس النوع الصارم
    throw new Error(`POSTING_MAP row missing: ${key}`);
  }
  return row;
}

function hasFx(basis: { fxGainLoss?: string }): boolean {
  const fx = Number(basis.fxGainLoss ?? '0');
  return Number.isFinite(fx) && fx !== 0;
}

/**
 * يصنِّف حركة صندوق (cash_tx) إلى ترحيلها الملزم وبند الأرباح الذي تغذيه.
 * الإدخال خام (tx_type + fx_gain_loss) — الاستبعاد الموحد (is_voided=0 AND
 * reversal_of IS NULL) مسؤولية المستدعي (reports.ts يطبقه على مستوى SQL).
 */
export function postCashTx(tx: CashTxBasis): PostingClassification {
  const fx = hasFx(tx);
  switch (tx.txType) {
    case 'receipt':
      // قبض تحصيل من عميل: AR → CASH — تسوية دين؛ فرق الصرف (إن وجد) بند FX
      return { row: rowByKey('receipt_customer'), debit: 'CASH', credit: 'AR', pnlFeed: null, fxFeed: fx };
    case 'payment':
      // صرف دفع لمورد: AP → CASH — تسوية دين؛ فرق الصرف (إن وجد) بند FX
      return { row: rowByKey('payment_supplier'), debit: 'AP', credit: 'CASH', pnlFeed: null, fxFeed: fx };
    case 'expense':
      return { row: rowByKey('cash_expense'), debit: 'EXP', credit: 'CASH', pnlFeed: 'expenses', fxFeed: false };
    case 'owner_draw':
      // بند مستقل خارج المصاريف — «صافي ما بقي للمالك» (FR-09-02)
      return { row: rowByKey('owner_draw'), debit: 'EQ', credit: 'CASH', pnlFeed: 'ownerDraw', fxFeed: false };
    case 'capital_in':
      // سطر رأس المال في حركة الشركة — ليس بند أرباح إطلاقاً
      return { row: rowByKey('capital_in'), debit: 'CASH', credit: 'EQ', pnlFeed: null, fxFeed: false };
    case 'box_transfer':
      // CASH → CASH + FX للفرق (FR-04-07) — الفرق على شطر الصادر
      return { row: rowByKey('box_transfer_fx'), debit: 'CASH', credit: 'CASH', pnlFeed: null, fxFeed: fx };
    case 'opening':
      return { row: rowByKey('cash_opening'), debit: 'CASH', credit: 'EQ', pnlFeed: null, fxFeed: false };
    case 'bank_deposit':
      return { row: rowByKey('bank_deposit'), debit: 'CASH', credit: 'CASH', pnlFeed: null, fxFeed: false };
    case 'bank_withdraw':
      return { row: rowByKey('bank_withdraw'), debit: 'CASH', credit: 'CASH', pnlFeed: null, fxFeed: false };
    case 'employee_advance':
      return { row: rowByKey('employee_advance'), debit: 'AR', credit: 'CASH', pnlFeed: null, fxFeed: false };
    case 'commission_payout':
      return { row: rowByKey('commission_payout'), debit: 'EXP', credit: 'CASH', pnlFeed: 'expenses', fxFeed: false };
    case 'salary_batch':
      return { row: rowByKey('salary_batch'), debit: 'EXP', credit: 'CASH', pnlFeed: 'expenses', fxFeed: false };
    default:
      return NOT_IN_MAP('cash_tx', tx.txType);
  }
}

/**
 * يصنِّف حركة مخزون (stock_movement) إلى ترحيلها الملزم وبند الأرباح.
 *  - purchase: الطرف الدائن CASH نقدي / AP آجل (مختلط: CASH للشطر النقدي) — سياق الفاتورة.
 *  - purchase_return: INV → CASH نقدي / INV → AP آجل.
 *  - stocktake_adjust / manual_adjust: إشارة qty تحدد زيادة (→INV، بند +) أو عجز (INV→، بند −).
 */
export function postStockMovement(mv: MovementBasis): PostingClassification {
  const qty = Number(mv.qty ?? '1'); // غياب qty = موجب (افتراض الصف الوارد)
  const positive = Number.isFinite(qty) ? qty > 0 : true;
  switch (mv.movementType) {
    case 'sale':
      // INV → COGS — COGS (+)
      return { row: rowByKey('stock_movement_sale'), debit: 'COGS', credit: 'INV', pnlFeed: 'cogs', fxFeed: false };
    case 'sale_return':
      // INV ← COGS — حركة المرتجع تُدخل المخزون بتكلفته الأصلية، فتخصم COGS
      // بتكلفة line_cost (الجانب التكلفي من صف «مرتجع بيع» — جانب الإيراد من المستند)
      return { row: rowByKey('sale_return'), debit: 'INV', credit: 'COGS', pnlFeed: 'returnsCost', fxFeed: false };
    case 'purchase': {
      const row = mv.purchasePayStatus === 'credit' ? rowByKey('purchase_credit') : rowByKey('purchase_cash');
      // مختلط: الشطر النقدي CASH والآجل AP — المفتاح المرجعي للنقدي مع توثيق السياق
      return {
        row,
        debit: 'INV',
        credit: mv.purchasePayStatus === 'credit' ? 'AP' : 'CASH',
        pnlFeed: null,
        fxFeed: false,
      };
    }
    case 'purchase_return': {
      // INV → CASH/AP — نقدي: المدين CASH / آجل: المدين AP — أصل بلا بند أرباح
      const row = rowByKey('purchase_return');
      return {
        row,
        debit: mv.purchaseReturnPayStatus === 'credit' ? 'AP' : 'CASH',
        credit: 'INV',
        pnlFeed: null,
        fxFeed: false,
      };
    }
    case 'stocktake_adjust':
      return positive
        ? { row: rowByKey('stocktake_adjust_increase'), debit: 'INV', credit: null, pnlFeed: 'stockSurplus', fxFeed: false }
        : { row: rowByKey('stocktake_adjust_shortage'), debit: null, credit: 'INV', pnlFeed: 'stockShortage', fxFeed: false };
    case 'manual_adjust':
      // تسوية يدوية = معاملة تسوية الجرد (زيادة/عجز حسب الإشارة)
      return positive
        ? { row: rowByKey('manual_adjust'), debit: 'INV', credit: null, pnlFeed: 'stockSurplus', fxFeed: false }
        : { row: rowByKey('manual_adjust'), debit: null, credit: 'INV', pnlFeed: 'stockShortage', fxFeed: false };
    case 'transfer_in':
      return { row: rowByKey('movement_transfer_in'), debit: 'INV', credit: 'INV', pnlFeed: null, fxFeed: false };
    case 'transfer_out':
      return { row: rowByKey('movement_transfer_out'), debit: 'INV', credit: 'INV', pnlFeed: null, fxFeed: false };
    case 'opening':
      return { row: rowByKey('movement_opening'), debit: 'INV', credit: null, pnlFeed: null, fxFeed: false };
    default:
      return NOT_IN_MAP('stock_movement', mv.movementType);
  }
}

/**
 * يصنِّف مستند فاتورة (doc_type مكتمل) إلى ترحيله الملزم:
 *  - sale: يُقاس مباشرة (المبيعات +) — لا سطر مزدوج.
 *  - sale_return: INV ← COGS + AR/CASH يُعكس — مرتجع (−) + خصم COGS.
 *  - purchase/purchase_return: أصل (المخزون) — لا بند أرباح (سياق الدفع
 *    يحدد الطرف المقابل CASH/AP).
 */
export function postInvoiceDoc(
  docType: string,
  ctx: { payStatus?: 'cash' | 'credit' | 'mixed' } = {},
): PostingClassification {
  switch (docType) {
    case 'sale':
      return { row: rowByKey('sale_completed'), debit: null, credit: null, pnlFeed: 'sales', fxFeed: false };
    case 'sale_return':
      return { row: rowByKey('sale_return'), debit: 'INV', credit: 'COGS', pnlFeed: 'salesReturns', fxFeed: false };
    case 'purchase': {
      const credit = ctx.payStatus === 'credit' ? 'AP' : 'CASH';
      return {
        row: ctx.payStatus === 'credit' ? rowByKey('purchase_credit') : rowByKey('purchase_cash'),
        debit: 'INV',
        credit,
        pnlFeed: null,
        fxFeed: false,
      };
    }
    case 'purchase_return':
      return {
        row: rowByKey('purchase_return'),
        debit: ctx.payStatus === 'credit' ? 'AP' : 'CASH',
        credit: 'INV',
        pnlFeed: null,
        fxFeed: false,
      };
    default:
      return NOT_IN_MAP('invoice', docType);
  }
}

/**
 * يصنِّف حدث شيك من دورة حياته (اتجاه + حالة) إلى ترحيله الملزم.
 * @param direction 'in' وارد / 'out' صادر
 * @param status    pending/deposited/cleared/bounced/void
 */
export function postChequeEvent(direction: 'in' | 'out', status: string): PostingClassification {
  if (direction === 'in') {
    switch (status) {
      case 'pending':
      case 'deposited':
        // استلام شيك وارد: AR → CHQ (حتى التحصيل) — تحت التحصيل
        return { row: rowByKey('cheque_received'), debit: 'CHQ', credit: 'AR', pnlFeed: null, fxFeed: false };
      case 'cleared':
        // CHQ → CASH (+FX إن لزم)
        return { row: rowByKey('cheque_in_cleared'), debit: 'CASH', credit: 'CHQ', pnlFeed: null, fxFeed: true };
      case 'bounced':
        // CHQ → AR + CASH → EXP للرسم — مصاريف (−) للرسم فقط
        return { row: rowByKey('cheque_in_bounced'), debit: 'AR', credit: 'CHQ', pnlFeed: 'expenses', fxFeed: false };
      default:
        return NOT_IN_MAP('cheque', `in:${status}`);
    }
  }
  switch (status) {
    case 'pending':
    case 'deposited':
      // إصدار شيك صادر: CHQ → AP (حتى الصرف) — تحت السحب
      return { row: rowByKey('cheque_issued'), debit: 'CHQ', credit: 'AP', pnlFeed: null, fxFeed: false };
    case 'cleared':
      // صرف شيك صادر: CASH → CHQ
      return { row: rowByKey('cheque_out_cleared'), debit: 'CHQ', credit: 'CASH', pnlFeed: null, fxFeed: false };
    default:
      return NOT_IN_MAP('cheque', `out:${status}`);
  }
}
