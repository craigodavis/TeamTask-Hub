# Splitting TeamHub into apps

Status: **design only.** Nothing here is built. Decisions marked OPEN are yours.

## The problem, stated precisely

TeamHub is one sidebar over 74 routes, 39 grantable capabilities and 4 derived
containers, serving twenty-two people.

Of those twenty-two: **15 members, 3 managers, 2 owners, 2 inventory.** Eighteen
of them hold capability grants — 213 in all.

That distribution is the whole argument. Fifteen of twenty-two people need five
screens. They are currently handed a sidebar built for the two people who need
all of them, and asked to find themselves in it.

The second problem is subtler and is the one that will keep biting: **the
sidebar is organised by what the data is, rather than by what the job is.**

- `Kitchen ▸ Receipts` and `Betty Bookkeeper` are the same job — making the
  books right — in two different places, one nested and one top-level.
- `Events` and `Private Events` sit side by side under Marketing and are
  different jobs: one is programming the calendar, the other is selling the
  room.
- `Media Library` sits under Marketing but exists to serve the website.
- `Ground Control` is irrigation for the vineyard and sits at top level between
  Gateway and Scheduled Reports.

And the structure has already started lying. The path and the menu disagree:
`marketing.events` lives at `/events`, `kitchen.receipts` lives at
`/quickbooks`. Because of that, `AppShell.jsx` carries six hand-maintained
functions — `isKitchenPath`, `isMarketingPath`, `isWinePath`, `isWebsitePath`,
`isTastingRoomPath`, `isReservationsPath` — whose only job is to re-derive, from
a list of path prefixes, the grouping the URL should have expressed in the first
place. Every new screen has to be remembered in two places.

So: yes, this is several apps in one.

## What makes something an app

A chart is only maintainable if there is a test for it, otherwise the next
screen gets filed wherever it feels nice. Two tests, and a thing is an app when
it passes both:

**1. Would someone say they are "doing" it for a whole shift?** "I'm on the
floor tonight." "I'm doing the books this morning." "I'm in the kitchen." Those
are apps. Nobody has ever said "I'm doing media library this afternoon."

**2. Is it the unit you hand a new hire?** You give someone the Kitchen. You do
not give someone Ingredients but not Recipes. If you would only ever grant the
whole thing, it is an app; if you would grant a piece, the piece is a screen.

Irrigation fails both tests — it is one screen, done in two minutes, by someone
who is already doing something else. So it does not get an app, it gets a home
inside one. The same test is what keeps the agent platform out of the top row
for now, and says exactly when it should be promoted (below).

## The chart

Six apps, plus Admin, which is a gear rather than an app.

```
Team ─────────── everyone's default. 15 of 22 people never leave it.
  My Tasks
  My Schedule
  Announcements
  Policies
  The Crew
  My Profile                    name, photo, bio — what the website shows
  Receipts                      snap one, say what it was for, see my own

Floor ────────── the tasting room, during service
  Bookings                      today's reservations
  Floor Plan
  Areas & Tables
  Layouts
  Offers
  Hours & Limits
  Menus
  Private Events                inquiry → contract → deposit → the day  (OPEN)

Kitchen ──────── food cost, from delivery to plate to bin
  Shopping Lists
  Inventory                     counts, and par levels
  Recipes
  Ingredients
  Item Catalog
  Waste
  Budget                        this period's kitchen spend against its budget

Cellar ───────── the wine, from vine to compliance
  Vineyard                      irrigation zones, schedules, devices
  Harvest                       picks, ferment bins, barrels
  Product Lines
  Products
  Wine Inventory
  Wine Reports
  ABC Filing                    monthly state report

Marketing ────── filling the room
  Events                        the calendar, and where it gets published
  Talent                        performers, terms, their submissions
  Campaigns                     email
  Loyalty
  Kindred App                   members, push notifications

Website ──────── what the public sees, and how it gets there
  Pages & Images
  Media Library
  Testimonials
  Home Popup
  Store Hours
  Settings
  Publish                       build status, what is live vs staged

⚙ Admin ──────── two people. Set apart, not in the top row.
  Users & Permissions
  Integrations                  Square, QBO, Commerce7, Twilio, mail
  Company Settings
  Reports                       scheduled, and operational
  Books                         all receipts · rules · QBO export · sources · Betty
  Departments & Budgets
  Automation                    Gateway · Skynet · Square explorer
```

