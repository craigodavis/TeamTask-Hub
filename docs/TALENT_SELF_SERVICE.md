# Talent self-service: update link, terms, and date sign-up

**Status: design only. Nothing here is built.**

Send a performer a link. They fill in what we're missing, read what we expect of
them, and later pick their own dates off a calendar we control.

---

## 0. Where the data stands

Of 36 live talent records today:

| | |
|---|---|
| reachable by **email** | 9 |
| reachable by **phone** | 10 |
| **no email and no phone** | **26** |
| have an address (needed for 1099) | 3 |
| have a photo | 3 |

**Decision: assume every performer gets an email or a phone number.** Staff fill
in whatever they have — that is the only prerequisite for sending — so the gap
closes as a matter of data entry rather than a blocker on the design.

It still sets the order of work. Addresses exist for 3 of 36, so the 1099 report
has nothing to run against until the form has been out for a season. Build the
collection before building the report.

## 1. The staff flow

The admin form stops trying to collect everything:

1. Enter **name**, and **email or phone** — whichever you have.
2. Click **Send update link**.
3. They fill in the rest.

So adding a performer takes seconds at the point of booking, which is when
someone actually has the information to hand, and the long tail — address, legal
name, genre, photos — arrives from the person who knows it. The admin form keeps
every field editable for staff; it just stops being the only way in.

The talent list should show where each person stands: *no link sent · sent, not
opened · opened, not submitted · awaiting review · current*. That column is what
makes chasing possible, and without it nobody will know who to chase.

## 2. The link

A long-lived-ish, single-performer, expiring token.

```
talent_update_links
  id            uuid pk
  musician_id   uuid -> musicians
  token_hash    text          -- sha-256; the raw token is shown once, at send
  channel       text          -- 'email' | 'sms' — what we actually used
  sent_to       text          -- the address/number at time of send
  sent_at       timestamptz
  expires_at    timestamptz   -- 24 hours
  opened_at     timestamptz
  submitted_at  timestamptz
  revoked_at    timestamptz
```

Hash the token, never store it raw — the same pattern as `service_tokens`.
`/t/<token>` for SMS, since the whole message has 160 characters.

**Scope it to one musician and nothing else.** The endpoint behind it must have
its own serializer, not a reuse of the admin one. The admin row carries
`lift_pct`, `rate_amount`, `write_check_to` and our internal `notes` — none of
which a performer should ever see, and `lift_pct` in particular is a number we
would not want read aloud.

**Expires in 24 hours**, and the SMS and email both say so — an unexplained dead
link reads as a broken system, a link that said it would expire reads as normal.

24 hours is short enough to matter and short enough to be a nuisance, so the
expired page must not be a dead end. It should offer **"text me a new link"**
straight away: the performer enters the phone or email we already hold, and gets
a fresh one. Same mechanism, performer-initiated instead of staff-initiated.
Without that, every lapsed link becomes a message to Craig.

Re-sending revokes the previous token. One live token per musician.

### Copy link

Alongside **Send**, a **Copy link** button — plenty of these conversations happen
in an Instagram DM, and pasting the link there beats asking for an email address
first.

One honest cost: a copied link is delivered through a channel we cannot see. The
`channel` enum gains `'copied'`, and `sent_to` is null, so the talent list shows
*"link copied 3 Nov"* rather than claiming a delivery that may never have
happened. Everything else — expiry, revocation, single-use-per-musician — is
identical, because the token does not care how it travelled.

Worth saying plainly: a 24-hour link pasted into a DM is about as safe as the DM.
That is an acceptable trade for contact details and a photo. It would not be for
anything in §3's excluded list, which is part of why that list exists.

---

## 3. What they can edit — and the two fields that must not be here

Editable: **legal first/last name**, **band/stage name**, **phone**, **email**,
**address**, **genre**, **act type**, **website**, **Instagram**, **YouTube**,
**Facebook**, **photos**, and a free-text **"anything we should know"**.

