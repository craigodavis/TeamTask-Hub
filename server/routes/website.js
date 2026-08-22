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
import { availableTimes, createBooking, customFields } from '../lib/resosClient.js';
import { resolveDay, exceptions, addDays } from '../lib/hoursResolver.js';
import { makeC7Client } from '../lib/commerce7Client.js';
import { sendMail } from '../mail.js';
import { companyForRequest, tenantForCompany } from '../lib/appOrigin.js';
import { notifyWebsiteContentChanged } from '../lib/websiteDeploy.js';
import { absMedia, absMediaAll } from '../lib/mediaUrls.js';
import { subscribeEverywhere } from '../lib/newsletterSubscribe.js';

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

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');
const CONTACT_NOTIFY = process.env.CONTACT_NOTIFY_EMAIL || 'craig@kindredvineyards.com';

// POST /api/website/newsletter { email } — website newsletter signup.
websiteRouter.post('/newsletter', async (req, res) => {
  try {
    const { email, website } = req.body || {};
    if (website) return res.json({ ok: true }); // honeypot: silently accept bots
    if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const addr = email.trim().toLowerCase().slice(0, 255);

    // Row first: it is the record of truth, and it is what makes a failed push
    // recoverable by hand. Then tell the mailing platforms.
    const saved = await query(
      `INSERT INTO kindred_web.form_submissions (kind, email, meta) VALUES ('newsletter', $1, $2) RETURNING id`,
      [addr, JSON.stringify({ ip: req.ip, ua: req.headers['user-agent'] || null })]
    );

    // Answer the browser regardless of what the platforms do — a signup should
    // never appear to fail because Campaign Monitor was slow.
    res.json({ ok: true });

    const result = await subscribeEverywhere(addr);
    await query(
      `UPDATE kindred_web.form_submissions
          SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [saved.rows[0].id, JSON.stringify({ delivery: result })]
    ).catch(() => {});
    if (/failed/.test(result.campaignMonitor) || /failed/.test(result.listmonk)) {
      console.error('[newsletter] signup saved but not fully delivered:', addr, result);
    }
  } catch { res.status(500).json({ error: 'Could not sign you up right now.' }); }
});

// POST /api/website/contact { name, email, message } — website contact form.
websiteRouter.post('/contact', async (req, res) => {
  try {
    const { name, email, message, website } = req.body || {};
    if (website) return res.json({ ok: true }); // honeypot
    if (!name?.trim() || !isEmail(email) || !message?.trim()) {
      return res.status(400).json({ error: 'Name, a valid email, and a message are required.' });
    }
    const clean = { name: name.trim().slice(0, 200), email: email.trim().toLowerCase().slice(0, 255), message: message.trim().slice(0, 5000) };
    await query(
      `INSERT INTO kindred_web.form_submissions (kind, name, email, message, meta) VALUES ('contact', $1, $2, $3, $4)`,
      [clean.name, clean.email, clean.message, JSON.stringify({ ip: req.ip, ua: req.headers['user-agent'] || null })]
    );
    // Best-effort email notification — never let a mail failure break the submit.
    sendMail({
      to: CONTACT_NOTIFY,
      subject: `Website contact — ${clean.name}`,
      text: `From: ${clean.name} <${clean.email}>\n\n${clean.message}`,
      html: `<p><strong>${clean.name}</strong> &lt;${clean.email}&gt;</p><p style="white-space:pre-wrap">${clean.message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`,
    }).catch(() => {});
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Could not send your message right now.' }); }
});


const LIST_FIELDS = `
  e.id, e.slug, e.title, e.description, e.start_at, e.end_at, e.all_day, e.cost,
  e.event_url, e.image_url, e.social_image_url, e.fb_image_url, e.category,
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
    res.json({ media: absMediaAll(r.rows) });
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
      slots[row.slot_key] = absMedia({ url: row.url, variants: row.variants, alt: row.alt_text || '', width: row.width, height: row.height });
    }
    res.json({ slots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/website/commerce7-hook — Commerce7 tells us a club, product or
 * collection changed, so the website can rebuild instead of waiting an hour.
 *
 * Commerce7 offers NO way to authenticate a webhook: no signature header, no
 * shared secret, no basic auth (developer.commerce7.com/docs/webhooks). So this
 * is a public endpoint and is built to be safe as one:
 *
 *  - It has no side effect beyond "rebuild the static site". Nothing here trusts
 *    the payload — the build re-reads everything from the authoritative APIs, so
 *    a forged call can't inject content, only cause a rebuild.
 *  - The rebuild is debounced (see lib/websiteDeploy.js), so even a flood
 *    collapses to at most one build per 90s. That's the rate limit.
 *  - C7_WEBHOOK_SECRET, if set, must arrive as ?key= — belt and braces for the
 *    nuisance case. Optional on purpose: the endpoint has to work the moment it
 *    deploys, or Commerce7 starts counting failures against it.
 *
 * Always answers 200, including for objects we ignore. Commerce7 disables a
 * webhook permanently after 48h of errors and it can't be re-enabled, only
 * recreated — so a 4xx for "not interested" would quietly cost us the hook.
 */
const C7_HOOK_OBJECTS = new Set(['Club', 'Product', 'Collection']);

websiteRouter.post('/commerce7-hook', async (req, res) => {
  // Answer first: never make Commerce7 wait on our database or on GitHub.
  res.json({ ok: true });
  try {
    const secret = process.env.C7_WEBHOOK_SECRET;
    if (secret && req.query.key !== secret) return;

    const { object, action, tenantId } = req.body || {};
    if (!C7_HOOK_OBJECTS.has(object)) return;

    // One tenant per Team install, but check anyway — this URL is public.
    const companyId = await kindredCompanyId();
    const ir = await query('SELECT c7_tenant_slug FROM company_integrations WHERE company_id = $1', [companyId]);
    const ours = ir.rows[0]?.c7_tenant_slug;
    if (ours && tenantId && tenantId !== ours) return;

    notifyWebsiteContentChanged(`commerce7 ${object} ${action || 'change'}`);
  } catch (e) {
    console.warn('[commerce7-hook]', e.message);
  }
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

// GET /api/website/clubs — published Commerce7 wine clubs, so the website can
// build its own club page instead of handing the whole area to the C7 widget.
// `content` is Commerce7's rich-text blurb (HTML) and `type` distinguishes the
// flexible Subscription clubs from the fixed Traditional tiers — the site groups
// on both, so they're passed through rather than flattened here.
websiteRouter.get('/clubs', async (_req, res) => {
  try {
    const companyId = await kindredCompanyId();
    const ir = await query(
      `SELECT company_id, c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
         FROM company_integrations WHERE company_id = $1`,
      [companyId]
    );
    const integration = ir.rows[0];
    if (!integration?.c7_api_key) return res.json({ clubs: [] });
    const c7 = makeC7Client(integration);
    const all = await c7.fetchAll('/club', 'clubs', 50);

    // Member discount is NOT on the club record — Commerce7 models it as a
    // promotion that is availableTo 'Club' and names the clubs it covers. So the
    // percentages come from there rather than being retyped into the website,
    // where they would quietly drift the first time someone changes one in C7.
    // `discount` is in hundredths: 2500 = 25%.
    const byClub = new Map();
    try {
      const promos = await c7.fetchAll('/promotion', 'promotions', 50);
      for (const p of promos || []) {
        if (p.status !== 'Enabled') continue;
        if (p.availableTo !== 'Club') continue;
        if (p.discountType !== 'Percentage Off') continue;
        const pct = Number(p.discount) / 100;
        if (!Number.isFinite(pct) || pct <= 0) continue;
        for (const id of p.availableToObjectIds || []) {
          // A club can sit in more than one promotion; show the best of them.
          if (!byClub.has(id) || byClub.get(id) < pct) byClub.set(id, pct);
        }
      }
    } catch (e) {
      console.warn('[website/clubs] could not read promotions:', e.message);
    }

    const clubs = (all || [])
      .filter((c) => c.adminStatus === 'Available' && c.webStatus !== 'Not Available' && c.slug)
      .map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        type: c.type,
        content: c.content || '',
        image: c.image || null,
        discountPct: byClub.has(c.id) ? byClub.get(c.id) : null,
      }));
    res.json({ clubs });
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
        `SELECT day_of_week, to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes,
                to_char(from_date,'YYYY-MM-DD') AS from_date,
                to_char(to_date,'YYYY-MM-DD') AS to_date, label
           FROM kindred_web.hours WHERE location_id = $1 AND department = 'main'
          ORDER BY day_of_week, sort, opens`,
        [loc.id]
      );
      // `days` stays the plain weekly pattern — it's what the hours TABLE prints.
      // Seasonal rules are deliberately kept out of it so the table doesn't claim
      // August's hours apply all year; they surface via `upcoming` instead.
      const days = Array.from({ length: 7 }, (_, d) => ({ day: d, intervals: [] }));
      for (const row of reg.rows) {
        if (row.from_date || row.to_date) continue;
        days[row.day_of_week].intervals.push({ opens: row.opens, closes: row.closes });
      }

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
      // Resolved next 60 days, and the subset that differs from the weekly pattern.
      // `upcoming` is what the site shows as "different this week"; `today` drives
      // the Open now badge so a seasonal rule is honoured there too.
      const tz = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Boise' });
      const today = tz.format(new Date());
      const specialRows = spec.rows.map((r) => ({ ...r, on_date: r.date }));
      const upcoming = exceptions(reg.rows, specialRows, today, addDays(today, 60))
        .map((d) => ({ date: d.date, closed: d.closed, intervals: d.intervals, label: d.label, source: d.source }));

      venues.push({
        venue: loc.web_slug, name: loc.name, days,
        today: resolveDay(reg.rows, specialRows, today),
        upcoming,
        specials: spec.rows, details: det.rows[0] || {},
      });
    }
    res.json({ timezone: 'America/Boise', venues });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/website/reservations/custom-fields?venue=&date=&time=&party=
// The extra questions ResOS is configured to ask for a given slot — currently
// the newsletter opt-in and wine club membership.
//
// The old WordPress booking widget rendered these; the form we built did not, so
// since go-live every booking has been missing them, including one ResOS marks
// REQUIRED. This is what lets the form put them back.
websiteRouter.get('/reservations/custom-fields', async (req, res) => {
  try {
    const companyId = await kindredCompanyId();
    const loc = (await query(
      `SELECT id FROM locations WHERE company_id = $1 AND web_slug = $2 LIMIT 1`, [companyId, req.query.venue]
    )).rows[0];
    if (!loc) return res.status(404).json({ error: 'Unknown venue' });
    const cfg = (await query(
      `SELECT api_key, api_base, active FROM kindred_web.resos_config WHERE location_id = $1`, [loc.id]
    )).rows[0];
    if (!cfg?.api_key || cfg.active === false) return res.json({ fields: [] });

    // The slot matters: ResOS attaches fields to opening hours, so the questions
    // for a Saturday evening need not be the questions for a Tuesday lunch.
    const fields = await customFields(cfg.api_base || 'https://api.resos.com', cfg.api_key, {
      date: /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : undefined,
      time: /^\d{2}:\d{2}$/.test(req.query.time || '') ? req.query.time : undefined,
      people: Math.min(Math.max(parseInt(req.query.party, 10) || 2, 1), 40),
    });
    // Short deliberately. These change rarely, but when someone edits a label in
    // ResOS they go and look at the site immediately — a 5 minute cache meant the
    // old wording stared back and looked like the change hadn't saved.
    res.set('Cache-Control', 'public, max-age=60');
    res.set('Vary', 'Accept-Encoding');
    res.json({ venue: req.query.venue, fields });
  } catch (e) {
    // A booking form that can't load its optional questions should still take a
    // booking, so this degrades to none rather than failing the page.
    console.warn('[reservations/custom-fields]', e.message);
    res.json({ venue: req.query.venue, fields: [] });
  }
});

// GET /api/website/reservations/availability?venue=&date=YYYY-MM-DD&party=N
// Bookable times for a date, straight from ResOS.
//
// This used to derive candidate times from kindred_web.hours (open → close in
// 30-min steps, minus a slot_minutes duration) and then probe each one against
// availableTables — up to 48 calls, and a second copy of the schedule that
// drifted from the real one. ResOS's /bookingFlow/times already returns the
// bookable intervals, computed from ITS opening hours, seating interval,
// booking duration (incl. per-party-size durations), capacity limits and the
// bookable-online flag. One call, one source of truth.
//
// kindred_web.hours still drives the website's "Open now", the hours table and
// the Google/Apple push — it just no longer decides what's reservable.
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
      `SELECT api_key, api_base, active FROM kindred_web.resos_config WHERE location_id = $1`, [loc.id]
    )).rows[0];
    if (!cfg?.api_key || cfg.active === false) {
      return res.json({ venue, date, party, bookingEnabled: false, slots: [] });
    }

    const base = cfg.api_base || 'https://api.resos.com';
    const { times, closed, specials, sections } = await availableTimes(base, cfg.api_key, { people: party, date });

    // ResOS returns nothing for two very different reasons: the venue is shut
    // that day, or it is open and has no table big enough. Both used to surface
    // as "closed", so a party of ten was told the Creek was shut when it was open
    // and simply couldn't seat them — the largest table is eight.
    //
    // Ask again for a small party to tell them apart. Only when the first answer
    // was empty and the party is big enough for size to be the plausible cause,
    // so the usual path still costs one call.
    let reason = closed ? 'closed' : null;
    if (closed && party > 2) {
      try {
        const probe = await availableTimes(base, cfg.api_key, { people: 2, date });
        if (probe.times.length) reason = 'party-too-large';
      } catch { /* leave it as 'closed' — a failed probe shouldn't change the answer */ }
    }

    res.set('Cache-Control', 'public, max-age=30');
    res.json({ venue, date, party, bookingEnabled: true, closed, reason, slots: times, specials: specials || [], sections: sections || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/website/reservations/book
// Completes a reservation started in the website's picker. This WRITES a real
// booking into the venue's ResOS account, so it is deliberately narrow:
//   - honeypot + field validation,
//   - a per-IP rate limit (it's public and it creates records),
//   - and the requested time is re-checked against ResOS availability before
//     writing, so a hand-crafted POST can't book a time that isn't offered.
// The ResOS key stays server-side; the browser never sees it.
const bookHits = new Map(); // ip -> [timestamps]
function rateLimited(ip, max = 5, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const hits = (bookHits.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  bookHits.set(ip, hits);
  if (bookHits.size > 5000) bookHits.clear(); // crude bound; this is one box
  return hits.length > max;
}

websiteRouter.post('/reservations/book', async (req, res) => {
  try {
    const { venue, date, time, party, name, email, phone, comment, website, answers } = req.body || {};
    if (website) return res.json({ ok: true }); // honeypot: accept, don't write

    const people = Math.min(Math.max(parseInt(party, 10) || 0, 1), 40);
    if (!venue || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) {
      return res.status(400).json({ error: 'A venue, date and time are required.' });
    }
    if (!name?.trim() || !isEmail(email) || !phone?.trim()) {
      return res.status(400).json({ error: 'Please give us a name, email and phone number.' });
    }
    if (rateLimited(req.ip)) {
      return res.status(429).json({ error: 'Too many booking attempts. Please call the winery.' });
    }

    const companyId = await kindredCompanyId();
    const loc = (await query(
      `SELECT id, name FROM locations WHERE company_id = $1 AND web_slug = $2 LIMIT 1`, [companyId, venue]
    )).rows[0];
    if (!loc) return res.status(404).json({ error: 'Unknown venue' });
    const cfg = (await query(
      `SELECT api_key, api_base, active FROM kindred_web.resos_config WHERE location_id = $1`, [loc.id]
    )).rows[0];
    if (!cfg?.api_key || cfg.active === false) {
      return res.status(503).json({ error: 'Online booking is not available for this venue.' });
    }

    const base = cfg.api_base || 'https://api.resos.com';
    // Re-check: only write a time ResOS is actually offering right now.
    const { times } = await availableTimes(base, cfg.api_key, { people, date });
    if (!times.includes(time)) {
      return res.status(409).json({ error: 'That time was just taken. Please pick another.' });
    }

    // ResOS wants E.164; a locally-formatted "208-504-2127" is rejected.
    const digits = (phone || '').replace(/\D/g, '');
    const e164 = digits.length === 10 ? `+1${digits}`
      : digits.length === 11 && digits.startsWith('1') ? `+${digits}`
      : `+${digits}`;

    // Custom field answers, rebuilt server-side from ResOS's own definitions.
    // The browser sends {fieldId: optionId} and nothing else — every name, label
    // and option is looked up here, so a tampered or stale form can't write
    // arbitrary text onto a booking, and the shape always matches what ResOS
    // stores. Shapes are copied from real bookings: a radio carries the chosen
    // option's id in `value`, a checkbox carries an array of selections.
    let customFieldPayload = [];
    try {
      const defs = await customFields(base, cfg.api_key, { date, time, people });
      for (const f of defs) {
        const picked = answers && answers[f.id];
        if (!picked) continue;
        if (f.type === 'checkbox') {
          const on = picked === true || picked === 'true' || picked === f.options[0]?.id;
          if (!on) continue;
          customFieldPayload.push({
            _id: f.id, name: f.name, label: f.label,
            value: (f.options.length ? [{ _id: f.options[0].id, name: f.options[0].name, value: true }] : []),
          });
        } else {
          const opt = f.options.find((o) => o.id === picked);
          if (!opt) continue;
          customFieldPayload.push({
            _id: f.id, name: f.name, label: f.label,
            value: opt.id, multipleChoiceValueName: opt.name,
          });
        }
      }
    } catch (e) {
      // Never block a booking because the questions couldn't be resolved.
      console.warn('[reservations/book] custom fields skipped:', e.message);
    }

    const booking = await createBooking(base, cfg.api_key, {
      date,
      time,
      people,
      guest: {
        name: name.trim().slice(0, 200),
        email: email.trim().toLowerCase().slice(0, 255),
        phone: e164,
        notificationEmail: true, // ResOS sends the guest their confirmation
      },
      source: 'website',
      ...(customFieldPayload.length ? { customFields: customFieldPayload } : {}),
      // Without a status ResOS files the booking as `request` — pending. It shows
      // a table against it but does not hold that table, so the next booking is
      // offered the same one and two parties end up on it. That is what happened
      // to Bock and Margaret Fair on 8 Aug, an hour and a half apart, so it was
      // never a race between simultaneous bookings.
      //
      // Phone bookings go straight in as approved, which is why this only started
      // when the website did. Verified against ResOS: creating with an explicit
      // status returns `approved` with a table assigned.
      status: 'approved',
      comment: (comment || '').trim().slice(0, 1000),
      languageCode: 'en',
    });

    res.set('Cache-Control', 'no-store');
    // A successful create returns the booking id as a bare string.
    const bookingId = typeof booking === 'string' ? booking : (booking?._id || booking?.id || null);
    res.json({ ok: true, venue, date, time, party: people, bookingId });
  } catch (e) {
    // Logged server-side only — the browser gets a safe message, not ResOS's.
    console.error('[reservations/book] failed:', e.message);
    res.status(502).json({ error: 'We could not complete that booking. Please call the winery.' });
  }
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
    res.json({ events: absMediaAll(r.rows) });
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
    res.json({ events: absMediaAll(r.rows), limit });
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
    res.json(absMedia(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/website/app-tenant
 *
 * "Which winery am I?" — asked by the guest app so it does not have to be told
 * at build time. The answer comes from the origin the request arrives from, so
 * one deployment can serve several wineries and a dev origin can point at a
 * test tenant without a separate build or a rebuilt bundle.
 *
 * Returns only public facts: the winery's name and its Commerce7 tenant slug,
 * which is already visible in the club-list URL the app calls next. No
 * credentials, and no company id — nothing here grants anything.
 */
websiteRouter.get('/app-tenant', async (req, res) => {
  try {
    const app = await companyForRequest(req);
    // No fallback on purpose: an unrecognised origin gets nothing rather than
    // quietly inheriting production.
    if (!app) return res.status(404).json({ error: 'This origin is not configured for an app.' });

    const tenant = await tenantForCompany(app.companyId);
    if (!tenant) return res.status(409).json({ error: 'That winery has no Commerce7 tenant configured.' });

    res.json({ tenant, label: app.label });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/website/zip/:zip  →  { city, stateCode }
 *
 * So the club signup can ask for a ZIP and fill in city and state, instead of
 * making someone type all three.
 *
 * Proxied through here rather than called from the page, deliberately: /join
 * carries a strict CSP with no third-party origins precisely because it is the
 * screen with a card field on it. Punching a hole in that policy to save two
 * fields of typing would be a poor trade, so the outside call happens here.
 *
 * Our own customers answer most lookups without leaving the building — the
 * addresses already on file cover the ZIPs local guests actually use. Anything
 * unseen falls through to a public ZIP directory, and the answer is remembered
 * for the life of the process so the same ZIP is never fetched twice.
 */
const zipCache = new Map();

websiteRouter.get('/zip/:zip', async (req, res) => {
  const zip = String(req.params.zip || '').replace(/\D/g, '').slice(0, 5);
  if (zip.length !== 5) return res.status(400).json({ error: 'Five-digit ZIP required.' });
  if (zipCache.has(zip)) return res.json(zipCache.get(zip));

  const remember = (v) => { zipCache.set(zip, v); return res.json(v); };

  try {
    // Addresses we already hold. Most-used spelling wins, since the same ZIP
    // gets typed several ways ("Caldwell", "caldwell", "CALDWELL").
    const local = await query(
      `SELECT city, state_code, count(*)::int n
         FROM club_steward.club_members
        WHERE regexp_replace(COALESCE(zip_code, ''), '[^0-9]', '', 'g') LIKE $1 || '%'
          AND city IS NOT NULL AND state_code IS NOT NULL
        GROUP BY city, state_code ORDER BY n DESC LIMIT 1`, [zip]);
    if (local.rows.length) {
      return remember({ city: local.rows[0].city, stateCode: local.rows[0].state_code });
    }

    const r = await fetch(`https://api.zippopotam.us/us/${zip}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return res.status(404).json({ error: 'Unknown ZIP.' });
    const j = await r.json();
    const place = (j.places || [])[0];
    if (!place) return res.status(404).json({ error: 'Unknown ZIP.' });
    return remember({ city: place['place name'], stateCode: place['state abbreviation'] });
  } catch (e) {
    // A lookup failure must never block the signup — the guest types it in.
    res.status(404).json({ error: 'Could not look that ZIP up.' });
  }
});
