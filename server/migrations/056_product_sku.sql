-- Product SKU. A product is one vintage of a product line; its SKU is the line's sku_base prefixed
-- by the 2-digit vintage and a dash, lowercase — e.g. line sku_base "papas-malbec" + vintage 2023
-- => "23-papas-malbec". Generated when a bottling is recorded (Vintly is master for product creation;
-- TeamHub dresses the line). Nullable: legacy Commerce7 products carry their SKU on product_variants,
-- not here, and are left as-is.
ALTER TABLE product.products ADD COLUMN IF NOT EXISTS sku VARCHAR(120);

-- Lookup index (SKU-by-company) for future channel-push/dedupe. Not unique: no backfill of legacy rows,
-- and NULLs would not collide anyway.
CREATE INDEX IF NOT EXISTS idx_products_company_sku ON product.products (company_id, sku);
