-- =====================================================================
-- FinAcc — الهجرة 0000 (init) — المخطط الكامل SRS §5.3 DDL v1.2
-- مولّدة عبر drizzle-kit ثم مُطبَّعة يدوياً لتطابق DDL حرفياً.
-- هذا الملف هو مصدر الحقيقة للتنفيذ وقت التشغيل (يُنفَّذ عبر adapter.exec()).
--
-- قرارات موثقة (انظر src/db/schema.ts وسجل العمل):
--  * أعمدة المبالغ/الكميات/الأسعار: TEXT (نصوص عشرية دقيقة — لا Float، SRS 5.2-3).
--  * قيود CHECK عليها بصيغة CAST(... AS REAL) حتى تُقيَّم رقمياً على تخزين TEXT.
--  * invoice.sales_rep_id و cash_tx.employee_id بلا FK (مؤجلان V2/V1.1).
--  * settings.key: أُضيف NOT NULL (مفتاح أساسي — نيّة DDL؛ SQLite بدونه يقبل NULL).
--  * تريغرات audit_log (append-only — FR-12-04) في نهاية هذا الملف.
-- =====================================================================
CREATE TABLE app_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username text NOT NULL,
  display_name text NOT NULL,
  role text DEFAULT 'admin' NOT NULL,
  pin_hash text,
  failed_attempts integer DEFAULT 0 NOT NULL,
  locked_until text,
  permissions text DEFAULT '{}' NOT NULL,
  default_cashbox_id integer,
  is_active integer DEFAULT 1,
  last_login_at text,
  created_at text,
  updated_at text,
  FOREIGN KEY (default_cashbox_id) REFERENCES cashbox(id),
  CONSTRAINT "app_user_role_enum" CHECK(role IN ('admin','cashier','viewer'))
);
CREATE UNIQUE INDEX app_user_username_unique ON app_user (username);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id integer,
  action text NOT NULL,
  entity text,
  entity_id integer,
  details text,
  at text NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_user(id)
);
CREATE INDEX idx_audit_at ON audit_log (at);

CREATE TABLE backup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind text NOT NULL,
  file_name text,
  file_size integer,
  checksum text,
  cloud_path text,
  status text DEFAULT 'ok',
  at text NOT NULL,
  user_id integer,
  created_at text,
  CONSTRAINT "backup_log_kind_enum" CHECK(kind IN ('manual','auto','cloud','pre_restore'))
);
CREATE TABLE batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id integer NOT NULL,
  warehouse_id integer NOT NULL,
  batch_number text,
  serial_number text,
  expiry_date text,
  qty text DEFAULT '0' NOT NULL,
  is_archived integer DEFAULT 0,
  created_at text,
  updated_at text,
  FOREIGN KEY (product_id) REFERENCES product(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouse(id)
);
CREATE UNIQUE INDEX batch_serial_number_unique ON batch (serial_number);

CREATE INDEX idx_batch_product ON batch (product_id,expiry_date);

CREATE TABLE cash_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_type text NOT NULL,
  cashbox_id integer NOT NULL,
  to_cashbox_id integer,
  currency_id integer NOT NULL,
  amount text NOT NULL,
  exchange_rate text NOT NULL,
  settlement_rate text,
  fx_gain_loss text DEFAULT '0' NOT NULL,
  voucher_no text,
  tx_date text NOT NULL,
  ref_type text,
  ref_id integer,
  expense_category_id integer,
  employee_id integer,
  customer_id integer,
  supplier_id integer,
  is_voided integer DEFAULT 0 NOT NULL,
  reversal_of integer,
  description text,
  created_at text,
  created_by integer,
  FOREIGN KEY (cashbox_id) REFERENCES cashbox(id),
  FOREIGN KEY (to_cashbox_id) REFERENCES cashbox(id),
  FOREIGN KEY (currency_id) REFERENCES currency(id),
  FOREIGN KEY (expense_category_id) REFERENCES expense_category(id),
  FOREIGN KEY (customer_id) REFERENCES customer(id),
  FOREIGN KEY (supplier_id) REFERENCES supplier(id),
  FOREIGN KEY (reversal_of) REFERENCES cash_tx(id),
  CONSTRAINT "cash_tx_type_enum" CHECK(tx_type IN ('receipt','payment','expense','owner_draw','capital_in','box_transfer','bank_deposit','bank_withdraw','opening','employee_advance','commission_payout','salary_batch')),
  CONSTRAINT "cash_tx_amount_positive" CHECK(CAST(amount AS REAL) > 0)
);
CREATE INDEX idx_cash_tx_date ON cash_tx (tx_date);

