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
              (mail_host IS NOT NULL AND mail_host != '') AS mail_configured,
              qbo_realm_id, qbo_environment,
              qbo_access_token IS NOT NULL AND qbo_access_token != '' AS qbo_connected,
              anthropic_api_key IS NOT NULL AND anthropic_api_key != '' AS anthropic_configured,
              ha_url,
              ha_token IS NOT NULL AND ha_token != '' AS ha_configured
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
        qbo_connected: false,
        qbo_realm_id: null,
        qbo_environment: 'production',
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
      qbo_connected: !!row.qbo_connected,
      qbo_realm_id: row.qbo_realm_id || null,
      qbo_environment: row.qbo_environment || 'production',
      anthropic_configured: !!row.anthropic_configured,
      ha_url: row.ha_url || null,
      ha_configured: !!row.ha_configured,
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
      anthropic_api_key,
      ha_url,
      ha_token,
    } = req.body ?? {};
    const mailSecureParam =
      mail_secure === true || mail_secure === 'true'
        ? true
        : mail_secure === false || mail_secure === 'false'
          ? false
          : null;
    const cId = companyId(req);
    await query(
      `INSERT INTO company_integrations (company_id, square_application_id, square_access_token, square_env, twilio_account_sid, twilio_auth_token, twilio_phone_number, mail_host, mail_port, mail_user, mail_pass, mail_from, mail_secure, anthropic_api_key, updated_by, ha_url, ha_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
         anthropic_api_key = COALESCE(NULLIF($14, ''), company_integrations.anthropic_api_key),
         updated_at = NOW(),
         updated_by = $15,
         ha_url = COALESCE(NULLIF($16, ''), company_integrations.ha_url),
         ha_token = COALESCE(NULLIF($17, ''), company_integrations.ha_token)`,
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
        anthropic_api_key ?? null,
        req.userId,
        ha_url ?? null,
        ha_token ?? null,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /settings/commerce7 — C7 credentials (owner only, never returns api key)
router.get('/commerce7', requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT c7_tenant_slug, c7_tenant_id, c7_api_base_url,
              c7_api_key IS NOT NULL AND c7_api_key != '' AS c7_configured
       FROM company_integrations WHERE company_id = $1`,
      [companyId(req)]
    );
    const row = r.rows[0];
    res.json({
      c7_tenant_slug:  row?.c7_tenant_slug  || '',
      c7_tenant_id:    row?.c7_tenant_id    || '',
      c7_api_base_url: row?.c7_api_base_url || '',
      c7_configured:   !!row?.c7_configured,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /settings/commerce7 — save C7 credentials (owner only)
router.put('/commerce7', requireOwner, async (req, res) => {
  const { c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key } = req.body ?? {};
  try {
    await query(
      `INSERT INTO company_integrations (company_id, c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id) DO UPDATE SET
         c7_tenant_slug  = COALESCE(NULLIF($2,''), company_integrations.c7_tenant_slug),
         c7_tenant_id    = COALESCE(NULLIF($3,''), company_integrations.c7_tenant_id),
         c7_api_base_url = COALESCE(NULLIF($4,''), company_integrations.c7_api_base_url),
         c7_api_key      = COALESCE(NULLIF($5,''), company_integrations.c7_api_key),
         updated_at      = NOW(),
         updated_by      = $6`,
      [
        companyId(req),
        c7_tenant_slug?.trim() || null,
        c7_tenant_id?.trim()   || null,
        c7_api_base_url?.trim()|| null,
        c7_api_key?.trim()     || null,
        req.userId,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /settings/commerce7/test — verify C7 credentials (owner only)
router.post('/commerce7/test', requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
       FROM company_integrations WHERE company_id = $1`,
      [companyId(req)]
    );
    const row = r.rows[0];
    // Allow testing unsaved values passed in body
    const integration = {
      c7_tenant_slug:  req.body?.c7_tenant_slug  || row?.c7_tenant_slug  || '',
      c7_tenant_id:    req.body?.c7_tenant_id    || row?.c7_tenant_id    || '',
      c7_api_base_url: req.body?.c7_api_base_url || row?.c7_api_base_url || '',
      c7_api_key:      req.body?.c7_api_key      || row?.c7_api_key      || '',
    };
    if (!integration.c7_api_key) {
      return res.status(400).json({ error: 'API key not configured. Enter and save your key first.' });
    }
    const { makeC7Client } = await import('../lib/commerce7Client.js');
    const client = makeC7Client(integration);
    const data = await client.get('/product?page=1&limit=1');
    res.json({ ok: true, message: `Connected. ${data.total ?? '?'} products found in Commerce7.` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /settings/commerce7/sync — trigger manual C7 data sync (owner only)
router.post('/commerce7/sync', requireOwner, async (req, res) => {
  const { mode = 'incremental', entity } = req.body; // entity: 'customers'|'orders'|undefined (both)
  try {
    const r = await query(
      `SELECT c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
       FROM company_integrations WHERE company_id = $1`,
      [companyId(req)]
    );
    const integration = r.rows[0];
    if (!integration?.c7_api_key) {
      return res.status(400).json({ error: 'Commerce7 not configured' });
    }

    const { syncCustomers, syncOrders, syncCompany } = await import('../lib/commerce7Sync.js');
    const cid = companyId(req);
    const opts = { mode };

    // Respond immediately — sync runs async in background
    res.json({ ok: true, message: `${mode} sync started for ${entity || 'customers + orders'}` });

    if (entity === 'customers') {
      syncCustomers(cid, integration, opts).catch((e) => console.error('[c7-sync] manual sync error:', e.message));
    } else if (entity === 'orders') {
      syncOrders(cid, integration, opts).catch((e) => console.error('[c7-sync] manual sync error:', e.message));
    } else {
      syncCompany(cid, integration, opts).catch((e) => console.error('[c7-sync] manual sync error:', e.message));
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /settings/commerce7/sync-log — recent sync history (owner only)
router.get('/commerce7/sync-log', requireOwner, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT entity, mode, since, records_synced, error_message, started_at, finished_at
       FROM commerce7.sync_log
       WHERE company_id = $1
       ORDER BY started_at DESC LIMIT 20`,
      [companyId(req)]
    );
    res.json({ log: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Amazon Business ──────────────────────────────────────────────────────────

// GET /settings/amazon — returns email (never password)
router.get('/amazon', requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT amazon_email,
              amazon_password IS NOT NULL AND amazon_password != '' AS amazon_configured
       FROM company_integrations WHERE company_id = $1`,
      [companyId(req)]
    );
    const row = r.rows[0];
    res.json({
      amazon_email:       row?.amazon_email       || '',
      amazon_configured:  !!row?.amazon_configured,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /settings/amazon — save email + password
router.put('/amazon', requireOwner, async (req, res) => {
  const { amazon_email, amazon_password } = req.body ?? {};
  try {
    await query(
      `INSERT INTO company_integrations (company_id, amazon_email, amazon_password, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id) DO UPDATE SET
         amazon_email    = COALESCE(NULLIF($2,''), company_integrations.amazon_email),
         amazon_password = COALESCE(NULLIF($3,''), company_integrations.amazon_password),
         updated_at      = NOW(),
         updated_by      = $4`,
      [companyId(req), amazon_email?.trim() || null, amazon_password || null, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /settings/amazon/test — test login with Playwright
router.post('/amazon/test', requireOwner, async (req, res) => {
  const cId = companyId(req);
  try {
    // Use body values if provided (unsaved), otherwise load from DB
    let email = req.body?.amazon_email?.trim();
    let password = req.body?.amazon_password;

    if (!email || !password) {
      const r = await query(
        `SELECT amazon_email, amazon_password FROM company_integrations WHERE company_id = $1`,
        [cId]
      );
      const row = r.rows[0];
      email    = email    || row?.amazon_email    || '';
      password = password || row?.amazon_password || '';
    }

    if (!email || !password) {
      return res.status(400).json({ error: 'Amazon email and password are required.' });
    }

    const { testAmazonLogin } = await import('../lib/amazonSync.js');
    const result = await testAmazonLogin(cId, email, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /settings/general — company-level general settings (owner only)
// Readable by any authenticated user — the timezone is needed for date
// calculations across the whole app. (PATCH below stays owner-only.)
router.get('/general', async (req, res) => {
  try {
    const r = await query(
      `SELECT timezone, ops_manager_name FROM companies WHERE id = $1`,
      [companyId(req)]
    );
    res.json({
      timezone:         r.rows[0]?.timezone         || 'UTC',
      ops_manager_name: r.rows[0]?.ops_manager_name || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /settings/general — update company-level general settings (owner only)
router.patch('/general', requireOwner, async (req, res) => {
  const { timezone, ops_manager_name } = req.body;
  if (!timezone?.trim()) return res.status(400).json({ error: 'timezone is required' });
  try {
    await query(
      `UPDATE companies SET timezone = $1, ops_manager_name = $2 WHERE id = $3`,
      [timezone.trim(), ops_manager_name?.trim() || null, companyId(req)]
    );
    res.json({ ok: true, timezone: timezone.trim(), ops_manager_name: ops_manager_name?.trim() || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /settings/square-employees — active Square employees for manager dropdown (owner only)
router.get('/square-employees', requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT given_name AS first_name, family_name AS last_name,
              TRIM(given_name || ' ' || family_name) AS full_name,
              phone_number
       FROM team_square.team_member
       WHERE status = 'ACTIVE'
         AND given_name IS NOT NULL
       ORDER BY family_name, given_name`
    );
    res.json({ employees: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI model settings ─────────────────────────────────────────────────────────

const AI_PROCESSES = [
  {
    key: 'receipt_extraction',
    name: 'Receipt Extraction',
    description: 'Pulls order numbers, dates, vendors, and line items from uploaded PDFs and emails',
    default_model: 'claude-haiku-3-5',
  },
  {
    key: 'receipt_categorization',
    name: 'Receipt Categorization',
    description: 'Suggests QuickBooks accounts and classes for each line item',
    default_model: 'claude-haiku-3-5',
  },
  {
    key: 'rule_suggestions',
    name: 'Rule Suggestions',
    description: 'Generates categorization rules from your manual corrections',
    default_model: 'claude-haiku-3-5',
  },
  {
    key: 'ai_rules',
    name: 'AI Rule Evaluation',
    description: 'Evaluates natural-language categorization rules against line items',
    default_model: 'claude-haiku-3-5',
  },
  {
    key: 'kindred_ai',
    name: 'Kindred AI Chat',
    description: 'Powers the AI assistant for sales data queries',
    default_model: 'claude-sonnet-4-5',
  },
  {
    key: 'shopping_duplicates',
    name: 'Shopping Duplicate Detection',
    description: 'Finds duplicate items in the product catalog',
    default_model: 'claude-haiku-3-5',
  },
  {
    key: 'shopping_unit_extract',
    name: 'Shopping Unit Extraction',
    description: 'Extracts pack sizes and unit quantities from descriptions',
    default_model: 'claude-haiku-3-5',
  },
];

// GET /settings/ai-models — return all processes with current model (owner only)
router.get('/ai-models', requireOwner, async (req, res) => {
  try {
    const cId = companyId(req);
    const r = await query(
      `SELECT process_key, model FROM ai_model_settings WHERE company_id = $1`,
      [cId]
    );
    const saved = Object.fromEntries(r.rows.map((row) => [row.process_key, row.model]));
    const processes = AI_PROCESSES.map((p) => ({
      key:           p.key,
      name:          p.name,
      description:   p.description,
      model:         saved[p.key] || p.default_model,
      default_model: p.default_model,
    }));
    res.json({ processes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /settings/ai-models — upsert model preferences (owner only)
// Body: { settings: { process_key: model, ... } }
router.put('/ai-models', requireOwner, async (req, res) => {
  try {
    const cId = companyId(req);
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'settings object required' });
    }
    for (const [processKey, model] of Object.entries(settings)) {
      await query(
        `INSERT INTO ai_model_settings (company_id, process_key, model, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (company_id, process_key) DO UPDATE SET model = EXCLUDED.model, updated_at = NOW()`,
        [cId, processKey, model]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as settingsRouter };
