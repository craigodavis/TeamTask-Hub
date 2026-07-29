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

const router = express.Router();

const COOKIE_DOMAIN = process.env.PWA_COOKIE_DOMAIN || '.kindredvineyards.com';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;   // 30 days, matching ClubSteward

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Digits only, so "(208) 555-0142" and "2085550142" are the same person. */
const normalizePhone = (p) => String(p || '').replace(/\D/g, '');

async function integration() {
  const r = await query(
    `SELECT company_id, c7_api_key, c7_tenant_slug, c7_api_base_url
       FROM company_integrations WHERE c7_api_key IS NOT NULL AND c7_api_key <> '' LIMIT 1`);
  if (!r.rows.length) throw new Error('Commerce7 is not configured');
  return r.rows[0];
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
    const integ = await integration();
    const companyId = integ.company_id;
    const c7 = makeC7Client(integ);

    // ── Match an existing Commerce7 customer before creating one ─────────────
    // Someone who has bought wine or booked a table before is already in C7.
    // Creating a duplicate would split their history and, worse, hide an
    // existing club membership from them.
    let customer = null;
    try {
      const found = await c7.get(`/customer?q=${encodeURIComponent(email)}&limit=5`);
      customer = (found.customers || []).find((c) =>
        (c.emails || []).some((e) => String(e.email).toLowerCase() === email)) || null;
    } catch { /* search is best-effort; fall through to create */ }

    if (!customer) {
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
    res.status(500).json({ error: err.message });
  }
});

export { router as kindredSignupRouter };
