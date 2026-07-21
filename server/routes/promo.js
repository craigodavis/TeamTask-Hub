import express from 'express';
import { query } from '../db.js';

const cId = (req) => req.companyId;
export const promoRouter = express.Router();

// ── Contacts (orgs/people we email) ──────────────────────────────────────────
const C_FIELDS = ['name', 'org', 'email', 'phone', 'website', 'role', 'notes', 'active'];

promoRouter.get('/contacts', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, org, email, phone, website, role, notes, active
         FROM promo_contacts WHERE company_id = $1 ORDER BY active DESC, org NULLS LAST, name`, [cId(req)]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

promoRouter.post('/contacts', async (req, res) => {
  try {
    if (!req.body.name?.trim()) return res.status(400).json({ error: 'Name is required' });
    const cols = ['company_id'], vals = [cId(req)], ph = ['$1'];
    for (const f of C_FIELDS) if (f in req.body) { cols.push(f); vals.push(req.body[f]); ph.push('$' + vals.length); }
    const r = await query(`INSERT INTO promo_contacts (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING id`, vals);
    res.json({ id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

promoRouter.patch('/contacts/:id', async (req, res) => {
  try {
    const sets = [], vals = [];
    for (const f of C_FIELDS) if (f in req.body) { vals.push(req.body[f]); sets.push(`${f} = $${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id, cId(req));
    await query(`UPDATE promo_contacts SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

promoRouter.delete('/contacts/:id', async (req, res) => {
  try { await query(`DELETE FROM promo_contacts WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Email templates ──────────────────────────────────────────────────────────
promoRouter.get('/templates', async (req, res) => {
  try {
    const r = await query(`SELECT id, name, subject, body_html FROM promo_templates WHERE company_id = $1 ORDER BY name`, [cId(req)]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

promoRouter.post('/templates', async (req, res) => {
  try {
    const { name, subject, body_html } = req.body || {};
    if (!name?.trim() || !subject?.trim()) return res.status(400).json({ error: 'Name and subject are required' });
    const r = await query(
      `INSERT INTO promo_templates (company_id, name, subject, body_html) VALUES ($1,$2,$3,$4) RETURNING id`,
      [cId(req), name.trim(), subject, body_html || '']);
    res.json({ id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

promoRouter.patch('/templates/:id', async (req, res) => {
  try {
    const sets = [], vals = [];
    for (const f of ['name', 'subject', 'body_html']) if (f in req.body) { vals.push(req.body[f]); sets.push(`${f} = $${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id, cId(req));
    await query(`UPDATE promo_templates SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

promoRouter.delete('/templates/:id', async (req, res) => {
  try { await query(`DELETE FROM promo_templates WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