CREATE INDEX idx_cash_tx_box ON cash_tx (cashbox_id,tx_date);

CREATE INDEX idx_cash_tx_ref ON cash_tx (ref_type,ref_id);

CREATE INDEX idx_cash_tx_voucher ON cash_tx (voucher_no);

CREATE TABLE cashbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL,
  currency_id integer NOT NULL,
  is_default integer DEFAULT 0,
  is_archived integer DEFAULT 0,
  created_at text,
  updated_at text,
  created_by integer,
  FOREIGN KEY (currency_id) REFERENCES currency(id)
);
CREATE TABLE category (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL,
  parent_id integer,
  sort_order integer DEFAULT 0,
  is_archived integer DEFAULT 0,
  created_at text,
  updated_at text,
  created_by integer,
  FOREIGN KEY (parent_id) REFERENCES category(id)
);
CREATE TABLE cheque (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction text NOT NULL,
  party_type text NOT NULL,
  party_id integer NOT NULL,
  cheque_no text NOT NULL,
  bank_name text,
  amount text NOT NULL,
  currency_id integer NOT NULL,
  exchange_rate text NOT NULL,
  issue_date text NOT NULL,
  due_date text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  bounced_at text,
  bounce_fee text DEFAULT '0',
  ref_invoice_id integer,
  cleared_cash_tx_id integer,
  notes text,
  created_at text,
  updated_at text,
  created_by integer,
  FOREIGN KEY (currency_id) REFERENCES currency(id),
  FOREIGN KEY (ref_invoice_id) REFERENCES invoice(id),
  FOREIGN KEY (cleared_cash_tx_id) REFERENCES cash_tx(id),
  CONSTRAINT "cheque_direction_enum" CHECK(direction IN ('in','out')),
  CONSTRAINT "cheque_party_type_enum" CHECK(party_type IN ('customer','supplier')),
  CONSTRAINT "cheque_status_enum" CHECK(status IN ('pending','deposited','cleared','bounced','void')),
  CONSTRAINT "cheque_amount_positive" CHECK(CAST(amount AS REAL) > 0)
);
CREATE INDEX idx_cheque_due ON cheque (due_date,status);

CREATE INDEX idx_cheque_party ON cheque (party_type,party_id);

CREATE TABLE company (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL,
  phone text,
  whatsapp text,
  address text,
  logo_path text,
  currency_id integer NOT NULL,
  tax_number text,
  tax_rate text DEFAULT '0' NOT NULL,
  invoice_prefix text DEFAULT 'INV',
  footer_text text,
  created_at text,
  updated_at text,
  created_by integer,
  FOREIGN KEY (currency_id) REFERENCES currency(id)
);
CREATE TABLE currency (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code text NOT NULL,
  name text NOT NULL,
  symbol_svg text,
  is_base integer DEFAULT 0 NOT NULL,
  decimals integer DEFAULT 2 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL
);
CREATE UNIQUE INDEX currency_code_unique ON currency (code);

CREATE TABLE customer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL,
  phone text,
  whatsapp text,
  address text,
  area text,
  credit_limit text,
  opening_balance text DEFAULT '0',
  opening_balance_currency_id integer,
  opening_balance_rate text,
  opening_balance_date text,
  notes text,
  image_path text,
  is_archived integer DEFAULT 0 NOT NULL,
  created_at text,
  updated_at text,
  created_by integer,
  FOREIGN KEY (opening_balance_currency_id) REFERENCES currency(id)
);
CREATE INDEX idx_customer_name ON customer (name);

CREATE INDEX idx_customer_phone ON customer (phone);

CREATE TABLE doc_sequence (
  doc_type text NOT NULL,
  year integer NOT NULL,
  last_no integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(doc_type, year)
);
CREATE TABLE exchange_rate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  currency_id integer NOT NULL,
  rate_date text NOT NULL,
  rate text NOT NULL,
  source text DEFAULT 'manual',
  created_at text,
  created_by integer,
  FOREIGN KEY (currency_id) REFERENCES currency(id),
  CONSTRAINT "exchange_rate_rate_positive" CHECK(CAST(rate AS REAL) > 0)
);
CREATE UNIQUE INDEX exchange_rate_currency_rate_date_unique ON exchange_rate (currency_id,rate_date);

