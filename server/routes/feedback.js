// Public post-shift feedback endpoint (no auth — the token identifies the row,
// the user's PIN authenticates the submission). Mounted at /api/feedback.
import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';

const router = express.Router();

// GET /api/feedback/:token — context for the form
router.get('/:token', async (req, res) => {
  try {
    const r = await query(
      `SELECT df.work_date, df.responded_at, u.display_name, l.name AS location
         FROM day_feedback df
         LEFT JOIN users u ON u.id = df.user_id
         LEFT JOIN locations l ON l.id = df.location_id
        WHERE df.token = $1`, [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'This feedback link is not valid.' });
    const row = r.rows[0];
    res.json({
      work_date: row.work_date,
      location: row.location || null,
      name: (row.display_name || '').split(' ')[0] || null,
      responded: !!row.responded_at,
    });
  } catch (e) { console.error('feedback get', e); res.status(500).json({ error: e.message }); }
});

// POST /api/feedback/:token — submit { pin, sentiment(1-3), staffing, note }
router.post('/:token', async (req, res) => {
  try {
    const { pin, sentiment, staffing, note } = req.body || {};
    const r = await query(
      `SELECT df.id, u.pin_hash FROM day_feedback df JOIN users u ON u.id = df.user_id WHERE df.token = $1`,
      [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'This feedback link is not valid.' });
    const row = r.rows[0];
    if (!row.pin_hash) return res.status(400).json({ error: 'No PIN is set on your account — set one in the app first.' });
    const ok = await bcrypt.compare(String(pin || ''), row.pin_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect PIN.' });
    const sent = [1, 2, 3].includes(Number(sentiment)) ? Number(sentiment) : null;
    const staff = ['over', 'right', 'under'].includes(staffing) ? staffing : null;
    await query(
      `UPDATE day_feedback SET sentiment = $1, staffing = $2, note = $3, responded_at = NOW() WHERE id = $4`,
      [sent, staff, (note || '').toString().slice(0, 500), row.id]);
    res.json({ ok: true });
  } catch (e) { console.error('feedback post', e); res.status(500).json({ error: e.message }); }
});

export { router as feedbackRouter };
