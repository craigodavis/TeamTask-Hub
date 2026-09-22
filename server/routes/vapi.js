/**
 * The door Vapi calls through — the phone agent for the Winery and the Creek.
 *
 * Two routers live here:
 *
 *   vapiRouter      public, key-gated. Mounted OUTSIDE requireAuth: Vapi has no
 *                   session, only the key from the Vapi Settings tab.
 *   vapiAdminRouter owner-only. Reads and rotates that key, and shows the call log.
 *
 * Why this is not just `/api/website/*`: that router is deliberately
 * unauthenticated because the public website's pages are built from it in a
 * browser. Putting a key on it would break the site. And the phone agent will
 * shortly need things the website must never expose — who is on shift, staff
 * mobile numbers, the ability to make those phones buzz. Those belong behind a
 * key, with an audit trail, from the start.
 *
 * Everything here is shaped for being SPOKEN. The website gets "16:00" and
 * formats it in CSS; a voice agent handed "16:00" says "sixteen hundred". So
 * each time also ships a `spoken` form, and the agent can read it verbatim.
 */
import express from 'express';
import { query } from '../db.js';
import { resolveDay, exceptions, addDays } from '../lib/hoursResolver.js';
import { verifyKey, presentedKey, logCall } from '../lib/vapiKey.js';
import { getOrCreateKey, rotateKey } from '../lib/vapiKey.js';
import { requireOwner } from '../middleware/auth.js';
// Behind Apache/Passenger req.ip is always 127.0.0.1 and req.protocol is always
// 'http'. mcpDb.js already worked out how to read the real client address from
// the forwarded chain (last entry — Apache appends, so earlier ones are
// caller-supplied), verified by spoofing. Reuse it rather than re-deriving it.
import { clientIpOf } from './mcpDb.js';

/**
 * The scheme the CLIENT used, not the one Passenger sees. Express `trust proxy`
 * would give us this, but it is app-wide state that also changes secure-cookie
 * behaviour on every other route — mcpDb.js declines it for the same reason.
 */
function clientProto(req) {
  const fwd = req.get('x-forwarded-proto');
  if (fwd) return String(fwd).split(',')[0].trim().toLowerCase();
  return req.protocol;
}

const TZ = 'America/Boise';
const DEPT = 'main';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const vapiRouter = express.Router();
export const vapiAdminRouter = express.Router();

// ── Company resolution ───────────────────────────────────────────────────────
// Same approach as the website router: this is a single-tenant deployment, and
// an unauthenticated caller has no session to carry a company on.
let _companyId = null;
async function kindredCompanyId() {
  if (_companyId) return _companyId;
  if (process.env.KINDRED_COMPANY_ID) return (_companyId = process.env.KINDRED_COMPANY_ID);
  const one = await query(`SELECT id FROM companies ORDER BY created_at LIMIT 2`);
  if (one.rows.length === 1) return (_companyId = one.rows[0].id);
  const k = await query(
    `SELECT id FROM companies WHERE slug ILIKE 'kindred%' OR name ILIKE '%kindred%'
      ORDER BY created_at LIMIT 1`
  );
  if (k.rows.length) return (_companyId = k.rows[0].id);
  throw new Error('Cannot resolve company; set KINDRED_COMPANY_ID');
}

// ── Speakable formatting ─────────────────────────────────────────────────────

