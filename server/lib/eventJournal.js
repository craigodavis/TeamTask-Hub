/**
 * The journal: what was done to a private event, by whom, and when.
 *
 * Craig: "We need to log a journal of all actions and make that journal available for
 * each event." The reason is not audit for its own sake — it is that this flow has
 * half a dozen steps spread across staff, a customer and two email paths, and when
 * something goes wrong on the day the first question is always what we actually did.
 *
 * Writing the journal is also what triggers the texts. One place, so an action cannot
 * be recorded without the people who asked to hear about it hearing about it, and a
 * notification cannot fire for something that was never recorded.
 */
import { query } from '../db.js';
import { sendSmsToUsers } from './smsHelper.js';

/** Actions worth telling somebody about, and how they read in a text. */
export const NOTIFIABLE = {
  request_received: 'New event enquiry',
  approved: 'Event approved',
  declined: 'Event declined',
  cancelled: 'Event cancelled',
  proposal_sent: 'Proposal sent',
  proposal_accepted: 'Proposal ACCEPTED',
  proposal_declined: 'Proposal turned down',
  special_request: 'New customer request',
  contract_sent: 'Contract sent',
  contract_signed: 'Contract SIGNED by customer',
  contract_executed: 'Contract counter-signed',
  deposit_paid: 'Deposit received',
  insurance_ok: 'Insurance accepted',
  resos_booked: 'Tables reserved in ResOS',
};

/**
 * Record an action, then tell whoever asked to hear about it.
 *
 * Never throws. A journal entry that fails must not take down the thing it was
 * describing, and a Twilio outage must not stop a contract being sent — the action
 * already happened, and losing it to a notification failure would be the worse bug.
 */
export async function journal(companyId, requestId, action, opts = {}) {
  const { detail = null, meta = null, actorId = null, actorName = null, notify = true } = opts;
  try {
    await query(
      `INSERT INTO kindred_web.event_request_activity
         (company_id, request_id, action, detail, meta, actor_id, actor_name)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [companyId, requestId, action, detail, meta ? JSON.stringify(meta) : null, actorId, actorName]);
  } catch (e) {
    console.error('[journal] could not record', action, e.message);
    return;
  }
  if (notify) notifyFor(companyId, requestId, action, detail).catch((e) =>
    console.error('[journal] notify failed for', action, e.message));
}

async function notifyFor(companyId, requestId, action, detail) {
  if (!NOTIFIABLE[action]) return;
  const people = (await query(
    `SELECT u.id FROM kindred_web.event_notify n
       JOIN users u ON u.id = n.user_id
      WHERE n.company_id = $1 AND n.action = $2
        AND u.phone IS NOT NULL AND u.phone <> ''`,
    [companyId, action])).rows;
  if (!people.length) return;

  const r = (await query(
    `SELECT first_name, last_name, event_date, guests FROM kindred_web.event_requests WHERE id = $1`,
    [requestId])).rows[0] || {};
  const who = `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'an enquiry';
  const when = r.event_date ? new Date(r.event_date).toLocaleDateString('en-US',
    { month: 'short', day: 'numeric' }) : 'no date';

  const body = `Kindred events — ${NOTIFIABLE[action]}: ${who}, ${when}`
    + (r.guests ? `, ${r.guests} guests` : '')
    + (detail ? `. ${detail}` : '');
  await sendSmsToUsers(companyId, people.map((p) => p.id), body, null);
}

/** The journal for one booking, newest first. */
export async function journalFor(requestId) {
  const { rows } = await query(
    `SELECT action, detail, meta, actor_name, created_at
       FROM kindred_web.event_request_activity
      WHERE request_id = $1 ORDER BY created_at DESC, id DESC LIMIT 500`, [requestId]);
  return rows;
}
