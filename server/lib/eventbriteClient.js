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
 *   - A TICKETED event is deliberately NOT listed. Selling through Eventbrite
 *     means Eventbrite takes the payment, which we do not want: it is a second
 *     payment rail to reconcile against Square, and for alcohol-inclusive
 *     admission the licensee should be the one taking the money. The two
 *     alternatives are both worse than not listing. Publishing it with a free
 *     ticket would state the wrong price and fail Eventbrite's own requirement
 *     that a listing "use Eventbrite to offer valid free or paid registrations";
 *     and a listing that shows the price but sends buyers elsewhere needs the
 *     external_ticketing feature, which answers a standard account with
 *     403 NOT_AUTHORIZED. So cost > 0 means "not applicable", and the event
 *     still reaches aggregators through the ICS/JSON-LD feed, which carries the
 *     real price. See docs/EVENT_DISTRIBUTION.md.
 */
import { query } from '../db.js';
import { publicVenueName, classifyBookingLink, bookingLinkFor } from './eventFeed.js';
import sharp from 'sharp';

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
/** Where a relative upload path resolves to, for fetching our own images. */
const SELF_BASE = process.env.PUBLIC_BASE_URL || 'https://team.kindredvineyards.com';

/** Eventbrite's event logo: 2:1, 2160x1080 recommended, 940x470 minimum. */
const EB_IMAGE_W = 2160;
const EB_IMAGE_H = 1080;

/**
 * Fit our artwork to Eventbrite's 2:1 without cropping it or stretching it.
 *
 * Nothing is cut. Kindred's banner art is 2.4:1 with the typography hard
 * against both edges -- "THURSDAYS" ends about 20px from the right -- so a
 * crop to 2:1 takes 16.7% off the width and decapitates the S, the K of CREEK,
 * the K of the KINDRED sign and the end of "ACOUSTIC LIVE MUSIC". Crop-to-fill
 * is therefore off the table for this set.
 *
 * The art is also not one shape: 2.4:1 banners, a 16:9, and 640x640 squares.
 * Flat letterbox bars suit the banners (a 2.4:1 gains a sliver top and bottom)
 * but ruin a square, which would sit in the middle 50% of the frame with the
 * rest a solid slab. So the gap is filled with a blurred, darkened copy of the
 * image itself: on a banner it reads as a soft glow, on a square it reads as
 * deliberate, and in both cases every pixel of the original survives.
 *
 * The result is exactly 2160x1080, which is what Eventbrite recommends.
 */
