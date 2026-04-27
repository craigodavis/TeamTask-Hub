import express from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { qboQueryAll } from '../qboClient.js';

const router = express.Router();

const QBO_AUTH_ENDPOINT = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_SCOPES = 'com.intuit.quickbooks.accounting';

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

// GET /api/integrations/qbo/status  — connection + sync status (owner only)
router.get('/status', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT qbo_realm_id, qbo_environment, qbo_token_expires_at,
              qbo_access_token IS NOT NULL AND qbo_access_token != '' AS connected
       FROM company_integrations WHERE company_id = $1`,
      [req.companyId]
    );
    const row = r.rows[0] || {};

    const counts = await query(
      `SELECT
         (SELECT COUNT(*) FROM qbo_accounts WHERE company_id = $1) AS accounts,
         (SELECT COUNT(*) FROM qbo_classes  WHERE company_id = $1) AS classes,
         (SELECT MAX(synced_at) FROM qbo_accounts WHERE company_id = $1) AS last_synced`,
      [req.companyId]
    );
    const c = counts.rows[0] || {};

    res.json({
      connected: !!row.connected,
      realm_id: row.qbo_realm_id || null,
      environment: row.qbo_environment || 'production',
      token_expires_at: row.qbo_token_expires_at || null,
      accounts: parseInt(c.accounts || 0, 10),
      classes: parseInt(c.classes || 0, 10),
      last_synced: c.last_synced || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/integrations/qbo/sync  — sync accounts + classes from QBO (owner only)
router.post('/sync', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  try {
    // -- Accounts --
    const accounts = await qboQueryAll(cId, 'SELECT * FROM Account');
    for (const a of accounts) {
      await query(
        `INSERT INTO qbo_accounts (company_id, qbo_id, name, fully_qualified_name, account_type, account_sub_type, classification, active, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (company_id, qbo_id) DO UPDATE SET
           name = $3, fully_qualified_name = $4, account_type = $5,
           account_sub_type = $6, classification = $7, active = $8, synced_at = NOW()`,
        [cId, a.Id, a.Name, a.FullyQualifiedName || a.Name, a.AccountType, a.AccountSubType || null, a.Classification || null, a.Active !== false]
      );
    }

    // -- Classes --
    const classes = await qboQueryAll(cId, 'SELECT * FROM Class');
    for (const c of classes) {
      await query(
        `INSERT INTO qbo_classes (company_id, qbo_id, name, fully_qualified_name, parent_id, active, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (company_id, qbo_id) DO UPDATE SET
           name = $3, fully_qualified_name = $4, parent_id = $5, active = $6, synced_at = NOW()`,
        [cId, c.Id, c.Name, c.FullyQualifiedName || c.Name, c.ParentRef?.value || null, c.Active !== false]
      );
    }

    res.json({
      ok: true,
      accounts: accounts.length,
      classes: classes.length,
      synced_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[qbo] sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/integrations/qbo/reference  — accounts + classes for dropdowns
router.get('/reference', requireAuth, async (req, res) => {
  try {
    const [a, c] = await Promise.all([
      query(`SELECT qbo_id, name, fully_qualified_name, account_type, account_sub_type, classification, active FROM qbo_accounts WHERE company_id = $1 ORDER BY classification, account_type, fully_qualified_name`, [req.companyId]),
      query(`SELECT qbo_id, name, fully_qualified_name, active FROM qbo_classes WHERE company_id = $1 ORDER BY fully_qualified_name`, [req.companyId]),
    ]);
    res.json({ accounts: a.rows, classes: c.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as qboRouter };
