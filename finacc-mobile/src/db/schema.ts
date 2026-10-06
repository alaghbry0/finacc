/**
 * FinAcc — المخطط الكامل لقاعدة البيانات (SRS §5.3 — DDL v1.2 ملزم).
 *
 * قواعد الترجمة (موثقة في سجل العمل):
 * 1. أسماء الجداول والأعمدة snake_case حرفياً كما في DDL — بلا أي تعديل.
 * 2. المبالغ/الكميات/الأسعار/النسب (NUMERIC(14,4) / NUMERIC(12,3) / NUMERIC(12,6) / NUMERIC(5,2)...)
 *    → نوع SQLite «TEXT» مع `.$type<string>()`: قيم نصية عشرية ثابتة (مثل "12500.0000")
 *    والحساب كله عبر decimal.js في طبقة Domain (SRS 5.2-3: لا Float أبداً).
 * 3. قيود CHECK على الأعمدة النصية تُكتب بصيغة CAST(... AS REAL) حتى تُقيَّم رقمياً على تخزين TEXT.
 * 4. الطوابع الزمنية نصوص ISO-8601 (created_at/updated_at/...) — $defaultFn حيث لا DEFAULT في DDL
 *    والتطبيق يُدخل القيمة.
 * 5. الأعلام 0/1 عبر integer({ mode: 'boolean' }).
 * 6. invoice.sales_rep_id و cash_tx.employee_id أعداد صحيحة بلا FK (مؤجلان V2/V1.1 — حرفياً كما في DDL).
 * 7. تريغرات audit_log (append-only) لا تُعبَّر في Drizzle — تُضاف يدوياً في ملف الهجرة SQL.
 */
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

/** مبلغ/كمية/سعر/نسبة — نص عشري دقيق (SRS 5.2-3). التخزين TEXT والقراءة string. */
const money = (name: string) => text(name).$type<string>();

/** طابع زمني ISO-8601 يُدخله التطبيق حين لا يوجد DEFAULT في DDL. */
const nowIso = () => new Date().toISOString();

/* ============ الترقيم الذري (قرار 6 / ملحق د) ============ */
export const docSequence = sqliteTable(
  'doc_sequence',
  {
    docType: text('doc_type').notNull(), // INV/PUR/SRN/PRN/RVT/PMT
    year: integer('year').notNull(),
    lastNo: integer('last_no').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.docType, t.year] })],
);

/* ============ المراجع الأساسية ============ */
export const company = sqliteTable('company', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  phone: text('phone'),
  whatsapp: text('whatsapp'),
  address: text('address'),
  logoPath: text('logo_path'),
  currencyId: integer('currency_id').notNull().references(() => currency.id),
  taxNumber: text('tax_number'),
  taxRate: money('tax_rate').notNull().default('0'),
  invoicePrefix: text('invoice_prefix').default('INV'),
  footerText: text('footer_text'),
  createdAt: text('created_at').$defaultFn(nowIso),
  updatedAt: text('updated_at').$defaultFn(nowIso),
  createdBy: integer('created_by'),
});

export const currency = sqliteTable('currency', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(), // YER, SAR, USD, AED
  name: text('name').notNull(),
  symbolSvg: text('symbol_svg'),
  isBase: integer('is_base', { mode: 'boolean' }).notNull().default(false),
  decimals: integer('decimals').notNull().default(2), // YER: 0
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
});

export const exchangeRate = sqliteTable(
  'exchange_rate',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    currencyId: integer('currency_id').notNull().references(() => currency.id),
    rateDate: text('rate_date').notNull(), // YYYY-MM-DD
    rate: money('rate').notNull(),
    source: text('source').default('manual'),
    createdAt: text('created_at').$defaultFn(nowIso),
    createdBy: integer('created_by'),
  },
  (t) => [
    unique('exchange_rate_currency_rate_date_unique').on(t.currencyId, t.rateDate),
    check('exchange_rate_rate_positive', sql`CAST(rate AS REAL) > 0`),
  ],
);

