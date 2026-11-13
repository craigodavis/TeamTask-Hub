/**
 * Machine-readable event feeds — ICS and schema.org JSON-LD.
 *
 * WHY THIS EXISTS
 *
 * The local listing channels (BoiseDev, SeekIdaho, Idaho Press, Boise Weekly)
 * have no write API. BoiseDev's calendar is a CitySpark install: its submit
 * link redirects to login.cityspark.com, the whole site sits behind a
 * Cloudflare managed challenge, and every submission is human-approved. There
 * is nothing there to POST to, and defeating the challenge is not on the table.
 *
 * But CitySpark does not author that calendar — it fills it. Their own product
 * page says the engine "patrols more than 100,000 sites on the web 24/7",
 * naming music venues explicitly, and that they ingest ~20 national partners
 * including Eventbrite. So the way into those calendars is to BE a source: a
 * feed a crawler can read, rather than a form a person fills in.
 *
 * The same two documents serve Google event search, Bing, Apple Calendar
 * subscribers and anything else that reads the open formats. One artefact,
 * every channel — which is why this is worth more than a per-channel robot.
 *
 * THE ONE RULE THAT MATTERS HERE
 *
 * Event times are stored as wall-clock-labelled-UTC: 18:30Z MEANS 6:30 PM in
 * Caldwell. It is not an instant that needs converting — converting it is the
 * bug. So:
 *   - ICS emits DTSTART;TZID=America/Boise:20261112T183000 with a VTIMEZONE,
 *     carrying the wall clock across untouched and letting the client resolve
 *     it. No arithmetic, nothing to get wrong.
 *   - JSON-LD has no TZID equivalent, so it needs a real offset. That offset is
 *     computed for the LOCAL time (see zoneOffset), not for the instant the
 *     label would be if you believed the Z.
 *
 * STABLE IDENTITY
 *
 * CitySpark's FAQ warns that resubmitting an event creates a duplicate. UIDs
 * are therefore derived from the slug and never from a timestamp or a random
 * value: a re-read of this feed updates the event it already has instead of
 * adding a second one. The same reasoning puts LAST-MODIFIED on every VEVENT —
 * it is how a consumer knows an edit happened.
 *
 * See docs/EVENT_DISTRIBUTION.md.
 */

import crypto from 'node:crypto';

export const FEED_TZ = 'America/Boise';
const DOMAIN = 'kindredvineyards.com';

/**
 * The offset America/Boise was running at a given LOCAL wall clock.
 *
 * Not the same question as "what offset applies at this instant". We hold the
 * Y-M-D H:M fields and need the instant whose Boise local time shows those
 * fields; the offset falls out of the difference. Two iterations converge
 * because the correction is itself at most an hour, which can only change the
 * answer inside a DST transition — and the second pass resolves that.
 *
 * Mountain Time, so -07:00 in winter and -06:00 under daylight saving. Getting
 * this wrong puts a 6:30 PM show on a listing at 11:30 AM, which is the kind of
 * error nobody reports and everybody notices.
 */
export function zoneOffsetMinutes(labelled, tz = FEED_TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const target = labelled.getTime();
  let instant = target;
  for (let i = 0; i < 2; i++) {
    const p = {};
    for (const part of fmt.formatToParts(new Date(instant))) p[part.type] = part.value;
    // hour can come back as "24" for midnight in this locale; normalise it.
    const localAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    instant = target - (localAsUtc - instant);
  }
  return Math.round((target - instant) / 60000);
}

/** "-07:00" for the offset at this local wall clock. */
export function offsetString(labelled, tz = FEED_TZ) {
  const m = zoneOffsetMinutes(labelled, tz);
  const sign = m <= 0 ? '-' : '+';
  const abs = Math.abs(m);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const d2 = (n) => String(n).padStart(2, '0');

/** The stored wall clock, as ICS local date-time. Never shifted. */
export function icsLocal(v) {
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getUTCFullYear()}${d2(d.getUTCMonth() + 1)}${d2(d.getUTCDate())}`
       + `T${d2(d.getUTCHours())}${d2(d.getUTCMinutes())}${d2(d.getUTCSeconds())}`;
}

export function icsDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getUTCFullYear()}${d2(d.getUTCMonth() + 1)}${d2(d.getUTCDate())}`;
}

