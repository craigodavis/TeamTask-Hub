/**
 * Store-hours management — Marketing → Hours. Manager-only writes.
 * The single source of truth for hours, consumed by the website (via
 * /api/website/hours) and, later, pushed to Google/Apple/Twilio.
 *
 * Regular hours live in kindred_web.hours (one row per open interval; a day with
 * no rows is closed). Date-specific overrides live in kindred_web.hours_special.
 */
import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';

const router = express.Router();
const cId = (req) => req.companyId;
const DEPT = 'main';

// GET /api/hours — web venues with their weekly schedule + upcoming specials.
router.get('/', async (req, res) => {
  try {
    const locs = await query(
      `SELECT id, name, web_slug FROM locations
        WHERE company_id = $1 AND web_slug IS NOT NULL ORDER BY name`,
      [cId(req)]
    );
    const locations = [];
    for (const loc of locs.rows) {
      const reg = await query(
        `SELECT id, day_of_week,
                to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes, sort,
                to_char(from_date,'YYYY-MM-DD') AS from_date,
                to_char(to_date,'YYYY-MM-DD')   AS to_date, label
           FROM kindred_web.hours WHERE location_id = $1 AND department = $2
          ORDER BY day_of_week, from_date NULLS FIRST, sort, opens`,
        [loc.id, DEPT]
      );
      const spec = await query(
        `SELECT id, to_char(on_date,'YYYY-MM-DD') AS on_date, is_closed,
                to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes, note
           FROM kindred_web.hours_special WHERE location_id = $1 AND department = $2
            AND on_date >= (now() AT TIME ZONE 'America/Boise')::date
          ORDER BY on_date`,
        [loc.id, DEPT]
      );
      const det = await query(
        `SELECT street, city, region, postal, country, phone, lat, lng, price_range, gbp_location, apple_location
           FROM kindred_web.venue_details WHERE location_id = $1`,
        [loc.id]
      );
      locations.push({
        id: loc.id, name: loc.name, venue: loc.web_slug,
        regular: reg.rows, specials: spec.rows, details: det.rows[0] || {},
      });
    }
    res.json({ locations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/hours/:locationId/details — upsert a venue's address/phone/geo/push targets.
router.put('/:locationId/details', requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    const chk = await query(`SELECT id FROM locations WHERE id = $1 AND company_id = $2`, [locationId, cId(req)]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Location not found' });

    const d = req.body || {};
    const num = (v) => (v === '' || v == null ? null : Number(v));
    await query(
      `INSERT INTO kindred_web.venue_details
         (location_id, street, city, region, postal, country, phone, lat, lng, price_range, gbp_location, apple_location, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (location_id) DO UPDATE SET
         street=$2, city=$3, region=$4, postal=$5, country=$6, phone=$7, lat=$8, lng=$9,
         price_range=$10, gbp_location=$11, apple_location=$12, updated_by=$13, updated_at=NOW()`,
      [locationId, d.street || null, d.city || null, d.region || null, d.postal || null,
       d.country || 'US', d.phone || null, num(d.lat), num(d.lng),
       d.price_range || null, d.gbp_location || null, d.apple_location || null, req.userId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/hours/:locationId — replace the whole weekly schedule for a location.
// Body: { department?, intervals: [{ day_of_week, opens:"HH:MM", closes:"HH:MM" }] }
router.put('/:locationId', requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    const department = req.body.department || DEPT;
    const intervals = Array.isArray(req.body.intervals) ? req.body.intervals : [];

    const chk = await query(`SELECT id FROM locations WHERE id = $1 AND company_id = $2`, [locationId, cId(req)]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Location not found' });

    await query(`DELETE FROM kindred_web.hours WHERE location_id = $1 AND department = $2`, [locationId, department]);
    let sort = 0;
    for (const iv of intervals) {
      if (iv.day_of_week == null || !iv.opens || !iv.closes) continue;
      // from_date/to_date empty => the year-round rule. Both set => a season.
      // Reject a half-specified or backwards window rather than skipping it —
      // silently dropping a row means the manager saves August and it isn't there.
      const from = iv.from_date || null;
      const to = iv.to_date || null;
      if (!!from !== !!to) {
        return res.status(400).json({ error: 'A seasonal rule needs both a first and a last date.' });
      }
      if (from && to && to < from) {
        return res.status(400).json({ error: 'A seasonal rule ends before it starts.' });
      }
      await query(
        `INSERT INTO kindred_web.hours
           (company_id, location_id, department, day_of_week, opens, closes, sort, from_date, to_date, label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [cId(req), locationId, department, iv.day_of_week, iv.opens, iv.closes, sort++,
         from, to, (iv.label || '').trim().slice(0, 80) || null]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/hours/:locationId/confirm-publish — record that a manager updated
// the outside listings by hand. Not a push; a receipt. Until the Google/Apple
// APIs are connected this is the only evidence the published hours match ours.
router.post('/:locationId/confirm-publish', requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    const { google, apple, facebook } = req.body || {};
    const chk = await query(`SELECT id FROM locations WHERE id = $1 AND company_id = $2`, [locationId, cId(req)]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Location not found' });
    await query(
      `INSERT INTO kindred_web.hours_publish_log (company_id, location_id, google, apple, facebook, confirmed_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [cId(req), locationId, !!google, !!apple, !!facebook, req.userId || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/hours/:locationId/special — add a holiday/closure override.
router.post('/:locationId/special', requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    const { on_date, is_closed = false, opens = null, closes = null, note = null, department = DEPT } = req.body || {};
    if (!on_date) return res.status(400).json({ error: 'on_date required' });

    const chk = await query(`SELECT id FROM locations WHERE id = $1 AND company_id = $2`, [locationId, cId(req)]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Location not found' });

    const r = await query(
      `INSERT INTO kindred_web.hours_special
         (company_id, location_id, department, on_date, is_closed, opens, closes, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [cId(req), locationId, department, on_date, !!is_closed, is_closed ? null : opens, is_closed ? null : closes, note]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/hours/special/:id
router.delete('/special/:id', requireManager, async (req, res) => {
  try {
    await query(`DELETE FROM kindred_web.hours_special WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export { router as hoursRouter };
