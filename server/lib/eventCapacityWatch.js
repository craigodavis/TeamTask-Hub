/**
 * Event capacity watch — email management when an event sitting can take no
 * more bookings.
 *
 * Why this exists: the 70's & 80's party stopped selling and nobody knew until
 * a guest hit "Sorry, no tables available" and said so. It was not full in the
 * sense anyone had in mind — 28 of 60 guest places were taken — it had simply
 * run out of TABLES, because the sitting was assigned one area holding twelve
 * of them and the average booking was a pair. A guest cap of 60 never came into
 * it. The same thing had happened once before on the same event.
 *
 * So this checks the thing that actually stops a sale, rather than the number
 * someone typed into the cap field:
 *
 *   - tables: how many the sitting's areas hold, against how many are taken
 *   - guests: the cap, against how many are booked
 *
 * Either one hitting the line closes the sitting, and the email says which,
 * because the fix is different. Out of tables is "add an area"; out of guest
 * places is "the night is genuinely sold out".
 *
 * TIERS SHARE TABLES. An event with a club price and a public price is two
 * opening-hours blocks at the same time over the same areas — deliberately, not
 * by accident. Their bookings land on one pool of tables, so a tier that has
 * sold nothing can be unable to sell anything because the other tier used the
 * last table. They are therefore grouped into one sitting and reported
 * together, with the per-tier split, rather than checked in isolation where
 * neither would look full.
 *
 * Manual: DB_HOST=localhost node lib/eventCapacityWatch.js
 */
import { query } from '../db.js';
import { sendMail } from '../mail.js';
import { renderEmail } from './email/render.js';

const TZ = 'America/Denver';
const SETTING_KEY = 'event_capacity_alerted';
const SETTING_RECIPIENTS = 'event_capacity_alert_emails';
const HORIZON_DAYS = 120;

