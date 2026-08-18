import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
// There is no push-to-WordPress path, by design. The production calendar is
// maintained by hand in WordPress and is the source of truth; TeamHub events feed
// preview.kindredvineyards.com, which pulls from /api/website at build time.
//
// lib/wpEventPush.js and wp-bridge/tec-sync.php used to do this and were deleted
// rather than left dormant. They shelled out to wp-cli against the live docroot
// (/home/kindredv/public_html), so nothing stood between calling that function and
// rewriting the live calendar — no API, no review, no undo. A commented-out warning
// only works while someone reads it. Reading the other direction is still fine and
// still supported: scripts/reconcile-events-from-wp.js.
import { sendOnePromoEmail } from '../lib/promoEmailSender.js';
import { getDistribution, announce, markPost, scheduleAnnounce } from '../lib/eventDistribution.js';

const cId = (req) => req.companyId;

// Readable event slug for website detail URLs, e.g. "august-nights-2026-08-01".
function makeSlug(title, startAt) {
  const base = String(title || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180) || 'event';
  const d = startAt ? new Date(startAt) : null;
  const datePart = d && !isNaN(d.valueOf()) ? d.toISOString().slice(0, 10) : '';
  return datePart ? `${base}-${datePart}` : base;
}
async function uniqueSlug(companyId, base, excludeId) {
  let slug = base;
  for (let n = 2; n <= 50; n++) {
    const params = excludeId ? [companyId, slug, excludeId] : [companyId, slug];
    const r = await query(
      `SELECT 1 FROM events WHERE company_id = $1 AND slug = $2 ${excludeId ? 'AND id <> $3' : ''} LIMIT 1`,
      params
    );
    if (!r.rows.length) return slug;
    slug = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

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
              phone, email, main_contact, write_check_to, address, lift_pct, lift_nights, notes, active
         FROM musicians WHERE company_id = $1 ORDER BY active DESC, lift_pct DESC NULLS LAST, name`, [cId(req)]);
    res.json(r.rows);
  } catch (e) { console.error('musicians list', e); res.status(500).json({ error: e.message }); }
});

const MUS_FIELDS = ['name', 'type', 'stage_name', 'bio', 'photo_url', 'website_url', 'links', 'rate_amount', 'rate_unit', 'phone', 'email', 'main_contact', 'write_check_to', 'address', 'notes', 'active'];
musiciansRouter.post('/', async (req, res) => {
  try {
    if (!req.body.name?.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!req.body.phone?.trim()) return res.status(400).json({ error: 'Phone is required (we text talent event reminders)' });
    if (!req.body.write_check_to?.trim() && req.body.main_contact?.trim()) req.body.write_check_to = req.body.main_contact.trim();
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
      `SELECT e.id, e.title, e.description, e.internal_notes, e.start_at, e.end_at, e.all_day, e.cost, e.event_url, e.image_url, e.social_image_url, e.fb_image_url,
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
const EV_FIELDS = ['location_id', 'musician_id', 'title', 'description', 'start_at', 'end_at', 'all_day', 'cost', 'event_url', 'image_url', 'social_image_url', 'fb_image_url', 'category', 'status', 'internal_notes'];

// Employees assignable to event tasks
eventsRouter.get('/assignable-users', async (req, res) => {
  try {
    const r = await query(`SELECT id, display_name FROM users WHERE company_id = $1 ORDER BY display_name`, [cId(req)]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Distribution: where this event has been announced ────────────────────────
// Stage 1 posts nothing itself — it tracks state and prepares work for a human.
// See docs/EVENT_DISTRIBUTION.md.
eventsRouter.get('/:id/distribution', async (req, res) => {
  try {
    const d = await getDistribution(cId(req), req.params.id);
    if (!d) return res.status(404).json({ error: 'Event not found' });
    res.json(d);
  } catch (e) { console.error('distribution get', e); res.status(500).json({ error: e.message }); }
});

// Queue channels. Body: { channelKeys?: string[] } — omit to use the enabled set.
eventsRouter.post('/:id/distribution/announce', async (req, res) => {
  try {
    const r = await announce(cId(req), req.params.id, {
      channelKeys: Array.isArray(req.body?.channelKeys) ? req.body.channelKeys : null,
      userId: req.userId,
    });
    res.json(r);
  } catch (e) { console.error('distribution announce', e); res.status(500).json({ error: e.message }); }
});

// Schedule instead of firing now. Body: { leadDays?, channelKeys? }
// leadDays is relative to the event, so it keeps working for events created at
// any notice. Omit it to use each channel's own default.
eventsRouter.post('/:id/distribution/schedule', async (req, res) => {
  const lead = req.body?.leadDays;
  if (lead != null && (!Number.isInteger(lead) || lead < 0 || lead > 365)) {
    return res.status(400).json({ error: 'leadDays must be a whole number of days between 0 and 365' });
  }
  try {
    const r = await scheduleAnnounce(cId(req), req.params.id, {
      leadDays: lead ?? null,
      channelKeys: Array.isArray(req.body?.channelKeys) ? req.body.channelKeys : null,
    });
    res.json(r);
  } catch (e) { console.error('distribution schedule', e); res.status(500).json({ error: e.message }); }
});

// Record that a human posted it (or undo). Body: { status, external_url? }
eventsRouter.patch('/distribution/:postId', async (req, res) => {
  const ALLOWED = ['pending', 'queued', 'posted', 'failed', 'skipped', 'needs_human'];
  if (!ALLOWED.includes(req.body?.status)) {
    return res.status(400).json({ error: `status must be one of ${ALLOWED.join(', ')}` });
  }
  try {
    const row = await markPost(cId(req), req.params.postId, {
      status: req.body.status, external_url: req.body.external_url, userId: req.userId,
    });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { console.error('distribution mark', e); res.status(500).json({ error: e.message }); }
});

// Tasks / named checklists on an event (internal — never promoted)
eventsRouter.get('/:id/tasks', async (req, res) => {
  try {
    const r = await query(
      `SELECT t.id, t.checklist, t.title, t.assignee_user_id, t.done, t.sort_order,
              t.due_date, t.reminder_date, t.parent_task_id, u.display_name AS assignee_name
         FROM event_tasks t LEFT JOIN users u ON u.id = t.assignee_user_id
        WHERE t.event_id = $1 AND t.company_id = $2
        ORDER BY t.checklist, t.sort_order, t.created_at`, [req.params.id, cId(req)]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

eventsRouter.post('/:id/tasks', async (req, res) => {
  try {
    const { checklist, title, assignee_user_id, due_date, reminder_date, parent_task_id } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: 'Task title is required' });
    const cl = (checklist || 'Checklist').slice(0, 80);
    // Next sort_order in a separate query — reusing a param both as an INSERT
    // value and inside a scalar subquery trips Postgres' "inconsistent types".
    const so = (await query(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM event_tasks WHERE event_id = $1 AND checklist = $2`,
      [req.params.id, cl])).rows[0].n;
    const r = await query(
      `INSERT INTO event_tasks (company_id, event_id, checklist, title, assignee_user_id, due_date, reminder_date, parent_task_id, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [cId(req), req.params.id, cl, title.trim(), assignee_user_id || null, due_date || null, reminder_date || null, parent_task_id || null, so]);
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
    if ('due_date' in b) add('due_date', b.due_date || null);
    if ('reminder_date' in b) add('reminder_date', b.reminder_date || null);
    if ('parent_task_id' in b) add('parent_task_id', b.parent_task_id || null);
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

// ── Promotion ticklers (escalating reminders) ────────────────────────────────
eventsRouter.get('/:id/promo-tasks', async (req, res) => {
  try {
    const r = await query(
      `SELECT pt.id, pt.title, pt.channel, pt.assignee_user_id, pt.escalate_to, pt.done, pt.done_at, pt.reminders_sent, u.display_name AS assignee_name
         FROM promo_tasks pt LEFT JOIN users u ON u.id = pt.assignee_user_id
        WHERE pt.event_id = $1 AND pt.company_id = $2 ORDER BY pt.created_at`, [req.params.id, cId(req)]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

eventsRouter.post('/:id/promo-tasks', async (req, res) => {
  try {
    const { title, channel, assignee_user_id, escalate_to } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
    const r = await query(
      `INSERT INTO promo_tasks (company_id, event_id, title, channel, assignee_user_id, escalate_to)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [cId(req), req.params.id, title.trim(), channel || null, assignee_user_id || null, JSON.stringify(Array.isArray(escalate_to) ? escalate_to : [])]);
    res.json({ id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

eventsRouter.patch('/promo-tasks/:tid', async (req, res) => {
  try {
    const b = req.body || {}, sets = [], vals = [];
    const add = (c, v) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
    if ('title' in b) add('title', b.title);
    if ('channel' in b) add('channel', b.channel || null);
    if ('assignee_user_id' in b) add('assignee_user_id', b.assignee_user_id || null);
    if ('escalate_to' in b) add('escalate_to', JSON.stringify(Array.isArray(b.escalate_to) ? b.escalate_to : []));
    if ('done' in b) { add('done', !!b.done); add('done_at', b.done ? new Date() : null); add('done_by', b.done ? (req.userId || null) : null); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.tid, cId(req));
    await query(`UPDATE promo_tasks SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

eventsRouter.delete('/promo-tasks/:tid', async (req, res) => {
  try {
    await query(`DELETE FROM promo_tasks WHERE id = $1 AND company_id = $2`, [req.params.tid, cId(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Scheduled promotion emails on an event ───────────────────────────────────
eventsRouter.get('/:id/emails', async (req, res) => {
  try {
    const r = await query(
      `SELECT pe.id, pe.send_at, pe.status, pe.sent_at, pe.error, pe.contact_id, pe.template_id,
              c.name AS contact_name, c.org, c.email AS contact_email, t.name AS template_name
         FROM promo_emails pe
         LEFT JOIN promo_contacts c ON c.id = pe.contact_id
         LEFT JOIN promo_templates t ON t.id = pe.template_id
        WHERE pe.event_id = $1 AND pe.company_id = $2 ORDER BY pe.send_at`, [req.params.id, cId(req)]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

eventsRouter.post('/:id/emails', async (req, res) => {
  try {
    const { contact_id, template_id, send_at } = req.body || {};
    if (!contact_id || !send_at) return res.status(400).json({ error: 'Contact and send date are required' });
    const r = await query(
      `INSERT INTO promo_emails (company_id, event_id, contact_id, template_id, send_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [cId(req), req.params.id, contact_id, template_id || null, send_at]);
    res.json({ id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

eventsRouter.delete('/emails/:eid', async (req, res) => {
  try { await query(`DELETE FROM promo_emails WHERE id = $1 AND company_id = $2`, [req.params.eid, cId(req)]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

eventsRouter.post('/emails/:eid/send-now', async (req, res) => {
  try {
    const own = await query(`SELECT id FROM promo_emails WHERE id = $1 AND company_id = $2`, [req.params.eid, cId(req)]);
    if (!own.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(await sendOnePromoEmail(req.params.eid));
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
    const slug = await uniqueSlug(cId(req), makeSlug(req.body.title, req.body.start_at));
    cols.push('slug'); vals.push(slug); ph.push('$' + vals.length);
    const r = await query(`INSERT INTO events (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING id`, vals);
    const id = r.rows[0].id;
    res.json({ id });
  } catch (e) { console.error('event create', e); res.status(500).json({ error: e.message }); }
});

eventsRouter.patch('/:id', async (req, res) => {
  try {
    const sets = [], vals = [];
    for (const f of EV_FIELDS) if (f in req.body) { vals.push(req.body[f] === '' ? null : req.body[f]); sets.push(`${f} = $${vals.length}`); }
    // Regenerate the slug if the title or start date changed.
    if ('title' in req.body || 'start_at' in req.body) {
      const cur = (await query(`SELECT title, start_at FROM events WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)])).rows[0];
      if (cur) {
        const base = makeSlug(req.body.title ?? cur.title, req.body.start_at ?? cur.start_at);
        const s = await uniqueSlug(cId(req), base, req.params.id);
        vals.push(s); sets.push(`slug = $${vals.length}`);
      }
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id, cId(req));
    await query(`UPDATE events SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { console.error('event patch', e); res.status(500).json({ error: e.message }); }
});

eventsRouter.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM events WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]);
    res.json({ ok: true });
  } catch (e) { console.error('event delete', e); res.status(500).json({ error: e.message }); }
});

// Duplicate an event: copy fields, blank the dates, force draft, name "<base> -copyN".
eventsRouter.post('/:id/duplicate', async (req, res) => {
  try {
    const src = (await query(`SELECT title FROM events WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)])).rows[0];
    if (!src) return res.status(404).json({ error: 'Event not found' });
    const base = String(src.title || 'Event').replace(/ -copy\d+$/i, '');
    const existing = (await query(`SELECT title FROM events WHERE company_id = $1 AND (title = $2 OR title LIKE $3)`, [cId(req), base, base + ' -copy%'])).rows;
    let max = 0;
    for (const t of existing) { const m = String(t.title).match(/ -copy(\d+)$/i); if (m) max = Math.max(max, Number(m[1])); }
    const title = `${base} -copy${max + 1}`;
    const r = await query(
      `INSERT INTO events (company_id, location_id, musician_id, title, description, internal_notes, cost, event_url, image_url, social_image_url, fb_image_url, category, status, start_at, end_at, created_by)
       SELECT company_id, location_id, musician_id, $2, description, internal_notes, cost, event_url, image_url, social_image_url, fb_image_url, category, 'draft', NULL, NULL, $3
         FROM events WHERE id = $1
       RETURNING id`, [req.params.id, title, req.userId || null]);
    res.json({ id: r.rows[0].id, title });
  } catch (e) { console.error('event duplicate', e); res.status(500).json({ error: e.message }); }
});
