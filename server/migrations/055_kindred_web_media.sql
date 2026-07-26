-- 055: kindred_web schema + media manager table (website media manager)
-- Part of the kindredvineyards.com rebuild. This schema houses website content
-- edited from Team's Marketing → Website area and read by the Astro site.
--
-- Run against the shared DB (kindredv_kindred). Fully schema-qualified so it is
-- independent of the app's DB_SCHEMA search_path (teamtask_hub).
--   psql "$CONN" -f server/migrations/055_kindred_web_media.sql

CREATE SCHEMA IF NOT EXISTS kindred_web;

CREATE TABLE IF NOT EXISTS kindred_web.media (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename       VARCHAR(255) NOT NULL,        -- stored (on-disk) filename of the original
  original_name  VARCHAR(255),                 -- original upload / WordPress filename
  url            VARCHAR(500) NOT NULL,        -- /api/uploads/media/<filename>
  mime           VARCHAR(100),
  width          INTEGER,
  height         INTEGER,
  size_bytes     BIGINT,
  alt_text       TEXT,                         -- accessibility + SEO (Google reads it)
  caption        TEXT,
  credit         VARCHAR(255),                 -- e.g. "Ed Hoffman"
  folder         VARCHAR(120) NOT NULL DEFAULT 'library',   -- library | needs-review | hero | wines | ...
  tags           TEXT[],                       -- searchable tags
  variants       JSONB,                        -- responsive derivatives: { webp:[{w,url}], avif:[{w,url}] }
  source         VARCHAR(30) NOT NULL DEFAULT 'upload',     -- upload | imported | ai-flagged
  source_url     VARCHAR(700),                 -- original WordPress URL when imported (also the import de-dupe key)
  company_id     UUID,                         -- optional; future multi-property use. No cross-schema FK by design.
  uploaded_by    UUID,                         -- Team user id (no cross-schema FK by design)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kw_media_folder  ON kindred_web.media(folder);
CREATE INDEX IF NOT EXISTS idx_kw_media_source  ON kindred_web.media(source);
CREATE INDEX IF NOT EXISTS idx_kw_media_created ON kindred_web.media(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kw_media_tags    ON kindred_web.media USING GIN(tags);
-- Prevent importing the same WordPress asset twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kw_media_source_url ON kindred_web.media(source_url) WHERE source_url IS NOT NULL;
