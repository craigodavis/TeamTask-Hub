/**
 * Ensure the kindred_web schema + website tables exist. Called at server startup
 * (same pattern as ensureLocationsTables) so no manual migration step is needed —
 * deploying the app creates everything.
 *
 * Fully schema-qualified so it is independent of the app's search_path (teamtask_hub).
 * Mirrors server/migrations/055_kindred_web_media.sql.
 */
import { query } from './db.js';

const STATEMENTS = [
  `CREATE SCHEMA IF NOT EXISTS kindred_web`,
  `CREATE TABLE IF NOT EXISTS kindred_web.media (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename       VARCHAR(255) NOT NULL,
    original_name  VARCHAR(255),
    url            VARCHAR(500) NOT NULL,
    mime           VARCHAR(100),
    width          INTEGER,
    height         INTEGER,
    size_bytes     BIGINT,
    alt_text       TEXT,
    caption        TEXT,
    credit         VARCHAR(255),
    folder         VARCHAR(300) NOT NULL DEFAULT 'library',
    tags           TEXT[],
    variants       JSONB,
    source         VARCHAR(30) NOT NULL DEFAULT 'upload',
    source_url     VARCHAR(700),
    company_id     UUID,
    uploaded_by    UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kw_media_folder  ON kindred_web.media(folder)`,
  `CREATE INDEX IF NOT EXISTS idx_kw_media_source  ON kindred_web.media(source)`,
  `CREATE INDEX IF NOT EXISTS idx_kw_media_created ON kindred_web.media(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_kw_media_tags    ON kindred_web.media USING GIN(tags)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_kw_media_source_url ON kindred_web.media(source_url) WHERE source_url IS NOT NULL`,
  // Website settings (key/value), edited in Team → Marketing → Website, read by the site.
  `CREATE TABLE IF NOT EXISTS kindred_web.settings (
    key         VARCHAR(80) PRIMARY KEY,
    value       JSONB,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  UUID
  )`,
  // Widen folder for nested FileBird paths (only if an older, narrower table exists).
  `DO $$ BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'kindred_web' AND table_name = 'media'
         AND column_name = 'folder'
         AND character_maximum_length IS NOT NULL AND character_maximum_length < 300
     ) THEN
       ALTER TABLE kindred_web.media ALTER COLUMN folder TYPE VARCHAR(300);
     END IF;
   END $$`,
];

export async function ensureKindredWebTables() {
  for (const sql of STATEMENTS) {
    await query(sql);
  }
}
