-- Monthly ending debt balances per company (Debt Report chart / comparison).
CREATE TABLE IF NOT EXISTS debt_monthly_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  year INTEGER NOT NULL CHECK (year >= 1900 AND year <= 2100),
  month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
  ending_balance NUMERIC(14, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_debt_monthly_balances_company_year
  ON debt_monthly_balances(company_id, year);
