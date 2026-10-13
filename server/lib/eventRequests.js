/**
 * Special Event Requests — the rules that must not differ between the public
 * form, the Team screen and the guest's return page.
 *
 * The one that matters: a request is quoted ONCE, at the moment it is submitted.
 * Tiers get edited — a price rises, a deposit is added — and a guest who was
 * quoted $500 must not silently be held to $750 because someone changed a
 * setting a week later. So the tier's figures are copied onto the request and
 * everything downstream reads those, never the tier. `tier_id` is kept for
 * reporting only.
 */
import { query } from '../db.js';
import crypto from 'crypto';

/** Settings keys, so the route and the UI can't disagree about spelling. */
export const KEYS = {
  intro: 'event_request_intro',              // copy at the top of the public form
  approvedEmail: 'event_request_approved_email', // body of the "you're approved" email
  alertUsers: 'event_request_alert_users',   // user ids to text — see alertRecipients()
};

/**
 * The tier covering a guest count. Bands are [min_guests, max_guests], max NULL
 * meaning "and above". Overlaps are possible if someone configures them badly,
 * so this is deterministic: the narrowest matching band wins, then the highest
 * minimum — a specific 40–60 rule beats a catch-all 1+.
 */
export async function tierForGuests(guests) {
  const n = Number(guests);
  if (!Number.isFinite(n) || n < 1) return null;
  const { rows } = await query(
    `SELECT * FROM kindred_web.event_tiers
      WHERE min_guests <= $1 AND (max_guests IS NULL OR max_guests >= $1)
      ORDER BY (max_guests IS NULL), (COALESCE(max_guests, 2147483647) - min_guests), min_guests DESC
      LIMIT 1`,
    [n],
  );
  return rows[0] || null;
}

/**
 * A URL-safe token for the guest's return link.
 *
 * 32 bytes of crypto randomness: this link is the only thing between the public
 * and someone else's event details, and it arrives by email where it may be
 * forwarded or logged. Not guessable, and not derived from anything about the
 * request.
 */
export const newToken = () => crypto.randomBytes(32).toString('base64url');

/** What the guest still has to do. Requirements not asked for are not steps. */
export function outstanding(reqRow) {
  const steps = [];
  if (reqRow.deposit_required) {
    steps.push({
      key: 'deposit',
      done: Boolean(reqRow.deposit_paid_at),
      label: 'Security deposit',
    });
  }
  if (reqRow.insurance_required) {
    steps.push({
      key: 'insurance',
      // Uploading is not the same as being accepted — staff still have to look
      // at it. Two states, so the guest can tell "we have it" from "it's fine".
      done: Boolean(reqRow.insurance_ok),
      uploaded: Boolean(reqRow.insurance_uploaded_at),
      label: 'Proof of insurance',
    });
  }
  return steps;
}

/**
 * Is everything this event needed satisfied? An event with no deposit and no
 * insurance requirement is complete the moment it is approved — which is why
 * this is computed from the steps rather than from a flag someone must remember
 * to set.
 */
export const allSatisfied = (reqRow) =>
  reqRow.status === 'approved' && outstanding(reqRow).every((s) => s.done);

/** Money in, readable out. Cents are stored; dollars are never stored. */
export const money = (cents) =>
  typeof cents === 'number' ? `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}` : '';

/* ------------------------------------------------------- staff notification */

/**
 * Who gets texted about event requests.
 *
 * An explicit list, not "everyone with a manager role". The role query returns
 * five people here, and texting the whole management team about every enquiry is
 * how a useful alert becomes one nobody reads. The list is a setting so it can
 * be changed in Team without a deploy.
 *
 * Falls back to owners only if nothing is configured — quieter is the safer
 * default for a notification nobody asked for.
 */
export async function alertRecipients(companyId) {
  let ids = null;
  try {
    const r = await query(`SELECT value FROM kindred_web.settings WHERE key = $1`, [KEYS.alertUsers]);
    const v = r.rows[0]?.value;
    if (Array.isArray(v) && v.length) ids = v;
  } catch { /* fall through to the default */ }

  const { rows } = ids
    ? await query(
        `SELECT id, display_name, phone FROM teamtask_hub.users
          WHERE company_id = $1 AND id = ANY($2::uuid[]) AND phone IS NOT NULL AND phone <> ''
          ORDER BY display_name`, [companyId, ids])
    : await query(
        `SELECT id, display_name, phone FROM teamtask_hub.users
          WHERE company_id = $1 AND role = 'owner' AND phone IS NOT NULL AND phone <> ''
          ORDER BY display_name`, [companyId]);
  return rows;
}

