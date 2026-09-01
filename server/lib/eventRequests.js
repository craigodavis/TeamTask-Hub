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
