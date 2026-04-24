-- Month-end debt balances for company 8d2df498-b5c0-4f73-94cd-323956036113.
-- Run with your DB connection and schema, e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET search_path TO teamtask_hub;" -f server/scripts/insert-debt-balances.sql
-- (Adjust search_path to match DB_SCHEMA in server/.env if not teamtask_hub.)
--
-- Dec 2024 = 145686 from the "Previous" column on 2025-01; other rows use month-end "New Balance".

INSERT INTO debt_monthly_balances (company_id, year, month, ending_balance, updated_at) VALUES
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2024, 12, 145686.00, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025,  1, 191484.00, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025,  2, 191282.00, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025,  3, 173795.00, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025,  4, 172667.06, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025,  5, 173872.42, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025,  6, 169705.03, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025,  7, 147778.13, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025,  8, 131728.15, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025,  9, 131208.96, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025, 10, 131069.36, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025, 11, 151974.27, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2025, 12, 183987.29, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2026,  1, 183057.73, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2026,  2, 211148.08, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2026,  3, 211070.12, NOW()),
  ('8d2df498-b5c0-4f73-94cd-323956036113'::uuid, 2026,  4, 196320.33, NOW())
ON CONFLICT (company_id, year, month)
DO UPDATE SET
  ending_balance = EXCLUDED.ending_balance,
  updated_at = EXCLUDED.updated_at;
