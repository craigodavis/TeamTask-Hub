-- Campaign Monitor credentials are stored in Club Steward (club_steward.company_settings).

ALTER TABLE company_integrations
  DROP COLUMN IF EXISTS campaign_monitor_api_key,
  DROP COLUMN IF EXISTS campaign_monitor_api_clientid,
  DROP COLUMN IF EXISTS campaign_monitor_api_secret;