CREATE TABLE expense_category (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL,
  is_archived integer DEFAULT 0,
  created_at text,
  updated_at text,
  created_by integer
);
CREATE TABLE fiscal_year (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year integer NOT NULL,
  start_date text NOT NULL,
  end_date text NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  closed_at text,
  closed_by integer,
  created_at text,
  updated_at text,
  CONSTRAINT "fiscal_year_status_enum" CHECK(status IN ('open','closed'))
);
CREATE UNIQUE INDEX fiscal_year_year_unique ON fiscal_year (year);

CREATE TABLE installment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id integer NOT NULL,
  seq integer NOT NULL,
  due_date text NOT NULL,
  amount text NOT NULL,
  paid_amount text DEFAULT '0',
  status text DEFAULT 'pending',
  paid_at text,
  cash_tx_id integer,
  created_at text,
  updated_at text,
  FOREIGN KEY (plan_id) REFERENCES installment_plan(id),
  FOREIGN KEY (cash_tx_id) REFERENCES cash_tx(id),
  CONSTRAINT "installment_status_enum" CHECK(status IN ('pending','partial','paid','late'))
);
CREATE INDEX idx_installment_due ON installment (due_date,status);

CREATE UNIQUE INDEX installment_plan_seq_unique ON installment (plan_id,seq);

CREATE TABLE installment_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id integer NOT NULL,
  invoice_id integer NOT NULL,
  currency_id integer NOT NULL,
  exchange_rate text NOT NULL,
  principal text NOT NULL,
  down_payment text DEFAULT '0',
  down_payment_cash_tx_id integer,
  months integer NOT NULL,
  cycle text DEFAULT 'monthly',
  first_due text NOT NULL,
  total_paid text DEFAULT '0',
  status text DEFAULT 'active',
  created_at text,
  updated_at text,
  created_by integer,
  FOREIGN KEY (customer_id) REFERENCES customer(id),
  FOREIGN KEY (invoice_id) REFERENCES invoice(id),
  FOREIGN KEY (currency_id) REFERENCES currency(id),
  FOREIGN KEY (down_payment_cash_tx_id) REFERENCES cash_tx(id),
  CONSTRAINT "installment_plan_cycle_enum" CHECK(cycle IN ('monthly','weekly')),
  CONSTRAINT "installment_plan_status_enum" CHECK(status IN ('active','completed','defaulted','cancelled'))
);
CREATE TABLE invoice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no text,
  doc_type text NOT NULL,
  pay_status text NOT NULL,
  status text DEFAULT 'completed' NOT NULL,
  issued_at text NOT NULL,
  converted_at text,
  original_invoice_id integer,
  due_date text,
  customer_id integer,
  supplier_id integer,
  sales_rep_id integer,
  cashbox_id integer,
  warehouse_id integer NOT NULL,
  currency_id integer NOT NULL,
  exchange_rate text NOT NULL,
  rate_is_fallback integer DEFAULT 0 NOT NULL,
  subtotal text DEFAULT '0' NOT NULL,
  discount_amount text DEFAULT '0' NOT NULL,
  tax_rate text DEFAULT '0' NOT NULL,
  tax_amount text DEFAULT '0' NOT NULL,
  total text NOT NULL,
  total_base text DEFAULT '0' NOT NULL,
  paid_amount text DEFAULT '0' NOT NULL,
  due_amount text DEFAULT '0' NOT NULL,
  cost_total text DEFAULT '0' NOT NULL,
  notes_internal text,
  notes_printed text,
  created_at text,
  updated_at text,
  created_by integer,
  FOREIGN KEY (original_invoice_id) REFERENCES invoice(id),
  FOREIGN KEY (customer_id) REFERENCES customer(id),
  FOREIGN KEY (supplier_id) REFERENCES supplier(id),
  FOREIGN KEY (cashbox_id) REFERENCES cashbox(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouse(id),
  FOREIGN KEY (currency_id) REFERENCES currency(id),
  CONSTRAINT "invoice_doc_type_enum" CHECK(doc_type IN ('sale','purchase','sale_return','purchase_return')),
  CONSTRAINT "invoice_pay_status_enum" CHECK(pay_status IN ('cash','credit','mixed')),
  CONSTRAINT "invoice_status_enum" CHECK(status IN ('draft','completed','void')),
  CONSTRAINT "invoice_total_positive" CHECK(CAST(total AS REAL) > 0),
  CONSTRAINT "invoice_due_amount_non_negative" CHECK(CAST(due_amount AS REAL) >= 0),
  CONSTRAINT "invoice_paid_le_total" CHECK(CAST(paid_amount AS REAL) <= CAST(total AS REAL))
);
CREATE UNIQUE INDEX invoice_invoice_no_unique ON invoice (invoice_no);

