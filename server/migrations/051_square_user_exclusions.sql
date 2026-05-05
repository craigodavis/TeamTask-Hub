CREATE TABLE IF NOT EXISTS square_user_exclusions (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  square_team_member_id VARCHAR(100) NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, square_team_member_id)
);

CREATE INDEX IF NOT EXISTS idx_square_user_exclusions_company
  ON square_user_exclusions(company_id);