async function fitToEventbriteLogo(buf) {
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) throw new Error('unreadable image');

  // Background: cover the whole frame, then blur it past recognition. Darkened
  // a little so it recedes behind the real image rather than competing with it.
  const background = await sharp(buf, { failOn: 'none' })
    .resize(EB_IMAGE_W, EB_IMAGE_H, { fit: 'cover', position: 'centre' })
    .blur(60)
    .modulate({ brightness: 0.55 })
    .toBuffer();

  // Foreground: the whole image, scaled to fit inside the frame. `contain`
  // never crops and never changes the aspect ratio.
  // .png() is load-bearing, not tidiness. toBuffer() keeps the INPUT format, and
  // most of this art is JPEG, which has no alpha channel — so `contain`'s
  // transparent padding flattened to opaque black and the composite covered the
  // blurred background completely, producing exactly the flat bars this is meant
  // to avoid. PNG carries the transparency through to the composite.
  const foreground = await sharp(buf, { failOn: 'none' })
    .resize(EB_IMAGE_W, EB_IMAGE_H, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return sharp(background)
    .composite([{ input: foreground, blend: 'over' }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

/**
 * Put an image on an Eventbrite event. Returns a logo id, or null.
 *
 * Never throws. An event with no picture still beats no event at all, so every
 * failure here -- unreachable file, image Eventbrite rejects, upload hiccup --
 * leaves the listing to publish without one.
 */
async function uploadEventImage(companyId, token, imageUrl) {
  if (!imageUrl) return null;
  try {
    // Stored images are usually absolute, but an upload path can be relative.
    const src = imageUrl.startsWith('http') ? imageUrl : `${SELF_BASE}${imageUrl}`;
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetching the image gave HTTP ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer());
    const fitted = await fitToEventbriteLogo(raw);

    // 1. ask where to put it
    const hand = await apiFetch(companyId, '/media/upload/?type=image-event-logo', { token });
    const form = new FormData();
    for (const [k, v] of Object.entries(hand.upload_data || {})) if (v) form.append(k, v);
    form.append(hand.file_parameter_name || 'file',
      new Blob([fitted], { type: 'image/jpeg' }), 'event.jpg');

    // 2. put it there (their storage, not the API host — no Authorization)
    const put = await fetch(hand.upload_url, { method: hand.upload_method || 'POST', body: form });
    if (!put.ok) throw new Error(`the upload host gave HTTP ${put.status}`);

    // 3. tell the API it landed. The crop mask is the whole image: we have
    //    already made it the right shape, and letting Eventbrite crop again
    //    would undo the point of the letterboxing.
    const media = await apiFetch(companyId, '/media/upload/', {
      method: 'POST', token,
      body: {
        upload_token: hand.upload_token,
        crop_mask: { top_left: { x: 0, y: 0 }, width: EB_IMAGE_W, height: EB_IMAGE_H },
      },
    });
    return media?.id || null;
  } catch (e) {
    console.error('uploadEventImage', e.message);
    return null;
  }
}

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
        // The PUBLIC name. locations.name is an internal label -- "Creek",
        // "Winery" -- and an Eventbrite venue called "Creek, 616 Main Street"
        // is both wrong and unsearchable. Same rule as the feeds, same one
        // function, keyed on web_slug so renaming the internal label cannot
        // change what the outside world is told.
        name: publicVenueName(ev.venue_web_slug, ev.venue_name),
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

/**
 * Put a real body on the Eventbrite listing: the description, plus the booking
 * link when the event carries one.
 *
 * `description.html` on the event object is NOT this. Eventbrite renders the
 * page body from `structured_content`, and ours had zero modules, so the body of
 * every listing we created was effectively blank. structured_content is also the
 * only one of the two that keeps a link -- the plain description is flattened to
 * text, so an <a> there is simply lost.
 *
 * The version number must increment on every write, hence the read first. A
 * freshly created event sits at version 1 with no modules.
 *
 * Deliberately never throws. This runs before publish, so a failure here would
 * cost us the whole listing, and a listing with a thin body still beats none.
 */
async function setListingBody(companyId, token, ebId, ev) {
  const esc = (v) => String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const paras = [];

  // The booking route leads, the description follows it.
  //
  // This is the whole body of the listing now. The event carries no
  // `description` field -- Eventbrite refuses summary and description together
  // -- so the Overview reads: short summary, then these modules. Putting the
  // booking call first therefore puts it near the top of the page instead of
  // behind the "Read more" fold, which was where a full-length description had
  // been burying it.
  //
  // And not just the booking_url field: that field is only filled for events
  // whose booking cannot be derived, so a normal event's route is its own page
  // on the website. Reading the field alone is why these listings first went up
  // with no booking route at all.
  const { url: booking, kind } = bookingLinkFor(ev);
  if (booking) {
    // A real button is not available. Eventbrite's sanitizer drops style, class
    // and font attributes outright -- probed against a throwaway draft, not
    // guessed -- and keeps only headings and bold. A bold heading link is
    // therefore the most button-like thing that survives, which is why this is
    // an <h3> and not a styled anchor.
    if (kind === 'tickets') {
      paras.push(`<h3><strong><a href="${esc(booking)}">Get tickets here</a></strong></h3>`);
    } else if (kind === 'booking' || kind === 'site') {
      // Named after Eventbrite's own button, because the confusion being
      // prevented is specifically between that button and a table. "Registering
      // does not hold a table" leaves the guest to make the connection; this
      // does not.
      paras.push('<p><strong>Eventbrite\u2019s \u201cReserve a spot\u201d does not reserve a table.</strong></p>');
      paras.push(`<h3><strong><a href="${esc(booking)}">Reserve a Table here</a></strong></h3>`);
    } else {
      paras.push(`<h3><strong><a href="${esc(booking)}">Book here</a></strong></h3>`);
    }
  }

  // The description, after the call to action rather than before it.
  const desc = (ev.description || '').toString().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (desc) paras.push(`<p>${esc(desc)}</p>`);
  if (!paras.length) return;

  try {
    const cur = await apiFetch(companyId, `/events/${ebId}/structured_content/`, { token });
    const next = Number(cur?.page_version_number || 1) + 1;
    await apiFetch(companyId, `/events/${ebId}/structured_content/${next}/`, {
      method: 'POST', token,
      body: {
        modules: [{ type: 'text', data: { body: { type: 'text', text: paras.join(''), alignment: 'left' } } }],
        publish: true,
        purpose: 'listing',
      },
    });
  } catch (e) { console.error('eventbrite listing body', ebId, e.message); }
}

/**
 * One sentence of teaser, inside Eventbrite's 140-character summary limit.
 *
 * Cuts at a sentence end when there is one in range, otherwise at the last word
 * -- a summary clipped mid-word reads like a bug on a public page.
 */
function summarise(desc, limit = 140) {
  const t = String(desc || '').trim();
  if (!t) return undefined;
  if (t.length <= limit) return t;
  const window = t.slice(0, limit);
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentence > 60) return window.slice(0, sentence + 1);
  const word = window.lastIndexOf(' ');
  return (word > 60 ? window.slice(0, word) : window.slice(0, limit - 1)).replace(/[,;:\s]+$/, '') + '\u2026';
}

function buildEventBody(ev, venueId) {
  const start = ev.start_at ? wallClockUtcToRealUtc(new Date(ev.start_at), EVENT_TZ) : null;
  let end = ev.end_at ? wallClockUtcToRealUtc(new Date(ev.end_at), EVENT_TZ) : null;
  if (start && !end) end = new Date(start.getTime() + 2 * 3600 * 1000); // default 2h
  const desc = (ev.description || '').toString().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const event = {
    name: { html: (ev.title || 'Event').slice(0, 250) },
    // A short summary, and NOT a description. Eventbrite rejects both together
    // with SUMMARY_DESCRIPTION_CONFLICT: `description` is the legacy field, and
    // the modern body is structured content, so the pair is summary + modules.
    //
    // The Overview renders summary first, then the structured content. Leaving
    // summary unset made Eventbrite derive it from the description at full
    // length, so the page opened with the whole description and then repeated
    // it below -- with the booking call buried between the two copies, past the
    // "Read more" fold. One short sentence here lifts the booking call to just
    // under a teaser.
    //
    // It stays a real teaser rather than the warning on purpose: this is the
    // snippet Eventbrite shows in search results and hands to aggregators.
    summary: summarise(desc),
    start: { timezone: EVENT_TZ, utc: isoZ(start) },
    end: { timezone: EVENT_TZ, utc: isoZ(end) },
    currency: 'USD',
    listed: true,
    shareable: true,
  };
  // No description field: see the summary comment above. The full text goes
  // into structured content instead, which is also the only place a link
  // survives.

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
/**
 * Bring an already-live listing back into line with the event.
 *
 * Eventbrite edits a live event with the same calls that create one, so this is
 * mostly the creation path minus the creating. Three things get refreshed:
 *
 *   details    name, start, end, venue -- the whole body, so a venue rename or a
 *              time change lands too
 *   image      only when it would actually differ. image_source_url remembers
 *              what we last pushed, so an unchanged picture is left alone rather
 *              than re-uploaded on every edit
 *   page body  always rewritten; structured_content is versioned, so a repeat
 *              write is harmless and the booking link cannot drift
 *
 * The ticket class is deliberately untouched. Changing capacity or a name on a
 * class people have already registered against is a decision for a person, not
 * a side effect of fixing a typo in the description.
 *
 * Returns { updated: true, changed: [...] } so the caller can say what moved.
 */
async function updateLiveListing({ companyId, token, orgId, ev, existing, record }) {
  const ebId = existing.eventbrite_event_id;
  const changed = [];

  // Never refresh an event that is over. Found the hard way: the first backfill
  // pushed fresh artwork at a show that had ended the night before, and
  // Eventbrite flipped it from 'live' to 'completed' the moment it was touched.
  // Nobody can register for it, so every call spent on it is waste, and touching
  // a finished listing only invites surprises.
  const endsAt = ev.end_at
    ? wallClockUtcToRealUtc(new Date(ev.end_at), EVENT_TZ)
    : ev.start_at
      ? new Date(wallClockUtcToRealUtc(new Date(ev.start_at), EVENT_TZ).getTime() + 2 * 3600 * 1000)
      : null;
  if (endsAt && endsAt < new Date()) {
    return {
      url: existing.url, published: true, eventbrite_event_id: ebId,
      updated: false, changed: [], skipped: 'past',
    };
  }

  const venueId = await ensureVenue(companyId, orgId, ev);
  await apiFetch(companyId, `/events/${ebId}/`, {
    method: 'POST', token, body: buildEventBody(ev, venueId),
  });
  changed.push('details');

  // The image, only if it would really change. Two reasons to push: we have
  // artwork the listing is missing (the backfill case), or the event's artwork
  // is not the one we last uploaded.
  const want = ev.image_url || ev.social_image_url || null;
  if (want) {
    let hasLogo = true;
    try {
      const live = await apiFetch(companyId, `/events/${ebId}/`, { token });
      hasLogo = !!live.logo?.url;
    } catch { /* if we cannot tell, fall through to the recorded source */ }
    if (!hasLogo || existing.image_source_url !== want) {
      try {
        const logoId = await uploadEventImage(companyId, token, want);
        if (logoId) {
          await apiFetch(companyId, `/events/${ebId}/`, {
            method: 'POST', token, body: { event: { logo_id: logoId } },
          });
          changed.push('image');
        }
      } catch (e) { console.error('eventbrite image', ebId, e.message); }
    }
  }

  await setListingBody(companyId, token, ebId, ev);
  changed.push('page body');

  const url = existing.url || null;
  await record('live', ebId, url, null, changed.includes('image') ? want : null);
  return { url, published: true, eventbrite_event_id: ebId, updated: true, changed };
}

/** Cancel a published Eventbrite event (keeps the listing but marks it cancelled). */
export async function cancelEventbriteEvent(companyId, eventbriteEventId) {
  return apiFetch(companyId, `/events/${eventbriteEventId}/cancel/`, { method: 'POST' });
}

export async function postEventToEventbrite(companyId, eventId, userId = null) {
  const token = await getToken(companyId);

  const existing = (await query(
    `SELECT eventbrite_event_id, url, state, image_source_url FROM eventbrite_event_posts
      WHERE company_id = $1 AND event_id = $2`,
    [companyId, eventId]
  )).rows[0];

  const ev = (await query(
    `SELECT e.id, e.title, e.description, e.start_at, e.end_at, e.all_day, e.cost,
            e.image_url, e.social_image_url, e.booking_url, e.resos_experience_url,
            e.slug, e.event_url,
            e.location_id, l.name AS venue_name, l.web_slug AS venue_web_slug
       FROM events e LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.id = $1 AND e.company_id = $2`,
    [eventId, companyId]
  )).rows[0];
  if (!ev) { const e = new Error('Event not found'); e.code = 'not_found'; e.statusCode = 404; throw e; }

  const record = async (state, ebId, url, error, imageSourceUrl) => {
    await query(
      `INSERT INTO eventbrite_event_posts (company_id, event_id, eventbrite_event_id, url, state, error, created_by, image_source_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id, event_id) DO UPDATE
         SET eventbrite_event_id = COALESCE(EXCLUDED.eventbrite_event_id, eventbrite_event_posts.eventbrite_event_id),
             url = COALESCE(EXCLUDED.url, eventbrite_event_posts.url),
             image_source_url = COALESCE(EXCLUDED.image_source_url, eventbrite_event_posts.image_source_url),
             state = EXCLUDED.state, error = EXCLUDED.error, updated_at = NOW()`,
      [companyId, eventId, ebId || null, url || null, state, error || null, userId, imageSourceUrl || null]
    );
  };

  // An event can turn ticketed AFTER it was listed: somebody records the price,
  // or pastes the Square link in. The live listing then advertises as free an
  // event that is not, so it has to come DOWN -- merely declining to refresh it
  // would leave the wrong page up for good.
  const takeDownIfLive = async (why) => {
    if (existing?.state !== 'live' || !existing.eventbrite_event_id) return null;
    const ebId = existing.eventbrite_event_id;
    try {
      await apiFetch(companyId, `/events/${ebId}/unpublish/`, { method: 'POST', token });
      await record('unpublished', ebId, existing.url, why);
      return 'unpublished';
    } catch (e) {
      // Eventbrite refuses to unpublish once somebody has registered. That is a
      // thing a person has to decide about, so it is recorded loudly and left
      // live rather than quietly reported as handled.
      console.error('eventbrite unpublish', ebId, e.message);
      await record('live', ebId, existing.url,
        `${why} This listing is still public and could not be taken down automatically: ${e.message}`);
      return 'stuck';
    }
  };

  // Ticketed: report it rather than listing it. Returning instead of throwing
  // because this is the correct outcome, not a failure — the caller records it
  // as 'not applicable' and leaves the other channels alone.
  //
  // A checkout link counts as ticketed on its own. It outranks a $0 price rather
  // than agreeing with it: the price is the field a person forgets, the checkout
  // link is not, because without it the event could not be sold at all. Jazz
  // Night was recorded at $0 with a Square link on it, and a price check alone
  // waved a $30 event through as free.
  const cost = Number(ev.cost);
  const linkKind = classifyBookingLink(ev.booking_url || ev.resos_experience_url);
  const ticketed = (Number.isFinite(cost) && cost > 0) ? { reason: null }
    : linkKind === 'tickets' ? { reason: 'Not listed: the booking link is a ticket checkout page, so this is a '
        + 'ticketed event whatever the price field says. Check the ticket price is '
        + 'recorded. Carried by the events feed instead.' }
    : null;
  if (ticketed) {
    const takedown = await takeDownIfLive(ticketed.reason || 'This event is ticketed, so it does not belong on Eventbrite.');
    return {
      skipped: 'paid', cost: Number.isFinite(cost) ? cost : null,
      published: false, url: null, takedown,
      // No reason for the priced case: the caller already words that one from
      // the price itself, which reads better than anything repeated from here.
      ...(ticketed.reason ? { reason: ticketed.reason } : {}),
    };
  }

  // Resolve (and cache) the organization to create events under.
  let orgId = (await query(`SELECT eventbrite_org_id FROM company_integrations WHERE company_id = $1`, [companyId])).rows[0]?.eventbrite_org_id;
  if (!orgId) {
    const orgs = await listOrganizations(companyId, token);
    orgId = orgs[0]?.id;
    if (!orgId) { const e = new Error('No Eventbrite organization found for this account.'); e.statusCode = 400; throw e; }
    await query(`UPDATE company_integrations SET eventbrite_org_id = $2, updated_at = NOW() WHERE company_id = $1`, [companyId, orgId]);
  }

  // Already live: refresh it in place rather than walking away. The channel goes
  // 'stale' when the event's payload hash stops matching what was posted, and
  // announce() re-runs a stale channel -- so editing an event here is what
  // brings the listing back into line, and nothing else has to be wired up.
  if (existing?.state === 'live' && existing.eventbrite_event_id) {
    return updateLiveListing({ companyId, token, orgId, ev, existing, record });
  }

  let created;
  try {
    const venueId = await ensureVenue(companyId, orgId, ev);
    created = await apiFetch(companyId, `/organizations/${orgId}/events/`, { method: 'POST', token, body: buildEventBody(ev, venueId) });
  } catch (e) {
    await record('error', null, null, e.message);
    throw e;
  }

  const ebId = created.id;

  // The picture, before publishing. An imageless listing looks abandoned next to
  // everything around it, and it is Eventbrite's most prominent field. It is
  // deliberately not fatal: uploadEventImage swallows its own failures and
  // returns null, because a listing with no picture still beats no listing.
  // image_url is preferred over social_image_url here -- the social crop is cut
  // for Facebook's 1.91:1 and is usually the tighter of the two.
  try {
    const logoId = await uploadEventImage(companyId, token, ev.image_url || ev.social_image_url);
    if (logoId) await apiFetch(companyId, `/events/${ebId}/`, {
      method: 'POST', token, body: { event: { logo_id: logoId } },
    });
  } catch (e) { console.error('eventbrite image', ebId, e.message); }

  // The body, also before publishing -- this is where the booking link lives,
  // and the link is the whole reason a seated event can go on Eventbrite at all.
  await setListingBody(companyId, token, ebId, ev);

  const url = created.url || null;

  // A published event needs at least one ticket class. We only ever get here for
  // a free event (cost > 0 returned above), so a free class is the truth rather
  // than a convenience — the RSVP it creates is a valid registration.
  try {
    await apiFetch(companyId, `/events/${ebId}/ticket_classes/`, {
      method: 'POST', token,
      body: { ticket_class: { name: 'General Admission', free: true, quantity_total: 200 } },
    });
    await apiFetch(companyId, `/events/${ebId}/publish/`, { method: 'POST', token });
  } catch (e) {
    // Created but couldn't publish — leave it as a draft to finish by hand.
    // Eventbrite's own wording goes back to the caller: the reason is the
    // actionable part, and the commonest one ("Phone verification is required
    // to publish events") is a thing the owner can fix in a minute if anyone
    // tells them. Swallowing it into "finish & publish it" hid that for good.
    const reason = `Eventbrite created the event but would not publish it: ${e.message}`;
    await record('draft', ebId, url, reason);
    return { url, published: false, eventbrite_event_id: ebId, reason };
  }

  await record('live', ebId, url, null);
  return { url, published: true, eventbrite_event_id: ebId };
}

/**
 * Pull RSVP numbers back from Eventbrite onto the posts we created.
 *
 * This exists to answer a question we cannot otherwise answer: does Eventbrite
 * actually bring anyone to a Caldwell winery? Their "89M monthly users" is a
 * global figure and tells us nothing about the Treasure Valley. A free listing
 * is placed in the same marketplace as a paid one, so counting RSVPs on the free
 * events measures the channel at no cost and with no payment rail — and in a few
 * months the number, rather than an opinion, decides whether paid ticketing is
 * worth revisiting.
 *
 * Two requests per live event, not one for the whole organization. The tidier
 * version read ticket_availability off a single organization-wide listing, which
 * is what the field names suggest you should do — but that expansion has no
 * quantity_sold in it, so every event came back with a defaulted 0 that looked
 * exactly like a real measurement. /attendees/ reports a genuine count, and it
 * is per event. Correct and slower beats fast and fictional.
 *
 * An unreadable event is left with whatever number it already had rather than
 * being overwritten with a guess, and never throws — a missing RSVP count must
 * not break the panel it decorates.
 *
 * Returns { synced, failed, skipped, error } for the caller to log, not to show.
 */
export async function syncEventbriteRsvps(companyId, { maxAgeMinutes = 20 } = {}) {
  try {
    const live = (await query(
      `SELECT eventbrite_event_id, rsvp_synced_at
         FROM eventbrite_event_posts
        WHERE company_id = $1 AND state = 'live' AND eventbrite_event_id IS NOT NULL`,
      [companyId])).rows;
    if (!live.length) return { synced: 0, skipped: 0 };

    // Throttle on the freshest row: RSVP counts are not worth a call per panel
    // open, and Eventbrite rate-limits by token.
    const freshest = live.reduce((a, r) => (
      r.rsvp_synced_at && (!a || r.rsvp_synced_at > a) ? r.rsvp_synced_at : a), null);
    if (freshest && Date.now() - new Date(freshest).getTime() < maxAgeMinutes * 60000) {
      return { synced: 0, skipped: live.length, fresh: true };
    }

    let synced = 0, failed = 0;
    for (const row of live) {
      const ebId = String(row.eventbrite_event_id);
      try {
        // /attendees/ is the only endpoint that actually reports how many
        // people signed up. The ticket_availability expansion looks like it
        // should -- it is what the docs point you at -- but it carries prices
        // and a sold-out flag and NO quantity_sold, so reading a count from it
        // meant writing a default of 0 and calling it a measurement. A panel
        // that invents zeros is worse than one that shows nothing.
        const att = await apiFetch(companyId, `/events/${ebId}/attendees/?page_size=1`);
        const count = att?.pagination?.object_count;
        if (!Number.isFinite(count)) { failed++; continue; }

        // Capacity is on the event itself. Absent is null, not zero.
        let cap = null;
        try {
          const e = await apiFetch(companyId, `/events/${ebId}/`);
          cap = Number.isFinite(Number(e?.capacity)) ? Number(e.capacity) : null;
        } catch { /* capacity is decoration; the count is the point */ }

        await query(
          `UPDATE eventbrite_event_posts
              SET rsvp_count = $3, rsvp_capacity = $4, rsvp_synced_at = NOW(), updated_at = NOW()
            WHERE company_id = $1 AND eventbrite_event_id = $2`,
          [companyId, ebId, count, cap]);
        synced++;
      } catch (e) {
        // One unreadable event must not stop the others, and must not leave a
        // stale or invented number behind: the row simply keeps whatever it had.
        console.error('syncEventbriteRsvps', ebId, e.message);
        failed++;
      }
    }
    return { synced, failed, skipped: live.length - synced - failed };
  } catch (e) {
    console.error('syncEventbriteRsvps', e.message);
    return { synced: 0, skipped: 0, error: e.message };
  }
}