/** A real UTC stamp, for DTSTAMP/LAST-MODIFIED, which are genuinely instants. */
export function icsStamp(v = new Date()) {
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getUTCFullYear()}${d2(d.getUTCMonth() + 1)}${d2(d.getUTCDate())}`
       + `T${d2(d.getUTCHours())}${d2(d.getUTCMinutes())}${d2(d.getUTCSeconds())}Z`;
}

/** The stored wall clock as ISO with Boise's offset for that local time. */
export function isoLocal(v) {
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getUTCFullYear()}-${d2(d.getUTCMonth() + 1)}-${d2(d.getUTCDate())}`
       + `T${d2(d.getUTCHours())}:${d2(d.getUTCMinutes())}:${d2(d.getUTCSeconds())}`
       + offsetString(d);
}

/** RFC 5545 §3.3.11: backslash, semicolon, comma, newline. */
export function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * RFC 5545 §3.1: no line over 75 octets. Folded on octets, not characters —
 * an event title with a — or an é is multi-byte, and splitting mid-sequence
 * produces a file some parsers reject outright.
 */
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let i = 0, limit = 75;
  while (i < bytes.length) {
    let take = Math.min(limit, bytes.length - i);
    // Do not split a UTF-8 continuation byte away from its leader.
    while (take > 1 && (bytes[i + take] & 0xc0) === 0x80) take--;
    out.push(bytes.slice(i, i + take).toString('utf8'));
    i += take;
    limit = 74; // continuation lines carry a leading space
  }
  return out.join('\r\n ');
}

export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * America/Boise as a VTIMEZONE. Mountain Time under the post-2007 US rules
 * (second Sunday in March, first Sunday in November), which have not changed
 * since and apply to every date this feed can carry.
 */
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:America/Boise',
  'X-LIC-LOCATION:America/Boise',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0700',
  'TZOFFSETTO:-0600',
  'TZNAME:MDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0600',
  'TZOFFSETTO:-0700',
  'TZNAME:MST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/**
 * A stable UID that is guaranteed never to be folded.
 *
 * Folding a UID is legal — RFC 5545 says unfold before parsing, and every
 * mainstream parser does. But the UID is pure identity, and the one failure
 * CitySpark explicitly warns about is duplicate listings. A consumer that
 * forgets to unfold sees a different id on every read and files a new event
 * each time, which is the worst outcome available to us. The cost of ruling it
 * out is this function, so we rule it out.
 *
 * `UID:` + slug + `@kindredvineyards.com` must fit in 75 octets. Our slugs
 * ("thursdays-at-the-creek-rochelle-and-the-james-gang-2026-11-19") routinely
 * do not, so a long one is truncated and given a hash of the FULL slug — still
 * deterministic, still unique, and still legible enough to recognise.
 */
export function eventUid(ev) {
  const slug = String(ev.slug || ev.id || 'event');
  const suffix = `@${DOMAIN}`;
  const budget = 75 - 'UID:'.length - Buffer.byteLength(suffix, 'utf8');
  if (Buffer.byteLength(slug, 'utf8') <= budget) return slug + suffix;
  const h = crypto.createHash('sha256').update(slug).digest('hex').slice(0, 10);
  return `${slug.slice(0, budget - h.length - 1)}-${h}${suffix}`;
}

/** The public page for an event, which is what a listing should link to. */
export function eventUrl(ev, origin = `https://${DOMAIN}`) {
  if (ev.event_url) return ev.event_url;
  return ev.slug ? `${origin}/events/${ev.slug}` : origin;
}

