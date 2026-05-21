/**
 * Query Actions — per-row actions triggered by scheduled report results
 *
 * Routes (all scoped under /api/reports/scheduled/:reportId/actions):
 *   GET    /                        list actions (with conditions + recipients)
 *   POST   /                        create action
 *   PATCH  /:id                     update action
 *   DELETE /:id                     delete action
 *   POST   /:id/run                 manually trigger this action against the report's current results
 *   GET    /team-members            list Square team members for manager recipient dropdown
 *
 * Action types:
 *   1 = SMS   config: { phone_field, message }
 *   2 = Email config: { email_field, subject, body }   (future)
 *   3 = DB    config: { table, field_map }             (future)
 */

import express from 'express';
import twilio from 'twilio';
import { pool, query } from '../db.js';
import { executeSqlReadOnly } from './scheduledReportsHelper.js';

const schema = process.env.DB_SCHEMA || 'teamtask_hub';
const router = express.Router({ mergeParams: true }); // exposes req.params.reportId

function cid(req) { return req.companyId || req.user?.company_id; }

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Verify the report belongs to this company */
async function assertReportOwner(reportId, companyId) {
  const r = await query(
    `SELECT id FROM scheduled_reports WHERE id = $1 AND company_id = $2`,
    [reportId, companyId]
  );
  if (!r.rows.length) throw Object.assign(new Error('Report not found'), { status: 404 });
}

/** Load a full action with its conditions and recipients */
async function loadAction(actionId) {
  const [aRes, cRes, rRes] = await Promise.all([
    query(`SELECT * FROM query_actions WHERE id = $1`, [actionId]),
    query(`SELECT * FROM query_action_conditions WHERE action_id = $1 ORDER BY condition_group, sort_order`, [actionId]),
    query(`SELECT * FROM query_action_recipients  WHERE action_id = $1 ORDER BY sort_order`, [actionId]),
  ]);
  if (!aRes.rows.length) return null;
  return { ...aRes.rows[0], conditions: cRes.rows, recipients: rRes.rows };
}

/** Replace {FieldName} tokens in a template string with values from a result row.
 *  Matching is case-insensitive. */
function renderTemplate(template, row) {
  return template.replace(/\{([^}]+)\}/g, (_, key) => {
    const match = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
    return match !== undefined ? (row[match] ?? '') : `{${key}}`;
  });
}

/** Evaluate whether a single condition matches a row value. */
function evalCondition(row, { field_name, operator, field_value }) {
  const match = Object.keys(row).find((k) => k.toLowerCase() === field_name.toLowerCase());
  if (match === undefined) return false;
  const raw = row[match];
  const rowVal = raw === null || raw === undefined ? '' : String(raw);
  const cmpVal = field_value;

  // Numeric comparison if both sides parse as numbers
  const rowNum = parseFloat(rowVal);
  const cmpNum = parseFloat(cmpVal);
  const bothNum = !isNaN(rowNum) && !isNaN(cmpNum);

  switch (operator) {
    case '=':            return rowVal === cmpVal;
    case '!=':           return rowVal !== cmpVal;
    case '>':            return bothNum ? rowNum > cmpNum  : rowVal > cmpVal;
    case '<':            return bothNum ? rowNum < cmpNum  : rowVal < cmpVal;
    case '>=':           return bothNum ? rowNum >= cmpNum : rowVal >= cmpVal;
    case '<=':           return bothNum ? rowNum <= cmpNum : rowVal <= cmpVal;
    case 'contains':     return rowVal.toLowerCase().includes(cmpVal.toLowerCase());
    case 'not_contains': return !rowVal.toLowerCase().includes(cmpVal.toLowerCase());
    case 'in':           return cmpVal.split(',').map((s) => s.trim()).includes(rowVal);
    case 'not_in':       return !cmpVal.split(',').map((s) => s.trim()).includes(rowVal);
    default:             return false;
  }
}

/** Evaluate all conditions for an action against a row.
 *  Conditions in the same group are ANDed; groups are ORed. */
function rowMatchesAction(row, conditions) {
  if (!conditions.length) return true; // no conditions → always fire
  const groups = {};
  for (const c of conditions) {
    const g = c.condition_group ?? 1;
    if (!groups[g]) groups[g] = [];
    groups[g].push(c);
  }
  // OR across groups; AND within each group
  return Object.values(groups).some((grp) => grp.every((c) => evalCondition(row, c)));
}

