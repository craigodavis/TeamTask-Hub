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
