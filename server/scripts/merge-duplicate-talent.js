/**
 * One-off: collapse the duplicate talent records the title parser created.
 *
 * Events were imported by parsing the performer out of the event title, and
 * titles like "Sunset Music Series with Brian Crouse at Kindred Vineyards 21+"
 * left the venue attached to the name. So one act ended up with two or three
 * records, splitting its booking history and its sales-lift figures.
 *
 * Which name survives: the one carrying a future booking, so nothing upcoming
 * has to be repointed by hand. Where neither has a future booking that rule
 * cannot decide, so the record with the longer history wins — which in every
 * case here is also the clean, un-suffixed spelling.
 *
 * Every losing record was checked first and holds no phone, email, rate, photo,
 * contact, payee, address or notes. The carry-over below is belt and braces: if
 * one ever does, it fills a gap on the survivor rather than vanishing.
 *
 * Writes to events_all, not events. `events` is a view over it that hides
 * soft-deleted rows, and musicians -> events_all is ON DELETE SET NULL, so a
 * soft-deleted event whose performer we deleted would quietly lose its link.
 *
 * Idempotent: re-running after a successful pass is a no-op.
 *   DB_HOST=localhost node scripts/merge-duplicate-talent.js
 */
import { query } from '../db.js';

const GROUPS = [
  { keep: 'Brian Crouse',        drop: ['Brian Crouse at Kindred Vineyards'],                        why: 'future booking 27 Nov' },
  { keep: 'Good Time Charlie',   drop: ['Goodtime Charlie', 'Good Time Charlie at Kindred Vineyards'], why: 'future booking 17 Nov' },
  { keep: 'Andrew Cahill',       drop: ['Andrew Cahill at Kindred Vineyards'],                       why: 'longer history' },
  { keep: 'Andy Porter',         drop: ['Andy Porter at Kindred Vineyards'],                         why: 'longer history' },
  { keep: 'Dustin Morris',       drop: ['Dustin Morris at Kindred Vineyards'],                       why: 'longer history' },
  { keep: 'Scott Knickerbocker', drop: ['Scott Knickerbocker Kindred Vineyards'],                    why: 'longer history' },
];

// Sole record with the venue stuck on the name — a rename, not a merge. Merging
// it would delete the only record she has and orphan her event.
const RENAMES = [{ from: 'Janice Gerard at Kindred Vineyards', to: 'Janice Gerard' }];

const CARRY = ['phone', 'email', 'rate_amount', 'rate_unit', 'photo_url', 'website_url',
  'main_contact', 'write_check_to', 'address', 'notes', 'stage_name', 'bio'];

const byName = async (name) =>
  (await query(`SELECT * FROM musicians WHERE name = $1`, [name])).rows[0] || null;

async function run() {
  const before = (await query(`SELECT count(*)::int AS n FROM musicians`)).rows[0].n;
  let merged = 0, moved = 0, renamed = 0;

  for (const g of GROUPS) {
    const keep = await byName(g.keep);
    if (!keep) { console.log(`SKIP  no record named "${g.keep}"`); continue; }

    for (const dropName of g.drop) {
      const drop = await byName(dropName);
      if (!drop) { console.log(`  ·  "${dropName}" already gone`); continue; }

      const n = (await query(
        `SELECT count(*)::int AS n FROM events_all WHERE musician_id = $1`, [drop.id])).rows[0].n;

      // Events first — the FK nulls them out if the record goes first.
      await query(`UPDATE events_all SET musician_id = $1, updated_at = NOW() WHERE musician_id = $2`,
        [keep.id, drop.id]);

      const fills = CARRY.filter((f) => (keep[f] === null || keep[f] === '') && drop[f] !== null && drop[f] !== '');
      if (fills.length) {
        await query(`UPDATE musicians SET ${fills.map((f, i) => `${f} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
          [keep.id, ...fills.map((f) => drop[f])]);
      }

      await query(`DELETE FROM musicians WHERE id = $1`, [drop.id]);
      console.log(`  ✓ "${dropName}" -> "${g.keep}"  (${n} event${n === 1 ? '' : 's'}${fills.length ? `, carried ${fills.join('/')}` : ''})`);
      moved += n; merged++;
    }
    // The merged set is wider than the window the lift was computed over.
    await query(
      `UPDATE musicians SET lift_pct = NULL, lift_nights = NULL, lift_updated_at = NULL, updated_at = NOW()
        WHERE id = $1 AND lift_pct IS NOT NULL`, [keep.id]);
  }

  for (const r of RENAMES) {
    const row = await byName(r.from);
    if (!row) { console.log(`  ·  "${r.from}" already renamed`); continue; }
    if (await byName(r.to)) { console.log(`SKIP  "${r.to}" already exists — would be a merge, not a rename`); continue; }
    await query(`UPDATE musicians SET name = $2, updated_at = NOW() WHERE id = $1`, [row.id, r.to]);
    console.log(`  ✓ renamed "${r.from}" -> "${r.to}"`);
    renamed++;
  }

  const after = (await query(`SELECT count(*)::int AS n FROM musicians`)).rows[0].n;
  const orphans = (await query(
    `SELECT count(*)::int AS n FROM events_all e
      WHERE e.musician_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM musicians m WHERE m.id = e.musician_id)`)).rows[0].n;
  const leftovers = (await query(
    `SELECT name FROM musicians WHERE name ILIKE '%kindred%' ORDER BY name`)).rows.map((r) => r.name);

  console.log(`\n${merged} record(s) merged, ${moved} event(s) repointed, ${renamed} renamed.`);
  console.log(`talent: ${before} -> ${after}`);
  console.log(`orphaned events (must be 0): ${orphans}`);
  console.log(`names still containing "Kindred": ${leftovers.length ? leftovers.join(', ') : 'none'}`);
  process.exit(orphans === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
