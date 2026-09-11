/**
 * Eventbrite API v3 client.
 *
 * Mirrors googleBusinessClient.js: OAuth connect stores a token on
 * company_integrations, and postEventToEventbrite() creates + publishes a real
 * Eventbrite event from a TeamHub event.
 *
 * Eventbrite specifics:
 *   - OAuth access tokens DO NOT expire and there is no refresh token, so the
 *     stored token is the whole credential.
 *   - An event is created as a draft, then needs at least one ticket class, then
 *     a separate publish call. Publish enforces listing completeness, so we treat
 *     a created-but-unpublished event as a draft a person can finish rather than
 *     a hard failure.
 *   - start/end are sent as a real UTC instant plus an IANA timezone. TeamHub
 *     stores event times as wall-clock-labelled-UTC (18:00Z means 6 PM at the
 *     venue), so we reinterpret that clock face in the venue timezone to get the
 *     true UTC instant Eventbrite wants.
 */
import { query } from '../db.js';

const OAUTH_AUTHORIZE = 'https://www.eventbrite.com/oauth/authorize';
const OAUTH_TOKEN = 'https://www.eventbrite.com/oauth/token';
const API_BASE = 'https://www.eventbriteapi.com/v3';
const EVENT_TZ = process.env.EVENTBRITE_EVENT_TZ || 'America/Boise';

export function eventbriteConfigured() {
  return !!(process.env.EVENTBRITE_CLIENT_ID && process.env.EVENTBRITE_CLIENT_SECRET);
}

function clientCreds() {
  const clientId = process.env.EVENTBRITE_CLIENT_ID;
  const clientSecret = process.env.EVENTBRITE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const e = new Error('Eventbrite is not configured on this server. Set EVENTBRITE_CLIENT_ID and EVENTBRITE_CLIENT_SECRET.');
    e.statusCode = 503;
    throw e;
  }
  return { clientId, clientSecret };
}