CREATE INDEX idx_invoice_type_date ON invoice (doc_type,issued_at);

CREATE INDEX idx_invoice_customer ON invoice (customer_id,issued_at);

CREATE INDEX idx_invoice_supplier ON invoice (supplier_id,issued_at);

CREATE INDEX idx_invoice_no ON invoice (invoice_no);

CREATE INDEX idx_invoice_original ON invoice (original_invoice_id);

CREATE TABLE invoice_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id integer NOT NULL,
  product_id integer,
  line_desc text,
  qty text NOT NULL,
  unit_id integer,
  unit_factor text DEFAULT '1' NOT NULL,
  unit_price text NOT NULL,
  discount_percent text DEFAULT '0',
  discount_amount text DEFAULT '0',
  tax_percent text DEFAULT '0',
  line_total text NOT NULL,
  line_cost text DEFAULT '0' NOT NULL,
  batch_id integer,
  serial_numbers text,
  notes text,
  created_at text,
  FOREIGN KEY (invoice_id) REFERENCES invoice(id),
  FOREIGN KEY (product_id) REFERENCES product(id),
  FOREIGN KEY (unit_id) REFERENCES unit(id),
  FOREIGN KEY (batch_id) REFERENCES batch(id),
  CONSTRAINT "invoice_item_qty_positive" CHECK(CAST(qty AS REAL) > 0)
);
CREATE INDEX idx_item_invoice ON invoice_item (invoice_id);

CREATE INDEX idx_item_product ON invoice_item (product_id);

CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  version integer NOT NULL,
  applied_at text
);
CREATE TABLE payment_allocation (
  cash_tx_id integer NOT NULL,
  invoice_id integer NOT NULL,
  allocated_amount text NOT NULL,
  allocated_at text NOT NULL,
  created_by integer,
  PRIMARY KEY(cash_tx_id, invoice_id),
  FOREIGN KEY (cash_tx_id) REFERENCES cash_tx(id),
  FOREIGN KEY (invoice_id) REFERENCES invoice(id),
  CONSTRAINT "payment_allocation_amount_positive" CHECK(CAST(allocated_amount AS REAL) > 0)
);
CREATE INDEX idx_alloc_invoice ON payment_allocation (invoice_id);

CREATE TABLE product (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL,
  barcode text,
  category_id integer,
  unit_id integer,
  cost_price text DEFAULT '0' NOT NULL,
  min_stock text DEFAULT '0' NOT NULL,
  is_service integer DEFAULT 0 NOT NULL,
  track_batches integer DEFAULT 0 NOT NULL,
  track_serials integer DEFAULT 0 NOT NULL,
  image_path text,
  notes text,
  is_archived integer DEFAULT 0 NOT NULL,
  created_at text,
  updated_at text,
  created_by integer,
  FOREIGN KEY (category_id) REFERENCES category(id),
  FOREIGN KEY (unit_id) REFERENCES unit(id)
);
CREATE UNIQUE INDEX product_barcode_unique ON product (barcode);

CREATE INDEX idx_product_name ON product (name);

CREATE INDEX idx_product_barcode ON product (barcode);

CREATE TABLE product_price (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id integer NOT NULL,
  currency_id integer NOT NULL,
  price text NOT NULL,
  price_level text DEFAULT 'retail' NOT NULL,
  margin_percent text DEFAULT '0' NOT NULL,
  updated_at text,
  FOREIGN KEY (product_id) REFERENCES product(id),
  FOREIGN KEY (currency_id) REFERENCES currency(id),
  CONSTRAINT "product_price_price_non_negative" CHECK(CAST(price AS REAL) >= 0),
  CONSTRAINT "product_price_level_enum" CHECK(price_level IN ('retail','wholesale','credit'))
);
CREATE UNIQUE INDEX product_price_product_currency_level_unique ON product_price (product_id,currency_id,price_level);

