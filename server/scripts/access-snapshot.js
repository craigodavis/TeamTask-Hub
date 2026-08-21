/**
 * Effective access for every user, as a snapshot that can be diffed.
 *
 *   node scripts/access-snapshot.js > /tmp/before.json
 *   ...convert a batch of routes...
 *   node scripts/access-snapshot.js > /tmp/after.json
 *   node scripts/access-snapshot.js --diff /tmp/before.json /tmp/after.json
 *
 * The conversion in step 2 is only correct if that diff is empty. Every batch
 * gets checked this way rather than reasoned about, because "this should be
 * equivalent" is exactly the assumption that locks someone out of the app on a
 * Saturday.
 *
 * Answers, per user, the one question that matters: for each capability, would
 * a request be allowed? That is `granted OR the old role would have allowed
 * it` -- the same test requireCapability applies, including its fallback.
 */
import dotenv from 'dotenv';
dotenv.config();
import fs from 'node:fs';
import { query, pool } from '../db.js';
import { ALL_CAPABILITIES, LEGACY_ROLE_GRANTS } from '../lib/capabilities.js';

const diffAt = process.argv.indexOf('--diff');
if (diffAt !== -1) {
  const [a, b] = [process.argv[diffAt + 1], process.argv[diffAt + 2]];
  const before = JSON.parse(fs.readFileSync(a, 'utf8'));
  const after  = JSON.parse(fs.readFileSync(b, 'utf8'));
  const changes = [];
  const added = new Set();
  for (const user of Object.keys({ ...before, ...after })) {
    for (const cap of ALL_CAPABILITIES) {
      const was = before[user]?.[cap] ?? null;
      const now = after[user]?.[cap] ?? null;
      if (was === now) continue;
      // A capability that did not exist in the baseline reads as null for
      // everybody, so introducing one shows up as a change for all 18 users at
      // once. That is a new capability, not an access change -- reported
      // separately so a real regression is never buried in that noise.
      if (was === null) { added.add(cap); continue; }
      changes.push({ user, capability: cap, was, now });
    }
  }
  if (added.size) {
    console.log(`ℹ new capabilities since the baseline: ${[...added].join(', ')}`);
  }
  if (!changes.length) {
    console.log('✔ no existing access changed');
  } else {
    console.log(`✖ ${changes.length} effective access changes:`);
    console.table(changes);
  }
  process.exit(changes.length ? 1 : 0);
}

const users = (await query(`SELECT id, display_name, role FROM users ORDER BY display_name`)).rows;
const out = {};
for (const u of users) {
  const grants = new Set((await query(
    `SELECT capability FROM user_capabilities WHERE user_id = $1`, [u.id]
  )).rows.map((r) => r.capability));
  const legacy = new Set(LEGACY_ROLE_GRANTS[u.role] || []);
  out[u.display_name] = Object.fromEntries(
    ALL_CAPABILITIES.map((c) => [c, grants.has(c) || legacy.has(c)])
  );
}
console.log(JSON.stringify(out, null, 2));
await pool.end();
