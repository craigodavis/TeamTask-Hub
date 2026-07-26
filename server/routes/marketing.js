/**
 * Website settings edited in Team → Marketing → Website Settings.
 * Reads/writes kindred_web.settings (whitelisted keys only). Manager-only.
 * The public site reads these via /api/website/settings.
 */
import express from 'express';
import { query } from '../db.js';

export const marketingRouter = express.Router();

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
