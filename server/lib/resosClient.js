/**
 * Minimal ResOS API client. Mirrors clubsteward's proven integration:
 * Basic auth with `base64(apiKey + ":")`, base https://api.resos.com.
 * Used server-side only (the API key never leaves Team).
 */

const authHeader = (apiKey) => `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;

// ResOS endpoints live under /v1. Normalize whatever base is stored so we always
// hit https://api.resos.com/v1 (a bare base returns ResOS's HTML landing page).
const apiRoot = (base) => `${base.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1`;

async function resosFetch(base, apiKey, pathWithQuery, { method = 'GET', body } = {}) {
  const res = await fetch(`${apiRoot(base)}${pathWithQuery}`, {
    method,
    headers: {
      Authorization: authHeader(apiKey),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

/** Validate a key by making a tiny authenticated request. */
export async function ping(base, apiKey) {
  try {
    const r = await resosFetch(base, apiKey, '/bookings?skip=0&limit=1');
    if (r.ok) return { ok: true };
    return { ok: false, status: r.status, message: typeof r.data === 'string' ? r.data.slice(0, 160) : (r.data?.message || `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * Bookable times for a date + party size, straight from ResOS.
 *
 * ResOS already owns all of this: its own opening hours, seating interval,
 * booking duration (including per-party-size durations), max bookings/guests,
 * and which times are bookable online. Asking it directly means we stop keeping
 * a second, drifting copy of the schedule in kindred_web.hours and stop
 * inventing rules like "the last booking is one slot before closing".
 *
 * Returns { times, closed }: `closed` distinguishes "no opening hours that day"
 * from "open but nothing left", which the picker words differently.
 */
/**
 * Custom booking questions configured in ResOS (e.g. "Receive Newsletter?"),
 * for the slot being booked. Only fields whose activeFlows include 'booking'
 * come back; others exist for ResOS's own flows and don't belong on our form.
 *
 * Pass date (and time, if known) to get the questions that actually apply —
 * see below for why the flag-based shortcut doesn't work.
 */
export async function customFields(base, apiKey, { date, time, people = 2 } = {}) {
  // ResOS attaches a custom field to opening hours, not to the restaurant. A
  // field can therefore apply to Saturday brunch and not to Tuesday lunch, and
  // the only place that mapping is exposed is `activeCustomFields` on each
  // opening hour in the booking flow. So ask about the actual slot being booked.
  //
  // The /customFields list below cannot answer this: it carries
  // `defaultOnAllOpeningHours`, which is true only when someone ticked "all
  // opening hours" at creation. We filtered on that flag, and it silently hid
  // every field attached to specific hours instead — which is how the Creek's
  // two questions, correctly configured, never appeared on the site.
  if (date) {
    const r = await resosFetch(base, apiKey, `/bookingFlow/times?date=${date}&people=${people}`);
    if (r.ok && Array.isArray(r.data)) {
      // A date can run several opening hours at once. If we know the time, take
      // the ones actually offering it; otherwise union them, since showing a
      // question that turns out not to apply beats dropping one that does.
      const matching = time ? r.data.filter((oh) => (oh.availableTimes || []).includes(time)) : [];
      const hours = matching.length ? matching : r.data;
      const byId = new Map();
      for (const oh of hours) for (const f of oh.activeCustomFields || []) byId.set(f._id, f);
      return shapeFields([...byId.values()]);
    }
    // Fall through on a failed lookup: stale questions beat none.
  }

  const r = await resosFetch(base, apiKey, '/customFields');
  if (!r.ok) throw new Error(`ResOS customFields HTTP ${r.status}`);
  return shapeFields((Array.isArray(r.data) ? r.data : []).filter((f) => f.defaultOnAllOpeningHours));
}

function shapeFields(all) {
  return all
    .filter((f) => (f.activeFlows || []).includes('booking'))
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
    .map((f) => ({
      id: f._id,
      name: f.name,
      label: f.label || f.name,
      helptext: f.helptext || null,
      type: f.type,                       // 'radio' | 'checkbox'
      required: !!f.isRequired,
      options: (f.multipleChoiceSelections || []).map((o) => ({ id: o._id, name: o.name })),
    }));
}

// HHMM integer (e.g. 1200, 1630) → "12 PM", "4:30 PM".
function fmtHM(hhmm) {
  const n = Number(hhmm);
  if (!Number.isFinite(n)) return '';
  const h = Math.floor(n / 100), m = n % 100;
  const ap = h < 12 ? 'AM' : 'PM';
  const hh = (h % 12) || 12;
  return m ? `${hh}:${String(m).padStart(2, '0')} ${ap}` : `${hh} ${ap}`;
}
function hoursRange(def) {
  const o = fmtHM(def?.open), c = fmtHM(def?.close);
  return o && c ? `${o} – ${c}` : '';
}

// /openingHours defs, cached briefly per API key — carries the native `special`
// (date-specific override) flag that /bookingFlow/times leaves off each block.
const _ohCache = new Map();
async function openingHoursDefs(base, apiKey) {
  const hit = _ohCache.get(apiKey);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.defs;
  const r = await resosFetch(base, apiKey, '/openingHours');
  const arr = r.ok && Array.isArray(r.data) ? r.data : (r.data?.data || []);
  const defs = new Map(arr.map((x) => [x._id, x]));
  _ohCache.set(apiKey, { at: Date.now(), defs });
  return defs;
}

function sortTimes(arr) {
  return [...new Set((arr || []).filter((t) => /^\d{1,2}:\d{2}$/.test(t)))]
    .sort((a, b) => {
      const [ah, am] = a.split(':').map(Number);
      const [bh, bm] = b.split(':').map(Number);
      return ah * 60 + am - (bh * 60 + bm);
    })
    .map((t) => (t.length === 4 ? `0${t}` : t));
}

export async function availableTimes(base, apiKey, { people, date }) {
  const q = `/bookingFlow/times?people=${encodeURIComponent(people)}` +
    `&date=${encodeURIComponent(date)}&onlyBookableOnline=true`;
  const r = await resosFetch(base, apiKey, q);
  if (!r.ok) throw new Error(`ResOS availableTimes HTTP ${r.status}`);
  const blocks = Array.isArray(r.data) ? r.data : (r.data?.data || []);

  // Each opening-hours block is its own section with its own bookable slots — its
  // interval and capacity differ, so a day can offer "Regular Reservations" every
  // 30 min AND a "Wine Club Release" at just 4:00 & 5:30. Keep them separate for
  // display; the merged `times` is only for the "any time bookable?" checks.
  let defs;
  try { defs = await openingHoursDefs(base, apiKey); } catch { defs = new Map(); }
  const sections = blocks
    .map((b) => {
      const def = defs.get(b?._id) || {};
      return {
        title: String(b?.name || '').trim(),
        special: def.special === true,
        hours: hoursRange(def),
        note: String(b?.note || '').trim() || String(def.note || '').trim(),
        slots: sortTimes(b?.availableTimes),
      };
    })
    .filter((s) => s.slots.length);

  const times = sortTimes(sections.flatMap((s) => s.slots));
  const seenTitle = new Set();
  const specials = sections
    .filter((s) => s.special && s.title && !seenTitle.has(s.title) && seenTitle.add(s.title))
    .map((s) => ({ title: s.title, hours: s.hours, note: s.note }));

  return { times, closed: blocks.length === 0, sections, specials };
}

/** Tables free for a party size within a datetime window. Returns [] on failure. */
export async function availableTables(base, apiKey, { people, fromDateTime, toDateTime }) {
  const q = `/bookingFlow/availableTables?people=${encodeURIComponent(people)}` +
    `&fromDateTime=${encodeURIComponent(fromDateTime)}&toDateTime=${encodeURIComponent(toDateTime)}&returnAllTables=false`;
  const r = await resosFetch(base, apiKey, q);
  if (!r.ok) throw new Error(`ResOS availableTables HTTP ${r.status}`);
  const d = r.data;
  const list = Array.isArray(d) ? d : (d?.availableTables || d?.available || d?.tables || d?.data || []);
  // A table is bookable if not explicitly flagged booked/unavailable.
  return list.filter((t) => t && t.booked !== true && t.available !== false);
}

/** Create a booking. payload: { people, date 'YYYY-MM-DD', time 'HH:MM', guest:{name,email,phone}, comment } */
export async function createBooking(base, apiKey, payload) {
  const r = await resosFetch(base, apiKey, '/bookings', { method: 'POST', body: payload });
  if (!r.ok) {
    const msg = typeof r.data === 'string' ? r.data.slice(0, 200) : (r.data?.message || `HTTP ${r.status}`);
    const err = new Error(`ResOS booking failed: ${msg}`);
    err.status = r.status;
    throw err;
  }
  return r.data;
}

/**
 * Every booking in a date range, with its custom-field answers.
 *
 * Two quirks of the ResOS bookings endpoint are worth knowing, because both
 * fail quietly rather than erroring:
 *
 *  - `fromDateTime` and `toDateTime` only take effect TOGETHER. Send one alone
 *    and the filter is ignored entirely — you get the oldest bookings in the
 *    account and no indication that your range was thrown away.
 *  - `limit` is capped at 100 (that one does error), so a range wider than a
 *    week or so has to be paged.
 *
 * Paging stops on a short page, and also on a page cap, so a filter that isn't
 * doing what we think can't turn into an unbounded crawl of 4,000 bookings.
 */
export async function listBookings(base, apiKey, { from, to, maxPages = 30 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const q = `/bookings?fromDateTime=${from}T00:00:00&toDateTime=${to}T23:59:59&skip=${page * 100}&limit=100`;
    const r = await resosFetch(base, apiKey, q);
    if (!r.ok) throw new Error(`ResOS bookings HTTP ${r.status}`);
    const batch = Array.isArray(r.data) ? r.data : r.data?.bookings || [];
    out.push(...batch);
    if (batch.length < 100) return out;
  }
  return out;
}

/**
 * Render one custom-field answer as something a person can read.
 *
 * ResOS stores the two field types differently, and neither is display-ready:
 * a single-choice answer is the bare option id with the resolved name alongside
 * it, and a checkbox is an array of the selections that were ticked.
 */
/**
 * Is this the newsletter question? Matched on both names because ResOS calls it
 * "Newsletter" internally and "Receive Newsletter/Event Notifications" on the
 * form, and only the label is stable across venues.
 */
export const isNewsletter = (f) => /newsletter/i.test(`${f.name || ''} ${f.label || ''}`);

/**
 * "No" is the only answer that isn't consent; blank means they were never asked.
 * Kept here beside answerText so the screen, the export and the sync cannot
 * drift into three different opinions about what a guest agreed to.
 */
export const optedIn = (text) => Boolean(text) && !/^no$/i.test(String(text).trim());

export function answerText(field) {
  const clean = (s) => String(s || '').replace(/\s*:\s*$/, '').trim();

  if (typeof field.value === 'string') return field.multipleChoiceValueName || field.value;
  if (typeof field.value === 'boolean') return field.value ? 'Yes' : 'No';

  if (Array.isArray(field.value)) {
    const ticked = field.value.filter((v) => v && v.value !== false);
    if (!ticked.length) return 'No';
    const names = ticked.map((v) => clean(v.name)).filter(Boolean);
    // A lone selection that just restates its own question means "yes" — showing
    // "Wine Club Member" under a heading of "Wine Club Member" reads as noise.
    if (names.length === 1 && clean(field.label || field.name).toLowerCase() === names[0].toLowerCase()) return 'Yes';
    return names.join(', ') || 'Yes';
  }
  return field.value == null ? '' : String(field.value);
}
