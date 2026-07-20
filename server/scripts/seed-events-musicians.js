/**
 * One-time seed: create musicians (with lift) from parsed performers, and import
 * the existing events into the new `events` table (source of truth).
 * Idempotent: musicians upsert lift only (keeps manual photo/rate/contact);
 * imported events are replaced.
 *   DB_HOST=localhost node scripts/seed-events-musicians.js <companyId>
 */
import { query } from '../db.js';

const COMPANY = process.argv[2] || '8d2df498-b5c0-4f73-94cd-323956036113';
const dnum = (ds) => new Date(ds + 'T12:00:00').getDay();

async function run() {
  // ── net sales by square location + date (2 yrs) for lift ──
  const net = {};
  const nsr = await query(
    `SELECT s.location_id, s.sales_date::text d, s.net_sales
       FROM team_square.v_square_net_sales_daily s
       JOIN locations l ON l.square_location_id = s.location_id AND l.company_id = $1
      WHERE s.sales_date > CURRENT_DATE - 800`, [COMPANY]);
  for (const r of nsr.rows) ((net[r.location_id] ??= {})[r.d] = Number(r.net_sales));

  // app location id -> square id
  const locs = (await query(`SELECT id, square_location_id FROM locations WHERE company_id = $1`, [COMPANY])).rows;
  const sidByAppId = Object.fromEntries(locs.map((l) => [l.id, l.square_location_id]));

  // events with performers
  const evs = (await query(
    `SELECT performer, location_id, event_date::text d FROM kindred_events
      WHERE company_id = $1 AND performer IS NOT NULL`, [COMPANY])).rows;
  const eventDay = new Set();
  for (const e of evs) { const sid = sidByAppId[e.location_id]; if (sid) eventDay.add(sid + '|' + e.d); }

  // weekday baselines per square-location on non-event days
  const baseAcc = {};
  for (const sid of Object.keys(net)) for (const d of Object.keys(net[sid])) {
    if (eventDay.has(sid + '|' + d)) continue;
    const w = dnum(d); ((baseAcc[sid] ??= {})[w] ??= { s: 0, n: 0 });
    baseAcc[sid][w].s += net[sid][d]; baseAcc[sid][w].n++;
  }
  const baseline = (sid, w) => (baseAcc[sid]?.[w]?.n ? baseAcc[sid][w].s / baseAcc[sid][w].n : null);

  // pooled lift per performer
  const perf = {};
  for (const e of evs) {
    const sid = sidByAppId[e.location_id]; if (!sid) continue;
    const s = net[sid]?.[e.d]; if (s == null) continue;
    const b = baseline(sid, dnum(e.d)); if (b == null) continue;
    (perf[e.performer] ??= { sSum: 0, bSum: 0, n: 0 });
    perf[e.performer].sSum += s; perf[e.performer].bSum += b; perf[e.performer].n++;
  }

  // all distinct performers (even those with no sales match yet)
  const allNames = (await query(
    `SELECT DISTINCT performer FROM kindred_events WHERE company_id = $1 AND performer IS NOT NULL`, [COMPANY])).rows.map((r) => r.performer);

  let mCount = 0;
  const musicianId = {};
  for (const name of allNames) {
    const p = perf[name];
    const lift = p && p.bSum > 0 ? Math.round((p.sSum / p.bSum - 1) * 1000) / 10 : null;
    const r = await query(
      `INSERT INTO musicians (company_id, name, lift_pct, lift_nights, lift_updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (company_id, name) DO UPDATE SET lift_pct = EXCLUDED.lift_pct, lift_nights = EXCLUDED.lift_nights, lift_updated_at = NOW()
       RETURNING id`, [COMPANY, name, lift, p ? p.n : 0]);
    musicianId[name] = r.rows[0].id; mCount++;
  }

  // import events (replace prior import)
  await query(`DELETE FROM events WHERE company_id = $1 AND source = 'wordpress_import'`, [COMPANY]);
  const keRows = (await query(
    `SELECT source_id, location_id, performer, event_date::text d, start_at, end_at, title, category, raw_excerpt
       FROM kindred_events WHERE company_id = $1`, [COMPANY])).rows;
  let eCount = 0;
  for (const k of keRows) {
    await query(
      `INSERT INTO events (company_id, location_id, musician_id, title, description, start_at, end_at, category, status, wp_event_id, source, wp_synced_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6, ($7||' 18:00')::timestamptz),$8,$9,'published',$10,'wordpress_import',NOW())`,
      [COMPANY, k.location_id, k.performer ? musicianId[k.performer] : null, k.title || 'Event',
       k.raw_excerpt || null, k.start_at, k.d, k.end_at, k.category, k.source_id]);
    eCount++;
  }

  console.log(`Seeded ${mCount} musicians (${Object.keys(perf).length} with lift) and imported ${eCount} events.`);
  process.exit(0);
}
run().catch((e) => { console.error(e); process.exit(1); });
