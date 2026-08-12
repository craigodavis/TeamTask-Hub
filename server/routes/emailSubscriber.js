/**
 * POST /api/email/subscriber — the email-list gateway ClubSteward writes to.
 *
 *   Header  X-Sync-Secret: <SYNC_SECRET>
 *   Body    { email, firstName, lastName, audience, commerce7CustomerId, change }
 *   Return  { ok, listmonkId, cmResult, ... }
 *
 * ClubSteward fans a new or changed club member out to every system it touches
 * (admin/server/lib/clubMemberSync.js) and calls this on add or name/email
 * change. TeamHub owns Listmonk and Campaign Monitor, so the audience → list
 * routing and both writes live here; the work itself is in lib/subscriberGateway.js.
 *
 * No user session — the caller is a server, not a person. It authenticates with
 * a shared secret, which is why this router is mounted without requireAuth and
 * why it must refuse everything when the secret is unset rather than falling
 * open.
 */

import express from 'express';
import crypto from 'node:crypto';
import { syncSubscriber, isKnownAudience, AUDIENCES } from '../lib/subscriberGateway.js';

export const emailSubscriberRouter = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Compare via digests: timingSafeEqual throws on a length mismatch, so feeding
 * it the raw values would answer "wrong length" through an exception before it
 * ever got to the constant-time part.
 */
function secretMatches(provided) {
  const expected = process.env.SYNC_SECRET || '';
  if (!expected) return false;
  const sha = (v) => crypto.createHash('sha256').update(String(v ?? '')).digest();
  return crypto.timingSafeEqual(sha(provided), sha(expected));
}

emailSubscriberRouter.post('/subscriber', async (req, res) => {
  // Fail closed. An unconfigured secret must never mean "let everyone in" on a
  // route that writes to the mailing lists.
  if (!process.env.SYNC_SECRET) {
    console.error('[email-gateway] refused: SYNC_SECRET is not set in the server environment');
    return res.status(503).json({ ok: false, error: 'SYNC_SECRET is not configured on this server' });
  }
  if (!secretMatches(req.get('X-Sync-Secret'))) {
    return res.status(401).json({ ok: false, error: 'bad or missing X-Sync-Secret' });
  }

  const { email, firstName, lastName, audience, commerce7CustomerId, change, previousEmail } = req.body || {};

  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ ok: false, error: 'email is required and must be an address' });
  }
  if (!isKnownAudience(audience)) {
    return res.status(400).json({
      ok: false,
      error: `unknown audience ${JSON.stringify(audience ?? null)}`,
      known: Object.keys(AUDIENCES),
    });
  }

  const result = await syncSubscriber({
    email, firstName, lastName, audience, commerce7CustomerId, change, previousEmail,
  });

  console.log(
    `[email-gateway] ${result.email} (${result.audience}, change=${result.change})`
    + ` → listmonk: ${result.listmonkResult}, campaign monitor: ${result.cmResult}`,
  );

  // A platform failure answers 5xx on purpose. ClubSteward records the HTTP
  // status in sync_log and nothing retries, so a 200 over a failed write would
  // leave a log saying the person was subscribed when they were not.
  res.status(result.ok ? 200 : 502).json(result);
});

export default emailSubscriberRouter;
