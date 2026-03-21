import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';

const router = express.Router();

// List users in current company (managers see all; members could be restricted). Includes location_ids per user.
router.get('/:companyId/users', async (req, res) => {
  try {
    const { companyId: paramCompanyId } = req.params;
    if (req.companyId !== paramCompanyId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const r = await query(
      `SELECT u.id, u.company_id, u.email, u.display_name, u.role, u.phone, u.square_team_member_id, u.created_at,
              COALESCE(
                (SELECT array_agg(ul.location_id ORDER BY ul.location_id) FROM user_locations ul WHERE ul.user_id = u.id),
                ARRAY[]::uuid[]
              ) AS location_ids
       FROM users u
       WHERE u.company_id = $1 ORDER BY u.display_name, u.email`,
      [paramCompanyId]
    );
    const users = r.rows.map((row) => ({
      ...row,
      location_ids: row.location_ids || [],
    }));
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user (role, display_name, password, location_ids) — manager/owner only; user must be in same company
router.patch('/:companyId/users/:userId', requireManager, async (req, res) => {
  try {
    const { companyId: paramCompanyId, userId } = req.params;
    if (req.companyId !== paramCompanyId) return res.status(403).json({ error: 'Forbidden' });
    const { role, display_name, password, location_ids } = req.body;

    const existing = await query(
      `SELECT id FROM users WHERE id = $1 AND company_id = $2`,
      [userId, paramCompanyId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const updates = [];
    const params = [];
    let p = 1;
    if (role !== undefined && ['member', 'manager', 'owner'].includes(role)) {
      updates.push(`role = $${p++}`);
      params.push(role);
    }
    if (display_name !== undefined) {
      updates.push(`display_name = $${p++}`);
      params.push(display_name === '' ? null : display_name);
    }
    if (password !== undefined && String(password).trim()) {
      const hash = await bcrypt.hash(String(password).trim(), 10);
      updates.push(`password_hash = $${p++}`);
      params.push(hash);
    }
    if (updates.length === 0 && location_ids === undefined) return res.status(400).json({ error: 'No valid fields to update' });

    if (updates.length > 0) {
      params.push(userId);
      await query(
        `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${p}`,
        params
      );
    }

    if (location_ids !== undefined) {
      const ids = Array.isArray(location_ids) ? location_ids : [];
      await query(`DELETE FROM user_locations WHERE user_id = $1`, [userId]);
      if (ids.length > 0) {
        const valid = await query(
          `SELECT id FROM locations WHERE id = ANY($1::uuid[]) AND company_id = $2`,
          [ids, paramCompanyId]
        );
        const validIds = valid.rows.map((row) => row.id);
        for (const lid of validIds) {
          await query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, lid]);
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete user — manager/owner only; user must be in same company; cannot delete self
router.delete('/:companyId/users/:userId', requireManager, async (req, res) => {
  try {
    const { companyId, userId } = req.params;
    if (req.companyId !== companyId) return res.status(403).json({ error: 'Forbidden' });
    if (req.userId === userId) return res.status(400).json({ error: 'Cannot delete your own account' });

    const existing = await query(
      `SELECT id FROM users WHERE id = $1 AND company_id = $2`,
      [userId, companyId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await query(`DELETE FROM users WHERE id = $1 AND company_id = $2`, [userId, companyId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create company (e.g. for onboarding - or seed manually)
router.post('/', requireManager, async (req, res) => {
  try {
    const { name, slug } = req.body;
    if (!name || !slug) {
      return res.status(400).json({ error: 'name and slug required' });
    }
    const r = await query(
      `INSERT INTO companies (name, slug) VALUES ($1, $2)
       RETURNING id, name, slug, created_at`,
      [name, slug]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Company slug already exists' });
    res.status(500).json({ error: err.message });
  }
});

export { router as companiesRouter };
