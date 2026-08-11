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
| **Press / tourism orgs** | No | Email or a web form. Idaho Press has a Submit News form; the rest are email. |

Two of these are load-bearing constraints, not details:

- **Facebook Events cannot be automated.** Any design that claims otherwise is wrong.
  The most we can do is prepare the copy and image and hand a human a deep link.
- **Bandsintown runs through the talent, not us.** That makes it a *relationship*
  action, which is why it belongs with the musician records and their contact details.

---

## 2. Three tiers

Everything above sorts into three handling modes. The tiering is the design.

**Tier A — automatic.** We call an API and record the result.
Website · Google Business Profile · Eventbrite · App push · Member email

**Tier B — assisted.** We can't post, so we prepare everything and ask a human for
the last click: prefilled copy, the right image, a deep link straight to the compose
screen.
Facebook Events · Instagram · Bandsintown (via the artist)

**Tier C — outreach.** An email or form submission to a contact.
Idaho Press · Idaho Wine Commission · Destination Caldwell · Sunnyslope · Visit SW Idaho · BoiseDev

Tier B is where this earns its keep. The failure mode today isn't that posting to
Facebook is hard — it's that nobody remembers, and nobody can tell afterwards whether
it happened. A tracked task with the copy already written fixes both.

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
