/**
 * Idaho ABC monthly wine report.
 *
 *   GET  /api/abc/filing/:month          compute the filing for YYYY-MM (Betty + review page)
 *   POST /api/abc/filing/:month/draft    save the computed filing as a draft awaiting review
 *   POST /api/abc/filing/:month/filed    mark a month as filed with the state (human only)
 *   GET  /api/abc/filings                filing history
 *
 * Nothing here submits anything to the state. Betty prepares and saves; the
 * licensee reviews and submits. See docs/ABC_FILING.md and
 * docs/skills/abc-wine-report.md.
 */

import express from 'express';
import { query } from '../db.js';
import { computeFiling, saveDraft } from '../lib/abcFiling.js';

const router = express.Router();

function cid(req) { return req.companyId || req.user?.company_id; }

// ── GET /api/abc/filing/:month ───────────────────────────────────────────────
router.get('/filing/:month', async (req, res) => {
  try {
    const filing = await computeFiling(cid(req), req.params.month);
    const stored = await query(
      `SELECT status, prepared_at, filed_at, notes FROM abc_filings
        WHERE company_id = $1 AND period_month = $2`,
      [cid(req), `${req.params.month}-01`]
    );
    res.json({ ...filing, stored: stored.rows[0] || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/abc/filing/:month/draft ────────────────────────────────────────
// Betty calls this after preparing the filing on the portal. Refuses to save a
// draft that failed preflight — a draft that can't be filed shouldn't look ready.
router.post('/filing/:month/draft', async (req, res) => {
  try {
    const filing = await computeFiling(cid(req), req.params.month);
    if (!filing.readyToFile) {
      return res.status(409).json({
        error: 'Preflight failed — not saved.',
        blocking: filing.blocking,
        checks: filing.checks.filter((c) => !c.ok),
      });
    }
    const row = await saveDraft(cid(req), filing);
    if (!row) return res.status(409).json({ error: `${req.params.month} is already marked filed — refusing to overwrite.` });
    res.json({ ok: true, filing: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/abc/filing/:month/filed ────────────────────────────────────────
// Records that a human submitted the report. Deliberately not callable by the
// preparation routine — the attestation is the licensee's, not the agent's.
router.post('/filing/:month/filed', async (req, res) => {
  if (req.serviceTokenId) {
    return res.status(403).json({ error: 'Filing must be confirmed by a signed-in user, not a service token.' });
  }
  try {
    const r = await query(
      `UPDATE abc_filings
          SET status = 'filed', filed_at = NOW(), filed_by = $3,
              notes = COALESCE($4, notes), updated_at = NOW()
        WHERE company_id = $1 AND period_month = $2
        RETURNING *`,
      [cid(req), `${req.params.month}-01`, req.userId || null, req.body?.notes || null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No draft on record for that month.' });
    res.json({ ok: true, filing: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/abc/filings ─────────────────────────────────────────────────────
router.get('/filings', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM abc_filings WHERE company_id = $1 ORDER BY period_month DESC LIMIT 36`,
      [cid(req)]
    );
    res.json({ filings: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as abcRouter };
