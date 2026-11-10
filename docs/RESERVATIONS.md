# Reservations — where this stands, and the draft schema

Written 9 Nov 2026, from the live database rather than from memory.

## The short version

ResOS owns every real booking and will keep owning them. TeamHub already owns
the *front door* to those bookings, and already keeps a *live mirror* of them.
What is missing is the middle: a description of our own floor, and an engine
that could answer "is 6:30 free for four people?" without asking ResOS.

Nothing in this document replaces anything. The config layer below can be built,
used daily and trusted without a single guest-facing byte changing.

## Three layers, three very different states

### 1. The front door — built, live, ours

The public booking funnel runs through TeamHub, not through ResOS:

| Endpoint | |
|---|---|
| `GET  /api/website/reservations/availability` | `routes/website.js:1100` |
| `GET  /api/website/reservations/custom-fields` | `routes/website.js:1054` |
| `POST /api/website/reservations/book` | `routes/website.js:1184` — honeypot + rate limit |

The phone AI books through the same client (`routes/vapi.js:505`). ResOS sits
*behind* this interface via `lib/resosClient.js`; the website and Vapi call us.

**This is the single most valuable thing already done.** Swapping the engine
behind an interface you already own is the easy half of a migration. The hard
half — getting every channel to point at you — is finished.

### 2. The mirror — built, live, and not by this repo

| Table | Rows | |
|---|---|---|
| `club_steward.reservations` | 2,500 Kindred (5,000 incl. the duplicate tenant) | guest, date, time, party, status, notes, custom fields |
| `club_steward.reservation_tables` | 5,021 across both tenants | table name, area, seats min/max, booking priority |
| `club_steward.room_layouts` | 2 | `Main` 60×40ft and `Main` 40×30ft |
| `club_steward.room_layout_tables` | 13 | shape, x, y, radius, rotation, keyed to `resos_table_id` |
| `club_steward.booking_events` | 0 | audit-log shaped: action, origin, details, user. Built, never written |
| `club_steward.reservations_stage` | 0 | raw ResOS import staging |
| `public.resos_reservations` | 1,736 | older flat export, Feb 2025 – Mar 2026 |

**This mirror is current**, and it holds 26 future Kindred bookings out to
30 Jan 2027.

**ClubSteward writes it**, on a poll: `services/resosSchedulerService.js` ticks
every minute and syncs each company on its own
`club_steward.resos_settings.sync_frequency_minutes`, which for Kindred is
**5 minutes**, covering today to +90 days. Nothing in THIS repository writes it.

**Count correction.** ClubSteward is multi-tenant and holds a second tenant
named "Resos" whose rows are an exact duplicate of Kindred's — same restaurant
ids, same 1,905/595 split, 2,489 booking signatures under both. Any query that
does not filter `company_id = '8d2df498-…'` returns double. Kindred's real
totals are 2,500 bookings: **Winery 1,905, Creek 595**.

Kindred booking sources: Creek — website 375 (63%), google 176 (30%), phone 43,
walk-in 1. Winery — website 1,598 (84%), google 196 (10%), phone 107, walk-in 4.

Two data snags to settle before using it:

- `location_id` is populated on all 5,000 rows but does not join to
  `locations.id`; counts per venue come out zero.
- `restaurant_name` is NULL on all 5,000. The usable venue key today is
  `restaurant_id` (the ResOS id).

### 3. The replacement — designed, not built

Six owner-only screens — Floor Plan, Layouts, Areas & Tables, Offers, Hours &
Limits, Booking Settings — were built 27–28 Oct. Every one renders
`pages/reservationsExample.js` and makes **no API calls**. The page heading says
"Reservations Mockup" and, as of today, the nav labels say so again too.

What they do give us is a settled model, and one detail that matters more than
it looks: every offer in the example data already carries `mode: 'resos'`.
Ownership was designed to be **per offer** from the start.

## Draft schema — the config layer

Not wired into `scripts/run-migrations.js`. Nothing below runs until it is
deliberately appended there, at the END of the array (a mid-array insert lands
on an already-recorded version and is skipped forever).

These four tables describe *our floor*. None of them stores a booking, so none
of them can affect a guest.