export const category = sqliteTable('category', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  parentId: integer('parent_id').references((): AnySQLiteColumn => category.id),
  sortOrder: integer('sort_order').default(0),
  isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').$defaultFn(nowIso),
  updatedAt: text('updated_at').$defaultFn(nowIso),
  createdBy: integer('created_by'),
});

export const unit = sqliteTable('unit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  baseUnitId: integer('base_unit_id').references((): AnySQLiteColumn => unit.id),
  factor: money('factor').default('1'),
  isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').$defaultFn(nowIso),
  updatedAt: text('updated_at').$defaultFn(nowIso),
  createdBy: integer('created_by'),
});

export const warehouse = sqliteTable('warehouse', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  location: text('location'),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').$defaultFn(nowIso),
  updatedAt: text('updated_at').$defaultFn(nowIso),
  createdBy: integer('created_by'),
});

export const cashbox = sqliteTable('cashbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  currencyId: integer('currency_id').notNull().references(() => currency.id),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').$defaultFn(nowIso),
  updatedAt: text('updated_at').$defaultFn(nowIso),
  createdBy: integer('created_by'),
});

export const expenseCategory = sqliteTable('expense_category', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').$defaultFn(nowIso),
  updatedAt: text('updated_at').$defaultFn(nowIso),
  createdBy: integer('created_by'),
});

/* ============ الفترات المحاسبية (قرار 6 + م5) ============ */
export const fiscalYear = sqliteTable(
  'fiscal_year',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    year: integer('year').notNull().unique(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    status: text('status').notNull().default('open'),
    closedAt: text('closed_at'),
    closedBy: integer('closed_by'),
    createdAt: text('created_at').$defaultFn(nowIso),
    updatedAt: text('updated_at').$defaultFn(nowIso),
  },
  (t) => [check('fiscal_year_status_enum', sql`status IN ('open','closed')`)],
);

/* ============ الأصناف والمخزون ============ */
export const product = sqliteTable(
  'product',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    barcode: text('barcode').unique(), // يبقى محجوزاً بعد الأرشفة
    categoryId: integer('category_id').references(() => category.id),
    unitId: integer('unit_id').references(() => unit.id),
    costPrice: money('cost_price').notNull().default('0'), // بالعملة الأساسية (WAC)
    minStock: money('min_stock').notNull().default('0'),
    isService: integer('is_service', { mode: 'boolean' }).notNull().default(false), // قرار 5
    trackBatches: integer('track_batches', { mode: 'boolean' }).notNull().default(false), // V1.1
    trackSerials: integer('track_serials', { mode: 'boolean' }).notNull().default(false),
    imagePath: text('image_path'),
    notes: text('notes'),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').$defaultFn(nowIso),
    updatedAt: text('updated_at').$defaultFn(nowIso),
    createdBy: integer('created_by'),
  },
  (t) => [index('idx_product_name').on(t.name), index('idx_product_barcode').on(t.barcode)],
);

export const productPrice = sqliteTable(
  'product_price', // سعر البيع لكل عملة
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id').notNull().references(() => product.id),
    currencyId: integer('currency_id').notNull().references(() => currency.id),
    price: money('price').notNull(),
    priceLevel: text('price_level').notNull().default('retail'), // V1: retail فقط (قرار 5)
    marginPercent: money('margin_percent').notNull().default('0'),
    updatedAt: text('updated_at'),
  },
  (t) => [
    unique('product_price_product_currency_level_unique').on(t.productId, t.currencyId, t.priceLevel),
    check('product_price_price_non_negative', sql`CAST(price AS REAL) >= 0`),
    check(
      'product_price_level_enum',
      sql`price_level IN ('retail','wholesale','credit')`,
    ),
  ],
);

