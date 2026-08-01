import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';

const router = express.Router();
const companyId = (req) => req.companyId;

// List locations for current company (includes square_location_id for UI picker)
router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, company_id, name, square_location_id, allows_library, created_at
       FROM locations WHERE company_id = $1 ORDER BY name`,
      [companyId(req)]
    );
    res.json({ locations: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List Square locations (for the location-picker UI)
router.get('/square', requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name FROM team_square.location ORDER BY name`
    );
    res.json({ locations: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create location (manager/owner only)
router.post('/', requireManager, async (req, res) => {
  try {
    const { name, square_location_id } = req.body;
    if (!name || String(name).trim() === '') {
      return res.status(400).json({ error: 'name required' });
    }
    const r = await query(
      `INSERT INTO locations (company_id, name, square_location_id) VALUES ($1, $2, $3)
       RETURNING id, company_id, name, square_location_id, created_at`,
      [companyId(req), String(name).trim(), square_location_id || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Location name already exists for this company' });
    res.status(500).json({ error: err.message });
  }
});

// Update location (manager/owner only)
router.patch('/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, square_location_id } = req.body;
    if (!name || String(name).trim() === '') {
      return res.status(400).json({ error: 'name required' });
    }
    const r = await query(
      `UPDATE locations SET
         name = $2,
         square_location_id = COALESCE($3, square_location_id)
       WHERE id = $1 AND company_id = $4
       RETURNING id, company_id, name, square_location_id, created_at`,
      [id, String(name).trim(), square_location_id !== undefined ? (square_location_id || null) : undefined, companyId(req)]
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
