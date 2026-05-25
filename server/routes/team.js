/**
 * Shared AI agent endpoints — usable by any bot (Betty, future agents).
 *
 *   POST /api/team/notify   Send an SMS alert to all manager + owner users
 */

import express from 'express';
import { query } from '../db.js';
import { sendSmsToUsers } from '../lib/smsHelper.js';

const router = express.Router();

function cid(req) { return req.companyId || req.user?.company_id; }

// ── POST /api/team/notify ─────────────────────────────────────────────────────
// Any AI agent calls this to SMS all manager + owner users.
// Body: { message: string }
// Returns: { ok, sent, failed, results }
router.post('/notify', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message (string) is required' });
  }

  const companyId = cid(req);

  try {
    const mgrs = await query(
      `SELECT id FROM users
       WHERE company_id = $1
         AND role IN ('manager', 'owner')
         AND phone IS NOT NULL AND phone != ''`,
      [companyId]
    );

    if (!mgrs.rows.length) {
      return res.status(200).json({
        ok: true, sent: 0, failed: 0,
        warning: 'No manager or owner users with phone numbers found.',
      });
    }

    const userIds = mgrs.rows.map((r) => r.id);
    const result  = await sendSmsToUsers(companyId, userIds, message.trim(), null);

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as teamRouter };