export const stockLevel = sqliteTable(
  'stock_level',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id').notNull().references(() => product.id),
    warehouseId: integer('warehouse_id').notNull().references(() => warehouse.id),
    qty: money('qty').notNull().default('0'),
  },
  (t) => [
    unique('stock_level_product_warehouse_unique').on(t.productId, t.warehouseId),
    check('stock_level_qty_non_negative', sql`CAST(qty AS REAL) >= 0`), // قرار 9
  ],
);

export const stockMovement = sqliteTable(
  'stock_movement',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id').notNull().references(() => product.id),
    warehouseId: integer('warehouse_id').notNull().references(() => warehouse.id),
    movementType: text('movement_type').notNull(),
    qty: money('qty').notNull(), // موجب/سالب حسب النوع
    unitCost: money('unit_cost').notNull(), // كانت NULLable — ربح وهمي (إصلاح v1.2)
    refType: text('ref_type'),
    refId: integer('ref_id'),
    movedAt: text('moved_at').notNull(),
    notes: text('notes'),
    createdAt: text('created_at').$defaultFn(nowIso),
    createdBy: integer('created_by'),
  },
  (t) => [
    index('idx_move_product_date').on(t.productId, t.movedAt),
    index('idx_move_warehouse').on(t.warehouseId, t.movedAt),
    index('idx_move_ref').on(t.refType, t.refId),
    check(
      'stock_movement_type_enum',
      sql`movement_type IN ('purchase','sale','sale_return','purchase_return','stocktake_adjust','manual_adjust','transfer_in','transfer_out','opening')`,
    ),
    check('stock_movement_qty_nonzero', sql`CAST(qty AS REAL) <> 0`),
  ],
);

export const batch = sqliteTable(
  'batch', // بنية باقية؛ واجهات FEFO → V1.1
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id').notNull().references(() => product.id),
    warehouseId: integer('warehouse_id').notNull().references(() => warehouse.id),
    batchNumber: text('batch_number'),
    serialNumber: text('serial_number').unique(),
    expiryDate: text('expiry_date'),
    qty: money('qty').notNull().default('0'),
    isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
    createdAt: text('created_at').$defaultFn(nowIso),
    updatedAt: text('updated_at').$defaultFn(nowIso),
  },
  (t) => [index('idx_batch_product').on(t.productId, t.expiryDate)],
);

export const stocktake = sqliteTable('stocktake', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  warehouseId: integer('warehouse_id').notNull().references(() => warehouse.id),
  countedAt: text('counted_at').notNull(),
  totalDiff: money('total_diff').default('0'),
  status: text('status').default('completed'),
  notes: text('notes'),
  createdAt: text('created_at').$defaultFn(nowIso),
  createdBy: integer('created_by'),
});

export const stocktakeLine = sqliteTable('stocktake_line', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  stocktakeId: integer('stocktake_id').notNull().references(() => stocktake.id),
  productId: integer('product_id').notNull().references(() => product.id),
  bookQty: money('book_qty').notNull(),
  countedQty: money('counted_qty').notNull(),
  diffQty: money('diff_qty').notNull(),
  unitCost: money('unit_cost').notNull(), // لقطة تكلفة وقت الجرد (إصلاح v1.2)
  createdAt: text('created_at').$defaultFn(nowIso),
  createdBy: integer('created_by'),
});

/* ============ الأطراف ============ */
export const customer = sqliteTable(
  'customer',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    phone: text('phone'),
    whatsapp: text('whatsapp'),
    address: text('address'),
    area: text('area'),
    creditLimit: money('credit_limit'), // NULL = بلا حد؛ 0 = منع الآجل (إصلاح v1.2)
    openingBalance: money('opening_balance').default('0'), // موجب=مدين
    openingBalanceCurrencyId: integer('opening_balance_currency_id').references(
      () => currency.id,
    ), // إصلاح v1.2: للأرصدة بعملتها
    openingBalanceRate: money('opening_balance_rate'),
    openingBalanceDate: text('opening_balance_date'),
    notes: text('notes'),
    imagePath: text('image_path'),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').$defaultFn(nowIso),
    updatedAt: text('updated_at').$defaultFn(nowIso),
    createdBy: integer('created_by'),
  },
  (t) => [index('idx_customer_name').on(t.name), index('idx_customer_phone').on(t.phone)],
);

