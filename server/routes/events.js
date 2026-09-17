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
import { sendSmsToPhone } from '../lib/smsHelper.js';
import { MARKS, DEFAULTS, render } from '../lib/talentReminders.js';
import { logEventActivity, getEventActivity, getCompanyActivity } from '../lib/eventActivity.js';

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
    const posted = (r.touched || []).filter((t) => t.action === 'posted').map((t) => t.key);
    if (posted.length) logEventActivity(cId(req), req.userId, 'announced', { eventId: req.params.id, detail: `pushed ${posted.length} channel${posted.length === 1 ? '' : 's'}`, meta: { channels: posted } });
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
    if ((r.scheduled || []).length) logEventActivity(cId(req), req.userId, 'scheduled', { eventId: req.params.id, detail: `scheduled ${r.scheduled.length} channel${r.scheduled.length === 1 ? '' : 's'}` });
    res.json(r);
  } catch (e) { console.error('distribution schedule', e); res.status(500).json({ error: e.message }); }
});

// Compose context for texting the event's talent: the assigned musician's
// name/phone and the three reminder templates rendered for this event, so a
// person can send a reminder now (to test) or edit it into a custom message.
eventsRouter.get('/:id/message', async (req, res) => {
  try {
    const ev = (await query(
      `SELECT e.id, e.title, m.id AS musician_id, m.name AS talent_name, m.phone,
              l.name AS location_name,
              to_char(e.start_at AT TIME ZONE 'America/Denver','FMMon FMDD') AS date_str,
              to_char(e.start_at AT TIME ZONE 'America/Denver','FMHH12:MI AM') AS time_str
         FROM events e
         LEFT JOIN musicians m ON m.id = e.musician_id
         LEFT JOIN locations l ON l.id = e.location_id
        WHERE e.id = $1 AND e.company_id = $2`, [req.params.id, cId(req)])).rows[0];
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    const s = (await query(
      `SELECT reminder_msg_month, reminder_msg_week, reminder_msg_day
         FROM scheduling_settings WHERE company_id = $1`, [cId(req)])).rows[0] || {};
    const templates = {};
    for (const mk of MARKS) templates[mk.key] = render(s[mk.tpl] || DEFAULTS[mk.tpl], ev);
    res.json({
      talent: ev.musician_id ? { id: ev.musician_id, name: ev.talent_name, phone: ev.phone } : null,
      templates,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send a text now from the event. Body: { body, to? }. Defaults to the event's
// talent phone; `to` overrides (e.g. a test number). Logs to sms_log.
eventsRouter.post('/:id/message', async (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message body is required' });
  try {
    let to = String(req.body?.to || '').trim();
    if (!to) {
      const ev = (await query(
        `SELECT m.phone FROM events e LEFT JOIN musicians m ON m.id = e.musician_id
          WHERE e.id = $1 AND e.company_id = $2`, [req.params.id, cId(req)])).rows[0];
      to = ev?.phone || '';
    }
    if (!to) return res.status(400).json({ error: 'No phone number — assign talent with a phone, or enter a number.' });
    const r = await sendSmsToPhone(cId(req), to, body, req.userId || null);
    if (!r.ok) return res.status(502).json({ error: r.reason || 'Send failed' });
    res.json({ ok: true, sid: r.sid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-event audit history, newest first.
eventsRouter.get('/:id/activity', async (req, res) => {
  try { res.json({ activity: await getEventActivity(cId(req), req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Company-wide audit feed. Query: ?actor=Name&action=verb
eventsRouter.get('/activity/feed', async (req, res) => {
  try { res.json({ activity: await getCompanyActivity(cId(req), { actor: req.query.actor, action: req.query.action }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-event channel on/off. Body: { enabled: bool }. Writes an override row so
// this event skips (or re-includes) a channel; announce/schedule respect it.
eventsRouter.put('/:id/distribution/channels/:key', async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
  try {
    const ok = await query(`SELECT 1 FROM events WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]);
    if (!ok.rows.length) return res.status(404).json({ error: 'Event not found' });
    await query(
      `INSERT INTO event_channel_prefs (company_id, event_id, channel_key, enabled, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (event_id, channel_key) DO UPDATE
         SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [cId(req), req.params.id, req.params.key, enabled, req.userId || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        WHERE t.event_id = $1 AND t.company_id = $2 AND t.deleted_at IS NULL
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
    logEventActivity(cId(req), req.userId, 'task_added', { eventId: req.params.id, detail: `“${title.trim()}”` });
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
    // Soft-delete → Trash rather than destroy. Restorable via /tasks/:taskId/restore.
    const r = await query(
      `UPDATE event_tasks SET deleted_at = NOW(), deleted_by = $3
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
        RETURNING event_id, title`, [req.params.taskId, cId(req), req.userId || null]);
    const t = r.rows[0];
    if (t) {
      const ev = (await query(`SELECT title FROM events WHERE id = $1`, [t.event_id])).rows[0];
      logEventActivity(cId(req), req.userId, 'task_deleted', { eventId: t.event_id, eventTitle: ev?.title, detail: `“${t.title}”` });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restore a trashed task.
eventsRouter.post('/tasks/:taskId/restore', async (req, res) => {
  try {
    const r = await query(
      `UPDATE event_tasks SET deleted_at = NULL, deleted_by = NULL
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NOT NULL
        RETURNING event_id, title`, [req.params.taskId, cId(req)]);
    const t = r.rows[0];
    if (!t) return res.status(404).json({ error: 'Not a deleted task' });
    logEventActivity(cId(req), req.userId, 'task_restored', { eventId: t.event_id, detail: `“${t.title}”` });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trashed tasks for an event (restorable).
eventsRouter.get('/:id/tasks/deleted', async (req, res) => {
  try {
    const r = await query(
      `SELECT t.id, t.checklist, t.title, t.deleted_at, u.display_name AS deleted_by_name
         FROM event_tasks t LEFT JOIN users u ON u.id = t.deleted_by
        WHERE t.event_id = $1 AND t.company_id = $2 AND t.deleted_at IS NOT NULL
        ORDER BY t.deleted_at DESC`, [req.params.id, cId(req)]);
    res.json(r.rows);
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
    logEventActivity(cId(req), req.userId, 'created', { eventId: id, eventTitle: req.body.title });
    res.json({ id });
  } catch (e) { console.error('event create', e); res.status(500).json({ error: e.message }); }
});

// Human labels for the fields we announce in the audit log.
const FIELD_LABEL = { location_id: 'venue', musician_id: 'talent', title: 'title', description: 'description',
  start_at: 'date/time', end_at: 'end time', all_day: 'all-day', cost: 'cost', event_url: 'ticket URL',
  image_url: 'image', social_image_url: 'social image', fb_image_url: 'Facebook image', category: 'category',
  status: 'status', internal_notes: 'internal notes' };

eventsRouter.patch('/:id', async (req, res) => {
  try {
    const cur = (await query(`SELECT title, start_at, status FROM events WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)])).rows[0];
    const sets = [], vals = [];
    for (const f of EV_FIELDS) if (f in req.body) { vals.push(req.body[f] === '' ? null : req.body[f]); sets.push(`${f} = $${vals.length}`); }
    // Regenerate the slug if the title or start date changed.
    if ('title' in req.body || 'start_at' in req.body) {
      if (cur) {
        const base = makeSlug(req.body.title ?? cur.title, req.body.start_at ?? cur.start_at);
        const s = await uniqueSlug(cId(req), base, req.params.id);
        vals.push(s); sets.push(`slug = $${vals.length}`);
      }
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id, cId(req));
    await query(`UPDATE events SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);

    // Audit: a status flip is its own verb; otherwise list the fields that changed.
    const title = req.body.title ?? cur?.title;
    if ('status' in req.body && cur && req.body.status !== cur.status) {
      const verb = req.body.status === 'published' ? 'published' : (cur.status === 'published' ? 'unpublished' : 'edited');
      logEventActivity(cId(req), req.userId, verb, { eventId: req.params.id, eventTitle: title, meta: { from: cur.status, to: req.body.status } });
    } else {
      const changed = EV_FIELDS.filter((f) => f in req.body && f !== 'status').map((f) => FIELD_LABEL[f] || f);
      if (changed.length) logEventActivity(cId(req), req.userId, 'edited', { eventId: req.params.id, eventTitle: title, detail: changed.join(', ') });
    }
    res.json({ ok: true });
  } catch (e) { console.error('event patch', e); res.status(500).json({ error: e.message }); }
});

// Marks the event deleted; the row is kept. A plain DELETE would also be
// converted by the INSTEAD OF trigger on the events view, but writing the
// UPDATE here is what records WHO removed it -- a trigger cannot see the
// request. `deleted` events disappear from every read, because `events` is a
// view over the undeleted rows.
eventsRouter.delete('/:id', async (req, res) => {
  try {
    const r = await query(
      `UPDATE events_all SET deleted_at = NOW(), deleted_by = $3, updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
        RETURNING id, title`,
      [req.params.id, cId(req), req.userId || null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No such event' });
    logEventActivity(cId(req), req.userId, 'deleted', { eventId: r.rows[0].id, eventTitle: r.rows[0].title });
    res.json({ ok: true, deleted: r.rows[0] });
  } catch (e) { console.error('event delete', e); res.status(500).json({ error: e.message }); }
});

// What has been removed, and by whom. This is the question that could not be
// answered before: "was there ever a fire department booking on the 11th?"
eventsRouter.get('/deleted/list', async (req, res) => {
  try {
    const r = await query(
      `SELECT e.id, e.title, e.start_at, e.status, e.deleted_at,
              u.display_name AS deleted_by_name, l.name AS location
         FROM events_all e
         LEFT JOIN users u ON u.id = e.deleted_by
         LEFT JOIN locations l ON l.id = e.location_id
        WHERE e.company_id = $1 AND e.deleted_at IS NOT NULL
        ORDER BY e.deleted_at DESC LIMIT 200`, [cId(req)]);
    res.json({ events: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Put one back.
eventsRouter.post('/:id/restore', async (req, res) => {
  try {
    const r = await query(
      `UPDATE events_all SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NOT NULL
        RETURNING id, title`, [req.params.id, cId(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not a deleted event' });
    logEventActivity(cId(req), req.userId, 'restored', { eventId: r.rows[0].id, eventTitle: r.rows[0].title });
    res.json({ ok: true, restored: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    // Copy the event but NOT the images — each event gets its own artwork — and
    // start it as a fresh draft with no dates.
    const r = await query(
      `INSERT INTO events (company_id, location_id, musician_id, title, description, internal_notes, cost, event_url, image_url, social_image_url, fb_image_url, category, status, start_at, end_at, created_by)
       SELECT company_id, location_id, musician_id, $2, description, internal_notes, cost, event_url, NULL, NULL, NULL, category, 'draft', NULL, NULL, $3
         FROM events WHERE id = $1
       RETURNING id`, [req.params.id, title, req.userId || null]);
    const newId = r.rows[0].id;
    // Carry the checklist over — the run-of-show is the point of duplicating a
    // recurring event. Copy structure only (unchecked, no assignees/dates).
    await query(
      `INSERT INTO event_tasks (company_id, event_id, checklist, title, parent_task_id, sort_order)
       SELECT company_id, $2, checklist, title, NULL, sort_order
         FROM event_tasks WHERE event_id = $1 AND parent_task_id IS NULL AND deleted_at IS NULL`,
      [req.params.id, newId]);
    logEventActivity(cId(req), req.userId, 'duplicated', { eventId: newId, eventTitle: title, detail: `copied from “${base}” (checklist copied, image not)` });
    res.json({ id: newId, title });
  } catch (e) { console.error('event duplicate', e); res.status(500).json({ error: e.message }); }
});
