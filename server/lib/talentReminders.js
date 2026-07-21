/**
 * Talent event reminders — texts the talent 1 month / 1 week / 1 day before their
 * event, using the company's editable templates. Runs every 6h; each mark is sent
 * once per event (tracked on events.reminder_*_sent_at). Gated by
 * scheduling_settings.talent_reminders_enabled (off by default).
 *   Manual: DB_HOST=localhost node lib/talentReminders.js <companyId> [force]
 */
import { query } from '../db.js';
import { sendSmsToPhone } from './smsHelper.js';

const MARKS = [
  { key: 'month', col: 'reminder_month_sent_at', interval: '1 month', tpl: 'reminder_msg_month' },
  { key: 'week', col: 'reminder_week_sent_at', interval: '7 days', tpl: 'reminder_msg_week' },
  { key: 'day', col: 'reminder_day_sent_at', interval: '1 day', tpl: 'reminder_msg_day' },
];
const DEFAULTS = {
  reminder_msg_month: 'Hi {talent}! You are booked for {event} at {location} on {date} at {time}.',
  reminder_msg_week: 'Hi {talent} — one week out! {event} at {location} on {date} at {time}.',
  reminder_msg_day: 'Hi {talent}, reminder: you are playing {event} at {location} tomorrow, {date} at {time}.',
};

function render(tpl, ev) {
  return String(tpl || '')
    .replace(/\{talent\}/g, ev.talent_name || '')
    .replace(/\{event\}/g, ev.title || '')
    .replace(/\{date\}/g, ev.date_str || '')
    .replace(/\{time\}/g, ev.time_str || '')
    .replace(/\{location\}/g, ev.location_name || '');
}

export async function runTalentReminders(companyId, { force = false } = {}) {
  const s = (await query(
    `SELECT talent_reminders_enabled, reminder_msg_month, reminder_msg_week, reminder_msg_day
       FROM scheduling_settings WHERE company_id = $1`, [companyId])).rows[0];
  if (!s) return [];
  if (!s.talent_reminders_enabled && !force) return [{ skipped: 'talent reminders disabled' }];
  const results = [];
  for (const mk of MARKS) {
    const evs = (await query(
      `SELECT e.id, e.title, m.name AS talent_name, m.phone, l.name AS location_name,
              to_char(e.start_at AT TIME ZONE 'America/Denver','FMMon FMDD') AS date_str,
              to_char(e.start_at AT TIME ZONE 'America/Denver','FMHH12:MI AM') AS time_str
         FROM events e
         JOIN musicians m ON m.id = e.musician_id
         LEFT JOIN locations l ON l.id = e.location_id
        WHERE e.company_id = $1 AND m.phone IS NOT NULL AND e.${mk.col} IS NULL
          AND (e.start_at AT TIME ZONE 'America/Denver')::date = ((NOW() AT TIME ZONE 'America/Denver')::date + $2::interval)::date`,
      [companyId, mk.interval])).rows;
    for (const ev of evs) {
      const msg = render(s[mk.tpl] || DEFAULTS[mk.tpl], ev);
      const r = await sendSmsToPhone(companyId, ev.phone, msg);
      if (r.ok) await query(`UPDATE events SET ${mk.col} = NOW() WHERE id = $1`, [ev.id]);
      results.push({ mark: mk.key, event: ev.title, talent: ev.talent_name, ...r });
    }
  }
  return results;
}

let started = false;
export function startTalentReminderScheduler() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      const cs = (await query(`SELECT company_id FROM company_integrations WHERE twilio_account_sid IS NOT NULL`)).rows;
      for (const c of cs) await runTalentReminders(c.company_id).catch((e) => console.error('talentReminders', c.company_id, e.message));
    } catch (e) { console.error('talent reminder loop failed:', e.message); }
  };
  setTimeout(run, 120 * 1000);
  setInterval(run, 6 * 60 * 60 * 1000);
  console.log('Talent reminder scheduler started (every 6h).');
}

if (process.argv[1]?.endsWith('talentReminders.js')) {
  (async () => {
    console.log(JSON.stringify(await runTalentReminders(process.argv[2], { force: process.argv[3] === 'force' }), null, 1));
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
