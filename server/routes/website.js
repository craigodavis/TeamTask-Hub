/**
 * Public, read-only API for the Astro website (kindredvineyards.com).
 * Mounted WITHOUT auth. Returns only published, public-safe fields.
 *
 * Everything is company-scoped to Kindred; since there's no auth/company on these
 * requests, we resolve the company once (KINDRED_COMPANY_ID env, else the single
 * company, else the one matching "kindred").
 */
import express from 'express';
import { query } from '../db.js';
import { availableTables } from '../lib/resosClient.js';
import { makeC7Client } from '../lib/commerce7Client.js';

export const websiteRouter = express.Router();

// Short CDN cache — content changes rarely; edits show within a minute.
// Public read API → allow cross-origin fetches from the website (browser).
websiteRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

let _companyId = null;
async function kindredCompanyId() {
  if (_companyId) return _companyId;
  if (process.env.KINDRED_COMPANY_ID) return (_companyId = process.env.KINDRED_COMPANY_ID);
  const one = await query(`SELECT id FROM companies ORDER BY created_at LIMIT 2`);
  if (one.rows.length === 1) return (_companyId = one.rows[0].id);
  const k = await query(
    `SELECT id FROM companies WHERE slug ILIKE 'kindred%' OR name ILIKE '%kindred%' ORDER BY created_at LIMIT 1`
  );
  if (k.rows.length) return (_companyId = k.rows[0].id);
  throw new Error('Cannot resolve company; set KINDRED_COMPANY_ID');
}

async function getSetting(key, fallback) {
  try {
    const r = await query(`SELECT value FROM kindred_web.settings WHERE key = $1`, [key]);
    return r.rows.length ? r.rows[0].value : fallback;
  } catch { return fallback; }
}

const LIST_FIELDS = `
  e.id, e.slug, e.title, e.description, e.start_at, e.end_at, e.all_day, e.cost,
  e.event_url, e.image_url, e.social_image_url, e.category,
  l.web_slug AS venue, l.name AS venue_name,
  m.name AS musician_name, m.stage_name AS musician_stage_name,
  m.photo_url AS musician_photo, m.website_url AS musician_url`;

