/**
 * Private-event TERMS: what a booking of a given size, at a given venue, inside or
 * outside opening hours actually costs and requires.
 *
 * This replaces the old event_rules table. That model had one row per EFFECT, so
 * "over 50 at the Creek after hours" meant eight near-identical rows — a rate row, a
 * deposit row, an insurance row — whose conditions could drift apart with nobody
 * noticing. Craig described the real shape: one condition set produces a whole
 * package of terms at once.
 *
 *   if over X people at a venue during/after hours
 *     -> rate, availability, deposit, security deposit, min wine purchase,
 *        insurance, which contract sections, whether a contract is needed at all
 *
 * Conditions are guests x venue x business-hours. Every one is nullable; NULL means
 * "any". Every OUTCOME is nullable too, which is what makes rows composable: a broad
 * row sets the house defaults, a narrow row overrides the two things that differ.
 *
 * Resolution is narrowest-match-wins, per field. Matching rows are ordered most
 * specific first, and each outcome takes the first row that has an opinion about it.
 * That is how CSS behaves and it means a new "over 100 at the Creek" row only has to
 * state what is special about it.
 *
 * Nothing in here contains policy. A 15-person daytime event needs no contract
 * because a row says so, not because this file has a 15 in it.
 */
import { query } from '../db.js';
import { resolveDay } from './hoursResolver.js';

/** Outcome columns, most specific row wins each one independently. */
export const SCALAR_OUTCOMES = [
  'availability',
  'base_price_cents',
  'min_wine_purchase_cents',
  'security_deposit_cents',
  'booking_deposit_cents',
  'booking_deposit_pct',
  'balance_due_days_before',
  'planning_meeting_days',
  'insurance_required',
  'contract_required',
  'parking_attendant_over',
  'notes_to_customer',
];

/** Array outcomes: an EMPTY array is also "no opinion", not "deliberately none". */
export const LIST_OUTCOMES = ['contract_section_keys', 'setup_task_keys'];

export const CONDITIONS = ['min_guests', 'max_guests', 'location_id', 'during_business_hours'];

/**
 * Is the whole requested window inside the venue's opening hours for that date?
 *
 * A window that straddles opening or closing counts as OUTSIDE: it is the safer
 * answer and the easy one to explain to a customer. A day the venue is closed is
 * likewise outside — the Creek has no Monday hours at all, and booking one means
 * opening specially, which may deserve its own rule.
 *
 * Returns null when it cannot be determined (no time given), so callers can tell
 * "outside hours" from "we don't know" — a rule requiring during_business_hours
 * must not match on an unknown.
 */
export async function duringBusinessHours(companyId, locationId, date, startTime, endTime) {
  if (!locationId || !date || !startTime || !endTime) return null;

  const [rules, specials] = await Promise.all([
    query(`SELECT * FROM kindred_web.hours
            WHERE company_id = $1 AND location_id = $2`, [companyId, locationId]),
    query(`SELECT * FROM kindred_web.hours_special
            WHERE company_id = $1 AND location_id = $2`, [companyId, locationId]),
  ]);

  let day;
  try {
    day = resolveDay(rules.rows, specials.rows, date);
  } catch {
    return null;
  }
  if (!day || day.closed || !day.intervals?.length) return false;

  // resolveDay returns INTERVALS, not a single opens/closes — a day can have split
  // hours, and seasonal rows (e.g. "Hot August Nights") add their own. The window
  // must fit inside one interval; spanning a midday closure is not "during hours".
  const hm = (t) => String(t).slice(0, 5);
  const from = hm(startTime);
  const to = hm(endTime);
  return day.intervals.some((iv) => from >= hm(iv.opens) && to <= hm(iv.closes));
}

/**
 * Three-way: does the window sit inside opening hours, outside, or across both?
 *
 * duringBusinessHours answers yes/no because a rule has to match one or the other.
 * The contract header needs the third answer — Craig's "Business hours, after hours,
 * or both" — because an event running 15:00–19:00 at the Creek genuinely spans the
 * 16:00 opening and calling it simply "after hours" on a contract would be wrong.
 *
 * Returns 'during' | 'after' | 'both' | null (unknown).
 */
export async function rentalType(companyId, locationId, date, startTime, endTime) {
  if (!locationId || !date || !startTime || !endTime) return null;

  const [rules, specials] = await Promise.all([
    query(`SELECT * FROM kindred_web.hours WHERE company_id = $1 AND location_id = $2`, [companyId, locationId]),
    query(`SELECT * FROM kindred_web.hours_special WHERE company_id = $1 AND location_id = $2`, [companyId, locationId]),
  ]);

  let day;
  try { day = resolveDay(rules.rows, specials.rows, date); } catch { return null; }
  if (!day || day.closed || !day.intervals?.length) return 'after';

  const hm = (t) => String(t).slice(0, 5);
  const from = hm(startTime);
  const to = hm(endTime);

  if (day.intervals.some((iv) => from >= hm(iv.opens) && to <= hm(iv.closes))) return 'during';
  // Any overlap at all, without being wholly contained, means it spans both.
  const overlaps = day.intervals.some((iv) => from < hm(iv.closes) && to > hm(iv.opens));
  return overlaps ? 'both' : 'after';
}

