/**
 * Amazon session cookie store
 *
 * The Mac sync script (harvester/sync-amazon-session.js) runs every 12 hours,
 * validates Craig's local Amazon cookies, and pushes them here.  Skynet's
 * amazon-scraper reads them via GET before each harvest so it always has a
 * fresh session without Craig having to SCP files manually.
 *
 * GET  /api/amazon-session  — return stored cookies (or 404)
 * PUT  /api/amazon-session  — store / refresh cookies
 * DELETE /api/amazon-session/notify-expired — SMS Craig that session needs refresh
 */

import express from 'express';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { sendSmsToUsers } from '../lib/smsHelper.js';

const router = express.Router();

// GET — Skynet fetches cookies before each harvest
router.get('/', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT cookies, synced_from, updated_at FROM amazon_sessions WHERE company_id = $1`,
      [req.companyId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No Amazon session stored' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT — Mac sync script pushes fresh cookies
router.put('/', requireAuth, requireOwner, async (req, res) => {
  const { cookies, synced_from } = req.body;
  if (!Array.isArray(cookies) || !cookies.length) {
    return res.status(400).json({ error: 'cookies must be a non-empty array' });
  }
  try {
    await query(
      `INSERT INTO amazon_sessions (company_id, cookies, synced_from, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (company_id) DO UPDATE
         SET cookies = EXCLUDED.cookies,
             synced_from = EXCLUDED.synced_from,
             updated_at = NOW()`,
      [req.companyId, JSON.stringify(cookies), synced_from || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /notify-expired — Skynet calls this when Amazon redirects to sign-in
// Sends Craig an SMS so he knows to re-run scripts/capture-amazon-cookies.js
router.post('/notify-expired', requireAuth, requireOwner, async (req, res) => {
  try {
    const owners = await query(
      `SELECT id FROM users WHERE company_id = $1 AND role = 'owner'`,
      [req.companyId]
    );
    const ownerIds = owners.rows.map((r) => r.id);
    const smsResult = await sendSmsToUsers(
      req.companyId,
      ownerIds,
      'Amazon session expired on Skynet. Run scripts/capture-amazon-cookies.js on your Mac to refresh it, then wait up to 12h for auto-sync — or run sync-amazon-session.js manually.',
      ownerIds[0] || null
    );
    res.json({ ok: true, sms: smsResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as amazonSessionRouter };
