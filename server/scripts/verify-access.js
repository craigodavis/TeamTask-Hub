/**
 * Prove a converted route still allows and denies exactly who it used to.
 *
 *   node scripts/verify-access.js          # needs the API on :3001
 *   PORT=3001 node scripts/verify-access.js
 *
 * Expectations are written out from the OLD middleware by hand, on purpose.
 * The grants-only diff in access-snapshot.js cannot catch a mistake in the
 * capability map itself, because both sides of that comparison read the map --
 * which is exactly how the first Wine batch silently took Wine Reports away
 * from the two inventory users. This exercises the real routes as real people
 * and compares against the old rules restated independently.
 *
 * Extend ROUTES with every batch. A converted route that is not listed here has
 * not been verified, whatever the diff says.
 */
import dotenv from 'dotenv';
dotenv.config();
import jwt from 'jsonwebtoken';
import { query, pool } from '../db.js';

const BASE = `http://localhost:${process.env.PORT || 3001}`;

// The old middleware, restated:
const manager   = (r) => ['manager', 'owner'].includes(r);
const inventory = (r) => ['inventory', 'manager', 'owner'].includes(r);
const owner     = (r) => r === 'owner';
const gc        = (r) => ['gc', 'manager', 'owner'].includes(r);
const schedule  = (r) => ['schedule', 'manager', 'owner'].includes(r);
export const OLD = { manager, inventory, owner, gc, schedule };

const ROUTES = [
  // ── Batch 1: Wine ────────────────────────────────────────────────────────
  { path: '/api/products/square-items',            was: 'manager',   allow: manager },
  { path: '/api/products/tax-exempt',              was: 'manager',   allow: manager },
  { path: '/api/products/tax-gap',                 was: 'manager',   allow: manager },
  { path: '/api/products/catalog-sync/status',     was: 'manager',   allow: manager },
  { path: '/api/product-lines/lookup/options',     was: 'authOnly',  allow: () => true },
  { path: '/api/products/inventory',               was: 'inventory', allow: inventory },
  { path: '/api/products/inventory/report?days=7', was: 'inventory', allow: inventory },

  // ── Batch 2: Marketing, Tasting Room, Announcements ──────────────────────
  // Each of these was verified against `git show HEAD:<file>` to be
  // requireManager BEFORE conversion. Picking a route by guessing put five
  // unguarded list endpoints in here and reported ten false regressions --
  // GET /media, /page-images and /announcements were never gated at all,
  // because staff have to be able to read announcements.
  { path: '/api/campaigns',                  was: 'manager',  allow: manager },
  { path: '/api/campaigns/lists',            was: 'manager',  allow: manager },
  { path: '/api/loyalty/stats',              was: 'manager',  allow: manager },
  { path: '/api/loyalty/rules',              was: 'manager',  allow: manager },
  { path: '/api/reservations',               was: 'manager',  allow: manager },
  { path: '/api/reservations/opt-ins.csv',   was: 'manager',  allow: manager },

  // And these were NEVER gated -- everyone authenticated could read them, and
  // must still be able to.
  { path: '/api/media',                      was: 'authOnly', allow: () => true },
  { path: '/api/page-images',                was: 'authOnly', allow: () => true },
  { path: '/api/announcements',              was: 'authOnly', allow: () => true },

  // ── Batch 3: Kitchen (recipes.js split four ways) and ops ────────────────
  { path: '/api/recipes',                      was: 'manager',   allow: manager },   // kitchen.recipes
  { path: '/api/recipes/catalog',              was: 'manager',   allow: manager },   // kitchen.catalog
  { path: '/api/recipes/ingredients',          was: 'manager',   allow: manager },   // kitchen.ingredients
  { path: '/api/recipes/inventory',            was: 'inventory', allow: inventory }, // kitchen.inventory
  { path: '/api/recipes/kitchen-settings',     was: 'inventory', allow: inventory }, // read stays inventory
  { path: '/api/recipes/shopping-list',        was: 'inventory', allow: inventory },
  { path: '/api/food-waste/report',            was: 'manager',   allow: manager },   // reports.operational
  { path: '/api/food-waste/ingredients',       was: 'authOnly',  allow: () => true },
  { path: '/api/dashboard',                    was: 'manager',   allow: manager },
  { path: '/api/ground-control/zones',         was: 'gc',        allow: gc },
  { path: '/api/ground-control/schedules',     was: 'gc',        allow: gc },

  // ── Batch 4: the last of them ────────────────────────────────────────────
  { path: '/api/scheduling/settings',          was: 'schedule',  allow: schedule },
  { path: '/api/events',                       was: 'schedule',  allow: schedule },
  { path: '/api/square/sessions',              was: 'manager',   allow: manager },  // ai.use
  { path: '/api/skynet/projects',              was: 'manager',   allow: manager },
  { path: '/api/reports/scheduled',            was: 'manager',   allow: manager },
  { path: '/api/marketing/hours',              was: 'manager',   allow: manager },
];

// One user per distinct role, so every branch of every rule is exercised.
const users = (await query(
  `SELECT DISTINCT ON (role) id, display_name, role FROM users ORDER BY role, display_name`
)).rows;

const rows = [];
let failures = 0;

for (const u of users) {
  const token = jwt.sign(
    { userId: u.id, companyId: u.company_id || (await query(`SELECT company_id FROM users WHERE id=$1`, [u.id])).rows[0].company_id, email: 'verify@local' },
    process.env.JWT_SECRET, { expiresIn: '5m' }
  );
  for (const r of ROUTES) {
    const res = await fetch(BASE + r.path, { headers: { Authorization: `Bearer ${token}` } });
    // A path that does not exist answers 404, which is not 403 and so would be
    // scored as "allowed" -- inventing two routes produced four confident false
    // regressions. A typo in this file must fail as a typo, not as a finding.
    if (res.status === 404) {
      console.error(`✖ ${r.path} returned 404 — no such route; fix the entry rather than trusting the result`);
      failures++;
      continue;
    }
    const allowed = res.status !== 403;
    const expected = r.allow(u.role);
    const ok = allowed === expected;
    if (!ok) failures++;
    rows.push({
      user: u.display_name, role: u.role,
      route: r.path.split('?')[0].replace('/api', ''),
      was: r.was,
      expected: expected ? 'allow' : 'deny',
      got: allowed ? 'allow' : 'deny',
      ok: ok ? '✔' : '✖ REGRESSION',
    });
  }
}

console.table(rows);

const hits = (await query(
  `SELECT route, capability, role, hits, last_seen FROM capability_fallback_hits ORDER BY last_seen DESC`
)).rows;
console.log('\nLegacy-role fallback hits:');
console.log(hits.length ? hits : '  none — every request was answered by a real grant');

console.log(failures === 0
  ? `\n✔ ${rows.length} checks, no regressions`
  : `\n✖ ${failures} of ${rows.length} checks regressed`);

await pool.end();
process.exit(failures ? 1 : 0);
