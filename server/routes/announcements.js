import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';

const router = express.Router();
const companyId = (req) => req.companyId;

// Active announcements for main screen (effective today or in range); includes my_acknowledged_at
router.get('/active', async (req, res) => {
  try {
    const { date } = req.query;
    const d = date || new Date().toISOString().slice(0, 10);
    const r = await query(
      `SELECT a.id, a.company_id, a.title, a.body, a.effective_from, a.effective_until, a.created_by, a.created_at,
              aa.acknowledged_at AS my_acknowledged_at
       FROM announcements a
       LEFT JOIN announcement_acknowledgments aa ON aa.announcement_id = a.id AND aa.user_id = $2
       WHERE a.company_id = $1 AND a.effective_from <= $3::date AND a.effective_until >= $3::date
       ORDER BY a.created_at DESC`,
      [companyId(req), req.userId, d]
    );
    const announcements = r.rows.map((row) => {
      const { my_acknowledged_at, ...rest } = row;
      return { ...rest, my_acknowledged_at: my_acknowledged_at || null };
    });
    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all announcements (manager; optional date filter)
router.get('/', async (req, res) => {
  try {
    const { from, to } = req.query;
    let q = `SELECT a.id, a.company_id, a.title, a.body, a.effective_from, a.effective_until, a.created_by, a.created_at,
                    u.display_name as created_by_name
             FROM announcements a
             LEFT JOIN users u ON u.id = a.created_by
             WHERE a.company_id = $1`;
    const params = [companyId(req)];
    if (from) { q += ` AND a.effective_until >= $${params.length + 1}::date`; params.push(from); }
    if (to) { q += ` AND a.effective_from <= $${params.length + 1}::date`; params.push(to); }
    q += ` ORDER BY a.effective_from DESC, a.created_at DESC`;
    const r = await query(q, params);
    res.json({ announcements: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireManager, async (req, res) => {
  try {
    const { title, body, effective_from, effective_until } = req.body;
    if (!title || !effective_from || !effective_until) {
      return res.status(400).json({ error: 'title, effective_from, effective_until required' });
    }
    const r = await query(
      `INSERT INTO announcements (company_id, title, body, effective_from, effective_until, created_by)
       VALUES ($1, $2, $3, $4::date, $5::date, $6)
       RETURNING id, company_id, title, body, effective_from, effective_until, created_by, created_at`,
      [companyId(req), title, body || null, effective_from, effective_until, req.userId]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, body, effective_from, effective_until } = req.body;
    const r = await query(
      `UPDATE announcements SET
         title = COALESCE($2, title), body = COALESCE($3, body),
         effective_from = COALESCE($4::date, effective_from), effective_until = COALESCE($5::date, effective_until),
         updated_at = NOW()
       WHERE id = $1 AND company_id = $6
       RETURNING id, company_id, title, body, effective_from, effective_until, created_by, updated_at`,
      [id, title, body, effective_from, effective_until, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `DELETE FROM announcements WHERE id = $1 AND company_id = $2 RETURNING id`,
      [id, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Acknowledge read (current user)
router.post('/:id/acknowledge', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `INSERT INTO announcement_acknowledgments (announcement_id, user_id)
       SELECT $1, $2 FROM announcements WHERE id = $1 AND company_id = $3
       ON CONFLICT (announcement_id, user_id) DO NOTHING
       RETURNING id, announcement_id, user_id, acknowledged_at`,
      [id, req.userId, companyId(req)]
    );
    if (r.rows.length === 0) {
      const check = await query(`SELECT 1 FROM announcements WHERE id = $1 AND company_id = $2`, [id, companyId(req)]);
      if (check.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' });
      const existing = await query(`SELECT id, acknowledged_at FROM announcement_acknowledgments WHERE announcement_id = $1 AND user_id = $2`, [id, req.userId]);
      return res.json(existing.rows[0] || { acknowledged: true });
    }
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Who read (manager)
router.get('/:id/acknowledgments', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `SELECT aa.id, aa.user_id, aa.acknowledged_at, u.display_name, u.email
       FROM announcement_acknowledgments aa
       JOIN users u ON u.id = aa.user_id
       JOIN announcements a ON a.id = aa.announcement_id AND a.company_id = $1
       WHERE aa.announcement_id = $2
       ORDER BY aa.acknowledged_at DESC`,
      [companyId(req), id]
    );
    res.json({ acknowledgments: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as announcementsRouter };