/** Resolve all recipients for an action + row to a list of { channel, address, label } */
async function resolveRecipients(recipients, row) {
  const resolved = [];
  for (const r of recipients) {
    let address;
    if (r.recipient_type === 'field') {
      const match = Object.keys(row).find((k) => k.toLowerCase() === r.value.toLowerCase());
      address = match ? row[match] : null;
    } else if (r.recipient_type === 'static') {
      address = r.value;
    } else if (r.recipient_type === 'user') {
      // Look up phone/email from our users table
      const col = r.channel === 'sms' ? 'phone' : 'email';
      const u = await query(`SELECT ${col} FROM users WHERE id = $1`, [r.value]);
      address = u.rows[0]?.[col] || null;
    }
    if (address) resolved.push({ channel: r.channel, address, label: r.label });
  }
  return resolved;
}

/** Returns the start of the current workweek (Wednesday) for dedup window */
function currentWeekStart() {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun … 6=Sat
  const daysBack = (dow + 4) % 7; // how many days back to Wednesday
  const wed = new Date(now);
  wed.setDate(now.getDate() - daysBack);
  wed.setHours(0, 0, 0, 0);
  return wed.toISOString();
}

/** Check if we already sent this action to this row_key with this triggered_status this week */
async function isSuppressed(actionId, rowKey, triggeredStatus) {
  const r = await query(
    `SELECT 1 FROM query_action_run_details
     WHERE action_id = $1
       AND row_key = $2
       AND triggered_status = $3
       AND status = 'sent'
       AND sent_at >= $4
     LIMIT 1`,
    [actionId, rowKey, triggeredStatus, currentWeekStart()]
  );
  return r.rows.length > 0;
}

