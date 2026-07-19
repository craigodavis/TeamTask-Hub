/**
 * Post-shift feedback sender — runs every ~15 min and texts the survey:
 *  - Clocked-in staff: once their shift is done (all today's Square shifts CLOSED,
 *    none OPEN), carrying that shift's location. Gated by feedback_prompt_enabled.
 *  - "Always-on" users (feedback_always, e.g. owners who don't clock out): once after
 *    feedback_send_hour on any day a location operated. Sent regardless of the toggle,
 *    with the location left blank so they pick Creek/Winery on the form.
 * One survey per user per day (day_feedback UNIQUE + ON CONFLICT DO NOTHING).
 *
 * Manual test:  DB_HOST=localhost node lib/feedbackSender.js <companyId> [force]
 */
import { query } from '../db.js';
import { sendSmsToUsers } from './smsHelper.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = 'America/Denver';
const BASE = process.env.APP_BASE_URL || 'https://team.kindredvineyards.com';

function nowInTz() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour === '24' ? '0' : p.hour) };
}
async function ensureSettings(companyId) {
  await query(`INSERT INTO scheduling_settings (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING`, [companyId]);
  return (await query(`SELECT * FROM scheduling_settings WHERE company_id = $1`, [companyId])).rows[0];
}

async function createAndSend(companyId, userId, locationId, workDate, locationName) {
  // Idempotent per (company, date, user); RETURNING is empty when a row already exists.
  const r = await query(
    `INSERT INTO day_feedback (company_id, user_id, location_id, work_date, sent_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (company_id, work_date, user_id) DO NOTHING
     RETURNING token`, [companyId, userId, locationId, workDate]);
  if (!r.rows.length) return { skipped: 'already sent today' };
  const link = `${BASE}/feedback/${r.rows[0].token}`;
  const where = locationName ? ` at ${locationName}` : '';
  const msg = `Kindred: how did today's shift go${where}? 10-sec check-in — 🙂 😐 ☹️ + staffing + emphasis: ${link} (enter your PIN)`;
  const res = await sendSmsToUsers(companyId, [userId], msg, userId);
  return { sent: res.sent, failed: res.failed };
}

export async function runFeedbackSend(companyId, { force = false } = {}) {
  const settings = await ensureSettings(companyId);
  const { date: today, hour } = nowInTz();
  const sendHour = settings.feedback_send_hour ?? 20;
  const enabled = !!settings.feedback_prompt_enabled;
  const locs = (await query(`SELECT id, name, square_location_id FROM locations WHERE company_id = $1`, [companyId])).rows;
  const sidToLoc = Object.fromEntries(locs.map((l) => [l.square_location_id, l]));
  const results = [];

  // Locations that operated today (had at least one shift)
  const operated = new Set((await query(
    `SELECT DISTINCT location_id FROM team_square.shift WHERE (start_at AT TIME ZONE $1)::date = $2`,
    [TZ, today])).rows.map((r) => r.location_id));

  // ── Clocked-in staff (only when the toggle is on) ──
  if (enabled) {
    const shifts = (await query(
      `SELECT team_member_id, location_id, status, end_at FROM team_square.shift
        WHERE (start_at AT TIME ZONE $1)::date = $2`, [TZ, today])).rows;
    const byTm = {};
    for (const s of shifts) (byTm[s.team_member_id] ??= []).push(s);
    for (const [tm, ss] of Object.entries(byTm)) {
      if (ss.some((s) => s.status === 'OPEN' || !s.end_at)) continue; // still on the clock
      const u = (await query(`SELECT id FROM users WHERE company_id = $1 AND square_team_member_id = $2 AND feedback_always = false`, [companyId, tm])).rows[0];
      if (!u) continue;
      const loc = sidToLoc[ss[ss.length - 1].location_id];
      results.push({ type: 'clockout', tm, ...(await createAndSend(companyId, u.id, loc?.id || null, today, loc?.name || null)) });
    }
  }

  // ── Always-on users (owners/floaters) — regardless of toggle, after send hour ──
  if ((force || hour >= sendHour) && (force || operated.size > 0)) {
    const always = (await query(
      `SELECT id, display_name FROM users WHERE company_id = $1 AND feedback_always = true AND phone IS NOT NULL`, [companyId])).rows;
    for (const u of always) {
      results.push({ type: 'always', user: u.display_name, ...(await createAndSend(companyId, u.id, null, today, null)) });
    }
  }
  return results;
}

let started = false;
export function startFeedbackScheduler() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      const companies = (await query(`SELECT company_id FROM company_integrations WHERE twilio_account_sid IS NOT NULL`)).rows;
      for (const c of companies) await runFeedbackSend(c.company_id).catch((e) => console.error('feedbackSend', c.company_id, e.message));
    } catch (e) { console.error('feedback scheduler loop failed:', e.message); }
  };
  setTimeout(run, 90 * 1000);
  setInterval(run, 15 * 60 * 1000);
  console.log('Feedback sender scheduler started (every 15 min).');
}

if (process.argv[1]?.endsWith('feedbackSender.js')) {
  (async () => {
    const companyId = process.argv[2];
    const force = process.argv[3] === 'force';
    console.log(JSON.stringify(await runFeedbackSend(companyId, { force }), null, 1));
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