/**
 * The name the public knows a venue by.
 *
 * `locations.name` is an internal label — "Creek", "Winery", "Winerage" — and a
 * listing that says "Creek, 616 Main Street" is both wrong and unsearchable.
 * Geocoders and humans both look for "Kindred by the Creek". Keyed on web_slug
 * rather than the name so renaming the internal label cannot change what the
 * outside world is told.
 */
export function publicVenueName(webSlug, fallback = 'Kindred Vineyards') {
  if (webSlug === 'creek') return 'Kindred by the Creek';
  if (webSlug === 'estate') return 'Kindred Vineyards';
  return fallback || 'Kindred Vineyards';
}

/**
 * Phone numbers are stored bare ("2085042131"). schema.org wants something
 * dialable, and a consumer that renders it as a tel: link needs the country
 * code or the call fails from outside the US.
 */
function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return phone || undefined;
}

/**
 * Where people actually book this event, and what kind of place that is.
 *
 * Every event has a booking route, but only the exceptional ones carry it in a
 * field. `booking_url` is for the case that cannot be derived -- Jazz Night
 * sells through Square -- and it is empty on a normal event. The normal route is
 * the event's own page on the website, which already renders a "Reserve a table"
 * button deep-linked to the venue, date and time.
 *
 * So an empty booking_url does NOT mean there is nowhere to book. Treating it
 * that way is what left the Eventbrite listings with no booking route at all.
 *
 * Linking to the event page rather than rebuilding that deep link is deliberate.
 * The query-string format belongs to the website; reconstructing it here would
 * duplicate someone else's URL scheme and break quietly the day it changes. One
 * extra click buys immunity from that.
 *
 * Returns { url, kind } where kind is 'tickets' | 'booking' | 'site' |
 * 'unknown' | 'none'. 'site' is our own event page -- known-good, but a page to
 * book FROM rather than a booking system itself.
 */
export function bookingLinkFor(ev, origin = `https://${DOMAIN}`) {
  const explicit = ev.booking_url || ev.resos_experience_url || null;
  if (explicit) return { url: explicit, kind: classifyBookingLink(explicit) };
  // No slug and no explicit page means the only honest answer is the site root,
  // which is not a booking route for THIS event. Say there is none instead.
  if (!ev.slug && !ev.event_url) return { url: null, kind: 'none' };
  return { url: eventUrl(ev, origin), kind: 'site' };
}

/** Whole dollars read as "$30", not "$30.00"; cents are kept when they exist. */
/**
 * What kind of link `booking_url` holds: a ticket purchase, a table reservation,
 * or something unrecognised.
 *
 * This earns its keep twice.
 *
 * It is independent evidence that an event is ticketed. The price field is the
 * one a person forgets: Jazz Night sat in the database at $0 with a Square
 * checkout link on it, so a $30 event would have gone onto Eventbrite as free.
 * A checkout link cannot be forgotten in the same way, because somebody had to
 * paste it in for the event to be sellable at all.
 *
 * And it decides the wording. Offering "a table" for a checkout page is wrong,
 * and so is "get tickets" for a ResOS booking.
 *
 * 'unknown' is deliberately a third answer rather than a default to either. The
 * field accepts anything on purpose, so guessing strictly would silently drop
 * events and guessing loosely would mislabel them. Only hosts we recognise get
 * a verdict; the rest get neutral treatment.
 */
const TICKET_HOSTS = [
  'square.link', 'squareup.com', 'square.site',
  'eventbrite.com', 'eventbrite.co.uk',
  'ticketleap.com', 'tickettailor.com', 'brownpapertickets.com',
  'universe.com', 'seetickets.us', 'etix.com', 'ticketspice.com',
  'buy.stripe.com', 'checkout.stripe.com', 'paypal.me', 'paypal.com',
];
const BOOKING_HOSTS = [
  'resos.com', 'opentable.com', 'exploretock.com', 'tock.com',
  'sevenrooms.com', 'resy.com', 'tableagent.com',
];

