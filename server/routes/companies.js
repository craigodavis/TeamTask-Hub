import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';

const router = express.Router();

// List users in current company (managers see all; members could be restricted)
router.get('/:companyId/users', async (req, res) => {
  try {
    const { companyId } = req.params;
    if (req.companyId !== companyId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const r = await query(
      `SELECT id, company_id, email, display_name, role, phone, square_team_member_id, created_at
       FROM users WHERE company_id = $1 ORDER BY display_name, email`,
      [companyId]
    );
    res.json({ users: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user (role, display_name, or set password) — manager/owner only; user must be in same company
router.patch('/:companyId/users/:userId', requireManager, async (req, res) => {
  try {
    const { companyId, userId } = req.params;
    if (req.companyId !== companyId) return res.status(403).json({ error: 'Forbidden' });
    const { role, display_name, password } = req.body;

    const existing = await query(
      `SELECT id FROM users WHERE id = $1 AND company_id = $2`,
      [userId, companyId]
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
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    params.push(userId);
    await query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${p}`,
      params
    );
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
