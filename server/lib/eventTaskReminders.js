/**
 * Event task reminders — for any checklist item that has a reminder_date and an
 * assignee and is NOT done, text the assignee once a day (from reminder_date
 * onward) until they check it off. Stops when done, or 7 days past its due_date
 * so a forgotten item doesn't nag forever. One text per task per day, guarded by
 * event_tasks.last_reminded_on. Runs every 6h (the daily guard makes it idempotent).
 *   Manual: DB_HOST=localhost node lib/eventTaskReminders.js <companyId>
 */
import { query } from '../db.js';
import { sendSmsToUsers } from './smsHelper.js';

const TZ = 'America/Denver';
const BASE = process.env.APP_BASE_URL || 'https://team.kindredvineyards.com';

export async function runEventTaskReminders(companyId) {
  const due = (await query(
    `SELECT t.id, t.title, t.assignee_user_id, e.id AS event_id, e.title AS event_title,
            to_char(t.due_date, 'FMMon FMDD') AS due_str
       FROM event_tasks t
       JOIN events e ON e.id = t.event_id
      WHERE t.company_id = $1
        AND t.done = false
        AND t.assignee_user_id IS NOT NULL
        AND t.reminder_date IS NOT NULL
        AND t.reminder_date <= (NOW() AT TIME ZONE $2)::date
        AND (t.last_reminded_on IS NULL OR t.last_reminded_on < (NOW() AT TIME ZONE $2)::date)
        AND (t.due_date IS NULL OR (NOW() AT TIME ZONE $2)::date <= t.due_date + 7)`,
    [companyId, TZ])).rows;
  if (!due.length) return [];

  const results = [];
  for (const t of due) {
    const dueBit = t.due_str ? ` (due ${t.due_str})` : '';
    const msg = `⏰ Kindred: "${t.title}"${dueBit} for "${t.event_title}" is still open. Check it off when done: ${BASE}/events?open=${t.event_id}`;
    const r = await sendSmsToUsers(companyId, [t.assignee_user_id], msg, null);
    await query(`UPDATE event_tasks SET last_reminded_on = (NOW() AT TIME ZONE $2)::date WHERE id = $1`, [t.id, TZ]);
    results.push({ task: t.title, event: t.event_title, sent: r.sent });
  }
  return results;
}

let started = false;
export function startEventTaskReminderScheduler() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      const cs = (await query(`SELECT company_id FROM company_integrations WHERE twilio_account_sid IS NOT NULL`)).rows;
      for (const c of cs) await runEventTaskReminders(c.company_id).catch((e) => console.error('eventTaskReminders', c.company_id, e.message));
    } catch (e) { console.error('event task reminder loop failed:', e.message); }
  };
  setTimeout(run, 240 * 1000);
  setInterval(run, 6 * 60 * 60 * 1000);
  console.log('Event task-reminder scheduler started (every 6h; one text/task/day).');
}

if (process.argv[1]?.endsWith('eventTaskReminders.js')) {
  (async () => { console.log(JSON.stringify(await runEventTaskReminders(process.argv[2]), null, 1)); process.exit(0); })().catch((e) => { console.error(e); process.exit(1); });
}
