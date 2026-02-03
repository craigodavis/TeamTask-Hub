-- Add Square Application ID to company_integrations (per-app identifier from Square Developer Dashboard).
-- Run against your schema (e.g. SET search_path TO teamtask_hub; first).

ALTER TABLE company_integrations
  ADD COLUMN IF NOT EXISTS square_application_id VARCHAR(100);