export const supplier = sqliteTable('supplier', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  phone: text('phone'),
  address: text('address'),
  openingBalance: money('opening_balance').default('0'), // موجب=دائن (مستحق له)
  openingBalanceCurrencyId: integer('opening_balance_currency_id').references(() => currency.id),
  openingBalanceRate: money('opening_balance_rate'),
  openingBalanceDate: text('opening_balance_date'),
  notes: text('notes'),
  isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').$defaultFn(nowIso),
  updatedAt: text('updated_at').$defaultFn(nowIso),
  createdBy: integer('created_by'),
});

/* ============ الفوترة ============ */
export const invoice = sqliteTable(
  'invoice',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    invoiceNo: text('invoice_no').unique(), // NULL لحالة draft — الرقم يُستهلك عند التحويل فقط (قرار 2)
    docType: text('doc_type').notNull(),
    payStatus: text('pay_status').notNull(), // حُذفت 'held' (قرار 2)
    status: text('status').notNull().default('completed'), // حُذفت 'converted'
    issuedAt: text('issued_at').notNull(),
    convertedAt: text('converted_at'), // تاريخ تحويل المسودة (أرشيفي)
    originalInvoiceId: integer('original_invoice_id').references(
      (): AnySQLiteColumn => invoice.id,
    ), // المرتجع المرتبط (إصلاح v1.2)
    dueDate: text('due_date'), // شروط ائتمان لأعمار الديون (إصلاح v1.2)
    customerId: integer('customer_id').references(() => customer.id),
    supplierId: integer('supplier_id').references(() => supplier.id),
    salesRepId: integer('sales_rep_id'), // محجوز V2 — بلا FK (الجدول مؤجل)
    cashboxId: integer('cashbox_id').references(() => cashbox.id),
    warehouseId: integer('warehouse_id').notNull().references(() => warehouse.id),
    currencyId: integer('currency_id').notNull().references(() => currency.id),
    exchangeRate: money('exchange_rate').notNull(), // حُذف DEFAULT 1 (قرار 3)
    rateIsFallback: integer('rate_is_fallback', { mode: 'boolean' }).notNull().default(false),
    subtotal: money('subtotal').notNull().default('0'),
    discountAmount: money('discount_amount').notNull().default('0'),
    taxRate: money('tax_rate').notNull().default('0'),
    taxAmount: money('tax_amount').notNull().default('0'),
    total: money('total').notNull(), // منع فاتورة صفرية (إصلاح v1.2)
    totalBase: money('total_base').notNull().default('0'),
    paidAmount: money('paid_amount').notNull().default('0'),
    dueAmount: money('due_amount').notNull().default('0'),
    costTotal: money('cost_total').notNull().default('0'), // تكلفة البنود للربح
    notesInternal: text('notes_internal'),
    notesPrinted: text('notes_printed'),
    createdAt: text('created_at').$defaultFn(nowIso),
    updatedAt: text('updated_at').$defaultFn(nowIso),
    createdBy: integer('created_by'),
  },
  (t) => [
    index('idx_invoice_type_date').on(t.docType, t.issuedAt),
    index('idx_invoice_customer').on(t.customerId, t.issuedAt),
    index('idx_invoice_supplier').on(t.supplierId, t.issuedAt),
    index('idx_invoice_no').on(t.invoiceNo),
    index('idx_invoice_original').on(t.originalInvoiceId),
    check('invoice_doc_type_enum', sql`doc_type IN ('sale','purchase','sale_return','purchase_return')`),
    check('invoice_pay_status_enum', sql`pay_status IN ('cash','credit','mixed')`),
    check('invoice_status_enum', sql`status IN ('draft','completed','void')`),
    check('invoice_total_positive', sql`CAST(total AS REAL) > 0`),
    check('invoice_due_amount_non_negative', sql`CAST(due_amount AS REAL) >= 0`),
    check('invoice_paid_le_total', sql`CAST(paid_amount AS REAL) <= CAST(total AS REAL)`),
  ],
);