### Why these six and not your four

You said Marketing, Operations, Kitchen, Website. I kept three of those and
split your Operations, because it was carrying two jobs done by different people
with different vocabularies: the person running the room tonight, and the person
making the wine. A hostess and a winemaker should not share a sidebar just
because neither of them is marketing.

I also added **Team**, which is not an app in the sense the other five are — it
is the floor under them. It matters because it is the only app fifteen people
will ever open, and because without it they land in somebody else's app with
most of it greyed out.

### Where the awkward ones went, and why

**Ground Control → Cellar ▸ Vineyard.** It is irrigation. It belongs with the
grapes, not between Gateway and Reports. This is the change that makes Cellar
coherent: grow it, make it, bottle it, report it to the state.

**Betty, Gateway, Skynet, the Square explorer → Admin ▸ Automation.** These are
four tools for running the agents, used by two people. By the two tests above
they are not yet an app. **Promote Automation to its own app when a third person
needs it, or when it gains a screen someone opens daily** — Gateway's approval
queue is the likely trigger, since approving agent actions is a recurring job
and recurring jobs become apps.

**Receipts → split between Team and Admin.** This is the one place the chart
puts a single name in two apps, and it is deliberate: capture and processing
are different jobs done by different people at different frequencies. See
*Receipts, departments and budgets* below, which is also where the 27
owner-only routes behind today's Receipts screen get dealt with.

**Scheduling splits.** "My shifts" is Team. The manager's scheduling tool spans
kitchen and floor, so it cannot live in either — it goes in Team as a screen
that shows more when you hold `scheduling.manage`. This is the one place I would
accept a screen that changes shape by capability rather than appearing and
disappearing, because the shift grid is genuinely the same object.

**Events → Marketing. Floor gets a read-only "tonight".** Programming the
calendar is marketing work; knowing that a duo starts at six is service work.
One owns it, the other needs a view. Duplicating the whole screen into Floor
would be the familiar mistake.

**Media Library → Website, linked from Marketing.** It is website plumbing.
Marketing reaches it through the picker it already uses, which is how marketing
touches it in practice anyway.

**Private Events → Floor. (OPEN, and the one I most expect you to overrule.)**
The contract, the deposit and the day-of are the same manager's work, and that
manager lives in Floor. But the inquiry arrives like a marketing lead. If you
tell me the inquiries are worked by whoever does campaigns, it moves.

## Switching between apps

**The switcher sits top-left**, where the Kindred mark is now, and always names
the app you are in. Clicking it drops a list of the apps you hold, each with one
line of description. That is the whole interaction — twenty-two users do not
need a command palette for seven destinations.

**One app means no switcher.** Fifteen people see a plain header that says
Team, and nothing they cannot use. This is the single most valuable consequence
of the split and it costs nothing.

**The URL carries the app.** `/floor/bookings`, `/kitchen/inventory`,
`/marketing/events`. Today the path and the nav disagree and `AppShell` carries
six functions to paper over it; making the path the truth deletes all six. It
also means a pasted link tells you which app it is in before you click it.

Old paths redirect. `/events` → `/marketing/events`, `/quickbooks` →
`/kitchen/receipts`, and so on. Nobody's bookmark breaks.

**A deep link into an app you hold switches you into it.** Clicking a link to a
booking from a Slack message should land you in Floor ▸ Bookings with the Floor
sidebar, not in whatever app you had open.

**A deep link into an app you don't hold shows a page that says so**, naming the
app and who can grant it. Today every such route does `<Navigate to="/" />`,
which is indistinguishable from a broken link — you click, you end up on the
dashboard, and you have no idea whether the thing exists.

**The app you were last in is remembered**, in `users.preferences`, which already
exists. First login goes to Team for anyone who holds it, and otherwise to the
first app they hold in the order above.

**Search spans every app you hold**, with each result labelled by its app. Not
needed for the first version, but it is the thing that stops a split from
hurting: the cost of putting a wall between Kitchen and Cellar is that someone
looking for "Syrah" has to know which side it is on. Search is how you refuse to
make them know.

## Access: who gets which app

The important decision here is what an app *is*, in the data.

**The app is the unit of conversation. The capability stays the unit of truth.**

You will talk about this in apps — "give Elaine Marketing and Website". The
server will keep checking capabilities, one per route, exactly as it does now.
Apps are **derived** from the capabilities someone holds, the same way
`visibleContainers()` already derives Kitchen and Wine today.

