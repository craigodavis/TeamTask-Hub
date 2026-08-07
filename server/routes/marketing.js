/**
 * Website settings edited in Team → Marketing → Website Settings.
 * Reads/writes kindred_web.settings (whitelisted keys only). Manager-only.
 * The public site reads these via /api/website/settings.
 */
import express from 'express';
import { query } from '../db.js';
import { ping as resosPing } from '../lib/resosClient.js';
import { tokenStatus } from '../lib/instagramToken.js';

export const marketingRouter = express.Router();

// GET /api/marketing/instagram — how much life the feed's token has left.
// An Instagram token dying is invisible from the outside: the website's feed just
// goes empty, which reads as "they haven't posted". This is where to look.
// Returns no token material, only its state.
marketingRouter.get('/instagram', async (_req, res) => {
  try { res.json(await tokenStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Resolve a venue web_slug → { location_id, name } for this company.
async function resolveVenue(companyId, venue) {
  const r = await query(
    `SELECT id, name FROM locations WHERE company_id = $1 AND web_slug = $2 LIMIT 1`,
    [companyId, venue]
  );
  return r.rows[0] ? { locationId: r.rows[0].id, name: r.rows[0].name } : null;
}
const last4 = (s) => (s && s.length > 4 ? s.slice(-4) : (s ? '••••' : null));

// Whitelisted settings: key → { parse, default }.
const SETTINGS = {
  events_list_count: {
    default: 10,
    parse: (v) => Math.min(Math.max(parseInt(v, 10) || 10, 1), 100),
  },
};

async function readSetting(key) {
  const r = await query(`SELECT value FROM kindred_web.settings WHERE key = $1`, [key]);
  return r.rows.length ? r.rows[0].value : SETTINGS[key].default;
}

// GET /api/marketing/settings — current values for all whitelisted keys.
marketingRouter.get('/settings', async (_req, res) => {
  try {
    const out = {};
    for (const key of Object.keys(SETTINGS)) out[key] = await readSetting(key);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/marketing/settings — upsert any provided whitelisted keys.
marketingRouter.put('/settings', async (req, res) => {
  try {
    const out = {};
    for (const [key, cfg] of Object.entries(SETTINGS)) {
      if (!(key in req.body)) { out[key] = await readSetting(key); continue; }
      const value = cfg.parse(req.body[key]);
      await query(
        `INSERT INTO kindred_web.settings (key, value, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
        [key, JSON.stringify(value), req.userId || null]
      );
      out[key] = value;
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ResOS reservation config (per venue) ─────────────────────────────────────

// GET /api/marketing/reservations — per-venue config (API key masked).
marketingRouter.get('/reservations', async (req, res) => {
  try {
    const locs = await query(
      `SELECT id, name, web_slug FROM locations WHERE company_id = $1 AND web_slug IS NOT NULL ORDER BY name`,
      [req.companyId]
    );
    const venues = [];
    for (const l of locs.rows) {
      const c = (await query(
        `SELECT api_key, api_base, slot_minutes, active FROM kindred_web.resos_config WHERE location_id = $1`,
        [l.id]
      )).rows[0] || {};
      venues.push({
        venue: l.web_slug, name: l.name,
        configured: !!c.api_key, key_last4: last4(c.api_key),
        api_base: c.api_base || 'https://api.resos.com',
        slot_minutes: c.slot_minutes || 90,
        active: c.active !== false,
      });
    }
    res.json({ venues });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/marketing/reservations/:venue — set key/base/slot. Empty api_key keeps existing.
marketingRouter.put('/reservations/:venue', async (req, res) => {
  try {
    const v = await resolveVenue(req.companyId, req.params.venue);
    if (!v) return res.status(404).json({ error: 'Unknown venue' });
    const { api_key, api_base, slot_minutes, active } = req.body || {};
    const existing = (await query(`SELECT api_key FROM kindred_web.resos_config WHERE location_id = $1`, [v.locationId])).rows[0];
    const keyToStore = (api_key && api_key.trim()) ? api_key.trim() : (existing?.api_key || null);
    await query(
      `INSERT INTO kindred_web.resos_config (location_id, api_key, api_base, slot_minutes, active, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (location_id) DO UPDATE SET api_key=$2, api_base=$3, slot_minutes=$4, active=$5, updated_at=NOW(), updated_by=$6`,
      [v.locationId, keyToStore, (api_base || 'https://api.resos.com').trim(),
       Math.min(Math.max(parseInt(slot_minutes, 10) || 90, 15), 240), active !== false, req.userId || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/marketing/reservations/:venue/test — validate the key against ResOS.
marketingRouter.post('/reservations/:venue/test', async (req, res) => {
  try {
    const v = await resolveVenue(req.companyId, req.params.venue);
    if (!v) return res.status(404).json({ error: 'Unknown venue' });
    const row = (await query(`SELECT api_key, api_base FROM kindred_web.resos_config WHERE location_id = $1`, [v.locationId])).rows[0];
    const key = (req.body?.api_key && req.body.api_key.trim()) || row?.api_key;
    const base = (req.body?.api_base && req.body.api_base.trim()) || row?.api_base || 'https://api.resos.com';
    if (!key) return res.status(400).json({ ok: false, message: 'No API key set for this venue yet.' });
    res.json(await resosPing(base, key));
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