/** 'none' | 'tickets' | 'booking' | 'unknown' */
export function classifyBookingLink(url) {
  if (!url) return 'none';
  let host;
  try {
    host = new URL(String(url).trim()).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown'; // not even a URL; certainly not something to reason from
  }
  // endsWith('.' + h) so a subdomain counts (kindred.resos.com) but a lookalike
  // registered as notresos.com does not.
  const on = (list) => list.some((h) => host === h || host.endsWith('.' + h));
  if (on(TICKET_HOSTS)) return 'tickets';
  if (on(BOOKING_HOSTS)) return 'booking';
  return 'unknown';
}

export function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0';
  return '$' + (Number.isInteger(v) ? String(v) : v.toFixed(2));
}

/** FMTTYPE must match the actual bytes; most of our event art is PNG. */
function imageType(url) {
  const ext = String(url || '').toLowerCase().split('?')[0].split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'avif') return 'image/avif';
  return 'image/jpeg';
}

function venueOf(ev) {
  // venue_details is the only place an address lives; a venue without one still
  // produces a valid listing, just a less useful one.
  const name = publicVenueName(ev.venue, ev.venue_name);
  const parts = [ev.street, ev.city, ev.region && ev.postal ? `${ev.region} ${ev.postal}` : (ev.region || ev.postal)]
    .filter(Boolean);
  return { name, street: ev.street || null, city: ev.city || null, region: ev.region || null,
    postal: ev.postal || null, country: ev.country || 'US', phone: ev.phone || null,
    lat: ev.lat ?? null, lng: ev.lng ?? null,
    oneLine: parts.length ? `${name}, ${parts.join(', ')}` : name };
}

function performerOf(ev) {
  return ev.musician_stage_name || ev.musician_name || null;
}

/** One VEVENT. Returns an array of unfolded lines. */
export function icsEvent(ev, origin) {
  const v = venueOf(ev);
  const url = eventUrl(ev, origin);
  const perf = performerOf(ev);
  const desc = [stripHtml(ev.description), perf ? `Performing: ${perf}` : '', url]
    .filter(Boolean).join('\n\n');

  const lines = [
    'BEGIN:VEVENT',
    // Slug-derived, so a re-read updates rather than duplicates.
    `UID:${eventUid(ev)}`,
    `DTSTAMP:${icsStamp()}`,
  ];

  if (ev.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(ev.start_at)}`);
    // DTEND is exclusive for all-day events: a one-day event ends the next day.
    const end = new Date(ev.end_at || ev.start_at);
    end.setUTCDate(end.getUTCDate() + 1);
    lines.push(`DTEND;VALUE=DATE:${icsDate(end)}`);
  } else {
    lines.push(`DTSTART;TZID=${FEED_TZ}:${icsLocal(ev.start_at)}`);
    if (ev.end_at) lines.push(`DTEND;TZID=${FEED_TZ}:${icsLocal(ev.end_at)}`);
  }

  lines.push(`SUMMARY:${icsEscape(ev.title)}`);
  // iCalendar has no price property, so an unqualified ticketed event travels
  // with no cost stated at all. The JSON-LD feed carries a real `offers` node;
  // for ICS the only honest place is the description a human will read.
  const priced = Number(ev.cost);
  const descWithPrice = Number.isFinite(priced) && priced > 0
    ? `${desc ? desc + '\n\n' : ''}Tickets ${money(priced)}. Book at ${url}`
    : desc;
  if (descWithPrice) lines.push(`DESCRIPTION:${icsEscape(descWithPrice)}`);
  lines.push(`LOCATION:${icsEscape(v.oneLine)}`);
  if (v.lat != null && v.lng != null) lines.push(`GEO:${v.lat};${v.lng}`);
  lines.push(`URL:${url}`);
  if (ev.category) lines.push(`CATEGORIES:${icsEscape(ev.category)}`);
  // Aggregators that read ICS routinely pick the image up from here.
  const img = ev.social_image_url || ev.image_url;
  if (img) lines.push(`ATTACH;FMTTYPE=${imageType(img)}:${img}`);
  lines.push('STATUS:CONFIRMED');
  lines.push('TRANSP:OPAQUE');
  if (ev.updated_at) lines.push(`LAST-MODIFIED:${icsStamp(ev.updated_at)}`);
  lines.push('END:VEVENT');
  return lines;
}

/** A complete VCALENDAR. CRLF throughout — RFC 5545 requires it. */
export function buildIcs(events, { origin = `https://${DOMAIN}`, name = 'Kindred Vineyards Events' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kindred Vineyards//TeamHub Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`,
    `X-WR-CALDESC:${icsEscape('Live music, tastings and events at Kindred Vineyards and Kindred by the Creek, Caldwell, Idaho.')}`,
    `X-WR-TIMEZONE:${FEED_TZ}`,
    // Crawlers re-read on their own schedule; this is the hint for the polite ones.
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    ...VTIMEZONE,
  ];
  for (const ev of events) lines.push(...icsEvent(ev, origin));
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * schema.org/Event for one event. Shaped to satisfy Google's event rich-results
 * requirements (name, startDate, location with a postal address) while staying
 * useful to any other consumer.
 */