`visibleApps(grants)` replaces `visibleContainers(grants)`. That is close to the
entire server-side change.

**Do not add an `app` grant that gates routes.** `docs/PERMISSIONS.md` already
makes this argument for containers and it is the same argument here: a checkbox
on a container can only create the failure mode where a granted child is
invisible. An app-level gate would do worse — it would let someone hold
`kitchen.inventory` and still be refused at the door, with the two checks
disagreeing and no obvious place to look. Derivation cannot drift, because there
is nothing to drift from.

### What changes in the permissions UI

The matrix gains a row per app, above its capabilities, in three states:

| | |
|---|---|
| **All** | they hold every capability in this app |
| **Some** | they hold a subset — the app still appears for them |
| **None** | the app is not in their switcher |

Clicking **All** stamps every capability in that app onto the person; clicking
**None** removes them. **Some** is never something you click, only something you
see — it is the state that tells you this person has been tuned by hand, which
is what you want to notice.

The existing **Customized** badge keeps working unchanged and gets more useful,
because it can now be read per app: *Marketing (customized)* says something that
*customized* alone does not.

### Presets become app bundles

| Preset | Apps |
|---|---|
| `member` | Team |
| `kitchen` | Team + Kitchen |
| `inventory` | Team + Kitchen (counts only) + Cellar (counts only) |
| `marketing` | Team + Marketing + Website |
| `manager` | Team + Floor + Kitchen + Cellar |
| `admin` | everything except Admin ▸ Users and Integrations |
| `owner` | everything |

This is readable in a way the current preset list is not — `manager` today is
`ALL_CAPABILITIES` minus two owner-only keys, which is a definition by
subtraction and tells you nothing about what a manager does.

Note that `inventory` — the preset that exists because two real people needed
something no role expressed — becomes sayable: *they count things in two places
and do nothing else.* That is a good test of the model.

### What does not change

Every route keeps its `requireCapability`. No guard is relaxed, none is
tightened, and the reorganisation stays a navigation change rather than a
security change. That is the point of deriving: it is not possible for this work
to become a permissions change by accident.

`location_capability` already exists in the schema. If an app should ever be
held for one location and not another, the hook is there — but nothing here
needs it, and it should stay unused until something does.

## The permissions as they actually stand

You asked whether what is set up is what we need. **The grants are right. The
enforcement is not.** Somebody scoped these people thoughtfully and the server
is quietly ignoring most of it.

Measured against the live database — 22 people, 18 of them holding 213 grants —
by running the real `requireCapability` middleware with each person's actual
role and actual grants, for every capability they were deliberately **not**
given:

| Person | Role | Holds | Withheld | **Passes anyway** |
|---|---|---|---|---|
| Elaine Ganino | manager | 19 | 20 | **18** |
| Jack Morehart | manager | 23 | 16 | **14** |
| Elizabeth Roberts | member | 0 | 39 | 4 |
| Tristan Rodriguez | inventory | 7 | 32 | 0 |

Elaine was narrowed out of Kitchen, Wine, Betty, Gateway, Ground Control, task
management and user admin. She reaches **all of them** through the API. The
only two things genuinely closed to her are the two owner-only keys. Jack is
the same story minus Marketing.

### Why

`requireCapability` has a migration fallback: if you do not hold the grant,
your old `role` is consulted, and if a legacy manager could have done it, you
go through. `LEGACY_ROLE_GRANTS.manager` is every capability except the two
owner-only ones. **So any user whose role string is `manager` passes almost
every check regardless of their grants.**

This was the right call when it was written — it made the conversion
impossible to break. It has outlived that job. The menu hides what Elaine does
not hold and the API hands it over, which is the exact shape
`docs/PERMISSIONS.md` named as security theatre and said it would not build.

### Its own exit test now fails

`PERMISSIONS.md` lists three conditions for deleting the fallback. Re-run
today, two have come untrue since they were written:

| Test | Doc says | Actually |
|---|---|---|
| no `requireManager` / `requireInventoryAccess` / `requireScheduleAccess` / `requireGControl` in routes | "Already true" | **38 `requireManager` calls**, all in `routes/eventRequests.js` |
| no client gate reads `user.role` | "Already true" | still true — two `isOwner()` uses in `App.jsx` |
| `capability_fallback_hits` stays 0 for a month | "Currently 0" | **1 row**: Elaine, `users.assist`, 6 hits, 2 Sept 2026 |

