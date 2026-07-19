/**
 * Harvester management routes
 *
 * GET    /api/harvester/connector-types   — catalog of connector types (live + planned)
 * GET    /api/harvester/sources           — list sources with status
 * POST   /api/harvester/sources           — create a source
 * PATCH  /api/harvester/sources/:id        — update name / schedule / active / config
 * DELETE /api/harvester/sources/:id        — remove a source
 * POST   /api/harvester/sources/:id/run    — request immediate run
 */

import express from 'express';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';

const router = express.Router();
const cId = (req) => req.companyId;

// ── Connector catalog ─────────────────────────────────────────────────────────
// Mirrors the CONNECTORS registry in harvester's src/engine.js. `status: 'live'`
// means the connector is implemented and running on skynet; `planned` means the
// registry can describe it but Harvester can't run it yet (creating one is blocked
// in the UI). config_fields describe the per-source settings each connector reads.
const CONNECTOR_TYPES = [
  {
    key: 'email_amazon',
    label: 'Amazon (email)',
    status: 'live',
    description:
      "Reads Amazon order-confirmation emails from a Gmail label and scrapes each order's page for card, tax and date.",
    config_fields: [
      { key: 'gmail_label', label: 'Gmail label', type: 'text', default: 'invoices' },
      { key: 'sender', label: 'From sender', type: 'text', default: 'auto-confirm@amazon.com' },
    ],
  },
  {
    key: 'email_invoice',
    label: 'Shared invoice@ inbox',
    status: 'planned',
    description:
      'Reads the shared invoice@ inbox and routes each message by sender — known vendors (Alsco, Sysco, liquor) to structured parsers, employee-forwarded photos to vision extraction, payment confirmations flagged.',
    config_fields: [
      { key: 'gmail_label', label: 'Gmail label', type: 'text', default: 'invoices' },
    ],
  },
  {
    key: 'amazon_report',
    label: 'Amazon Business report',
    status: 'planned',
    description:
      'Pulls the Amazon Business admin order report so purchases by ALL employees are captured, not just those whose confirmation email reaches a monitored inbox.',
    config_fields: [],
  },
  {
    key: 'sysco_portal',
    label: 'Sysco portal',
    status: 'planned',
    description: 'Logs into the Sysco portal and pulls invoices directly.',
    config_fields: [],
  },
];

const LIVE_TYPES = new Set(CONNECTOR_TYPES.filter((c) => c.status === 'live').map((c) => c.key));
const KNOWN_TYPES = new Set(CONNECTOR_TYPES.map((c) => c.key));

router.get('/connector-types', requireAuth, requireOwner, (_req, res) => {
  res.json({ connector_types: CONNECTOR_TYPES });
});

// ── List sources with status ──────────────────────────────────────────────────
router.get('/sources', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, connector_type, cron_schedule, active, config,
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

// ── Create a source ───────────────────────────────────────────────────────────
router.post('/sources', requireAuth, requireOwner, async (req, res) => {
  try {
    const { name, connector_type, cron_schedule, config, active } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!KNOWN_TYPES.has(connector_type)) {
      return res.status(400).json({ error: `Unknown connector type: ${connector_type}` });
    }
    if (!LIVE_TYPES.has(connector_type)) {
      return res.status(400).json({
        error: `The "${connector_type}" connector isn't built yet — it's marked planned. Pick a live connector.`,
      });
    }
    if (!cron_schedule?.trim()) return res.status(400).json({ error: 'A schedule is required' });

    const r = await query(
      `INSERT INTO harvester_sources (company_id, name, connector_type, cron_schedule, active, config)
       VALUES ($1, $2, $3, $4, COALESCE($5, true), $6)
       RETURNING id, name, connector_type, cron_schedule, active, config,
                 last_run_at, last_success_at, last_status, last_error, last_records, run_requested_at, created_at`,
      [cId(req), name.trim(), connector_type, cron_schedule.trim(), active ?? true, config ? JSON.stringify(config) : null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update name / schedule / active / config ──────────────────────────────────
router.patch('/sources/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    const { name, cron_schedule, active, config } = req.body;
    const r = await query(
      `UPDATE harvester_sources
       SET name          = COALESCE($2, name),
           cron_schedule = COALESCE($3, cron_schedule),
           active        = COALESCE($4, active),
           config        = COALESCE($5, config)
       WHERE id = $1 AND company_id = $6
       RETURNING id, name, connector_type, cron_schedule, active, config, last_run_at,
                 last_success_at, last_status, last_error, last_records, run_requested_at`,
      [
        req.params.id,
        name ?? null,
        cron_schedule ?? null,
        active ?? null,
        config !== undefined ? JSON.stringify(config) : null,
        cId(req),
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Source not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete a source ───────────────────────────────────────────────────────────
router.delete('/sources/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await query(
      `DELETE FROM harvester_sources WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, cId(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Source not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Request immediate run ─────────────────────────────────────────────────────
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
