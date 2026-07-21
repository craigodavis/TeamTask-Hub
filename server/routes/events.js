import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { syncEventToWp, removeEventFromWp } from '../lib/wpEventPush.js';

const cId = (req) => req.companyId;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const eventUploadsDir = path.join(__dirname, '..', 'uploads', 'events');
fs.mkdirSync(eventUploadsDir, { recursive: true });
const imgUpload = multer({
  storage: multer.diskStorage({
    destination: eventUploadsDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase() || '.jpg'}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only image files are allowed'))),
});

// ── Musicians ────────────────────────────────────────────────────────────────
export const musiciansRouter = express.Router();

musiciansRouter.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, type, stage_name, bio, photo_url, website_url, links, rate_amount, rate_unit,
              phone, email, lift_pct, lift_nights, notes, active
         FROM musicians WHERE company_id = $1 ORDER BY active DESC, lift_pct DESC NULLS LAST, name`, [cId(req)]);
    res.json(r.rows);
  } catch (e) { console.error('musicians list', e); res.status(500).json({ error: e.message }); }
});

const MUS_FIELDS = ['name', 'type', 'stage_name', 'bio', 'photo_url', 'website_url', 'links', 'rate_amount', 'rate_unit', 'phone', 'email', 'notes', 'active'];
musiciansRouter.post('/', async (req, res) => {
  try {
    if (!req.body.name?.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!req.body.phone?.trim()) return res.status(400).json({ error: 'Phone is required (we text talent event reminders)' });
    const cols = ['company_id'], vals = [cId(req)], ph = ['$1'];
    for (const f of MUS_FIELDS) if (f in req.body) {
      cols.push(f); vals.push(f === 'links' ? JSON.stringify(req.body[f] || []) : req.body[f]); ph.push('$' + vals.length);
    }
    const r = await query(`INSERT INTO musicians (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING id`, vals);
    res.json({ id: r.rows[0].id });
  } catch (e) { console.error('musician create', e); res.status(500).json({ error: e.message }); }
});

musiciansRouter.patch('/:id', async (req, res) => {
  try {
    const sets = [], vals = [];
    for (const f of MUS_FIELDS) if (f in req.body) {
      vals.push(f === 'links' ? JSON.stringify(req.body[f] || []) : req.body[f]);
      sets.push(`${f} = $${vals.length}`);
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id, cId(req));
    await query(`UPDATE musicians SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { console.error('musician patch', e); res.status(500).json({ error: e.message }); }
});

// ── Events ───────────────────────────────────────────────────────────────────
export const eventsRouter = express.Router();

eventsRouter.get('/', async (req, res) => {
  try {
    const past = req.query.range === 'all' || req.query.range === 'past';
    const where = past ? '' : `AND e.start_at >= NOW() - INTERVAL '1 day'`;
    const order = past ? 'DESC' : 'ASC';
    const r = await query(
      `SELECT e.id, e.title, e.description, e.internal_notes, e.start_at, e.end_at, e.all_day, e.cost, e.event_url, e.image_url,
              e.category, e.status, e.wp_event_id, e.location_id, e.musician_id,
              l.name AS location_name, m.name AS musician_name, m.lift_pct
         FROM events e
         LEFT JOIN locations l ON l.id = e.location_id
         LEFT JOIN musicians m ON m.id = e.musician_id
        WHERE e.company_id = $1 ${where}
        ORDER BY e.start_at ${order} LIMIT 300`, [cId(req)]);
    res.json(r.rows);
  } catch (e) { console.error('events list', e); res.status(500).json({ error: e.message }); }
});

eventsRouter.post('/upload-image', imgUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  res.json({ url: `/api/uploads/events/${req.file.filename}` });
});

// Internal-only fields (notes, tasks) are never included in the WordPress push.
const EV_FIELDS = ['location_id', 'musician_id', 'title', 'description', 'start_at', 'end_at', 'all_day', 'cost', 'event_url', 'image_url', 'category', 'status', 'internal_notes'];

