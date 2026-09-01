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
  // Regular weekly hours — one row per open interval. A (location, department, day)
  // with no rows = closed that day. Multiple rows/day support split hours.
  `CREATE TABLE IF NOT EXISTS kindred_web.hours (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID,
    location_id  UUID NOT NULL,                         -- locations.id (teamtask_hub)
    department   VARCHAR(40) NOT NULL DEFAULT 'main',   -- main | kitchen | ...
    day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sunday
    opens        TIME NOT NULL,
    closes       TIME NOT NULL,
    sort         SMALLINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kw_hours_loc ON kindred_web.hours(location_id, department, day_of_week)`,

  // Seasonal hours: the SAME weekday rule, optionally bounded by a date window.
  // Both NULL (every existing row) means "all year", so this needs no migration.
  // "Saturdays in August we close at 10" is one row: day_of_week=6, from 08-01,
  // to 08-31. Resolution is most-specific-wins — an exact-date row in
  // hours_special beats a bounded rule, which beats the unbounded year-round one.
  `ALTER TABLE kindred_web.hours ADD COLUMN IF NOT EXISTS from_date DATE`,
  `ALTER TABLE kindred_web.hours ADD COLUMN IF NOT EXISTS to_date   DATE`,
  `ALTER TABLE kindred_web.hours ADD COLUMN IF NOT EXISTS label     VARCHAR(80)`,
  `CREATE INDEX IF NOT EXISTS idx_kw_hours_season
     ON kindred_web.hours(location_id, department, day_of_week, from_date, to_date)`,

  // Special / holiday hours + temporary closures for specific dates (override regular).
  `CREATE TABLE IF NOT EXISTS kindred_web.hours_special (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID,
    location_id  UUID NOT NULL,
    department   VARCHAR(40) NOT NULL DEFAULT 'main',
    on_date      DATE NOT NULL,
    is_closed    BOOLEAN NOT NULL DEFAULT false,
    opens        TIME,
    closes       TIME,
    note         VARCHAR(120),                          -- e.g. "Thanksgiving"
    sort         SMALLINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kw_hours_special ON kindred_web.hours_special(location_id, department, on_date)`,

  // Who confirmed the outside listings were updated, and when.
  // Google/Apple/Facebook are still updated by hand, so hours can be saved here
  // and silently disagree with what's published. This turns that into a record:
  // after saving, the manager ticks off each listing, and we keep the receipt.
  // When the API pushes land this becomes the fallback log rather than dead weight.
  `CREATE TABLE IF NOT EXISTS kindred_web.hours_publish_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID,
    location_id   UUID NOT NULL,
    google        BOOLEAN NOT NULL DEFAULT false,
    apple         BOOLEAN NOT NULL DEFAULT false,
    facebook      BOOLEAN NOT NULL DEFAULT false,
    confirmed_by  UUID,
    confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kw_publish_log ON kindred_web.hours_publish_log(location_id, confirmed_at DESC)`,

  // Per-venue public details: address, phone, geo — for website structured data
  // and the Google/Apple hours pushes. Keyed to a location (teamtask_hub.locations).
  `CREATE TABLE IF NOT EXISTS kindred_web.venue_details (
    location_id   UUID PRIMARY KEY,
    street        VARCHAR(200),
    city          VARCHAR(120),
    region        VARCHAR(60),          -- state/province
    postal        VARCHAR(20),
    country       VARCHAR(4) NOT NULL DEFAULT 'US',
    phone         VARCHAR(40),
    lat           NUMERIC(9,6),
    lng           NUMERIC(9,6),
    price_range   VARCHAR(10),          -- e.g. "$$"
    gbp_location  VARCHAR(200),         -- Google Business Profile location resource name (push target)
    apple_location VARCHAR(200),        -- Apple Business Connect location id (push target)
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by    UUID
  )`,

  // Page image slots: which library image fills each named spot on the website.
  `CREATE TABLE IF NOT EXISTS kindred_web.page_images (
    slot_key    VARCHAR(80) PRIMARY KEY,
    media_id    UUID REFERENCES kindred_web.media(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  UUID
  )`,

  // Per-venue ResOS reservation config (API key per location). Manager-only;
  // NEVER exposed by the public /api/website endpoints — used server-side to
  // proxy availability + bookings to ResOS.
  `CREATE TABLE IF NOT EXISTS kindred_web.resos_config (
    location_id   UUID PRIMARY KEY,
    api_key       TEXT,
    api_base      VARCHAR(120) NOT NULL DEFAULT 'https://api.resos.com',
    slot_minutes  SMALLINT NOT NULL DEFAULT 90,   -- booking duration used for availability windows
    active        BOOLEAN NOT NULL DEFAULT true,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by    UUID
  )`,

  // Cached Instagram media (fetched from the IG Graph API on a schedule; the
  // website reads this cache so tokens stay server-side and the site stays fast).
  `CREATE TABLE IF NOT EXISTS kindred_web.instagram_media (
    id             VARCHAR(64) PRIMARY KEY,
    media_type     VARCHAR(20),
    media_url      TEXT,
    thumbnail_url  TEXT,
    permalink      TEXT,
    caption        TEXT,
    posted_at      TIMESTAMPTZ,
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kw_ig_posted ON kindred_web.instagram_media(posted_at DESC)`,

  // The Crew — staff profiles for the public "meet the team" page.
  //
  // Keyed on Square's team member id, NOT users.id. The Square integration hard
  // deletes app users whose team member has gone (routes/integrations.js), so a
  // profile hung off users.id would be destroyed when a seasonal employee cycles
  // out — and Square keeps its own row, INACTIVE, forever. No FK: cross-schema,
  // and team_square syncs independently, which is already the house norm here.
  //
  // Nothing about publication is stored as a flag. Someone is public only if they
  // consented, a manager approved, and Square still says ACTIVE — evaluated at
  // read time in the /api/website projection, so the day somebody leaves they come
  // off the site without anyone having to remember to do it.
  `CREATE TABLE IF NOT EXISTS kindred_web.crew_profile (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    square_team_member_id  VARCHAR(64) NOT NULL UNIQUE,
    slug                   VARCHAR(80) UNIQUE,   -- assigned once at first publish, then frozen
    nickname               VARCHAR(60),
    bio                    TEXT,
    education              TEXT,
    square_job_id          VARCHAR(64),          -- which Square assignment to show; half the crew has several
    media_id               UUID REFERENCES kindred_web.media(id) ON DELETE SET NULL,
    consent_at             TIMESTAMPTZ,          -- the employee agreed to appear
    approved_at            TIMESTAMPTZ,          -- a manager cleared the copy
    approved_by            UUID,
    sort_order             INT NOT NULL DEFAULT 0,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by             UUID
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kw_crew_order ON kindred_web.crew_profile(sort_order, id)`,

  // Website form submissions (newsletter signups + contact messages).
  `CREATE TABLE IF NOT EXISTS kindred_web.form_submissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        VARCHAR(20) NOT NULL,          -- newsletter | contact
    name        VARCHAR(200),
    email       VARCHAR(255),
    message     TEXT,
    meta        JSONB,                         -- ip, user-agent, referer
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kw_form_submissions ON kindred_web.form_submissions(kind, created_at DESC)`,

  // ---- Special Event Requests (mirrors migrations/057_event_requests.sql) ----
  `CREATE TABLE IF NOT EXISTS kindred_web.event_tiers (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    min_guests            INTEGER NOT NULL,
    max_guests            INTEGER,
    title                 VARCHAR(120),
    base_price_cents      INTEGER NOT NULL DEFAULT 0,
    min_alcohol_cents     INTEGER NOT NULL DEFAULT 0,
    rules                 TEXT,
    deposit_required      BOOLEAN NOT NULL DEFAULT FALSE,
    deposit_cents         INTEGER NOT NULL DEFAULT 0,
    deposit_description   TEXT,
    insurance_required    BOOLEAN NOT NULL DEFAULT FALSE,
    insurance_description TEXT,
    sort_order            INTEGER NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kw_event_tiers_band ON kindred_web.event_tiers(min_guests, max_guests)`,

  `CREATE TABLE IF NOT EXISTS kindred_web.event_requests (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name         VARCHAR(120) NOT NULL,
    last_name          VARCHAR(120) NOT NULL,
    email              VARCHAR(255) NOT NULL,
    phone              VARCHAR(40),
    address            TEXT,
    event_date         DATE NOT NULL,
    guests             INTEGER NOT NULL,
    notes              TEXT,
    tier_id            UUID REFERENCES kindred_web.event_tiers(id) ON DELETE SET NULL,
    quoted_base_cents         INTEGER,
    quoted_min_alcohol_cents  INTEGER,
    quoted_deposit_cents      INTEGER,
    deposit_required   BOOLEAN NOT NULL DEFAULT FALSE,
    insurance_required BOOLEAN NOT NULL DEFAULT FALSE,
    status             VARCHAR(20) NOT NULL DEFAULT 'new',
    approved_at        TIMESTAMPTZ,
    approved_by        UUID,
    declined_reason    TEXT,
    token              VARCHAR(64) NOT NULL UNIQUE,
    token_expires_at   TIMESTAMPTZ,
    square_invoice_id      VARCHAR(191),
    square_invoice_url     TEXT,
    square_invoice_status  VARCHAR(40),
    deposit_paid_at        TIMESTAMPTZ,
    insurance_media_id     UUID,
    insurance_uploaded_at  TIMESTAMPTZ,
    insurance_ok           BOOLEAN NOT NULL DEFAULT FALSE,
    insurance_ok_at        TIMESTAMPTZ,
    insurance_ok_by        UUID,
    meta               JSONB,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kw_event_requests_status ON kindred_web.event_requests(status, event_date)`,
  `CREATE INDEX IF NOT EXISTS idx_kw_event_requests_created ON kindred_web.event_requests(created_at DESC)`,

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
