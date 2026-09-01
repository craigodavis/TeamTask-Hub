-- Special Event Requests: the public enquiry form, its per-guest-count tiers,
-- and the approval workflow that follows (deposit invoice + proof of insurance).
--
-- Mirrored in server/ensureKindredWebTables.js so a deploy creates it without a
-- manual migration step — that file is the one that actually runs.

CREATE SCHEMA IF NOT EXISTS kindred_web;

-- What we require of an event, banded by how many people are coming.
-- Bands are [min_guests, max_guests]; max NULL means "and above".
CREATE TABLE IF NOT EXISTS kindred_web.event_tiers (
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
);

CREATE INDEX IF NOT EXISTS idx_kw_event_tiers_band
  ON kindred_web.event_tiers(min_guests, max_guests);

CREATE TABLE IF NOT EXISTS kindred_web.event_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What the guest told us.
  first_name         VARCHAR(120) NOT NULL,
  last_name          VARCHAR(120) NOT NULL,
  email              VARCHAR(255) NOT NULL,
  phone              VARCHAR(40),
  address            TEXT,
  event_date         DATE NOT NULL,
  guests             INTEGER NOT NULL,
  notes              TEXT,

  -- The tier that applied WHEN THEY ASKED. Kept by value, not just by id: tiers
  -- get edited, and a guest who was quoted $500 must not silently be held to a
  -- later $750. tier_id is for reporting; the *_cents columns are the quote.
  tier_id            UUID REFERENCES kindred_web.event_tiers(id) ON DELETE SET NULL,
  quoted_base_cents      INTEGER,
  quoted_min_alcohol_cents INTEGER,
  quoted_deposit_cents   INTEGER,
  deposit_required   BOOLEAN NOT NULL DEFAULT FALSE,
  insurance_required BOOLEAN NOT NULL DEFAULT FALSE,

  -- Workflow. `approved` is the flag staff set; everything downstream keys off it.
  status             VARCHAR(20) NOT NULL DEFAULT 'new',   -- new | approved | declined | complete
  approved_at        TIMESTAMPTZ,
  approved_by        UUID,
  declined_reason    TEXT,

  -- The guest's return link. Long, random, and the only thing standing between
  -- the public and someone else's event — so it is unique and never reused.
  token              VARCHAR(64) NOT NULL UNIQUE,
  token_expires_at   TIMESTAMPTZ,

  -- Deposit, via a Square invoice. We store the id and the last status Square
  -- gave us; Square remains the authority on whether it is actually paid.
  square_invoice_id      VARCHAR(191),
  square_invoice_url     TEXT,
  square_invoice_status  VARCHAR(40),
  deposit_paid_at        TIMESTAMPTZ,

  -- Proof of insurance. A third party's document with their details on it, so it
  -- lives behind Team's auth, never on a public URL.
  insurance_media_id  UUID,
  insurance_uploaded_at TIMESTAMPTZ,
  insurance_ok        BOOLEAN NOT NULL DEFAULT FALSE,
  insurance_ok_at     TIMESTAMPTZ,
  insurance_ok_by     UUID,

  meta               JSONB,                                -- ip, user-agent, referer
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kw_event_requests_status
  ON kindred_web.event_requests(status, event_date);
CREATE INDEX IF NOT EXISTS idx_kw_event_requests_created
  ON kindred_web.event_requests(created_at DESC);
