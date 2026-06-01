/**
 * Harvester management routes
 *
 * GET  /api/harvester/sources          — list sources with status
 * PATCH /api/harvester/sources/:id     — update schedule or active flag
 * POST /api/harvester/sources/:id/run  — request immediate run
 */

import express from 'express';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';

const router = express.Router();
const cId = (req) => req.companyId;

// List all sources with status
router.get('/sources', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, connector_type, cron_schedule, active,
              last_run_at, last_success_at, last_status, last_error,
              last_records, run_requested_at, created_at
       FROM harvester_sources
       WHERE company_id = $1
       ORDER BY name`,
      [cId(req)]
    );
    res.json({ sources: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update schedule or active flag
router.patch('/sources/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    const { cron_schedule, active } = req.body;
    const r = await query(
      `UPDATE harvester_sources
       SET cron_schedule = COALESCE($2, cron_schedule),
           active = COALESCE($3, active)
       WHERE id = $1 AND company_id = $4
       RETURNING id, name, connector_type, cron_schedule, active, last_run_at,
                 last_success_at, last_status, last_error, last_records`,
      [req.params.id, cron_schedule ?? null, active ?? null, cId(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Source not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request immediate run
router.post('/sources/:id/run', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await query(
      `UPDATE harvester_sources
       SET run_requested_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING id, name, last_status`,
      [req.params.id, cId(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Source not found' });
    res.json({ ok: true, message: `Run requested for ${r.rows[0].name} — will start within 1 minute.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as harvesterRouter };
