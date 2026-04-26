/**
 * Run migrations so company_integrations exists in the same schema as the app (DB_SCHEMA).
 * Usage: from server folder: node scripts/run-migrations.js
 */
import { query } from '../db.js';

const MIGRATIONS = [
  // 002: company_integrations table
  `CREATE TABLE IF NOT EXISTS company_integrations (
    company_id     UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    square_access_token VARCHAR(500),
    square_env         VARCHAR(50),
    twilio_account_sid VARCHAR(100),
    twilio_auth_token  VARCHAR(100),
    twilio_phone_number VARCHAR(50),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by    UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
  // 003: square_application_id
  `ALTER TABLE company_integrations
   ADD COLUMN IF NOT EXISTS square_application_id VARCHAR(100)`,
  // 004: password_reset_tokens
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at)`,
  // 005: mail config
  `ALTER TABLE company_integrations
   ADD COLUMN IF NOT EXISTS mail_host VARCHAR(255),
   ADD COLUMN IF NOT EXISTS mail_port INTEGER,
   ADD COLUMN IF NOT EXISTS mail_user VARCHAR(255),
   ADD COLUMN IF NOT EXISTS mail_pass VARCHAR(500),
   ADD COLUMN IF NOT EXISTS mail_from VARCHAR(255),
   ADD COLUMN IF NOT EXISTS mail_secure BOOLEAN DEFAULT false`,
  // 006: weekly task day of week (0=Sun, 1=Mon, ... 6=Sat)
  `ALTER TABLE task_list_templates ADD COLUMN IF NOT EXISTS day_of_week INTEGER`,
  // 007: monthly (day_of_month 1-31), yearly (recur_month 1-12, recur_day 1-31)
  `ALTER TABLE task_list_templates
   ADD COLUMN IF NOT EXISTS day_of_month INTEGER,
   ADD COLUMN IF NOT EXISTS recur_month INTEGER,
   ADD COLUMN IF NOT EXISTS recur_day INTEGER`,
  // 008: locations and junction tables (user_locations, announcement_locations, task_list_template_locations)
  `CREATE TABLE IF NOT EXISTS locations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name       VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(company_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS user_locations (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, location_id)
  )`,
  `CREATE TABLE IF NOT EXISTS announcement_locations (
    announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    PRIMARY KEY (announcement_id, location_id)
  )`,
  `CREATE TABLE IF NOT EXISTS task_list_template_locations (
    template_id UUID NOT NULL REFERENCES task_list_templates(id) ON DELETE CASCADE,
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    PRIMARY KEY (template_id, location_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_locations_company_id ON locations(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_locations_user_id ON user_locations(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_locations_location_id ON user_locations(location_id)`,
  `CREATE INDEX IF NOT EXISTS idx_announcement_locations_announcement_id ON announcement_locations(announcement_id)`,
  `CREATE INDEX IF NOT EXISTS idx_announcement_locations_location_id ON announcement_locations(location_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_list_template_locations_template_id ON task_list_template_locations(template_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_list_template_locations_location_id ON task_list_template_locations(location_id)`,
  // 012: Campaign Monitor settings moved to Club Steward — drop legacy columns if present
  `ALTER TABLE company_integrations
   DROP COLUMN IF EXISTS campaign_monitor_api_key,
   DROP COLUMN IF EXISTS campaign_monitor_api_clientid,
   DROP COLUMN IF EXISTS campaign_monitor_api_secret`,
  // 014: debt report — month/year ending balances
  `CREATE TABLE IF NOT EXISTS debt_monthly_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    year INTEGER NOT NULL CHECK (year >= 1900 AND year <= 2100),
    month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
    ending_balance NUMERIC(14, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, year, month)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_debt_monthly_balances_company_year ON debt_monthly_balances(company_id, year)`,
  // 015: debt ceiling
  `ALTER TABLE company_integrations ADD COLUMN IF NOT EXISTS debt_ceiling NUMERIC(14, 2)`,
  // 013: QBO integration columns
  `ALTER TABLE company_integrations
   ADD COLUMN IF NOT EXISTS qbo_access_token     TEXT,
   ADD COLUMN IF NOT EXISTS qbo_refresh_token    TEXT,
   ADD COLUMN IF NOT EXISTS qbo_token_expires_at TIMESTAMPTZ,
   ADD COLUMN IF NOT EXISTS qbo_realm_id         VARCHAR(50),
   ADD COLUMN IF NOT EXISTS qbo_environment      VARCHAR(20) DEFAULT 'production',
   ADD COLUMN IF NOT EXISTS qbo_pending_state    VARCHAR(200)`,
  // 014: QBO reference data
  `CREATE TABLE IF NOT EXISTS qbo_accounts (
    company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    qbo_id               VARCHAR(50) NOT NULL,
    name                 VARCHAR(255) NOT NULL,
    fully_qualified_name VARCHAR(500),
    account_type         VARCHAR(100),
    account_sub_type     VARCHAR(100),
    active               BOOLEAN NOT NULL DEFAULT true,
    synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, qbo_id)
  )`,
  `CREATE TABLE IF NOT EXISTS qbo_classes (
    company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    qbo_id               VARCHAR(50) NOT NULL,
    name                 VARCHAR(255) NOT NULL,
    fully_qualified_name VARCHAR(500),
    parent_id            VARCHAR(50),
    active               BOOLEAN NOT NULL DEFAULT true,
    synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, qbo_id)
  )`,
  // 016: receipts, receipt_items, product_memory
  `CREATE TABLE IF NOT EXISTS receipts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    order_number VARCHAR(100) NOT NULL,
    order_date   DATE,
    vendor       VARCHAR(100) NOT NULL DEFAULT 'Amazon',
    subtotal     NUMERIC(10,2),
    tax          NUMERIC(10,2),
    total        NUMERIC(10,2),
    pdf_filename VARCHAR(255),
    status       VARCHAR(20) NOT NULL DEFAULT 'pending',
    imported_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(company_id, order_number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_company_id ON receipts(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_company_status ON receipts(company_id, status)`,
  `CREATE TABLE IF NOT EXISTS receipt_items (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id     UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    description    TEXT NOT NULL,
    quantity       NUMERIC(10,3) DEFAULT 1,
    unit_price     NUMERIC(10,2),
    total          NUMERIC(10,2),
    qbo_account_id VARCHAR(50),
    qbo_class_id   VARCHAR(50),
    ai_confidence  NUMERIC(3,2),
    item_status    VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt_id ON receipt_items(receipt_id)`,
  `CREATE TABLE IF NOT EXISTS product_memory (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    product_pattern TEXT NOT NULL,
    qbo_account_id  VARCHAR(50),
    qbo_class_id    VARCHAR(50),
    usage_count     INTEGER NOT NULL DEFAULT 1,
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(company_id, product_pattern)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_memory_company_id ON product_memory(company_id)`,
  // 017: categorization rules
  `CREATE TABLE IF NOT EXISTS categorization_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    priority    INTEGER NOT NULL DEFAULT 100,
    if_description_contains TEXT,
    if_vendor               VARCHAR(100),
    if_account_type_contains TEXT,
    then_account_id   VARCHAR(50),
    then_class_id     VARCHAR(50),
    then_clear        BOOLEAN NOT NULL DEFAULT false,
    notes       TEXT,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cat_rules_company ON categorization_rules(company_id, priority)`,
  // 018: QBO export tracking
  `ALTER TABLE receipts
   ADD COLUMN IF NOT EXISTS qbo_transaction_id VARCHAR(50),
   ADD COLUMN IF NOT EXISTS exported_at TIMESTAMPTZ`,
  `ALTER TABLE company_integrations
   ADD COLUMN IF NOT EXISTS qbo_payment_account_id VARCHAR(50)`,
  // 019: Amazon order history payments
  `CREATE TABLE IF NOT EXISTS amazon_payments (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    payment_reference_id VARCHAR(100) NOT NULL,
    payment_date         DATE,
    payment_amount       NUMERIC(10,2),
    payment_instrument   VARCHAR(50),
    card_last4           VARCHAR(10),
    order_ids            TEXT[] NOT NULL DEFAULT '{}',
    imported_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(company_id, payment_reference_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_amazon_payments_company ON amazon_payments(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_amazon_payments_date ON amazon_payments(company_id, payment_date)`,
  // 020: item-level data per shipment (enables Option C: split QBO updates by shipment)
  `CREATE TABLE IF NOT EXISTS amazon_payment_items (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES amazon_payments(id) ON DELETE CASCADE,
    order_id   VARCHAR(50) NOT NULL,
    asin       VARCHAR(20),
    title      TEXT NOT NULL,
    item_subtotal  NUMERIC(10,2),
    item_tax       NUMERIC(10,2),
    item_total     NUMERIC(10,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_amazon_payment_items_payment ON amazon_payment_items(payment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_amazon_payment_items_order ON amazon_payment_items(order_id)`,
  // 021: card last4 on receipts (extracted from PDF)
  `ALTER TABLE receipts
   ADD COLUMN IF NOT EXISTS card_last4 VARCHAR(10),
   ADD COLUMN IF NOT EXISTS payment_instrument VARCHAR(50)`,
  // 022: card → QBO payment account mappings
  `CREATE TABLE IF NOT EXISTS card_account_mappings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    card_last4     VARCHAR(10) NOT NULL,
    card_label     VARCHAR(100),
    qbo_account_id VARCHAR(50) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(company_id, card_last4)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_card_mappings_company ON card_account_mappings(company_id)`,
];

async function run() {
  const schema = process.env.DB_SCHEMA || 'teamtask_hub';
  console.log('Running migrations in schema:', schema);
  for (let i = 0; i < MIGRATIONS.length; i++) {
    try {
      await query(MIGRATIONS[i]);
      console.log('  Migration', i + 1, 'OK');
    } catch (err) {
      console.error('  Migration', i + 1, 'failed:', err.message);
      process.exit(1);
    }
  }
  console.log('Done.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