/** "16:00" -> "4:00 PM". Minutes are dropped on the hour: "4 PM", not "4:00 PM". */
function spokenTime(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour12}:${String(m).padStart(2, '0')} ${period}` : `${hour12} ${period}`;
}

/** A whole day as one phrase the agent can say without assembling anything. */
function spokenDay(closed, intervals) {
  if (closed || !intervals?.length) return 'closed';
  return intervals
    .map((i) => `${spokenTime(i.opens)} to ${spokenTime(i.closes)}`)
    .join(', and again from ');
}

function todayInTz() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

/** Local wall-clock minutes-since-midnight, for the open-now check. */
function nowMinutesInTz() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

// ── The hours payload ────────────────────────────────────────────────────────

async function venuePayload(companyId) {
  const locs = await query(
    `SELECT id, name, web_slug FROM locations
      WHERE company_id = $1 AND web_slug IS NOT NULL ORDER BY name`,
    [companyId]
  );

  const today = todayInTz();
  const nowMin = nowMinutesInTz();
  const venues = [];

  for (const loc of locs.rows) {
    const reg = await query(
      `SELECT day_of_week, to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes,
              to_char(from_date,'YYYY-MM-DD') AS from_date,
              to_char(to_date,'YYYY-MM-DD') AS to_date, label
         FROM kindred_web.hours WHERE location_id = $1 AND department = $2
        ORDER BY day_of_week, sort, opens`,
      [loc.id, DEPT]
    );
    const spec = await query(
      `SELECT to_char(on_date,'YYYY-MM-DD') AS date, is_closed,
              to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes, note
         FROM kindred_web.hours_special WHERE location_id = $1 AND department = $2
          AND on_date >= (now() AT TIME ZONE $3)::date
        ORDER BY on_date LIMIT 30`,
      [loc.id, DEPT, TZ]
    );
    const det = await query(
      `SELECT street, city, region, postal, country, phone, lat, lng
         FROM kindred_web.venue_details WHERE location_id = $1`,
      [loc.id]
    );
    const d = det.rows[0] || {};

    // resolveDay applies seasonal ranges and one-off specials, so `today` is the
    // real answer rather than the plain weekly pattern.
    const specialRows = spec.rows.map((r) => ({ ...r, on_date: r.date }));
    const todayResolved = resolveDay(reg.rows, specialRows, today);

    // The weekly pattern, excluding date-ranged seasonal rules — those would
    // otherwise claim August's hours apply all year.
    const week = Array.from({ length: 7 }, (_, dow) => {
      const intervals = reg.rows
        .filter((r) => r.day_of_week === dow && !r.from_date && !r.to_date)
        .map((r) => ({ opens: r.opens, closes: r.closes }));
      return {
        day: dow,
        day_name: DAY_NAMES[dow],
        closed: intervals.length === 0,
        intervals,
        spoken: spokenDay(intervals.length === 0, intervals),
      };
    });

    const openNow = !todayResolved.closed && (todayResolved.intervals || []).some(
      (i) => nowMin >= toMinutes(i.opens) && nowMin < toMinutes(i.closes)
    );

    const addressParts = [d.street, d.city, d.region, d.postal].filter(Boolean);

    venues.push({
      venue: loc.web_slug,
      name: loc.name,
      phone: d.phone || null,
      address: addressParts.join(', ') || null,
      address_parts: {
        street: d.street || null, city: d.city || null,
        region: d.region || null, postal: d.postal || null,
        country: d.country || 'US',
      },
      coordinates: d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng } : null,
      open_now: openNow,
      today: {
        date: today,
        day_name: DAY_NAMES[new Date(`${today}T12:00:00`).getDay()],
        closed: !!todayResolved.closed,
        intervals: todayResolved.intervals || [],
        label: todayResolved.label || null,
        spoken: spokenDay(todayResolved.closed, todayResolved.intervals),
      },
      week,
      // Anything in the next 60 days that differs from the weekly pattern —
      // holiday closures, seasonal hours, one-off events.
      upcoming_changes: exceptions(reg.rows, specialRows, today, addDays(today, 60)).map((x) => ({
        date: x.date,
        day_name: DAY_NAMES[new Date(`${x.date}T12:00:00`).getDay()],
        closed: !!x.closed,
        intervals: x.intervals || [],
        label: x.label || null,
        spoken: spokenDay(x.closed, x.intervals),
      })),
    });
  }

  return { timezone: TZ, as_of: today, venues };
}

// ── Public router: key required ──────────────────────────────────────────────

vapiRouter.use(express.json({ limit: '256kb' }));

vapiRouter.use(async (req, res, next) => {
  // Never cached by an intermediary: the answer depends on the key and changes
  // through the day as the venues open and close.
  res.set('Cache-Control', 'no-store');

  // A tripwire, NOT a protection — do not rely on it.
  //
  // The key travels in a request header and this host does not redirect plain
  // http to https, so http://…/api/vapi is served in clear, key and all. This
  // check cannot stop that: Apache here does not set x-forwarded-proto (verified
  // — sending it by hand returns 403, a genuine http request returns 401, so the
  // header is simply absent), and the header is caller-supplied anyway, so an
  // attacker sends "https" and walks past. It catches a misconfigured proxy in
  // front of us and nothing else.
  //
  // The real fix is an Apache-level redirect, which protects the whole site
  // rather than this router. Until that exists, treat any key that has been sent
  // over http as disclosed and rotate it.
  if (req.get('x-forwarded-proto') && clientProto(req) !== 'https') {
    return res.status(403).json({ error: 'HTTPS required' });
  }

  try {
    const companyId = await kindredCompanyId();
    const ok = await verifyKey(companyId, presentedKey(req));
    if (!ok) {
      await logCall(companyId, req.path, false, 'bad or missing key', clientIpOf(req));
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.vapiCompanyId = companyId;
    next();
  } catch (e) {
    console.error('[vapi] auth error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * The base URL itself. Nothing matched it before, so it fell through to the SPA
 * catch-all and answered `<!DOCTYPE html>` with a 200 — which is what a caller
 * pasting the base URL into Vapi actually got, and it fails as "Unexpected
 * token '<'". Answer with the endpoint list instead: it is the natural thing to
 * try, and it tells you what to call next.
 */
vapiRouter.get('/', async (req, res) => {
  await logCall(req.vapiCompanyId, '/', true, 'index', clientIpOf(req));
  res.json({
    ok: true,
    service: 'kindred-vapi',
    timezone: TZ,
    as_of: todayInTz(),
    endpoints: {
      'GET /ping': 'liveness and key check',
      'GET /hours': 'hours, address and phone for every venue',
      'GET /hours/{venue}': 'one venue — venue is "creek" or "estate"',
    },
  });
});

/** Liveness + key check, so Vapi's config screen can prove the key works. */
vapiRouter.get('/ping', async (req, res) => {
  await logCall(req.vapiCompanyId, '/ping', true, null, clientIpOf(req));
  res.json({ ok: true, timezone: TZ, as_of: todayInTz() });
});

/** Hours, addresses and phone for both venues — the bulk of what a caller asks. */
vapiRouter.get('/hours', async (req, res) => {
  try {
    const payload = await venuePayload(req.vapiCompanyId);
    await logCall(req.vapiCompanyId, '/hours', true, `${payload.venues.length} venues`, clientIpOf(req));
    res.json(payload);
  } catch (e) {
    console.error('[vapi] /hours failed:', e.message);
    await logCall(req.vapiCompanyId, '/hours', false, e.message, clientIpOf(req));
    res.status(500).json({ error: 'Server error' });
  }
});

/** The same data narrowed to one venue, for when the agent knows which line rang. */
vapiRouter.get('/hours/:venue', async (req, res) => {
  try {
    const payload = await venuePayload(req.vapiCompanyId);
    const want = String(req.params.venue || '').toLowerCase();
    const venue = payload.venues.find(
      (v) => v.venue?.toLowerCase() === want || v.name?.toLowerCase() === want
    );
    if (!venue) {
      await logCall(req.vapiCompanyId, `/hours/${want}`, false, 'unknown venue', clientIpOf(req));
      return res.status(404).json({
        error: 'Unknown venue',
        known: payload.venues.map((v) => v.venue),
      });
    }
    await logCall(req.vapiCompanyId, `/hours/${want}`, true, null, clientIpOf(req));
    res.json({ timezone: payload.timezone, as_of: payload.as_of, ...venue });
  } catch (e) {
    console.error('[vapi] /hours/:venue failed:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Admin router: owner only ─────────────────────────────────────────────────

vapiAdminRouter.get('/key', requireOwner, async (req, res) => {
  try {
    const row = await getOrCreateKey(req.companyId, req.userId);
    res.json({
      api_key: row.api_key,
      rotated_at: row.rotated_at,
      base_url: `${clientProto(req)}://${req.get('host')}/api/vapi`,
    });
  } catch (e) {
    console.error('[vapi] key read failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

vapiAdminRouter.post('/key/rotate', requireOwner, async (req, res) => {
  try {
    const row = await rotateKey(req.companyId, req.userId);
    console.warn('[vapi] key rotated by user %s', req.userId);
    res.json({ api_key: row.api_key, rotated_at: row.rotated_at });
  } catch (e) {
    console.error('[vapi] key rotate failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** Recent calls — the quickest way to see whether Vapi is actually reaching us. */
vapiAdminRouter.get('/log', requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT endpoint, ok, detail, ip, at FROM vapi_call_log
        WHERE company_id = $1 ORDER BY at DESC LIMIT 50`,
      [req.companyId]
    );
    res.json({ calls: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unmatched paths must not escape into the SPA fallback below this mount, which
// answers 200 text/html and makes every client-side JSON parse fail with
// "Unexpected token '<'". Everything under /api/vapi is JSON, including misses.
vapiRouter.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    endpoints: ['/ping', '/hours', '/hours/{venue}'],
  });
});
