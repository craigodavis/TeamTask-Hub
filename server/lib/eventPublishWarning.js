/**
 * Event publish warning — when an event is within the warning window (default 7
 * days) and still NOT published (not on the calendar/website), text the designated
 * people (scheduling_settings.event_warn_user_ids; falls back to owners/managers)
 * with a link to the event. Fires once per event (events.publish_warned_at).
 * Runs every 3h.
 *   Manual: DB_HOST=localhost node lib/eventPublishWarning.js <companyId>
 */
import { query } from '../db.js';
import { sendSmsToUsers } from './smsHelper.js';

const TZ = 'America/Denver';
const BASE = process.env.APP_BASE_URL || 'https://team.kindredvineyards.com';

export async function runPublishWarnings(companyId) {
  const s = (await query(`SELECT event_warn_user_ids, event_warn_days FROM scheduling_settings WHERE company_id = $1`, [companyId])).rows[0];
  const days = s?.event_warn_days ?? 7;
  const events = (await query(
    `SELECT e.id, e.title,
            ((e.start_at AT TIME ZONE $2)::date - (NOW() AT TIME ZONE $2)::date) AS days_until,
            to_char(e.start_at AT TIME ZONE $2, 'FMMon FMDD') AS date_str
       FROM events e
      WHERE e.company_id = $1 AND e.status <> 'published' AND e.publish_warned_at IS NULL
        AND (e.start_at AT TIME ZONE $2)::date >= (NOW() AT TIME ZONE $2)::date
        AND (e.start_at AT TIME ZONE $2)::date <= (NOW() AT TIME ZONE $2)::date + $3::int`,
    [companyId, TZ, days])).rows;
  if (!events.length) return [];

  let recipients = Array.isArray(s?.event_warn_user_ids) ? s.event_warn_user_ids : [];
  if (!recipients.length) {
    recipients = (await query(`SELECT id FROM users WHERE company_id = $1 AND role IN ('owner','manager') AND phone IS NOT NULL`, [companyId])).rows.map((r) => r.id);
  }
  if (!recipients.length) return [];

  const results = [];
  for (const e of events) {
    const when = e.days_until <= 0 ? 'TODAY' : `${e.days_until} day(s) out`;
    const msg = `⚠ Kindred: "${e.title}" (${e.date_str}) is ${when} and still a DRAFT — not on the calendar yet. Publish it: ${BASE}/events?open=${e.id}`;
    const r = await sendSmsToUsers(companyId, recipients, msg, null);
    await query(`UPDATE events SET publish_warned_at = NOW() WHERE id = $1`, [e.id]);
    results.push({ event: e.title, days: e.days_until, sent: r.sent });
  }
  return results;
}

let started = false;
export function startPublishWarningScheduler() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      const cs = (await query(`SELECT company_id FROM company_integrations WHERE twilio_account_sid IS NOT NULL`)).rows;
      for (const c of cs) await runPublishWarnings(c.company_id).catch((e) => console.error('publishWarn', c.company_id, e.message));
    } catch (e) { console.error('publish warning loop failed:', e.message); }
  };
  setTimeout(run, 200 * 1000);
  setInterval(run, 3 * 60 * 60 * 1000);
  console.log('Event publish-warning scheduler started (every 3h).');
}

if (process.argv[1]?.endsWith('eventPublishWarning.js')) {
  (async () => { console.log(JSON.stringify(await runPublishWarnings(process.argv[2]), null, 1)); process.exit(0); })().catch((e) => { console.error(e); process.exit(1); });
}