```sql
-- An area is a physical space in a venue: Indoor Tasting, Firepit Patio.
CREATE TABLE IF NOT EXISTS reservation_areas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name            VARCHAR(80)  NOT NULL,
  -- ResOS exposes areas to the booking widget per area; mirror that so the
  -- two agree while both are running.
  bookable_online BOOLEAN      NOT NULL DEFAULT true,
  priority        INTEGER      NOT NULL DEFAULT 1,  -- lower is offered first
  internal_note   TEXT,
  archived_at     TIMESTAMPTZ,                      -- never delete a booked area
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, name)
);

-- A table is durable. Its identity survives every rearrangement, which is what
-- lets a booking taken in March still mean something in November.
CREATE TABLE IF NOT EXISTS reservation_tables (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  area_id        UUID NOT NULL REFERENCES reservation_areas(id) ON DELETE CASCADE,
  name           VARCHAR(40) NOT NULL,   -- "12", "Firepit 3"
  seats_min      SMALLINT    NOT NULL DEFAULT 1,
  seats_max      SMALLINT    NOT NULL,
  -- Geometry in the area's own coordinate space, matching what
  -- club_steward.room_layout_tables already stores for the 13 placed tables.
  shape          VARCHAR(12) NOT NULL DEFAULT 'circle'
                 CHECK (shape IN ('circle','rect')),
  x              INTEGER     NOT NULL DEFAULT 0,
  y              INTEGER     NOT NULL DEFAULT 0,
  width          INTEGER,
  height         INTEGER,
  radius         INTEGER,
  rotation       SMALLINT    NOT NULL DEFAULT 0,
  -- THE IMPORTANT COLUMN. While ResOS is authoritative this is how our table
  -- and their table are known to be the same table: it is what lets the floor
  -- plan show tonight's real bookings, and what lets a shadow engine be
  -- compared against ResOS answer for answer. Nullable, because a table we add
  -- before ResOS knows about it is still a table.
  resos_table_id VARCHAR(64),
  archived_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (area_id, name),
  CHECK (seats_max >= seats_min)
);
CREATE INDEX IF NOT EXISTS idx_res_tables_resos ON reservation_tables(resos_table_id);

-- A layout is a named arrangement of the venue: Standard, Dance Floor,
-- Harvest Long Tables.
CREATE TABLE IF NOT EXISTS reservation_layouts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id        UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name               VARCHAR(80) NOT NULL,
  is_default         BOOLEAN     NOT NULL DEFAULT false,
  standing_capacity  INTEGER     NOT NULL DEFAULT 0,  -- headcount on the floor
  open_seats         INTEGER     NOT NULL DEFAULT 0,  -- pool for 'open' tables
  changeover_minutes SMALLINT    NOT NULL DEFAULT 0,
  note               TEXT,
  archived_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, name)
);
-- At most one default per venue, enforced rather than hoped for.
CREATE UNIQUE INDEX IF NOT EXISTS idx_res_layout_one_default
  ON reservation_layouts(location_id) WHERE is_default AND archived_at IS NULL;

-- A table's role in one layout. A table with no row here is ABSENT from that
-- layout -- that is the whole representation of "we push it against the wall
-- for the band", and why this is a row per pair rather than a column on either.
CREATE TABLE IF NOT EXISTS reservation_layout_tables (
  layout_id  UUID NOT NULL REFERENCES reservation_layouts(id) ON DELETE CASCADE,
  table_id   UUID NOT NULL REFERENCES reservation_tables(id)  ON DELETE CASCADE,
  mode       VARCHAR(10) NOT NULL
             CHECK (mode IN ('seated','open','standing','held')),
  -- Per-layout geometry override: where this table sits in THIS arrangement.
  -- NULL means it stays where reservation_tables says.
  x          INTEGER,
  y          INTEGER,
  rotation   SMALLINT,
  PRIMARY KEY (layout_id, table_id)
);

-- An offer is something a guest can book: a layout, a time rule, a price.
CREATE TABLE IF NOT EXISTS reservation_offers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id   UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  layout_id     UUID REFERENCES reservation_layouts(id) ON DELETE SET NULL,
  name          VARCHAR(80) NOT NULL,
  kind          VARCHAR(20) NOT NULL DEFAULT 'service'
                CHECK (kind IN ('service','event','experience','private')),
  party_min     SMALLINT NOT NULL DEFAULT 1,
  party_max     SMALLINT NOT NULL DEFAULT 8,
  price_note    VARCHAR(120),            -- "$30 public · $20 club"
  visibility    VARCHAR(20) NOT NULL DEFAULT 'always'
                CHECK (visibility IN ('always','dated','staff_only')),
  slug          VARCHAR(120),            -- book/estate/harvest-dinner

  -- THE SAFETY SWITCH, and the reason "functional without replacing" works.
  -- 'resos'  : ResOS decides availability and holds the booking. Today: all.
  -- 'shadow' : we compute availability too, log both answers, and still send
  --            the guest to ResOS. Nobody is affected; we find out whether we
  --            agree.
  -- 'native' : we answer and we hold the booking. One offer at a time, and
  --            only after shadow has been boring for weeks.
  -- The example data already carries mode:'resos' on every offer, so the
  -- screens were designed expecting this column.
  engine        VARCHAR(10) NOT NULL DEFAULT 'resos'
                CHECK (engine IN ('resos','shadow','native')),

  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, name),
  CHECK (party_max >= party_min)
);
```

