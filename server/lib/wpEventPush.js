/**
 * Pushes TeamHub events to The Events Calendar via the wp-cli bridge (co-located
 * box; the WP REST API is unreachable from here). Publishing writes/updates the
 * event; unpublishing or deleting trashes it. Failures are swallowed and the
 * event is left marked unsynced for a later retry — publishing in TeamHub never
 * fails just because the website push hiccuped.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WP_PATH = process.env.WP_PATH || '/home/kindredv/public_html';
const WP_BIN = process.env.WP_CLI || '/usr/local/bin/wp';
const BRIDGE = path.join(__dirname, '..', 'wp-bridge', 'tec-sync.php');
const UPLOADS = path.join(__dirname, '..', 'uploads', 'events');

function runBridge(payload) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(WP_BIN, ['eval-file', BRIDGE, `--path=${WP_PATH}`], { timeout: 90000 }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      try { resolve(JSON.parse(line)); }
      catch { resolve({ ok: false, error: (err || out || 'no output from bridge').slice(0, 300) }); }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// Build the payload for one event (dates formatted in the venue timezone).
async function payloadForEvent(companyId, eventId) {
  const r = await query(
    `SELECT e.title, e.description, e.status, e.cost, e.event_url, e.image_url, e.category, e.wp_event_id,
            to_char(e.start_at AT TIME ZONE 'America/Denver', 'YYYY-MM-DD HH24:MI:SS') AS start_local,
            to_char(COALESCE(e.end_at, e.start_at) AT TIME ZONE 'America/Denver', 'YYYY-MM-DD HH24:MI:SS') AS end_local,
            l.name AS venue_name
       FROM events e LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.id = $1 AND e.company_id = $2`, [eventId, companyId]);
  if (!r.rows.length) return null;
  const e = r.rows[0];
  const image_path = e.image_url ? path.join(UPLOADS, path.basename(e.image_url)) : null;
  return {
    action: 'upsert',
    wp_event_id: e.wp_event_id || null,
    title: e.title, content: e.description || '', status: e.status,
    start: e.start_local, end: e.end_local, timezone: 'America/Denver',
    venue_name: e.venue_name || null, category: e.category || null,
    cost: e.cost, url: e.event_url || null, image_path,
  };
}

// Publish/update an event on the website. Returns the bridge result.
export async function syncEventToWp(companyId, eventId) {
  const payload = await payloadForEvent(companyId, eventId);
  if (!payload) return { ok: false, error: 'event not found' };
  const res = await runBridge(payload);
  if (res.ok && res.wp_event_id) {
    await query(`UPDATE events SET wp_event_id = $1, wp_synced_at = NOW() WHERE id = $2`, [res.wp_event_id, eventId]);
  }
  return res;
}

// Remove from the website (unpublish → draft, or delete → trash).
export async function removeEventFromWp(companyId, eventId, wpEventId) {
  const id = wpEventId || (await query(`SELECT wp_event_id FROM events WHERE id = $1 AND company_id = $2`, [eventId, companyId])).rows[0]?.wp_event_id;
  if (!id) return { ok: true };
  const res = await runBridge({ action: 'delete', wp_event_id: id });
  if (res.ok) await query(`UPDATE events SET wp_event_id = NULL, wp_synced_at = NOW() WHERE id = $1`, [eventId]).catch(() => {});
  return res;
}
