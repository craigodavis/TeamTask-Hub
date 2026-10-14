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
  'hourly_rate_cents',
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

  const out = resolveTerms(rows, booking, inHours);

  // The contract's editable values — capacity, what the rental includes, the payment
  // split, the setup hours — frozen with the rest.
  //
  // These are terms, not decoration: a contract that says "capacity up to 30" must
  // say what it was when this booking was quoted, not what somebody changed it to
  // last week. Freezing the whole set costs one small object and means a value added
  // to a clause later is automatically captured for bookings quoted after it, with
  // no column to remember to add.
  const consts = await query(
    `SELECT key, value FROM kindred_web.event_contract_values WHERE company_id = $1`,
    [companyId]);
  out.constants = Object.fromEntries(consts.rows.map((r) => [r.key, r.value ?? '']));

  return out;
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

  // The guest band that set the price, carried on the snapshot so a contract can say
  // "this rate covers up to N guests" without going back to a table that may since
  // have changed or been deleted.
  const priceRow = matched.find((t) => !isEmpty(t.hourly_rate_cents) || !isEmpty(t.base_price_cents));

  const hours = booking.startTime && booking.endTime
    ? hoursBetween(booking.startTime, booking.endTime) : null;

  // The venue fee is per hour. The flat base_price_cents is the fallback for rows
  // whose hourly rate has not been set yet, so pricing never silently drops to
  // nothing mid-changeover. An hourly rate with no times given cannot be totalled —
  // that reads as "we need your times", not as a free booking.
  const rentalCents = terms.hourly_rate_cents != null
    ? (hours != null ? Math.round(terms.hourly_rate_cents * hours) : null)
    : (terms.base_price_cents ?? null);
  const rentalBasis = terms.hourly_rate_cents != null ? 'hourly' : 'flat';

  // A flat deposit beats a percentage when both are set: the tiers quote flat amounts
  // ($200, $500) and the contract's 50/50 wording is the fallback for anything that
  // only has a percentage.
  const bookingDepositCents = terms.booking_deposit_cents != null
    ? terms.booking_deposit_cents
    : (rentalCents != null && terms.booking_deposit_pct != null
        ? Math.round(rentalCents * terms.booking_deposit_pct / 100)
        : null);

  return {
    evaluatedAt: new Date().toISOString(),
    duringBusinessHours: inHours,
    guests: booking.guests ?? null,
    hours,
    ...terms,
    rental_total_cents: rentalCents,
    rental_basis: rentalBasis,
    band_min_guests: priceRow?.min_guests ?? null,
    band_max_guests: priceRow?.max_guests ?? null,
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

/** Fields staff may change for a single booking. Conditions are not among them. */
export const OVERRIDABLE = [
  'hourly_rate_cents', 'base_price_cents', 'rental_total_cents',
  'min_wine_purchase_cents', 'booking_deposit_cents', 'security_deposit_cents',
  'balance_due_days_before', 'planning_meeting_days',
  'insurance_required', 'contract_required', 'availability', 'notes_to_customer',
];

/**
 * What this booking is actually on: the evaluated terms with any per-booking changes
 * laid over them.
 *
 * The two are stored apart rather than merged on save. Writing an override straight
 * over the snapshot would answer "what are we charging" and destroy "why is it
 * different from the price list", and the second question is the one that gets asked
 * months later when nobody remembers the conversation.
 *
 * due_now_cents is recomputed rather than carried across: it is the sum of the two
 * deposits, so overriding a deposit and leaving the total alone would put a figure on
 * the proposal that does not add up.
 */
export function effectiveTerms(request) {
  const base = request?.requirements || {};
  const over = request?.overrides || {};
  const out = { ...base };

  for (const k of OVERRIDABLE) {
    if (Object.prototype.hasOwnProperty.call(over, k) && over[k] !== undefined) out[k] = over[k];
  }
  out.overridden = OVERRIDABLE.filter((k) =>
    Object.prototype.hasOwnProperty.call(over, k) && over[k] !== undefined
    && JSON.stringify(over[k]) !== JSON.stringify(base[k]));

  if (out.overridden.includes('hourly_rate_cents') && !out.overridden.includes('rental_total_cents')) {
    out.rental_total_cents = out.hourly_rate_cents != null && out.hours != null
      ? Math.round(out.hourly_rate_cents * out.hours) : out.rental_total_cents;
  }
  // Recomputed ONLY when an override touched a deposit. Doing it unconditionally
  // discarded the quoted figure on any snapshot that recorded a total without its
  // parts, which silently turned an agreed deposit into nothing owed.
  if (out.overridden.includes('booking_deposit_cents')
      || out.overridden.includes('security_deposit_cents')) {
    out.due_now_cents =
      (out.booking_deposit_cents ?? 0) + (out.security_deposit_cents ?? 0) || null;
  }

  return out;
}
