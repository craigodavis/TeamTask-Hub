import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';

const router = express.Router();
const companyId = (req) => req.companyId;

// List locations for current company
router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, company_id, name, created_at
       FROM locations WHERE company_id = $1 ORDER BY name`,
      [companyId(req)]
    );
    res.json({ locations: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create location (manager/owner only)
router.post('/', requireManager, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || String(name).trim() === '') {
      return res.status(400).json({ error: 'name required' });
    }
    const r = await query(
      `INSERT INTO locations (company_id, name) VALUES ($1, $2)
       RETURNING id, company_id, name, created_at`,
      [companyId(req), String(name).trim()]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Location name already exists for this company' });
    res.status(500).json({ error: err.message });
  }
});

// Update location name (manager/owner only)
router.patch('/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || String(name).trim() === '') {
      return res.status(400).json({ error: 'name required' });
    }
    const r = await query(
      `UPDATE locations SET name = $2
       WHERE id = $1 AND company_id = $3
       RETURNING id, company_id, name, created_at`,
      [id, String(name).trim(), companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Location not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Location name already exists for this company' });
    res.status(500).json({ error: err.message });
  }
});

// Delete location (manager/owner only); junction tables remove rows via ON DELETE CASCADE
router.delete('/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `DELETE FROM locations WHERE id = $1 AND company_id = $2 RETURNING id`,
      [id, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Location not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as locationsRouter };
