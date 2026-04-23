import express from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';

const router = express.Router();

const QBO_AUTH_ENDPOINT = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_SCOPES = [
  'com.intuit.quickbooks.accounting',
  'com.intuit.quickbooks.payment',
  'project-management.project',
  'payroll.compensation.read',
].join(' ');

function getCallbackUri() {
  return process.env.QBO_REDIRECT_URI || 'https://team.kindredvineyards.com/api/integrations/qbo/callback';
}

function getSettingsUrl() {
  return `${process.env.APP_BASE_URL || 'https://team.kindredvineyards.com'}/settings`;
}

// GET /api/integrations/qbo/connect-url  — generate Intuit auth URL (owner only)
router.get('/connect-url', requireAuth, requireOwner, async (req, res) => {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(503).json({ error: 'QuickBooks is not configured on this server. Set QBO_CLIENT_ID and QBO_CLIENT_SECRET.' });
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const state = `${req.companyId}:${nonce}`;

  await query(
    `INSERT INTO company_integrations (company_id, qbo_pending_state, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (company_id) DO UPDATE SET qbo_pending_state = $2, updated_at = NOW()`,
    [req.companyId, state]
  );

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getCallbackUri(),
    response_type: 'code',
    scope: QBO_SCOPES,
    state,
  });

  res.json({ url: `${QBO_AUTH_ENDPOINT}?${params.toString()}` });
});

// GET /api/integrations/qbo/callback  — Intuit redirects here after authorization (no auth)
router.get('/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query;
  const settingsUrl = getSettingsUrl();

  if (error) {
    return res.redirect(`${settingsUrl}?qbo_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return res.redirect(`${settingsUrl}?qbo_error=missing_code`);
  }

  // State format: "{companyId}:{nonce}"
  const colonIdx = state.indexOf(':');
  if (colonIdx < 0) {
    return res.redirect(`${settingsUrl}?qbo_error=invalid_state`);
  }
  const companyId = state.slice(0, colonIdx);

  try {
    const r = await query(
      `SELECT qbo_pending_state FROM company_integrations WHERE company_id = $1`,
      [companyId]
    );
    const row = r.rows[0];
    if (!row || row.qbo_pending_state !== state) {
      return res.redirect(`${settingsUrl}?qbo_error=state_mismatch`);
    }

    const clientId = process.env.QBO_CLIENT_ID;
    const clientSecret = process.env.QBO_CLIENT_SECRET;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const tokenRes = await fetch(QBO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: getCallbackUri(),
      }).toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('[qbo] token exchange failed:', err);
      return res.redirect(`${settingsUrl}?qbo_error=token_exchange_failed`);
    }

    const tokens = await tokenRes.json();
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);
    const env = process.env.QBO_ENVIRONMENT || 'production';

    await query(
      `UPDATE company_integrations
       SET qbo_access_token     = $2,
           qbo_refresh_token    = $3,
           qbo_token_expires_at = $4,
           qbo_realm_id         = $5,
           qbo_environment      = $6,
           qbo_pending_state    = NULL,
           updated_at           = NOW()
       WHERE company_id = $1`,
      [companyId, tokens.access_token, tokens.refresh_token, expiresAt, realmId || null, env]
    );

    res.redirect(`${settingsUrl}?qbo_connected=1`);
  } catch (err) {
    console.error('[qbo] callback error:', err);
    res.redirect(`${settingsUrl}?qbo_error=server_error`);
  }
});

// POST /api/integrations/qbo/disconnect  — clear QBO tokens (owner only)
router.post('/disconnect', requireAuth, requireOwner, async (req, res) => {
  try {
    await query(
      `UPDATE company_integrations
       SET qbo_access_token     = NULL,
           qbo_refresh_token    = NULL,
           qbo_token_expires_at = NULL,
           qbo_realm_id         = NULL,
           qbo_pending_state    = NULL,
           updated_at           = NOW()
       WHERE company_id = $1`,
      [req.companyId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as qboRouter };
