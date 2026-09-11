/**
 * Eventbrite integration routes. Mirrors routes/googleBusiness.js.
 *
 * Mounted at /api/integrations/eventbrite WITHOUT global requireAuth so the
 * public OAuth callback works. Eventbrite tokens don't expire, so there is no
 * refresh path — the callback just stores the token.
 */
import express from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import {
  eventbriteConfigured,
  getAuthorizeUrl,
  exchangeCode,
  getMe,
  listOrganizations,
  postEventToEventbrite,
} from '../lib/eventbriteClient.js';

const router = express.Router();

function getCallbackUri() {
  return process.env.EVENTBRITE_REDIRECT_URI || 'https://team.kindredvineyards.com/api/integrations/eventbrite/callback';
}
function getSettingsUrl() {
  return `${process.env.APP_BASE_URL || 'https://team.kindredvineyards.com'}/settings`;
}

// GET /connect-url (owner)
router.get('/connect-url', requireAuth, requireOwner, async (req, res) => {
  if (!eventbriteConfigured()) {
    return res.status(503).json({ error: 'Eventbrite is not configured on this server. Set EVENTBRITE_CLIENT_ID and EVENTBRITE_CLIENT_SECRET.' });
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = `${req.companyId}:${nonce}`;
  await query(
    `INSERT INTO company_integrations (company_id, eventbrite_pending_state, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (company_id) DO UPDATE SET eventbrite_pending_state = $2, updated_at = NOW()`,
    [req.companyId, state]
  );
  res.json({ url: getAuthorizeUrl(getCallbackUri(), state) });
});

// GET /callback (public — Eventbrite redirects here)
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const settingsUrl = getSettingsUrl();
  if (error) return res.redirect(`${settingsUrl}?eventbrite_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${settingsUrl}?eventbrite_error=missing_code`);

  const colonIdx = String(state).indexOf(':');
  if (colonIdx < 0) return res.redirect(`${settingsUrl}?eventbrite_error=invalid_state`);
  const companyId = String(state).slice(0, colonIdx);

  try {
    const r = await query(`SELECT eventbrite_pending_state FROM company_integrations WHERE company_id = $1`, [companyId]);
    if (!r.rows[0] || r.rows[0].eventbrite_pending_state !== state) {
      return res.redirect(`${settingsUrl}?eventbrite_error=state_mismatch`);
    }

    const tokens = await exchangeCode(code, getCallbackUri());
    if (!tokens.access_token) return res.redirect(`${settingsUrl}?eventbrite_error=no_token`);

    const me = await getMe(tokens.access_token);
    const name = me?.name || me?.emails?.[0]?.email || null;

    await query(
      `UPDATE company_integrations
          SET eventbrite_token = $2, eventbrite_connected_name = $3,
              eventbrite_pending_state = NULL, updated_at = NOW()
        WHERE company_id = $1`,
      [companyId, tokens.access_token, name]
    );

    // Cache the org id so the first post doesn't have to resolve it.
    try {
      const orgs = await listOrganizations(companyId, tokens.access_token);
      if (orgs[0]?.id) {
        await query(`UPDATE company_integrations SET eventbrite_org_id = $2, updated_at = NOW() WHERE company_id = $1`, [companyId, orgs[0].id]);
      }
    } catch (e) {
      console.error('[eventbrite] org fetch failed:', e.message);
    }

    res.redirect(`${settingsUrl}?eventbrite_connected=1`);
  } catch (err) {
    console.error('[eventbrite] callback error:', err);
    res.redirect(`${settingsUrl}?eventbrite_error=server_error`);
  }
});

// GET /status (owner)
router.get('/status', requireAuth, requireOwner, async (req, res) => {
  try {
    const row = (await query(
      `SELECT eventbrite_connected_name, eventbrite_org_id,
              eventbrite_token IS NOT NULL AND eventbrite_token != '' AS connected
         FROM company_integrations WHERE company_id = $1`,
      [req.companyId]
    )).rows[0] || {};
    res.json({
      connected: !!row.connected,
      configured: eventbriteConfigured(),
      name: row.eventbrite_connected_name || null,
      org_id: row.eventbrite_org_id || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /disconnect (owner)
router.post('/disconnect', requireAuth, requireOwner, async (req, res) => {
  try {
    await query(
      `UPDATE company_integrations
          SET eventbrite_token = NULL, eventbrite_pending_state = NULL,
              eventbrite_connected_name = NULL, eventbrite_org_id = NULL, updated_at = NOW()
        WHERE company_id = $1`,
      [req.companyId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /events/:id/post (owner) — manually create+publish one event on Eventbrite
router.post('/events/:id/post', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await postEventToEventbrite(req.companyId, req.params.id, req.userId || null);
    res.json({ ok: true, ...r });
  } catch (err) {
    if (err.code && err.code !== 'not_found') return res.status(err.statusCode || 400).json({ error: err.message });
    console.error('[eventbrite] post event error:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export { router as eventbriteRouter };
