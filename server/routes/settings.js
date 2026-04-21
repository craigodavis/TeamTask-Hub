import express from 'express';
import twilio from 'twilio';
import { query } from '../db.js';
import { requireOwner } from '../middleware/auth.js';
import { sendMail } from '../mail.js';

const router = express.Router();
const companyId = (req) => req.companyId;

/** Visible in the terminal where `node` / `npm run server` runs (not the browser). Never pass secrets/tokens. */
function logIntegration(test, message, meta) {
  const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[integrations:${test}] ${message}${suffix}`);
}

async function getCompanyIntegrations(cId) {
  const r = await query(
    `SELECT square_access_token, square_env, square_application_id FROM company_integrations WHERE company_id = $1`,
    [cId]
  );
  return r.rows[0] || null;
}

// POST test-square: verify Square token (owner only). Body may include square_access_token, square_env to test without saving.
router.post('/integrations/test-square', requireOwner, async (req, res) => {
  try {
    const cId = companyId(req);
    logIntegration('square', 'test started', { company_id: cId });
    const integrations = await getCompanyIntegrations(cId);
    const bodyToken = req.body?.square_access_token?.trim();
    const bodyEnv = req.body?.square_env;
    const token = bodyToken || (integrations?.square_access_token && integrations.square_access_token.trim()) || process.env.SQUARE_ACCESS_TOKEN;
    if (!token) {
      logIntegration('square', 'test skipped: no token (saved, body, or env)');
      return res.status(400).json({ error: 'Square not configured. Enter an access token and Save, or paste one and click Test.' });
    }
    const squareEnv = bodyEnv || integrations?.square_env || process.env.SQUARE_ENV || 'production';
    const squareBase = squareEnv === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
    const response = await fetch(
      `${squareBase}/v2/team-members/search`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Square-Version': '2024-01-18',
        },
        body: JSON.stringify({ query: { filter: { status: 'ACTIVE' } }, limit: 1 }),
      }
    );
    if (!response.ok) {
      const err = await response.text();
      logIntegration('square', 'test failed', { http_status: response.status, details_preview: err.slice(0, 120) });
      return res.status(response.status).json({ error: 'Square API error', details: err });
    }
    const data = await response.json();
    const count = data.team_members?.length ?? 0;
    const cursor = data.cursor;
    logIntegration('square', 'test ok', { env: squareEnv, team_members_sample: count, has_cursor: !!cursor });
    res.json({ ok: true, message: 'Connected to Square.', team_members_sample: count, cursor: !!cursor });
  } catch (err) {
    logIntegration('square', 'test error', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST test-twilio: verify Twilio credentials (owner only). Body may include twilio_account_sid, twilio_auth_token to test without saving.
router.post('/integrations/test-twilio', requireOwner, async (req, res) => {
  try {
    const cId = companyId(req);
    logIntegration('twilio', 'test started', { company_id: cId });
    const r = await query(
      `SELECT twilio_account_sid, twilio_auth_token FROM company_integrations WHERE company_id = $1`,
      [cId]
    );
    const saved = r.rows[0];
    const bodySid = req.body?.twilio_account_sid?.trim();
    const bodyToken = req.body?.twilio_auth_token?.trim();
    const sid = bodySid || (saved?.twilio_account_sid && saved.twilio_account_sid.trim());
    const token = bodyToken || (saved?.twilio_auth_token && saved.twilio_auth_token.trim());
    if (!sid || !token) {
      logIntegration('twilio', 'test skipped: missing sid or token');
      return res.status(400).json({
        error: 'Twilio not configured. Enter Account SID and Auth Token and Save, or paste them and click Test.',
      });
    }
    const client = twilio(sid, token);
    const account = await client.api.accounts(sid).fetch();
    logIntegration('twilio', 'test ok', {
      account_sid_suffix: sid.length >= 4 ? sid.slice(-4) : '****',
      friendly_name: account.friendlyName,
    });
    res.json({
      ok: true,
      message: 'Connected to Twilio.',
      friendly_name: account.friendlyName,
    });
  } catch (err) {
    logIntegration('twilio', 'test failed', { message: err.message });
    res.status(400).json({ error: err.message || 'Twilio API error' });
  }
});

// POST mail/test: send a test email using current DB config for the company (owner only).
router.post('/mail/test', requireOwner, async (req, res) => {
  try {
    const cId = companyId(req);
    const r = await query(`SELECT email FROM users WHERE id = $1`, [req.userId]);
    const to = r.rows[0]?.email;
    if (!to) return res.status(400).json({ error: 'User email not found' });
    const result = await sendMail(
      { to, subject: 'TeamTask Hub – test email', text: 'This is a test email from Settings > Mail.' },
      cId
    );
    if (!result.sent) return res.status(400).json({ error: result.error || 'Failed to send' });
    res.json({ ok: true, message: 'Test email sent.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET integration settings (owner only). Returns non-secret fields + configured flags; secrets are never returned.
router.get('/integrations', requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT square_env, square_application_id, twilio_phone_number,
              square_access_token IS NOT NULL AND square_access_token != '' AS square_configured,
              twilio_account_sid IS NOT NULL AND twilio_account_sid != '' AND
              twilio_auth_token IS NOT NULL AND twilio_auth_token != '' AS twilio_api_configured,
              twilio_account_sid IS NOT NULL AND twilio_account_sid != '' AND
              twilio_auth_token IS NOT NULL AND twilio_auth_token != '' AND
              twilio_phone_number IS NOT NULL AND twilio_phone_number != '' AS twilio_configured,
              mail_host, mail_port, mail_user, mail_from, mail_secure,
              (mail_host IS NOT NULL AND mail_host != '') AS mail_configured
       FROM company_integrations WHERE company_id = $1`,
      [companyId(req)]
    );
    const row = r.rows[0];
    if (!row) {
      return res.json({
        square_env: null,
        square_application_id: null,
        twilio_phone_number: null,
        square_configured: false,
        twilio_api_configured: false,
        twilio_configured: false,
        mail_host: null,
        mail_port: null,
        mail_user: null,
        mail_from: null,
        mail_secure: false,
        mail_configured: false,
      });
    }
    res.json({
      square_env: row.square_env,
      square_application_id: row.square_application_id || null,
      twilio_phone_number: row.twilio_phone_number,
      square_configured: !!row.square_configured,
      twilio_api_configured: !!row.twilio_api_configured,
      twilio_configured: !!row.twilio_configured,
      mail_host: row.mail_host || null,
      mail_port: row.mail_port != null ? row.mail_port : null,
      mail_user: row.mail_user || null,
      mail_from: row.mail_from || null,
      mail_secure: row.mail_secure || false,
      mail_configured: row.mail_configured || false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function optionalTrimmedString(v) {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? v.trim() : String(v).trim();
  return s === '' ? null : s;
}

// PUT integration settings (owner only). Only updates provided fields.
router.put('/integrations', requireOwner, async (req, res) => {
  try {
    const {
      square_application_id,
      square_access_token,
      square_env,
      twilio_account_sid,
      twilio_auth_token,
      twilio_phone_number,
      mail_host,
      mail_port,
      mail_user,
      mail_pass,
      mail_from,
      mail_secure,
    } = req.body ?? {};
    const mailSecureParam =
      mail_secure === true || mail_secure === 'true'
        ? true
        : mail_secure === false || mail_secure === 'false'
          ? false
          : null;
    const cId = companyId(req);
    await query(
      `INSERT INTO company_integrations (company_id, square_application_id, square_access_token, square_env, twilio_account_sid, twilio_auth_token, twilio_phone_number, mail_host, mail_port, mail_user, mail_pass, mail_from, mail_secure, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (company_id) DO UPDATE SET
         square_application_id = COALESCE(NULLIF($2, ''), company_integrations.square_application_id),
         square_access_token = COALESCE(NULLIF($3, ''), company_integrations.square_access_token),
         square_env = COALESCE($4, company_integrations.square_env),
         twilio_account_sid = COALESCE(NULLIF($5, ''), company_integrations.twilio_account_sid),
         twilio_auth_token = COALESCE(NULLIF($6, ''), company_integrations.twilio_auth_token),
         twilio_phone_number = COALESCE(NULLIF($7, ''), company_integrations.twilio_phone_number),
         mail_host = COALESCE(NULLIF($8, ''), company_integrations.mail_host),
         mail_port = COALESCE(NULLIF($9::text, '')::integer, company_integrations.mail_port),
         mail_user = COALESCE(NULLIF($10, ''), company_integrations.mail_user),
         mail_pass = COALESCE(NULLIF($11, ''), company_integrations.mail_pass),
         mail_from = COALESCE(NULLIF($12, ''), company_integrations.mail_from),
         mail_secure = COALESCE($13, company_integrations.mail_secure),
         updated_at = NOW(),
         updated_by = $14`,
      [
        cId,
        square_application_id ?? null,
        square_access_token ?? null,
        square_env ?? null,
        twilio_account_sid ?? null,
        twilio_auth_token ?? null,
        twilio_phone_number ?? null,
        mail_host ?? null,
        mail_port != null && mail_port !== '' ? parseInt(mail_port, 10) : null,
        mail_user ?? null,
        mail_pass ?? null,
        mail_from ?? null,
        mailSecureParam,
        req.userId,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as settingsRouter };
