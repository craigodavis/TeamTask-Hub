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
import { rentalType } from './eventRules.js';

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
  const tokens = await tokensFor(companyId, request);
  return {
    tokens,
    sections: rows.map((s) => ({
      key: s.key, title: s.title, body: fill(s.body, tokens),
    })),
  };
}