export function eventJsonLd(ev, origin = `https://${DOMAIN}`) {
  const v = venueOf(ev);
  const perf = performerOf(ev);
  const url = eventUrl(ev, origin);
  const images = [ev.image_url, ev.social_image_url, ev.fb_image_url].filter(Boolean);

  const node = {
    '@type': 'Event',
    '@id': url,
    name: ev.title,
    startDate: ev.all_day ? isoLocal(ev.start_at).slice(0, 10) : isoLocal(ev.start_at),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url,
    location: {
      '@type': 'Place',
      name: v.name,
      address: {
        '@type': 'PostalAddress',
        streetAddress: v.street || undefined,
        addressLocality: v.city || undefined,
        addressRegion: v.region || undefined,
        postalCode: v.postal || undefined,
        addressCountry: v.country || undefined,
      },
      telephone: e164(v.phone),
      geo: (v.lat != null && v.lng != null)
        ? { '@type': 'GeoCoordinates', latitude: v.lat, longitude: v.lng } : undefined,
    },
    organizer: { '@type': 'Organization', name: 'Kindred Vineyards', url: `https://${DOMAIN}` },
  };

  if (ev.end_at) node.endDate = ev.all_day ? isoLocal(ev.end_at).slice(0, 10) : isoLocal(ev.end_at);
  const desc = stripHtml(ev.description);
  if (desc) node.description = desc.slice(0, 1200);
  if (images.length) node.image = images;
  if (ev.category) node.keywords = ev.category;
  if (perf) node.performer = { '@type': 'PerformingGroup', name: perf };

  // A free event says so explicitly — "no offers" reads as "unknown", and an
  // unpriced listing is ranked below a priced one by some consumers.
  const price = ev.cost == null ? 0 : Number(ev.cost);
  node.offers = {
    '@type': 'Offer',
    price: Number.isFinite(price) ? price : 0,
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
    url: bookingLinkFor(ev, origin).url || url,
    validFrom: undefined,
  };

  return prune(node);
}

/** Drop undefined/null/empty leaves — JSON-LD consumers dislike empty keys. */
function prune(o) {
  if (Array.isArray(o)) return o.map(prune).filter((x) => x !== undefined);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(o)) {
      const p = prune(val);
      if (p === undefined || p === null || p === '') continue;
      if (typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0) continue;
      out[k] = p;
    }
    return out;
  }
  return o;
}

/** The whole set as one @graph, for embedding on a listing page. */
export function buildJsonLdGraph(events, { origin = `https://${DOMAIN}` } = {}) {
  return {
    '@context': 'https://schema.org',
    '@graph': events.map((ev) => eventJsonLd(ev, origin)),
  };
}
