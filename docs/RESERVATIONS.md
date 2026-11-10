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
| `club_steward.reservations` | 5,000 | guest, date, time, party, status, notes, custom fields |
| `club_steward.reservation_tables` | 5,021 | table name, area, seats min/max, booking priority |
| `club_steward.room_layouts` | 2 | `Main` 60×40ft and `Main` 40×30ft |
| `club_steward.room_layout_tables` | 13 | shape, x, y, radius, rotation, keyed to `resos_table_id` |
| `club_steward.booking_events` | 0 | audit-log shaped: action, origin, details, user. Built, never written |
| `club_steward.reservations_stage` | 0 | raw ResOS import staging |
| `public.resos_reservations` | 1,736 | older flat export, Feb 2025 – Mar 2026 |

**This mirror is current.** Ten rows were created on 9 Nov, a steady couple of
dozen a day before that, and it holds 52 future bookings out to 30 Jan 2027.
Booking sources: website 3,946 · google 744 · phone 300 · walk-in 10.

**Nothing in this repository writes it.** No route, script or scheduler here
touches `club_steward.reservations`. Something else — presumably the Club
Steward service — syncs ResOS into it. Worth confirming what and on what
cadence before anything depends on it.

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
5. `google` is 744 of 5,000 bookings. Reserve-with-Google is a channel that
   would have to be re-pointed at Stage 4; it is not covered by owning the
   website endpoints.
