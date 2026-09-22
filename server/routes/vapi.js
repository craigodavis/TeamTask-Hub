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
import { availableTimes, createBooking } from '../lib/resosClient.js';
import { sendSmsToPhone } from '../lib/smsHelper.js';
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
      'GET /availability': 'bookable times — ?venue=&date=YYYY-MM-DD&party=N',
      'POST /book': 'make a reservation — {venue,date,time,party,name,phone,email?,comment?}',
      'POST /space-rental-link': 'text the event-enquiry form — {phone,name?}',
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
    const want = normalizeVenue(req.params.venue) || String(req.params.venue || '').toLowerCase();
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

// ── Reservations ─────────────────────────────────────────────────────────────

/** The ResOS credentials for a venue slug, or null if it cannot take bookings. */
async function resosForVenue(companyId, venueSlug) {
  const loc = (await query(
    `SELECT id, name FROM locations WHERE company_id = $1 AND web_slug = $2 LIMIT 1`,
    [companyId, venueSlug]
  )).rows[0];
  if (!loc) return null;
  const cfg = (await query(
    `SELECT api_key, api_base, active FROM kindred_web.resos_config WHERE location_id = $1`,
    [loc.id]
  )).rows[0];
  if (!cfg?.api_key || cfg.active === false) return { loc, cfg: null };
  return { loc, cfg, base: cfg.api_base || 'https://api.resos.com' };
}

// ── Meeting the model where it is ────────────────────────────────────────────
// A language model fills these from what a caller SAID. It will send "Creek",
// "the winery", "9/26/2026" and "four", and a 404 mid-call is a dropped booking.
// Be liberal about what comes in; the slugs and formats are our problem, not the
// agent's.

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, couple: 2, pair: 2,
};

/** Anything a caller might call a venue -> the web_slug we actually store. */
export function normalizeVenue(raw) {
  const t = String(raw || '').toLowerCase().trim()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  if (t.includes('creek')) return 'creek';
  // "Winery", "Estate", "Frost Road", and plain "Kindred Vineyards" all mean the
  // Frost Road property. Checked after creek so "Kindred by the Creek" wins.
  if (/(winery|estate|vineyard|frost)/.test(t)) return 'estate';
  return t;
}

/** YYYY-MM-DD, YYYY-M-D and US M/D/YYYY all land as YYYY-MM-DD. */
export function normalizeDate(raw) {
  const s = String(raw || '').trim();
  const pad = (n) => String(n).padStart(2, '0');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);      // US order, as spoken
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

/**
 * Party size. Returns null rather than a default when it cannot tell — silently
 * treating "four" as two answers a different question than the one asked, and
 * nothing downstream would notice.
 */
export function normalizeParty(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const t = String(raw).toLowerCase().trim();
  const n = parseInt(t, 10);
  if (Number.isFinite(n) && String(n) === t.replace(/[^0-9]/g, '')) {
    return n >= 1 && n <= 40 ? n : null;
  }
  for (const [word, val] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return val;
  }
  return null;
}

/**
 * "9:30" -> "09:30", and "5:30 PM" -> "17:30".
 *
 * ResOS lists times zero-padded, and the booking is matched against that list by
 * string equality. An unpadded hour passes a loose format check and then fails
 * the match, so the caller is told the slot has gone when it is sitting right
 * there — the most confusing possible failure, and invisible in the logs.
 */
export function normalizeTime(raw) {
  const s = String(raw || '').trim().toLowerCase();
  let m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || Number(min) > 59) return null;
  return `${String(h).padStart(2, '0')}:${min}`;
}

/** ResOS rejects a locally-formatted number; it wants E.164. */
function toE164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/**
 * GET /availability?venue=creek&date=YYYY-MM-DD&party=4
 *
 * Read-only, so the agent can offer times before committing to anything. Times
 * come back both raw and spoken — an agent reading "16:30" says "sixteen thirty".
 */
vapiRouter.get('/availability', async (req, res) => {
  const venue = normalizeVenue(req.query.venue);
  const date = normalizeDate(req.query.date);
  const party = normalizeParty(req.query.party);
  try {
    if (!venue || !date || !party) {
      return res.status(400).json({
        error: 'venue, date and party are all required',
        got: { venue: req.query.venue ?? null, date: req.query.date ?? null, party: req.query.party ?? null },
        expected: { venue: 'creek | estate', date: 'YYYY-MM-DD', party: 'a number, 1-40' },
        spoken: 'I did not catch which location, what date, or how many people.',
      });
    }
    const r = await resosForVenue(req.vapiCompanyId, venue);
    if (!r) return res.status(404).json({ error: 'Unknown venue', known_venues: ['creek', 'estate'] });
    if (!r.cfg) {
      return res.status(503).json({ error: 'That venue does not take online bookings.', venue, bookable: false });
    }

    const { times } = await availableTimes(r.base, r.cfg.api_key, { people: party, date });
    const slots = (times || []).map((t) => ({ time: t, spoken: spokenTime(t) }));
    await logCall(req.vapiCompanyId, '/availability', true, `${venue} ${date} party=${party} -> ${slots.length}`, clientIpOf(req));
    res.json({
      venue, date, party,
      available: slots.length > 0,
      slots,
      spoken: slots.length
        ? `We have ${slots.length === 1 ? 'one time' : slots.length + ' times'} available: ${slots.map((x) => x.spoken).join(', ')}`
        : 'We have nothing available at that size on that day.',
    });
  } catch (e) {
    console.error('[vapi] /availability failed:', e.message);
    await logCall(req.vapiCompanyId, '/availability', false, e.message, clientIpOf(req));
    res.status(502).json({ error: 'Could not check availability right now.' });
  }
});

