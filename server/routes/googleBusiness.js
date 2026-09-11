/**
 * Google Business Profile (GBP) integration routes.
 *
 * Auto-posts Kindred events to the Google Business Profile of the matching venue
 * as "What's new / Event" local posts. Mirrors routes/qbo.js: an owner runs the
 * one-time OAuth connect, then per-venue location mapping decides which profile
 * each event is pushed to.
 *
 * Mounted at /api/integrations/gbp WITHOUT global requireAuth so the public
 * OAuth callback (Google redirects the browser here with no session) works.
 */
import express from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import {
  GBP_SCOPES,
  exchangeCode,
  getUserEmail,
  listAccounts,
  listLocations,
  postEventToGoogleBusiness,
} from '../lib/googleBusinessClient.js';

const router = express.Router();

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

function getCallbackUri() {
  return process.env.GBP_REDIRECT_URI || 'https://team.kindredvineyards.com/api/integrations/gbp/callback';
}
function getSettingsUrl() {
  return `${process.env.APP_BASE_URL || 'https://team.kindredvineyards.com'}/settings`;
}

// The v4 localPosts endpoint needs "accounts/{acct}/locations/{loc}". The
// Business Information API returns location.name as "locations/{loc}", so we
// stitch the two together and store the full v4 resource in gbp_locations.
function v4Resource(accountName, location) {
  const locName = location.name || '';
  if (locName.startsWith('accounts/')) return locName;
  return `${accountName}/${locName}`;
}

// ── Connect ────────────────────────────────────────────────────────────────
// GET /api/integrations/gbp/connect-url  (owner only)
router.get('/connect-url', requireAuth, requireOwner, async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Google Business Profile is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' });
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = `${req.companyId}:${nonce}`;
  await query(
    `INSERT INTO company_integrations (company_id, gbp_pending_state, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (company_id) DO UPDATE SET gbp_pending_state = $2, updated_at = NOW()`,
    [req.companyId, state]
  );
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: getCallbackUri(),
    response_type: 'code',
    scope: GBP_SCOPES,
    access_type: 'offline',
    prompt: 'consent',           // force a refresh_token every time
    include_granted_scopes: 'true',
    state,
  });
  res.json({ url: `${AUTH_ENDPOINT}?${params.toString()}` });
});

// GET /api/integrations/gbp/callback  (public — Google redirects here)
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const settingsUrl = getSettingsUrl();
  if (error) return res.redirect(`${settingsUrl}?gbp_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${settingsUrl}?gbp_error=missing_code`);

  const colonIdx = String(state).indexOf(':');
  if (colonIdx < 0) return res.redirect(`${settingsUrl}?gbp_error=invalid_state`);
  const companyId = String(state).slice(0, colonIdx);

  try {
    const r = await query(`SELECT gbp_pending_state FROM company_integrations WHERE company_id = $1`, [companyId]);
    if (!r.rows[0] || r.rows[0].gbp_pending_state !== state) {
      return res.redirect(`${settingsUrl}?gbp_error=state_mismatch`);
    }

    const tokens = await exchangeCode(code, getCallbackUri());
    if (!tokens.refresh_token) {
      // Happens if the user previously consented and Google withheld a new
      // refresh token. prompt=consent should prevent this; surface it if not.
      return res.redirect(`${settingsUrl}?gbp_error=no_refresh_token`);
    }
    const email = await getUserEmail(tokens.access_token);
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

    await query(
      `UPDATE company_integrations
          SET gbp_refresh_token    = $2,
              gbp_access_token     = $3,
              gbp_token_expires_at = $4,
              gbp_connected_email  = $5,
              gbp_pending_state    = NULL,
              updated_at           = NOW()
        WHERE company_id = $1`,
      [companyId, tokens.refresh_token, tokens.access_token, expiresAt, email]
    );

    // Best-effort: pick the account and auto-map locations to venues by name.
    try {
      const accounts = await listAccounts(companyId);
      if (accounts.length) {
        const account = accounts[0];
        await query(
          `UPDATE company_integrations SET gbp_account_name = $2, updated_at = NOW() WHERE company_id = $1`,
          [companyId, account.name]
        );
        const locations = await listLocations(companyId, account.name);
        await autoMapLocations(companyId, account.name, locations);
      }
    } catch (e) {
      console.error('[gbp] post-connect account/location fetch failed:', e.message);
      // Non-fatal — the owner can still map locations from Settings.
    }

    res.redirect(`${settingsUrl}?gbp_connected=1`);
  } catch (err) {
    console.error('[gbp] callback error:', err);
    res.redirect(`${settingsUrl}?gbp_error=server_error`);
  }
});

// Auto-map TeamHub venues to Google locations by fuzzy name match, writing the
// resolved resource to venue_details.gbp_location. Only fills blanks — never
// overwrites a mapping a person already set.
async function autoMapLocations(companyId, accountName, googleLocations) {
  const locs = (await query(`SELECT id, name FROM locations WHERE company_id = $1`, [companyId])).rows;
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const loc of locs) {
    const target = norm(loc.name);
    let best = null;
    for (const g of googleLocations) {
      const gname = norm(g.title);
      if (!gname) continue;
      if (gname === target || gname.includes(target) || target.includes(gname)) { best = g; break; }
    }
    if (!best) continue;
    await query(
      `INSERT INTO kindred_web.venue_details (location_id, gbp_location, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (location_id) DO UPDATE
         SET gbp_location = COALESCE(NULLIF(kindred_web.venue_details.gbp_location, ''), EXCLUDED.gbp_location),
             updated_at = NOW()`,
      [loc.id, v4Resource(accountName, best)]
    );
  }
}

