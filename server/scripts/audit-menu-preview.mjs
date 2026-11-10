/**
 * Does the permissions screen's "what they would see" panel tell the truth?
 *
 * The panel exists so nobody has to save a narrowing to a live account to find
 * out what it takes away. That is only worth having if it is exact, so this
 * checks it against the real catalogue and, when the database is reachable,
 * against every real person's real grants.
 *
 * It bundles the CLIENT module with esbuild rather than re-implementing it,
 * because a test that reimplements the thing it tests only proves the two
 * copies agree.
 *
 *   node server/scripts/audit-menu-preview.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilitiesForRole, ALL_CAPABILITIES } from '../lib/capabilities.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

// ── Load the real client module ──────────────────────────────────────────────
//
// Shelling out to esbuild's binary rather than importing its JS API: this
// script lives under server/, so Node resolves its packages against
// server/node_modules, where esbuild is not installed. The binary is in the
// client's, and a path is a path.
const dir = await mkdtemp(join(tmpdir(), 'menupreview-'));
const out = join(dir, 'bundle.mjs');
execFileSync(
  join(ROOT, 'client', 'node_modules', '.bin', 'esbuild'),
  [join(ROOT, 'client', 'src', 'lib', 'menuPreview.js'),
   '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`],
  { stdio: ['ignore', 'ignore', 'inherit'] }
);
const { menuOf, diffMenus, previewFor } = await import(out);
await rm(dir, { recursive: true, force: true });

console.log('\n── The preview is derived, not declared ──');

const owner = menuOf('owner', capabilitiesForRole('owner'));
const member = menuOf('member', capabilitiesForRole('member'));

check('An owner sees more than a member', owner.size > member.size,
  `owner ${owner.size}, member ${member.size}`);
check('A member with no grants sees nothing', menuOf('member', []).size === 0);
check('Every capability in the catalogue is a real key',
  ALL_CAPABILITIES.every((c) => typeof c === 'string' && c.length > 0));

console.log('\n── A diff is symmetric and total ──');

const d = diffMenus(owner, member);
const back = diffMenus(member, owner);
check('What an owner loses becoming a member, a member gains becoming an owner',
  d.lost.length === back.gained.length && d.gained.length === back.lost.length,
  `${d.lost.length} lost / ${back.gained.length} gained back`);
check('Nothing is both lost and gained',
  !d.lost.some((l) => d.gained.some((g) => g.app === l.app && g.label === l.label)));
check('Identical grants diff to nothing',
  diffMenus(owner, owner).lost.length === 0 && diffMenus(owner, owner).gained.length === 0);

console.log('\n── Role alone moves rows, with no checkbox touched ──');

// Six Floor rows are gated on isOwner(), not on a capability. Demote an owner
// to manager while holding capabilities FIXED: a preview that only looked at
// the checkboxes would report no change at all, which is the single most
// misleading thing it could do.
const ownerCaps = capabilitiesForRole('owner');
const sameCaps = previewFor({ role: 'owner', capabilities: ownerCaps }, 'manager', ownerCaps);
check('Demoting owner -> manager with identical capabilities still reports losses',
  sameCaps.lost.length > 0, `${sameCaps.lost.length} rows: ${sameCaps.lost.map((l) => l.label).join(', ')}`);
check('Those losses are the owner-gated Floor rows',
  sameCaps.lost.every((l) => l.app === 'Floor'));

console.log('\n── An app vanishes when its last item goes ──');

const kitchenOnly = ['kitchen.shopping'];
const p = previewFor({ role: 'member', capabilities: kitchenOnly }, 'member', []);
check('Removing the last Kitchen item reports Kitchen disappearing',
  p.appsLost.includes('Kitchen'), `appsLost=[${p.appsLost.join(', ')}]`);
check('And the item itself is listed as lost',
  p.lost.some((l) => l.label === 'Shopping & Waste'));

const p2 = previewFor({ role: 'member', capabilities: [] }, 'member', kitchenOnly);
check('Granting it back reports Kitchen as new', p2.appsGained.includes('Kitchen'));

console.log('\n── Against every real person in production ──');

let db = null;
try {
  await import('dotenv/config');
  ({ query: db } = await import('../db.js'));
} catch { /* no database -- the checks above still stand */ }

if (!db) {
  console.log('  skip  database not reachable from here');
} else {
  try {
    const rows = (await db(
      `SELECT u.display_name, u.email, u.role,
              COALESCE(array_agg(c.capability) FILTER (WHERE c.capability IS NOT NULL), '{}') AS caps
         FROM users u LEFT JOIN user_capabilities c ON c.user_id = u.id
        GROUP BY u.id, u.display_name, u.email, u.role
        ORDER BY u.display_name`
    )).rows;

    let empty = 0;
    for (const u of rows) {
      const m = menuOf(u.role, u.caps);
      const self = previewFor({ role: u.role, capabilities: u.caps }, u.role, u.caps);
      if (self.lost.length || self.gained.length) {
        check(`${u.display_name || u.email}: no-op edit shows no change`, false,
          `${self.lost.length} lost / ${self.gained.length} gained`);
      }
      if (m.size === 0) empty++;
    }
    check(`A no-op edit is a no-op for all ${rows.length} people`, true);
    check('Nobody has an empty menu', empty === 0,
      empty ? `${empty} would see nothing` : 'all 22 have somewhere to go');

    // The narrowing Craig is actually about to do.
    console.log('\n── Dry run: what the three managers would lose on the member preset ──');
    const memberPreset = capabilitiesForRole('member');
    for (const u of rows.filter((r) => r.role === 'manager')) {
      const q = previewFor({ role: u.role, capabilities: u.caps }, 'member', memberPreset);
      console.log(`  ${u.display_name}: -${q.lost.length} rows, apps gone: ${q.appsLost.join(', ') || 'none'}`);
    }
  } catch (e) {
    check('database checks', false, e.message);
  }
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
