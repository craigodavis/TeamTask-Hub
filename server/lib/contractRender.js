/**
 * Fill a contract's {{tokens}} from the booking.
 *
 * The clause library holds the wording; this puts the booking into it. Sections are
 * assembled in sort order — the ones marked always_include, plus whichever the terms
 * band selects — and every token is replaced before anything is shown or signed.
 *
 * The result is what gets snapshotted and hashed. Once signed, nothing here can
 * change it: editing a clause afterwards affects future contracts only.
 */
import { query } from '../db.js';
import { rentalType } from './eventTerms.js';

const RENTAL_LABEL = {
  during: 'Business hours',
  after: 'After hours',
  both: 'Business hours and after hours',
};

/**
 * pg returns a DATE column as a JS Date, and String(aDate).slice(0,10) is
 * "Tue Sep 01" — which parses as Invalid Date. Only a string can be sliced.
 */
export function isoDate(d) {
  if (!d) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function fmtDate(d) {
  const iso = isoDate(d);
  if (!iso) return '—';
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US',
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtTime(t) {
  if (!t) return null;
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/**
 * An unknown value prints as "—" rather than as an empty cell. A blank line in a
 * signed contract reads as though the term does not apply; a dash reads as missing,
 * which is what it is.
 */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Friday and Saturday" / "Thursday, Friday and Saturday" */
function listDays(names) {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * When after-hours use actually begins at a venue, read from the hours table.
 *
 * The wording Craig supplied carried fixed times ("Friday after 6:00 pm, Saturday
 * and Sunday after 7:00 pm") which were hypothetical and did not match any venue —
 * the Creek is open to the public until 10:00 pm on Friday, so promising exclusive
 * use from 6:00 pm would have been a term we could not honour, and rental_type
 * would have billed it at the shared rate anyway.
 *
 * Generating it means the contract cannot drift from the app. Change the hours and
 * the next contract says the new ones.
 */
export async function afterHoursSentence(companyId, locationId) {
  if (!locationId) return 'once Kindred closes to the public';

  const { rows } = await query(
    `SELECT day_of_week, closes FROM kindred_web.hours
      WHERE company_id = $1 AND location_id = $2 AND from_date IS NULL
      ORDER BY day_of_week`, [companyId, locationId]);
  if (!rows.length) return 'once Kindred closes to the public';

  // Group the days that share a closing time, so it reads like a person wrote it.
  const byClose = new Map();
  for (const r of rows) {
    const t = fmtTime(r.closes);
    if (!byClose.has(t)) byClose.set(t, []);
    byClose.get(t).push(DAY_NAMES[r.day_of_week]);
  }
  const parts = [...byClose.entries()].map(([t, days]) => `${listDays(days)} after ${t}`);
  return `${listDays(parts)} — whenever Kindred closes to the public that day`;
}

export async function tokensFor(companyId, r) {
  const type = await rentalType(companyId, r.location_id, isoDate(r.event_date),
    r.start_time, r.end_time);

  const where = r.both_venues
    ? 'Winery tasting room and Kindred by the Creek'
    : (r.location_name || '—');

  const times = r.start_time && r.end_time
    ? `${fmtTime(r.start_time)} – ${fmtTime(r.end_time)}`
    : '—';

  return {
    // Computed, so it overrides the seeded default and always matches the app.
    after_hours_availability: await afterHoursSentence(companyId, r.location_id),
    renter_name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || '—',
    renter_phone: r.phone || '—',
    renter_email: r.email || '—',
    renter_address: r.address || '—',
    event_date: fmtDate(r.event_date),
    event_times: times,
    location: where,
    rental_type: type ? RENTAL_LABEL[type] : '—',
    guests: r.guests != null ? String(r.guests) : '—',
    event_type: r.event_type || '—',
  };
}

/** The editable business constants — rates, drink minimum, curfew, thresholds. */
export async function contractValues(companyId) {
  const { rows } = await query(
    `SELECT key, value FROM kindred_web.event_contract_values WHERE company_id = $1`,
    [companyId]
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value ?? '']));
}

/** Replace {{token}} wherever it appears; an unknown token is left visible on
 *  purpose, so a typo in a clause shows up rather than silently blanking. */
export function fill(body, tokens) {
  return String(body || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi,
    (whole, key) => (key.toLowerCase() in tokens ? tokens[key.toLowerCase()] : whole));
}

/**
 * The whole contract for one booking: every always-include section plus any extra
 * keys the terms band selects, in sort order, tokens filled.
 */
export async function renderContract(companyId, request, extraKeys = []) {
  const { rows } = await query(
    `SELECT * FROM kindred_web.event_contract_sections
      WHERE company_id = $1 AND active
        AND (always_include OR key = ANY($2::text[]))
      ORDER BY sort_order, title`,
    [companyId, extraKeys]
  );
  // Constants first, booking second: a per-booking value always wins over the
  // company default, which is what lets a terms band later override a rate for one
  // event without the clause wording changing.
  const defaults = await contractValues(companyId);
  const tokens = { ...defaults, ...(await tokensFor(companyId, request)) };
  return {
    tokens,
    sections: rows.map((s) => ({
      key: s.key, title: s.title, body: fill(s.body, tokens),
    })),
  };
}