`eventRequests.js` is the interesting one: Private Events was built **after**
the conversion and went straight back to the old pattern. Nothing stopped it,
because nothing checks.

The single fallback hit is useful rather than alarming — it is Elaine reaching
user admin she was deliberately not granted, which is precisely the thing the
hit log was built to reveal. It worked. Nobody looked.

### Four people hold nothing at all

Elizabeth Roberts, Ivan Eells, Kayla Jones-Young and Nayeli Galarza have **zero
grants**. They are not locked out of the API — the fallback gives them the
member baseline — but `can()` on the client has no fallback, so they log in to
**an empty sidebar**.

They have never appeared in the fallback log, which means they have not used
TeamHub at all since the conversion. Either they are gone, or they opened it
once, saw nothing, and never came back. Worth finding out which before
backfilling.

### Elisha Brooks is an owner who is not one

Elisha's role is `owner` but the two owner-only capabilities are withheld. The
grants say no; `requireOwner` checks `req.role === 'owner'` and says yes, on
all 103 of its call sites. The client's `isOwner()` does the same, which is
also what hands Elisha the unfinished ResOS reservation screens.

Either Elisha is an owner or they are not. If the intent was "an admin who
should not touch users", the role should be `admin` and the grants will then
mean something.

### What to do, in order

These are independent of the app split and worth doing first — reorganising
navigation on top of guards that do not hold would be rearranging the labels on
an unlocked door.

1. **Convert `eventRequests.js`.** 38 `requireManager` calls become capability
   checks. Until this lands the fallback cannot be deleted, because deleting it
   would not even be noticed here.
2. **Backfill the four empty members**, or deactivate them. Decide which.
3. **Settle Elisha's role.**
4. **Delete the fallback branch**, drop `LEGACY_ROLE_GRANTS`, and flip the two
   `inventory` users to `member` with their seven grants, as `PERMISSIONS.md`
   already prescribes. The day this lands, Elaine and Jack's scoping becomes
   true for the first time.
5. **Then** the app split, which at that point is only navigation.

Step 4 is the one that changes behaviour for real people. Elaine loses 18
things she can reach today and does not know she can reach. That is the
intended outcome, but it should be a decision you make on a Monday rather than
a side effect of a reorganisation.

### Does the app split need new permissions?

**No.** Every app in the chart is covered by capabilities that already exist,
with two additions, both from the receipts change below: `spend.submit` and
`spend.review`. The apps are derived, so there is nothing else to grant.

## Receipts, departments and budgets

You are right that Receipts is in the wrong place, and the reason is sharper
than "Kitchen is too narrow": **Receipts is currently two jobs wearing one
name**, and only one of them belongs to the kitchen.

Today `server/routes/receipts.js` has 28 routes. **Twenty-seven are
`requireOwner`.** Exactly one — `POST /upload` — is gated on
`kitchen.receipts`.

So right now a person holding `kitchen.receipts` can upload a PDF and then
cannot list it, open it, see its PDF, process it, correct a line or delete it.
The capability is a one-way letterbox. Whatever Receipts looks like in the
sidebar, two people can actually use it.

That accident is also the design. The split is real; it was just never named:

**Capture** is thirty seconds in a parking lot on a phone. Photograph the
receipt, say what it was for, done. High frequency, low privilege, **everyone
who buys anything**.

**Process** is an hour at a desk. Vendor matching, categorisation rules, QBO
export, fixing line items. Low frequency, high privilege, two people.

### So Receipts goes in two places

```
Team ▸ Receipts          capture
  Snap a receipt
  What was it for?       department, and optionally a project
  My receipts            what I sent, and whether it has been accepted

⚙ Admin ▸ Books          process  (joins Betty)
  All receipts
  Rules
  Vendors & QBO export
  Receipt Sources        which vendors email invoices in
```

Kitchen does not keep a Receipts screen. A kitchen receipt is just a receipt
with its department set to Kitchen, and the chef sees their own in Team like
everyone else. If the chef should see *everyone's* kitchen spend, that is a
budget screen in Kitchen reading the same data — not a second receipts inbox.

Two new capabilities, following the `tasks.own` / `tasks.manage` pair that
already exists:

| | |
|---|---|
| `spend.submit` | capture a receipt, and see **my own** |
| `spend.review` | see and process **everyone's** |