**No bookings table here, deliberately.** A table that can hold a booking is the
first thing that can disagree with ResOS about whether a seat is free. The
config layer above cannot, which is exactly why it is safe to build first.

## Can it be functional without replacing anything?

Yes — and the design already assumes it. Four stages, each useful on its own,
each stopping wherever you like.

**Stage 1 — the floor becomes real.** The four tables above get built and the
Areas & Tables, Layouts and Offers screens read and write them instead of the
example file. You describe the real venues once. No booking path is touched,
and nothing a guest can reach changes. The "· mockup" suffix comes off those
three screens.

**Stage 2 — the floor plan shows tonight.** Join `club_steward.reservations` →
`reservation_tables` on `resos_table_id` and the Floor Plan screen stops showing
invented seatings and starts showing the real service. This is the point where
it becomes a thing staff open every day, and ResOS still owns every booking.
`club_steward.booking_events` is already shaped to log what staff do here.

**Stage 3 — shadow availability.** Set an offer to `engine = 'shadow'`. On every
availability request we compute our own answer alongside the ResOS one and log
both. Guests continue to get the ResOS answer. After a few weeks you have a
report that says, in numbers, whether our engine would have sold the same seats.
That evidence is what makes the decision for you — and the 5,000-booking mirror
means some of it can be back-tested before a single live request.

**Stage 4 — one offer goes native.** Not now, and not all at once. Pick the
simplest, least busy offer, flip it to `native`, and leave everything else on
ResOS.

### The catch worth naming

**Double-booking can only happen at Stage 4, and only for the offer you flip.**
Until something other than ResOS can *accept* a guest, there is exactly one
system saying yes, so there is nothing to disagree with. That is the whole
safety argument, and it is why the bookings table is not in this draft.

The real risk in stages 1–3 is duller and more likely: **two screens showing
different truth**, and staff trusting the wrong one. Mitigations — keep the
mockup labels until a screen is genuinely live, keep ResOS the only place a
booking is created or changed, and make Stage 2's floor plan clearly a *view*.

One genuine open question for Stage 2: **who owns table assignment?** ResOS
assigns tables (`availableTables` in `resosClient.js`). If staff start seating
from our floor plan while ResOS holds its own assignment, those two drift. The
honest options are to treat ResOS as authoritative and show its assignment, or
to own assignment ourselves and accept that ResOS's copy goes stale. Worth
deciding before Stage 2, not during it.

## Open questions

1. What writes `club_steward.reservations`, and how often? Nothing in this repo
   does, and Stage 2 would depend on it.
2. `location_id` on that table does not join to `locations.id`. What is it?
3. Is `public.resos_reservations` (1,736 rows, stops Mar 2026) dead? It looks
   superseded by the `club_steward` mirror.
4. Do the 2 existing `room_layouts` and 13 placed tables get migrated into
   `reservation_areas`/`reservation_tables`, or re-drawn? 13 is small enough
   that re-drawing may be cleaner than mapping.
5. `google` is 744 of 5,000 bookings and is not covered by owning the website
   endpoints. See **Reserve with Google** below, which is now the longest
   section here for a reason.

---

# The beta plan

Measured 9 Nov 2026 from `club_steward.reservations`.

## Slice by venue, not by weekday

Bookings per open day, last 180 days:

Kindred only (the duplicate tenant excluded):

| | Mon | Tue | Wed | Thu | Fri | Sat | Sun |
|---|---|---|---|---|---|---|---|
| **Creek** | closed | 2.3 | 2.1 | **4.7** | 3.3 | 4.3 | 3.3 |
| **Winery** | 7.6 | 6.7 | 2.4 | 6.0 | 15.3 | **23.7** | 17.0 |

Creek is flat — 2 to 5 every day it opens. Its busiest day is quieter than all
but one of the Winery's days. **Creek already is the slow week**, so slicing it
further by weekday buys about five bookings and costs a rule nobody can hold in
their head.

