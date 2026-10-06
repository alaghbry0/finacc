/**
 * seed.ts — بيانات أساسية موحدة لاختبارات Domain (bun:sqlite في الذاكرة).
 * نفس مستوى البيانات الذي سينشئه Onboarding لاحقاً (المهمة 5).
 */
import type { SqliteAdapter } from '../../db/adapter';
import { freshDb } from '../../db/test-setup';

export interface Seed {
  yerId: number;
  sarId: number;
  companyId: number;
  warehouseId: number;
  cashboxId: number;
  /** «حليب المراعي» — صنف مخزني، تكلفة 90 */
  milkId: number;
  /** «توصيل» — صنف خدمي */
  deliveryId: number;
  customerId: number;
  supplierId: number;
}

const NOW = new Date().toISOString();

export async function seededDb(): Promise<{ db: SqliteAdapter; seed: Seed }> {
  const db = await freshDb();
  const seed = await seedBase(db);
  return { db, seed };
}

export async function seedBase(db: SqliteAdapter): Promise<Seed> {
  const yer = await db.all<{ id: number }>(
    `INSERT INTO currency (code, name, is_base, decimals, is_active)
     VALUES ('YER', 'ريال يمني', 1, 0, 1) RETURNING id`,
  );
  const sar = await db.all<{ id: number }>(
    `INSERT INTO currency (code, name, is_base, decimals, is_active)
     VALUES ('SAR', 'ريال سعودي', 0, 2, 1) RETURNING id`,
  );
  const company = await db.all<{ id: number }>(
    `INSERT INTO company (name, currency_id, tax_rate, invoice_prefix, created_at, updated_at)
     VALUES ('متجر الاختبار', ?, '0', 'INV', ?, ?) RETURNING id`,
    [yer[0]!.id, NOW, NOW],
  );
  const warehouse = await db.all<{ id: number }>(
    `INSERT INTO warehouse (name, is_default, created_at, updated_at)
     VALUES ('المخزن الرئيسي', 1, ?, ?) RETURNING id`,
    [NOW, NOW],
  );
  const cashbox = await db.all<{ id: number }>(
    `INSERT INTO cashbox (name, currency_id, is_default, created_at, updated_at)
     VALUES ('الصندوق الرئيسي', ?, 1, ?, ?) RETURNING id`,
    [yer[0]!.id, NOW, NOW],
  );
  const milk = await db.all<{ id: number }>(
    `INSERT INTO product (name, cost_price, is_service, created_at, updated_at)
     VALUES ('حليب المراعي', '90.0000', 0, ?, ?) RETURNING id`,
    [NOW, NOW],
  );
  await db.run(
    `INSERT INTO product_price (product_id, currency_id, price, price_level, margin_percent, updated_at)
     VALUES (?, ?, '115.0000', 'retail', '0', ?)`,
    [milk[0]!.id, yer[0]!.id, NOW],
  );
  const delivery = await db.all<{ id: number }>(
    `INSERT INTO product (name, cost_price, is_service, created_at, updated_at)
     VALUES ('توصيل', '0.0000', 1, ?, ?) RETURNING id`,
    [NOW, NOW],
  );
  const customer = await db.all<{ id: number }>(
    `INSERT INTO customer (name, created_at, updated_at) VALUES ('أحمد', ?, ?) RETURNING id`,
    [NOW, NOW],
  );
  const supplier = await db.all<{ id: number }>(
    `INSERT INTO supplier (name, created_at, updated_at) VALUES ('مورد النور', ?, ?) RETURNING id`,
    [NOW, NOW],
  );
  return {
    yerId: yer[0]!.id,
    sarId: sar[0]!.id,
    companyId: company[0]!.id,
    warehouseId: warehouse[0]!.id,
    cashboxId: cashbox[0]!.id,
    milkId: milk[0]!.id,
    deliveryId: delivery[0]!.id,
    customerId: customer[0]!.id,
    supplierId: supplier[0]!.id,
  };
}

/** تاريخ اليوم ISO (YYYY-MM-DD) */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** تاريخ قبل N يوماً (سالب = المستقبل) */
export function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
