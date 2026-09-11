/**
 * Google Business Profile (GBP) API client with automatic token refresh.
 *
 * Reads/writes OAuth tokens from company_integrations (gbp_* columns), mirroring
 * qboClient.js. The durable credential is the offline refresh_token captured at
 * connect time (access_type=offline&prompt=consent); the access_token is short-
 * lived and refreshed on demand.
 *
 * Google split the old "My Business" API into several v1 services plus the
 * legacy v4 for posts:
 *   - Account Management  (accounts)          mybusinessaccountmanagement v1
 *   - Business Information (locations)         mybusinessbusinessinformation v1
 *   - Local posts         (localPosts)         mybusiness v4  (still the only
 *                                              way to create "What's new"/Event
 *                                              posts as of 2026)
 */
import { query } from '../db.js';
import { toGoogle, addDays } from './hoursResolver.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const ACCT_MGMT_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const BIZ_INFO_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const V4_BASE = 'https://mybusiness.googleapis.com/v4';

export const GBP_SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
  'openid',
  'email',
].join(' ');

function clientCreds() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const e = new Error('Google Business Profile is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    e.statusCode = 503;
    throw e;
  }
  return { clientId, clientSecret };
}

async function loadTokens(companyId) {
  const r = await query(
    `SELECT gbp_access_token, gbp_refresh_token, gbp_token_expires_at,
            gbp_account_name, gbp_connected_email
       FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  return r.rows[0] || null;
}

async function saveAccessToken(companyId, accessToken, expiresIn) {
  const expiresAt = new Date(Date.now() + (expiresIn || 3600) * 1000);
  await query(
    `UPDATE company_integrations
        SET gbp_access_token = $2, gbp_token_expires_at = $3, updated_at = NOW()
      WHERE company_id = $1`,
    [companyId, accessToken, expiresAt]
  );
  return accessToken;
}

async function refreshAccessToken(companyId, refreshToken) {
  const { clientId, clientSecret } = clientCreds();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token refresh failed: ${err}`);
  }
  const tokens = await res.json();
  return saveAccessToken(companyId, tokens.access_token, tokens.expires_in);
}

export async function getAccessToken(companyId) {
  const row = await loadTokens(companyId);
  if (!row?.gbp_refresh_token) {
    const e = new Error('Google Business Profile is not connected. Go to Settings → Integrations to connect.');
    e.statusCode = 409;
    throw e;
  }
  const expiresAt = row.gbp_token_expires_at ? new Date(row.gbp_token_expires_at) : null;
  const isExpired = !row.gbp_access_token || !expiresAt || Date.now() >= expiresAt.getTime() - 60_000;
  if (isExpired) return refreshAccessToken(companyId, row.gbp_refresh_token);
  return row.gbp_access_token;
}

/**
 * Exchange an authorization code for tokens (used by the OAuth callback).
 * Returns the raw token response (includes refresh_token on first consent).
 */
export async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = clientCreds();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }
  return res.json();
}

export async function getUserEmail(accessToken) {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.email || null;
}

async function apiFetch(companyId, url, { method = 'GET', body } = {}) {
  const token = await getAccessToken(companyId);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || text || `HTTP ${res.status}`;
    const e = new Error(`Google API ${res.status}: ${msg}`);
    e.statusCode = res.status;
    e.body = data;
    throw e;
  }
  return data;
}