// ── Status / disconnect ──────────────────────────────────────────────────────
// GET /api/integrations/gbp/status  (owner only)
router.get('/status', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT gbp_connected_email, gbp_account_name, gbp_token_expires_at,
              gbp_refresh_token IS NOT NULL AND gbp_refresh_token != '' AS connected
         FROM company_integrations WHERE company_id = $1`,
      [req.companyId]
    );
    const row = r.rows[0] || {};
    const mapped = parseInt((await query(
      `SELECT COUNT(*) AS n FROM kindred_web.venue_details vd
         JOIN locations l ON l.id = vd.location_id
        WHERE l.company_id = $1 AND vd.gbp_location IS NOT NULL AND vd.gbp_location != ''`,
      [req.companyId]
    )).rows[0]?.n || 0, 10);
    res.json({
      connected: !!row.connected,
      configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      email: row.gbp_connected_email || null,
      account_name: row.gbp_account_name || null,
      mapped_locations: mapped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/integrations/gbp/disconnect  (owner only)
router.post('/disconnect', requireAuth, requireOwner, async (req, res) => {
  try {
    // Clears the company-level OAuth connection only. The per-venue
    // gbp_location mapping on venue_details is left intact so reconnecting the
    // same Google account doesn't lose it.
    await query(
      `UPDATE company_integrations
          SET gbp_refresh_token = NULL, gbp_access_token = NULL,
              gbp_token_expires_at = NULL, gbp_pending_state = NULL,
              gbp_connected_email = NULL, gbp_account_name = NULL,
              updated_at = NOW()
        WHERE company_id = $1`,
      [req.companyId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Location mapping ─────────────────────────────────────────────────────────
// GET /api/integrations/gbp/locations  (owner only)
// Returns TeamHub venues, the Google locations available, and current mapping.
router.get('/locations', requireAuth, requireOwner, async (req, res) => {
  try {
    const cfg = (await query(
      `SELECT gbp_account_name FROM company_integrations WHERE company_id = $1`,
      [req.companyId]
    )).rows[0] || {};
    // Venues plus their current gbp_location push target from venue_details.
    const venues = (await query(
      `SELECT l.id, l.name, vd.gbp_location
         FROM locations l
         LEFT JOIN kindred_web.venue_details vd ON vd.location_id = l.id
        WHERE l.company_id = $1 ORDER BY l.name`, [req.companyId]
    )).rows;
    const mapping = {};
    for (const v of venues) if (v.gbp_location) mapping[v.id] = { resource: v.gbp_location };

    let google = [];
    if (cfg.gbp_account_name) {
      const gl = await listLocations(req.companyId, cfg.gbp_account_name);
      google = gl.map((g) => ({ resource: v4Resource(cfg.gbp_account_name, g), title: g.title }));
    }
    // Fill in titles for resources already mapped (so the current selection shows a name).
    for (const v of venues) {
      if (v.gbp_location && !google.some((g) => g.resource === v.gbp_location)) {
        google.push({ resource: v.gbp_location, title: v.gbp_location });
      }
    }
    res.json({ venues: venues.map((v) => ({ id: v.id, name: v.name })), google, mapping });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// PUT /api/integrations/gbp/locations  (owner only) — save venue→location map.
// Writes each venue's target to venue_details.gbp_location (the canonical push
// target, shared with the hours push). Body: { mapping: { <locationId>: { resource } | resource | "" } }
router.put('/locations', requireAuth, requireOwner, async (req, res) => {
  try {
    const mapping = req.body?.mapping;
    if (!mapping || typeof mapping !== 'object') {
      return res.status(400).json({ error: 'mapping object required' });
    }
    // Only touch venues that belong to this company.
    const venueIds = new Set((await query(
      `SELECT id FROM locations WHERE company_id = $1`, [req.companyId]
    )).rows.map((r) => r.id));

    for (const [locationId, val] of Object.entries(mapping)) {
      if (!venueIds.has(locationId)) continue;
      const resource = (typeof val === 'string' ? val : val?.resource) || null;
      await query(
        `INSERT INTO kindred_web.venue_details (location_id, gbp_location, updated_by, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (location_id) DO UPDATE
           SET gbp_location = EXCLUDED.gbp_location, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [locationId, resource, req.userId || null]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Posting ──────────────────────────────────────────────────────────────────
// POST /api/integrations/gbp/events/:id/post  — push one event to Google (owner)
router.post('/events/:id/post', requireAuth, requireOwner, async (req, res) => {
  try {
    const result = await postEventToGoogleBusiness(req.companyId, req.params.id, req.userId || null);
    res.json({ ok: true, name: result.name, searchUrl: result.searchUrl });
  } catch (err) {
    if (err.code && err.code !== 'not_found') {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }
    console.error('[gbp] post event error:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// GET /api/integrations/gbp/events/:id/post  — posting status for an event
router.get('/events/:id/post', requireAuth, requireOwner, async (req, res) => {
  try {
    const rows = (await query(
      `SELECT location_resource, local_post_name, state, search_url, error, updated_at
         FROM gbp_event_posts WHERE company_id = $1 AND event_id = $2`,
      [req.companyId, req.params.id]
    )).rows;
    res.json({ posts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as googleBusinessRouter };
