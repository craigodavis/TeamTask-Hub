/**
 * Kindred app — account creation WITHOUT a club membership.
 *
 *   POST /api/kindred-app/signup   { name, phone, email }
 *
 * Until now the only door into having an identity was buying a wine club
 * membership: Commerce7's signup creates the customer and the membership
 * together. That is exactly what opening the app to everyone was meant to end.
 *
 * This creates (or matches) a plain Commerce7 customer and a member_account, and
 * issues the same session ClubSteward's passkey flow issues — same table, same
 * cookie — so everything downstream (prefs, push subscribe, activity) treats a
 * non-member exactly like a member.
 */

import express from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { makeC7Client } from '../lib/commerce7Client.js';
import { companyForRequest } from '../lib/appOrigin.js';

const router = express.Router();

const COOKIE_DOMAIN = process.env.PWA_COOKIE_DOMAIN || '.kindredvineyards.com';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;   // 30 days, matching ClubSteward

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Digits only, so "(208) 555-0142" and "2085550142" are the same person. */
const normalizePhone = (p) => String(p || '').replace(/\D/g, '');

/**
 * The winery this signup belongs to, and its Commerce7 credentials if it has
 * any here.
 *
 * This used to be `LIMIT 1` — take whichever row has a key — which was fine
 * while there was exactly one winery and wrong the moment there was a second.
 * The company now comes from the origin the app is served from (see
 * lib/appOrigin.js): the origin decides which winery a NEW account belongs to,
 * and nothing else.
 *
 * Commerce7 credentials are optional. A winery configured in ClubSteward but
 * not here still gets accounts — the customer simply is not pre-created, and
 * the club signup creates it later (ClubSteward's flow already POSTs /customer
 * and handles the duplicate case). That is deliberate: it means a test tenant
 * needs no credentials copied into this database to be usable.
 */
async function integration(req) {
  const app = await companyForRequest(req);
  // No fallback: an unrecognised origin is refused rather than quietly
  // inheriting production's winery.
  if (!app) {
    const err = new Error('This app origin is not configured.');
    err.status = 403;
    throw err;
  }
  const r = await query(
    `SELECT company_id, c7_api_key, c7_tenant_slug, c7_api_base_url
       FROM company_integrations WHERE company_id = $1`, [app.companyId]);
  return r.rows[0] || { company_id: app.companyId, c7_api_key: null };
}

/** Issues the same opaque session ClubSteward does — one session store, not two. */
async function issueSession(res, accountId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO club_steward.member_sessions (token, account_id, expires_at)
     VALUES ($1, $2, NOW() + interval '30 days')`, [token, accountId]);
  // SameSite=None because the app is on friend. and this is team.; the parent
  // domain is what lets one cookie serve both.
  res.cookie('member_session', token, {
    httpOnly: true, secure: true, sameSite: 'none',
    domain: COOKIE_DOMAIN, maxAge: SESSION_TTL_MS, path: '/',
  });
}

// ── POST /signup ─────────────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const phone = normalizePhone(req.body?.phone);

  if (!name)                 return res.status(400).json({ error: 'Please tell us your name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email address does not look right.' });
  if (phone.length < 10)     return res.status(400).json({ error: 'Please give us a phone number we can reach you on.' });

  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(' ') || firstName;

  try {
    const integ = await integration(req);
    const companyId = integ.company_id;
    // A winery with no Commerce7 key here still gets accounts — see integration().
    const c7 = integ.c7_api_key ? makeC7Client(integ) : null;

    // ── Match an existing Commerce7 customer before creating one ─────────────
    // Someone who has bought wine or booked a table before is already in C7.
    // Creating a duplicate would split their history and, worse, hide an
    // existing club membership from them.
    let customer = null;
    try {
      if (!c7) throw new Error('no Commerce7 credentials for this winery');
      const found = await c7.get(`/customer?q=${encodeURIComponent(email)}&limit=5`);
      customer = (found.customers || []).find((c) =>
        (c.emails || []).some((e) => String(e.email).toLowerCase() === email)) || null;
    } catch { /* search is best-effort; fall through to create */ }

    if (!customer && c7) {
      try {
        customer = await c7.post('/customer', {
          firstName, lastName,
          emails: [{ email }],
          phones: phone ? [{ phone: `+1${phone}`.replace(/^\+1\+1/, '+1') }] : [],
          emailMarketingStatus: 'Subscribed',
        });
      } catch (err) {
        // A customer we cannot create in C7 is not a reason to refuse the
        // account — they can still get notifications and book a table. Record
        // the account locally and let the next sync reconcile.
        console.warn('[kindred-signup] C7 customer create failed:', err.message);
      }
    }

    // ── The app account ─────────────────────────────────────────────────────
    const acct = await query(
      `INSERT INTO club_steward.member_accounts (company_id, commerce7_customer_id, email, last_seen_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (company_id, email) DO UPDATE SET
         commerce7_customer_id = COALESCE(EXCLUDED.commerce7_customer_id, club_steward.member_accounts.commerce7_customer_id),
         last_seen_at = NOW()
       RETURNING id, commerce7_customer_id`,
      [companyId, customer?.id || null, email]);
    const account = acct.rows[0];

    await issueSession(res, account.id);

    // Is this person already in a club? Decides whether the app offers it.
    let isClubMember = false;
    if (account.commerce7_customer_id) {
      const m = await query(
        `SELECT 1 FROM commerce7.club_membership
          WHERE company_id = $1 AND customer_id = $2 AND status = 'Active' LIMIT 1`,
        [companyId, account.commerce7_customer_id]);
      isClubMember = m.rows.length > 0;
    }

    // The reason they signed up. UNIQUE (account_id, perk) means someone who
    // signs up twice with the same email doesn't earn a second one.
    await query(
      `INSERT INTO kindred_app_perks (company_id, account_id, perk)
       VALUES ($1, $2, 'free_tasting')
       ON CONFLICT (account_id, perk) DO NOTHING`,
      [companyId, account.id]
    ).catch((e) => console.warn('[kindred-signup] perk grant failed:', e.message));

    await query(
      `INSERT INTO app_activity (company_id, account_id, event_type, metadata)
       VALUES ($1, $2, 'account_created', $3)`,
      [companyId, account.id, JSON.stringify({ matchedExistingCustomer: !!customer })]
    ).catch(() => {});

    res.status(201).json({
      ok: true,
      accountId: account.id,
      isClubMember,
      // So the app knows whether to offer the club after a booking.
      offerClub: !isClubMember,
    });
  } catch (err) {
    // An unconfigured origin is a 403, not a 500 — it is a refusal, not a fault,
    // and the app needs to be able to tell those apart.
    res.status(err.status || 500).json({ error: err.message });
  }
});

export { router as kindredSignupRouter };