Venue is also a *true* partition: separate ResOS restaurant, separate API key,
separate rooms. The two systems cannot disagree about a seat because they never
describe the same seat. A weekday slice only looks like a partition — it leaks
the moment a guest moves Tuesday's booking to Saturday, and it leaves staff
asking "which system is tonight?" every shift.

And the whole of Creek teaches more than a quiet Tuesday: a weekday, a Saturday,
and Thursday live music, which is Creek's *busiest* day and uses the hard case
the model was built for — the `Thursday Live Music` layout, 60 standing, inside
tables held.

## Lead times make the cutover forgiving

| | |
|---|---|
| median lead time | 0 days (same day) |
| 90th percentile | 8 days |
| 99th percentile | 34 days |
| Creek future book today | 8 bookings (26 across both venues) |

Nothing is migrated and there is no big-bang moment. Pick a date ~2 weeks out:
from that date Creek bookings are ours, everything already booked plays out in
ResOS, and within five weeks the ResOS Creek book is empty on its own.

## Exit criteria

Shadow first; it affects nobody and produces the evidence. The 595 real Creek
bookings, with their real table assignments, can be replayed through the engine
*before any live request* to check it never double-assigns a table.

The two error classes are not equally bad:

- **We say free, ResOS says full → overbooking.** Must be **zero**.
- **We say full, ResOS says free → lost revenue.** Near zero; survivable.

Ready at: three consecutive weeks of >=99% identical availability covering at
least three Thursdays and three Saturdays, zero overbooking-class errors, and
one full service worked only from the new floor plan.

# Reserve with Google

**These are real Reserve with Google bookings, not Google referrals.** Every
one has no referrer and *zero* custom fields — Google's form never asks our
questions — yet always carry email and phone. Bookings that merely arrived via
a Google search appear as `source='website'` with a referrer.

| | Google bookings | share of venue |
|---|---|---|
| Winery | 196 | 10% |
| **Creek** | **176** | **30%** |

**Nearly a third of Creek's bookings** — at the venue proposed to go first. The
share is what matters and it is unaffected by the duplicate-tenant correction;
only the absolute counts halve.

## Why it cannot simply be repointed

ResOS is Google's integration partner, not us. Google holds a feed of ResOS's
availability and posts bookings to ResOS's API. There is no setting on our side
that redirects that; the relationship is Google-to-ResOS.

So if Creek goes native and we stop treating ResOS as authoritative, Google
keeps selling Creek tables against ResOS's idea of the floor — which no longer
matches ours. That is overbooking arriving through a door we do not control,
and it is the single largest risk in this whole plan.

## The answer: invert ResOS rather than switch it off

Keep ResOS running at Creek purely as the Google adapter, and reverse which
system is upstream. Every booking we take natively is **written back into ResOS**
so ResOS's floor stays correct and Google is never offered a seat we have sold.
ResOS stops being the brain and becomes a peripheral.

This is already plumbed:

- `lib/resosClient.js` `createBooking` is in daily use — `routes/website.js:1258`
  creates ResOS bookings from our own public endpoint today.
- Write-back must not send a second confirmation. ResOS supports that: our
  `walkin` bookings carry `send_notification = false`, so the seat can be held
  without emailing the guest.
- It must create with `status: 'approved'`. This is settled knowledge, not a
  guess: a booking created without an explicit status files as `request`, which
  *shows* a table but does not *hold* it, so the next booking is offered the
  same table. That is exactly how Bock and Margaret Fair ended up on one table
  on 8 Aug, 90 minutes apart.

### What this changes about the end state

**ResOS is not switched off at the end of the Creek beta. It is demoted.**
Turning it off completely is a separate project with an external dependency, and
it should be planned as one rather than assumed to fall out of the migration.

### Two things to nail down

1. **Mirror latency is the overbooking window.** A Google booking lands in ResOS
   and we only learn of it when the mirror syncs. Whatever that interval is, it
   is how long we may sell a seat Google has already sold. Near-real-time ingest
   (ResOS webhook if available, otherwise a short poll) is required before Creek
   goes native — and nothing in this repo writes that mirror, so the owner of
   that sync needs finding first.
2. **A failed write-back must be loud.** If we take a booking and cannot push it
   to ResOS, the seat is sold in one system and free in the other. Fail the
   guest's booking or alarm immediately; never let it fail quietly.

The collision window itself is small at Creek — 4 to 10 bookings a day — but the
cost of one collision is two parties at one table on a Saturday night.

## Keeping the Google feature without ResOS

Researched against Google's own documentation on 9 Nov 2026. These programmes
change; re-check before committing. Where a claim below comes from a
third-party source rather than from Google, it says so.

