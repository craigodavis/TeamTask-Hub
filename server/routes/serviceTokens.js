/**
 * Service Tokens — named, revocable API keys for agents and integrations.
 *
 * Tokens are prefixed with `thk_` and stored as SHA-256 hashes.
 * The raw token is returned ONCE at creation and never stored.
 *
 * Routes (owner only):
 *   GET    /api/service-tokens          list tokens (no raw value)
 *   POST   /api/service-tokens          create token (returns raw value once)
 *   DELETE /api/service-tokens/:id      revoke token
 */

import express from 'express';
import crypto from 'crypto';
import { query } from '../db.js';

const router = express.Router();

function cid(req) { return req.companyId || req.user?.company_id; }

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// GET /api/service-tokens
router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT st.id, st.name, st.role, st.created_at, st.last_used_at, st.revoked_at,
              u.display_name AS created_by_name
       FROM service_tokens st
       LEFT JOIN users u ON u.id = st.created_by
       WHERE st.company_id = $1
       ORDER BY st.created_at DESC`,
      [cid(req)]
    );
    res.json({ tokens: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/service-tokens
router.post('/', async (req, res) => {
  const { name, role = 'manager' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!['manager', 'owner'].includes(role)) return res.status(400).json({ error: 'role must be manager or owner' });

  // Generate token: thk_ + 32 random bytes hex = 68 chars total
  const raw = 'thk_' + crypto.randomBytes(32).toString('hex');
  const hash = hashToken(raw);

  try {
    const r = await query(
      `INSERT INTO service_tokens (company_id, name, token_hash, role, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, role, created_at`,
      [cid(req), name.trim(), hash, role, req.userId || null]
    );
    // Return the raw token ONCE — it is never stored and cannot be retrieved again
    res.json({ token: { ...r.rows[0], raw } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/service-tokens/:id  (revoke — soft delete so last_used_at history is preserved)
router.delete('/:id', async (req, res) => {
  try {
    const r = await query(
      `UPDATE service_tokens SET revoked_at = NOW()
       WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Token not found or already revoked' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as serviceTokensRouter };
