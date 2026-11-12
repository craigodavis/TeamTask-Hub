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

srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