export const invoiceItem = sqliteTable(
  'invoice_item',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    invoiceId: integer('invoice_id').notNull().references(() => invoice.id),
    productId: integer('product_id').references(() => product.id), // NULLable لسطر خدمة حرة (قرار 5)
    lineDesc: text('line_desc'), // وصف سطر الخدمة الحرة
    qty: money('qty').notNull(), // إصلاح v1.2
    unitId: integer('unit_id').references(() => unit.id),
    unitFactor: money('unit_factor').notNull().default('1'),
    unitPrice: money('unit_price').notNull(),
    discountPercent: money('discount_percent').default('0'),
    discountAmount: money('discount_amount').default('0'),
    taxPercent: money('tax_percent').default('0'),
    lineTotal: money('line_total').notNull(),
    lineCost: money('line_cost').notNull().default('0'), // التكلفة لحظة البيع (Snapshot)
    batchId: integer('batch_id').references(() => batch.id), // V1.1
    serialNumbers: text('serial_numbers'),
    notes: text('notes'),
    createdAt: text('created_at').$defaultFn(nowIso),
  },
  (t) => [
    index('idx_item_invoice').on(t.invoiceId),
    index('idx_item_product').on(t.productId),
    check('invoice_item_qty_positive', sql`CAST(qty AS REAL) > 0`),
  ],
);

/* ============ النقدية ============ */
export const cashTx = sqliteTable(
  'cash_tx',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    txType: text('tx_type').notNull(),
    cashboxId: integer('cashbox_id').notNull().references(() => cashbox.id),
    toCashboxId: integer('to_cashbox_id').references(() => cashbox.id),
    currencyId: integer('currency_id').notNull().references(() => currency.id),
    amount: money('amount').notNull(), // الاتجاه من tx_type
    exchangeRate: money('exchange_rate').notNull(), // حُذف DEFAULT 1 (قرار 3)
    settlementRate: money('settlement_rate'), // سعر يوم الدفع عند التسوية بعملة مختلفة (قرار 8)
    fxGainLoss: money('fx_gain_loss').notNull().default('0'), // فرق الصرف المحقق (قرار 8)
    voucherNo: text('voucher_no'), // RVT-/PMT- عند طباعة سند (م4)
    txDate: text('tx_date').notNull(),
    refType: text('ref_type'), // invoice/installment/stocktake/transfer/on_account
    refId: integer('ref_id'),
    expenseCategoryId: integer('expense_category_id').references(() => expenseCategory.id),
    employeeId: integer('employee_id'), // محجوز V1.1 (بلا FK)
    customerId: integer('customer_id').references(() => customer.id),
    supplierId: integer('supplier_id').references(() => supplier.id),
    isVoided: integer('is_voided', { mode: 'boolean' }).notNull().default(false), // إصلاح v1.2
    reversalOf: integer('reversal_of').references((): AnySQLiteColumn => cashTx.id),
    description: text('description'),
    createdAt: text('created_at').$defaultFn(nowIso),
    createdBy: integer('created_by'),
  },
  (t) => [
    index('idx_cash_tx_date').on(t.txDate),
    index('idx_cash_tx_box').on(t.cashboxId, t.txDate),
    index('idx_cash_tx_ref').on(t.refType, t.refId),
    index('idx_cash_tx_voucher').on(t.voucherNo),
    check(
      'cash_tx_type_enum',
      sql`tx_type IN ('receipt','payment','expense','owner_draw','capital_in','box_transfer','bank_deposit','bank_withdraw','opening','employee_advance','commission_payout','salary_batch')`,
    ),
    check('cash_tx_amount_positive', sql`CAST(amount AS REAL) > 0`),
  ],
);