// GET /api/website/venues — venues with a short key for per-location pages.
websiteRouter.get('/venues', async (_req, res) => {
  try {
    const companyId = await kindredCompanyId();
    const r = await query(
      `SELECT web_slug AS venue, name FROM locations WHERE company_id = $1 AND web_slug IS NOT NULL ORDER BY name`,
      [companyId]
    );
    res.json({ venues: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/settings — public whitelist only.
websiteRouter.get('/settings', async (_req, res) => {
  try {
    const events_list_count = Number(await getSetting('events_list_count', 10)) || 10;
    res.json({ events_list_count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/instagram — cached recent Instagram posts for the site feed.
websiteRouter.get('/instagram', async (_req, res) => {
  try {
    const r = await query(
      `SELECT id, media_type, media_url, thumbnail_url, permalink, caption, posted_at
         FROM kindred_web.instagram_media ORDER BY posted_at DESC LIMIT 12`
    );
    res.json({ media: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/images — assigned page-image slots (url + variants + alt) for the site.
websiteRouter.get('/images', async (_req, res) => {
  try {
    const r = await query(
      `SELECT p.slot_key, m.url, m.variants, m.alt_text, m.width, m.height
         FROM kindred_web.page_images p
         JOIN kindred_web.media m ON m.id = p.media_id`
    );
    const slots = {};
    for (const row of r.rows) {
      slots[row.slot_key] = { url: row.url, variants: row.variants, alt: row.alt_text || '', width: row.width, height: row.height };
    }
    res.json({ slots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/collections — published Commerce7 collections (slug + title)
// for the website shop nav. Uses Team's stored C7 credentials (server-side).
websiteRouter.get('/collections', async (_req, res) => {
  try {
    const companyId = await kindredCompanyId();
    const ir = await query(
      `SELECT company_id, c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
         FROM company_integrations WHERE company_id = $1`,
      [companyId]
    );
    const integration = ir.rows[0];
    if (!integration?.c7_api_key) return res.json({ collections: [] });
    const c7 = makeC7Client(integration);
    const data = await c7.get('/collection?limit=50');
    const collections = (data.collections || [])
      .filter((c) => c.adminStatus === 'Available' && c.webStatus !== 'Not Available')
      .map((c) => ({ slug: c.slug, title: c.title }));
    res.json({ collections });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/products — published Commerce7 product slugs, so the website
// can pre-render a page per product (deep-links to /product/[slug] work).
websiteRouter.get('/products', async (_req, res) => {
  try {
    const companyId = await kindredCompanyId();
    const ir = await query(
      `SELECT company_id, c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
         FROM company_integrations WHERE company_id = $1`,
      [companyId]
    );
    const integration = ir.rows[0];
    if (!integration?.c7_api_key) return res.json({ products: [] });
    const c7 = makeC7Client(integration);
    const all = await c7.fetchAll('/product', 'products', 50);
    const products = (all || [])
      .filter((p) => p.adminStatus === 'Available' && p.webStatus !== 'Not Available' && p.slug)
      .map((p) => ({ slug: p.slug, title: p.title }));
    res.json({ products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/hours — weekly hours + upcoming specials per venue, for the site.
websiteRouter.get('/hours', async (_req, res) => {
  try {
    const companyId = await kindredCompanyId();
    const locs = await query(
      `SELECT id, name, web_slug FROM locations
        WHERE company_id = $1 AND web_slug IS NOT NULL ORDER BY name`,
      [companyId]
    );
    const venues = [];
    for (const loc of locs.rows) {
      const reg = await query(
        `SELECT day_of_week, to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes
           FROM kindred_web.hours WHERE location_id = $1 AND department = 'main'
          ORDER BY day_of_week, sort, opens`,
        [loc.id]
      );
      const days = Array.from({ length: 7 }, (_, d) => ({ day: d, intervals: [] }));
      for (const row of reg.rows) days[row.day_of_week].intervals.push({ opens: row.opens, closes: row.closes });

      const spec = await query(
        `SELECT to_char(on_date,'YYYY-MM-DD') AS date, is_closed,
                to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes, note
           FROM kindred_web.hours_special WHERE location_id = $1 AND department = 'main'
            AND on_date >= (now() AT TIME ZONE 'America/Boise')::date
          ORDER BY on_date LIMIT 30`,
        [loc.id]
      );
      const det = await query(
        `SELECT street, city, region, postal, country, phone, lat, lng, price_range
           FROM kindred_web.venue_details WHERE location_id = $1`,
        [loc.id]
      );
      venues.push({ venue: loc.web_slug, name: loc.name, days, specials: spec.rows, details: det.rows[0] || {} });
    }
    res.json({ timezone: 'America/Boise', venues });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/reservations/availability?venue=&date=YYYY-MM-DD&party=N
// Combines the venue's hours with live ResOS table availability → bookable times.
websiteRouter.get('/reservations/availability', async (req, res) => {
  try {
    const companyId = await kindredCompanyId();
    const venue = req.query.venue;
    const date = req.query.date;
    const party = Math.min(Math.max(parseInt(req.query.party, 10) || 2, 1), 40);
    if (!venue || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ error: 'venue and date=YYYY-MM-DD are required' });
    }
    const loc = (await query(
      `SELECT id, name FROM locations WHERE company_id = $1 AND web_slug = $2 LIMIT 1`, [companyId, venue]
    )).rows[0];
    if (!loc) return res.status(404).json({ error: 'Unknown venue' });
    const cfg = (await query(
      `SELECT api_key, api_base, slot_minutes, active FROM kindred_web.resos_config WHERE location_id = $1`, [loc.id]
    )).rows[0];
    if (!cfg?.api_key || cfg.active === false) return res.json({ venue, date, party, bookingEnabled: false, slots: [] });

    // Open intervals for this date: special-day override wins over the weekday hours.
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const special = (await query(
      `SELECT is_closed, to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes
         FROM kindred_web.hours_special WHERE location_id = $1 AND department = 'main' AND on_date = $2`,
      [loc.id, date]
    )).rows;
    let intervals;
    if (special.length) {
      intervals = special.some((s) => s.is_closed) ? [] : special.filter((s) => s.opens && s.closes);
    } else {
      intervals = (await query(
        `SELECT to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes
           FROM kindred_web.hours WHERE location_id = $1 AND department = 'main' AND day_of_week = $2 ORDER BY opens`,
        [loc.id, dow]
      )).rows;
    }
    if (!intervals.length) return res.json({ venue, date, party, bookingEnabled: true, closed: true, slots: [] });

    const dur = cfg.slot_minutes || 90;
    const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const cands = [];
    for (const iv of intervals) {
      for (let t = toMin(iv.opens); t + dur <= toMin(iv.closes); t += 30) cands.push(fmt(t));
    }
    const capped = [...new Set(cands)].slice(0, 24);

    const base = cfg.api_base || 'https://api.resos.com';
    const slots = [];
    const CONC = 5;
    for (let i = 0; i < capped.length; i += CONC) {
      const batch = capped.slice(i, i + CONC);
      const r = await Promise.all(batch.map(async (time) => {
        const from = `${date}T${time}:00`;
        const to = `${date}T${fmt(toMin(time) + dur)}:00`;
        try {
          const tables = await availableTables(base, cfg.api_key, { people: party, fromDateTime: from, toDateTime: to });
          return tables.length > 0 ? time : null;
        } catch { return null; }
      }));
      slots.push(...r.filter(Boolean));
    }
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ venue, date, party, bookingEnabled: true, slots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/events/calendar?venue=&month=YYYY-MM — published events in a month.
// (Defined before /events/:slug so "calendar" isn't treated as a slug.)
websiteRouter.get('/events/calendar', async (req, res) => {
  try {
    const companyId = await kindredCompanyId();
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
    const params = [companyId];
    let range = '';
    if (month) {
      params.push(`${month}-01`);
      range = `AND e.start_at >= $${params.length}::date AND e.start_at < ($${params.length}::date + INTERVAL '1 month')`;
    } else {
      range = `AND e.start_at >= date_trunc('day', now())`;
    }
    let venueClause = '';
    if (req.query.venue) { params.push(req.query.venue); venueClause = `AND l.web_slug = $${params.length}`; }
    const r = await query(
      `SELECT ${LIST_FIELDS}
         FROM events e
         LEFT JOIN locations l ON l.id = e.location_id
         LEFT JOIN musicians m ON m.id = e.musician_id
        WHERE e.company_id = $1 AND e.status = 'published' ${range} ${venueClause}
        ORDER BY e.start_at ASC`,
      params
    );
    res.json({ events: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/events?venue=&limit=&q=&category= — upcoming published events.
websiteRouter.get('/events', async (req, res) => {
  try {
    const companyId = await kindredCompanyId();
    const defaultLimit = Number(await getSetting('events_list_count', 10)) || 10;
    const limit = Math.min(Math.max(Number(req.query.limit) || defaultLimit, 1), 100);

    const params = [companyId];
    let where = `e.company_id = $1 AND e.status = 'published' AND e.start_at >= date_trunc('day', now())`;
    if (req.query.venue) { params.push(req.query.venue); where += ` AND l.web_slug = $${params.length}`; }
    if (req.query.category) { params.push(req.query.category); where += ` AND e.category = $${params.length}`; }
    if (req.query.q && req.query.q.trim()) {
      params.push(`%${req.query.q.trim()}%`);
      where += ` AND (e.title ILIKE $${params.length} OR e.description ILIKE $${params.length} OR e.category ILIKE $${params.length})`;
    }
    params.push(limit);
    const r = await query(
      `SELECT ${LIST_FIELDS}
         FROM events e
         LEFT JOIN locations l ON l.id = e.location_id
         LEFT JOIN musicians m ON m.id = e.musician_id
        WHERE ${where}
        ORDER BY e.start_at ASC
        LIMIT $${params.length}`,
      params
    );
    res.json({ events: r.rows, limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/events/:slug — one published event (with fuller musician info).
websiteRouter.get('/events/:slug', async (req, res) => {
  try {
    const companyId = await kindredCompanyId();
    const r = await query(
      `SELECT ${LIST_FIELDS}, e.end_at, m.bio AS musician_bio, m.links AS musician_links
         FROM events e
         LEFT JOIN locations l ON l.id = e.location_id
         LEFT JOIN musicians m ON m.id = e.musician_id
        WHERE e.company_id = $1 AND e.status = 'published' AND e.slug = $2
        LIMIT 1`,
      [companyId, req.params.slug]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
