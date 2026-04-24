/**
 * Upsert the provided month-end debt balances for one company.
 *
 * Usage (from repo root):
 *   COMPANY_ID=<companies.id uuid> node server/scripts/insert-debt-balances.js
 *   node server/scripts/insert-debt-balances.js <uuid>
 *
 * "New Balance" from your sheet is stored as ending_balance for that month.
 * Dec 2024 (145686) is included from the Jan 2025 previous column for chart continuity.
 */
import { query, pool } from '../db.js';

const companyId = process.argv[2] || process.env.COMPANY_ID;
if (!companyId || !/^[0-9a-f-]{36}$/i.test(companyId)) {
  console.error('Set COMPANY_ID or pass UUID as first argument. Example:');
  console.error('  COMPANY_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx node server/scripts/insert-debt-balances.js');
  process.exit(1);
}

/** [year, month, ending_balance] — month 1–12 */
const ROWS = [
  [2024, 12, 145686],
  [2025, 1, 191484],
  [2025, 2, 191282],
  [2025, 3, 173795],
  [2025, 4, 172667.06],
  [2025, 5, 173872.42],
  [2025, 6, 169705.03],
  [2025, 7, 147778.13],
  [2025, 8, 131728.15],
  [2025, 9, 131208.96],
  [2025, 10, 131069.36],
  [2025, 11, 151974.27],
  [2025, 12, 183987.29],
  [2026, 1, 183057.73],
  [2026, 2, 211148.08],
  [2026, 3, 211070.12],
  [2026, 4, 196320.33],
];

const sql = `INSERT INTO debt_monthly_balances (company_id, year, month, ending_balance, updated_at)
  VALUES ($1, $2, $3, $4, NOW())
  ON CONFLICT (company_id, year, month)
  DO UPDATE SET ending_balance = EXCLUDED.ending_balance, updated_at = NOW()`;

async function main() {
  for (const [year, month, ending_balance] of ROWS) {
    await query(sql, [companyId, year, month, ending_balance]);
    console.log(`  ${year}-${String(month).padStart(2, '0')} → ${ending_balance}`);
  }
  console.log(`Upserted ${ROWS.length} rows for company ${companyId}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