// تخصيص المدفوعات (إصلاح v1.2): سند واحد يغطي عدة فواتير + قبض حر on_account
export const paymentAllocation = sqliteTable(
  'payment_allocation',
  {
    cashTxId: integer('cash_tx_id').notNull().references(() => cashTx.id),
    invoiceId: integer('invoice_id').notNull().references(() => invoice.id),
    allocatedAmount: money('allocated_amount').notNull(),
    allocatedAt: text('allocated_at').notNull(),
    createdBy: integer('created_by'),
  },
  (t) => [
    primaryKey({ columns: [t.cashTxId, t.invoiceId] }),
    index('idx_alloc_invoice').on(t.invoiceId),
    check('payment_allocation_amount_positive', sql`CAST(allocated_amount AS REAL) > 0`),
  ],
);

export const shift = sqliteTable('shift', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  cashboxId: integer('cashbox_id').notNull().references(() => cashbox.id),
  userId: integer('user_id').references(() => appUser.id),
  openedAt: text('opened_at').notNull(),
  closedAt: text('closed_at'),
  openingCount: money('opening_count'),
  expected: money('expected'),
  counted: money('counted'),
  difference: money('difference'),
  notes: text('notes'),
  createdAt: text('created_at').$defaultFn(nowIso),
  updatedAt: text('updated_at').$defaultFn(nowIso),
});

/* ============ الشيكات (وحدة 14 — جديدة في v1.2) ============ */
export const cheque = sqliteTable(
  'cheque',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    direction: text('direction').notNull(),
    partyType: text('party_type').notNull(),
    partyId: integer('party_id').notNull(),
    chequeNo: text('cheque_no').notNull(),
    bankName: text('bank_name'),
    amount: money('amount').notNull(),
    currencyId: integer('currency_id').notNull().references(() => currency.id),
    exchangeRate: money('exchange_rate').notNull(),
    issueDate: text('issue_date').notNull(),
    dueDate: text('due_date').notNull(),
    status: text('status').notNull().default('pending'),
    bouncedAt: text('bounced_at'),
    bounceFee: money('bounce_fee').default('0'),
    refInvoiceId: integer('ref_invoice_id').references(() => invoice.id),
    clearedCashTxId: integer('cleared_cash_tx_id').references(() => cashTx.id),
    notes: text('notes'),
    createdAt: text('created_at').$defaultFn(nowIso),
    updatedAt: text('updated_at').$defaultFn(nowIso),
    createdBy: integer('created_by'),
  },
  (t) => [
    index('idx_cheque_due').on(t.dueDate, t.status),
    index('idx_cheque_party').on(t.partyType, t.partyId),
    check('cheque_direction_enum', sql`direction IN ('in','out')`),
    check('cheque_party_type_enum', sql`party_type IN ('customer','supplier')`),
    check(
      'cheque_status_enum',
      sql`status IN ('pending','deposited','cleared','bounced','void')`,
    ),
    check('cheque_amount_positive', sql`CAST(amount AS REAL) > 0`),
  ],
);

