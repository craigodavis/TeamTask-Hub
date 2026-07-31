/**
 * One-time merge: fold the stray "Hip" musician record into "Hip Sounds".
 *
 * The WordPress import parsed performers out of event titles, and "Hip.Sounds"
 * sometimes split on the dot — leaving two records for one act. "Hip" accumulated
 * all the real contact/payment detail (phone, email, rate, Anne Delgado as contact
 * and payee, address); "Hip Sounds" has the better name and most of the events.
 * Keep "Hip Sounds" as the record, take everything else from "Hip".
 *
 * Also normalizes kindred_events.performer, so a future re-run of
 * seed-events-musicians.js doesn't recreate the split.
 *
 * Note on lift: the two records hold separately-pooled figures (17.2% over 3 nights,
 * 28.6% over 2). Pooled lift is sSum/bSum, not a night-weighted average, so the two
 * cannot be recombined from the stored values without the underlying sums. This
 * clears them rather than inventing a blended number that looks precise; they
 * recompute from Square data next time lift runs across all 5 nights.
 *
 * Dry run by default; pass --apply to write.
 *   DB_HOST=localhost node scripts/merge-musician-hip-sounds.js [--apply]
 */
import { query } from '../db.js';

const APPLY = process.argv.includes('--apply');
const COMPANY = '8d2df498-b5c0-4f73-94cd-323956036113';
const KEEP = 'Hip Sounds';
const DROP = 'Hip';

// Filled on the surviving record only where it is currently empty, so anything
// already curated on "Hip Sounds" wins over the imported record.
const CARRY = ['photo_url', 'website_url', 'rate_amount', 'rate_unit', 'phone', 'email',
  'notes', 'main_contact', 'write_check_to', 'address', 'stage_name', 'bio'];

async function run() {
  console.log(APPLY ? '*** APPLYING ***\n' : '*** DRY RUN — nothing will be written (pass --apply) ***\n');

  const rows = (await query(
    `SELECT * FROM musicians WHERE company_id = $1 AND name = ANY($2)`, [COMPANY, [KEEP, DROP]])).rows;
  const keep = rows.find((r) => r.name === KEEP);
  const drop = rows.find((r) => r.name === DROP);

  if (!keep) { console.log(`No "${KEEP}" record — nothing to do.`); process.exit(0); }
  if (!drop) { console.log(`No "${DROP}" record — already merged.`); process.exit(0); }

  const fills = CARRY.filter((f) => (keep[f] === null || keep[f] === '') && drop[f] !== null && drop[f] !== '');
  const evs = (await query(`SELECT count(*) n FROM events WHERE musician_id = $1`, [drop.id])).rows[0].n;
  const kes = (await query(
    `SELECT count(*) n FROM kindred_events WHERE company_id = $1 AND performer = $2`, [COMPANY, DROP])).rows[0].n;

  console.log(`keep "${KEEP}"  ${keep.id}`);
  console.log(`drop "${DROP}"  ${drop.id}\n`);
  console.log('fields carried over:');
  for (const f of fills) console.log(`  ${f.padEnd(16)} ${JSON.stringify(drop[f])}`);
  console.log(`\nrepoint ${evs} event(s) -> ${KEEP}`);
  console.log(`normalize ${kes} kindred_events.performer '${DROP}' -> '${KEEP}'`);
  console.log(`clear lift on ${KEEP} (was ${keep.lift_pct}% / ${keep.lift_nights} nights; "${DROP}" had ${drop.lift_pct}% / ${drop.lift_nights})`);
  console.log(`delete "${DROP}"`);

  if (!APPLY) { console.log('\nDry run complete — nothing written. Re-run with --apply.'); process.exit(0); }

  // Events first: musicians -> events is ON DELETE SET NULL, so deleting the
  // record before repointing would silently orphan those five events.
  await query(`UPDATE events SET musician_id = $1, updated_at = NOW() WHERE musician_id = $2`, [keep.id, drop.id]);
  await query(`UPDATE kindred_events SET performer = $1 WHERE company_id = $2 AND performer = $3`, [KEEP, COMPANY, DROP]);

  if (fills.length) {
    const sets = fills.map((f, i) => `${f} = $${i + 2}`).join(', ');
    await query(`UPDATE musicians SET ${sets}, updated_at = NOW() WHERE id = $1`,
      [keep.id, ...fills.map((f) => drop[f])]);
  }
  await query(
    `UPDATE musicians SET lift_pct = NULL, lift_nights = NULL, lift_updated_at = NULL, updated_at = NOW()
      WHERE id = $1`, [keep.id]);
  await query(`DELETE FROM musicians WHERE id = $1`, [drop.id]);

  const after = (await query(`SELECT name, phone, email, rate_amount, main_contact, write_check_to, address
     FROM musicians WHERE id = $1`, [keep.id])).rows[0];
  const n = (await query(`SELECT count(*) n FROM events WHERE musician_id = $1`, [keep.id])).rows[0].n;
  const stray = (await query(`SELECT count(*) n FROM musicians WHERE company_id = $1 AND name = $2`, [COMPANY, DROP])).rows[0].n;
  console.log('\nmerged:', JSON.stringify(after, null, 2));
  console.log(`events now on "${KEEP}": ${n}   stray "${DROP}" records left: ${stray}`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
