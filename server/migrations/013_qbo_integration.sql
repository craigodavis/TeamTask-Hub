ALTER TABLE company_integrations
  ADD COLUMN IF NOT EXISTS qbo_access_token      VARCHAR(2000),
  ADD COLUMN IF NOT EXISTS qbo_refresh_token     VARCHAR(2000),
  ADD COLUMN IF NOT EXISTS qbo_token_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qbo_realm_id          VARCHAR(100),
  ADD COLUMN IF NOT EXISTS qbo_environment       VARCHAR(50) DEFAULT 'production',
  ADD COLUMN IF NOT EXISTS qbo_pending_state     VARCHAR(200);
