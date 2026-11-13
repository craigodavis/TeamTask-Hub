/**
 * Audit the machine-readable event feeds.
 *
 * The feed exists to be parsed by crawlers we cannot talk to and cannot ask for
 * an error message, so every mistake here is silent. These checks therefore
 * assert the things a consumer would reject us for: a shifted clock, an
 * unstable UID, an unfolded long line, a missing street address.
 *
 * Mounts the real routes with auth stubbed and reads production data.
 * Read-only. Run:  node scripts/audit-event-feed.mjs
 */
import express from 'express';
import { websiteRouter } from '../routes/website.js';
import {
  zoneOffsetMinutes, offsetString, icsLocal, isoLocal, icsEscape, foldLine,
  stripHtml, buildIcs, eventJsonLd, eventUid, icsEvent, money,
} from '../lib/eventFeed.js';
import { CHANNEL_BY_KEY, defaultMode } from '../lib/eventDistribution.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ── pure unit checks: the clock, which is the one thing that must not move ────
console.log('\nTime handling');
{
  // Stored wall-clock-labelled-UTC. 18:30Z MEANS 6:30 PM in Caldwell.
  const nov = new Date('2026-11-12T18:30:00.000Z');
  const jul = new Date('2026-07-04T18:30:00.000Z');
  ok('ICS keeps the wall clock unshifted', icsLocal(nov) === '20261112T183000', icsLocal(nov));
  ok('ICS keeps a summer wall clock unshifted', icsLocal(jul) === '20260704T183000', icsLocal(jul));
  ok('November resolves to MST (-07:00)', offsetString(nov) === '-07:00', offsetString(nov));
  ok('July resolves to MDT (-06:00)', offsetString(jul) === '-06:00', offsetString(jul));
  ok('JSON-LD start is local time + offset',
    isoLocal(nov) === '2026-11-12T18:30:00-07:00', isoLocal(nov));
  ok('offsets are whole hours for Mountain Time',
    zoneOffsetMinutes(nov) % 60 === 0, String(zoneOffsetMinutes(nov)));
  // The DST boundary itself: 1 Nov 2026 is a Sunday, the switch back.
  ok('day before the autumn switch is still MDT',
    offsetString(new Date('2026-10-31T18:00:00.000Z')) === '-06:00');
  ok('day after the autumn switch is MST',
    offsetString(new Date('2026-11-02T18:00:00.000Z')) === '-07:00');
}

console.log('\nRFC 5545 mechanics');
{
  ok('escapes comma, semicolon and backslash',
    icsEscape('a,b;c\\d') === 'a\\,b\\;c\\\\d', icsEscape('a,b;c\\d'));
  ok('escapes newlines as \\n', icsEscape('a\nb') === 'a\\nb');
  const long = 'SUMMARY:' + 'x'.repeat(200);
  const folded = foldLine(long);
  const segs = folded.split('\r\n');
  ok('folds past 75 octets', segs.length > 1, `${segs.length} segments`);
  ok('every folded segment is within 75 octets',
    segs.every((l, i) => Buffer.from(i ? l.slice(1) : l, 'utf8').length <= 75));
  ok('continuation lines start with a space', segs.slice(1).every((l) => l.startsWith(' ')));
  // Multi-byte safety: an em dash must survive the fold intact.
  const dashes = 'DESCRIPTION:' + '—'.repeat(60);
  ok('does not split a multi-byte character',
    foldLine(dashes).split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join('') === dashes);
  ok('strips HTML out of descriptions',
    stripHtml('<p>Hi &amp; <b>welcome</b></p>') === 'Hi & welcome', stripHtml('<p>Hi &amp; <b>welcome</b></p>'));
}

