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
    const stored = await query(
      `SELECT * FROM abc_filings WHERE company_id = $1 AND period_month = $2`,
      [cid(req), `${req.params.month}-01`]
    );
    const row = stored.rows[0];
    const storedMeta = row ? { status: row.status, prepared_at: row.prepared_at, filed_at: row.filed_at, notes: row.notes } : null;

    // A month with real stored detail (April/May/June 2026) was hand-reconciled
    // once and is served exactly as stored, never recomputed. April and May
    // CANNOT be reproduced by a live computeFiling() call — the reconciliation
    // deliberately booked May's real vintly bottling run onto April instead
    // (Craig's decision), which a fresh recompute correctly flags as a residual
    // failure. That is the check working as designed, not a bug — so these
    // months must never be recomputed, only handed over as-is.
    if (row?.has_detail) {
      const n = (v) => (v === null ? null : Number(v));
      return res.json({
        month: req.params.month,
        companyId: cid(req),
        readyToFile: row.status !== 'filed',
        blocking: row.status === 'filed' ? ['Already marked filed'] : [],
        checks: [{
          id: 'previously_reconciled', ok: true, label: 'Previously reconciled',
          detail: 'These figures come from the original hand reconciliation, not a live computation. Enter them as-is.',
        }],
        lines: {
          beginningInventory: n(row.beginning_inventory), purchases: n(row.purchases),
          production: n(row.production), spoilageSamples: n(row.spoilage_samples),
          salesWholesale: n(row.sales_wholesale), salesRetail: n(row.sales_retail),
          salesOther: n(row.sales_other), salesConsumers: n(row.sales_consumers),
          returnedProduct: n(row.returned_product), endingInventory: n(row.ending_inventory),
        },
        detail: { source: 'stored', freeTastings: n(row.free_tastings), residual: n(row.residual) },
        stored: storedMeta,
      });
    }

    const filing = await computeFiling(cid(req), req.params.month);
    res.json({ ...filing, stored: storedMeta });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/abc/next-month ──────────────────────────────────────────────────
// The oldest month not yet marked filed. Centralizes the "one at a time, in
// order" rule here rather than trusting every caller (Betty included) to work
// it out — the ABC portal itself only allows one report in progress at once.
router.get('/next-month', async (req, res) => {
  try {
    const r = await query(
      `SELECT period_month::text FROM abc_filings
        WHERE company_id = $1 AND status <> 'filed' AND has_detail = true
        ORDER BY period_month ASC LIMIT 1`,
      [cid(req)]);
    if (r.rows.length) {
      return res.json({ month: r.rows[0].period_month.slice(0, 7), reason: 'awaiting_submission' });
    }
    // Nothing outstanding among reconciled months — the next one is whatever
    // comes after the latest filed month, computed live.
    const latest = await query(
      `SELECT period_month::text FROM abc_filings
        WHERE company_id = $1 AND status = 'filed'
        ORDER BY period_month DESC LIMIT 1`,
      [cid(req)]);
    if (!latest.rows.length) return res.json({ month: null, reason: 'no_filing_history' });
    const d = new Date(latest.rows[0].period_month);
    d.setUTCMonth(d.getUTCMonth() + 1);
    res.json({ month: d.toISOString().slice(0, 7), reason: 'next_in_sequence' });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// ── GET /api/abc/isp-credentials ─────────────────────────────────────────────
// The mirror image of POST /filed: that endpoint REJECTS service tokens because
// filing is the licensee's act. This endpoint REJECTS everyone EXCEPT a service
// token — a signed-in human browsing TeamHub should never be able to pull the
// raw ISP password back out through the API; only Betty's automation may.
// Craig enters the credential once through Settings; it is never echoed there.
router.get('/isp-credentials', async (req, res) => {
  if (!req.isServiceToken) {
    return res.status(403).json({ error: 'This endpoint is for the filing automation only.' });
  }
  try {
    const r = await query(
      `SELECT isp_username, isp_password FROM company_integrations WHERE company_id = $1`,
      [cid(req)]);
    const row = r.rows[0];
    if (!row?.isp_username || !row?.isp_password) {
      return res.status(404).json({ error: 'ISP portal credentials are not configured in Settings yet.' });
    }
    res.json({ username: row.isp_username, password: row.isp_password });
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
