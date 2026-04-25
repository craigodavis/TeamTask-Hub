-- QBO Accounts (Chart of Accounts) — synced daily from QuickBooks
CREATE TABLE IF NOT EXISTS qbo_accounts (
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  qbo_id           VARCHAR(50) NOT NULL,
  name             VARCHAR(255) NOT NULL,
  fully_qualified_name VARCHAR(500),
  account_type     VARCHAR(100),
  account_sub_type VARCHAR(100),
  active           BOOLEAN NOT NULL DEFAULT true,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, qbo_id)
);

-- QBO Classes — synced daily from QuickBooks
CREATE TABLE IF NOT EXISTS qbo_classes (
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  qbo_id           VARCHAR(50) NOT NULL,
  name             VARCHAR(255) NOT NULL,
  fully_qualified_name VARCHAR(500),
  parent_id        VARCHAR(50),
  active           BOOLEAN NOT NULL DEFAULT true,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, qbo_id)
);
