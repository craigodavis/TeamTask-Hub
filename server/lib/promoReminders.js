/**
 * Promotion ticklers — texts the assignee of a promo task at 1 month / 3 weeks /
 * 2 weeks / 1 week before the event, until they mark it done. From the 2-week
 * mark on, an incomplete task also texts a broader audience (the task's
 * escalate_to list, plus owners/managers as a fallback).
 * Runs every 6h; each mark fires once (tracked in promo_tasks.reminders_sent).
 *   Manual: DB_HOST=localhost node lib/promoReminders.js <companyId> [force]
 */
import { query } from '../db.js';
import { sendSmsToUsers } from './smsHelper.js';

const TZ = 'America/Denver';
const MARKS = [{ d: 30, label: '1 month' }, { d: 21, label: '3 weeks' }, { d: 14, label: '2 weeks' }, { d: 7, label: '1 week' }];
const ESCALATE_AT = 14; // days: at/inside 2 weeks, broaden to the wider audience

export async function runPromoReminders(companyId, { force = false } = {}) {
  const rows = (await query(
    `SELECT pt.id, pt.title, pt.assignee_user_id, pt.escalate_to, pt.reminders_sent,
            e.title AS event_title,
            to_char(e.start_at AT TIME ZONE $2, 'FMMon FMDD') AS date_str,
            ((e.start_at AT TIME ZONE $2)::date - (NOW() AT TIME ZONE $2)::date) AS days_until
       FROM promo_tasks pt JOIN events e ON e.id = pt.event_id
      WHERE pt.company_id = $1 AND pt.done = false
        AND (e.start_at AT TIME ZONE $2)::date >= (NOW() AT TIME ZONE $2)::date`,
    [companyId, TZ])).rows;
  if (!rows.length) return [];

  // owners/managers fallback for escalation
  const mgrs = (await query(`SELECT id FROM users WHERE company_id = $1 AND role IN ('owner','manager')`, [companyId])).rows.map((r) => r.id);
  const results = [];

  for (const t of rows) {
    const daysUntil = Number(t.days_until);
    const applicable = MARKS.filter((m) => m.d >= daysUntil); // marks reached
    if (!applicable.length) continue;                          // still >1 month out
    const current = applicable.reduce((a, b) => (a.d < b.d ? a : b)); // smallest reached mark
    const sent = Array.isArray(t.reminders_sent) ? t.reminders_sent : [];
    if (sent.includes(current.d) && !force) continue;          // this tickler already sent

    const recipients = new Set();
    if (t.assignee_user_id) recipients.add(t.assignee_user_id);
    if (current.d <= ESCALATE_AT) {
      (Array.isArray(t.escalate_to) ? t.escalate_to : []).forEach((u) => recipients.add(u));
      mgrs.forEach((u) => recipients.add(u));
    }
    if (!recipients.size) continue;

    const escalated = current.d <= ESCALATE_AT;
    const msg = `${escalated ? '⚠ ESCALATED — ' : '⏰ '}Promo reminder (${current.label} out): "${t.title}" for "${t.event_title}" (${t.date_str}) is not done yet. Post it, then mark it complete in TeamHub.`;
    const r = await sendSmsToUsers(companyId, [...recipients], msg, t.assignee_user_id || null);
    // Mark current + all larger reached marks as sent so we don't backfire.
    const newSent = [...new Set([...sent, ...applicable.map((m) => m.d)])];
    await query(`UPDATE promo_tasks SET reminders_sent = $1 WHERE id = $2`, [JSON.stringify(newSent), t.id]);
    results.push({ task: t.title, mark: current.label, escalated, sent: r.sent, to: recipients.size });
  }
  return results;
}

let started = false;
export function startPromoReminderScheduler() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      const cs = (await query(`SELECT company_id FROM company_integrations WHERE twilio_account_sid IS NOT NULL`)).rows;
      for (const c of cs) await runPromoReminders(c.company_id).catch((e) => console.error('promoReminders', c.company_id, e.message));
    } catch (e) { console.error('promo reminder loop failed:', e.message); }
  };
  setTimeout(run, 150 * 1000);
  setInterval(run, 6 * 60 * 60 * 1000);
  console.log('Promo reminder scheduler started (every 6h).');
}

if (process.argv[1]?.endsWith('promoReminders.js')) {
  (async () => {
    console.log(JSON.stringify(await runPromoReminders(process.argv[2], { force: process.argv[3] === 'force' }), null, 1));
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