/** 'YYYY-MM-DD' → 'Sat, Oct 12'. Dates are stored as DATE, so no timezone games. */
export function shortDate(d) {
  if (!d) return '';
  const s = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * The "book the planning meeting" alert.
 *
 * Deliberately short: it is an SMS, and its whole job is to get someone to open
 * Team. The date we must have met BY is the one piece that has to be in the
 * message, because that is what makes it urgent or not.
 */
export function planningMeetingSms(reqRow) {
  const who = `${reqRow.first_name} ${reqRow.last_name}`.trim();
  const when = shortDate(reqRow.event_date);
  const by = reqRow.planning_meeting_due ? ` Book the pre-event planning meeting by ${shortDate(reqRow.planning_meeting_due)}.` : '';
  return `Kindred: event approved — ${who}, ${reqRow.guests} guests, ${when}.${by}`;
}

/** The alert when a new request arrives, before anyone has approved anything. */
export function newRequestSms(reqRow) {
  const who = `${reqRow.first_name} ${reqRow.last_name}`.trim();
  return `Kindred: new event request — ${who}, ${reqRow.guests} guests, ${shortDate(reqRow.event_date)}. Review in Team.`;
}

/**
 * When a private event may start and finish, and the granularity we ask for.
 *
 * Craig: minutes only on the hour and half hour, nothing after 10PM or before 10AM.
 *
 * Defined once and served to the public form in the pricing response, so the page
 * builds its dropdowns from the same numbers the server validates against. Baking
 * the window into the page as well would be a second copy of a rule, and the band
 * rule already showed how that ends: the page offers something the server refuses.
 */
export const BOOKING_WINDOW = {
  earliest: '10:00',   // earliest an event may start
  closes: '22:00',     // nothing runs past this, ever — the one hard rule
  stepMinutes: 30,
  maxHours: 4,
};

/**
 * The latest an event may start: one step before closing.
 *
 * Derived rather than configured. A separate "latest start" was a second number
 * that had to agree with the close, and when it was set to 7PM it quietly made
 * after-hours bookings unreachable — the Creek is still open to the public at 7
 * most nights, so nothing booked through the form could ever land after hours.
 * Deriving it means the 10PM close is the only rule anyone has to maintain.
 */
export const latestStart = () =>
  hhmmOf(minutesOfDay(BOOKING_WINDOW.closes) - BOOKING_WINDOW.stepMinutes);

/** "13:30" -> 810. Null for anything that is not a time on our grid. */
export function minutesOfDay(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export const hhmmOf = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * Check a start time and a duration against the window.
 *
 * Returns { startTime, endTime } or { error }. The end is COMPUTED from the hours
 * rather than asked for: the form asks "how many hours", because that is the thing
 * a customer knows and it is what the per-hour price multiplies.
 */
export function resolveWindow(startTime, hours) {
  const start = minutesOfDay(startTime);
  const open = minutesOfDay(BOOKING_WINDOW.earliest);
  const closes = minutesOfDay(BOOKING_WINDOW.closes);
  const lastStart = closes - BOOKING_WINDOW.stepMinutes;

  if (start == null) return { error: 'Please choose a start time.' };
  if (start % BOOKING_WINDOW.stepMinutes !== 0) {
    return { error: 'Please choose a start time on the hour or the half hour.' };
  }
  if (start < open || start > lastStart) {
    return { error: `Events start between ${BOOKING_WINDOW.earliest} and ${latestStart()}.` };
  }

  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return { error: 'Please choose how many hours you need.' };
  if ((h * 60) % BOOKING_WINDOW.stepMinutes !== 0) {
    return { error: 'Please choose a length in half hours.' };
  }
  if (h > BOOKING_WINDOW.maxHours) {
    return { error: `We book up to ${BOOKING_WINDOW.maxHours} hours through the form. Ring us for anything longer.` };
  }

  // Two limits, and the tighter one wins: a late start cannot run the full four
  // hours, because nothing runs past the close.
  const end = start + Math.round(h * 60);
  if (end > closes) {
    return { error: `Everything finishes by ${BOOKING_WINDOW.closes}, so that is longer than we can fit from ${startTime}.` };
  }
  return { startTime: hhmmOf(start), endTime: hhmmOf(end) };
}
