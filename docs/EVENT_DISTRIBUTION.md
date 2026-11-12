# Event distribution — announcing one event to every channel

**Status: design only. Nothing here is built.**

Today an event is published in TeamHub, the website picks it up on the next build,
and everything else — Facebook, Google, the newspaper — is somebody remembering.
This describes making one action ("announce this event") reach every channel, and
tracking per-channel what actually happened.

The point of the design is *not* a big new subsystem. Most of the machinery already
exists; the missing piece is a per-channel status record and a dispatcher.

---

## 1. What can actually be automated

This is the part worth reading first, because the channels differ far more than they
look and it's easy to promise things that are not possible.

| Channel | API? | Reality |
|---|---|---|
| **Own website** | n/a | Already works. Astro builds from `/api/website/*`. |
| **Google Business Profile** | Yes | Business Profile API, `localPosts` with `topicType: EVENT`. Real and supported — but access is gated behind a Google application/quota approval. |
| **Eventbrite** | Yes | REST API v3, OAuth token. Create + publish + update. Free events have no fee. Straightforward. |
| **Kindred App (PWA) push** | Yes | **We already built this** — web push, service worker, notification prefs. Zero marginal cost, owned audience. |
| **Club / member email** | Yes | `promo_emails` + `promo_templates` + `mail.js` already exist. |
| **Apple Business Connect** | Partly | We already publish *hours* to Apple. Showcases/events fit the same publisher pattern. Underused by competitors. |
| **Instagram / FB page post** | Partly | A *feed post* is possible via Graph API with a Business account. Not the same thing as an Event. |
| **Facebook Events** | **No** | Meta removed event creation from the Graph API years ago. No aggregator restores it — they post to the page feed, not Events. **Native FB Events are human-only.** |
| **Bandsintown** | **No (venue-side)** | Listings originate from the *artist's* account. We can claim a venue page, but the action is asking the performer to add the date. |
| **BoiseDev** | **No — and nothing to build** | Their calendar is a **CitySpark** install. Submit redirects to `login.cityspark.com`, the site answers non-browser clients with a Cloudflare challenge, and every submission is human-approved. But CitySpark *crawls* venue sites, so we reach it by publishing a feed. See §2a. |
| **Press / tourism orgs** | No | Email or a web form. Idaho Press has a Submit News form; the rest are email. |

Two of these are load-bearing constraints, not details:

- **Facebook Events cannot be automated.** Any design that claims otherwise is wrong.
  The most we can do is prepare the copy and image and hand a human a deep link.
- **Bandsintown runs through the talent, not us.** That makes it a *relationship*
  action, which is why it belongs with the musician records and their contact details.

---

## 2. Four tiers

Everything above sorts into four handling modes. The tiering is the design.

**Tier A — automatic.** We call an API and record the result.
Website · Google Business Profile · Eventbrite · App push · Member email

**Tier B — assisted.** We can't post, so we prepare everything and ask a human for
the last click: prefilled copy, the right image, a deep link straight to the compose
screen.
Facebook Events · Instagram · Bandsintown (via the artist)

**Tier C — outreach.** An email or form submission to a contact.
Idaho Press · Idaho Wine Commission · Destination Caldwell · Sunnyslope · Visit SW Idaho

Tier B is where this earns its keep. The failure mode today isn't that posting to
Facebook is hard — it's that nobody remembers, and nobody can tell afterwards whether
it happened. A tracked task with the copy already written fixes both.

**Tier D — feed.** They read a document we publish. Nothing to do per event, ever;
the channel is registered once as a source and then carries every published event by
construction.
BoiseDev (via CitySpark)

---

## 2a. The feed tier — why BoiseDev is not a form to fill in

Investigated 2026-11-11. The obvious plan — script the "Submit your event" form —
is closed off four separate ways:

1. **`boisedev.com` sits behind a Cloudflare managed challenge.** A plain client gets
   `403` with `cf-mitigated: challenge`. Defeating bot detection is off the table, and
   a browser-driven workaround would be fighting a control that exists on purpose.
2. **The free submit path is not theirs.** "Submit your event" → a paid/free chooser →
   `login.cityspark.com`. BoiseDev's calendar is a CitySpark install.
3. **A CitySpark account is required**, and creating accounts on someone else's service
   is the owner's action, not the software's.
4. **Nothing goes live unreviewed.** CitySpark's FAQ: *"No submitted events will go live
   without prior approval."* So a `posted` status could never mean "listed", and their
   FAQ also warns that resubmitting **creates a duplicate** — which makes any retry loop
   actively harmful.

