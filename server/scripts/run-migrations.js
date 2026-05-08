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
  // 047: personal_use flag on card_account_mappings
  `ALTER TABLE card_account_mappings
   ADD COLUMN IF NOT EXISTS personal_use BOOLEAN NOT NULL DEFAULT FALSE`,
  // 048: allow null qbo_account_id for personal-use cards
  `ALTER TABLE card_account_mappings
   ALTER COLUMN qbo_account_id DROP NOT NULL`,
  // 049: classification (Asset/Liability/Equity/Revenue/Expense) on qbo_accounts
  `ALTER TABLE qbo_accounts
   ADD COLUMN IF NOT EXISTS classification VARCHAR(50)`,
  // 050: rule_applied label on receipt_items
  `ALTER TABLE receipt_items
   ADD COLUMN IF NOT EXISTS rule_applied VARCHAR(255)`,
  // 051: square user exclusions for daily auto-sync
  `CREATE TABLE IF NOT EXISTS square_user_exclusions (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    square_team_member_id VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, square_team_member_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_square_user_exclusions_company ON square_user_exclusions(company_id)`,
  // 052: square catalog category correction map (pre-2023 items categorized differently)
  `CREATE TABLE IF NOT EXISTS square_catalog_category_map (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog_item_id VARCHAR(256) NOT NULL UNIQUE,
    item_name       VARCHAR(500),
    category_name   VARCHAR(256) NOT NULL,
    category_id     VARCHAR(256),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_square_catalog_category_map_item ON square_catalog_category_map(catalog_item_id)`,
  // 053: Square AI journal — logs every Ask query for learning and debugging
  `CREATE TABLE IF NOT EXISTS square_ai_journal (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question     TEXT NOT NULL,
    generated_sql TEXT,
    success      BOOLEAN NOT NULL DEFAULT false,
    error_message TEXT,
    row_count    INTEGER,
    thumbs_up    BOOLEAN,
    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_square_ai_journal_created ON square_ai_journal(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_square_ai_journal_success ON square_ai_journal(success, created_at DESC)`,
  // 054: Square AI facts — permanent business knowledge always injected into system prompt
  `CREATE TABLE IF NOT EXISTS square_ai_facts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category   VARCHAR(100) NOT NULL DEFAULT 'General',
    content    TEXT NOT NULL,
    active     BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_square_ai_facts_active ON square_ai_facts(active, sort_order)`,
  // 055: Square AI lessons — curated corrections promoted from journal
  `CREATE TABLE IF NOT EXISTS square_ai_lessons (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content    TEXT NOT NULL,
    journal_id UUID REFERENCES square_ai_journal(id) ON DELETE SET NULL,
    active     BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_square_ai_lessons_active ON square_ai_lessons(active, created_at)`,
  // 056: Scheduled reports
  `CREATE TABLE IF NOT EXISTS scheduled_reports (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,
    description   TEXT,
    sql_query     TEXT NOT NULL,
    frequency     VARCHAR(20) NOT NULL CHECK (frequency IN ('daily','weekly','monthly','yearly')),
    day_of_week   INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
    day_of_month  INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
    send_month    INTEGER CHECK (send_month BETWEEN 1 AND 12),
    send_time     TIME NOT NULL DEFAULT '08:00',
    start_date    DATE,
    end_date      DATE,
    active        BOOLEAN NOT NULL DEFAULT true,
    last_ran_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_reports_company ON scheduled_reports(company_id, active)`,
  // 057: Scheduled report recipients
  `CREATE TABLE IF NOT EXISTS scheduled_report_recipients (
    report_id UUID NOT NULL REFERENCES scheduled_reports(id) ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (report_id, user_id)
  )`,
  // 058: Scheduled report runs (history + token for public view)
  `CREATE TABLE IF NOT EXISTS scheduled_report_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id       UUID NOT NULL REFERENCES scheduled_reports(id) ON DELETE CASCADE,
    ran_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status          VARCHAR(20) NOT NULL DEFAULT 'success',
    rows_returned   INTEGER,
    sms_sent_count  INTEGER,
    error_message   TEXT,
    view_token      UUID NOT NULL DEFAULT gen_random_uuid(),
    token_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    result_data     JSONB,
    result_fields   JSONB
  )`,
  `CREATE INDEX IF NOT EXISTS idx_report_runs_report ON scheduled_report_runs(report_id, ran_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_report_runs_token ON scheduled_report_runs(view_token)`,
  // 059: Add params (template variables) to scheduled_reports
  `ALTER TABLE scheduled_reports ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '[]'`,
  // 060: Store evaluated param snapshot on each run for display in report header
  `ALTER TABLE scheduled_report_runs ADD COLUMN IF NOT EXISTS params_snapshot JSONB NOT NULL DEFAULT '[]'`,
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
