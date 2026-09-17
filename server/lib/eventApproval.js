/**
 * Event approval workflow: notifications + the nag scheduler.
 *
 * Pipeline: draft → review → approved → published.
 *  - When a draft is submitted, the approver is texted, and re-texted every day
 *    until they approve or request changes (the event leaves 'review').
 *  - When approved, the creator is texted, and re-texted every day until they
 *    publish (the event leaves 'approved').
 *
 * Reminders are SMS via smsHelper. Best-effort — a send failure never blocks the
 * workflow; it just gets retried on the next tick.
 */
import { query } from '../db.js';
import { sendSmsToUsers } from './smsHelper.js';

function appBase() {
  return (process.env.APP_BASE_URL || 'https://team.kindredvineyards.com').replace(/\/$/, '');
}
const eventsLink = () => `${appBase()}/events`;

export async function getApprovalConfig(companyId) {
  const r = await query(
    `SELECT event_approval_required AS required, event_approver_id AS approver_id
       FROM scheduling_settings WHERE company_id = $1`,
    [companyId]
  );
  return { required: !!r.rows[0]?.required, approverId: r.rows[0]?.approver_id || null };
}

/** Text the approver that an event is waiting for review. Stamps review_notified_at. */
export async function notifyApprover(companyId, event, actorId = null) {
  const { approverId } = await getApprovalConfig(companyId);
  if (!approverId) return { skipped: 'no_approver' };
  const msg = `TeamHub — review needed: “${event.title}” is ready for your approval. ${eventsLink()}`;
  const r = await sendSmsToUsers(companyId, [approverId], msg, actorId);
  await query(`UPDATE events SET review_notified_at = NOW() WHERE id = $1`, [event.id]).catch(() => {});
  return r;
}

/** Text the creator that their event was approved (nudge to publish). */
export async function notifyCreatorApproved(companyId, event, actorId = null) {
  if (!event.created_by) return { skipped: 'no_creator' };
  const msg = `TeamHub — “${event.title}” was approved and is ready to publish. ${eventsLink()}`;
  const r = await sendSmsToUsers(companyId, [event.created_by], msg, actorId);
  await query(`UPDATE events SET approved_notified_at = NOW() WHERE id = $1`, [event.id]).catch(() => {});
  return r;
}

/** Text the creator that changes were requested. */
export async function notifyCreatorChanges(companyId, event, notes, actorId = null) {
  if (!event.created_by) return { skipped: 'no_creator' };
  const tail = notes ? `: ${String(notes).slice(0, 300)}` : ' — see the review notes.';
  const msg = `TeamHub — changes requested on “${event.title}”${tail} ${eventsLink()}`;
  return sendSmsToUsers(companyId, [event.created_by], msg, actorId);
}

/**
 * Re-nag anyone sitting on a pending event. Runs on a timer. One text per event
 * per ~day: an event in 'review' re-texts the approver, one in 'approved'
 * re-texts the creator, until it moves on.
 */
export async function runDueApprovalReminders(companyId) {
  const { required, approverId } = await getApprovalConfig(companyId);
  if (!required) return { skipped: 'approval_off' };
  let review = 0, publish = 0;

  const inReview = (await query(
    `SELECT id, title FROM events
      WHERE company_id = $1 AND stage = 'review'
        AND (review_notified_at IS NULL OR review_notified_at < NOW() - INTERVAL '23 hours')`,
    [companyId]
  )).rows;
  for (const ev of inReview) {
    if (!approverId) break;
    await notifyApprover(companyId, ev).catch(() => {});
    review++;
  }

  const approved = (await query(
    `SELECT id, title, created_by FROM events
      WHERE company_id = $1 AND stage = 'approved'
        AND (approved_notified_at IS NULL OR approved_notified_at < NOW() - INTERVAL '23 hours')`,
    [companyId]
  )).rows;
  for (const ev of approved) {
    await notifyCreatorApproved(companyId, ev).catch(() => {});
    publish++;
  }
  return { review, publish };
}

let started = false;
export function startEventApprovalReminders() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      const cs = (await query(`SELECT company_id FROM scheduling_settings WHERE event_approval_required = true`)).rows;
      for (const c of cs) await runDueApprovalReminders(c.company_id).catch((e) => console.error('[approval]', c.company_id, e.message));
    } catch (e) { console.error('[approval] loop failed:', e.message); }
  };
  setTimeout(run, 90 * 1000);
  setInterval(run, 6 * 60 * 60 * 1000); // every 6h; the 23h gate throttles to ~daily
  console.log('Event approval reminder scheduler started (6h).');
}
