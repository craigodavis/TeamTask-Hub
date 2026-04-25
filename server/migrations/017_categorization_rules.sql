-- Categorization rules — applied after AI suggestions, first match wins
CREATE TABLE IF NOT EXISTS categorization_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 100,   -- lower = runs first

  -- IF conditions (all non-null conditions must match)
  if_description_contains TEXT,              -- case-insensitive substring
  if_vendor               VARCHAR(100),       -- exact match (null = any vendor)
  if_account_type_contains TEXT,             -- e.g. "Asset" matches "Other Asset", "Fixed Asset"

  -- THEN actions
  then_account_id   VARCHAR(50),             -- force this QBO account id
  then_class_id     VARCHAR(50),             -- force this QBO class id
  then_clear        BOOLEAN NOT NULL DEFAULT false,  -- clear AI suggestion entirely

  notes       TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cat_rules_company ON categorization_rules(company_id, priority);