/* ============ التقسيط ============ */
export const installmentPlan = sqliteTable(
  'installment_plan',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    customerId: integer('customer_id').notNull().references(() => customer.id),
    invoiceId: integer('invoice_id').notNull().references(() => invoice.id), // من فاتورة آجلة فقط
    currencyId: integer('currency_id').notNull().references(() => currency.id),
    exchangeRate: money('exchange_rate').notNull(), // Snapshot وقت الإنشاء (إصلاح v1.2)
    principal: money('principal').notNull(),
    downPayment: money('down_payment').default('0'),
    downPaymentCashTxId: integer('down_payment_cash_tx_id').references(() => cashTx.id),
    months: integer('months').notNull(),
    cycle: text('cycle').default('monthly'),
    firstDue: text('first_due').notNull(),
    totalPaid: money('total_paid').default('0'),
    status: text('status').default('active'),
    createdAt: text('created_at').$defaultFn(nowIso),
    updatedAt: text('updated_at').$defaultFn(nowIso),
    createdBy: integer('created_by'),
  },
  (t) => [
    check('installment_plan_cycle_enum', sql`cycle IN ('monthly','weekly')`),
    check(
      'installment_plan_status_enum',
      sql`status IN ('active','completed','defaulted','cancelled')`,
    ),
  ],
);

export const installment = sqliteTable(
  'installment',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    planId: integer('plan_id').notNull().references(() => installmentPlan.id),
    seq: integer('seq').notNull(),
    dueDate: text('due_date').notNull(),
    amount: money('amount').notNull(),
    paidAmount: money('paid_amount').default('0'),
    status: text('status').default('pending'),
    paidAt: text('paid_at'),
    cashTxId: integer('cash_tx_id').references(() => cashTx.id),
    createdAt: text('created_at').$defaultFn(nowIso),
    updatedAt: text('updated_at').$defaultFn(nowIso),
  },
  (t) => [
    unique('installment_plan_seq_unique').on(t.planId, t.seq),
    index('idx_installment_due').on(t.dueDate, t.status),
    check('installment_status_enum', sql`status IN ('pending','partial','paid','late')`),
  ],
);

/* ============ المستخدمون والأمان ============ */
export const appUser = sqliteTable(
  'app_user',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull().unique(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull().default('admin'), // V1: admin فقط
    pinHash: text('pin_hash'), // Argon2id
    failedAttempts: integer('failed_attempts').notNull().default(0), // سياسة قفل PIN (قرار 4)
    lockedUntil: text('locked_until'),
    permissions: text('permissions').notNull().default('{}'), // تُفعَّل V1.1
    defaultCashboxId: integer('default_cashbox_id').references(() => cashbox.id),
    isActive: integer('is_active', { mode: 'boolean' }).default(true),
    lastLoginAt: text('last_login_at'),
    createdAt: text('created_at').$defaultFn(nowIso),
    updatedAt: text('updated_at').$defaultFn(nowIso),
  },
  (t) => [check('app_user_role_enum', sql`role IN ('admin','cashier','viewer')`)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => appUser.id),
    action: text('action').notNull(), // void_invoice, price_override, fx_edit, stocktake, backdate, restore_backup, cheque_bounce...
    entity: text('entity'),
    entityId: integer('entity_id'),
    details: text('details'),
    at: text('at').notNull(),
  },
  // ملاحظة: تريغرات منع UPDATE/DELETE (FR-12-04) تُنشأ في SQL الهجرة — لا تدعمها تعريفات Drizzle.
  (t) => [index('idx_audit_at').on(t.at)],
);

export const backupLog = sqliteTable(
  'backup_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    fileName: text('file_name'),
    fileSize: integer('file_size'),
    checksum: text('checksum'),
    cloudPath: text('cloud_path'), // V1.1
    status: text('status').default('ok'),
    at: text('at').notNull(),
    userId: integer('user_id'),
    createdAt: text('created_at').$defaultFn(nowIso),
  },
  (t) => [check('backup_log_kind_enum', sql`kind IN ('manual','auto','cloud','pre_restore')`)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(), // مفتاح سجل الإعدادات (ملحق هـ)
  value: text('value').notNull(), // JSON مُتحقق بـ zod
  updatedAt: text('updated_at'),
  updatedBy: integer('updated_by'),
});

/* ============ الهجرات (بنية سجل _migrations — يديرها src/db/migrate.ts) ============ */
export const migrations = sqliteTable('_migrations', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull(),
  appliedAt: text('applied_at'),
});
