/**
 * One-off: unify Kindred's company_id across the two halves of the database.
 *
 * Kindred existed under two ids in one database:
 *   teamtask_hub / commerce7 / vintly / product / kindred_web -> 8d2df498-...
 *   club_steward (ClubSteward admin + the PWA's member_accounts) -> a444cbca-...
 *
 * Any join across the two returned nothing, silently. That already cost one live
 * bug where push subscriptions were filed under one id and looked up under the
 * other, so every send reported success and reached nobody.
 *
 * Moves the club_steward side (5,271 rows, one schema) onto the TeamHub id rather
 * than the reverse (60,840 rows across five schemas).
 *
 * ClubSteward is MULTI-TENANT — it also holds "Resos". Every statement is scoped
 * to the old id explicitly, and the run verifies Resos row counts are unchanged.
 *
 * All 18 FKs onto club_steward.companies are ON UPDATE NO ACTION, so the parent
 * row cannot simply be renamed. Order is: insert the new parent, repoint children,
 * drop the old parent — integrity holds at every step, no constraint surgery.
 *
 *   node scripts/unify-company-id.js            # dry run, changes nothing
 *   node scripts/unify-company-id.js --execute  # real, in one transaction
 */
import dotenv from 'dotenv';
dotenv.config();
import { pool } from '../db.js';

const OLD = 'a444cbca-3bc4-4b8d-9bcc-5800504c2b18';   // club_steward's Kindred
const NEW = '8d2df498-b5c0-4f73-94cd-323956036113';   // TeamHub's Kindred
const OTHER_TENANT = '67722387-c097-4c85-862e-c4ccfca3f8e4'; // Resos — must not move

const EXECUTE = process.argv.includes('--execute');

async function main() {
  const c = await pool.connect();
  try {
    // Tables carrying company_id in club_steward, discovered rather than listed,
    // so a table added since this was written can't be silently skipped.
    const tables = (await c.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'club_steward' AND column_name = 'company_id'
        ORDER BY table_name`)).rows.map((r) => r.table_name);

    console.log(`club_steward tables with company_id: ${tables.length}\n`);

    // ── Preconditions ────────────────────────────────────────────────────────
    const pre = await c.query(
      `SELECT (SELECT count(*) FROM club_steward.companies WHERE id = $1)::int AS old_exists,
              (SELECT count(*) FROM club_steward.companies WHERE id = $2)::int AS new_exists`,
      [OLD, NEW]);
    if (pre.rows[0].old_exists !== 1) throw new Error(`Expected exactly 1 companies row for ${OLD}`);
    if (pre.rows[0].new_exists !== 0) throw new Error(`${NEW} already exists in club_steward.companies — aborting`);
    console.log('preconditions OK: old parent present, no collision on the new id\n');

    // ── Before ───────────────────────────────────────────────────────────────
    const before = {}, resosBefore = {};
    for (const t of tables) {
      const r = await c.query(
        `SELECT count(*) FILTER (WHERE company_id = $1)::int mine,
                count(*) FILTER (WHERE company_id = $2)::int resos FROM club_steward.${t}`,
        [OLD, OTHER_TENANT]);
      before[t] = r.rows[0].mine;
      resosBefore[t] = r.rows[0].resos;
      if (r.rows[0].mine || r.rows[0].resos) {
        console.log(`  ${t.padEnd(38)} kindred=${String(r.rows[0].mine).padStart(5)}  resos=${String(r.rows[0].resos).padStart(5)}`);
      }
    }
    const total = Object.values(before).reduce((a, b) => a + b, 0);
    console.log(`\n  ${total} Kindred rows would move; Resos rows must not change.\n`);

    if (!EXECUTE) {
      console.log('DRY RUN — nothing changed. Re-run with --execute to apply.');
      return;
    }

    // ── Execute ──────────────────────────────────────────────────────────────
    await c.query('BEGIN');

    // 1. New parent, cloned from the old row so every column carries over —
    //    including any added since this was written. Via a temp table because a
    //    plain INSERT ... SELECT * would copy the id and violate the PK.
    //
    //    companies.slug is also UNIQUE, so the two rows cannot both hold the real
    //    slug while they coexist. The clone parks it under a temporary value and
    //    takes the real one back in step 4, once the old row is gone.
    const origSlug = (await c.query(
      `SELECT slug FROM club_steward.companies WHERE id = $1`, [OLD])).rows[0].slug;
    const parkedSlug = `${origSlug}-migrating`;

    await c.query(`CREATE TEMP TABLE _newco ON COMMIT DROP AS
                     SELECT * FROM club_steward.companies WHERE id = $1`, [OLD]);
    await c.query(`UPDATE _newco SET id = $1, slug = $2`, [NEW, parkedSlug]);
    await c.query(`INSERT INTO club_steward.companies SELECT * FROM _newco`);

    // 2. Repoint children. Scoped to OLD explicitly — never a bare update.
    const moved = {};
    for (const t of tables) {
      if (t === 'companies') continue;
      const r = await c.query(
        `UPDATE club_steward.${t} SET company_id = $2 WHERE company_id = $1`, [OLD, NEW]);
      moved[t] = r.rowCount;
    }

    // 3. Old parent goes last, once nothing references it.
    const del = await c.query(`DELETE FROM club_steward.companies WHERE id = $1`, [OLD]);
    if (del.rowCount !== 1) throw new Error(`Expected to delete 1 old company row, deleted ${del.rowCount}`);

    // 4. Reclaim the real slug now the old row is gone.
    await c.query(`UPDATE club_steward.companies SET slug = $2 WHERE id = $1`, [NEW, origSlug]);
    const slugCheck = await c.query(
      `SELECT slug FROM club_steward.companies WHERE id = $1`, [NEW]);
    if (slugCheck.rows[0].slug !== origSlug) {
      throw new Error(`slug not restored: expected "${origSlug}", got "${slugCheck.rows[0].slug}"`);
    }

    // ── Verify inside the transaction; roll back if anything is off ──────────
    for (const t of tables) {
      const r = await c.query(
        `SELECT count(*) FILTER (WHERE company_id = $1)::int leftover,
                count(*) FILTER (WHERE company_id = $2)::int resos FROM club_steward.${t}`,
        [OLD, OTHER_TENANT]);
      if (t !== 'companies' && r.rows[0].leftover !== 0) {
        throw new Error(`${t} still has ${r.rows[0].leftover} rows on the old id`);
      }
      if (r.rows[0].resos !== resosBefore[t]) {
        throw new Error(`${t}: Resos count changed ${resosBefore[t]} -> ${r.rows[0].resos} — ROLLING BACK`);
      }
    }
    const parents = await c.query(
      `SELECT id, name FROM club_steward.companies ORDER BY name`);

    await c.query('COMMIT');

    console.log('COMMITTED.\n');
    Object.entries(moved).filter(([, n]) => n > 0)
      .forEach(([t, n]) => console.log(`  moved ${String(n).padStart(5)}  club_steward.${t}`));
    console.log('\nclub_steward.companies now:');
    parents.rows.forEach((p) => console.log(`  ${p.id}  ${p.name}`));
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch { /* not in a transaction */ }
    console.error('\nFAILED — rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

main();
