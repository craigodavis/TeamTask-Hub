-- Debt ceiling (max borrowing) for debt report chart; one value per company.
ALTER TABLE company_integrations
  ADD COLUMN IF NOT EXISTS debt_ceiling NUMERIC(14, 2);