/**
 * POST /book  { venue, date, time, party, name, phone, email?, comment? }
 *
 * Email is OPTIONAL here, unlike the website form. Spelling an address out loud
 * is the most error-prone thing a voice agent can attempt, and a wrong one is
 * worse than none — the confirmation goes to a stranger. When it is absent
 * ResOS is told not to email, and the phone number is the contact.
 *
 * status:'approved' matters. Without it ResOS files the booking as a pending
 * request, which shows a table but does not hold it, so the same table gets
 * offered again and two parties end up on it.
 */
vapiRouter.post('/book', async (req, res) => {
  const { name, phone, email, comment } = req.body || {};
  const venue = normalizeVenue(req.body?.venue);
  const date = normalizeDate(req.body?.date);
  const people = normalizeParty(req.body?.party);
  const time = normalizeTime(req.body?.time);
  try {
    if (!venue || !date || !people || !time) {
      return res.status(400).json({
        error: 'venue, date, time and party are all required',
        got: { venue: req.body?.venue ?? null, date: req.body?.date ?? null, time: req.body?.time ?? null, party: req.body?.party ?? null },
        expected: { venue: 'creek | estate', date: 'YYYY-MM-DD', time: 'HH:MM (24h)', party: 'a number, 1-40' },
      });
    }
    if (!String(name || '').trim() || !String(phone || '').trim()) {
      return res.status(400).json({ error: 'A name and phone number are required.' });
    }
    const r = await resosForVenue(req.vapiCompanyId, String(venue));
    if (!r) return res.status(404).json({ error: 'Unknown venue', known_venues: ['creek', 'estate'] });
    if (!r.cfg) return res.status(503).json({ error: 'That venue does not take online bookings.' });

    // Re-check against ResOS: never write a time it is not currently offering.
    const { times } = await availableTimes(r.base, r.cfg.api_key, { people, date });
    if (!times.includes(time)) {
      return res.status(409).json({
        error: 'That time is no longer available.',
        spoken: 'I am sorry, that time has just gone. Shall I check what else is open?',
        slots: (times || []).map((t) => ({ time: t, spoken: spokenTime(t) })),
      });
    }

    const hasEmail = typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
    const booking = await createBooking(r.base, r.cfg.api_key, {
      date, time, people,
      guest: {
        name: String(name).trim().slice(0, 200),
        phone: toE164(phone),
        ...(hasEmail ? { email: email.trim().toLowerCase().slice(0, 255) } : {}),
        notificationEmail: hasEmail,
      },
      source: 'phone',
      status: 'approved',
      comment: String(comment || '').trim().slice(0, 1000),
      languageCode: 'en',
    });

    const bookingId = typeof booking === 'string' ? booking : (booking?._id || booking?.id || null);
    await logCall(req.vapiCompanyId, '/book', true, `${venue} ${date} ${time} party=${people} id=${bookingId}`, clientIpOf(req));
    res.json({
      ok: true, venue, date, time, party: people, booking_id: bookingId,
      emailed: hasEmail,
      spoken: `You are booked for ${people} at ${spokenTime(time)} on ${new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`,
    });
  } catch (e) {
    console.error('[vapi] /book failed:', e.message);
    await logCall(req.vapiCompanyId, '/book', false, e.message, clientIpOf(req));
    res.status(502).json({ error: 'Could not complete that booking.', spoken: 'I could not complete that booking. Let me take a message and someone will call you back.' });
  }
});

// ── Space rental ─────────────────────────────────────────────────────────────

const EVENT_REQUEST_URL = process.env.EVENT_REQUEST_URL || 'https://www.kindredvineyards.com/events/request/';

/**
 * POST /space-rental-link  { phone, name? }
 *
 * Texts the caller the application form rather than trying to take a private
 * event booking by voice. The form needs a date, guest count, address and email
 * to produce a quote — that is a bad conversation on the phone and a worse one
 * to get wrong, since the quote is stored by value and honoured afterwards.
 */
vapiRouter.post('/space-rental-link', async (req, res) => {
  const { phone, name } = req.body || {};
  try {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 10) {
      return res.status(400).json({ error: 'A valid phone number is required.' });
    }
    const greeting = String(name || '').trim() ? `Hi ${String(name).trim().split(/\s+/)[0]}, ` : '';
    const body = `${greeting}here is the link to enquire about hosting your event at Kindred Vineyards: ${EVENT_REQUEST_URL}`;
    await sendSmsToPhone(req.vapiCompanyId, toE164(digits), body, null);

    await logCall(req.vapiCompanyId, '/space-rental-link', true, `sent to ...${digits.slice(-4)}`, clientIpOf(req));
    res.json({
      ok: true, sent_to: `...${digits.slice(-4)}`, url: EVENT_REQUEST_URL,
      spoken: 'I have just texted you the link to our event enquiry form.',
    });
  } catch (e) {
    console.error('[vapi] /space-rental-link failed:', e.message);
    await logCall(req.vapiCompanyId, '/space-rental-link', false, e.message, clientIpOf(req));
    res.status(502).json({ error: 'Could not send the text.', spoken: 'I could not send that text just now. Let me take a message instead.' });
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
    endpoints: ['/ping', '/hours', '/hours/{venue}', '/availability', '/book', '/space-rental-link'],
  });
});