const auth = (apiKey) => `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
const apiRoot = (base) => `${(base || 'https://api.resos.com').replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1`;

async function resos(cfg, path) {
  const r = await fetch(apiRoot(cfg.api_base) + path, {
    headers: { Authorization: auth(cfg.api_key), Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`ResOS ${path} → ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const asList = (d) => (Array.isArray(d) ? d : d?.data || []);

/**
 * The local calendar day a single-date block belongs to.
 *
 * ResOS stores it as an instant, and for an evening sitting in Mountain time
 * that instant falls on the NEXT day in UTC — 7:30pm on 7 Nov is 02:30Z on the
 * 8th. Reading the date off the front of the ISO string puts the whole event on
 * the wrong day, which is the mistake that made a full evening look empty.
 */
function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

const hhmm = (n) => `${String(Math.floor(n / 100)).padStart(2, '0')}:${String(n % 100).padStart(2, '0')}`;

const LIVE = (b) => !['deleted', 'canceled', 'cancelled', 'noShow'].includes(String(b?.status));

/** Sittings that are still ahead of us, with their tiers grouped. */
function sittings(blocks) {
  const today = localDay(new Date().toISOString());
  const horizon = new Date(Date.now() + HORIZON_DAYS * 86400000).toISOString().slice(0, 10);
  const byKey = new Map();
  for (const b of blocks) {
    if (b.active === false || !b.date) continue;
    const day = localDay(b.date);
    if (!day || day < today || day > horizon) continue;
    // Same day, same hours, same areas = one sitting sold at several prices.
    const key = `${day}|${b.open}|${b.close}|${[...(b.areas || [])].sort().join(',')}`;
    if (!byKey.has(key)) byKey.set(key, { key, day, open: b.open, close: b.close, areas: b.areas || [], tiers: [] });
    byKey.get(key).tiers.push(b);
  }
  return [...byKey.values()];
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] report what would be emailed, send nothing and
 *   remember nothing — so it can be run by hand to see the current state
 *   without burning the one alert each sitting gets.
 */
export async function runCapacityWatch({ dryRun = false } = {}) {
  const venues = (await query(
    `SELECT l.id, l.name, l.web_slug, c.api_key, c.api_base, l.company_id
       FROM kindred_web.resos_config c
       JOIN locations l ON l.id = c.location_id
      WHERE c.api_key IS NOT NULL AND c.active IS NOT FALSE`)).rows;

  const alerted = await readAlerted();
  const nowIso = new Date().toISOString();
  let changed = false;
  const full = [];

  for (const v of venues) {
    let blocks, areas;
    try {
      blocks = asList(await resos(v, '/openingHours'));
      areas = asList(await resos(v, '/tables'));
    } catch (e) {
      console.warn(`[capacity] ${v.web_slug}: ResOS unreachable — ${e.message}`);
      continue;
    }
    const tablesIn = new Map(areas.map((a) => [a._id, (a.tables || []).length]));

    for (const s of sittings(blocks)) {
      const capacityTables = s.areas.reduce((n, id) => n + (tablesIn.get(id) || 0), 0);
      const ids = new Set(s.tiers.map((t) => t._id));

      // Span both UTC days: an evening sitting here lands on tomorrow in UTC.
      let bookings;
      try {
        const d = await resos(v, `/bookings?fromDateTime=${s.day}T00:00&toDateTime=${s.day}T23:59&limit=100`);
        const next = new Date(`${s.day}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
        const d2 = await resos(v, `/bookings?fromDateTime=${next.toISOString().slice(0, 10)}T00:00&toDateTime=${next.toISOString().slice(0, 10)}T23:59&limit=100`);
        bookings = [...asList(d), ...asList(d2)].filter((b) => LIVE(b) && ids.has(b.openingHourId));
      } catch (e) {
        console.warn(`[capacity] ${v.web_slug} ${s.day}: bookings unreadable — ${e.message}`);
        continue;
      }

      const usedTables = new Set();
      for (const b of bookings) for (const t of (b.tables || [])) usedTables.add(t?.name || t?._id || t);
      const guests = bookings.reduce((n, b) => n + (b.people || 0), 0);
      const guestCap = Math.max(0, ...s.tiers.map((t) => Number(t.maxGuests) || 0));

      const outOfTables = capacityTables > 0 && usedTables.size >= capacityTables;
      const outOfGuests = guestCap > 0 && guests >= guestCap;
      const isFull = outOfTables || outOfGuests;

      if (isFull && !alerted[s.key]) {
        alerted[s.key] = nowIso;
        changed = true;
        full.push({
          venue: v, sitting: s, bookings, guests, guestCap,
          usedTables: usedTables.size, capacityTables, outOfTables, outOfGuests,
        });
      } else if (!isFull && alerted[s.key]) {
        // Room again — adding an area or a cancellation. Forget it, so the next
        // time it fills is reported rather than swallowed as "already told you".
        delete alerted[s.key];
        changed = true;
      }
    }
  }

  const drafts = [];
  for (const f of full) {
    try { drafts.push(await emailFull(f, { dryRun })); }
    catch (e) { console.error('[capacity] email failed:', e.message); }
  }
  if (changed && !dryRun) await writeAlerted(alerted);
  console.log(`[capacity] checked; ${full.length} sitting(s) newly full.${dryRun ? ' (dry run)' : ''}`);
  return { full: full.length, drafts };
}

/* --------------------------------------------------------------- the email */

async function recipients(companyId) {
  try {
    const r = await query(`SELECT value FROM kindred_web.settings WHERE key = $1`, [SETTING_RECIPIENTS]);
    const v = r.rows[0]?.value;
    if (Array.isArray(v) && v.length) return v;
  } catch { /* fall through */ }
  const { rows } = await query(
    `SELECT email FROM teamtask_hub.users
      WHERE company_id = $1 AND role IN ('owner','manager')
        AND email IS NOT NULL AND email <> '' ORDER BY role, display_name`, [companyId]);
  return rows.map((r) => r.email);
}

async function emailFull({ venue, sitting, bookings, guests, guestCap, usedTables, capacityTables, outOfTables }, { dryRun = false } = {}) {
  const to = await recipients(venue.company_id);
  if (!to.length) { console.warn('[capacity] nobody to email'); return null; }

  const when = new Date(`${sitting.day}T12:00:00Z`).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const time = `${hhmm(sitting.open)}–${hhmm(sitting.close)}`;
  const names = [...new Set(sitting.tiers.map((t) => t.name))];

  const perTier = sitting.tiers.map((t) => {
    const mine = bookings.filter((b) => b.openingHourId === t._id);
    const price = t.payment?.active ? `$${t.payment.amount}/guest` : 'no prepayment';
    return `${t.name} (${price}) — ${mine.length} booking${mine.length === 1 ? '' : 's'}, ${mine.reduce((n, b) => n + (b.people || 0), 0)} guests`;
  });

  // The two causes need different answers, so the email leads with which it is
  // rather than saying "full" and leaving someone to work it out.
  const cause = outOfTables
    ? `Every table is taken: ${usedTables} of ${capacityTables} in the areas this sitting is assigned to. Only ${guests} of ${guestCap || '—'} guest places are used, so this is a table shortage rather than a sell-out — most bookings are small and each one holds a table. Adding another area to the sitting in ResOS reopens it.`
    : `The guest limit is reached: ${guests} of ${guestCap}. This one really is sold out.`;

  const tally = `Tables ${usedTables}/${capacityTables}  ·  Guests ${guests}${guestCap ? `/${guestCap}` : ''}`;
  // `letter` escapes its body and splits on blank lines, so this is plain text
  // in paragraphs — no markup, and nothing that needs escaping by hand.
  const body = [cause, perTier.join('\n'), tally].join('\n\n');

  const html = renderEmail([
    { type: 'hero', eyebrow: venue.name, heading: `${names[0]} is full`, sub: `${when} · ${time}` },
    { type: 'letter', body },
  ], { subject: `Event full: ${names[0]}`, preheader: cause.slice(0, 120) });

  const text = [`${names.join(' / ')} is full`, `${when}, ${time} — ${venue.name}`, '', body].join('\n');

  const msg = { to: to.join(', '), subject: `Event full: ${names[0]} — ${when}`, text, html };
  if (dryRun) return msg;
  await sendMail(msg, venue.company_id);
  console.log(`[capacity] emailed ${to.length} about "${names[0]}" on ${sitting.day}`);
  return msg;
}

/* ------------------------------------------------------------- alert state */
/* Kept in settings rather than a table: it is a handful of keys whose only job
   is stopping the same email going out every two hours. */

async function readAlerted() {
  try {
    const r = await query(`SELECT value FROM kindred_web.settings WHERE key = $1`, [SETTING_KEY]);
    const v = r.rows[0]?.value;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

async function writeAlerted(obj) {
  try {
    await query(
      `INSERT INTO kindred_web.settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [SETTING_KEY, JSON.stringify(obj)]);
  } catch (e) { console.warn('[capacity] could not save alert state:', e.message); }
}

let started = false;
export function startCapacityWatch() {
  if (started) return;
  started = true;
  const run = () => runCapacityWatch().catch((e) => console.error('Capacity watch failed:', e.message));
  setTimeout(run, 90 * 1000);          // after boot settles
  setInterval(run, 2 * 60 * 60 * 1000); // every 2h
  console.log('Event capacity watch started (every 2h).');
}

// CLI: `node lib/eventCapacityWatch.js --dry` reports without sending.
if (process.argv[1]?.endsWith('eventCapacityWatch.js')) {
  const dryRun = process.argv.includes('--dry');
  runCapacityWatch({ dryRun })
    .then((r) => {
      for (const d of r.drafts || []) {
        console.log(`\n--- to: ${d.to}\nsubject: ${d.subject}\n${d.text}`);
      }
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