/**
 * How specific is this row? The number of DIMENSIONS it pins down, out of three:
 * headcount, venue, and inside-or-outside opening hours.
 *
 * Counting each column instead would make min_guests + max_guests score 2 and beat a
 * row pinning headcount AND hours — the 10-24 tier would outrank "15 or fewer during
 * open hours" and quietly put a contract and a deposit back on a small daytime party.
 * Guests is one dimension however many of its bounds are set.
 *
 * Ties break on the tighter guest band, then created_at, so the order is total and
 * stable: two rows must never swap places between page loads and change a quote.
 */
export function specificity(term) {
  let n = 0;
  if (term.min_guests != null || term.max_guests != null) n += 1;
  if (term.location_id != null) n += 1;
  if (term.during_business_hours != null) n += 1;
  return n;
}

function guestBandWidth(term) {
  const lo = term.min_guests ?? 0;
  const hi = term.max_guests ?? Number.MAX_SAFE_INTEGER;
  return hi - lo;
}

/** Does this row's condition set cover the booking? */
export function termMatches(term, booking, inHours) {
  const { guests, locationId } = booking;

  if (term.min_guests != null && (guests == null || guests < term.min_guests)) return false;
  if (term.max_guests != null && (guests == null || guests > term.max_guests)) return false;
  if (term.location_id && term.location_id !== locationId) return false;

  // An unknown hours answer must not satisfy a row that cares either way, or a
  // request submitted without a time would quietly pick up after-hours pricing.
  if (term.during_business_hours != null) {
    if (inHours === null) return false;
    if (term.during_business_hours !== inHours) return false;
  }

  return true;
}

function isEmpty(v) {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

/**
 * Evaluate a booking and return its terms.
 *
 * The result is built to be FROZEN onto a proposal. The tier code already does this
 * and the reason holds here: terms get edited, and what a guest was quoted must not
 * change under them afterwards.
 *
 * `sources` names the row that supplied each field, so the screen can answer "why am
 * I being charged a security deposit" with a row name instead of a number.
 */
export async function evaluate(companyId, booking) {
  const inHours = await duringBusinessHours(
    companyId, booking.locationId, booking.eventDate, booking.startTime, booking.endTime
  );

  const { rows } = await query(
    `SELECT * FROM kindred_web.event_terms
      WHERE company_id = $1 AND active`, [companyId]
  );

  return resolveTerms(rows, booking, inHours);
}

/**
 * The resolution itself, with no database in it, so it can be exercised directly.
 * Given the candidate rows, the booking, and the hours answer, produce the terms.
 */
export function resolveTerms(rows, booking, inHours) {
  const matched = rows
    .filter((t) => termMatches(t, booking, inHours))
    .sort((a, b) =>
      specificity(b) - specificity(a) ||
      guestBandWidth(a) - guestBandWidth(b) ||
      new Date(a.created_at) - new Date(b.created_at));

  const terms = {};
  const sources = {};
  for (const field of [...SCALAR_OUTCOMES, ...LIST_OUTCOMES]) {
    const row = matched.find((t) => !isEmpty(t[field]));
    if (row) {
      terms[field] = field === 'booking_deposit_pct' ? Number(row[field]) : row[field];
      sources[field] = { id: row.id, name: row.name };
    } else {
      terms[field] = field === 'contract_section_keys' || field === 'setup_task_keys' ? [] : null;
      sources[field] = null;
    }
  }

  // Defaults for the two that must always have an answer. Everything else is
  // legitimately "nothing configured", and the UI shows that as a gap rather than
  // inventing a zero that looks like a decision.
  if (terms.availability == null) terms.availability = 'available';
  if (terms.contract_required == null) terms.contract_required = false;
  if (terms.insurance_required == null) terms.insurance_required = false;

  const hours = booking.startTime && booking.endTime
    ? hoursBetween(booking.startTime, booking.endTime) : null;

  // A flat deposit beats a percentage when both are set: the tiers quote flat amounts
  // ($200, $500) and the contract's 50/50 wording is the fallback for anything that
  // only has a percentage.
  const bookingDepositCents = terms.booking_deposit_cents != null
    ? terms.booking_deposit_cents
    : (terms.base_price_cents != null && terms.booking_deposit_pct != null
        ? Math.round(terms.base_price_cents * terms.booking_deposit_pct / 100)
        : null);

  return {
    evaluatedAt: new Date().toISOString(),
    duringBusinessHours: inHours,
    guests: booking.guests ?? null,
    hours,
    ...terms,
    booking_deposit_cents: bookingDepositCents,
    // What the customer owes up front vs on the day, so the screen and the contract
    // do not each do this arithmetic differently.
    due_now_cents: (bookingDepositCents ?? 0) + (terms.security_deposit_cents ?? 0) || null,
    sources,
    // Every row that applied, in the order they were consulted. This is what makes
    // the quote explainable instead of a bare total.
    matched: matched.map((t) => ({
      id: t.id, name: t.name, specificity: specificity(t),
      conditions: Object.fromEntries(CONDITIONS.map((c) => [c, t[c]])),
    })),
  };
}

/** Decimal hours between two HH:MM times; null if it does not go forward. */
export function hoursBetween(startTime, endTime) {
  const mins = (t) => {
    const [h, m] = String(t).slice(0, 5).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  const a = mins(startTime); const b = mins(endTime);
  if (a == null || b == null || b <= a) return null;
  return (b - a) / 60;
}