Switching Google off is not on this list. It is 30% of Creek's bookings, and
losing that for the length of a beta is not a trade worth making.

### Who these guests are

64% of Google bookings are made **same-day**. Otherwise they look like our
website guests — average party 3.5 against 3.1, no-shows 2.2% against 1.8%. So
it is not a different kind of customer, it is a more impulsive moment: someone
standing in Google Maps deciding where to go now. That is the audience most
sensitive to an extra hop, which is what makes Route A cost more here than the
raw percentage suggests.

### Route A — our own link, self-serve, available today

Google Business Profile lets a business add its own reservation link when it
does not use a booking provider. Free, no partner status, no vendor, and we
control it.

What it is NOT: the in-Google booking button. The guest gets a link and leaves
Google to finish on our page. Vendor write-ups also report it is less prominent
than a partner button; that is their claim, not Google's.

This is the floor. It is always available, and it survives whatever happens
with the rest.

### Route B — become the Google partner ourselves

The real answer to "keep the feature without ResOS", and more plausible than it
first looks.

Google's stated eligibility test is: *"Partners need to have a direct
contractual relationship with all the merchants included in their integration
feed."* We would be both partner and merchant, which satisfies that on its face.

**Be honest about the gap: none of Google's pages says whether a business can
integrate for itself.** They are written throughout for third-party platforms
serving many merchants. They also never say a single business is excluded. Only
Google can answer this.

The technical bar, quoted from the E2E integration policies:

| Requirement | Google's wording |
|---|---|
| Sub-second availability | *"partners must be able to respond to availability requests from Google in less than 1 second"* |
| 30 days of availability | *"Partners must have 30 days or more of merchants' availability."* |
| Online cancellation | *"Partners must support online cancellation of bookings."* |
| Real-time confirmation | *"All bookings must be confirmed automatically in real time"* (except async integrations) |

**Every one of these is something our own engine has to do anyway.** A
reservation system that cannot answer availability in under a second, or
publish 30 days out, is not good enough for our own website either. These are
not an extra project — they are a reasonable specification for the thing we are
already building.

A third-party audit lists the booking server methods as HealthCheck,
BatchAvailabilityLookup, CreateBooking, UpdateBooking, GetBookingStatus and
ListBookings. That is not from Google's pages and should be verified.

The gate is not technical. The programme is **invitation-only**: a partner
interest form or a Google business development contact, then sandbox and
production review. Google is explicit that *"meeting the requirements does not
guarantee a partner will be eligible to integrate or go live."*

**Submit the partner interest form early — before any code is written.** It is
free, and the answer decides the end state. If Google will onboard a two-venue
winery directly, ResOS goes away entirely and the feature survives intact. If
not, we find out while there is still time to plan around it rather than at
cutover.

### Route C — a cheaper partner as the adapter

Swap ResOS for a thinner booking platform that already holds partner status,
used purely as the Google adapter. Same shape as keeping ResOS, possibly less
money, but it does not get us out from under a vendor. Worth considering only
if ResOS's cost is the actual motivation.

### Sources

- https://developers.google.com/actions-center/verticals/reservations/e2e/overview
- https://developers.google.com/actions-center/verticals/reservations/e2e/policies/integration-policies
- https://developers.google.com/actions-center/verticals/ordering/redirect/integration-steps/dining-reservation-links
- https://support.google.com/business/answer/7475773

---

# Next actions

In order, and the first two cost nothing to start.

1. **Submit Google's partner interest form.** Free, needs no code, and the
   answer decides whether ResOS ever goes away. The longest lead time of
   anything here, so it should start first.
2. ~~Find what writes `club_steward.reservations`.~~ **Answered:** ClubSteward,
   polling ResOS every 5 minutes. That 5 minutes is the overbooking window.
3. **Record the venue to ResOS-restaurant mapping.** `kindred_web.resos_config`
   has no `restaurant_id` column, which is why `location_id` does not join to
   `locations.id` and `restaurant_name` is NULL on all 5,000 mirrored rows.
   Everything downstream needs to know which venue a booking belongs to.
4. **Build the config layer** (the four tables above) and take Areas & Tables,
   Layouts and Offers off the example data. The `· mockup` suffix comes off a
   screen when that screen talks to the database.
5. **Back-test.** Replay the 595 real Creek bookings with their real table
   assignments through the engine. No live request needed, and it can happen
   before shadow mode exists.
6. **Shadow Creek**, then take Creek native on a date boundary, with ResOS
   write-back for Google. Leave the Winery alone until Creek has been boring
   for a month.
