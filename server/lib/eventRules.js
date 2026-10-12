/**
 * Private-event rules: what a booking requires.
 *
 * See docs/PRIVATE_EVENTS.md. Deliberately a narrow, typed table rather than a
 * general condition/action engine — the question that actually gets asked is "why
 * was I charged a deposit", and a general engine cannot answer it once there are
 * fifteen rules.
 *
 * Every condition is nullable and NULL means "don't care". Rules are gathered, then
 * ONE wins per effect_type by priority (lower first). The winners become the
 * booking's requirements.
 *
 * Nothing here decides policy. A 15-person daytime event gets no deposit because a
 * rule says so, not because the code has a threshold in it.
 */
import { query } from '../db.js';
import { resolveDay } from './hoursResolver.js';

export const EFFECT_TYPES = [
  'deposit', 'payment', 'contract', 'insurance', 'staffing', 'surcharge', 'block',
];

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

/** Sunday = 0, matching EXTRACT(DOW) and the day_of_week column in hours. */
function dowBit(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00`);
  return 1 << d.getDay();
}

function daysUntil(dateStr) {
  const target = new Date(`${String(dateStr).slice(0, 10)}T12:00:00`);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

/**
 * Does one rule apply to this booking?
 *
 * `inHours` is passed in rather than looked up per rule so the hours are resolved
 * once and can be snapshotted alongside the decision.
 */
export function ruleMatches(rule, booking, inHours) {
  const { guests, locationId, eventDate } = booking;

  if (rule.min_guests != null && (guests == null || guests < rule.min_guests)) return false;
  if (rule.max_guests != null && (guests == null || guests > rule.max_guests)) return false;
  if (rule.location_id && rule.location_id !== locationId) return false;

  // An unknown hours answer must not satisfy a rule that cares either way,
  // otherwise a request with no time silently picks up after-hours pricing.
  if (rule.during_business_hours != null) {
    if (inHours === null) return false;
    if (rule.during_business_hours !== inHours) return false;
  }

  if (rule.day_of_week_mask != null && eventDate) {
    if ((rule.day_of_week_mask & dowBit(eventDate)) === 0) return false;
  }

  if ((rule.lead_days_min != null || rule.lead_days_max != null) && eventDate) {
    const lead = daysUntil(eventDate);
    if (rule.lead_days_min != null && lead < rule.lead_days_min) return false;
    if (rule.lead_days_max != null && lead > rule.lead_days_max) return false;
  }

  return true;
}

/**
 * Evaluate a booking and return its requirements.
 *
 * The result is designed to be FROZEN onto a proposal. The tier code already works
 * this way and says why: tiers get edited, and what a guest was told must not change
 * under them afterwards. Rules are no different — editing a deposit threshold must
 * never rewrite terms someone has already been quoted or signed.
 *
 * `matched` records every rule that applied and which one won, so the screen can
 * show the reasoning rather than just a number.
 */
export async function evaluate(companyId, booking) {
  const inHours = await duringBusinessHours(
    companyId, booking.locationId, booking.eventDate, booking.startTime, booking.endTime
  );

  const { rows } = await query(
    `SELECT * FROM kindred_web.event_rules
      WHERE company_id = $1 AND active
      ORDER BY priority ASC, created_at ASC`, [companyId]
  );

  const matched = rows.filter((r) => ruleMatches(r, booking, inHours));

  // One winner per effect type — the first, since the query is already ordered.
  const winners = {};
  for (const r of matched) if (!winners[r.effect_type]) winners[r.effect_type] = r;

  const payments = matched
    .filter((r) => r.effect_type === 'payment')
    .map((r) => ({
      ruleId: r.id, name: r.name,
      amountCents: r.amount_cents ?? null,
      amountPct: r.amount_pct != null ? Number(r.amount_pct) : null,
      dueOffsetDays: r.due_offset_days ?? null,
      customerText: r.customer_text || null,
    }));

  const flag = (type) => {
    const w = winners[type];
    if (!w) return { required: false, ruleId: null, ruleName: null, reason: 'no rule matched' };
    // An effect with no amount and no text is how a rule says "explicitly not
    // required" — rule 10 in the design, the 15-person daytime case.
    const required = !(w.amount_cents === 0 || w.amount_cents == null) || !!w.customer_text;
    return {
      required: type === 'deposit' ? (w.amount_cents ?? 0) > 0 : required,
      ruleId: w.id, ruleName: w.name,
      amountCents: w.amount_cents ?? null,
      customerText: w.customer_text || null,
    };
  };

  return {
    evaluatedAt: new Date().toISOString(),
    duringBusinessHours: inHours,
    deposit: flag('deposit'),
    contract: flag('contract'),
    insurance: flag('insurance'),
    payments,
    blocked: !!winners.block,
    blockedReason: winners.block?.customer_text || null,
    surcharge: winners.surcharge
      ? { ruleId: winners.surcharge.id, amountCents: winners.surcharge.amount_cents,
          customerText: winners.surcharge.customer_text }
      : null,
    staffing: winners.staffing
      ? { ruleId: winners.staffing.id, customerText: winners.staffing.customer_text }
      : null,
    // Every rule that applied, winner or not — this is what makes the decision
    // explainable instead of a bare number.
    matched: matched.map((r) => ({
      id: r.id, name: r.name, effectType: r.effect_type, priority: r.priority,
      won: winners[r.effect_type]?.id === r.id,
    })),
  };
}