The way in is the opposite of submitting. BoiseDev does not author that calendar;
CitySpark fills it, and CitySpark's own product page says their engine *"patrols more
than 100,000 sites on the web 24/7"*, naming music venues explicitly, and that they
ingest **~20 national partner feeds including Eventbrite**.

So there are two automatic routes, and both already exist in our stack:

- **Be crawlable.** `/api/website/events.ics` and `/api/website/events/feed.jsonld`
  publish every upcoming published event in the two formats aggregators read. The same
  documents serve Google event search, Bing and Apple Calendar subscribers — one
  artefact, every channel, which no per-channel robot achieves.
- **Be on a partner feed.** Eventbrite is already a Tier A channel firing on publish.
  It was failing with *"No Eventbrite organization found for this account"*: the OAuth
  token is valid (`/users/me/` → 200) but `/users/me/organizations/` returns `[]`, so
  there is nothing to create events under. One organizer profile in Eventbrite fixes
  it, and that unblocks a CitySpark partner path for free.

**What a `feed` channel does in the UI.** Status `feed` ("In feed"), deliberately a
different colour from `Posted` — nobody posted anything, and a confirmed listing on
their site is a stronger claim than we can make. No `promo_task` is created, because a
reminder for a non-action is how people learn to ignore reminders. A feed channel can
never go `stale` either: the documents are generated from live data on each request, so
an edit propagates without anyone re-announcing.

**The one-time setup** rides on the channel row (`setup` in the catalogue, rendered as a
"One-time setup" notice): register the site and the `.ics` URL as a source with
CitySpark, and create the Eventbrite organization.

### The clock, which is the thing most likely to break

Event times are stored **wall-clock-labelled-UTC**: `18:30Z` *means* 6:30 PM in
Caldwell. It is not an instant awaiting conversion — converting it is the bug.

- **ICS** emits `DTSTART;TZID=America/Boise:20261112T183000` with a `VTIMEZONE` block,
  carrying the wall clock across untouched. No arithmetic, nothing to get wrong.
- **JSON-LD** has no `TZID` equivalent, so it needs a real offset, computed for the
  *local* time rather than for the instant the `Z` would imply: `-07:00` in winter,
  `-06:00` under daylight saving. Get this wrong and a 6:30 PM show lists at 11:30 AM —
  an error nobody reports and everybody notices.

`scripts/audit-event-feed.mjs` (58 checks) pins both, including the days either side of
the autumn transition, RFC 5545 folding on octets rather than characters, and that UIDs
are stable across reads.

### Known gaps

- `kindred_web.venue_details.lat`/`lng` are **null for both venues**. CitySpark geocodes
  from the street address, so this is not fatal, but filling them removes a guess.
- The feeds are served from `team.kindredvineyards.com`. A crawler weights a feed on the
  venue's own domain more highly; worth proxying to `kindredvineyards.com/events.ics`
  when the new site goes live.
- `jsonld` is returned by `/api/website/events/:slug` ready to embed in a
  `<script type="application/ld+json">` tag, but **nothing embeds it yet** — that is the
  website's side of the work, and Google wants the markup on the event's own page.
- Other form-based channels (SeekIdaho, Idaho Press, Boise Weekly, Destination Caldwell
  on Tockify) are unchanged. Whether any of them also crawl is untested; each one that
  does becomes a one-line tier change rather than new code.

---

## 2b. Ticketed events, and why they do not go to Eventbrite

