/**
 * Skynet routes — manage AI agent schedules via Paperclip.
 *
 *   GET    /api/skynet/agents              list agents from Paperclip
 *   GET    /api/skynet/schedules           list all schedules
 *   POST   /api/skynet/schedules           create a schedule
 *   PATCH  /api/skynet/schedules/:id       update (prompt, enabled, etc.)
 *   DELETE /api/skynet/schedules/:id       delete
 *   POST   /api/skynet/schedules/:id/run   trigger immediately
 *   GET    /api/skynet/config              get Paperclip connection config
 *   PUT    /api/skynet/config              save Paperclip connection config
 */

import express from 'express';
import { query } from '../db.js';

const router = express.Router();

function cid(req) { return req.companyId || req.user?.company_id; }

async function getPaperclipConfig(companyId) {
  const r = await query(
    `SELECT paperclip_base_url, paperclip_api_key, paperclip_company_id, paperclip_default_goal_id
     FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const row = r.rows[0];
  return {
    baseUrl:   row?.paperclip_base_url?.trim()        || process.env.PAPERCLIP_BASE_URL        || '',
    apiKey:    row?.paperclip_api_key?.trim()         || process.env.PAPERCLIP_API_KEY         || '',
    companyId: row?.paperclip_company_id?.trim()      || process.env.PAPERCLIP_COMPANY_ID      || '',
    goalId:    row?.paperclip_default_goal_id?.trim() || process.env.PAPERCLIP_DEFAULT_GOAL_ID || '',
  };
}

async function paperclipFetch(companyId, path, options = {}) {
  const cfg = await getPaperclipConfig(companyId);
  if (!cfg.baseUrl || !cfg.apiKey) throw new Error('Paperclip not configured — set base URL and API key in Skynet settings.');
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperclip ${res.status}: ${text}`);
  }
  return res.json();
}

// Calculate next_run_at for a new or updated schedule
function computeNextRunAt(scheduleType, fireAt, scheduleConfig) {
  if (scheduleType === 'once') return fireAt ? new Date(fireAt) : null;

  const now = new Date();
  const { hour = 8, minute = 0, dayOfWeek = 1, dayOfMonth = 1, month = 1 } = scheduleConfig || {};

  switch (scheduleType) {
    case 'hourly': {
      const next = new Date(now);
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      return next;
    }
    case 'daily': {
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next;
    }
    case 'weekly': {
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      const daysUntil = (dayOfWeek - next.getDay() + 7) % 7 || 7;
      next.setDate(next.getDate() + daysUntil);
      return next;
    }
    case 'monthly': {
      const next = new Date(now);
      next.setDate(dayOfMonth);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) next.setMonth(next.getMonth() + 1);
      return next;
    }
    case 'annually': {
      const next = new Date(now);
      next.setMonth(month - 1, dayOfMonth);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) next.setFullYear(next.getFullYear() + 1);
      return next;
    }
    default: return null;
  }
}

