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
  // 061: Company timezone for scheduled reports and date expressions
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) NOT NULL DEFAULT 'UTC'`,

  // 062: Commerce7 integration credentials on company_integrations
  `ALTER TABLE company_integrations
     ADD COLUMN IF NOT EXISTS c7_tenant_slug    VARCHAR(200),
     ADD COLUMN IF NOT EXISTS c7_tenant_id      VARCHAR(200),
     ADD COLUMN IF NOT EXISTS c7_api_base_url   VARCHAR(500),
     ADD COLUMN IF NOT EXISTS c7_api_key        TEXT`,

  // 063: product schema + products master table
  `CREATE SCHEMA IF NOT EXISTS product`,
  `CREATE TABLE IF NOT EXISTS product.products (
     id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id     UUID         NOT NULL,
     name           VARCHAR(500) NOT NULL,
     description    TEXT,
     vintage        SMALLINT,
     varietal       VARCHAR(200),
     wine_style     VARCHAR(50),
     appellation    VARCHAR(200),
     region         VARCHAR(200),
     country        VARCHAR(100) DEFAULT 'USA',
     alcohol_pct    NUMERIC(5,2),
     is_available   BOOLEAN      NOT NULL DEFAULT true,
     is_archived    BOOLEAN      NOT NULL DEFAULT false,
     display_order  INTEGER      NOT NULL DEFAULT 0,
     internal_notes TEXT,
     images         JSONB        NOT NULL DEFAULT '[]',
     created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     created_by     UUID,
     updated_by     UUID
   )`,
  `CREATE INDEX IF NOT EXISTS idx_products_company       ON product.products(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_products_company_avail ON product.products(company_id, is_available, is_archived)`,
  `CREATE INDEX IF NOT EXISTS idx_products_vintage       ON product.products(company_id, vintage)`,
  `CREATE INDEX IF NOT EXISTS idx_products_varietal      ON product.products(company_id, varietal)`,

  // 064: product_variants (SKUs per product)
  `CREATE TABLE IF NOT EXISTS product.product_variants (
     id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
     product_id    UUID        NOT NULL REFERENCES product.products(id) ON DELETE CASCADE,
     company_id    UUID        NOT NULL,
     volume_format VARCHAR(50) NOT NULL DEFAULT '750ml',
     sku           VARCHAR(100),
     price_cents   INTEGER,
     is_default    BOOLEAN     NOT NULL DEFAULT false,
     is_available  BOOLEAN     NOT NULL DEFAULT true,
     taxable       BOOLEAN     NOT NULL DEFAULT true,
     weight_oz     NUMERIC(7,2),
     ordinal       INTEGER     NOT NULL DEFAULT 0,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(product_id, volume_format)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_variants_product ON product.product_variants(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_variants_company ON product.product_variants(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_variants_sku     ON product.product_variants(company_id, sku)`,

  // 065: c7_products (Commerce7-specific overlay fields)
  `CREATE TABLE IF NOT EXISTS product.c7_products (
     product_id         UUID PRIMARY KEY REFERENCES product.products(id) ON DELETE CASCADE,
     company_id         UUID    NOT NULL,
     c7_product_id      VARCHAR(200) UNIQUE,
     c7_handle          VARCHAR(500),
     teaser             TEXT,
     winemaker_notes    TEXT,
     residual_sugar     VARCHAR(100),
     food_pairings      TEXT[]  NOT NULL DEFAULT '{}',
     awards             JSONB   NOT NULL DEFAULT '[]',
     club_eligible      BOOLEAN NOT NULL DEFAULT false,
     available_channels TEXT[]  NOT NULL DEFAULT '{}',
     seo_title          VARCHAR(500),
     seo_description    TEXT,
     tags               TEXT[]  NOT NULL DEFAULT '{}',
     sort_position      INTEGER,
     c7_created_at      TIMESTAMPTZ,
     c7_updated_at      TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS idx_c7_products_company   ON product.c7_products(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_products_c7_id     ON product.c7_products(c7_product_id)`,

  // 066: c7_variant_data
  `CREATE TABLE IF NOT EXISTS product.c7_variant_data (
     variant_id         UUID PRIMARY KEY REFERENCES product.product_variants(id) ON DELETE CASCADE,
     company_id         UUID NOT NULL,
     c7_variant_id      VARCHAR(200) UNIQUE,
     member_price_cents INTEGER,
     inventory_on_hand  INTEGER,
     c7_updated_at      TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS idx_c7_variant_company ON product.c7_variant_data(company_id)`,

  // 067: square_items (Square-specific overlay)
  `CREATE TABLE IF NOT EXISTS product.square_items (
     product_id           UUID PRIMARY KEY REFERENCES product.products(id) ON DELETE CASCADE,
     company_id           UUID    NOT NULL,
     square_item_id       VARCHAR(200) UNIQUE,
     abbreviation         VARCHAR(24),
     square_category_id   VARCHAR(100),
     tax_ids              TEXT[]  NOT NULL DEFAULT '{}',
     modifier_list_info   JSONB   NOT NULL DEFAULT '[]',
     available_online     BOOLEAN NOT NULL DEFAULT true,
     available_for_pickup BOOLEAN NOT NULL DEFAULT true,
     skip_modifier_screen BOOLEAN NOT NULL DEFAULT false,
     sq_updated_at        TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS idx_square_items_company ON product.square_items(company_id)`,

  // 068: square_variation_data
  `CREATE TABLE IF NOT EXISTS product.square_variation_data (
     variant_id                UUID PRIMARY KEY REFERENCES product.product_variants(id) ON DELETE CASCADE,
     company_id                UUID    NOT NULL,
     square_variation_id       VARCHAR(200) UNIQUE,
     pricing_type              VARCHAR(30) DEFAULT 'FIXED_PRICING',
     inventory_alert_type      VARCHAR(30) DEFAULT 'NONE',
     inventory_alert_threshold INTEGER,
     location_overrides        JSONB   NOT NULL DEFAULT '[]',
     sellable                  BOOLEAN NOT NULL DEFAULT true,
     stockable                 BOOLEAN NOT NULL DEFAULT true,
     sq_updated_at             TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sq_variation_company ON product.square_variation_data(company_id)`,

  // 069: sync_status (per product per system)
  `CREATE TABLE IF NOT EXISTS product.sync_status (
     id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id     UUID        NOT NULL,
     product_id     UUID        NOT NULL REFERENCES product.products(id) ON DELETE CASCADE,
     system         VARCHAR(30) NOT NULL,
     needs_push     BOOLEAN     NOT NULL DEFAULT true,
     last_synced_at TIMESTAMPTZ,
     sync_error     TEXT,
     retry_count    SMALLINT    NOT NULL DEFAULT 0,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE(product_id, system)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sync_status_company    ON product.sync_status(company_id, system)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_status_needs_push ON product.sync_status(company_id, needs_push) WHERE needs_push = true`,

  // 070: webhook_events (raw inbound payloads from C7 / Square)
  `CREATE TABLE IF NOT EXISTS product.webhook_events (
     id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id        UUID,
     source            VARCHAR(30) NOT NULL,
     event_type        VARCHAR(200),
     external_event_id VARCHAR(200),
     raw_payload       JSONB       NOT NULL,
     received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     processed_at      TIMESTAMPTZ,
     process_error     TEXT,
     product_id        UUID        REFERENCES product.products(id) ON DELETE SET NULL,
     UNIQUE(source, external_event_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_company  ON product.webhook_events(company_id, source)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_unproc   ON product.webhook_events(processed_at) WHERE processed_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_received ON product.webhook_events(received_at DESC)`,

  // 071: inventory_counts (monthly count sessions)
  `CREATE TABLE IF NOT EXISTS product.inventory_counts (
     id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id   UUID        NOT NULL,
     count_month  DATE        NOT NULL,
     location_id  UUID,
     status       VARCHAR(20) NOT NULL DEFAULT 'open',
     notes        TEXT,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_by   UUID        NOT NULL,
     submitted_at TIMESTAMPTZ,
     submitted_by UUID,
     approved_at  TIMESTAMPTZ,
     approved_by  UUID
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_counts_unique ON product.inventory_counts(company_id, count_month, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid))`,
  `CREATE INDEX IF NOT EXISTS idx_inv_counts_company ON product.inventory_counts(company_id, count_month DESC)`,

  // 072: inventory_lines (per-SKU entries per count session)
  `CREATE TABLE IF NOT EXISTS product.inventory_lines (
     id             UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
     count_id       UUID     NOT NULL REFERENCES product.inventory_counts(id) ON DELETE CASCADE,
     company_id     UUID     NOT NULL,
     variant_id     UUID     NOT NULL REFERENCES product.product_variants(id) ON DELETE RESTRICT,
     cases_count    SMALLINT NOT NULL DEFAULT 0 CHECK (cases_count >= 0),
     bottles_count  SMALLINT NOT NULL DEFAULT 0 CHECK (bottles_count >= 0),
     total_bottles  SMALLINT GENERATED ALWAYS AS (cases_count * 12 + bottles_count) STORED,
     entered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     entered_by     UUID     NOT NULL,
     last_edited_at TIMESTAMPTZ,
     last_edited_by UUID,
     notes          TEXT,
     UNIQUE(count_id, variant_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_inv_lines_count   ON product.inventory_lines(count_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inv_lines_variant ON product.inventory_lines(variant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inv_lines_company ON product.inventory_lines(company_id)`,

  // 073: Add triggered_by to scheduled_report_runs (manual run tracking)
  `ALTER TABLE scheduled_report_runs ADD COLUMN IF NOT EXISTS triggered_by UUID REFERENCES users(id) ON DELETE SET NULL`,

  // 074: Query actions
  `CREATE TABLE IF NOT EXISTS query_actions (
    id                     UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id              UUID    NOT NULL REFERENCES scheduled_reports(id) ON DELETE CASCADE,
    name                   VARCHAR(255) NOT NULL,
    action_type            SMALLINT     NOT NULL DEFAULT 1,
    config                 JSONB        NOT NULL DEFAULT '{}',
    notify_once_per_status BOOLEAN      NOT NULL DEFAULT false,
    is_active              BOOLEAN      NOT NULL DEFAULT true,
    sort_order             INTEGER      NOT NULL DEFAULT 0,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by             UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_query_actions_report ON query_actions(report_id, is_active)`,

  // 075: Query action conditions — all conditions in same group ANDed; groups ORed
  `CREATE TABLE IF NOT EXISTS query_action_conditions (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    action_id       UUID    NOT NULL REFERENCES query_actions(id) ON DELETE CASCADE,
    field_name      VARCHAR(255) NOT NULL,
    operator        VARCHAR(20)  NOT NULL
                    CHECK (operator IN ('=','!=','>','<','>=','<=','contains','not_contains','in','not_in')),
    field_value     VARCHAR(500) NOT NULL,
    condition_group INTEGER      NOT NULL DEFAULT 1,
    sort_order      INTEGER      NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_qac_action ON query_action_conditions(action_id)`,

  // 076: Query action recipients — who gets notified (field from row, static value, or system user)
  `CREATE TABLE IF NOT EXISTS query_action_recipients (
    id             UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
    action_id      UUID   NOT NULL REFERENCES query_actions(id) ON DELETE CASCADE,
    channel        VARCHAR(10)  NOT NULL CHECK (channel IN ('sms','email')),
    recipient_type VARCHAR(10)  NOT NULL CHECK (recipient_type IN ('field','static','user')),
    value          VARCHAR(500) NOT NULL,
    label          VARCHAR(100),
    sort_order     INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_qar_action ON query_action_recipients(action_id)`,

  // 077: Query action run details — per-row delivery log; supports dedup via row_key + triggered_status
  `CREATE TABLE IF NOT EXISTS query_action_run_details (
    id               UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id           UUID   NOT NULL REFERENCES scheduled_report_runs(id) ON DELETE CASCADE,
    action_id        UUID   NOT NULL REFERENCES query_actions(id) ON DELETE CASCADE,
    row_data         JSONB  NOT NULL,
    row_key          VARCHAR(500),
    recipient        VARCHAR(255),
    status           VARCHAR(20)  NOT NULL DEFAULT 'sent'
                     CHECK (status IN ('sent','failed','skipped','suppressed')),
    triggered_status VARCHAR(100),
    error_message    TEXT,
    sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_qard_run       ON query_action_run_details(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_qard_action    ON query_action_run_details(action_id)`,
  `CREATE INDEX IF NOT EXISTS idx_qard_dedup     ON query_action_run_details(action_id, row_key, triggered_status, sent_at DESC)`,

  // 078: Service tokens — named, revocable API keys for agents / integrations (no human login required)
  `CREATE TABLE IF NOT EXISTS service_tokens (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    token_hash   TEXT        NOT NULL UNIQUE,
    role         TEXT        NOT NULL DEFAULT 'manager'
                             CHECK (role IN ('manager', 'owner')),
    created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_service_tokens_company ON service_tokens(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_service_tokens_hash    ON service_tokens(token_hash) WHERE revoked_at IS NULL`,

  // 079: Betty recommendations — agent's suggested categorizations vs human bookkeeper
  // Read-only comparison: no changes are written to QBO, just stored here for review
  `CREATE TABLE IF NOT EXISTS betty_recommendations (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    qbo_txn_id          TEXT        NOT NULL,
    qbo_txn_type        TEXT        NOT NULL,   -- Purchase, JournalEntry, Deposit, etc.
    txn_date            DATE        NOT NULL,
    txn_amount          NUMERIC(12,2),
    txn_description     TEXT,
    payee_name          TEXT,
    -- What the human bookkeeper has in QBO right now
    bookkeeper_account_id    TEXT,
    bookkeeper_account_name  TEXT,
    bookkeeper_class_id      TEXT,
    bookkeeper_class_name    TEXT,
    -- What Betty recommends
    betty_account_id    TEXT,
    betty_account_name  TEXT,
    betty_class_id      TEXT,
    betty_class_name    TEXT,
    betty_reasoning     TEXT,
    betty_confidence    TEXT CHECK (betty_confidence IN ('high','medium','low')),
    -- Review outcome
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','agree','disagree','needs_review')),
    reviewer_note       TEXT,
    reviewed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, qbo_txn_id, qbo_txn_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_betty_company   ON betty_recommendations(company_id, txn_date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_betty_status    ON betty_recommendations(company_id, status)`,

  // ── Migration 080: commerce7 schema ──────────────────────────────────────
  `CREATE SCHEMA IF NOT EXISTS commerce7`,

  // ── Migration 081: commerce7.customers ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.customers (
    id                     UUID        PRIMARY KEY,   -- C7's customer UUID
    company_id             UUID        NOT NULL,
    honorific              TEXT,
    first_name             TEXT,
    last_name              TEXT,
    birth_date             DATE,
    city                   TEXT,
    state_code             VARCHAR(10),
    zip_code               VARCHAR(20),
    country_code           VARCHAR(10),
    email_marketing_status TEXT,
    has_account            BOOLEAN     NOT NULL DEFAULT false,
    last_activity_date     TIMESTAMPTZ,
    emails                 JSONB       NOT NULL DEFAULT '[]',
    phones                 JSONB       NOT NULL DEFAULT '[]',
    clubs                  JSONB       NOT NULL DEFAULT '[]',
    order_information      JSONB,
    tags                   JSONB       NOT NULL DEFAULT '[]',
    metadata               JSONB,
    c7_created_at          TIMESTAMPTZ,
    c7_updated_at          TIMESTAMPTZ,
    synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_c7_customers_company    ON commerce7.customers(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_customers_updated    ON commerce7.customers(company_id, c7_updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_customers_email      ON commerce7.customers USING gin(emails)`,

  // ── Migration 082: commerce7.orders ─────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.orders (
    id                     UUID        PRIMARY KEY,   -- C7's order UUID
    company_id             UUID        NOT NULL,
    order_number           INTEGER     NOT NULL,
    order_submitted_date   TIMESTAMPTZ,
    order_paid_date        TIMESTAMPTZ,
    order_fulfilled_date   TIMESTAMPTZ,
    order_source           TEXT,                      -- Internal, Web, API …
    customer_type          TEXT,                      -- New Customer, Repeat Customer …
    purchase_type          TEXT,                      -- Regular, Exchange, Club …
    previous_order_id      UUID,                      -- populated for exchanges
    previous_order_number  INTEGER,
    refund_order_id        UUID,
    payment_status         TEXT,
    compliance_status      TEXT,
    fulfillment_status     TEXT,
    shipping_status        TEXT,
    channel                TEXT,                      -- Inbound, Outbound …
    sales_attribute_code   TEXT,                      -- Club, Tasting Room, Web …
    pos_profile_id         UUID,
    customer_id            UUID        REFERENCES commerce7.customers(id) ON DELETE SET NULL,
    order_delivery_method  TEXT,
    tax_sale_type          TEXT,
    -- Monetary totals (cents — same as C7 API)
    sub_total              INTEGER     NOT NULL DEFAULT 0,
    ship_total             INTEGER     NOT NULL DEFAULT 0,
    tax_total              INTEGER     NOT NULL DEFAULT 0,
    duty_total             INTEGER     NOT NULL DEFAULT 0,
    bottle_deposit_total   INTEGER     NOT NULL DEFAULT 0,
    tip_total              INTEGER     NOT NULL DEFAULT 0,
    total                  INTEGER     NOT NULL DEFAULT 0,
    total_after_tip        INTEGER     NOT NULL DEFAULT 0,
    is_non_taxable         BOOLEAN     NOT NULL DEFAULT false,
    is_no_duty             BOOLEAN     NOT NULL DEFAULT false,
    loyalty_points_earned  INTEGER     NOT NULL DEFAULT 0,
    -- Billing address (denormalised for reporting — avoids joins)
    bill_to_first_name     TEXT,
    bill_to_last_name      TEXT,
    bill_to_city           TEXT,
    bill_to_state_code     TEXT,
    bill_to_zip_code       TEXT,
    bill_to_country_code   TEXT,
    -- Complex sub-objects stored as JSONB
    club                   JSONB,
    tenders                JSONB       NOT NULL DEFAULT '[]',
    taxes                  JSONB       NOT NULL DEFAULT '[]',
    fulfillments           JSONB       NOT NULL DEFAULT '[]',
    promotions             JSONB       NOT NULL DEFAULT '[]',
    coupons                JSONB       NOT NULL DEFAULT '[]',
    tags                   JSONB       NOT NULL DEFAULT '[]',
    metadata               JSONB,
    c7_created_at          TIMESTAMPTZ,
    c7_updated_at          TIMESTAMPTZ,
    synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_c7_orders_company_date  ON commerce7.orders(company_id, order_submitted_date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_orders_customer      ON commerce7.orders(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_orders_number        ON commerce7.orders(company_id, order_number)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_orders_purchase_type ON commerce7.orders(company_id, purchase_type)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_orders_sales_attr    ON commerce7.orders(company_id, sales_attribute_code)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_c7_orders_co_num ON commerce7.orders(company_id, order_number)`,

  // ── Migration 083: commerce7.order_items ────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.order_items (
    id                     UUID        PRIMARY KEY,   -- C7's item UUID
    company_id             UUID        NOT NULL,
    order_id               UUID        NOT NULL REFERENCES commerce7.orders(id) ON DELETE CASCADE,
    purchase_type          TEXT,
    product_title          TEXT,
    product_slug           TEXT,
    item_type              TEXT,                      -- Wine, Merchandise, Fee …
    product_id             UUID,
    product_variant_id     UUID,
    product_variant_title  TEXT,
    sku                    TEXT,
    cost_of_good           INTEGER,                   -- cents
    price                  INTEGER,                   -- cents
    original_price         INTEGER,                   -- cents
    compare_price          INTEGER,                   -- cents
    quantity               INTEGER     NOT NULL DEFAULT 1,
    quantity_fulfilled     INTEGER     NOT NULL DEFAULT 0,
    tax                    INTEGER     NOT NULL DEFAULT 0,  -- cents
    tax_type               TEXT,
    bottle_deposit         INTEGER     NOT NULL DEFAULT 0,
    weight                 NUMERIC(8,3),
    volume_in_ml           INTEGER,
    alcohol_percentage     NUMERIC(5,2),
    department_code        TEXT,
    department_id          UUID,
    allocation_id          UUID,
    is_price_override      BOOLEAN     NOT NULL DEFAULT false,
    notes                  TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_c7_items_order       ON commerce7.order_items(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_items_company     ON commerce7.order_items(company_id, order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_items_product     ON commerce7.order_items(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_items_sku         ON commerce7.order_items(company_id, sku)`,

  // ── Migration 084: commerce7.sync_log ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.sync_log (
    id             BIGSERIAL   PRIMARY KEY,
    company_id     UUID        NOT NULL,
    entity         TEXT        NOT NULL,  -- 'customers' | 'orders'
    mode           TEXT        NOT NULL DEFAULT 'incremental',  -- 'full' | 'incremental'
    since          TIMESTAMPTZ,           -- incremental window start
    records_synced INTEGER     NOT NULL DEFAULT 0,
    error_message  TEXT,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at    TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_c7_sync_log ON commerce7.sync_log(company_id, entity, started_at DESC)`,

  // ── Migration 085: gateway_actions ───────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS gateway_actions (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    -- Who submitted
    submitted_by_user   UUID        REFERENCES users(id) ON DELETE SET NULL,
    submitted_by_token  UUID        REFERENCES service_tokens(id) ON DELETE SET NULL,
    requested_by_label  TEXT        NOT NULL,           -- display name for audit log
    -- What to do
    service             TEXT        NOT NULL CHECK (service IN ('qbo','square','commerce7')),
    operation           TEXT        NOT NULL,           -- e.g. "Bill.create", "Payment.delete"
    payload             JSONB       NOT NULL DEFAULT '{}',
    -- Approval state
    status              TEXT        NOT NULL DEFAULT 'pending_approval'
                        CHECK (status IN ('pending_approval','executing','completed','failed','rejected')),
    auto_approve_at     TIMESTAMPTZ,                    -- NULL = manual-only
    -- Resolution
    approved_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
    approved_at         TIMESTAMPTZ,
    rejected_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
    rejected_at         TIMESTAMPTZ,
    rejection_note      TEXT,
    -- Execution result
    result              JSONB,
    error_message       TEXT,
    executed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gwa_company_status ON gateway_actions(company_id, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_gwa_auto_approve   ON gateway_actions(auto_approve_at) WHERE status = 'pending_approval'`,

  // ── Migration 086: gateway_approval_rules ────────────────────────────────
  `CREATE TABLE IF NOT EXISTS gateway_approval_rules (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name                TEXT        NOT NULL,
    -- Match criteria (glob patterns, NULL = match all)
    service_pattern     TEXT,                           -- e.g. "qbo", "*"
    operation_pattern   TEXT,                           -- e.g. "*.delete", "Bill.*"
    -- Approval behaviour
    require_approval    BOOLEAN     NOT NULL DEFAULT true,
    auto_approve_minutes INT,                           -- NULL = never auto-approve; 0 = immediate
    -- Order
    priority            INT         NOT NULL DEFAULT 100,
    enabled             BOOLEAN     NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gwr_company ON gateway_approval_rules(company_id, priority)`,

  // ── Migration 087: priority on task_templates ────────────────────────────
  `ALTER TABLE task_templates ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'must'`,

  // ── Migration 088: wage_title on task list templates ─────────────────────
  `ALTER TABLE task_list_templates ADD COLUMN IF NOT EXISTS wage_title VARCHAR(256)`,

  // ── Migration 088: tri-state completion (status + reason) ────────────────
  `ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS status VARCHAR(20)`,
  `ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS reason TEXT`,

  // ── Migration 089: ops_manager_name on companies ─────────────────────────
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS ops_manager_name VARCHAR(200)`,

  // ── Migration 090: completion_sms_sent_at on task_assignments ─────────────
  `ALTER TABLE task_assignments ADD COLUMN IF NOT EXISTS completion_sms_sent_at TIMESTAMPTZ`,

  // ── Migration 091: tax_exempt_square_items ───────────────────────────────
  `CREATE TABLE IF NOT EXISTS tax_exempt_square_items (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    item_name   VARCHAR(500) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  UUID        REFERENCES users(id),
    UNIQUE (company_id, item_name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tax_exempt_company ON tax_exempt_square_items(company_id)`,

  // ── Migration 092: only_alert_if_rows on scheduled_reports ───────────────
  `ALTER TABLE scheduled_reports ADD COLUMN IF NOT EXISTS only_alert_if_rows BOOLEAN NOT NULL DEFAULT false`,

  // ── Migration 097: archived_at on task_assignments ───────────────────────
  `ALTER TABLE task_assignments ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,

  // ── Migrations 093-096: Skynet agent scheduler ────────────────────────────
  `CREATE TABLE IF NOT EXISTS skynet_schedules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name            VARCHAR(300) NOT NULL,
    agent_id        VARCHAR(100) NOT NULL,
    agent_name      VARCHAR(200),
    prompt          TEXT NOT NULL,
    schedule_type   VARCHAR(50) NOT NULL DEFAULT 'once',
    cron_expression VARCHAR(100),
    fire_at         TIMESTAMPTZ,
    next_run_at     TIMESTAMPTZ,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    last_run_at     TIMESTAMPTZ,
    last_issue_id   VARCHAR(200),
    run_count       INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_skynet_schedules_company ON skynet_schedules(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skynet_schedules_next_run ON skynet_schedules(next_run_at) WHERE enabled = true`,
  `ALTER TABLE company_integrations
     ADD COLUMN IF NOT EXISTS paperclip_base_url VARCHAR(500),
     ADD COLUMN IF NOT EXISTS paperclip_api_key  VARCHAR(500),
     ADD COLUMN IF NOT EXISTS paperclip_company_id VARCHAR(100),
     ADD COLUMN IF NOT EXISTS paperclip_default_goal_id VARCHAR(100)`,
  // ── Migration 161: Square catalog sync ───────────────────────────────────
  `ALTER TABLE square.catalog_item
     ADD COLUMN IF NOT EXISTS tax_ids        TEXT[],
     ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS is_deleted     BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE square.catalog_category
     ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS is_deleted     BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS square_catalog_sync_jobs (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     completed_at  TIMESTAMPTZ,
     status        VARCHAR(20) NOT NULL DEFAULT 'running',
     items_upserted  INTEGER NOT NULL DEFAULT 0,
     cats_upserted   INTEGER NOT NULL DEFAULT 0,
     error         TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sq_sync_jobs_company ON square_catalog_sync_jobs(company_id, started_at DESC)`,
  // ── Migration 165: square_sync_objects ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS square_sync_objects (
     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     object_type     VARCHAR(50)  NOT NULL,
     label           VARCHAR(100) NOT NULL,
     enabled         BOOLEAN      NOT NULL DEFAULT false,
     sync_frequency  VARCHAR(20)  NOT NULL DEFAULT 'nightly',
     last_synced_at  TIMESTAMPTZ,
     last_sync_status VARCHAR(20),
     last_sync_count  INTEGER,
     last_sync_error  TEXT,
     next_sync_at    TIMESTAMPTZ,
     UNIQUE (company_id, object_type)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sq_sync_objects_company ON square_sync_objects(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_sync_objects_next ON square_sync_objects(next_sync_at) WHERE enabled = true`,

  // ── Migration 167: team_square schema ────────────────────────────────────
  `CREATE SCHEMA IF NOT EXISTS team_square`,

  // Catalog items — all Fivetran fields + API extras
  `CREATE TABLE IF NOT EXISTS team_square.catalog_item (
     id                          VARCHAR(100) PRIMARY KEY,
     name                        TEXT,
     description                 TEXT,
     description_html            TEXT,
     description_plaintext       TEXT,
     abbreviation                VARCHAR(50),
     label_color                 VARCHAR(20),
     available_online            BOOLEAN,
     available_for_pickup        BOOLEAN,
     available_electronically    BOOLEAN,
     category_id                 VARCHAR(100),
     image_url                   TEXT,
     image_ids                   TEXT[],
     product_type                VARCHAR(50),
     skip_modifier_screen        BOOLEAN,
     tax_ids                     TEXT[],
     reporting_category_id       VARCHAR(100),
     reporting_category_ordinal  BIGINT,
     present_at_all_locations    BOOLEAN,
     ecom_available              BOOLEAN,
     ecom_visibility             VARCHAR(50),
     version                     BIGINT,
     is_deleted                  BOOLEAN NOT NULL DEFAULT false,
     updated_at                  TIMESTAMPTZ,
     synced_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // Item variations — all Fivetran fields + API extras
  `CREATE TABLE IF NOT EXISTS team_square.catalog_item_variation (
     id                          VARCHAR(100) PRIMARY KEY,
     item_id                     VARCHAR(100),
     name                        TEXT,
     sku                         VARCHAR(100),
     upc                         VARCHAR(100),
     ordinal                     INTEGER,
     pricing_type                VARCHAR(50),
     price_money_amount          BIGINT,
     price_money_currency        VARCHAR(10),
     track_inventory             BOOLEAN,
     inventory_alert_type        VARCHAR(50),
     inventory_alert_threshold   INTEGER,
     user_data                   TEXT,
     service_duration            INTEGER,
     available_for_booking       BOOLEAN,
     sellable                    BOOLEAN,
     stockable                   BOOLEAN,
     measurement_unit_id         VARCHAR(100),
     version                     BIGINT,
     is_deleted                  BOOLEAN NOT NULL DEFAULT false,
     updated_at                  TIMESTAMPTZ,
     synced_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // Categories — all Fivetran fields + API extras
  `CREATE TABLE IF NOT EXISTS team_square.catalog_category (
     id                VARCHAR(100) PRIMARY KEY,
     name              TEXT,
     category_type     VARCHAR(50),
     is_top_level      BOOLEAN,
     parent_category_id VARCHAR(100),
     image_ids         TEXT[],
     version           BIGINT,
     is_deleted        BOOLEAN NOT NULL DEFAULT false,
     updated_at        TIMESTAMPTZ,
     synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // Taxes — all Fivetran fields + API extras
  `CREATE TABLE IF NOT EXISTS team_square.catalog_tax (
     id                        VARCHAR(100) PRIMARY KEY,
     name                      TEXT,
     calculation_phase         VARCHAR(50),
     inclusion_type            VARCHAR(50),
     percentage                NUMERIC(8,4),
     applies_to_custom_amounts BOOLEAN,
     enabled                   BOOLEAN,
     tax_type_id               VARCHAR(100),
     version                   BIGINT,
     is_deleted                BOOLEAN NOT NULL DEFAULT false,
     updated_at                TIMESTAMPTZ,
     synced_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE INDEX IF NOT EXISTS idx_ts_item_category    ON team_square.catalog_item(category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_item_deleted     ON team_square.catalog_item(is_deleted)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_variation_item   ON team_square.catalog_item_variation(item_id)`,
  // ── Migration 175: allow null sent_by in sms_log (agents have no user ID) ──
  `ALTER TABLE sms_log ALTER COLUMN sent_by DROP NOT NULL`,

  // ── Migration 176: team_square orders ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.order (
     id                                    VARCHAR(100) PRIMARY KEY,
     location_id                           VARCHAR(100),
     reference_id                          VARCHAR(100),
     customer_id                           VARCHAR(100),
     state                                 VARCHAR(20),
     ticket_name                           VARCHAR(200),
     order_source_name                     VARCHAR(100),
     total_money_amount                    BIGINT,
     total_money_currency                  VARCHAR(10),
     total_tax_amount                      BIGINT,
     total_tax_currency                    VARCHAR(10),
     total_discount_amount                 BIGINT,
     total_discount_currency               VARCHAR(10),
     total_tip_amount                      BIGINT,
     total_tip_currency                    VARCHAR(10),
     total_service_charge_amount           BIGINT,
     total_service_charge_currency         VARCHAR(10),
     net_amount_total_money_amount         BIGINT,
     created_at                            TIMESTAMPTZ,
     updated_at                            TIMESTAMPTZ,
     closed_at                             TIMESTAMPTZ,
     synced_at                             TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ts_order_state      ON team_square.order(state)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_order_created    ON team_square.order(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_order_updated    ON team_square.order(updated_at)`,
  `CREATE TABLE IF NOT EXISTS team_square.order_line_item (
     order_id                VARCHAR(100) NOT NULL,
     uid                     VARCHAR(100) NOT NULL,
     name                    TEXT,
     quantity                NUMERIC(10,4),
     note                    TEXT,
     catalog_object_id       VARCHAR(100),
     catalog_version         BIGINT,
     variation_name          TEXT,
     item_type               VARCHAR(50),
     base_price_amount       BIGINT,
     base_price_currency     VARCHAR(10),
     gross_sales_amount      BIGINT,
     total_tax_amount        BIGINT,
     total_discount_amount   BIGINT,
     total_amount            BIGINT,
     total_currency          VARCHAR(10),
     synced_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (order_id, uid)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ts_oli_order        ON team_square.order_line_item(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_oli_catalog      ON team_square.order_line_item(catalog_object_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_oli_name         ON team_square.order_line_item(name)`,

  // ── Migration 184: team_square.shift ─────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.shift (
     id                              VARCHAR(64)  PRIMARY KEY,
     employee_id                     VARCHAR(64),
     team_member_id                  VARCHAR(64),
     location_id                     VARCHAR(64),
     timezone                        VARCHAR(64),
     start_at                        TIMESTAMPTZ,
     end_at                          TIMESTAMPTZ,
     status                          VARCHAR(20),
     wage_title                      VARCHAR(255),
     wage_hourly_rate_amount         INTEGER,
     wage_hourly_rate_currency       VARCHAR(10),
     wage_job_id                     VARCHAR(64),
     wage_tip_eligible               BOOLEAN,
     declared_cash_tip_amount        INTEGER,
     declared_cash_tip_currency      VARCHAR(10),
     version                         INTEGER,
     created_at                      TIMESTAMPTZ,
     updated_at                      TIMESTAMPTZ,
     synced_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 185: team_square.shift_break ────────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.shift_break (
     id                   VARCHAR(64)  PRIMARY KEY,
     shift_id             VARCHAR(64)  NOT NULL REFERENCES team_square.shift(id) ON DELETE CASCADE,
     break_type_id        VARCHAR(64),
     name                 VARCHAR(255),
     start_at             TIMESTAMPTZ,
     end_at               TIMESTAMPTZ,
     expected_duration    VARCHAR(32),
     is_paid              BOOLEAN,
     synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 186: indexes on shift tables ────────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_ts_shift_team_member  ON team_square.shift(team_member_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_shift_location     ON team_square.shift(location_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_shift_start        ON team_square.shift(start_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_shift_status       ON team_square.shift(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_shift_updated      ON team_square.shift(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_break_shift        ON team_square.shift_break(shift_id)`,

  // ── Migration 192: team_square.scheduled_shift ────────────────────────────
  // Stores both draft and published versions of each scheduled shift.
  // draft_* fields are always present; pub_* fields are null until published.
  `CREATE TABLE IF NOT EXISTS team_square.scheduled_shift (
     id                    VARCHAR(64) PRIMARY KEY,
     -- draft details (unpublished / pending edits)
     draft_team_member_id  VARCHAR(64),
     draft_location_id     VARCHAR(64),
     draft_job_id          VARCHAR(64),
     draft_start_at        TIMESTAMPTZ,
     draft_end_at          TIMESTAMPTZ,
     draft_timezone        VARCHAR(64),
     draft_is_deleted      BOOLEAN,
     -- published details (what employees see; null if never published)
     pub_team_member_id    VARCHAR(64),
     pub_location_id       VARCHAR(64),
     pub_job_id            VARCHAR(64),
     pub_start_at          TIMESTAMPTZ,
     pub_end_at            TIMESTAMPTZ,
     pub_timezone          VARCHAR(64),
     pub_is_deleted        BOOLEAN,
     -- meta
     version               INTEGER,
     created_at            TIMESTAMPTZ,
     updated_at            TIMESTAMPTZ,
     synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 193: indexes on scheduled_shift ─────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_ts_sshift_draft_member ON team_square.scheduled_shift(draft_team_member_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_sshift_pub_member   ON team_square.scheduled_shift(pub_team_member_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_sshift_draft_start  ON team_square.scheduled_shift(draft_start_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_sshift_pub_start    ON team_square.scheduled_shift(pub_start_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_sshift_updated      ON team_square.scheduled_shift(updated_at)`,

  // ── Migration 198: team_square.team_member ────────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.team_member (
     id                       VARCHAR(64)  PRIMARY KEY,
     reference_id             VARCHAR(255),
     is_owner                 BOOLEAN,
     status                   VARCHAR(20),
     given_name               VARCHAR(255),
     family_name              VARCHAR(255),
     email_address            VARCHAR(255),
     phone_number             VARCHAR(50),
     merchant_id              VARCHAR(64),
     -- location assignment
     assigned_location_type   VARCHAR(50),
     assigned_location_ids    TEXT[],
     -- wage setting (scalar fields; job assignments in child table)
     wage_is_overtime_exempt  BOOLEAN,
     wage_version             INTEGER,
     wage_created_at          TIMESTAMPTZ,
     wage_updated_at          TIMESTAMPTZ,
     -- meta
     created_at               TIMESTAMPTZ,
     updated_at               TIMESTAMPTZ,
     synced_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 199: team_square.team_member_job_assignment ─────────────────
  `CREATE TABLE IF NOT EXISTS team_square.team_member_job_assignment (
     id                    BIGSERIAL    PRIMARY KEY,
     team_member_id        VARCHAR(64)  NOT NULL REFERENCES team_square.team_member(id) ON DELETE CASCADE,
     job_id                VARCHAR(64),
     job_title             VARCHAR(255),
     pay_type              VARCHAR(20),
     hourly_rate_amount    INTEGER,
     hourly_rate_currency  VARCHAR(10),
     synced_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 200: indexes on team member tables ──────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_ts_tm_status   ON team_square.team_member(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_tm_email    ON team_square.team_member(email_address)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_tm_updated  ON team_square.team_member(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_tmja_member ON team_square.team_member_job_assignment(team_member_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_tmja_job    ON team_square.team_member_job_assignment(job_id)`,

  // ── Migration 205: team_square.location (already applied — keep in place) ──
  `CREATE TABLE IF NOT EXISTS team_square.location (
     id                                      VARCHAR(64)  PRIMARY KEY,
     name                                    VARCHAR(255),
     status                                  VARCHAR(20),
     type                                    VARCHAR(20),
     merchant_id                             VARCHAR(64),
     business_name                           VARCHAR(255),
     business_email                          VARCHAR(255),
     phone_number                            VARCHAR(50),
     website_url                             VARCHAR(500),
     description                             TEXT,
     timezone                                VARCHAR(64),
     country                                 VARCHAR(10),
     language_code                           VARCHAR(10),
     currency                                VARCHAR(10),
     address_line_1                          VARCHAR(255),
     address_line_2                          VARCHAR(255),
     address_line_3                          VARCHAR(255),
     address_locality                        VARCHAR(255),
     address_sublocality                     VARCHAR(255),
     address_administrative_district_level_1 VARCHAR(100),
     address_postal_code                     VARCHAR(20),
     address_country                         VARCHAR(10),
     latitude                                DOUBLE PRECISION,
     longitude                               DOUBLE PRECISION,
     mcc                                     VARCHAR(10),
     full_format_logo_url                    TEXT,
     capabilities                            TEXT[],
     created_at                              TIMESTAMPTZ,
     synced_at                               TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 206: team_square.customer ──────────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.customer (
     id                VARCHAR(64)  PRIMARY KEY,
     given_name        VARCHAR(255),
     family_name       VARCHAR(255),
     email_address     VARCHAR(255),
     phone_number      VARCHAR(50),
     company_name      VARCHAR(255),
     nickname          VARCHAR(255),
     birthday          VARCHAR(20),
     note              TEXT,
     reference_id      VARCHAR(255),
     creation_source   VARCHAR(64),
     email_unsubscribed BOOLEAN,
     segment_ids       TEXT[],
     version           BIGINT,
     created_at        TIMESTAMPTZ,
     updated_at        TIMESTAMPTZ,
     synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ts_customer_email   ON team_square.customer(email_address)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_customer_updated ON team_square.customer(updated_at)`,

  // ── Migration 209: team_square.payment ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.payment (
     id                        VARCHAR(64)  PRIMARY KEY,
     status                    VARCHAR(20),
     source_type               VARCHAR(30),
     location_id               VARCHAR(64),
     order_id                  VARCHAR(64),
     team_member_id            VARCHAR(64),
     employee_id               VARCHAR(64),
     amount_money_amount       BIGINT,
     amount_money_currency     VARCHAR(10),
     total_money_amount        BIGINT,
     total_money_currency      VARCHAR(10),
     tip_money_amount          BIGINT,
     app_fee_money_amount      BIGINT,
     refunded_money_amount     BIGINT,
     note                      TEXT,
     receipt_number            VARCHAR(20),
     receipt_url               TEXT,
     device_id                 VARCHAR(128),
     device_name               VARCHAR(255),
     card_brand                VARCHAR(30),
     card_last_4               VARCHAR(4),
     card_exp_month            INTEGER,
     card_exp_year             INTEGER,
     card_entry_method         VARCHAR(30),
     buyer_cash_amount         BIGINT,
     change_back_cash_amount   BIGINT,
     created_at                TIMESTAMPTZ,
     updated_at                TIMESTAMPTZ,
     synced_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ts_payment_order     ON team_square.payment(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_payment_location  ON team_square.payment(location_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_payment_created   ON team_square.payment(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_payment_member    ON team_square.payment(team_member_id)`,

  // ── Migration 214: team_square.invoice ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.invoice (
     id                           VARCHAR(128) PRIMARY KEY,
     version                      INTEGER,
     location_id                  VARCHAR(64),
     order_id                     VARCHAR(64),
     invoice_number               VARCHAR(50),
     title                        VARCHAR(255),
     description                  TEXT,
     status                       VARCHAR(30),
     delivery_method              VARCHAR(30),
     timezone                     VARCHAR(64),
     public_url                   TEXT,
     creator_team_member_id       VARCHAR(64),
     recipient_customer_id        VARCHAR(64),
     recipient_given_name         VARCHAR(255),
     recipient_family_name        VARCHAR(255),
     recipient_email_address      VARCHAR(255),
     recipient_phone_number       VARCHAR(50),
     created_at                   TIMESTAMPTZ,
     updated_at                   TIMESTAMPTZ,
     synced_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS team_square.invoice_payment_request (
     id                        BIGSERIAL    PRIMARY KEY,
     invoice_id                VARCHAR(128) NOT NULL REFERENCES team_square.invoice(id) ON DELETE CASCADE,
     uid                       VARCHAR(64),
     request_type              VARCHAR(30),
     due_date                  DATE,
     tipping_enabled           BOOLEAN,
     computed_amount           BIGINT,
     total_completed_amount    BIGINT,
     automatic_payment_source  VARCHAR(30),
     synced_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (invoice_id, uid)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ts_invoice_location ON team_square.invoice(location_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_invoice_status   ON team_square.invoice(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_invoice_updated  ON team_square.invoice(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_ipr_invoice      ON team_square.invoice_payment_request(invoice_id)`,

  // ── Migration 219: team_square.gift_card ──────────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.gift_card (
     id               VARCHAR(128) PRIMARY KEY,
     type             VARCHAR(20),
     gan_source       VARCHAR(20),
     state            VARCHAR(20),
     balance_amount   BIGINT,
     balance_currency VARCHAR(10),
     gan              VARCHAR(64),
     created_at       TIMESTAMPTZ,
     synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ts_giftcard_state ON team_square.gift_card(state)`,

  // ── Migration 221: team_square.inventory_count ────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.inventory_count (
     catalog_object_id    VARCHAR(64)  NOT NULL,
     location_id          VARCHAR(64)  NOT NULL,
     state                VARCHAR(30)  NOT NULL,
     catalog_object_type  VARCHAR(30),
     quantity             NUMERIC,
     calculated_at        TIMESTAMPTZ,
     synced_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     PRIMARY KEY (catalog_object_id, location_id, state)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ts_inv_location ON team_square.inventory_count(location_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_inv_object   ON team_square.inventory_count(catalog_object_id)`,

  // ── Migration 225: team_square.payout ─────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.payout (
     id                VARCHAR(64)   PRIMARY KEY,
     status            VARCHAR(20),
     location_id       VARCHAR(64),
     amount_amount     BIGINT,
     amount_currency   VARCHAR(3),
     destination_type  VARCHAR(50),
     destination_id    VARCHAR(64),
     type              VARCHAR(20),
     arrival_date      DATE,
     end_to_end_id     VARCHAR(100),
     version           INTEGER,
     created_at        TIMESTAMPTZ,
     updated_at        TIMESTAMPTZ,
     synced_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 226: team_square.payout_fee ─────────────────────────────────
  `CREATE TABLE IF NOT EXISTS team_square.payout_fee (
     id               BIGSERIAL    PRIMARY KEY,
     payout_id        VARCHAR(64)  NOT NULL REFERENCES team_square.payout(id) ON DELETE CASCADE,
     type             VARCHAR(50),
     effective_at     TIMESTAMPTZ,
     amount_amount    BIGINT,
     amount_currency  VARCHAR(3),
     synced_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migrations 227-229: payout indexes ────────────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_ts_payout_location   ON team_square.payout(location_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_payout_status     ON team_square.payout(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_payout_created    ON team_square.payout(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ts_payout_fee_payout ON team_square.payout_fee(payout_id)`,

  // ── Migration 230: commerce7_sync_objects ─────────────────────────────────
  `CREATE TABLE IF NOT EXISTS teamtask_hub.commerce7_sync_objects (
     id               BIGSERIAL     PRIMARY KEY,
     company_id       UUID          NOT NULL,
     object_type      VARCHAR(50)   NOT NULL,
     label            VARCHAR(100)  NOT NULL,
     enabled          BOOLEAN       NOT NULL DEFAULT false,
     sync_frequency   VARCHAR(20)   NOT NULL DEFAULT 'every_6h',
     last_synced_at   TIMESTAMPTZ,
     last_sync_status VARCHAR(20),
     last_sync_error  TEXT,
     last_sync_count  INTEGER,
     next_sync_at     TIMESTAMPTZ,
     UNIQUE (company_id, object_type)
   )`,

  // ── Migration 231: index on commerce7_sync_objects ────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_c7_sync_company ON teamtask_hub.commerce7_sync_objects(company_id)`,

  // ── Migration 232: commerce7.product ──────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.product (
     id                   VARCHAR(64)   PRIMARY KEY,
     company_id           UUID          NOT NULL,
     title                VARCHAR(512),
     slug                 VARCHAR(512),
     type                 VARCHAR(100),
     admin_status         VARCHAR(50),
     web_status           VARCHAR(50),
     price                BIGINT,
     compare_price        BIGINT,
     short_description    TEXT,
     description          TEXT,
     image                JSONB,
     images               JSONB,
     tags                 JSONB,
     vendor_id            VARCHAR(64),
     collection_ids       JSONB,
     wine_varietal_ids    JSONB,
     wine_appellation_id  VARCHAR(64),
     vintage              INTEGER,
     alcohol_percentage   NUMERIC(5,2),
     volume_in_ml         INTEGER,
     weight               NUMERIC(10,3),
     country_code         VARCHAR(10),
     region               VARCHAR(255),
     metadata             JSONB,
     c7_created_at        TIMESTAMPTZ,
     c7_updated_at        TIMESTAMPTZ,
     synced_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 233: commerce7.product_variant ──────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.product_variant (
     id                VARCHAR(64)   PRIMARY KEY,
     company_id        UUID          NOT NULL,
     product_id        VARCHAR(64)   NOT NULL REFERENCES commerce7.product(id) ON DELETE CASCADE,
     title             VARCHAR(512),
     sku               VARCHAR(255),
     price             BIGINT,
     compare_price     BIGINT,
     on_hand_count     INTEGER,
     reserve_count     INTEGER,
     allocated_count   INTEGER,
     available_count   INTEGER,
     is_default        BOOLEAN,
     attributes        JSONB,
     metadata          JSONB,
     c7_created_at     TIMESTAMPTZ,
     c7_updated_at     TIMESTAMPTZ,
     synced_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 234: commerce7.collection ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.collection (
     id              VARCHAR(64)   PRIMARY KEY,
     company_id      UUID          NOT NULL,
     title           VARCHAR(512),
     slug            VARCHAR(512),
     is_published    BOOLEAN,
     description     TEXT,
     image           JSONB,
     metadata        JSONB,
     c7_created_at   TIMESTAMPTZ,
     c7_updated_at   TIMESTAMPTZ,
     synced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 235: commerce7.vendor ───────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.vendor (
     id              VARCHAR(64)   PRIMARY KEY,
     company_id      UUID          NOT NULL,
     title           VARCHAR(512),
     c7_created_at   TIMESTAMPTZ,
     c7_updated_at   TIMESTAMPTZ,
     synced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 236: commerce7.wine_varietal ────────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.wine_varietal (
     id              VARCHAR(64)   PRIMARY KEY,
     company_id      UUID          NOT NULL,
     title           VARCHAR(255),
     c7_created_at   TIMESTAMPTZ,
     c7_updated_at   TIMESTAMPTZ,
     synced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 237: commerce7.wine_appellation ─────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.wine_appellation (
     id              VARCHAR(64)   PRIMARY KEY,
     company_id      UUID          NOT NULL,
     title           VARCHAR(255),
     c7_created_at   TIMESTAMPTZ,
     c7_updated_at   TIMESTAMPTZ,
     synced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 238: commerce7.club ─────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.club (
     id              VARCHAR(64)   PRIMARY KEY,
     company_id      UUID          NOT NULL,
     title           VARCHAR(512),
     slug            VARCHAR(512),
     status          VARCHAR(50),
     description     TEXT,
     image           JSONB,
     metadata        JSONB,
     c7_created_at   TIMESTAMPTZ,
     c7_updated_at   TIMESTAMPTZ,
     synced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 239: commerce7.club_membership ──────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.club_membership (
     id                  VARCHAR(64)   PRIMARY KEY,
     company_id          UUID          NOT NULL,
     customer_id         VARCHAR(64),
     club_id             VARCHAR(64),
     status              VARCHAR(50),
     signup_date         DATE,
     cancel_date         DATE,
     next_process_date   DATE,
     frequency           VARCHAR(50),
     shipment_count      INTEGER,
     tags                JSONB,
     metadata            JSONB,
     c7_created_at       TIMESTAMPTZ,
     c7_updated_at       TIMESTAMPTZ,
     synced_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 240: commerce7.reservation ──────────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.reservation (
     id                    VARCHAR(64)   PRIMARY KEY,
     company_id            UUID          NOT NULL,
     customer_id           VARCHAR(64),
     reservation_type_id   VARCHAR(64),
     reservation_date      DATE,
     start_time            VARCHAR(10),
     end_time              VARCHAR(10),
     party_size            INTEGER,
     status                VARCHAR(50),
     payment_status        VARCHAR(50),
     channel               VARCHAR(50),
     sub_total             BIGINT,
     tax_total             BIGINT,
     total                 BIGINT,
     notes                 TEXT,
     tags                  JSONB,
     tenders               JSONB,
     metadata              JSONB,
     c7_created_at         TIMESTAMPTZ,
     c7_updated_at         TIMESTAMPTZ,
     synced_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 241: commerce7.gift_card ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.gift_card (
     id                VARCHAR(64)   PRIMARY KEY,
     company_id        UUID          NOT NULL,
     customer_id       VARCHAR(64),
     code              VARCHAR(255),
     status            VARCHAR(50),
     balance           BIGINT,
     original_balance  BIGINT,
     currency          VARCHAR(10),
     c7_created_at     TIMESTAMPTZ,
     c7_updated_at     TIMESTAMPTZ,
     synced_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migration 242: commerce7.promotion ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS commerce7.promotion (
     id              VARCHAR(64)   PRIMARY KEY,
     company_id      UUID          NOT NULL,
     title           VARCHAR(512),
     type            VARCHAR(100),
     status          VARCHAR(50),
     discount_type   VARCHAR(50),
     discount_value  NUMERIC(10,4),
     start_date      DATE,
     end_date        DATE,
     metadata        JSONB,
     c7_created_at   TIMESTAMPTZ,
     c7_updated_at   TIMESTAMPTZ,
     synced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Migrations 243-254: indexes ───────────────────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_c7_product_company     ON commerce7.product(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_product_updated     ON commerce7.product(c7_updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_product_type        ON commerce7.product(type)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_variant_product     ON commerce7.product_variant(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_variant_company     ON commerce7.product_variant(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_collection_company  ON commerce7.collection(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_club_company        ON commerce7.club(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_membership_company  ON commerce7.club_membership(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_membership_customer ON commerce7.club_membership(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_membership_club     ON commerce7.club_membership(club_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_reservation_company ON commerce7.reservation(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_c7_reservation_date    ON commerce7.reservation(reservation_date)`,

  // ── Migration 255: Amazon Business credentials ────────────────────────────
  `ALTER TABLE teamtask_hub.company_integrations
     ADD COLUMN IF NOT EXISTS amazon_email    VARCHAR(255),
     ADD COLUMN IF NOT EXISTS amazon_password TEXT`,

  // ── Migration 256: Link locations to Square location IDs ─────────────────
  `ALTER TABLE teamtask_hub.locations
     ADD COLUMN IF NOT EXISTS square_location_id VARCHAR(255)`,

  // Auto-populate square_location_id by partial name match (best-effort)
  `UPDATE teamtask_hub.locations l
   SET square_location_id = sq.id
   FROM team_square.location sq
   WHERE l.square_location_id IS NULL
     AND (
       LOWER(sq.name) LIKE '%' || LOWER(l.name) || '%'
       OR LOWER(l.name) LIKE '%' || LOWER(sq.name) || '%'
     )`,

  // ── Migration 258: Add 'gc' role to users check constraint ───────────────
  // Drop and re-add the constraint to include gc
  `DO $$
   BEGIN
     ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
     ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_role;
   EXCEPTION WHEN others THEN NULL;
   END$$`,
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
  `ALTER TABLE users ADD CONSTRAINT users_role_check
     CHECK (role IN ('member', 'manager', 'owner', 'gc'))`,

  // ── Migration 259: rachio_schedules (biweekly irrigation schedules) ───────
  `CREATE TABLE IF NOT EXISTS rachio_schedules (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    zone_id          TEXT        NOT NULL,
    zone_name        TEXT,
    device_id        TEXT        NOT NULL,
    name             TEXT        NOT NULL,
    duration_minutes INTEGER     NOT NULL,
    day_of_week      INTEGER     NOT NULL,
    start_time       TEXT        NOT NULL,
    next_run_at      TIMESTAMPTZ,
    last_run_at      TIMESTAMPTZ,
    enabled          BOOLEAN     NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rachio_schedules_company ON rachio_schedules(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rachio_schedules_next_run ON rachio_schedules(next_run_at) WHERE enabled = true`,

  // ── Migration 260: Anthropic API key on company_integrations ─────────────
  `ALTER TABLE company_integrations ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT`,

  // ── Migration 261: PIN quick-login ────────────────────────────────────────
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash TEXT`,

  // ── Migration 262: Home Assistant (KIN) credentials on company_integrations ─
  `ALTER TABLE company_integrations
     ADD COLUMN IF NOT EXISTS ha_url   VARCHAR(500),
     ADD COLUMN IF NOT EXISTS ha_token VARCHAR(500)`,

  // ── Migration 263: Harvester — automated receipt/invoice collection ────────
  `CREATE TABLE IF NOT EXISTS harvester_sources (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name             VARCHAR(255) NOT NULL,
    connector_type   VARCHAR(100) NOT NULL,
    cron_schedule    VARCHAR(100),
    active           BOOLEAN     NOT NULL DEFAULT true,
    last_run_at      TIMESTAMPTZ,
    last_success_at  TIMESTAMPTZ,
    last_status      VARCHAR(50),
    last_error       TEXT,
    last_records     INTEGER,
    run_requested_at TIMESTAMPTZ,
    config           JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_harvester_sources_company ON harvester_sources(company_id)`,

  // ── Migration 264: store receipt PDF bytes in the database ─────────────────
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS pdf_data BYTEA`,

  // ── Migration 265: Shopping — canonical item catalog ─────────────────────
  `CREATE TABLE IF NOT EXISTS shopping_items (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    description  TEXT,
    category     TEXT,
    par_qty      NUMERIC(10,2),
    par_unit     TEXT        DEFAULT 'box',
    is_routine   BOOLEAN     NOT NULL DEFAULT false,
    notes        TEXT,
    created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shopping_items_company ON shopping_items(company_id)`,

  // ── Migration 266: Shopping — vendor purchase history per item ────────────
  `CREATE TABLE IF NOT EXISTS shopping_item_purchases (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    shopping_item_id UUID        NOT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
    receipt_item_id  UUID        REFERENCES receipt_items(id) ON DELETE SET NULL,
    company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vendor           TEXT,
    description_raw  TEXT,
    price            NUMERIC(10,2),
    quantity         NUMERIC(10,2),
    purchase_date    DATE,
    matched_by       TEXT        DEFAULT 'manual' CHECK (matched_by IN ('ai','manual','auto')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shopping_purchases_item ON shopping_item_purchases(shopping_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shopping_purchases_company ON shopping_item_purchases(company_id)`,

  // ── Migration 267: Shopping — inventory counts per item per location ──────
  `CREATE TABLE IF NOT EXISTS shopping_inventory (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    shopping_item_id UUID        NOT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
    location_id      UUID        REFERENCES locations(id) ON DELETE CASCADE,
    company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sort_order       INTEGER     NOT NULL DEFAULT 0,
    current_qty      NUMERIC(10,2) DEFAULT 0,
    last_counted_at  TIMESTAMPTZ,
    last_counted_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(shopping_item_id, location_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shopping_inventory_company ON shopping_inventory(company_id, location_id)`,

  // ── Migration 268: Shopping — count history log ───────────────────────────
  `CREATE TABLE IF NOT EXISTS shopping_inventory_log (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    shopping_item_id UUID        NOT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
    location_id      UUID        REFERENCES locations(id) ON DELETE CASCADE,
    company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    qty              NUMERIC(10,2) NOT NULL,
    counted_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
    counted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shopping_inv_log_item ON shopping_inventory_log(shopping_item_id, counted_at DESC)`,

  // ── Migration 269: Shopping — raw item dedup table ────────────────────────
  `CREATE TABLE IF NOT EXISTS shopping_item_raw (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    description_raw  TEXT        NOT NULL,
    vendor           TEXT,
    last_price       NUMERIC(10,2),
    last_purchase_date DATE,
    purchase_count   INTEGER     NOT NULL DEFAULT 1,
    shopping_item_id UUID        REFERENCES shopping_items(id) ON DELETE SET NULL,
    ignored          BOOLEAN     NOT NULL DEFAULT false,
    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(company_id, description_raw, vendor)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shopping_item_raw_company ON shopping_item_raw(company_id, ignored, shopping_item_id)`,

  // ── Migration 270: Shopping — item stocked per location ───────────────────
  `CREATE TABLE IF NOT EXISTS shopping_item_locations (
    shopping_item_id UUID NOT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
    location_id      UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    PRIMARY KEY (shopping_item_id, location_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shopping_item_locations_company ON shopping_item_locations(company_id, location_id)`,
  `INSERT INTO shopping_item_locations (shopping_item_id, location_id, company_id)
   SELECT si.id, l.id, si.company_id
   FROM shopping_items si
   JOIN locations l ON l.company_id = si.company_id
   WHERE si.is_routine = true
   ON CONFLICT DO NOTHING`,

  // ── Migration 271: Shopping — fuzzy matching + unit pricing (pg_trgm optional) ─
  `DO $$
   BEGIN
     CREATE EXTENSION IF NOT EXISTS pg_trgm;
   EXCEPTION
     WHEN OTHERS THEN
       RAISE NOTICE 'pg_trgm extension unavailable, skipping: %', SQLERRM;
   END
   $$`,
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
       CREATE INDEX IF NOT EXISTS idx_shopping_item_raw_trgm
         ON shopping_item_raw USING gin (description_raw gin_trgm_ops);
     END IF;
   END
   $$`,
  `ALTER TABLE shopping_item_purchases ADD COLUMN IF NOT EXISTS quantity_purchased NUMERIC(10,2)`,
  `ALTER TABLE shopping_item_purchases ADD COLUMN IF NOT EXISTS unit TEXT`,
  `ALTER TABLE shopping_item_purchases ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10,4)`,
  `ALTER TABLE shopping_item_raw ADD COLUMN IF NOT EXISTS similarity_score NUMERIC(4,3)`,
  `ALTER TABLE shopping_item_raw ADD COLUMN IF NOT EXISTS fuzzy_match_id UUID REFERENCES shopping_items(id) ON DELETE SET NULL`,

  // ── Migration 273: AI condition rules ─────────────────────────────────────
  `ALTER TABLE categorization_rules ADD COLUMN IF NOT EXISTS is_ai_rule BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE categorization_rules ADD COLUMN IF NOT EXISTS ai_condition TEXT`,

  // ── Migration 274: Shopping — buy frequency ───────────────────────────────
  `ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS buy_frequency    TEXT CHECK (buy_frequency IN ('daily','weekly','biweekly','monthly','monthly_weekday','adhoc'))`,
  `ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS buy_day_of_week  INTEGER CHECK (buy_day_of_week BETWEEN 0 AND 6)`,
  `ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS buy_day_of_month INTEGER CHECK (buy_day_of_month BETWEEN 1 AND 31)`,
  `ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS buy_week_of_month INTEGER CHECK (buy_week_of_month BETWEEN 1 AND 5)`,

  // ── Migration 272: Extended receipt_items for vendor-specific structured data ──
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS vendor_item_number TEXT`,
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS pack_size          TEXT`,
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS brand              TEXT`,
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS quantity_cases     NUMERIC(10,2)`,
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS unit_size          TEXT`,
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS price_per_unit     NUMERIC(10,4)`,
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS price_unit_type    TEXT`,
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS delivery_date      DATE`,
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS submitted_by       TEXT`,
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS vendor_data        JSONB`,

  // ── Migration 275: Model selection on skynet_schedules ───────────────────
  `ALTER TABLE skynet_schedules ADD COLUMN IF NOT EXISTS model VARCHAR(100) NOT NULL DEFAULT 'claude-haiku-3-5'`,

  // ── Migration 276: AI model settings per company per process ─────────────
  `CREATE TABLE IF NOT EXISTS ai_model_settings (
  company_id   UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  process_key  VARCHAR(100) NOT NULL,
  model        VARCHAR(100) NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, process_key)
)`,

  // ── Migration 278: commerce7.club — store webStatus + adminStatus separately ─
  // C7 clubs have no 'status' field; they use 'webStatus' and 'adminStatus'.
  // The sync was writing club.status (always undefined) → always NULL.
  // Now writes club.webStatus → status, club.adminStatus → admin_status.
  `ALTER TABLE commerce7.club ADD COLUMN IF NOT EXISTS admin_status VARCHAR(50)`,

  // ── Migration 277: Announcement approval flow ─────────────────────────────
  // status: 'draft' | 'pending_approval' | 'published' (default 'published' = backward compat)
  `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'published'`,
  `CREATE TABLE IF NOT EXISTS announcement_approvals (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    announcement_id UUID        NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    approver_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
    comment         TEXT,
    responded_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(announcement_id, approver_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ann_approvals_announcement ON announcement_approvals(announcement_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ann_approvals_approver     ON announcement_approvals(approver_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ann_approvals_pending      ON announcement_approvals(approver_id) WHERE status = 'pending'`,

  // delivery_address on receipts (Sysco ship-to address)
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS delivery_address VARCHAR(200)`,

  // pack size on receipt_items (e.g. '475 CT', '5012X12')
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS pack VARCHAR(50)`,

  // qbo_purchase_id on receipts — tracks which QBO Purchase a receipt was imported from
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS qbo_purchase_id VARCHAR(50)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS receipts_qbo_purchase_id_company_idx
     ON receipts (company_id, qbo_purchase_id)
     WHERE qbo_purchase_id IS NOT NULL`,

  // task_sms_enabled — when false, sendClosureSms skips sending (default off)
  `ALTER TABLE company_integrations ADD COLUMN IF NOT EXISTS task_sms_enabled BOOLEAN NOT NULL DEFAULT false`,

  // receipt source — tracks how each receipt entered the system
  // 'email' = Amazon email harvester, 'qbo' = QBO attachable import, 'csv' = Chef Store CSV, 'upload' = manual PDF upload
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'email'`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_source ON receipts(company_id, source)`,

  // Amazon session store — Mac pushes fresh cookies here every 12h; Skynet reads before each harvest.
  `CREATE TABLE IF NOT EXISTS amazon_sessions (
     company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
     cookies     JSONB        NOT NULL,
     synced_from VARCHAR(100),
     updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── Recipes — extend shopping_item_raw for recipe ingredient linking ──────────
  `ALTER TABLE shopping_item_raw
     ADD COLUMN IF NOT EXISTS ingredient_id          UUID REFERENCES ingredients(id) ON DELETE SET NULL,
     ADD COLUMN IF NOT EXISTS is_recipe_primary      BOOLEAN NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS servings_per_container NUMERIC(10,3)`,
  `CREATE INDEX IF NOT EXISTS idx_shopping_item_raw_ingredient ON shopping_item_raw(ingredient_id)`,

  // ── Recipes — extend ingredients with COGS + description fields ───────────────
  `ALTER TABLE ingredients
     ADD COLUMN IF NOT EXISTS description TEXT,
     ADD COLUMN IF NOT EXISTS base_unit   VARCHAR(10),
     ADD COLUMN IF NOT EXISTS is_active   BOOLEAN     NOT NULL DEFAULT true,
     ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

  // ── Recipes — recipe master ───────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS recipes (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id        UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name              VARCHAR(255) NOT NULL,
    category          VARCHAR(100),
    description       TEXT,
    instructions      TEXT,
    photo_path        VARCHAR(255),
    prep_time_minutes INTEGER,
    status            VARCHAR(20)  NOT NULL DEFAULT 'active',
    menu_price        NUMERIC(10,2),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recipes_company        ON recipes(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipes_company_status ON recipes(company_id, status)`,

  // ── Recipes — recipe_locations (mirrors announcement_locations) ───────────────
  `CREATE TABLE IF NOT EXISTS recipe_locations (
    recipe_id   UUID NOT NULL REFERENCES recipes(id)   ON DELETE CASCADE,
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    PRIMARY KEY (recipe_id, location_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_locations_recipe ON recipe_locations(recipe_id)`,

  // ── Recipes — recipe_ingredients join table ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id     UUID          NOT NULL REFERENCES recipes(id)      ON DELETE CASCADE,
    ingredient_id UUID          NOT NULL REFERENCES ingredients(id)  ON DELETE RESTRICT,
    quantity      NUMERIC(10,3) NOT NULL,
    unit          VARCHAR(10),
    position      INTEGER       NOT NULL DEFAULT 0,
    note          TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe     ON recipe_ingredients(recipe_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_ingredient ON recipe_ingredients(ingredient_id)`,

  // ── Recipes — backfill shopping_item_raw from all historical receipt_items ──
  // Sysco CSV imports and other non-PDF paths never wrote to shopping_item_raw.
  // This one-time backfill ensures every receipt_item description is visible in
  // the Item Catalog. ON CONFLICT preserves any existing data (ignored flag, etc).
  `WITH grouped AS (
     SELECT
       r.company_id,
       lower(trim(ri.description)) AS description_raw,
       r.vendor,
       MAX(r.order_date)           AS last_purchase_date,
       COUNT(*)                    AS purchase_count
     FROM receipt_items ri
     JOIN receipts r ON r.id = ri.receipt_id
     WHERE ri.description IS NOT NULL AND trim(ri.description) != ''
     GROUP BY r.company_id, lower(trim(ri.description)), r.vendor
   )
   INSERT INTO shopping_item_raw
     (company_id, description_raw, vendor, last_price, last_purchase_date, purchase_count)
   SELECT
     g.company_id,
     g.description_raw,
     g.vendor,
     (SELECT ri2.unit_price
      FROM receipt_items ri2
      JOIN receipts r2 ON r2.id = ri2.receipt_id
      WHERE r2.company_id = g.company_id
        AND lower(trim(ri2.description)) = g.description_raw
        AND r2.vendor IS NOT DISTINCT FROM g.vendor
      ORDER BY r2.order_date DESC NULLS LAST
      LIMIT 1) AS last_price,
     g.last_purchase_date,
     g.purchase_count
   FROM grouped g
   ON CONFLICT (company_id, description_raw, vendor) DO UPDATE SET
     purchase_count     = GREATEST(shopping_item_raw.purchase_count, EXCLUDED.purchase_count),
     last_price         = COALESCE(EXCLUDED.last_price, shopping_item_raw.last_price),
     last_purchase_date = GREATEST(shopping_item_raw.last_purchase_date, EXCLUDED.last_purchase_date),
     updated_at         = NOW()
   WHERE shopping_item_raw.ignored = false`,

  // quantity_unit — unit of measure for the quantity field: 'each', 'lb', 'oz', 'case', etc.
  // Sysco catch-weight items: quantity = T/WT (total weight in lbs), quantity_unit = 'lb'
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS quantity_unit TEXT NOT NULL DEFAULT 'each'`,

  // quantity_grams — canonical weight in grams for lb/oz/g/kg items; null for 'each'/'case'
  `ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS quantity_grams NUMERIC(10,3)`,

  // unit override on catalog items — user-verified unit for container size (lb, oz, g, kg, each, case)
  // overrides the per-receipt last_quantity_unit when computing container grams for COGS
  `ALTER TABLE shopping_item_raw ADD COLUMN IF NOT EXISTS unit TEXT`,

  // ── Recipes — vendor item number as stable catalog key ────────────────────
  // Keying on (vendor, item_number) is more reliable than description text which
  // can vary between invoices. Partial unique index only applies when item number
  // is present; description-based dedup is the fallback for vendors without them.
  `ALTER TABLE shopping_item_raw ADD COLUMN IF NOT EXISTS vendor_item_number TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_shopping_item_raw_vendor_item
     ON shopping_item_raw (company_id, vendor, vendor_item_number)
     WHERE vendor_item_number IS NOT NULL`,

  // Backfill vendor_item_number from receipt_items for existing catalog rows
  `UPDATE shopping_item_raw sir
   SET vendor_item_number = (
     SELECT ri.vendor_item_number
     FROM receipt_items ri
     JOIN receipts r ON r.id = ri.receipt_id
     WHERE r.company_id = sir.company_id
       AND lower(trim(ri.description)) = sir.description_raw
       AND r.vendor IS NOT DISTINCT FROM sir.vendor
       AND ri.vendor_item_number IS NOT NULL
     ORDER BY r.order_date DESC NULLS LAST
     LIMIT 1
   )
   WHERE sir.vendor_item_number IS NULL`,

  // ── Sysco Shop credentials (mirrors amazon_email/amazon_password) ─────────
  // Used by syscoSync Playwright client to log into shop.sysco.com and pull
  // authenticated per-customer catalog data (name, pack, UOM) by item number.
  `ALTER TABLE company_integrations
     ADD COLUMN IF NOT EXISTS sysco_username VARCHAR(255),
     ADD COLUMN IF NOT EXISTS sysco_password TEXT`,

  // ── Recipes — enrichment columns from vendor catalog lookups ──────────────
  // Populated by Chef Store Algolia + Sysco Playwright enrichment. enrich_source
  // records where the clean data came from (chefstore | sysco | manual).
  `ALTER TABLE shopping_item_raw
     ADD COLUMN IF NOT EXISTS product_name  TEXT,
     ADD COLUMN IF NOT EXISTS uom           TEXT,
     ADD COLUMN IF NOT EXISTS pack          TEXT,
     ADD COLUMN IF NOT EXISTS enriched_at   TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS enrich_source TEXT`,

  // ── Recipes — vendor category + food classification ───────────────────────
  // category is the vendor's product category (e.g. "CHEESE", "CHEMICAL/JANTRL").
  // is_food is derived from it: true = grocery/ingredient, false = non-grocery
  // (paper goods, janitorial, packaging), NULL = unknown (not yet enriched).
  `ALTER TABLE shopping_item_raw
     ADD COLUMN IF NOT EXISTS category TEXT,
     ADD COLUMN IF NOT EXISTS is_food  BOOLEAN`,

  // ── raw_item_id: link receipt_items back to shopping_item_raw ────────────
  // Enables indexed spend queries ("how much did we spend on X?") without
  // string scanning. Backfilled for existing rows via vendor_item_number first,
  // then normalized description + vendor.
  `ALTER TABLE receipt_items
     ADD COLUMN IF NOT EXISTS raw_item_id UUID REFERENCES shopping_item_raw(id)`,

  `CREATE INDEX IF NOT EXISTS receipt_items_raw_item_id_idx ON receipt_items(raw_item_id)`,

  // Backfill: item-number match first (most stable key — Sysco / structured vendors)
  `UPDATE receipt_items ri
   SET raw_item_id = sir.id
   FROM receipts r, shopping_item_raw sir
   WHERE ri.receipt_id          = r.id
     AND sir.company_id         = r.company_id
     AND sir.vendor             = r.vendor
     AND sir.vendor_item_number IS NOT NULL
     AND sir.vendor_item_number = ri.vendor_item_number
     AND ri.raw_item_id         IS NULL
     AND ri.vendor_item_number  IS NOT NULL`,

  // Backfill: normalized description + vendor for remaining rows (Amazon, etc.)
  `UPDATE receipt_items ri
   SET raw_item_id = sir.id
   FROM receipts r, shopping_item_raw sir
   WHERE ri.receipt_id      = r.id
     AND sir.company_id     = r.company_id
     AND sir.vendor         = r.vendor
     AND sir.description_raw = lower(trim(ri.description))
     AND ri.raw_item_id     IS NULL`,

  // ── Kitchen consolidation, Phase A (additive) ─────────────────────────────
  // `ingredients` becomes the single canonical purchasable item. Bring over the
  // par-level, buy-schedule, per-location stocking and on-hand inventory
  // features prototyped on the (now-retired) shopping_items tables.
  `ALTER TABLE ingredients
     ADD COLUMN IF NOT EXISTS par_qty           NUMERIC(10,2),
     ADD COLUMN IF NOT EXISTS par_unit          TEXT,
     ADD COLUMN IF NOT EXISTS buy_frequency     TEXT CHECK (buy_frequency IN ('daily','weekly','biweekly','monthly','monthly_weekday','adhoc')),
     ADD COLUMN IF NOT EXISTS buy_day_of_week   INTEGER CHECK (buy_day_of_week BETWEEN 0 AND 6),
     ADD COLUMN IF NOT EXISTS buy_day_of_month  INTEGER CHECK (buy_day_of_month BETWEEN 1 AND 31),
     ADD COLUMN IF NOT EXISTS buy_week_of_month INTEGER CHECK (buy_week_of_month BETWEEN 1 AND 5)`,

  // Which sites stock each ingredient (drives the derived is_routine flag)
  `CREATE TABLE IF NOT EXISTS ingredient_locations (
    ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    location_id   UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    PRIMARY KEY (ingredient_id, location_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ingredient_locations_company ON ingredient_locations(company_id, location_id)`,

  // On-hand counts per ingredient per location
  `CREATE TABLE IF NOT EXISTS ingredient_inventory (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ingredient_id   UUID        NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    location_id     UUID        REFERENCES locations(id) ON DELETE CASCADE,
    company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sort_order      INTEGER     NOT NULL DEFAULT 0,
    current_qty     NUMERIC(10,2) DEFAULT 0,
    last_counted_at TIMESTAMPTZ,
    last_counted_by UUID        REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(ingredient_id, location_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ingredient_inventory_company ON ingredient_inventory(company_id, location_id)`,

  // Count history log
  `CREATE TABLE IF NOT EXISTS ingredient_inventory_log (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ingredient_id UUID        NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    location_id   UUID        REFERENCES locations(id) ON DELETE CASCADE,
    company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    qty           NUMERIC(10,2) NOT NULL,
    counted_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
    counted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ingredient_inv_log_item ON ingredient_inventory_log(ingredient_id, counted_at DESC)`,

  // ── Kitchen consolidation, Phase C (teardown) ────────────────────────────
  // The shopping_items subsystem was a never-finished prototype; its features
  // now live on `ingredients`. Data was backed up to
  // backups/shopping_tables_pre_teardown_2026-06-19.sql before dropping.
  // Drop the FK columns linking shopping_item_raw → shopping_items first.
  `ALTER TABLE shopping_item_raw
     DROP COLUMN IF EXISTS shopping_item_id,
     DROP COLUMN IF EXISTS fuzzy_match_id`,
  `DROP TABLE IF EXISTS shopping_inventory_log`,
  `DROP TABLE IF EXISTS shopping_inventory`,
  `DROP TABLE IF EXISTS shopping_item_purchases`,
  `DROP TABLE IF EXISTS shopping_item_locations`,
  `DROP TABLE IF EXISTS shopping_items`,

  // ── Policy announcements ─────────────────────────────────────────────────
  // A policy is an announcement flagged is_policy=true. It ignores
  // effective_from/until and stays active until the author sets
  // policy_required=false. Signatures are tracked separately from the
  // plain-click announcement_acknowledgments table since a policy needs a
  // typed name + timestamp.
  `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS is_policy BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS policy_required BOOLEAN NOT NULL DEFAULT true`,
  `CREATE TABLE IF NOT EXISTS policy_signatures (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    announcement_id UUID        NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    signed_name     TEXT        NOT NULL,
    signed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(announcement_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_policy_signatures_announcement ON policy_signatures(announcement_id)`,
  `CREATE INDEX IF NOT EXISTS idx_policy_signatures_user ON policy_signatures(user_id)`,

  // ── Wine inventory ────────────────────────────────────────────────────────
  // product_inventory is the fast "current count" cache (one row per
  // product+location, upserted on every entry); product_inventory_log is the
  // append-only history that powers "as of date" reporting. Counts are stored
  // as a single canonical total_bottles (case size is a fixed 12, applied in
  // application code via server/lib/wineInventory.js) so cross-location sums
  // never need separate case/bottle rollover logic.
  `CREATE TABLE IF NOT EXISTS product.product_inventory (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID        NOT NULL REFERENCES product.products(id) ON DELETE CASCADE,
    location_id     UUID        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    total_bottles   INTEGER     NOT NULL DEFAULT 0,
    last_counted_at TIMESTAMPTZ,
    last_counted_by UUID        REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(product_id, location_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_inventory_location ON product.product_inventory(location_id)`,
  `CREATE TABLE IF NOT EXISTS product.product_inventory_log (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id    UUID        NOT NULL REFERENCES product.products(id) ON DELETE CASCADE,
    location_id   UUID        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    total_bottles INTEGER     NOT NULL,
    counted_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
    counted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_inv_log_lookup ON product.product_inventory_log(product_id, location_id, counted_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_product_inv_log_company_date ON product.product_inventory_log(company_id, counted_at DESC)`,

  // Commerce7's top-level product "Type" (e.g. Wine vs Non-Wine) — distinct
  // from wine_style (Red/White/Rosé/etc, sourced from wine.type). Needed to
  // filter wine products out of food/merchandise items synced from C7.
  `ALTER TABLE product.products ADD COLUMN IF NOT EXISTS product_type VARCHAR(100)`,
  `CREATE INDEX IF NOT EXISTS idx_products_type ON product.products(company_id, product_type)`,

  // ── "User + Inventory" role: normal member permissions plus access to
  // Wine Inventory (entry + reports), but not the Products catalog itself.
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
  `ALTER TABLE users ADD CONSTRAINT users_role_check
     CHECK (role IN ('member', 'manager', 'owner', 'gc', 'inventory'))`,

  // ── Kitchen: per-location PAR levels ─────────────────────────────────────
  // Par used to be a single global value on ingredients.par_qty. Each location
  // now sets its own par (stocking config lives on ingredient_locations, the
  // count lives on ingredient_inventory). Seed each stocked location's par from
  // the old global value so nothing is lost; ingredients.par_qty stays as the
  // default applied to newly-stocked locations.
  `ALTER TABLE ingredient_locations
     ADD COLUMN IF NOT EXISTS par_qty  NUMERIC(10,2),
     ADD COLUMN IF NOT EXISTS par_unit TEXT`,
  `UPDATE ingredient_locations il
     SET par_qty = i.par_qty, par_unit = i.par_unit
     FROM ingredients i
     WHERE i.id = il.ingredient_id
       AND il.par_qty IS NULL
       AND i.par_qty IS NOT NULL`,

  // ── Kitchen: single company-wide "cost to shop" ──────────────────────────
  // One flat trip cost distributed across a shopping list by each item's dollar
  // share. (Phase 2 source-comparison may later need per-store costs.)
  `CREATE TABLE IF NOT EXISTS kitchen_settings (
    company_id   UUID          PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    cost_to_shop NUMERIC(10,2) NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  )`,

  // Cost to shop is PER STORE (two stores on a run = two trip costs). Each
  // store's cost is spread only across that store's items. kitchen_settings
  // .cost_to_shop is kept as the default applied to stores with no explicit cost.
  `CREATE TABLE IF NOT EXISTS kitchen_store_costs (
    company_id   UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vendor       TEXT          NOT NULL,
    cost_to_shop NUMERIC(10,2) NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, vendor)
  )`,

  // ── Kitchen: per-location buy frequency ──────────────────────────────────
  // Like par, buy frequency/schedule is per location. Seed each stocked
  // location from the old global values on ingredients.
  `ALTER TABLE ingredient_locations
     ADD COLUMN IF NOT EXISTS buy_frequency     TEXT CHECK (buy_frequency IN ('daily','weekly','biweekly','monthly','monthly_weekday','adhoc')),
     ADD COLUMN IF NOT EXISTS buy_day_of_week   INTEGER CHECK (buy_day_of_week BETWEEN 0 AND 6),
     ADD COLUMN IF NOT EXISTS buy_day_of_month  INTEGER CHECK (buy_day_of_month BETWEEN 1 AND 31),
     ADD COLUMN IF NOT EXISTS buy_week_of_month INTEGER CHECK (buy_week_of_month BETWEEN 1 AND 5)`,
  `UPDATE ingredient_locations il
     SET buy_frequency     = i.buy_frequency,
         buy_day_of_week   = i.buy_day_of_week,
         buy_day_of_month  = i.buy_day_of_month,
         buy_week_of_month = i.buy_week_of_month
     FROM ingredients i
     WHERE i.id = il.ingredient_id
       AND il.buy_frequency IS NULL
       AND i.buy_frequency IS NOT NULL`,

  // ── Recipes can consume other recipes (sub-recipes / components) ──────────
  // e.g. Burrata (a prep recipe) is a component of the Fennel Thyme & Sausage
  // pizza. child_recipe_id is RESTRICT so a recipe used as a component can't be
  // deleted out from under its parent.
  `CREATE TABLE IF NOT EXISTS recipe_components (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    child_recipe_id  UUID NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
    company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    quantity         NUMERIC(10,3),
    unit             VARCHAR(10),
    position         INTEGER NOT NULL DEFAULT 0,
    note             TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_components_parent ON recipe_components(parent_recipe_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_components_child  ON recipe_components(child_recipe_id)`,
];

export async function runMigrations() {
  const schema = process.env.DB_SCHEMA || 'teamtask_hub';

  // Ensure the tracking table exists (always safe to run)
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER     PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Find which versions are already applied
  const applied = await query(`SELECT version FROM schema_migrations ORDER BY version`);
  const appliedSet = new Set(applied.rows.map((r) => r.version));

  let ran = 0;
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (appliedSet.has(version)) continue; // already applied — skip

    try {
      await query(MIGRATIONS[i]);
      await query(`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`, [version]);
      console.log(`  Migration ${version} applied.`);
      ran++;
    } catch (err) {
      console.error(`  Migration ${version} failed:`, err.message);
      throw err;
    }
  }

  if (ran === 0) {
    console.log('Migrations: schema is up to date.');
  } else {
    console.log(`Migrations: ${ran} applied.`);
  }
}

// Allow running directly: node scripts/run-migrations.js
if (process.argv[1]?.endsWith('run-migrations.js')) {
  runMigrations().then(() => process.exit(0)).catch(() => process.exit(1));
}
