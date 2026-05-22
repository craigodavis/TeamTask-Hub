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