`spend.submit` goes in the member baseline. A line cook must not be able to
browse the company's invoices just because they bought paper towels, and "my
own" is the distinction that lets you hand this to all twenty-two people
without thinking about it.

The 27 `requireOwner` guards become `requireCapability('spend.review')`. That
is the only real server work, and it is mechanical.

### Department and project are two levels, not one

You named Kitchen, Cellar, Marketing, Events and Wine Club. Notice what that
list is **not**: it is not the app list.

- Kitchen, Cellar and Marketing are apps.
- **Events** is a screen inside Marketing — but an event's spend is a band fee,
  a food cost and an ad buy. It crosses Kitchen and Marketing.
- **Wine Club** is not in the app chart at all. Its spend crosses Marketing and
  Cellar.

So: **do not derive departments from apps.** They are a separate dimension that
happens to overlap, and the two will drift the moment you add a sixth
department or a seventh app. Deriving one from the other would make every such
change a schema argument.

Two levels:

**Department** is the standing bucket — Kitchen, Cellar, Marketing, Events, Wine
Club. It changes once a year.

**Project** is a specific thing with a start and an end: *Hot August Nights*,
*the 2026 Syrah release*. It belongs to a department and has its own budget. It
is how you answer "what did that show cost us", which is the question a
department total can never answer.

A receipt carries a department, and optionally a project. Picking a project
fills in its department, so there is one thing to get right rather than two.

### Split receipts

A Costco run has kitchen paper and marketing signage on the same slip, and
pretending otherwise is how a department total quietly stops being true.

`receipt_items` already exists — `PATCH /:id/items` edits it. So the honest
model is **department on the line, defaulted from the receipt**: one picker for
the common case, a split for the real one, and no migration later when somebody
hits the first mixed receipt.

### Budgets — what the percentage is of  (OPEN)

A budget as a **percent** needs a denominator, and which one you mean changes
the whole shape:

1. **Percent of revenue** — the bucket moves with the season. Kitchen gets 28%
   of food sales. Self-correcting in a slow month, and needs revenue wired in
   per department, which for Wine Club and Events is not obvious.
2. **Percent of a total spend pool** — you set an annual number and divide it.
   Simple, static, and tells you nothing in a month when sales collapse.
3. **A flat amount per period**, with the percent only shown as *how much of it
   you have used*. Simplest to build, and probably what you actually picture
   when you imagine looking at the screen.

I would build 3, and store the budget as an amount per department per period.
A percent-of-revenue rule can then be a way of *computing* that amount later,
without the stored shape changing. Going the other way is a rewrite.

Tell me which you meant, and whether the period is monthly, quarterly or
annual.

## How to ship it without stopping the business

Four phases, each shippable on its own and each reversible.

**1. Make the URL match the menu.** Move `/events` under `/marketing`,
`/quickbooks` under `/kitchen`, and the rest; add redirects from every old path.
Delete the six `is…Path` functions. Nothing moves on screen — the sidebar looks
identical. This is the phase that pays for itself even if you stop here.

**2. Add `visibleApps()` and the switcher, sidebar unchanged.** The switcher
appears and works; the sidebar still shows everything you hold. People can find
the new idea before it is enforced. Members see no switcher at all, which is
already most of the benefit.

**3. The sidebar narrows to the current app.** This is the day it looks
different. Do it alone, with nothing else in the release, so that if it goes
badly there is one thing to revert.

**4. App rows in the permissions matrix.** Last, because by then the apps have
been real for a few weeks and the groupings have been argued about.

## Open questions

1. **Private Events — Floor or Marketing?** Who works the inquiries?
2. **Is "Cellar" the word?** It is the one I would change first if it does not
   sound like what you call it out loud. *Production* is the alternative, and it
   is duller and clearer.
3. **Does Floor need its own Events view**, or is "tonight" a line on Bookings?
4. **Where does a manager's Reports live** — Admin, or a tab in each app
   reporting on that app? Admin is simpler; per-app is more useful. I lean
   per-app with Admin keeping the scheduled-report plumbing.
5. **Harvest** is in the chart under Cellar on the strength of the winery tools
   that already exist. Confirm whether that work belongs in TeamHub at all, or
   stays where it is.
6. **What is the budget percentage a percentage of**, and over what period?
   See *Receipts, departments and budgets*.
7. **Are the four empty members still staff?** Backfill or deactivate.
8. **Is Elisha an owner or an admin?** The role says one thing and the grants
   say another.
