-- Mail config per company (Owner configures in Settings > Mail tab).
-- Run against your schema first if needed (e.g. SET search_path TO teamtask_hub;).

ALTER TABLE company_integrations
  ADD COLUMN IF NOT EXISTS mail_host     VARCHAR(255),
  ADD COLUMN IF NOT EXISTS mail_port     INTEGER,
  ADD COLUMN IF NOT EXISTS mail_user     VARCHAR(255),
  ADD COLUMN IF NOT EXISTS mail_pass     VARCHAR(500),
  ADD COLUMN IF NOT EXISTS mail_from     VARCHAR(255),
  ADD COLUMN IF NOT EXISTS mail_secure   BOOLEAN DEFAULT false;
