import express from 'express';
import twilio from 'twilio';
import { pool, query } from '../db.js';
import { executeSqlReadOnly } from './scheduledReportsHelper.js';
import { queryActionsRouter } from './queryActions.js';

const schema = process.env.DB_SCHEMA || 'teamtask_hub';

async function getCompanyTimezone(companyId) {
  const r = await query(`SELECT timezone FROM companies WHERE id = $1`, [companyId]);
  return r.rows[0]?.timezone || 'UTC';
}

const router = express.Router();

// ── Helper: get company integrations (Twilio) ────────────────────────────────
async function getIntegrations(companyId) {
  const r = await query(
    `SELECT twilio_account_sid, twilio_auth_token, twilio_phone_number
     FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  return r.rows[0] || {};
}

// ── Helper: resolve companyId from request ───────────────────────────────────
function cid(req) {
  return req.companyId || req.user?.company_id;
}

// ── GET /api/reports/scheduled ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT sr.*,
        COALESCE(
          json_agg(json_build_object('id', u.id, 'display_name', u.display_name, 'phone', u.phone))
          FILTER (WHERE u.id IS NOT NULL), '[]'
        ) AS recipients
       FROM scheduled_reports sr
       LEFT JOIN scheduled_report_recipients srr ON srr.report_id = sr.id
       LEFT JOIN users u ON u.id = srr.user_id
       WHERE sr.company_id = $1
       GROUP BY sr.id
       ORDER BY sr.name`,
      [cid(req)]
    );
    res.json({ reports: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/reports/scheduled ──────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    name, description, sql_query, frequency,
    day_of_week, day_of_month, send_month,
    send_time, start_date, end_date, active = true,
    recipient_ids = [], params = [],
  } = req.body;

  if (!name?.trim())      return res.status(400).json({ error: 'name is required' });
  if (!sql_query?.trim()) return res.status(400).json({ error: 'sql_query is required' });
  if (!frequency)         return res.status(400).json({ error: 'frequency is required' });

  const dbClient = await pool.connect();
  try {
    await dbClient.query(`SET search_path TO ${schema}`);
    await dbClient.query('BEGIN');
    const r = await dbClient.query(
      `INSERT INTO scheduled_reports
         (company_id, name, description, sql_query, frequency, day_of_week, day_of_month,
          send_month, send_time, start_date, end_date, active, created_by, params)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [cid(req), name.trim(), description || null, sql_query.trim(), frequency,
       day_of_week ?? null, day_of_month ?? null, send_month ?? null,
       send_time || '08:00', start_date || null, end_date || null, active,
       req.user?.id || null, JSON.stringify(params)]
    );
    const report = r.rows[0];
    if (recipient_ids.length) {
      await dbClient.query(
        `INSERT INTO scheduled_report_recipients (report_id, user_id)
         SELECT $1, UNNEST($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [report.id, recipient_ids]
      );
    }
    await dbClient.query('COMMIT');
    res.json({ report });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// ── PATCH /api/reports/scheduled/:id ────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const {
    name, description, sql_query, frequency,
    day_of_week, day_of_month, send_month,
    send_time, start_date, end_date, active,
    recipient_ids, params,
  } = req.body;

  const dbClient = await pool.connect();
  try {
    await dbClient.query(`SET search_path TO ${schema}`);
    await dbClient.query('BEGIN');

    const fields = [];
    const vals = [];
    const set = (col, val) => { fields.push(`${col} = $${vals.length + 1}`); vals.push(val); };

    if (name        !== undefined) set('name', name);
    if (description !== undefined) set('description', description);
    if (sql_query   !== undefined) set('sql_query', sql_query);
    if (frequency   !== undefined) set('frequency', frequency);
    if (day_of_week !== undefined) set('day_of_week', day_of_week);
    if (day_of_month !== undefined) set('day_of_month', day_of_month);
    if (send_month  !== undefined) set('send_month', send_month);
    if (send_time   !== undefined) set('send_time', send_time);
    if (start_date  !== undefined) set('start_date', start_date || null);
    if (end_date    !== undefined) set('end_date', end_date || null);
    if (active      !== undefined) set('active', active);
    if (params      !== undefined) set('params', JSON.stringify(params));

    if (fields.length) {
      vals.push(req.params.id, cid(req));
      const r = await dbClient.query(
        `UPDATE scheduled_reports SET ${fields.join(', ')}
         WHERE id = $${vals.length - 1} AND company_id = $${vals.length}
         RETURNING *`,
        vals
      );
      if (!r.rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    }

    if (recipient_ids !== undefined) {
      await dbClient.query(`DELETE FROM scheduled_report_recipients WHERE report_id = $1`, [req.params.id]);
      if (recipient_ids.length) {
        await dbClient.query(
          `INSERT INTO scheduled_report_recipients (report_id, user_id)
           SELECT $1, UNNEST($2::uuid[])`,
          [req.params.id, recipient_ids]
        );
      }
    }

    await dbClient.query('COMMIT');

    // Fetch updated report with recipients
    const updated = await query(
      `SELECT sr.*, COALESCE(
          json_agg(json_build_object('id', u.id, 'display_name', u.display_name, 'phone', u.phone))
          FILTER (WHERE u.id IS NOT NULL), '[]'
        ) AS recipients
       FROM scheduled_reports sr
       LEFT JOIN scheduled_report_recipients srr ON srr.report_id = sr.id
       LEFT JOIN users u ON u.id = srr.user_id
       WHERE sr.id = $1 GROUP BY sr.id`,
      [req.params.id]
    );
    res.json({ report: updated.rows[0] });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// ── DELETE /api/reports/scheduled/:id ───────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await query(
      `DELETE FROM scheduled_reports WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/reports/scheduled/:id/test ────────────────────────────────────
// Run the saved query (with its saved params) and return results without sending SMS
router.post('/:id/test', async (req, res) => {
  try {
    const r = await query(
      `SELECT sql_query, params FROM scheduled_reports WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const timezone = await getCompanyTimezone(cid(req));
    const { rows, fields } = await executeSqlReadOnly(r.rows[0].sql_query, r.rows[0].params || [], timezone);
    res.json({ rows, fields, count: rows.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/reports/scheduled/test-sql ────────────────────────────────────
// Test arbitrary SQL + params (from the editor before saving)
router.post('/test-sql', async (req, res) => {
  const { sql_query, params } = req.body;
  if (!sql_query?.trim()) return res.status(400).json({ error: 'sql_query required' });
  try {
    const timezone = await getCompanyTimezone(cid(req));
    const { rows, fields } = await executeSqlReadOnly(sql_query, params || [], timezone);
    res.json({ rows, fields, count: rows.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/reports/scheduled/:id/runs ─────────────────────────────────────
router.get('/:id/runs', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, ran_at, status, rows_returned, sms_sent_count, error_message,
              view_token, token_expires_at
       FROM scheduled_report_runs
       WHERE report_id = $1
       ORDER BY ran_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ runs: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/view/:token (PUBLIC — no auth) ──────────────────────────
// Mounted at /api/reports/view in index.js, so this handles /api/reports/view/:token
router.get('/:token', async (req, res) => {
  try {
    const r = await query(
      `SELECT rr.*, sr.name, sr.description, sr.sql_query
       FROM scheduled_report_runs rr
       JOIN scheduled_reports sr ON sr.id = rr.report_id
       WHERE rr.view_token = $1 AND rr.token_expires_at > NOW()`,
      [req.params.token]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Report not found or link expired' });
    const run = r.rows[0];
    res.json({
      name: run.name,
      description: run.description,
      ran_at: run.ran_at,
      rows: run.result_data,
      fields: run.result_fields,
      rows_returned: run.rows_returned,
      params_snapshot: run.params_snapshot || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Nest query actions under /:reportId/actions so mergeParams works correctly
router.use('/:reportId/actions', queryActionsRouter);

export { router as scheduledReportsRouter };