// ── GET /api/skynet/config ────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const cfg = await getPaperclipConfig(cid(req));
    res.json({ baseUrl: cfg.baseUrl, companyId: cfg.companyId, goalId: cfg.goalId, hasApiKey: !!cfg.apiKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/skynet/config ────────────────────────────────────────────────────
router.put('/config', async (req, res) => {
  const { baseUrl, apiKey, companyId, goalId } = req.body;
  try {
    await query(
      `INSERT INTO company_integrations (company_id, paperclip_base_url, paperclip_api_key, paperclip_company_id, paperclip_default_goal_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id) DO UPDATE SET
         paperclip_base_url        = COALESCE(EXCLUDED.paperclip_base_url, company_integrations.paperclip_base_url),
         paperclip_api_key         = COALESCE(EXCLUDED.paperclip_api_key, company_integrations.paperclip_api_key),
         paperclip_company_id      = COALESCE(EXCLUDED.paperclip_company_id, company_integrations.paperclip_company_id),
         paperclip_default_goal_id = COALESCE(EXCLUDED.paperclip_default_goal_id, company_integrations.paperclip_default_goal_id),
         updated_at = NOW()`,
      [cid(req), baseUrl || null, apiKey || null, companyId || null, goalId || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/skynet/agents ────────────────────────────────────────────────────
router.get('/agents', async (req, res) => {
  try {
    const cfg = await getPaperclipConfig(cid(req));
    const agents = await paperclipFetch(cid(req), `/api/companies/${cfg.companyId}/agents`);
    const list = (Array.isArray(agents) ? agents : agents.agents || []).map((a) => ({
      id:           a.id,
      name:         a.name,
      role:         a.role,
      title:        a.title,
      capabilities: a.capabilities,
      status:       a.status,
    }));
    res.json({ agents: list });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/skynet/schedules ─────────────────────────────────────────────────
router.get('/schedules', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM skynet_schedules WHERE company_id = $1 ORDER BY created_at DESC`,
      [cid(req)]
    );
    res.json({ schedules: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/skynet/schedules ────────────────────────────────────────────────
router.post('/schedules', async (req, res) => {
  const { name, agentId, agentName, prompt, scheduleType, fireAt, scheduleConfig } = req.body;

  if (!name?.trim())       return res.status(400).json({ error: 'name is required' });
  if (!agentId?.trim())    return res.status(400).json({ error: 'agentId is required' });
  if (!prompt?.trim())     return res.status(400).json({ error: 'prompt is required' });
  if (!scheduleType)       return res.status(400).json({ error: 'scheduleType is required' });

  const validTypes = ['once', 'hourly', 'daily', 'weekly', 'monthly', 'annually'];
  if (!validTypes.includes(scheduleType)) return res.status(400).json({ error: `scheduleType must be one of: ${validTypes.join(', ')}` });
  if (scheduleType === 'once' && !fireAt) return res.status(400).json({ error: 'fireAt is required for one-time schedules' });

  const nextRunAt = computeNextRunAt(scheduleType, fireAt, scheduleConfig);

  try {
    const r = await query(
      `INSERT INTO skynet_schedules
         (company_id, name, agent_id, agent_name, prompt, schedule_type, fire_at, next_run_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [cid(req), name.trim(), agentId.trim(), agentName || null, prompt.trim(),
       scheduleType, fireAt || null, nextRunAt, req.userId || null]
    );
    res.status(201).json({ schedule: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/skynet/schedules/:id ──────────────────────────────────────────
router.patch('/schedules/:id', async (req, res) => {
  const { name, prompt, enabled, scheduleType, fireAt, scheduleConfig } = req.body;
  const fields = [];
  const vals   = [];
  let i = 1;

  if (name    !== undefined) { fields.push(`name = $${i++}`);    vals.push(name.trim()); }
  if (prompt  !== undefined) { fields.push(`prompt = $${i++}`);  vals.push(prompt.trim()); }
  if (enabled !== undefined) { fields.push(`enabled = $${i++}`); vals.push(enabled); }

  if (scheduleType !== undefined) {
    fields.push(`schedule_type = $${i++}`); vals.push(scheduleType);
    fields.push(`fire_at = $${i++}`);       vals.push(fireAt || null);
    const nextRunAt = computeNextRunAt(scheduleType, fireAt, scheduleConfig);
    fields.push(`next_run_at = $${i++}`);   vals.push(nextRunAt);
  }

  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

  try {
    const r = await query(
      `UPDATE skynet_schedules SET ${fields.join(', ')} WHERE id = $${i++} AND company_id = $${i++} RETURNING *`,
      [...vals, req.params.id, cid(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ schedule: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/skynet/schedules/:id ─────────────────────────────────────────
router.delete('/schedules/:id', async (req, res) => {
  try {
    const r = await query(
      `DELETE FROM skynet_schedules WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/skynet/schedules/:id/run ───────────────────────────────────────
router.post('/schedules/:id/run', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM skynet_schedules WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const schedule = r.rows[0];

    const cfg = await getPaperclipConfig(cid(req));
    const body = {
      title:           `${schedule.name} — ${new Date().toISOString().slice(0, 10)}`,
      description:     schedule.prompt,
      assigneeAgentId: schedule.agent_id,
      priority:        'medium',
      status:          'todo',
    };
    if (cfg.goalId) body.goalId = cfg.goalId;

    const issue = await paperclipFetch(cid(req), `/api/companies/${cfg.companyId}/issues`, {
      method: 'POST',
      body:   JSON.stringify(body),
    });

    const issueId = issue?.id || issue?.issue?.id || null;
    await query(
      `UPDATE skynet_schedules SET last_run_at = NOW(), last_issue_id = $1, run_count = run_count + 1 WHERE id = $2`,
      [issueId, schedule.id]
    );

    res.json({ ok: true, issue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as skynetRouter };
