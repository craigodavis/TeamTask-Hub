/**
 * Event audit log. Append-only: every create, edit, publish, announce, task
 * add/delete, delete/restore and duplicate writes one row to event_activity.
 * Nothing here ever updates or removes a row — a deletion is just another entry,
 * so the history survives even after the event itself is gone.
 *
 * Writes are best-effort: a logging failure must never fail the user's action,
 * so everything is wrapped and swallowed with a console warning.
 */
import { query } from '../db.js';

const nameCache = new Map();
async function actorName(actorId, given) {
  if (given) return given;
  if (!actorId) return null;
  if (nameCache.has(actorId)) return nameCache.get(actorId);
  try {
    const n = (await query(`SELECT display_name FROM users WHERE id = $1`, [actorId])).rows[0]?.display_name || null;
    nameCache.set(actorId, n);
    return n;
  } catch { return null; }
}

/**
 * @param {string} companyId
 * @param {string|null} actorId  user id, or null for system/automation
 * @param {string} action        verb key: created | edited | published | unpublished |
 *                               announced | scheduled | task_added | task_deleted |
 *                               task_restored | deleted | restored | duplicated
 * @param {object} opts { eventId, eventTitle, detail, meta, actorName }
 */
export async function logEventActivity(companyId, actorId, action, opts = {}) {
  try {
    const who = await actorName(actorId, opts.actorName);
    await query(
      `INSERT INTO event_activity (company_id, event_id, event_title, actor_id, actor_name, action, detail, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [companyId, opts.eventId || null, opts.eventTitle || null, actorId || null,
       who, action, opts.detail || null, opts.meta ? JSON.stringify(opts.meta) : null]
    );
  } catch (e) {
    console.warn('[eventActivity] log failed:', e.message);
  }
}

/** Per-event history, newest first. */
export async function getEventActivity(companyId, eventId, limit = 100) {
  const r = await query(
    `SELECT id, actor_name, action, detail, meta, created_at
       FROM event_activity WHERE company_id = $1 AND event_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [companyId, eventId, limit]
  );
  return r.rows;
}

/** Company-wide audit feed with optional actor/action filters. */
export async function getCompanyActivity(companyId, { actor, action, limit = 200 } = {}) {
  const where = ['company_id = $1'];
  const vals = [companyId];
  if (actor)  { vals.push(actor);  where.push(`actor_name = $${vals.length}`); }
  if (action) { vals.push(action); where.push(`action = $${vals.length}`); }
  vals.push(Math.min(limit, 500));
  const r = await query(
    `SELECT id, event_id, event_title, actor_name, action, detail, meta, created_at
       FROM event_activity WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT $${vals.length}`,
    vals
  );
  return r.rows;
}
