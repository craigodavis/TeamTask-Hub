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
import { effectiveTerms } from './eventTerms.js';
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

  // The agreed numbers: the frozen snapshot with any per-booking changes laid over
  // it. Not the live terms table — a contract states what this booking agreed, not
  // what the price list says today.
  const t = effectiveTerms(r);

  // Only what we agreed to. A request the customer made and we rejected has no place
  // in the agreement, and one approved with changes goes in with OUR wording.
  const agreed = (await query(
    `SELECT body, agreed_text FROM kindred_web.event_special_requests
      WHERE request_id = $1 AND status IN ('approved','modified')
      ORDER BY created_at`, [r.id])).rows;
  const agreedText = agreed.length
    ? agreed.map((a) => `- ${(a.agreed_text || a.body).trim()}`).join('\n')
    : 'None.';
  const band = t.sources?.base_price_cents?.name || t.sources?.hourly_rate_cents?.name || null;

  // How long the quote stands. Read from the frozen constants first, so a booking
  // quoted under a 7-day window keeps it if the window is later changed to 14.
  const validDays = Number(
    r.requirements?.constants?.quote_valid_days ?? (await contractValues(companyId)).quote_valid_days ?? 7
  ) || 7;
  const requested = r.created_at ? new Date(r.created_at) : null;
  const validUntil = requested
    ? new Date(requested.getTime() + validDays * 86400000) : null;

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

    // Everything the guest was shown on the form, so the contract can restate the
    // deal rather than gesture at it. An em dash where a number is genuinely absent,
    // never a zero: "no deposit" and "nobody set a deposit" are different facts.
    hours: t.hours != null ? String(t.hours) : '—',
    hourly_rate: cash(t.hourly_rate_cents),
    venue_fee: cash(t.rental_total_cents),
    min_wine_purchase: cash(t.min_wine_purchase_cents),
    per_person_hour: cash(t.per_person_hour_cents),
    per_person_total: cash(t.per_person_total_cents),
    booking_deposit: cash(t.booking_deposit_cents),
    security_deposit: cash(t.security_deposit_cents),
    due_to_confirm: cash(t.due_now_cents),
    balance_due_days: t.balance_due_days_before != null ? String(t.balance_due_days_before) : '—',
    planning_meeting_days: t.planning_meeting_days != null ? String(t.planning_meeting_days) : '—',
    insurance_required: t.insurance_required ? 'Yes' : 'No',
    tier_name: band || '—',
    // Degrades to a phrase, not a dash: this sentence has to read as a sentence even
    // on a booking evaluated before the band ceiling was recorded.
    tier_max_guests: t.band_max_guests != null ? `${t.band_max_guests} guests` : 'the agreed guest count',
    // Only the approved ones. The raw note from the form is a request, not a term.
    agreed_items: agreedText,
    special_requests: agreedText,
    request_date: requested ? fmtDate(requested) : '—',
    quote_valid_days: String(validDays),
    quote_valid_until: validUntil ? fmtDate(validUntil) : '—',
    // Terms carries a per-booking parking threshold, so the clause should read this
    // booking's, not the house default.
    ...(t.parking_attendant_over != null
      ? { parking_attendant_threshold: String(t.parking_attendant_over) } : {}),
  };
}

/** Cents as money, or an em dash. Never a zero standing in for "not set". */
function cash(cents) {
  if (cents == null) return '—';
  const n = cents / 100;
  return `$${n.toFixed(2).replace(/\.00$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
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
  // The agreed-additions clause appears only when something was agreed. An empty
  // "Agreed Additions: None." reads like an oversight; its absence reads like
  // nothing was asked for, which is the truth.
  const anyAgreed = (await query(
    `SELECT 1 FROM kindred_web.event_special_requests
      WHERE request_id = $1 AND status IN ('approved','modified') LIMIT 1`,
    [request.id])).rows.length > 0;
  const keys = anyAgreed ? [...extraKeys, 'agreed_additions'] : extraKeys;

  const { rows } = await query(
    `SELECT * FROM kindred_web.event_contract_sections
      WHERE company_id = $1 AND active
        AND (always_include OR key = ANY($2::text[]))
      ORDER BY sort_order, title`,
    [companyId, keys]
  );
  // Constants first, booking second: a per-booking value always wins over the
  // company default, which is what lets a terms band later override a rate for one
  // event without the clause wording changing.
  // Three layers, narrowest last.
  //
  // Live values are only a fallback — for a booking quoted before the constants were
  // frozen, or for a key added to a clause since. The frozen set is what this booking
  // was actually quoted against, and the booking's own figures beat both.
  //
  // Craig's point, and it is the whole reason for the order: terms change after a
  // request is made, and the contract has to state the terms that applied to it.
  const live = await contractValues(companyId);
  const frozen = request?.requirements?.constants || {};
  const tokens = { ...live, ...frozen, ...(await tokensFor(companyId, request)) };
  // Numbered here, by position, rather than stored in the title.
  //
  // The numbers used to be part of the title text, so inserting a section at
  // position 4 left two sections numbered 4 and every later heading off by one —
  // which happened, and a contract that reads 4, 4, 6 is one nobody checked.
  // Numbering at render time means a section can be added, removed or reordered
  // without anybody having to remember to renumber the rest.
  return {
    tokens,
    sections: rows.map((s, i) => ({
      key: s.key,
      number: i + 1,
      title: s.title,
      heading: `${i + 1}. ${s.title}`,
      body: fill(s.body, tokens),
    })),
  };
}