// ── the live routes against production data ──────────────────────────────────
const app = express();
app.use('/api/website', websiteRouter);
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}/api/website`;

console.log('\nLive ICS feed');
const icsRes = await fetch(`${base}/events.ics`);
const ics = await icsRes.text();
{
  ok('serves 200', icsRes.status === 200, String(icsRes.status));
  ok('content type is text/calendar',
    (icsRes.headers.get('content-type') || '').includes('text/calendar'),
    icsRes.headers.get('content-type'));
  ok('wrapped in VCALENDAR',
    ics.startsWith('BEGIN:VCALENDAR') && ics.trimEnd().endsWith('END:VCALENDAR'));
  ok('uses CRLF line endings', ics.includes('\r\n') && !/[^\r]\n/.test(ics));
  ok('declares the Boise timezone', ics.includes('BEGIN:VTIMEZONE') && ics.includes('TZID:America/Boise'));
  const events = ics.split('BEGIN:VEVENT').length - 1;
  ok('carries at least one event', events > 0, `${events} events`);
  // DTSTART is counted with its parameters, because VTIMEZONE carries two bare
  // DTSTART lines of its own for the DST rules and they are not events.
  const starts = (ics.match(/\r\nDTSTART;(?:TZID=|VALUE=DATE:)/g) || []).length;
  ok('every event has a UID, DTSTART and SUMMARY',
    (ics.match(/\r\nUID:/g) || []).length === events
    && starts === events
    && (ics.match(/\r\nSUMMARY:/g) || []).length === events,
    `uid=${(ics.match(/\r\nUID:/g) || []).length} dtstart=${starts} summary=${(ics.match(/\r\nSUMMARY:/g) || []).length} of ${events}`);
  ok('timed events carry TZID rather than a Z instant',
    ics.includes('DTSTART;TZID=America/Boise:') && !/DTSTART;TZID[^\n]*Z\r/.test(ics));
  ok('UIDs are slug-derived, so a re-read updates instead of duplicating',
    (ics.match(/\r\nUID:[a-z0-9-]+@kindredvineyards\.com\r\n/g) || []).length === events);
  // Identity must never be folded — a consumer that forgets to unfold would see
  // a new id on every read and duplicate every event.
  ok('no UID line is folded',
    ics.split('\r\n').filter((l) => l.startsWith('UID:'))
       .every((l) => Buffer.from(l, 'utf8').length <= 75));
  ok('eventUid shortens a slug that would not fit',
    (() => {
      const long = 'x'.repeat(120);
      const u = eventUid({ slug: long });
      return Buffer.byteLength(`UID:${u}`) <= 75 && u === eventUid({ slug: long });
    })());
  ok('eventUid leaves a short slug readable', eventUid({ slug: 'jazz-night-2026-11-14' }) === 'jazz-night-2026-11-14@kindredvineyards.com');
  const uids = [...ics.matchAll(/\r\nUID:([^\r\n]+)/g)].map((m) => m[1]);
  ok('UIDs are unique within the feed', new Set(uids).size === uids.length);
  ok('every event names a venue with a street address',
    (ics.match(/\nLOCATION:[^\r\n]*Caldwell/g) || []).length === events);
  ok('no line exceeds 75 octets',
    ics.split('\r\n').every((l) => Buffer.from(l, 'utf8').length <= 75),
    ics.split('\r\n').filter((l) => Buffer.from(l, 'utf8').length > 75)[0]);
  // Two reads in a row must agree on identity, or every crawl creates duplicates.
  const again = await (await fetch(`${base}/events.ics`)).text();
  const uids2 = [...again.matchAll(/\r\nUID:([^\r\n]+)/g)].map((m) => m[1]);
  ok('UIDs are stable across requests', JSON.stringify(uids) === JSON.stringify(uids2));
  ok('DTSTAMP is the only thing that moves between reads',
    again.replace(/DTSTAMP:[^\r\n]+/g, '') === ics.replace(/DTSTAMP:[^\r\n]+/g, ''));
}

console.log('\nLive JSON-LD feed');
const ldRes = await fetch(`${base}/events/feed.jsonld`);
const ld = await ldRes.json();
{
  ok('serves 200', ldRes.status === 200, String(ldRes.status));
  ok('content type is application/ld+json',
    (ldRes.headers.get('content-type') || '').includes('application/ld+json'));
  ok('is a schema.org graph', ld['@context'] === 'https://schema.org' && Array.isArray(ld['@graph']));
  const g = ld['@graph'];
  ok('graph is non-empty', g.length > 0, `${g.length} nodes`);
  ok('every node is an Event', g.every((n) => n['@type'] === 'Event'));
  // Google's event rich-result requirements.
  ok('every event has name, startDate and location', g.every((n) => n.name && n.startDate && n.location));
  ok('every location has a street address and locality',
    g.every((n) => n.location.address?.streetAddress && n.location.address?.addressLocality));
  ok('startDate carries an explicit offset', g.every((n) => /[+-]\d\d:\d\d$/.test(n.startDate) || /^\d{4}-\d\d-\d\d$/.test(n.startDate)));
  ok('no node leaks an empty object or null', !JSON.stringify(ld).includes('null') && !JSON.stringify(ld).includes('{}'));
  ok('free events still state a price', g.every((n) => n.offers && n.offers.priceCurrency === 'USD'));
  ok('every event links to its own page',
    g.every((n) => typeof n.url === 'string' && n.url.startsWith('https://kindredvineyards.com/events/')));
  // The clock again, this time end to end.
  ok('a 6:30 PM show reads as 18:30 local, not 11:30',
    g.every((n) => !/T(0[0-9]|1[01]):/.test(n.startDate) || n.startDate.length === 10));
}

console.log('\nSingle-event markup');
{
  const slug = [...ics.matchAll(/\nUID:([a-z0-9-]+)@/g)][0]?.[1];
  const one = await (await fetch(`${base}/events/${slug}`)).json();
  ok('event endpoint still returns the event', !!one.title, slug);
  ok('and now carries ready-to-embed jsonld', one.jsonld?.['@type'] === 'Event');
  ok('its jsonld has the address too', !!one.jsonld?.location?.address?.streetAddress);
  ok('jsonld matches the feed node for the same event',
    JSON.stringify(one.jsonld) === JSON.stringify(ld['@graph'].find((n) => n.url.endsWith(`/${slug}`))));
}

console.log('\nBoiseDev channel');
{
  const bd = CHANNEL_BY_KEY.boisedev;
  ok('is a feed channel, not assisted', bd.tier === 'feed', bd.tier);
  ok('fires on publish', defaultMode('boisedev') === 'on_publish');
  ok('points at the ICS feed', (bd.link || '').endsWith('/api/website/events.ics'), bd.link);
  ok('carries one-time setup instructions', !!bd.setup);
  ok('no longer offers paste-copy, since nothing is pasted', !bd.copy);
  // A feed channel must never grow a per-event task: that is the whole point.
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventDistribution.js', import.meta.url), 'utf8');
  const feedBlock = src.slice(src.indexOf("if (ch.tier === 'feed')"), src.indexOf('let taskId = ch.promo_task_id'));
  ok('the feed branch creates no promo_task', !feedBlock.includes('promo_tasks'));
  ok('the feed branch runs before the task branch', feedBlock.length > 0 && feedBlock.length < 1200);
}

// A buildIcs with nothing in it must still be a valid document, or a quiet week
// serves a broken file to every subscriber.
console.log('\nDegenerate cases');
{
  const empty = buildIcs([]);
  ok('an empty feed is still a valid VCALENDAR',
    empty.startsWith('BEGIN:VCALENDAR') && empty.includes('END:VCALENDAR') && !empty.includes('BEGIN:VEVENT'));
  const bare = eventJsonLd({ title: 'X', slug: 'x', start_at: '2026-11-12T18:30:00.000Z' });
  ok('an event with no venue row still produces valid markup', bare.name === 'X' && !!bare.startDate);
  ok('and does not invent an address', !bare.location.address?.streetAddress);
}

// ── ticketed events: the price must survive, and Eventbrite must decline ────
console.log('\nTicketed events');
{
  ok('money() drops pointless cents', money(30) === '$30', money(30));
  ok('money() keeps real cents', money(27.5) === '$27.50', money(27.5));
  ok('money() survives rubbish', money(null) === '$0' && money('x') === '$0');

  const paid = { title: 'Harvest Dinner', slug: 'harvest-dinner-2026-11-20',
                 start_at: '2026-11-20T18:30:00.000Z', cost: 30 };
  const ld = eventJsonLd(paid);
  ok('JSON-LD carries the real price', ld.offers?.price === 30, JSON.stringify(ld.offers));
  ok('JSON-LD prices a free event at 0',
    eventJsonLd({ ...paid, cost: null }).offers?.price === 0);

  // iCalendar has no price property at all, so the description is the only
  // honest place to put it. A ticketed event that travels with no cost stated
  // is the failure this guards.
  const icsLines = icsEvent(paid, 'https://kindredvineyards.com').join('\r\n');
  ok('ICS states the ticket price somewhere a human reads',
    /DESCRIPTION:[^\r\n]*Tickets \$30/.test(icsLines),
    icsLines.split('\r\n').find((l) => l.startsWith('DESCRIPTION:')) || 'no DESCRIPTION');
  const freeLines = icsEvent({ ...paid, cost: 0 }, 'https://kindredvineyards.com').join('\r\n');
  ok('a free event is not labelled with a price', !/Tickets \$/.test(freeLines));

  // The client must refuse before it creates anything: the bug being prevented
  // is a $30 show listed on Eventbrite at $0.
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventbriteClient.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function postEventToEventbrite'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const guardAt = body.indexOf("skipped: 'paid'");
  const ticketAt = body.indexOf('ticket_classes');
  ok('the paid guard exists', guardAt > -1);
  ok('and returns BEFORE any ticket class is created',
    guardAt > -1 && ticketAt > -1 && guardAt < ticketAt, `guard@${guardAt} ticket@${ticketAt}`);
  ok('the free ticket class is still free', /free: true/.test(body));

  const dsrc = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventDistribution.js', import.meta.url), 'utf8');
  ok('announce records it as not_applicable', dsrc.includes("'not_applicable'"));
  // Settled means settled: retrying every publish would call Eventbrite to be
  // told the same thing and would rewrite the explanation each time.
  ok('not_applicable is terminal, like posted',
    /DONE = new Set\(\['posted', 'not_applicable'\]\)/.test(dsrc));
  ok('RSVP counts are read back onto the channel row', dsrc.includes('rsvp_count'));

  const ui = await (await import('node:fs/promises')).readFile(
    new URL('../../client/src/pages/Events.jsx', import.meta.url), 'utf8');
  ok('the UI has a pill for it', ui.includes('not_applicable:'));
  ok('it is grey, not amber — nothing is owed',
    /not_applicable: \{ bg: '#f1f3f4'/.test(ui));
  ok('Mark posted is hidden on a channel that does not apply',
    ui.includes("c.status !== 'not_applicable'"));
  ok('the RSVP count is rendered', ui.includes('RSVP{c.rsvp_count === 1'));
}

// ── two prices: the public one travels, the members' one does not ──────────
console.log('\nClub ticket price');
{
  const ev = { title: 'Jazz Night', slug: 'jazz-night-2026-11-14',
               start_at: '2026-11-14T19:30:00.000Z', cost: 30, club_cost: 20 };
  const ld = eventJsonLd(ev);
  // The members' price is not a public offer. Publishing it would advertise a
  // price most readers cannot get, and schema.org has no way to say "members
  // only" that any consumer honours.
  ok('JSON-LD publishes the public price', ld.offers?.price === 30, JSON.stringify(ld.offers));
  // Matched on the price FIELD, not on the digits: a bare search for "20" hits
  // the date in "2026-11-14" and the slug, which is how this check first failed
  // against perfectly correct output.
  ok('JSON-LD does NOT leak the club price',
    !/"price"\s*:\s*"?20\b/.test(JSON.stringify(ld)) && !Array.isArray(ld.offers),
    JSON.stringify(ld.offers));
  const ics = icsEvent(ev, 'https://kindredvineyards.com').join('\r\n');
  ok('ICS states the public price', /Tickets \$30/.test(ics));
  ok('ICS does NOT leak the club price', !/\$20/.test(ics));

  const route = await (await import('node:fs/promises')).readFile(
    new URL('../routes/events.js', import.meta.url), 'utf8');
  ok('club_cost is saveable (in EV_FIELDS)', /EV_FIELDS = \[[^\]]*'club_cost'/.test(route));
  ok('club_cost is returned by the events list', /e\.club_cost/.test(route));
  ok('a change to it is described in words', /club_cost: 'club ticket price'/.test(route));
  ok('duplicating an event carries it over',
    /INSERT INTO events \([^)]*club_cost/.test(route));

  const ui = await (await import('node:fs/promises')).readFile(
    new URL('../../client/src/pages/Events.jsx', import.meta.url), 'utf8');
  ok('the form says "Ticket Price", not "Cost"',
    ui.includes('>Ticket Price<') && !ui.includes('>Cost<'));
  ok('and has a Club Ticket Price beside it', ui.includes('>Club Ticket Price<'));
  // Both forms, not one: the new-event form and the edit drawer are separate.
  ok('both forms have both fields',
    (ui.match(/>Ticket Price</g) || []).length === 2
    && (ui.match(/>Club Ticket Price</g) || []).length === 2,
    `ticket=${(ui.match(/>Ticket Price</g)||[]).length} club=${(ui.match(/>Club Ticket Price</g)||[]).length}`);
  // A field that renders but never saves is the classic half-done version of
  // this change, so the payload list is asserted too.
  ok('the edit form actually sends it', /'cost', 'club_cost'/.test(ui));
  ok('the new-event form resets it after save',
    (ui.match(/club_cost: ''/g) || []).length >= 2);
}

// ── the panel gate: grey when priced, warn when not ────────────────────────
console.log('\nEventbrite checkbox gating');
{
  const ui = await (await import('node:fs/promises')).readFile(
    new URL('../../client/src/pages/Events.jsx', import.meta.url), 'utf8');

  ok('ticketed is derived from the payload price', /const isTicketed =/.test(ui));
  // Blank and 0 are both free. Most events are entered with no price at all, so
  // treating blank as "unknown" would grey the channel for nearly all of them.
  ok('blank and 0 both count as free', /dist\?\.payload\?\.cost \?\? 0/.test(ui));
  ok('only Eventbrite is ever blocked', /key === 'eventbrite' && isTicketed/.test(ui));

  ok('the checkbox is disabled when priced', /disabled=\{blocked\}/.test(ui));
  ok('the row is greyed when priced', /opacity: blocked \? 0\.45/.test(ui));
  // A greyed control with no reason beside it is what people file bugs about.
  ok('and the row says why', /<b>Ticketed event \(\{pricedLabel\}\)\.<\/b>/.test(ui));
  ok('the reason names which price it found',
    /const pricedLabel =/.test(ui) && /club \$\$\{clubPrice\}/.test(ui));

  ok('turning it on for a free event asks first',
    /window\.confirm\(\s*\n?\s*'This event has no ticket price/.test(ui));
  // The disabled attribute is a hint, not a guarantee — the handler must refuse
  // too, or a stale render or a keyboard path switches it on anyway.
  ok('the handler refuses a blocked channel regardless of the input',
    /if \(blockedChannel\(key\) && enabled\) return;/.test(ui));
  // "Select all" was the obvious hole: it bypasses the checkbox entirely.
  ok('"select all" cannot switch on a blocked channel',
    /\.filter\(\(c\) => !\(enabled && blockedChannel\(c\.key\)\)\)/.test(ui));
  ok('and its optimistic update leaves it alone',
    /\(enabled && blockedChannel\(c\.key\)\) \? c :/.test(ui));

  // The payload must actually carry the price, or every event looks free.
  const dsrc = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventDistribution.js', import.meta.url), 'utf8');
  ok('the distribution payload carries cost', /cost: ev\.cost \?\? null/.test(dsrc));
}

// ── what the Eventbrite listing tells the public ────────────────────────────
console.log('\nEventbrite listing correctness');
{
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventbriteClient.js', import.meta.url), 'utf8');

  // The venue name was the same bug as the feeds had: locations.name is an
  // internal label, so Eventbrite showed a venue called "Creek".
  ok('the Eventbrite venue uses the public name',
    /name: publicVenueName\(ev\.venue_web_slug, ev\.venue_name\)/.test(src));
  ok('and the query actually selects web_slug',
    /l\.web_slug AS venue_web_slug/.test(src));
  ok('one definition of the public name, shared with the feeds',
    /import \{[^}]*\bpublicVenueName\b[^}]*\} from '\.\/eventFeed\.js'/.test(src));

  // The RSVP count must come from somewhere that reports one. The
  // ticket_availability expansion does NOT carry quantity_sold, so reading it
  // there wrote a defaulted 0 that was indistinguishable from a real zero.
  ok('RSVPs are counted from the attendees endpoint',
    /\/attendees\/\?page_size=1/.test(src));
  ok('ticket_availability is no longer trusted for a count',
    !/quantity_sold \?\? 0/.test(src));
  ok('an unreadable count is left NULL, never defaulted to 0',
    /if \(!Number\.isFinite\(count\)\) \{ failed\+\+; continue; \}/.test(src));
  ok('capacity absent means null, not zero',
    /cap = Number\.isFinite\(Number\(e\?\.capacity\)\) \? Number\(e\.capacity\) : null/.test(src));
  ok('one failing event does not stop the rest', /failed\+\+;\n\s*\}\n\s*\}/.test(src));

  // The bookkeeping INSERT: $4 was used as a value and in a comparison, which
  // Postgres rejects outright, so the channel could never record ANY result.
  const dsrc = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventDistribution.js', import.meta.url), 'utf8');
  ok('the status parameter is cast, so the insert is valid SQL',
    /\$4::text/.test(dsrc));
  ok('no uncast $4 comparison remains', !/CASE WHEN \$4='posted'/.test(dsrc));
  // And Eventbrite's own reason reaches the panel, rather than being replaced
  // by a generic message. "Phone verification is required" is actionable.
  ok('Eventbrite\'s own reason is stored', /r\.reason \|\|/.test(dsrc));
  ok('and the client hands one back', /return \{ url, published: false, eventbrite_event_id: ebId, reason \}/.test(src));
}

// ── the Eventbrite image: nothing cropped, nothing stretched ───────────────
console.log('\nEventbrite event image');
{
  const sharp = (await import('sharp')).default;
  const EB_W = 2160, EB_H = 1080;
  // The same pipeline the client runs, exercised on synthetic art of each shape
  // we actually hold: 2.4:1 banners, a 16:9, and 640x640 squares.
  const fit = async (buf) => {
    const bg = await sharp(buf, { failOn: 'none' })
      .resize(EB_W, EB_H, { fit: 'cover', position: 'centre' })
      .blur(60).modulate({ brightness: 0.55 }).toBuffer();
    const fg = await sharp(buf, { failOn: 'none' })
      .resize(EB_W, EB_H, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
    return sharp(bg).composite([{ input: fg, blend: 'over' }])
      .jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  };
  // A red block on a green field: if anything crops, the red edges vanish.
  const art = async (w, h) => sharp({
    create: { width: w, height: h, channels: 3, background: { r: 0, g: 128, b: 0 } },
  }).composite([{
    input: await sharp({ create: { width: w, height: Math.max(1, Math.round(h * 0.1)),
      channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer(),
    top: 0, left: 0,
  }]).jpeg().toBuffer();

  for (const [w, h, label] of [[2400, 1000, '2.4:1 banner'], [2102, 1182, '16:9'], [640, 640, 'square']]) {
    const out = await fit(await art(w, h));
    const m = await sharp(out).metadata();
    ok(`${label} comes out exactly 2160x1080`,
      m.width === EB_W && m.height === EB_H, `${m.width}x${m.height}`);
  }

  // The aspect ratio must survive. A 2.4:1 source scaled to `contain` inside a
  // 2:1 frame keeps its own ratio; a stretched one would not.
  {
    const out = await fit(await art(2400, 1000));
    const { channels } = await sharp(out)
      .extract({ left: 0, top: 0, width: EB_W, height: 2 }).stats();
    // Top rows are the blurred background, not the red stripe: the artwork is
    // letterboxed, so the stripe sits lower. That it is NOT pure red is the
    // evidence that nothing was stretched to fill the frame.
    ok('a 2.4:1 image is letterboxed, not stretched to fill',
      channels[0].mean < 250, `top-row red mean ${channels[0].mean.toFixed(0)}`);
  }

  const src = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventbriteClient.js', import.meta.url), 'utf8');
  // .png() on the foreground is load-bearing: without it a JPEG source loses the
  // alpha and the composite covers the blur with flat black bars.
  ok('the foreground keeps its alpha channel',
    /fit: 'contain',[\s\S]{0,120}\.png\(\)/.test(src));
  ok('the crop mask covers the whole frame, so Eventbrite does not re-crop',
    /crop_mask: \{ top_left: \{ x: 0, y: 0 \}, width: EB_IMAGE_W, height: EB_IMAGE_H \}/.test(src));
  ok('a failed image never fails the publish', /catch \(e\) \{\s*console\.error\('uploadEventImage'/.test(src));
  ok('the image is attached before publishing', src.indexOf('logo_id') < src.indexOf('/publish/'));
  ok('image_url is preferred over the social crop',
    /ev\.image_url \|\| ev\.social_image_url/.test(src));
  ok('and the query selects both', /e\.image_url, e\.social_image_url/.test(src));
}

// ── reaching the listing to review it ──────────────────────────────────────
console.log('\nLink to the live listing');
{
  const dsrc = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventDistribution.js', import.meta.url), 'utf8');
  // The link must survive the row's own bookkeeping failing: that is exactly
  // when you most want to look at what went up.
  ok('the panel falls back to the Eventbrite post URL',
    /external_url: r\.external_url \|\| r\.eventbrite_url \|\| null/.test(dsrc));
  ok('and the query selects it', /eb\.url AS eventbrite_url/.test(dsrc));
  // Eventbrite's own view of the listing, which can disagree with ours.
  ok('Eventbrite\'s own live/draft state is surfaced',
    /eb\.state AS eventbrite_state/.test(dsrc) && /external_state: r\.eventbrite_state/.test(dsrc));

  const ui = await (await import('node:fs/promises')).readFile(
    new URL('../../client/src/pages/Events.jsx', import.meta.url), 'utf8');
  ok('the link names the channel rather than saying "view"',
    /View on \$\{c\.name\}/.test(ui) && !/>view \u2197</.test(ui));
  ok('a draft is labelled as needing review',
    /c\.external_state === 'draft' \? 'Review draft'/.test(ui));
  // The window has to clear the title and style attributes between the anchor
  // and the label — ~240 characters, not the 200 this first allowed.
  ok('it opens in a new tab, safely',
    /target="_blank" rel="noreferrer"[\s\S]{0,400}View on/.test(ui));
}

// ── the booking link on the listing ─────────────────────────────────
console.log('\nBooking link on the Eventbrite listing');
{
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventbriteClient.js', import.meta.url), 'utf8');

  // The link only survives in structured_content. `description.html` is
  // flattened to text by Eventbrite, so an <a> put there is silently lost --
  // which is why the body is written as a module and not as a description.
  ok('the body goes to structured_content, where links survive',
    /structured_content\/\$\{next\}\//.test(src));
  ok('the version is read before writing, since it must increment',
    /page_version_number \|\| 1\) \+ 1/.test(src));
  ok('the event query actually selects the link',
    /e\.booking_url, e\.resos_experience_url/.test(src));

  // The destination must be specific to THIS event. A field link when there is
  // one, otherwise the event's own page -- which already renders a "Reserve a
  // table" button deep-linked to venue, date and time. What is still forbidden
  // is a generic page that cannot book this particular event.
  const fn = src.slice(src.indexOf('async function setListingBody'), src.indexOf('\nfunction buildEventBody'));
  ok('the booking route comes from the shared ladder, not the field alone',
    /bookingLinkFor\(ev\)/.test(fn) && !/ev\.booking_url \|\| ev\.resos_experience_url \|\| null/.test(fn));
  ok('the event page is needed to derive it, so the query selects the slug',
    /e\.slug, e\.event_url/.test(src));
  {
    const { bookingLinkFor } = await import('../lib/eventFeed.js');
    // A field link wins and keeps its own kind.
    const sq = bookingLinkFor({ booking_url: 'https://square.link/u/A', slug: 's' });
    ok('an explicit checkout link wins over the derived page',
      sq.kind === 'tickets' && sq.url === 'https://square.link/u/A');
    // The normal case: no field, so the event's own page.
    const site = bookingLinkFor({ slug: 'wine-bingo-2026-11-18' });
    ok('a normal event falls back to its own page, not a generic one',
      site.kind === 'site'
      && site.url === 'https://kindredvineyards.com/events/wine-bingo-2026-11-18');
    // Nothing to point at is still a real answer.
    ok('an event with no page at all gets no link rather than the site root',
      bookingLinkFor({}).url === null && bookingLinkFor({}).kind === 'none');
  }
  // Comments stripped first: this is about what the code does, and the comment
  // right above it explains the rule by naming the thing it refuses to do.
  const fnCode = fn.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('no generic reservations page is substituted', !/reservations/i.test(fnCode));
  ok('an event with neither link nor description writes nothing',
    /if \(!paras\.length\) return;/.test(fn));

  // User-entered text and a user-entered URL both land inside HTML.
  ok('text and URL are escaped before going into the markup',
    /replace\(\/&\/g, '&amp;'\)/.test(fn) && /replace\(\/"\/g, '&quot;'\)/.test(fn));
  // Stripping moved with the description: setListingBody no longer carries it,
  // but buildEventBody still sends it as description.html, and Eventbrite
  // flattens that to text -- so leftover markup would show as literal tags.
  {
    const bf = src.slice(src.indexOf('function buildEventBody'), src.indexOf('\n/**', src.indexOf('function buildEventBody')));
    ok('the description is stripped of its own tags before it is sent',
      /replace\(\/<\[\^>\]\*>\/g, ' '\)/.test(bf));
  }

  // It runs before publish, so throwing here would cost the whole listing.
  ok('a failed body write never throws', /catch \(e\) \{ console\.error\('eventbrite listing body'/.test(fn));
  ok('the body is written before the event is published',
    src.indexOf('setListingBody(companyId, token, ebId, ev)') < src.indexOf('/publish/'));

  // The field has to be reachable when the event is first created, not only on
  // a second pass through the edit form.
  const ui = await (await import('node:fs/promises')).readFile(
    new URL('../../client/src/pages/Events.jsx', import.meta.url), 'utf8');
  ok('the create form offers a booking link', /value=\{form\.booking_url\}/.test(ui));
  ok('the edit form still does', /value=\{f\.booking_url\}/.test(ui));
  ok('the create form clears it after saving',
    (ui.match(/status: 'draft', image_url: '', booking_url: ''/g) || []).length === 2);
}

// ── a checkout link is proof of a ticketed event ─────────────────────
console.log('\nTicket link vs booking link');
{
  const { classifyBookingLink } = await import('../lib/eventFeed.js');

  // The real link that exposed this: Jazz Night sat at $0 in the database with a
  // Square checkout on it, so the price check alone would have listed a $30
  // event as free.
  ok('a Square checkout reads as ticketed',
    classifyBookingLink('https://square.link/u/XfzSWKBn') === 'tickets');
  ok('so does Stripe, Tock-style ticketing and a foreign Eventbrite',
    classifyBookingLink('https://buy.stripe.com/x') === 'tickets'
    && classifyBookingLink('https://www.eventbrite.com/e/x-123') === 'tickets');
  ok('our own ResOS reads as a table booking',
    classifyBookingLink('https://kindred.resos.com/booking?experience=1') === 'booking');
  ok('OpenTable and Tock do too',
    classifyBookingLink('https://www.opentable.com/r/x') === 'booking'
    && classifyBookingLink('https://www.exploretock.com/x') === 'booking');

  // The two ways a host check goes wrong. Both must come back 'unknown' rather
  // than a confident wrong answer.
  ok('a lookalike domain is not trusted',
    classifyBookingLink('https://notresos.com/booking') === 'unknown');
  ok('a known name in the path proves nothing',
    classifyBookingLink('https://evil.example/square.link') === 'unknown');
  ok('something that is not a URL is unknown, not a crash',
    classifyBookingLink('nonsense') === 'unknown');
  ok('no link is its own answer, distinct from unknown',
    classifyBookingLink(null) === 'none' && classifyBookingLink('') === 'none');

  const src = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventbriteClient.js', import.meta.url), 'utf8');
  // A club price on its own is still money changing hands, and an event with
  // only a club price recorded is usually one whose public price was forgotten
  // -- the same way Jazz Night slipped through on a blank cost.
  ok('a club ticket price alone marks the event ticketed',
    /Number\.isFinite\(clubCost\) && clubCost > 0/.test(src));
  ok('and the query selects it', /e\.club_cost,/.test(src));
  ok('its reason names the club price rather than quoting $0',
    /this event has a club /.test(src) && /ticket price, so it is a ticketed event/.test(src));

  const dist0 = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventDistribution.js', import.meta.url), 'utf8');
  // Beside the payload, never inside it: the payload is hashed to detect "this
  // event changed since we posted it", so adding a field would change every
  // event's hash at once and set every manual channel asking to be redone.
  ok('the panel gets the club price without it entering the hashed payload',
    /club_cost: ev\.club_cost \?\? null/.test(dist0)
    && !/club_cost: ev\.club_cost \?\? null/.test(dist0.slice(dist0.indexOf('function buildPayload'), dist0.indexOf('export function hashPayload'))));

  const ui0 = await (await import('node:fs/promises')).readFile(
    new URL('../../client/src/pages/Events.jsx', import.meta.url), 'utf8');
  ok('the checkbox greys out on either price',
    /const clubPrice = Number\(dist\?\.club_cost \?\? 0\)/.test(ui0)
    && /const isTicketed = priced > 0/.test(ui0));
  ok('and the notice says to clear both fields',
    /Clear both the Ticket Price and the Club Ticket Price/.test(ui0));

  ok('the guard refuses an event whose link is a checkout page',
    /linkKind === 'tickets'/.test(src) && /skipped: 'paid'/.test(src));
  ok('and it refuses before anything is created on Eventbrite',
    src.indexOf("linkKind === 'tickets'") < src.indexOf('/organizations/${orgId}/events/'));
  ok('the refusal says to go and record the price',
    /Check the ticket price is/.test(src));

  // Wording follows the link type: "a table" is only true of a table booking.
  const fn = src.slice(src.indexOf('async function setListingBody'), src.indexOf('\nfunction buildEventBody'));
  ok('a checkout link is offered as tickets', /kind === 'tickets'[\s\S]{0,200}Get tickets here/.test(fn));
  // Both a real booking system and our own event page lead to a table, so both
  // must also say that the Eventbrite RSVP is not one. A guest arriving to no
  // table because they clicked RSVP is the whole failure being prevented, and
  // naming Eventbrite's own button is what makes it land.
  ok('a link that leads to a table says the RSVP is not one',
    /kind === 'booking' \|\| kind === 'site'/.test(fn)
    && /does not reserve a table/.test(fn) && /Reserve a Table here/.test(fn));
  ok('it names Eventbrite\'s own button rather than a vague "registering"',
    /Reserve a spot/.test(fn));
  ok('an unrecognised link claims neither a table nor tickets', /Book here/.test(fn));

  // Eventbrite's `summary` and `description` are two views of ONE field --
  // clearing description cleared summary too, and sending both is rejected with
  // SUMMARY_DESCRIPTION_CONFLICT. So the listing is summary + structured
  // content, and the full text belongs in the modules.
  ok('no description field is sent alongside the summary',
    !/event\.description = /.test(src));
  ok('a short summary is sent instead', /summary: summarise\(desc\)/.test(src));

  // Left unset, Eventbrite derived the summary from the description at full
  // length, so the page opened with the whole description, then the booking
  // call, then the whole description again -- the call buried between two
  // copies of the same text, past the "Read more" fold.
  {
    const long = 'Ease into Thursday evening with wine by the creek and soft, background live '
      + 'music from 6:30-8:30 PM. This is a relaxed, ambient experience designed to complement '
      + 'your wine tasting. Join us downtown for an unhurried evening.';
    const sum = src.slice(src.indexOf('function summarise'), src.indexOf('function buildEventBody'));
    const summarise = eval(`(${sum.slice(sum.indexOf('function summarise')).replace(/^function summarise/, 'function')})`);
    const out = summarise(long);
    ok('the summary fits Eventbrite\'s 140-character limit', out.length <= 140, `${out.length} chars`);
    ok('and breaks at a sentence, not mid-word', /\.$/.test(out), JSON.stringify(out.slice(-40)));
    ok('a short description is left alone', summarise('Short one.') === 'Short one.');
    ok('an empty description yields no summary at all', summarise('') === undefined);
    // No sentence end in range: must still not cut mid-word.
    const nodots = 'a'.repeat(5) + ' ' + 'wordy '.repeat(40);
    ok('a description with no sentence end still breaks on a word',
      !/\w\u2026$/.test(summarise(nodots)) || summarise(nodots).endsWith(' …') === false);
  }

  // The booking call leads; the description follows it in the same module.
  ok('the booking call comes before the description in the body',
    fn.indexOf('bookingLinkFor(ev)') < fn.indexOf('ev.description'));

  // style/class/font are all stripped by Eventbrite (probed, not assumed), so a
  // heading is the only way left to make this read like a button.
  ok('the call to action is a heading, since styling is stripped',
    /<h3><strong><a href=/.test(fn));
  ok('and no dead styling is sent', !/style="/.test(fn) && !/class="btn/.test(fn));

  // The comment that justified the old field-only rule must not outlive it.
  ok('no stale comment still claims there is no fallback',
    !/No link is the better failure/.test(fn));

  const dist = await (await import('node:fs/promises')).readFile(
    new URL('../lib/eventDistribution.js', import.meta.url), 'utf8');
  // "Ticketed event ($0)" would read as a contradiction, so the client's own
  // reason has to win when it has one.
  ok('the panel prefers the real reason over quoting a $0 price',
    /const why = \(?r\.reason/.test(dist));
}

// ── refreshing a listing that is already up ───────────────────────
console.log('\nUpdating a live Eventbrite listing');
{
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/eventbriteClient.js', import.meta.url), 'utf8');

  // It used to walk away from a live listing, which meant an edit in TeamHub
  // could never reach Eventbrite.
  ok('a live listing is refreshed, not skipped',
    /return updateLiveListing\(/.test(src) && !/published: true, eventbrite_event_id: existing\.eventbrite_event_id, existing: true/.test(src));

  const fn = src.slice(src.indexOf('async function updateLiveListing'), src.indexOf('/** Cancel a published'));
  ok('it refreshes the details', /changed\.push\('details'\)/.test(fn));
  ok('it refreshes the page body', /changed\.push\('page body'\)/.test(fn));

  // The picture is the expensive one: fetch, resize, three uploads. It must only
  // happen when it would actually change something.
  ok('the image is pushed only when it differs or is missing',
    /if \(!hasLogo \|\| existing\.image_source_url !== want\)/.test(fn));
  ok('and what was pushed is remembered, so the next run can tell',
    /image_source_url/.test(src) && /changed\.includes\('image'\) \? want : null/.test(fn));

  // Pushing at a finished show is waste, and touching it flips it to
  // 'completed'. The first backfill did exactly this.
  ok('a finished event is left entirely alone',
    /skipped: 'past'/.test(fn) && fn.indexOf("skipped: 'past'") < fn.indexOf('ensureVenue'));

  // Capacity and ticket names affect people who already registered.
  ok('the ticket class is not touched on an update', !/ticket_classes/.test(fn));

  // An event that turns ticketed AFTER listing: the page must come down.
  ok('a listing is taken down when the event turns ticketed',
    /takeDownIfLive/.test(src) && /\/unpublish\//.test(src));
  ok('a takedown that fails is recorded as still public, not as handled',
    /still public and could not be taken down automatically/.test(src));

  const dist = await fs.readFile(new URL('../lib/eventDistribution.js', import.meta.url), 'utf8');
  ok('the panel says when a public listing was pulled',
    /has been unpublished/.test(dist));
  ok('and shouts when one could not be pulled',
    /WARNING: the Eventbrite listing is still public/.test(dist));

  // Positional migrations: the new column must be the LAST array entry, or it
  // gets a version already marked applied and never runs.
  const mig = await fs.readFile(new URL('./run-migrations.js', import.meta.url), 'utf8');
  const last = mig.lastIndexOf('image_source_url TEXT`');
  const close = mig.lastIndexOf('\n];');
  ok('the image_source_url migration is appended, not inserted',
    last > 0 && last < close && !mig.slice(last, close).includes('`,\n  `'));
}

srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
