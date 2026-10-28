/**
 * The performer-facing endpoints. PUBLIC — no login, the token is the only
 * credential, so everything here is written defensively.
 *
 * Three rules this file keeps:
 *   - never reveal anything but the one musician the token names
 *   - never trust a field name from the request (lib/talentLinks whitelists)
 *   - never confirm whether a token merely never existed
 *
 * See docs/TALENT_SELF_SERVICE.md.
 */
import express from 'express';
import { query } from '../db.js';
import {
  resolveToken, markOpened, sanitize, validate, publicProfile, currentTerms, issueLink, LINK_TTL_HOURS,
} from '../lib/talentLinks.js';
import { sendSmsToPhone } from '../lib/smsHelper.js';
import { sendMail } from '../mail.js';

export const talentPublicRouter = express.Router();

const BASE = () => (process.env.APP_BASE_URL || 'https://team.kindredvineyards.com').replace(/\/$/, '');
export const linkUrl = (token) => `${BASE()}/t/${token}`;

// A bad token should cost an attacker time. Crude, in-process, and enough:
// this endpoint sees a few requests a week from real performers.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, since: now };
  if (now - rec.since > 15 * 60 * 1000) { rec.n = 0; rec.since = now; }
  rec.n += 1;
  attempts.set(ip, rec);
  return rec.n > 30;
}

// ── GET /api/talent-link/:token — the form's data ────────────────────────────
talentPublicRouter.get('/:token', async (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  try {
    const r = await resolveToken(req.params.token);
    if (!r.ok) return res.status(410).json({ error: r.reason }); // invalid | expired | used
    await markOpened(r.link.id);
    const [profile, terms] = await Promise.all([
      publicProfile(r.link.musician_id),
      currentTerms(r.link.m_company),
    ]);
    res.json({
      musician: profile,
      terms,
      expires_at: r.link.expires_at,
      // Already-pending work should not be silently replaced by a second submit.
      pending: (await query(
        `SELECT count(*)::int AS n FROM talent_submissions
          WHERE musician_id = $1 AND status = 'pending'`, [r.link.musician_id])).rows[0].n > 0,
    });
  } catch (e) { console.error('talent link get', e); res.status(500).json({ error: 'Something went wrong.' }); }
});

// ── POST /api/talent-link/:token — their submission ──────────────────────────
talentPublicRouter.post('/:token', async (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  try {
    const r = await resolveToken(req.params.token);
    if (!r.ok) return res.status(410).json({ error: r.reason });

    const payload = sanitize(req.body);
    const errs = validate(payload);
    if (errs.length) return res.status(400).json({ error: errs[0], errors: errs });
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'Nothing was filled in.' });

    const terms = await currentTerms(r.link.m_company);
    if (terms && !req.body?.accept_terms) {
      return res.status(400).json({ error: 'Please confirm you have read the terms.' });
    }

    const sub = (await query(
      `INSERT INTO talent_submissions (company_id, musician_id, link_id, payload, terms_version)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [r.link.m_company, r.link.musician_id, r.link.id, JSON.stringify(payload), terms?.version || null])).rows[0];

    if (terms) {
      await query(
        `INSERT INTO talent_terms_acceptances
           (company_id, musician_id, terms_version, channel, submission_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [r.link.m_company, r.link.musician_id, terms.version, r.link.channel, sub.id]);
    }

    // Burn the link. One submission per send; re-opening shows "already sent".
    await query(`UPDATE talent_update_links SET submitted_at = NOW() WHERE id = $1`, [r.link.id]);
    res.json({ ok: true, received: Object.keys(payload).length });
  } catch (e) { console.error('talent link post', e); res.status(500).json({ error: 'Something went wrong.' }); }
});

// ── POST /api/talent-link/resend — "text me a new link" ──────────────────────
// A 24-hour link that lapses must not need a human to restart. The contact
// given is only ever matched against what we already hold, and the response is
// identical either way so this cannot be used to test whether we know someone.
talentPublicRouter.post('/', async (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  const contact = String(req.body?.contact || '').trim();
  const same = { ok: true, message: 'If that matches a performer we have on file, a new link is on its way.' };
  if (!contact) return res.json(same);
  try {
    const digits = contact.replace(/\D/g, '');
    const m = (await query(
      `SELECT id, company_id, name, phone, email FROM musicians
        WHERE deleted_at IS NULL
          AND ( lower(email) = lower($1)
                OR (length($2) >= 10 AND regexp_replace(coalesce(phone,''), '\\D', '', 'g') = $2) )
        LIMIT 1`, [contact, digits])).rows[0];
    if (!m) return res.json(same);

    const byEmail = !!m.email && m.email.toLowerCase() === contact.toLowerCase();
    const { token } = await issueLink(m.company_id, m.id, {
      channel: byEmail ? 'email' : 'sms', sentTo: byEmail ? m.email : m.phone,
    });
    await deliver(m, token, byEmail ? 'email' : 'sms').catch((e) => console.error('resend deliver', e.message));
    res.json(same);
  } catch (e) { console.error('talent resend', e); res.json(same); }
});

/** Send the link. The expiry is stated, because an unexplained dead link reads as broken. */
export async function deliver(musician, token, channel) {
  const url = linkUrl(token);
  if (channel === 'sms') {
    return sendSmsToPhone(musician.company_id, musician.phone,
      `Kindred Vineyards: please update your performer details here — ${url}\n\nThis link expires in ${LINK_TTL_HOURS} hours.`);
  }
  return sendMail({
    to: musician.email,
    subject: 'Your Kindred Vineyards performer details',
    text: `Hi ${musician.name},\n\nPlease take a moment to fill in your details for the website and our records:\n\n${url}\n\nThis link expires in ${LINK_TTL_HOURS} hours. The page shows what we provide and what we ask of you.\n\nWe never ask for bank details or your tax ID by email — those we take over the phone.\n\n— Kindred Vineyards`,
    html: `<p>Hi ${musician.name},</p>
<p>Please take a moment to fill in your details for the website and our records:</p>
<p><a href="${url}">Update my details</a></p>
<p>This link expires in <strong>${LINK_TTL_HOURS} hours</strong>. The page shows what we provide and what we ask of you.</p>
<p>We never ask for bank details or your tax ID by email — those we take over the phone.</p>
<p>— Kindred Vineyards</p>`,
  }, musician.company_id);
}
