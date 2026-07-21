/**
 * Promotion email sender — sends scheduled promo emails to contacts when due,
 * rendering the chosen template's tags. Runs hourly. Also exposes sendOnePromoEmail
 * for a manual "send now".
 * Tags: {contact} {org} {event} {date} {time} {location} {description} {link} {image}
 *   Manual: DB_HOST=localhost node lib/promoEmailSender.js <companyId>
 */
import { query } from '../db.js';
import { sendMail } from '../mail.js';

const TZ = 'America/Denver';

function render(str, d) {
  return String(str || '')
    .replace(/\{contact\}/g, d.contact_name || '')
    .replace(/\{org\}/g, d.org || '')
    .replace(/\{event\}/g, d.event_title || '')
    .replace(/\{date\}/g, d.date_str || '')
    .replace(/\{time\}/g, d.time_str || '')
    .replace(/\{location\}/g, d.location_name || '')
    .replace(/\{description\}/g, d.description || '')
    .replace(/\{link\}/g, d.event_url || 'https://kindredvineyards.com/events/')
    .replace(/\{image\}/g, d.image_url ? `<img src="${d.image_url}" alt="" style="max-width:100%;border-radius:8px" />` : '');
}

async function loadEmail(id) {
  const r = await query(
    `SELECT pe.id, pe.company_id, pe.status,
            c.name AS contact_name, c.org, c.email AS contact_email,
            t.subject, t.body_html,
            e.title AS event_title, e.description, e.event_url, e.image_url,
            l.name AS location_name,
            to_char(e.start_at AT TIME ZONE $2, 'FMDay, FMMonth FMDD') AS date_str,
            to_char(e.start_at AT TIME ZONE $2, 'FMHH12:MI AM') AS time_str
       FROM promo_emails pe
       JOIN promo_contacts c ON c.id = pe.contact_id
       LEFT JOIN promo_templates t ON t.id = pe.template_id
       JOIN events e ON e.id = pe.event_id
       LEFT JOIN locations l ON l.id = e.location_id
      WHERE pe.id = $1`, [id, TZ]);
  return r.rows[0];
}

export async function sendOnePromoEmail(emailId) {
  const d = await loadEmail(emailId);
  if (!d) return { ok: false, error: 'not found' };
  if (!d.contact_email) { await query(`UPDATE promo_emails SET status='failed', error='contact has no email' WHERE id=$1`, [emailId]); return { ok: false, error: 'no email' }; }
  const subject = render(d.subject || `Event: {event}`, d) || d.event_title;
  const html = render(d.body_html || '<p>{event} on {date}. {link}</p>', d);
  try {
    await sendMail({ to: d.contact_email, subject, html }, d.company_id);
    await query(`UPDATE promo_emails SET status='sent', sent_at=NOW(), error=NULL WHERE id=$1`, [emailId]);
    return { ok: true };
  } catch (e) {
    await query(`UPDATE promo_emails SET status='failed', error=$2 WHERE id=$1`, [emailId, String(e.message).slice(0, 300)]);
    return { ok: false, error: e.message };
  }
}

export async function sendDuePromoEmails(companyId) {
  const due = (await query(
    `SELECT id FROM promo_emails WHERE company_id = $1 AND status = 'scheduled' AND send_at <= NOW()`, [companyId])).rows;
  const results = [];
  for (const row of due) results.push({ id: row.id, ...(await sendOnePromoEmail(row.id)) });
  return results;
}

let started = false;
export function startPromoEmailScheduler() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      const cs = (await query(`SELECT company_id FROM company_integrations WHERE mail_host IS NOT NULL AND mail_host <> ''`)).rows;
      for (const c of cs) await sendDuePromoEmails(c.company_id).catch((e) => console.error('promoEmail', c.company_id, e.message));
    } catch (e) { console.error('promo email loop failed:', e.message); }
  };
  setTimeout(run, 180 * 1000);
  setInterval(run, 60 * 60 * 1000);
  console.log('Promo email scheduler started (hourly).');
}

if (process.argv[1]?.endsWith('promoEmailSender.js')) {
  (async () => { console.log(JSON.stringify(await sendDuePromoEmails(process.argv[2]), null, 1)); process.exit(0); })().catch((e) => { console.error(e); process.exit(1); });
}
