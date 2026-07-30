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
export async function availableTimes(base, apiKey, { people, date }) {
  const q = `/bookingFlow/times?people=${encodeURIComponent(people)}` +
    `&date=${encodeURIComponent(date)}&onlyBookableOnline=true`;
  const r = await resosFetch(base, apiKey, q);
  if (!r.ok) throw new Error(`ResOS availableTimes HTTP ${r.status}`);
  const blocks = Array.isArray(r.data) ? r.data : (r.data?.data || []);
  // One entry per opening-hour block (lunch/dinner etc.) — flatten and dedupe.
  const times = [...new Set(blocks.flatMap((b) => b?.availableTimes || []))]
    .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .sort((a, b) => {
      const [ah, am] = a.split(':').map(Number);
      const [bh, bm] = b.split(':').map(Number);
      return ah * 60 + am - (bh * 60 + bm);
    })
    .map((t) => (t.length === 4 ? `0${t}` : t));
  return { times, closed: blocks.length === 0 };
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
