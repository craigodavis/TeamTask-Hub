/**
 * Whether a booking can be approved yet, and if not, why.
 *
 * Approving is the moment we commit to hosting, so it has prerequisites, and they
 * are not all ours:
 *
 *   - Nothing they asked for may still be undecided. Approving around an unanswered
 *     question means agreeing to host an event whose shape nobody has settled.
 *   - Anything we agreed to WITH CHANGES has to be accepted by them first. That is
 *     us answering a different question from the one asked — they wanted noodles, we
 *     said noodles from your own caterer — and treating it as settled because we
 *     settled it is how a contract comes to contain a term the customer never agreed
 *     to.
 *
 * Returned as reasons rather than a boolean so the screen can say what is in the way
 * instead of showing a button that does nothing.
 */
import { query } from '../db.js';

export async function approvalBlockers(requestId) {
  const { rows } = await query(
    `SELECT status, body, agreed_text, customer_accepted_at, customer_declined_at
       FROM kindred_web.event_special_requests
      WHERE request_id = $1`, [requestId]);

  const short = (t) => `“${String(t || '').replace(/\s+/g, ' ').slice(0, 48)}”`;
  const blockers = [];

  for (const r of rows) {
    if (r.status === 'pending') {
      blockers.push({ kind: 'undecided', text: `${short(r.body)} has not been answered` });
    } else if (r.status === 'modified' && !r.customer_accepted_at) {
      blockers.push({
        kind: r.customer_declined_at ? 'change_refused' : 'awaiting_customer',
        text: r.customer_declined_at
          ? `they are not happy with the change to ${short(r.body)}`
          : `waiting for them to accept the change to ${short(r.body)}`,
      });
    }
  }
  return blockers;
}

export const canApprove = async (requestId) => (await approvalBlockers(requestId)).length === 0;