CREATE TABLE settings (
  key text PRIMARY KEY NOT NULL,
  value text NOT NULL,
  updated_at text,
  updated_by integer
);
CREATE TABLE shift (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cashbox_id integer NOT NULL,
  user_id integer,
  opened_at text NOT NULL,
  closed_at text,
  opening_count text,
  expected text,
  counted text,
  difference text,
  notes text,
  created_at text,
  updated_at text,
  FOREIGN KEY (cashbox_id) REFERENCES cashbox(id),
  FOREIGN KEY (user_id) REFERENCES app_user(id)
);
CREATE TABLE stock_level (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id integer NOT NULL,
  warehouse_id integer NOT NULL,
  qty text DEFAULT '0' NOT NULL,
  FOREIGN KEY (product_id) REFERENCES product(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouse(id),
  CONSTRAINT "stock_level_qty_non_negative" CHECK(CAST(qty AS REAL) >= 0)
);
CREATE UNIQUE INDEX stock_level_product_warehouse_unique ON stock_level (product_id,warehouse_id);

CREATE TABLE stock_movement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id integer NOT NULL,
  warehouse_id integer NOT NULL,
  movement_type text NOT NULL,
  qty text NOT NULL,
  unit_cost text NOT NULL,
  ref_type text,
  ref_id integer,
  moved_at text NOT NULL,
  notes text,
  created_at text,
  created_by integer,
  FOREIGN KEY (product_id) REFERENCES product(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouse(id),
  CONSTRAINT "stock_movement_type_enum" CHECK(movement_type IN ('purchase','sale','sale_return','purchase_return','stocktake_adjust','manual_adjust','transfer_in','transfer_out','opening')),
  CONSTRAINT "stock_movement_qty_nonzero" CHECK(CAST(qty AS REAL) <> 0)
);
CREATE INDEX idx_move_product_date ON stock_movement (product_id,moved_at);

CREATE INDEX idx_move_warehouse ON stock_movement (warehouse_id,moved_at);

CREATE INDEX idx_move_ref ON stock_movement (ref_type,ref_id);

CREATE TABLE stocktake (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id integer NOT NULL,
  counted_at text NOT NULL,
  total_diff text DEFAULT '0',
  status text DEFAULT 'completed',
  notes text,
  created_at text,
  created_by integer,
  FOREIGN KEY (warehouse_id) REFERENCES warehouse(id)
);
CREATE TABLE stocktake_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stocktake_id integer NOT NULL,
  product_id integer NOT NULL,
  book_qty text NOT NULL,
  counted_qty text NOT NULL,
  diff_qty text NOT NULL,
  unit_cost text NOT NULL,
  created_at text,
  created_by integer,
  FOREIGN KEY (stocktake_id) REFERENCES stocktake(id),
  FOREIGN KEY (product_id) REFERENCES product(id)
);
CREATE TABLE supplier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL,
  phone text,
  address text,
  opening_balance text DEFAULT '0',
  opening_balance_currency_id integer,
  opening_balance_rate text,
  opening_balance_date text,
  notes text,
  is_archived integer DEFAULT 0,
  created_at text,
  updated_at text,
  created_by integer,
  FOREIGN KEY (opening_balance_currency_id) REFERENCES currency(id)
);
CREATE TABLE unit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL,
  base_unit_id integer,
  factor text DEFAULT '1',
  is_archived integer DEFAULT 0,
  created_at text,
  updated_at text,
  created_by integer,
  FOREIGN KEY (base_unit_id) REFERENCES unit(id)
);
CREATE TABLE warehouse (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL,
  location text,
  is_default integer DEFAULT 0,
  is_archived integer DEFAULT 0,
  created_at text,
  updated_at text,
  created_by integer
);

-- ============ حماية سجل التدقيق (FR-12-04 — append-only) ============
-- SQLite لا يدعم CREATE TRIGGER IF NOT EXISTS → DROP ثم CREATE (idempotent)
DROP TRIGGER IF EXISTS audit_log_no_update;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
DROP TRIGGER IF EXISTS audit_log_no_delete;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