/** Send an SMS via Twilio. Returns { ok, error }. */
async function sendSms(companyId, to, body) {
  const integrations = await query(
    `SELECT twilio_account_sid, twilio_auth_token, twilio_phone_number
     FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const cfg = integrations.rows[0];
  if (!cfg?.twilio_account_sid) return { ok: false, error: 'Twilio not configured' };
  try {
    const client = twilio(cfg.twilio_account_sid, cfg.twilio_auth_token);
    await client.messages.create({ to, from: cfg.twilio_phone_number, body });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core execution engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all active actions for a report against a result set.
 * Creates a run_detail log entry for every delivery attempt.
 * Returns { triggered, sent, suppressed, failed }.
 */
async function executeActions(runId, reportId, companyId, rows, timezone = 'UTC') {
  const actRes = await query(
    `SELECT qa.*,
       COALESCE(json_agg(DISTINCT qac.*) FILTER (WHERE qac.id IS NOT NULL), '[]') AS conditions,
       COALESCE(json_agg(DISTINCT qar.*) FILTER (WHERE qar.id IS NOT NULL), '[]') AS recipients
     FROM query_actions qa
     LEFT JOIN query_action_conditions qac ON qac.action_id = qa.id
     LEFT JOIN query_action_recipients qar ON qar.action_id = qa.id
     WHERE qa.report_id = $1 AND qa.is_active = true
     GROUP BY qa.id
     ORDER BY qa.sort_order`,
    [reportId]
  );
  const actions = actRes.rows;
  if (!actions.length) return { triggered: 0, sent: 0, suppressed: 0, failed: 0 };

  let triggered = 0, sent = 0, suppressed = 0, failed = 0;

  for (const action of actions) {
    const { config = {}, notify_once_per_status } = action;
    const conditions = action.conditions || [];
    const recipients = action.recipients || [];

    for (const row of rows) {
      if (!rowMatchesAction(row, conditions)) continue;
      triggered++;

      // Derive row key from first column value for dedup
      const firstCol = Object.keys(row)[0];
      const rowKey = firstCol ? String(row[firstCol]) : '';

      // Find the "status" field value for dedup label (look for a field named Status or OT Status)
      const statusKey = Object.keys(row).find((k) => /status/i.test(k));
      const triggeredStatus = statusKey ? String(row[statusKey]) : 'triggered';

      // Dedup check
      if (notify_once_per_status) {
        const suppress = await isSuppressed(action.id, rowKey, triggeredStatus);
        if (suppress) {
          suppressed++;
          await query(
            `INSERT INTO query_action_run_details
               (run_id, action_id, row_data, row_key, recipient, status, triggered_status)
             VALUES ($1,$2,$3,$4,$5,'suppressed',$6)`,
            [runId, action.id, JSON.stringify(row), rowKey, null, triggeredStatus]
          );
          continue;
        }
      }

      // Resolve recipients and dispatch
      const resolvedRecipients = await resolveRecipients(recipients, row);

      if (!resolvedRecipients.length) {
        // Log as skipped — no resolvable recipient
        await query(
          `INSERT INTO query_action_run_details
             (run_id, action_id, row_data, row_key, recipient, status, triggered_status, error_message)
           VALUES ($1,$2,$3,$4,$5,'skipped',$6,'No recipient resolved')`,
          [runId, action.id, JSON.stringify(row), rowKey, null, triggeredStatus]
        );
        continue;
      }

      for (const recipient of resolvedRecipients) {
        let result = { ok: false, error: 'Unsupported action type' };

        if (action.action_type === 1 && recipient.channel === 'sms') {
          const message = renderTemplate(config.message || '', row);
          result = await sendSms(companyId, recipient.address, message);
        }
        // action_type 2 (email) and 3 (DB insert) — placeholders for future
        // else if (action.action_type === 2) { ... }

        const status = result.ok ? 'sent' : 'failed';
        if (result.ok) sent++; else failed++;

        await query(
          `INSERT INTO query_action_run_details
             (run_id, action_id, row_data, row_key, recipient, status, triggered_status, error_message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [runId, action.id, JSON.stringify(row), rowKey,
           recipient.address, status, triggeredStatus, result.error || null]
        );
      }
    }
  }

  return { triggered, sent, suppressed, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/reports/scheduled/:reportId/actions
router.get('/', async (req, res) => {
  try {
    await assertReportOwner(req.params.reportId, cid(req));
    const r = await query(
      `SELECT qa.*,
         COALESCE(json_agg(DISTINCT jsonb_build_object(
           'id', qac.id, 'field_name', qac.field_name, 'operator', qac.operator,
           'field_value', qac.field_value, 'condition_group', qac.condition_group,
           'sort_order', qac.sort_order
         )) FILTER (WHERE qac.id IS NOT NULL), '[]') AS conditions,
         COALESCE(json_agg(DISTINCT jsonb_build_object(
           'id', qar.id, 'channel', qar.channel, 'recipient_type', qar.recipient_type,
           'value', qar.value, 'label', qar.label, 'sort_order', qar.sort_order
         )) FILTER (WHERE qar.id IS NOT NULL), '[]') AS recipients
       FROM query_actions qa
       LEFT JOIN query_action_conditions qac ON qac.action_id = qa.id
       LEFT JOIN query_action_recipients qar ON qar.action_id = qa.id
       WHERE qa.report_id = $1
       GROUP BY qa.id
       ORDER BY qa.sort_order, qa.created_at`,
      [req.params.reportId]
    );
    res.json({ actions: r.rows });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/reports/scheduled/:reportId/actions
router.post('/', async (req, res) => {
  const { name, action_type = 1, config = {}, notify_once_per_status = false,
          is_active = true, sort_order = 0, conditions = [], recipients = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  const dbClient = await pool.connect();
  try {
    await assertReportOwner(req.params.reportId, cid(req));
    await dbClient.query(`SET search_path TO ${schema}`);
    await dbClient.query('BEGIN');

    const aRes = await dbClient.query(
      `INSERT INTO query_actions
         (report_id, name, action_type, config, notify_once_per_status, is_active, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.reportId, name.trim(), action_type, JSON.stringify(config),
       notify_once_per_status, is_active, sort_order, req.user?.id || null]
    );
    const action = aRes.rows[0];

    for (const c of conditions) {
      await dbClient.query(
        `INSERT INTO query_action_conditions
           (action_id, field_name, operator, field_value, condition_group, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [action.id, c.field_name, c.operator, c.field_value,
         c.condition_group ?? 1, c.sort_order ?? 0]
      );
    }
    for (const r of recipients) {
      await dbClient.query(
        `INSERT INTO query_action_recipients
           (action_id, channel, recipient_type, value, label, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [action.id, r.channel, r.recipient_type, r.value, r.label || null, r.sort_order ?? 0]
      );
    }

    await dbClient.query('COMMIT');
    res.json({ action: await loadAction(action.id) });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// PATCH /api/reports/scheduled/:reportId/actions/:id
router.patch('/:id', async (req, res) => {
  const { name, action_type, config, notify_once_per_status, is_active,
          sort_order, conditions, recipients } = req.body;

  const dbClient = await pool.connect();
  try {
    await assertReportOwner(req.params.reportId, cid(req));
    await dbClient.query(`SET search_path TO ${schema}`);
    await dbClient.query('BEGIN');

    // Build dynamic UPDATE
    const fields = [], vals = [];
    const set = (col, val) => { fields.push(`${col} = $${vals.length + 1}`); vals.push(val); };
    if (name                  !== undefined) set('name', name);
    if (action_type           !== undefined) set('action_type', action_type);
    if (config                !== undefined) set('config', JSON.stringify(config));
    if (notify_once_per_status !== undefined) set('notify_once_per_status', notify_once_per_status);
    if (is_active             !== undefined) set('is_active', is_active);
    if (sort_order            !== undefined) set('sort_order', sort_order);

    if (fields.length) {
      vals.push(req.params.id, req.params.reportId);
      const r = await dbClient.query(
        `UPDATE query_actions SET ${fields.join(', ')}
         WHERE id = $${vals.length - 1} AND report_id = $${vals.length} RETURNING *`,
        vals
      );
      if (!r.rows.length) {
        await dbClient.query('ROLLBACK');
        return res.status(404).json({ error: 'Action not found' });
      }
    }

    // Replace conditions if provided
    if (conditions !== undefined) {
      await dbClient.query(`DELETE FROM query_action_conditions WHERE action_id = $1`, [req.params.id]);
      for (const c of conditions) {
        await dbClient.query(
          `INSERT INTO query_action_conditions
             (action_id, field_name, operator, field_value, condition_group, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, c.field_name, c.operator, c.field_value,
           c.condition_group ?? 1, c.sort_order ?? 0]
        );
      }
    }

    // Replace recipients if provided
    if (recipients !== undefined) {
      await dbClient.query(`DELETE FROM query_action_recipients WHERE action_id = $1`, [req.params.id]);
      for (const r of recipients) {
        await dbClient.query(
          `INSERT INTO query_action_recipients
             (action_id, channel, recipient_type, value, label, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, r.channel, r.recipient_type, r.value, r.label || null, r.sort_order ?? 0]
        );
      }
    }

    await dbClient.query('COMMIT');
    res.json({ action: await loadAction(req.params.id) });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// DELETE /api/reports/scheduled/:reportId/actions/:id
router.delete('/:id', async (req, res) => {
  try {
    await assertReportOwner(req.params.reportId, cid(req));
    await query(
      `DELETE FROM query_actions WHERE id = $1 AND report_id = $2`,
      [req.params.id, req.params.reportId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Manual run
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/reports/scheduled/:reportId/actions/:id/run  — or omit :id to run all
router.post(['/:id/run', '/run'], async (req, res) => {
  try {
    await assertReportOwner(req.params.reportId, cid(req));

    const rptRes = await query(
      `SELECT sql_query, params FROM scheduled_reports WHERE id = $1`,
      [req.params.reportId]
    );
    if (!rptRes.rows.length) return res.status(404).json({ error: 'Report not found' });

    const { sql_query, params } = rptRes.rows[0];
    const timezone = (await query(`SELECT timezone FROM companies WHERE id = $1`, [cid(req)])).rows[0]?.timezone || 'UTC';
    const { rows } = await executeSqlReadOnly(sql_query, params || [], timezone);

    // Create a run record to anchor the detail logs
    const runRes = await query(
      `INSERT INTO scheduled_report_runs
         (report_id, status, rows_returned, triggered_by)
       VALUES ($1, 'action_run', $2, $3) RETURNING id`,
      [req.params.reportId, rows.length, req.user?.id || null]
    );
    const runId = runRes.rows[0].id;

    const stats = await executeActions(runId, req.params.reportId, cid(req), rows, timezone);

    // Update run record with action stats
    await query(
      `UPDATE scheduled_report_runs
       SET sms_sent_count = $1, status = $2
       WHERE id = $3`,
      [stats.sent, stats.failed > 0 ? 'partial' : 'success', runId]
    );

    res.json({ ok: true, run_id: runId, rows: rows.length, ...stats });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Supporting data
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/reports/scheduled/:reportId/actions/team-members
// Returns TeamHub users (managers/owners) for the manager recipient dropdown.
// recipient_type='user' stores a TeamHub user UUID; the execution engine
// looks up their phone from the users table at send time.
router.get('/team-members', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, display_name AS name, phone, email
       FROM users
       WHERE company_id = $1
         AND phone IS NOT NULL
         AND phone != ''
       ORDER BY display_name`,
      [cid(req)]
    );
    res.json({ team_members: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Export engine for use by the scheduled report cron runner
// ─────────────────────────────────────────────────────────────────────────────
export { executeActions };
export { router as queryActionsRouter };
