/**
 * CLI: return a bottled lot to bulk.
 *
 *   node scripts/return-to-barrel.js <projectId> <YYYY-MM-DD> [bottles] [reason]
 *
 * Exists because there is no vintly lot screen yet, and the 24 Into the Mystic
 * unbottling had to be recorded before the July and August ABC filings. Shares
 * lib/returnToBarrel.js with the HTTP route, so the guards are identical — it will
 * refuse the same ambiguous lot-to-product matches rather than zeroing a guess.
 */
import { pool } from '../db.js';
import { returnToBarrel } from '../lib/returnToBarrel.js';

const [projectId, unbottledOn, bottlesArg, ...reasonParts] = process.argv.slice(2);
const companyId = process.env.COMPANY_ID;

if (!projectId || !unbottledOn || !companyId) {
  console.error('Usage: COMPANY_ID=<uuid> node scripts/return-to-barrel.js <projectId> <YYYY-MM-DD> [bottles] [reason]');
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query(`SET search_path TO product, ${process.env.DB_SCHEMA || 'teamtask_hub'}`);
  const out = await returnToBarrel(client, {
    companyId,
    projectId,
    unbottledOn,
    bottles: bottlesArg,
    reason: reasonParts.join(' ') || undefined,
  });
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.error ? 1 : 0);
} finally {
  client.release();
  await pool.end();
}
