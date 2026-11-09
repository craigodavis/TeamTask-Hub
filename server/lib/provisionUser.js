/**
 * Give a newly created user the grants their role implies.
 *
 * This exists because nothing did it. All three `INSERT INTO users` sites --
 * /auth/register and the two Square syncs -- set a role and stopped, and the
 * permissions screen was the only thing that ever wrote a grant row. Every
 * person hired after the capability conversion therefore arrived holding
 * nothing: the API still admitted them on the legacy role fallback, but the
 * client's `can()` has no fallback, so they logged in to an empty sidebar and,
 * by the look of the fallback log, never came back.
 *
 * Four people in ten weeks, the most recent four days before this was written.
 * Back-filling them without fixing this would have been scheduling a fifth.
 *
 * The role is a PRESET, not a live link (see docs/PERMISSIONS.md): this stamps
 * it once at creation. Editing a preset later still does not retroactively
 * change anyone, which is the whole point of the model.
 */
import { query } from '../db.js';
import { capabilitiesForRole } from './capabilities.js';

export async function grantRolePreset(userId, companyId, role) {
  const caps = capabilitiesForRole(role);
  if (!userId || !companyId || !caps.length) return 0;

  // UNNEST rather than a loop: one statement, so a half-granted user is not a
  // state this can leave behind. granted_by stays NULL -- no person granted it.
  await query(
    `INSERT INTO user_capabilities (user_id, company_id, capability)
     SELECT $1, $2, cap FROM UNNEST($3::text[]) AS cap
     ON CONFLICT (user_id, capability) DO NOTHING`,
    [userId, companyId, caps]
  );
  return caps.length;
}
