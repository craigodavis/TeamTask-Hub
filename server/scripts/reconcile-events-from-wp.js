/**
 * One-time reconciliation: bring `events` for 2026-07-31 forward back in line with
 * the production WordPress calendar, which is the source of truth for that window.
 *
 * Context: the live site's events were corrected by hand in WordPress. TeamHub had
 * drifted — five August Nights rows pointed at a trashed post (5327) or at fabricated
 * ids (10000296-99), one show lost its performer, one new show was never imported,
 * and two rows were UI test fixtures. Only 8 of 24 rows differ, so this patches those
 * 8 rather than deleting and re-importing: the untouched rows carry descriptions
 * extracted from Elementor, musician links feeding the Scheduling lift analysis, and
 * slugs the preview site's URLs are built on — none of which exist in WordPress.
 *
 * Deliberately writes straight to the DB and never goes through routes/events.js,
 * because that path pushes back to WordPress and would overwrite the hand corrections.
 *
 * Dry run by default; pass --apply to write.
 *   DB_HOST=localhost node scripts/reconcile-events-from-wp.js [--apply]
 */
import { query } from '../db.js';

const APPLY = process.argv.includes('--apply');
const COMPANY = '8d2df498-b5c0-4f73-94cd-323956036113';
const ESTATE = '9278d8c3-244d-4b5d-97c6-4aa406d26e77';
const HIP_SOUNDS = '614eaae2-d1b7-4032-898d-53bf2dbbdf65';
const CUTOFF = '2026-07-31';

