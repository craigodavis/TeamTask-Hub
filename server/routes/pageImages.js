/**
 * Page image slots — Marketing → Website Images. Manager-only writes.
 * Maps each named site slot (see lib/imageSlots.js) to a media library image.
 * The website reads the public projection at /api/website/images.
 */
import express from 'express';
import { query } from '../db.js';
import {requireCapability} from '../middleware/auth.js';
import { IMAGE_SLOTS, ALL_SLOT_KEYS } from '../lib/imageSlots.js';
import { publishWebsiteNow } from '../lib/websiteDeploy.js';
import { absMediaAll } from '../lib/mediaUrls.js';

const router = express.Router();

// POST /api/page-images/publish — force a website rebuild now. The slot writes
// below already queue one automatically (see lib/websiteDeploy.js); this is the
// manual "go now" for when someone doesn't want to wait out the debounce.
router.post('/publish', requireCapability('marketing.website'), async (_req, res) => {
  const r = await publishWebsiteNow(['manual publish']);
  if (r.ok) return res.json({ ok: true });
  // "GITHUB_DEPLOY_TOKEN is not set" is true but reads like the edit was lost,
  // which it wasn't — the assignment is already saved and the hourly rebuild in
  // deploy.yml will carry it. Say that, rather than showing someone a bare
  // environment-variable name and letting them assume their work vanished.
  const unconfigured = /not set/i.test(r.error || '');
  res.status(unconfigured ? 503 : 502).json({
    error: unconfigured
      ? 'Saved. Instant publishing isn\u2019t switched on yet (no GitHub deploy token), so the site will pick this up within the hour instead.'
      : `Saved, but the rebuild could not be triggered: ${r.error}. The site will pick it up within the hour.`,
    saved: true,
  });
});

// GET /api/page-images — the slot catalog + current assignments (with media info).
router.get('/', async (_req, res) => {
  try {
    const r = await query(
      `SELECT p.slot_key, m.id AS media_id, m.url, m.variants, m.alt_text, m.width, m.height, m.original_name
         FROM kindred_web.page_images p
         JOIN kindred_web.media m ON m.id = p.media_id`
    );
    const assignments = {};
    // Absolute, because the website's in-page editor reads this cross-origin.
    for (const row of absMediaAll(r.rows)) assignments[row.slot_key] = row;
    res.json({ catalog: IMAGE_SLOTS, assignments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/page-images/:slot — assign a media image to a slot.
router.put('/:slot', requireCapability('marketing.website'), async (req, res) => {
  try {
    const slot = req.params.slot;
    if (!ALL_SLOT_KEYS.has(slot)) return res.status(400).json({ error: 'Unknown slot' });
    const { media_id } = req.body || {};
    if (!media_id) return res.status(400).json({ error: 'media_id required' });
    await query(
      `INSERT INTO kindred_web.page_images (slot_key, media_id, updated_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (slot_key) DO UPDATE SET media_id = $2, updated_by = $3, updated_at = NOW()`,
      [slot, media_id, req.userId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/page-images/:slot — clear a slot (site falls back to its placeholder).
router.delete('/:slot', requireCapability('marketing.website'), async (req, res) => {
  try {
    await query(`DELETE FROM kindred_web.page_images WHERE slot_key = $1`, [req.params.slot]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export { router as pageImagesRouter };