/** List the Business Profile accounts the connected user can manage. */
export async function listAccounts(companyId) {
  const out = [];
  let pageToken = '';
  do {
    const url = new URL(`${ACCT_MGMT_BASE}/accounts`);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await apiFetch(companyId, url.toString());
    out.push(...(data.accounts || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

/** List locations under an account (resource name "accounts/{id}"). */
export async function listLocations(companyId, accountName) {
  const out = [];
  let pageToken = '';
  const readMask = 'name,title,storefrontAddress,metadata';
  do {
    const url = new URL(`${BIZ_INFO_BASE}/${accountName}/locations`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('readMask', readMask);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await apiFetch(companyId, url.toString());
    out.push(...(data.locations || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

/**
 * Create a local post on a location.
 * locationResource must be the v4 form "accounts/{acct}/locations/{loc}".
 * post is the LocalPost body (summary, event, callToAction, media, topicType…).
 */
export async function createLocalPost(companyId, locationResource, post) {
  const url = `${V4_BASE}/${locationResource}/localPosts`;
  return apiFetch(companyId, url, { method: 'POST', body: post });
}

/** Delete a local post by its full resource name. */
export async function deleteLocalPost(companyId, localPostName) {
  const url = `${V4_BASE}/${localPostName}`;
  return apiFetch(companyId, url, { method: 'DELETE' });
}

/**
 * Patch a location's opening hours via the Business Information API v1.
 * locationName is "locations/{id}" (no account prefix). hours is
 * { regularHours, specialHours } in BI-API v1 shape (TimeOfDay objects).
 */
export async function updateLocationHours(companyId, locationName, { regularHours, specialHours }) {
  const url = new URL(`${BIZ_INFO_BASE}/${locationName}`);
  url.searchParams.set('updateMask', 'regularHours,specialHours');
  return apiFetch(companyId, url.toString(), {
    method: 'PATCH',
    body: { regularHours, specialHours },
  });
}

// ── High-level: post one event to its venue's Google Business Profile ─────────
function publicSiteBase() {
  return (process.env.PUBLIC_SITE_BASE || 'https://kindredvineyards.com').replace(/\/$/, '');
}

// Break a JS Date into Google's {year,month,day} / {hours,minutes}.
//
// TeamHub stores event times as wall-clock labelled UTC: 18:00Z *means* 6 PM at
// the venue, not 6 PM UTC. (eventDistribution.whenText formats with timeZone
// 'UTC' for exactly this reason.) Google's Event schedule carries no offset —
// startTime is bare hours/minutes shown in the venue's local time — so we read
// the UTC clock face straight through. Shifting into a real zone would move
// 6 PM to 11 AM, which is the bug this fixes.
function googleDateParts(date) {
  return {
    date: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    time: { hours: date.getUTCHours(), minutes: date.getUTCMinutes() },
  };
}

export function buildLocalPost(ev) {
  const url = ev.event_url || (ev.slug ? `${publicSiteBase()}/events/${ev.slug}` : publicSiteBase());
  const start = ev.start_at ? new Date(ev.start_at) : null;
  const end = ev.end_at ? new Date(ev.end_at) : null;

  const schedule = {};
  if (start) {
    const s = googleDateParts(start);
    schedule.startDate = s.date;
    if (!ev.all_day) schedule.startTime = s.time;
  }
  if (end) {
    const e = googleDateParts(end);
    schedule.endDate = e.date;
    if (!ev.all_day) schedule.endTime = e.time;
  } else if (start) {
    schedule.endDate = schedule.startDate; // single-day event
  }

  const summary = (ev.description || ev.title || '').toString().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
  const post = {
    languageCode: 'en-US',
    topicType: 'EVENT',
    summary,
    event: { title: (ev.title || 'Event').slice(0, 58), schedule },
    callToAction: { actionType: 'LEARN_MORE', url },
  };
  const image = ev.social_image_url || ev.image_url || ev.fb_image_url;
  if (image) post.media = [{ mediaFormat: 'PHOTO', sourceUrl: image }];
  return post;
}

/**
 * Load an event, resolve its venue's Google location from the saved mapping,
 * create the local post, and record the result in gbp_event_posts.
 *
 * Throws an Error with `.code`:
 *   'not_connected' — no refresh token stored
 *   'not_mapped'    — the event's venue has no Google location mapped
 * and any API error (with .statusCode) otherwise. Returns
 * { name, searchUrl, resource } on success.
 */
export async function postEventToGoogleBusiness(companyId, eventId, userId = null) {
  const ev = (await query(
    `SELECT id, title, description, start_at, end_at, all_day, event_url, slug,
            image_url, social_image_url, fb_image_url, location_id
       FROM events WHERE id = $1 AND company_id = $2`,
    [eventId, companyId]
  )).rows[0];
  if (!ev) { const e = new Error('Event not found'); e.code = 'not_found'; e.statusCode = 404; throw e; }

  const connected = (await query(
    `SELECT gbp_refresh_token IS NOT NULL AS connected FROM company_integrations WHERE company_id = $1`,
    [companyId]
  )).rows[0]?.connected;
  if (!connected) { const e = new Error('Google Business Profile is not connected.'); e.code = 'not_connected'; e.statusCode = 409; throw e; }

  // Per-venue push target lives on venue_details.gbp_location (keyed by location).
  const resource = ev.location_id ? (await query(
    `SELECT gbp_location FROM kindred_web.venue_details WHERE location_id = $1`,
    [ev.location_id]
  )).rows[0]?.gbp_location : null;
  if (!resource) {
    const e = new Error("This event's venue is not mapped to a Google location. Map it in Settings → Integrations.");
    e.code = 'not_mapped'; e.statusCode = 400; throw e;
  }

  const body = buildLocalPost(ev);
  let created;
  try {
    created = await createLocalPost(companyId, resource, body);
  } catch (err) {
    await query(
      `INSERT INTO gbp_event_posts (company_id, event_id, location_resource, state, error, created_by)
       VALUES ($1,$2,$3,'error',$4,$5)
       ON CONFLICT (company_id, event_id, location_resource)
       DO UPDATE SET state='error', error=$4, updated_at=NOW()`,
      [companyId, eventId, resource, err.message, userId]
    );
    throw err;
  }

  await query(
    `INSERT INTO gbp_event_posts (company_id, event_id, location_resource, local_post_name, state, search_url, error, created_by)
     VALUES ($1,$2,$3,$4,'live',$5,NULL,$6)
     ON CONFLICT (company_id, event_id, location_resource)
     DO UPDATE SET local_post_name=$4, state='live', search_url=$5, error=NULL, updated_at=NOW()`,
    [companyId, eventId, resource, created?.name || null, created?.searchUrl || null, userId]
  );

  return { name: created?.name || null, searchUrl: created?.searchUrl || null, resource };
}

// ── High-level: push a venue's opening hours to its Google Business Profile ────
const HOURS_DEPT = 'main';           // the venue's public-facing hours
const SPECIAL_WINDOW_DAYS = 120;     // how far ahead to send dated exceptions

// venue_details.gbp_location is the v4 form "accounts/{a}/locations/{l}"; the
// Business Information API addresses the same place as "locations/{l}".
function biLocationName(gbpLocation) {
  const m = String(gbpLocation || '').match(/locations\/[^/]+/);
  return m ? m[0] : null;
}

// Today's date 'YYYY-MM-DD' in the venue's timezone (Kindred is America/Boise).
function todayLocal(tz = 'America/Boise') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// "HH:MM" -> Business Information API TimeOfDay { hours, minutes }.
const toTimeOfDay = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return { hours: h || 0, minutes: m || 0 };
};

// hoursResolver.toGoogle emits string times (its legacy v4 shape); the BI API v1
// wants TimeOfDay objects and an explicit endDate on every special period.
function toBusinessInfoHours(g) {
  return {
    regularHours: {
      periods: (g.regularHours?.periods || []).map((p) => ({
        openDay: p.openDay, openTime: toTimeOfDay(p.openTime),
        closeDay: p.closeDay, closeTime: toTimeOfDay(p.closeTime),
      })),
    },
    specialHours: {
      specialHourPeriods: (g.specialHours?.specialHourPeriods || []).map((sp) =>
        sp.closed
          ? { startDate: sp.startDate, endDate: sp.endDate || sp.startDate, closed: true }
          : {
              startDate: sp.startDate, endDate: sp.endDate || sp.startDate,
              openTime: toTimeOfDay(sp.openTime), closeTime: toTimeOfDay(sp.closeTime), closed: false,
            }
      ),
    },
  };
}

/**
 * Push regular + special hours for one venue to Google.
 *
 * Reads the same kindred_web.hours / hours_special rows the website and the
 * "Open now" badge read, resolves them through hoursResolver.toGoogle (weekly
 * pattern + dated exceptions, seasonal rules expanded to dates because Google
 * has no season concept), converts to BI-API v1 shape, and PATCHes the location.
 * Records the push in hours_publish_log.
 *
 * Throws with `.code` 'not_connected' or 'not_mapped' so callers can treat those
 * as "nothing to do yet" rather than errors.
 */
export async function pushHoursToGoogle(companyId, locationId, userId = null) {
  const connected = (await query(
    `SELECT gbp_refresh_token IS NOT NULL AS connected FROM company_integrations WHERE company_id = $1`,
    [companyId]
  )).rows[0]?.connected;
  if (!connected) { const e = new Error('Google Business Profile is not connected.'); e.code = 'not_connected'; e.statusCode = 409; throw e; }

  const gbpLocation = (await query(
    `SELECT gbp_location FROM kindred_web.venue_details WHERE location_id = $1`,
    [locationId]
  )).rows[0]?.gbp_location;
  const locationName = biLocationName(gbpLocation);
  if (!locationName) {
    const e = new Error('This venue is not mapped to a Google location.'); e.code = 'not_mapped'; e.statusCode = 400; throw e;
  }

  const rules = (await query(
    `SELECT day_of_week,
            to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes,
            to_char(from_date,'YYYY-MM-DD') AS from_date,
            to_char(to_date,'YYYY-MM-DD')   AS to_date, label
       FROM kindred_web.hours WHERE location_id = $1 AND department = $2`,
    [locationId, HOURS_DEPT]
  )).rows;
  const specials = (await query(
    `SELECT to_char(on_date,'YYYY-MM-DD') AS on_date, is_closed,
            to_char(opens,'HH24:MI') AS opens, to_char(closes,'HH24:MI') AS closes, note
       FROM kindred_web.hours_special WHERE location_id = $1 AND department = $2`,
    [locationId, HOURS_DEPT]
  )).rows;

  const from = todayLocal();
  const to = addDays(from, SPECIAL_WINDOW_DAYS);
  const g = toBusinessInfoHours(toGoogle(rules, specials, from, to));

  await updateLocationHours(companyId, locationName, g);

  await query(
    `INSERT INTO kindred_web.hours_publish_log (company_id, location_id, google, confirmed_by)
     VALUES ($1, $2, true, $3)`,
    [companyId, locationId, userId]
  );

  return {
    location: locationName,
    regular_periods: g.regularHours.periods.length,
    special_periods: g.specialHours.specialHourPeriods.length,
  };
}
