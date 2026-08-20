/**
 * Give every existing user the capability grants matching what their current
 * role can already reach. Step 1 of the permissions matrix.
 *
 *   node scripts/backfill-capabilities.js          # report only
 *   node scripts/backfill-capabilities.js --apply  # write
 *
 * Idempotent, and additive only: it never revokes. Nothing reads
 * user_capabilities yet, so this changes no behaviour -- it exists so that when
 * the guards do switch over (step 2) every person's access is already correct
 * and nobody is locked out at the moment of the cutover.
 */
import dotenv from 'dotenv';
dotenv.config();
import { query, pool } from '../db.js';
import { LEGACY_ROLE_GRANTS, capabilitiesForRole, isCustomized, PRESETS } from '../lib/capabilities.js';

/**
 * `inventory`, `schedule` and `gc` are not roles in the new model -- they
 * become a member plus specific grants. Their `users.role` is deliberately NOT
 * rewritten here: the guards still read that column, so changing it now would
 * strip those two people of the inventory screens the moment this runs. The
 * column gets flipped in step 2, in the same change that makes the guards read
 * capabilities instead.
 */
const ROLE_AFTER_CUTOVER = { inventory: 'member', schedule: 'member', gc: 'member' };

const APPLY = process.argv.includes('--apply');

const users = (await query(
  `SELECT id, company_id, display_name, role FROM users ORDER BY role, display_name`
)).rows;

let granted = 0;
const summary = [];

for (const u of users) {
  const want = LEGACY_ROLE_GRANTS[u.role] || capabilitiesForRole(u.role);
  const have = (await query(
    `SELECT capability FROM user_capabilities WHERE user_id = $1`, [u.id]
  )).rows.map((r) => r.capability);
  const missing = want.filter((c) => !have.includes(c));

  if (APPLY && missing.length) {
    for (const cap of missing) {
      await query(
        `INSERT INTO user_capabilities (user_id, company_id, capability)
         VALUES ($1, $2, $3) ON CONFLICT (user_id, capability) DO NOTHING`,
        [u.id, u.company_id, cap]
      );
      granted++;
    }
  }

  const roleAfter = ROLE_AFTER_CUTOVER[u.role] || u.role;
  summary.push({
    user: u.display_name,
    role_now: u.role,
    role_after: roleAfter === u.role ? '' : roleAfter,
    grants: APPLY ? have.length + missing.length : want.length,
    adding: missing.length,
    customized: PRESETS[roleAfter] && isCustomized(roleAfter, want) ? 'yes' : '',
  });
}

console.table(summary);
console.log(APPLY ? `\n${granted} grants written.` : '\nDRY RUN — nothing written. Re-run with --apply');
await pool.end();
