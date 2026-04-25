-- Receipts — one row per imported order PDF
CREATE TABLE IF NOT EXISTS receipts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_number VARCHAR(100) NOT NULL,
  order_date   DATE,
  vendor       VARCHAR(100) NOT NULL DEFAULT 'Amazon',
  subtotal     NUMERIC(10,2),
  tax          NUMERIC(10,2),
  total        NUMERIC(10,2),
  pdf_filename VARCHAR(255),
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | reviewed | imported
  imported_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, order_number)
);

CREATE INDEX IF NOT EXISTS idx_receipts_company_id ON receipts(company_id);
CREATE INDEX IF NOT EXISTS idx_receipts_company_status ON receipts(company_id, status);

-- Receipt line items — one row per product on the order
CREATE TABLE IF NOT EXISTS receipt_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id     UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  description    TEXT NOT NULL,
  quantity       NUMERIC(10,3) DEFAULT 1,
  unit_price     NUMERIC(10,2),
  total          NUMERIC(10,2),
  qbo_account_id VARCHAR(50),   -- references qbo_accounts.qbo_id
  qbo_class_id   VARCHAR(50),   -- references qbo_classes.qbo_id
  ai_confidence  NUMERIC(3,2),  -- 0.00–1.00, how sure the AI was
  item_status    VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt_id ON receipt_items(receipt_id);

-- Product memory — learns from user corrections over time
CREATE TABLE IF NOT EXISTS product_memory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_pattern TEXT NOT NULL,   -- normalized product description (lowercased, trimmed)
  qbo_account_id  VARCHAR(50),
  qbo_class_id    VARCHAR(50),
  usage_count     INTEGER NOT NULL DEFAULT 1,
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, product_pattern)
);

CREATE INDEX IF NOT EXISTS idx_product_memory_company_id ON product_memory(company_id);
