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

// ── High-level: post one event to its venue's Google Business Profile ─────────
const EVENT_TZ = process.env.GBP_EVENT_TZ || 'America/Los_Angeles';
function publicSiteBase() {
  return (process.env.PUBLIC_SITE_BASE || 'https://kindredvineyards.com').replace(/\/$/, '');
}

// Break a JS Date into Google's {year,month,day} / {hours,minutes} in EVENT_TZ.
function googleDateParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: EVENT_TZ, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  let hours = parseInt(parts.hour, 10);
  if (hours === 24) hours = 0; // some ICU builds emit 24 for midnight
  return {
    date: { year: +parts.year, month: +parts.month, day: +parts.day },
    time: { hours, minutes: parseInt(parts.minute, 10) },
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