// Matches the slugs already in the table: lowercase, any run of non-alphanumerics
// becomes one hyphen ("Hip.Sounds @ …" -> "hip-sounds-…"), then the date is appended.
const slugify = (title, date) =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${date}`;

// wp_event_id remaps + artwork the fabricated rows never got. Keyed by start_at.
const REMAP = [
  { at: '2026-08-01T19:00:00Z', from: '5327',     to: '5384', image: null },
  { at: '2026-08-08T19:00:00Z', from: '10000296', to: '5386', image: 'https://kindredvineyards.com/wp-content/uploads/2026/07/Vineyard-Page-Design-2.png' },
  { at: '2026-08-15T19:00:00Z', from: '10000297', to: '5388', image: 'https://kindredvineyards.com/wp-content/uploads/2026/07/Vineyard-Page-Design-2.png' },
  { at: '2026-08-22T19:00:00Z', from: '10000298', to: '5390', image: 'https://kindredvineyards.com/wp-content/uploads/2026/07/Vineyard-Page-Design-2.png' },
  { at: '2026-08-29T19:00:00Z', from: '10000299', to: '5392', image: 'https://kindredvineyards.com/wp-content/uploads/2026/07/Vineyard-Page-Design-2.png' },
];

const AUG7_TITLE = 'Sunset Music Series at Kindred Vineyards 21+';
const JUL31_TITLE = 'Sunset Music Series: Hip.Sounds @ Kindred Vineyards 21+';
const SUNSET_ART = 'https://kindredvineyards.com/wp-content/uploads/2026/04/Sunset-Music-series-3.png';

const log = (s = '') => console.log(s);
const plan = [];

async function run() {
  log(APPLY ? '*** APPLYING ***\n' : '*** DRY RUN — nothing will be written (pass --apply) ***\n');

  // ── 1. the show that was added on the site but never imported ──────────────
  // Times are stored wall-clock-labeled-UTC (a TEC export artifact the website's
  // formatter relies on), so WP's "18:00" is written as 18:00Z, never converted.
  const dupe = await query(
    `SELECT id FROM events WHERE company_id = $1 AND start_at = '2026-07-31T18:00:00Z'`, [COMPANY]);
  if (dupe.rows.length) {
    log('SKIP insert — a row already exists at 2026-07-31T18:00Z');
  } else {
    // Reuse a sibling's description rather than re-parsing Elementor markup.
    const sib = await query(
      `SELECT description FROM events WHERE id = '09bd6ec6-422a-4056-b227-f7a866edbfdd'`);
    const description = sib.rows[0]?.description ?? null;
    const slug = slugify(JUL31_TITLE, '2026-07-31');
    plan.push({
      what: `INSERT  2026-07-31 18:00  ${JUL31_TITLE}`,
      detail: `  slug=${slug}  wp=5375  musician=Hip Sounds  description=${description ? description.length + ' chars (from Aug 14 sibling)' : 'NULL'}`,
      run: () => query(
        `INSERT INTO events
           (company_id, location_id, musician_id, title, description, start_at, end_at,
            all_day, category, status, wp_event_id, source, wp_synced_at, slug, image_url)
         VALUES ($1,$2,$3,$4,$5,'2026-07-31T18:00:00Z','2026-07-31T21:00:00Z',
                 false,'music_named','published','5375','wordpress_import',NOW(),$6,$7)`,
        [COMPANY, ESTATE, HIP_SOUNDS, JUL31_TITLE, description, slug, SUNSET_ART]),
    });
  }

  // ── 2. the two Event-UI test fixtures ─────────────────────────────────────
  // Created to exercise the preview detail page, never real events. Children in
  // event_tasks / promo_tasks / promo_emails go with them via ON DELETE CASCADE.
  const fixtures = await query(
    `SELECT id, title, start_at FROM events
      WHERE company_id = $1 AND start_at >= $2 AND source = 'teamhub'
      ORDER BY start_at`, [COMPANY, CUTOFF]);
  for (const f of fixtures.rows) {
    plan.push({
      what: `DELETE  ${new Date(f.start_at).toISOString().slice(0, 16)}  ${f.title}`,
      detail: `  id=${f.id}  (source='teamhub' test fixture)`,
      run: () => query(`DELETE FROM events WHERE id = $1`, [f.id]),
    });
  }

  // ── 3. August Nights: dead/fabricated wp ids, and missing artwork ─────────
  for (const r of REMAP) {
    const cur = await query(
      `SELECT id, title, wp_event_id, image_url FROM events
        WHERE company_id = $1 AND start_at = $2`, [COMPANY, r.at]);
    if (!cur.rows.length) { log(`WARN  no row at ${r.at} — skipping remap`); continue; }
    const row = cur.rows[0];
    if (String(row.wp_event_id) !== r.from) {
      log(`WARN  ${r.at} wp_event_id is ${row.wp_event_id}, expected ${r.from} — skipping`);
      continue;
    }
    const bits = [`wp_event_id ${r.from} -> ${r.to}`];
    if (r.image && !row.image_url) bits.push('image_url NULL -> artwork');
    plan.push({
      what: `UPDATE  ${r.at.slice(0, 16)}  ${row.title}`,
      detail: `  ${bits.join('; ')}`,
      run: () => query(
        `UPDATE events SET wp_event_id = $2,
                image_url = COALESCE(image_url, $3),
                wp_synced_at = NOW(), updated_at = NOW()
          WHERE id = $1`, [row.id, r.to, r.image]),
    });
  }

  // ── 4. Aug 7 lost its performer ───────────────────────────────────────────
  // The site dropped "Dustin Morris" from the title. Clear the musician link and
  // demote the category too, or the lift analysis keeps crediting him for a show
  // he is no longer playing.
  const aug7 = await query(
    `SELECT id, title, musician_id, category FROM events
      WHERE company_id = $1 AND start_at = '2026-08-07T18:00:00Z'`, [COMPANY]);
  if (!aug7.rows.length) {
    log('WARN  no row at 2026-08-07T18:00Z — skipping retitle');
  } else if (aug7.rows[0].title === AUG7_TITLE) {
    log('SKIP retitle — Aug 7 already matches the site');
  } else {
    const row = aug7.rows[0];
    const slug = slugify(AUG7_TITLE, '2026-08-07');
    plan.push({
      what: `UPDATE  2026-08-07T18:00  ${row.title}`,
      detail: `  title -> ${AUG7_TITLE}\n    slug -> ${slug}\n    musician_id ${row.musician_id} -> NULL (Dustin Morris)\n    category ${row.category} -> music_unnamed`,
      run: () => query(
        `UPDATE events SET title = $2, slug = $3, musician_id = NULL,
                category = 'music_unnamed', updated_at = NOW()
          WHERE id = $1`, [row.id, AUG7_TITLE, slug]),
    });
  }

  // ── report, then optionally write ─────────────────────────────────────────
  log(`\n${plan.length} change(s):\n`);
  for (const p of plan) { log(p.what); log(p.detail); log(); }

  if (!APPLY) { log('Dry run complete — nothing written. Re-run with --apply.'); process.exit(0); }

  for (const p of plan) await p.run();
  log(`Applied ${plan.length} change(s).`);

  const after = await query(
    `SELECT count(*) n, count(*) FILTER (WHERE wp_event_id IS NULL) no_wp,
            count(*) FILTER (WHERE wp_event_id LIKE '1000%') fake
       FROM events WHERE company_id = $1 AND start_at >= $2`, [COMPANY, CUTOFF]);
  log(`Window now: ${after.rows[0].n} rows, ${after.rows[0].no_wp} without wp_event_id, ${after.rows[0].fake} fabricated ids.`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