Decided 2026-11-12. Free events go to Eventbrite as free RSVPs. **A ticketed event
is not listed there at all**, and the channel reports `not_applicable` ("Doesn't
apply") rather than posting anything.

### The reasoning, since the fee argument is weaker than it looks

Selling a $30 ticket on Eventbrite costs about **$3.77** (3.7% + $1.79 service,
plus 2.9% processing) — and *by default the buyer pays it*, not us. So this is not
really a cost decision; we would still receive $30 while the customer paid $33.77.
What actually decides it:

1. **Alcohol.** For alcohol-inclusive admission the licensee should be the one
   taking the money. Routing it through a third-party processor muddies who made
   the sale, and that is not worth any amount of reach.
2. **A second payment rail.** Square already holds the money, the payouts and the
   reconciliation. Eventbrite ticketing adds a second of each.
3. **Channel conflict.** Our own site would sell the same ticket at $30 while
   Eventbrite showed $33.77, so we look more expensive on the platform where
   people are comparing.

### The three options, and why the third wins

| | Outcome |
|---|---|
| List it paid on Eventbrite | They take the payment. Rejected, above. |
| List it as a free RSVP | States the wrong price, and fails Eventbrite's own rule that a listing must "use Eventbrite to offer valid free or paid registrations". A decoy RSVP is not a valid registration. |
| **Don't list it** | **No $0 anywhere. Discovery still happens through the feed.** |

A fourth option would have been ideal — a listing showing the real price that sends
buyers to Square. Eventbrite has an `external_ticketing` endpoint for exactly this,
and a standard account is refused:

```
GET /events/{id}/external_ticketing/
  -> 403 NOT_AUTHORIZED  "The feature that you requested is not available to you."
```

It is a gated partner feature, so that option does not exist for us.

### What a ticketed event loses, and what it does not

It loses Eventbrite's own audience for that event. It does **not** lose BoiseDev:
the Eventbrite route to CitySpark is only one of two, and our own feed is the other.
The JSON-LD feed carries the real price from `events.cost`, so a $30 show is
published as $30 to CitySpark, Google event search and anything else reading
schema.org.

One format gap worth knowing: **iCalendar has no price property.** A ticketed event
would otherwise travel through the `.ics` feed with no cost stated at all, so the
price is written into the DESCRIPTION ("Tickets $30. Book at …") — the only honest
place ICS offers.

### The guard is before the write, deliberately

`postEventToEventbrite` returns `{ skipped: 'paid' }` *before* it creates an event
or a ticket class. The bug being prevented is a $30 show listed at $0, and a guard
that ran after creation would have to delete a live listing to recover. The audit
asserts the ordering, not just the presence of the check.

`not_applicable` is terminal, like `posted`: re-attempting it on every publish would
call Eventbrite to be told the same thing and would rewrite the explanation each
time. It renders grey rather than amber, because nothing is owed — a channel that
reads as a job half-done is a channel people keep trying to finish.

---

## 2c. Measuring whether Eventbrite is worth anything here

Eventbrite's "89M monthly users" is a global figure and says nothing about whether
anyone in the Treasure Valley opens it to decide their Saturday. Rather than guess,
the panel now reports the number.

`syncEventbriteRsvps()` reads `ticket_availability.quantity_sold` back from
Eventbrite and the Eventbrite row shows **"12 RSVPs"** next to its status. One
request covers the whole organization (the expansion carries sold counts, so N
events cost one call), it is throttled to one call per 20 minutes, and it never
throws — a missing count must not break the panel it decorates.

The measurement works *because* a free listing sits in the same marketplace as a
paid one: counting RSVPs on free events measures the channel at no cost and with no
payment rail. In a few months the number decides whether paid ticketing deserves
another look.

**One honest caveat.** Eventbrite earns nothing on free events, so it is plausible
their ranking favours paid listings — in which case free-RSVP numbers understate
what paid tickets would do. There is no public evidence either way; ranking
algorithms are not published. Read a low number with that possible bias in mind
rather than as a settled verdict.

---

## 3. Reuse, don't rebuild

Most of this exists:

| Need | Already have |
|---|---|
| Human tasks with escalating SMS nags | `promo_tasks` + `lib/promoReminders.js` (1mo/3wk/2wk/1wk, escalates at 2wk) |
| Scheduled outreach email | `promo_emails`, `promo_templates`, `promo_contacts`, `lib/promoEmailSender.js` |
| Contact list | `promo_contacts` — now populated |
| Website publish | `/api/website/*` + `lib/websiteDeploy.js` debounced dispatch |
| Member push | Club 77 web-push worker + notification prefs |
| Secret storage | `company_integrations` (pattern set by Amazon + ISP creds) |

So Tier B is "create a `promo_task` with prefilled copy", and Tier C is "schedule a
`promo_email`". Neither needs new infrastructure. Only Tier A needs new code.

---

## 4. Data model

Two new tables.

```
promo_channels            -- catalogue; seeded, rarely edited
  key            text pk        -- 'google_business' | 'eventbrite' | 'facebook_event' | …
  name           text
  tier           text           -- 'auto' | 'assisted' | 'outreach'
  enabled        bool
  config         jsonb          -- account ids, page ids, default folder, etc.

event_channel_posts       -- one row per (event, channel)
  id             uuid pk
  event_id       uuid  fk -> events on delete cascade
  channel_key    text  fk -> promo_channels
  status         text           -- pending|queued|posted|failed|skipped|needs_human
  external_id    text           -- the id the channel gave back
  external_url   text           -- where it landed, for the UI
  payload_hash   text           -- what we last successfully sent
  attempts       int
  last_error     text
  posted_at      timestamptz
  unique (event_id, channel_key)
```

`payload_hash` is the important column. It gives idempotency (re-announcing an
unchanged event is a no-op) and change detection (an edited event whose hash moved
needs an *update*, not a second post). Given we already had five near-identical
August Nights rows and four fabricated WordPress ids, duplicate-on-retry is a
realistic failure here, not a hypothetical one.

---

## 5. Flow

```
event published / edited
        │
        ▼
  build payload per enabled channel  (title, blurb, start/end, venue, image, url)
        │
        ├── hash unchanged ────────────────► skip
        │
        ▼
  upsert event_channel_posts (status = queued)
        │
        ├── tier auto      → dispatcher calls the API → posted | failed(+retry)
        ├── tier assisted  → create promo_task with prefilled copy + deep link
        └── tier outreach  → schedule promo_email to the tier's contacts
```

Trigger: reuse the `websiteContentWatch` debounce (15s quiet / 90s cap). Editing an
event is half a dozen PATCHes in a row; firing per-write would post six times.

Announcing should be **explicit, not automatic on publish** — at least at first. A
draft going live shouldn't fire off an Eventbrite listing and a newspaper email
because someone was fixing a typo. An "Announce…" button showing exactly which
channels will fire, with checkboxes, is the safer shape.

---

## 6. Updates and cancellations

This matters more than it sounds. In the last week alone one event was retitled
twice, had its performer changed, and had its start time shifted by six hours — all
after it would have been announced.

- **Time/title/image change** → hash moves → update in place where the channel
  supports it (GBP, Eventbrite both do); a task for the assisted tier.
- **Cancellation** → delete/unpublish on Tier A; a task for Tier B with explicit
  "this is a cancellation" copy; a correction email for Tier C.
- **Never silently drop.** A channel that can't be updated must surface as
  `needs_human` with what changed, not fail quietly.

---

## 7. Auth

| Channel | Credential | Notes |
|---|---|---|
| Google Business Profile | OAuth2 refresh token | Needs API access approval from Google first — apply early, it isn't instant. Also needs the location id. |
| Eventbrite | Private token | Simple. Also needs the organization id. |
| Instagram / FB page | Long-lived page token | Feed posts only. Tokens expire; needs refresh handling. |

Store in `company_integrations` alongside the Amazon and ISP credentials, and read
them server-side only — the same rule as the ISP portal password: never sent to the
browser, never echoed back in a settings form.

---

## 8. UI

On the event detail, a **Distribution** card listing every channel as a row:
status pill · where it landed (link) · when · retry / mark-done.

Tier B rows show the prepared copy with a Copy button and a deep link
("Create Facebook Event ↗"). The existing Promotion card already does something
close to this — this replaces its ad-hoc links with tracked state.

A board-level view answering "what's going out this week, and what's stuck" is the
natural second screen, since that's the question a manager actually asks.

---

## 9. Suggested order

1. **Schema + dispatcher + the Distribution card, with Tier B and C only.** No
   external APIs at all. This alone fixes the real problem — nobody knowing whether
   Facebook got posted. Uses existing `promo_tasks` / `promo_emails` machinery.
2. **Eventbrite** — the easiest real API; proves the Tier A path end to end.
3. **App push + member email** — owned audience, no third-party approval, and the
   push infrastructure is already built.
4. **Google Business Profile** — highest value, longest lead time. Start the access
   application while building steps 1–3.
5. **Instagram / FB page feed posts** — only if steps 1–4 land well.

Bandsintown stays a Tier B task permanently, pointed at the talent record, since
that's genuinely how it works.

---

## 10. Open questions

- **Does Kindred have a Google Business Profile API project yet?** If not, that
  application gates step 4 and should start now regardless of when we build.
- **Eventbrite for free events** — do we want listings at all, or only when there's
  a ticket? Listing everything raises reach but creates a second place to keep
  correct.
- **Who owns the last click** for Facebook? The escalating reminder needs a named
  assignee or it escalates to nobody.
- **Sunnyslope Wine Trail may already syndicate member events.** Worth asking before
  building outreach we don't need.
- **How much copy is per-channel?** GBP truncates hard, Eventbrite wants long-form,
  Instagram is image-first. Either one blurb everywhere (simpler, worse) or a
  per-channel override field (better, more editing). Recommend one blurb plus an
  optional override.