// Employees assignable to event tasks
eventsRouter.get('/assignable-users', async (req, res) => {
  try {
    const r = await query(`SELECT id, display_name FROM users WHERE company_id = $1 ORDER BY display_name`, [cId(req)]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tasks / named checklists on an event (internal — never promoted)
eventsRouter.get('/:id/tasks', async (req, res) => {
  try {
    const r = await query(
      `SELECT t.id, t.checklist, t.title, t.assignee_user_id, t.done, t.sort_order, u.display_name AS assignee_name
         FROM event_tasks t LEFT JOIN users u ON u.id = t.assignee_user_id
        WHERE t.event_id = $1 AND t.company_id = $2
        ORDER BY t.checklist, t.sort_order, t.created_at`, [req.params.id, cId(req)]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

eventsRouter.post('/:id/tasks', async (req, res) => {
  try {
    const { checklist, title, assignee_user_id } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: 'Task title is required' });
    const r = await query(
      `INSERT INTO event_tasks (company_id, event_id, checklist, title, assignee_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [cId(req), req.params.id, (checklist || 'Checklist').slice(0, 80), title.trim(), assignee_user_id || null]);
    res.json({ id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

eventsRouter.patch('/tasks/:taskId', async (req, res) => {
  try {
    const b = req.body || {}, sets = [], vals = [];
    const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if ('checklist' in b) add('checklist', (b.checklist || 'Checklist').slice(0, 80));
    if ('title' in b) add('title', b.title);
    if ('assignee_user_id' in b) add('assignee_user_id', b.assignee_user_id || null);
    if ('sort_order' in b) add('sort_order', b.sort_order);
    if ('done' in b) { add('done', !!b.done); add('done_at', b.done ? new Date() : null); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.taskId, cId(req));
    await query(`UPDATE event_tasks SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

eventsRouter.delete('/tasks/:taskId', async (req, res) => {
  try {
    await query(`DELETE FROM event_tasks WHERE id = $1 AND company_id = $2`, [req.params.taskId, cId(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
eventsRouter.post('/', async (req, res) => {
  try {
    if (!req.body.title?.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!req.body.start_at) return res.status(400).json({ error: 'Start date/time is required' });
    const cols = ['company_id', 'created_by'], vals = [cId(req), req.userId || null], ph = ['$1', '$2'];
    for (const f of EV_FIELDS) if (f in req.body && req.body[f] !== '') {
      cols.push(f); vals.push(req.body[f]); ph.push('$' + vals.length);
    }
    const r = await query(`INSERT INTO events (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING id`, vals);
    const id = r.rows[0].id;
    if (req.body.status === 'published') syncEventToWp(cId(req), id).catch((e) => console.error('wp push (create)', e.message));
    res.json({ id });
  } catch (e) { console.error('event create', e); res.status(500).json({ error: e.message }); }
});

eventsRouter.patch('/:id', async (req, res) => {
  try {
    const sets = [], vals = [];
    for (const f of EV_FIELDS) if (f in req.body) { vals.push(req.body[f] === '' ? null : req.body[f]); sets.push(`${f} = $${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id, cId(req));
    await query(`UPDATE events SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
    // Reconcile the website copy: published → push/update; back to draft (with a prior push) → remove.
    const ev = (await query(`SELECT status, wp_event_id FROM events WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)])).rows[0];
    if (ev) {
      if (ev.status === 'published') syncEventToWp(cId(req), req.params.id).catch((e) => console.error('wp push (update)', e.message));
      else if (ev.wp_event_id) removeEventFromWp(cId(req), req.params.id, ev.wp_event_id).catch((e) => console.error('wp unpublish', e.message));
    }
    res.json({ ok: true });
  } catch (e) { console.error('event patch', e); res.status(500).json({ error: e.message }); }
});

eventsRouter.delete('/:id', async (req, res) => {
  try {
    const ev = (await query(`SELECT wp_event_id FROM events WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)])).rows[0];
    await query(`DELETE FROM events WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]);
    if (ev?.wp_event_id) removeEventFromWp(cId(req), req.params.id, ev.wp_event_id).catch((e) => console.error('wp delete', e.message));
    res.json({ ok: true });
  } catch (e) { console.error('event delete', e); res.status(500).json({ error: e.message }); }
});