export function getAuthorizeUrl(redirectUri, state) {
  const { clientId } = clientCreds();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

export async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = clientCreds();
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Eventbrite token exchange failed: ${err}`);
  }
  return res.json(); // { access_token, token_type, ... } — no refresh token
}

async function getToken(companyId) {
  const row = (await query(
    `SELECT eventbrite_token FROM company_integrations WHERE company_id = $1`,
    [companyId]
  )).rows[0];
  if (!row?.eventbrite_token) {
    const e = new Error('Eventbrite is not connected. Go to Settings → Integrations to connect.');
    e.code = 'not_connected'; e.statusCode = 409; throw e;
  }
  return row.eventbrite_token;
}

async function apiFetch(companyId, path, { method = 'GET', body, token } = {}) {
  const t = token || await getToken(companyId);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error_description || data?.error || text || `HTTP ${res.status}`;
    const e = new Error(`Eventbrite API ${res.status}: ${msg}`);
    e.statusCode = res.status; e.body = data; throw e;
  }
  return data;
}

export async function getMe(token) {
  const res = await fetch(`${API_BASE}/users/me/`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

/** Organizations the connected user can create events under. */
export async function listOrganizations(companyId, token) {
  const data = await apiFetch(companyId, '/users/me/organizations/', { token });
  return data.organizations || [];
}

// Reinterpret a wall-clock-labelled-UTC Date as local time in `tz`, returning the
// true UTC instant. e.g. a Date whose UTC face is 18:00 becomes the UTC moment
// that is 6:00 PM in America/Boise (handles DST).
function wallClockUtcToRealUtc(date, tz) {
  const y = date.getUTCFullYear(), mo = date.getUTCMonth(), d = date.getUTCDate();
  const h = date.getUTCHours(), mi = date.getUTCMinutes();
  const naive = Date.UTC(y, mo, d, h, mi);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(naive)).map((x) => [x.type, x.value]));
  const seenAsUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  const offset = seenAsUTC - naive; // ms tz is ahead of UTC at that instant
  return new Date(naive - offset);
}

const isoZ = (dt) => dt.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Create (or reuse) an Eventbrite venue for a TeamHub location from its address. */
async function ensureVenue(companyId, orgId, ev) {
  if (!ev.location_id) return null;
  const vd = (await query(
    `SELECT eventbrite_venue_id, street, city, region, postal, lat, lng
       FROM kindred_web.venue_details WHERE location_id = $1`,
    [ev.location_id]
  )).rows[0];
  if (vd?.eventbrite_venue_id) return vd.eventbrite_venue_id;
  if (!vd || !vd.street) return null; // no address → create the event without a venue

  const venue = await apiFetch(companyId, `/organizations/${orgId}/venues/`, {
    method: 'POST',
    body: {
      venue: {
        name: ev.venue_name || 'Kindred',
        address: {
          address_1: vd.street, city: vd.city || undefined, region: vd.region || undefined,
          postal_code: vd.postal || undefined, country: 'US',
          latitude: vd.lat != null ? String(vd.lat) : undefined,
          longitude: vd.lng != null ? String(vd.lng) : undefined,
        },
      },
    },
  });
  await query(
    `UPDATE kindred_web.venue_details SET eventbrite_venue_id = $2, updated_at = NOW() WHERE location_id = $1`,
    [ev.location_id, venue.id]
  );
  return venue.id;
}

function buildEventBody(ev, venueId) {
  const start = ev.start_at ? wallClockUtcToRealUtc(new Date(ev.start_at), EVENT_TZ) : null;
  let end = ev.end_at ? wallClockUtcToRealUtc(new Date(ev.end_at), EVENT_TZ) : null;
  if (start && !end) end = new Date(start.getTime() + 2 * 3600 * 1000); // default 2h
  const desc = (ev.description || '').toString().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const event = {
    name: { html: (ev.title || 'Event').slice(0, 250) },
    start: { timezone: EVENT_TZ, utc: isoZ(start) },
    end: { timezone: EVENT_TZ, utc: isoZ(end) },
    currency: 'USD',
    listed: true,
    shareable: true,
  };
  if (desc) event.description = { html: desc };
  if (venueId) event.venue_id = venueId;
  return { event };
}

/**
 * Create + publish an Eventbrite event for a TeamHub event. Idempotent-ish: if a
 * live post already exists we return it rather than creating a duplicate.
 *
 * Throws with `.code`:
 *   'not_connected' — no token stored
 * Returns { url, published, eventbrite_event_id }. `published` is false when the
 * event was created but Eventbrite refused to publish (incomplete listing); the
 * URL is then the draft/manage page for a person to finish.
 */
export async function postEventToEventbrite(companyId, eventId, userId = null) {
  const token = await getToken(companyId);

  const existing = (await query(
    `SELECT eventbrite_event_id, url, state FROM eventbrite_event_posts
      WHERE company_id = $1 AND event_id = $2`,
    [companyId, eventId]
  )).rows[0];
  if (existing?.state === 'live') {
    return { url: existing.url, published: true, eventbrite_event_id: existing.eventbrite_event_id, existing: true };
  }

  const ev = (await query(
    `SELECT e.id, e.title, e.description, e.start_at, e.end_at, e.all_day, e.cost,
            e.location_id, l.name AS venue_name
       FROM events e LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.id = $1 AND e.company_id = $2`,
    [eventId, companyId]
  )).rows[0];
  if (!ev) { const e = new Error('Event not found'); e.code = 'not_found'; e.statusCode = 404; throw e; }

  // Resolve (and cache) the organization to create events under.
  let orgId = (await query(`SELECT eventbrite_org_id FROM company_integrations WHERE company_id = $1`, [companyId])).rows[0]?.eventbrite_org_id;
  if (!orgId) {
    const orgs = await listOrganizations(companyId, token);
    orgId = orgs[0]?.id;
    if (!orgId) { const e = new Error('No Eventbrite organization found for this account.'); e.statusCode = 400; throw e; }
    await query(`UPDATE company_integrations SET eventbrite_org_id = $2, updated_at = NOW() WHERE company_id = $1`, [companyId, orgId]);
  }

  const record = async (state, ebId, url, error) => {
    await query(
      `INSERT INTO eventbrite_event_posts (company_id, event_id, eventbrite_event_id, url, state, error, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, event_id) DO UPDATE
         SET eventbrite_event_id = COALESCE(EXCLUDED.eventbrite_event_id, eventbrite_event_posts.eventbrite_event_id),
             url = COALESCE(EXCLUDED.url, eventbrite_event_posts.url),
             state = EXCLUDED.state, error = EXCLUDED.error, updated_at = NOW()`,
      [companyId, eventId, ebId || null, url || null, state, error || null, userId]
    );
  };

  let created;
  try {
    const venueId = await ensureVenue(companyId, orgId, ev);
    created = await apiFetch(companyId, `/organizations/${orgId}/events/`, { method: 'POST', token, body: buildEventBody(ev, venueId) });
  } catch (e) {
    await record('error', null, null, e.message);
    throw e;
  }

  const ebId = created.id;
  const url = created.url || null;

  // A published event needs at least one ticket class. Kindred events are RSVP;
  // paid pricing is noted in the description rather than wired to Eventbrite
  // payouts, so create a free General Admission class.
  try {
    await apiFetch(companyId, `/events/${ebId}/ticket_classes/`, {
      method: 'POST', token,
      body: { ticket_class: { name: 'General Admission', free: true, quantity_total: 200 } },
    });
    await apiFetch(companyId, `/events/${ebId}/publish/`, { method: 'POST', token });
  } catch (e) {
    // Created but couldn't publish — leave it as a draft to finish by hand.
    await record('draft', ebId, url, `Created as draft — finish & publish on Eventbrite: ${e.message}`);
    return { url, published: false, eventbrite_event_id: ebId };
  }

  await record('live', ebId, url, null);
  return { url, published: true, eventbrite_event_id: ebId };
}
