/**
 * Read-only audit: does every route the router serves belong to exactly one app?
 *
 * The app shell no longer carries a hand-written sidebar. It renders from
 * lib/apps.js, and which app you are in is derived from the URL rather than
 * held as state. That removed six `isKitchenPath`-style predicates -- and it
 * means a screen added to App.jsx without an entry in lib/apps.js would quietly
 * land the user in a shell with the wrong menu, or none.
 *
 * This is the check for that. It lists every path App.jsx routes to and asserts
 * the app and the highlighted row. It imports the real module the shell imports;
 * a reimplementation here would only prove the copy agrees with itself.
 *
 * Also checks the derivation: who sees which apps, that an app with no held
 * items never appears, and that every app's landing target is real.
 *
 * No database, no HTTP, nothing to clean up. Safe to run anywhere.
 *   node scripts/audit-apps.mjs
 *
 * When a route is added to App.jsx, add it to ROUTES below. A failure here is
 * the cheapest place to find out you forgot lib/apps.js.
 */
import { readdir, readFile } from 'node:fs/promises';
import { APPS, matchPath, visibleApps, landingFor } from '../../client/src/lib/apps.js';

const can = (u, c) => (u.capabilities || []).includes(c);
const isOwner = (u) => u.role === 'owner';
let pass = 0, fail = 0;
const ok = (c, m, extra='') => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}${extra ? ' — ' + extra : ''}`); };

// Every path App.jsx routes to, with the app it should land in.
const ROUTES = [
  ['/', 'team'], ['/tasks', 'team'], ['/dashboard', 'team'],
  ['/manage?tab=tasks', 'team'], ['/manage?tab=announcements', 'team'],
  ['/scheduling', 'team'], ['/policies', 'team'], ['/crew', 'team'],
  ['/tasting-room/reservations', 'floor'], ['/tasting-room/reservations/floor', 'floor'],
  ['/tasting-room/reservations/layouts', 'floor'], ['/tasting-room/reservations/tables', 'floor'],
  ['/tasting-room/reservations/offers', 'floor'], ['/tasting-room/reservations/hours', 'floor'],
  ['/tasting-room/reservations/settings', 'floor'], ['/tasting-room/menus', 'floor'],
  ['/marketing/private-events', 'floor'], ['/marketing/event-requests', 'floor'],
  ['/food', 'kitchen'], ['/food/lists', 'kitchen'], ['/food/waste', 'kitchen'],
  ['/food/waste/abc-123', 'kitchen'], ['/food/ingredients', 'kitchen'], ['/waste', 'kitchen'],
  ['/kitchen/inventory', 'kitchen'], ['/kitchen/sources', 'kitchen'],
  ['/recipes/list', 'kitchen'], ['/recipes/ingredients', 'kitchen'], ['/recipes/catalog', 'kitchen'],
  ['/recipes/scan', 'kitchen'], ['/recipes/abc-123', 'kitchen'], ['/quickbooks', 'kitchen'],
  ['/ground-control', 'cellar'], ['/product-lines', 'cellar'], ['/product-lines/new', 'cellar'],
  ['/product-lines/abc-123', 'cellar'], ['/products', 'cellar'], ['/products/new', 'cellar'],
  ['/products/abc-123', 'cellar'], ['/products/inventory', 'cellar'],
  ['/products/inventory/report', 'cellar'], ['/abc', 'cellar'],
  ['/events', 'marketing'], ['/marketing/campaigns', 'marketing'],
  ['/marketing/loyalty', 'marketing'], ['/kindred-app', 'marketing'],
  ['/marketing/images', 'website'], ['/marketing/media', 'website'],
  ['/marketing/website/testimonials', 'website'], ['/marketing/website/popup', 'website'],
  ['/marketing/hours', 'website'], ['/marketing/website/settings', 'website'],
  ['/marketing/settings', 'website'],
  ['/settings', 'admin'], ['/sync-users', 'admin'], ['/manage?tab=reports', 'admin'],
  ['/manage?tab=integrations', 'admin'], ['/square', 'admin'], ['/square/reconcile', 'admin'],
  ['/betty', 'admin'], ['/gateway', 'admin'], ['/skynet', 'admin'],
];

console.log('Every routed path lands in exactly one app\n');
for (const [url, want] of ROUTES) {
  const [p, s] = url.split('?');
  const m = matchPath(p, s ? '?' + s : '');
  ok(m?.app.id === want, url.padEnd(38), m ? `${m.app.id} → ${m.item.label}` : 'NO MATCH');
}

console.log('\nThe right ROW highlights, not just the right app');
const row = (url, want) => {
  const [p, s] = url.split('?');
  const m = matchPath(p, s ? '?' + s : '');
  ok(m?.item.label === want, `${url.padEnd(34)} highlights ${want}`, m?.item.label || 'none');
};
row('/products', 'Products');
row('/products/inventory', 'Wine Inventory');
row('/products/inventory/report', 'Wine Reports');
row('/products/abc-123', 'Products');
row('/marketing/media', 'Media Library');
row('/marketing/website/settings', 'Website Settings');
row('/tasting-room/reservations', 'Bookings');
row('/tasting-room/reservations/offers', 'Offers');
row('/manage?tab=reports', 'Reports');
row('/manage?tab=tasks', 'Manage Tasks');
row('/square', 'Kindred AI');
row('/square/reconcile', 'Kindred AI');

console.log('\nWho sees which apps');
const MEMBER = ['tasks.own','policies.read','crew.profile','kitchen.shopping'];
const people = [
  ['member (15 of 22)', { role:'member', capabilities: MEMBER }, ['team','kitchen']],
  ['inventory (Tristan)', { role:'inventory', capabilities:[...MEMBER,'wine.inventory','wine.reports','kitchen.inventory'] }, ['team','kitchen','cellar']],
  ['no grants at all', { role:'member', capabilities: [] }, []],
];
for (const [who, u, want] of people) {
  const got = visibleApps(u, can, isOwner).map((v) => v.app.id);
  ok(JSON.stringify(got) === JSON.stringify(want), `${who.padEnd(22)} sees [${want.join(', ')}]`, `[${got.join(', ')}]`);
}

console.log('\nAn app with no items held never appears');
const marketingOnly = { role:'marketing', capabilities:['marketing.events'] };
const got = visibleApps(marketingOnly, can, isOwner).map((v) => v.app.id);
ok(!got.includes('kitchen') && !got.includes('admin'), 'one marketing grant does not conjure Kitchen or Admin', `[${got.join(', ')}]`);
ok(got.includes('marketing'), 'but it does conjure Marketing');

console.log('\nLanding targets are real and held');
for (const { app } of visibleApps({ role:'owner', capabilities: APPS.flatMap(a=>a.nav).map(()=>'') }, () => true, () => true)) {
  const to = landingFor(app, {role:'owner'}, () => true, () => true);
  ok(!!to && to !== '/', `${app.name.padEnd(10)} lands on ${to}`);
}

console.log('\nNo legacy role guard has come back');
// Private Events was built after the capability conversion and used
// `requireManager` on all 38 of its routes, because the function was still
// exported and looked like the house style. The four are deleted now; this is
// what makes that stick, in both directions: a route that reaches for one, and
// a middleware file that offers one again.
{
  const routesDir = new URL('../routes/', import.meta.url);
  const LEGACY = ['requireManager', 'requireGControl', 'requireInventoryAccess', 'requireScheduleAccess'];
  const files = (await readdir(routesDir)).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const src = await readFile(new URL(f, routesDir), 'utf8');
    // Ignore prose: only a call or an import of one counts.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const g of LEGACY) if (code.includes(g)) offenders.push(`${f}:${g}`);
  }
  ok(offenders.length === 0, `${files.length} route files use no legacy role guard`, offenders.join(', '));

  const auth = (await readFile(new URL('../middleware/auth.js', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const reborn = LEGACY.filter((g) => auth.includes(`function ${g}`));
  ok(reborn.length === 0, 'middleware/auth.js exports none of them', reborn.join(', '));
}

console.log('\nThe capability gate has no second opinion');
// requireCapability must consult the grant and nothing else. A fallback to the
// old role is what made revoking a no-op for managers; it is deleted, and the
// grants were materialised first so that deletion cost nobody anything.
{
  const auth = await readFile(new URL('../middleware/auth.js', import.meta.url), 'utf8');
  const body = auth.slice(auth.indexOf('export function requireCapability'));
  const gate = body.slice(0, body.indexOf('\n}') + 2).replace(/^\s*\/\/.*$/gm, '');
  ok(!/LEGACY_ROLE_GRANTS|recordFallbackHit|req\.role/.test(gate),
     'requireCapability checks the grant only', gate.replace(/\s+/g, ' ').slice(0, 90));
  const caps = await readFile(new URL('../lib/capabilities.js', import.meta.url), 'utf8');
  ok(!/export const LEGACY_ROLE_GRANTS/.test(caps), 'LEGACY_ROLE_GRANTS is not exported');
}

console.log('\nImpersonation is owner-only, by role');
// "View as" answers every request as somebody else. Gating it on a CAPABILITY
// meant a tickable box could hand that power to a non-owner -- the menu item
// would stay hidden, but the endpoint would have answered anyone who called
// it. A role is not tickable, which is the whole reason this is requireOwner.
{
  const src = await readFile(new URL('../routes/auth.js', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes("router.post('/view-as/"));
  ok(!!line, 'the view-as route still exists');
  ok(!!line && /requireOwner/.test(line), 'view-as is guarded by requireOwner', line?.trim());
  ok(!!line && !/requireCapability/.test(line),
     'view-as is NOT gated on a tickable capability', line?.trim());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