The three socials get their own columns — `instagram_url`, `youtube_url`,
`facebook_url` — rather than going into the existing `links` jsonb array, which
is `[]` on all 36 records and has never been used. Named columns can be
validated per platform, rendered as the right icon, and queried ("who has no
Instagram?"); a loose array of URLs can do none of that. Keep `links` for
anything that does not fit.

These are also the fields that make the promotion expectation in §5 checkable at
all: asking someone to post about the show is hollow if we do not know where
they post.

Two deliberate exclusions:

**Taxpayer ID (SSN/EIN) does not go in this form.** A 1099-NEC needs legal name,
address and a TIN. You already decided bank details are collected by phone —
a TIN deserves the same rule, and more. Putting SSNs in a web form means TeamHub
starts storing government identifiers, which brings encryption at rest, access
control, retention and breach obligations that this app is not currently built
for. Collect it the way you collect the bank details, and ideally keep it in the
accounting system rather than here. **The form should ask for legal name and
address only, and say the tax ID will be taken by phone.**

**`notes` is ours, not theirs.** The existing column holds our commentary about a
performer. If their free-text lands in the same field it will overwrite internal
notes the first time someone submits. Add `performer_notes` and keep them apart.

### Name, carefully

`musicians.name` is the booking name and is referenced all over — events, the
website, Bandsintown. 1099 needs the *legal* name, which is often different
("Hip Sounds" is not who the cheque is written to; you already have
`write_check_to` for exactly this reason).

So: add `legal_first_name` / `legal_last_name` / `business_name` / `tax_entity`
(individual | business) and **leave `name` alone**. The performer edits their
legal details without renaming the act — which also avoids them renaming
themselves mid-season and detaching the history we just spent a merge rebuilding.

---

## 4. Submissions are proposals, not writes

Performer input should **not** go straight into the record.

The reason is concrete: a 1099 address and legal name are things you file against.
Someone typing "Mike" over "Michael Sorenson", or a half-finished address, must
not silently replace good data. There is also already a precedent in this app —
events have `stage`, `submitted_at`, `review_by`, approve / request-changes.

```
talent_submissions
  id, musician_id, link_id
  payload        jsonb      -- only whitelisted fields
  status         text       -- pending | applied | rejected
  reviewed_by, reviewed_at, review_notes
  terms_version  text
  terms_accepted_at timestamptz
  created_at
```

Staff see a **diff** — current value beside proposed value, field by field, with
accept-all or accept-per-field. Uncontroversial fields (photo, socials, genre)
could auto-apply later once there is some confidence; legal name and address
should always be reviewed.

**Photos go to the media library's `needs-review` folder**, which already exists
and is already understood by the media UI. An outside party's upload should not
land in the library proper unseen.

---

## 5. Terms

Shown in the email *and* on the form, with an explicit acknowledgement:

> **What we provide** — one pizza and one drink for you during your performance.
>
> **What we ask** — that you actively promote the event: social posts, your
> mailing list, your own event listings.
>
> **How we pay** — direct deposit or a mailed cheque. We will take those details
> from you over the phone; never send bank information or your tax ID by email
> or through this form.
>
> **Your photos and links** — what you send us may appear on our website and in
> our promotion of the show. Tell us any time if you want something taken down.

### Versioned, and visible per performer

Terms are their own records, not a string in a template:

```
terms_versions
  version        text pk     -- '2026-11' or a semver; human-chosen, not auto
  body_md        text        -- the exact wording shown
  effective_from timestamptz
  created_by, created_at

talent_terms_acceptances
  id, musician_id, terms_version -> terms_versions
  accepted_at    timestamptz
  channel        text         -- 'email' | 'sms' — how they were sent it
  submission_id  uuid         -- the submission it came in with
```

An acceptance stores **the version, not a copy of the text**, and the version
row keeps the exact wording — so what someone agreed to can always be read back
verbatim rather than reconstructed.

**Each musician gets a Terms tab**: every version they have been sent, when they
accepted it, and through which channel. Opening Hip Sounds shows they accepted
`2026-11` on 3 November by SMS, and nothing since.

The view that earns its keep is the other direction: **who is not on the current
version.** When the promotion expectation sharpens, that list is who needs
re-sending — and it is the question that is impossible to answer if acceptance is
a timestamp on a submission row.

Re-accepting is just another link send, so there is no second mechanism to build.

That last paragraph is doing double duty: it sets the payment expectation *and*
it inoculates performers against a phishing email that asks for bank details in
your name. Worth keeping even when it feels redundant.

A note on the promotion ask: it is an expectation, not an enforceable term, and
nothing here measures it. If it matters, the honest version is a Bandsintown /
social check on the Distribution card — see docs/EVENT_DISTRIBUTION.md, where
Bandsintown is already an artist-side action.

---

## 6. Act and genre — the dropdown

Identified: the garbage is the **em dash**. The empty option renders as
`—` in both the edit drawer and the filter:

```jsx
<option value="">—</option>          // Events.jsx, the Act select
```

It is a placeholder that reads as a value — in a list of *Solo / Duo / Band* a
dash looks like a fourth, broken choice. Replace it with words: **"Not set"** in
the editor, matching the sibling filters which already say *"Act not set"* and
*"Genre not set"*.

Nothing stored is wrong — `act_type` and `genre` are NULL on all 36 records.
This is a one-word label fix, not a data problem.

Beyond that: if performers are going to pick these, both lists need to be real
reference data — one defined set used by the admin form, the filter and the
public form, instead of three options hardcoded in a JSX file. The genre list in
particular is currently free text with suggestions drawn from values in use, and
since none are in use it suggests nothing, so the first performer to type one
invents the vocabulary for everyone after them.

## 7. Preview: what they will look like on the website

A **Preview** button on the form, showing the performer their own card exactly as
visitors will see it.

This is the best idea in the brief, because it makes the form self-correcting.
Nobody argues with a photo that looks bad once they can see it looking bad, and
a performer who has seen their own empty card is far likelier to write a bio
than one who has been asked to write a bio.

**It has a dependency, and the dependency does not exist yet.** There is no
"musicians that play here" page on the website — no `/musicians` route, no
performer template. The public API exposes a musician's name and photo only as
part of an event. So preview has nothing to point at today.

That is sequencable rather than blocking, if it is built in this order:

1. **The card component first** — one performer's photo, name, genre, act type,
   bio, socials. A self-contained piece of the site.
2. **Preview renders that card** with the submission's values, live as they
   type. No page needed.
3. **The page comes later** and is mostly an arrangement of cards.

Preview is honest about emptiness: a card with no photo and no bio should look
like what it is, not fall back to a tasteful placeholder. The gap is the point.

Current state argues for exactly this order — across 36 performers there are
**3 photos, 4 websites and 0 bios**. A musicians page published today would be
a wall of blanks. Collect first with preview as the carrot, publish once there
is something worth showing.

### Consent

If their photo, bio and socials are going on the website, the terms have to say
so. That is not a technicality — they are handing over graphics *for
publication*, and should be told that is where it goes, alongside a way to ask
for it to come down.

## 8. Accounts, an app, Face ID?

**Recommendation: no app, no passwords. A link, with passkeys later for the
regulars who want them.**

Weigh it against who these people are. There are ~36 performers, most playing a
handful of nights a year, and what they are editing is their own phone number
and a photo. Asking someone to install an app and create an account to do that
is a worse deal than the task is worth — most simply will not, and the ones who
do will have forgotten the password by the next booking. An app also means two
platforms, store review, and updates forever, for a form.

Passwords for ~36 outside users are their own tax: resets, support messages, and
credential storage this app does not currently do for non-staff.

**Face ID and fingerprint do not need an app.** What they actually are, in a
browser, is **passkeys (WebAuthn)** — supported in mobile Safari and Chrome, and
the biometric never leaves the device. But a passkey has to be *enrolled* against
something, so it cannot be the first step: a performer still arrives by link the
first time. It is an upgrade for returning regulars, not a front door.

So, in order:

| phase | mechanism | who it serves |
|---|---|---|
| **1** | expiring link, staff-sent, plus self-service "text me a new link" | everyone |
| **2** *(optional)* | passkey enrolled on their device at the end of a successful submission — "use Face ID next time" | the handful who come back often |
| **never** | installed app, or passwords | — |

Phase 2 is worth it only if phase 1 shows the same people returning. Hip Sounds
at 21 bookings might; the twenty acts with a single booking never will. Decide
with that data rather than now.

The thing to get right in phase 1 so phase 2 stays cheap: make the identity the
**musician record plus a verified channel**, not the token. Then a passkey is
simply another way to prove the same identity, rather than a parallel system.

## 9. Later: letting them pick dates

**Deferred — not in this round.** Kept here because it has a dependency worth
knowing about now, since it affects nothing else being built.

**Slots have to exist before anyone can claim one.** Right now every event is an
individual row — *Thursdays at the Creek* is seven hand-made rows. A sign-up
calendar needs the open dates to be generated from a pattern ("Creek, every
Thursday, 6:30, through October"), which is the recurring-series feature we
established does not exist. **That is the real prerequisite, not the calendar UI.**

```
booking_slots
  id, location_id, starts_at, duration_min
  status      -- open | offered | held | booked | closed
  event_id    -- set once it becomes a real event
  series_id   -- which pattern generated it
```

### Preference, without building a priority engine

The instinct is a ranking system — tiers, weights, who outranks whom. That gets
complicated fast and is hard to explain to a performer. **Explicit offers with an
expiry are simpler and behave the same:**

```
slot_offers
  slot_id, musician_id
  offered_at, expires_at      -- "yours until Friday"
  status                      -- offered | accepted | declined | lapsed
```

Hip Sounds gets Creek Thursdays offered two weeks before they open to anyone
else. They accept, decline, or it lapses and the slot goes `open`. No ranking to
maintain, every decision is visible and auditable, and the performer sees a
straight answer: *this date is yours until Friday.*

Recurring preference ("Hip Sounds gets first refusal on every Creek Thursday")
becomes a rule that *generates* offers, so the rule stays simple and the offers
stay explicit.

### Things that will bite

- **Double-booking.** Two performers accepting the same slot. Needs a unique
  constraint on `(slot_id)` where status is accepted, not a check-then-write.
- **Accepting is not booking.** An accepted slot still needs an event, a title,
  artwork and a publish — it should create a draft event, not a live one.
- **Cancellation.** A performer dropping out three days before is the case that
  matters most and the one most likely to be skipped. It needs a path that
  notifies someone loudly, not a status change nobody sees.

---

## 10. Suggested order

1. **Act dropdown label** — `—` becomes "Not set". A one-word fix, do it now.
2. **Terms versions table and version one of the wording.** Everything
   references it and it is the cheapest piece here.
3. **Minimal create + Send / Copy link + the form + review queue.** The whole
   loop for one performer, end to end.
4. **The performer card component, and Preview wired to it.** Before the public
   page exists — preview is what makes the form fill itself in.
5. **Self-service "send me a new link"**, so a 24-hour expiry does not become a
   stream of messages asking for another.
6. **Terms tab per musician, and the "not on the current version" list.**
7. **The public musicians page**, assembling cards — once there is content.
8. **Legal-name / address fields and the 1099 report** — after a season of
   collection; 3 of 36 have an address today.
9. **Act and genre as reference data**, once the lists are agreed.
10. *(optional)* **Passkeys for returning regulars.**
11. *(deferred)* Recurring series, then the slot calendar.

Steps 1–4 are the ones that change anything this season. Everything from 7
onward depends on performers having actually filled things in, which is a matter
of weeks, not code.

## 11. Open questions

- **What are the terms, exactly, in your words?** The wording in §5 is my draft
  of what you described, now including a publication clause. It becomes version
  one and is stamped on every acceptance, so it is worth reading as copy rather
  than as a summary.
- **Who reviews submissions**, and should a photo-only change wait for a human?
- **What belongs on the public card?** Photo, name, genre, act type, bio and
  socials is my assumption. Rate and lift obviously not; past appearances and
  next date are open.
- **Does a lapsed link need chasing?** The status column shows who never
  submitted, but nothing chases. A weekly "still missing" digest may be the
  difference between this working and quietly not.
