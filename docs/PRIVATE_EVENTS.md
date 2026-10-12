# Private Events

Design for the Private Event module: a calendar-first workspace where a public
enquiry becomes a confirmed, paid, (sometimes) signed booking — with every message
in and out of the business recorded against it.

**Status: design only. Nothing in here is built yet.** Written 2026-10-12 for Craig
to mark up before any code.

---

## 1. What already exists

Verified against production, not assumed. More of this is built than it looks.

| Piece | Where | State |
|---|---|---|
| Public enquiry form | `/events/request/` on the website | live, 1 submission (1 Sep) |
| Submit endpoint | `POST /api/website/event-request` | live |
| Request storage | `kindred_web.event_requests` (36 cols) | live |
| Pricing tiers | `kindred_web.event_tiers` | live |
| Admin screen | TeamHub → Event Requests | live |
| Square invoicing | `square_invoice_id/url/status`, `deposit_paid_at` | columns exist |
| Insurance upload + verify | `insurance_media_id`, `insurance_ok`, `_at`, `_by` | columns exist |
| Planning meeting | `planning_meeting_due/booked/at`, tier `planning_meeting_days` | columns exist |
| Opening hours per venue | `kindred_web.hours` + `hours_special`, `lib/hoursResolver.js` | live, used by Vapi |
| Outbound email | `server/mail.js` — nodemailer/SMTP, per-company config | live |
| Inbound email | Harvester `src/connectors/email-invoice.js` — Gmail API, service account | live, for invoices |

`event_tiers` already carries `min_guests`, `max_guests`, `base_price_cents`,
`min_alcohol_cents`, `deposit_required`, `deposit_cents`, `insurance_required`,
`planning_meeting_days`.

---

## 2. The enquiry form

### Required today

| Field | Required | Validation |
|---|---|---|
| First / last name | yes | non-empty |
| Email | yes | format |
| Event date | yes | `YYYY-MM-DD`, must be future |
| Guests | yes | 1–2000 |
| Phone | **no** | — |
| Address | **no** | — |
| Notes | no | — |

### Changes

1. **Phone becomes required.** You need it, and it is missing today.
2. **Address stays optional at enquiry, required at contract.** Asking a stranger
   for their home address before they have a price is a conversion cost you never
   see. It is obviously necessary once there is a contract to sign.
3. **Add a time window: `start_time` + `end_time`.** Not a single "requested time".
   Every hours-based rule depends on the window, and so does conflict detection.
   One point in time cannot answer "is this during business hours".
4. **Add `location_id`** — FK to `locations` where `is_venue`, i.e. Creek or Winery.
   Not a `creek|winery` enum: those rows already exist, and an enum diverges from
   them immediately. (Note the existing inconsistency to avoid repeating — the
   Winery's public `web_slug` is `estate`, not `winery`.)

Venue hours differ sharply, which is why location must be captured with the time:
the Creek opens 16:00 Tue–Fri, the Winery 12:00.

---

## 3. Rules

### Why a narrow table, not an engine

A general condition/action engine is quick to start and impossible to answer
questions about once there are fifteen rules and a customer asks why they were
charged a deposit. This table is deliberately limited to the conditions the
business actually uses.

```
event_rules
  id, company_id, name, active, priority        -- lower priority wins

  -- conditions; NULL means "don't care"
  min_guests, max_guests
  location_id                   -- NULL = either venue
  during_business_hours         -- NULL = either, true, false
  day_of_week_mask              -- NULL = any day
  lead_days_min, lead_days_max  -- how far ahead the booking is

  -- effect
  effect_type                   -- deposit | payment | contract | insurance
                                -- | staffing | surcharge | block
  amount_cents, amount_pct
  due_offset_days               -- negative = before the event
  customer_text                 -- what the proposal says

  created_at, updated_at
```

### Evaluation

1. Gather every rule whose conditions match the booking.
2. **One winner per `effect_type`**, by priority.
3. The winning set becomes the booking's **requirements**.

Worked example — the no-deposit case:

| Priority | Guests | Hours | Effect | Customer text |
|---|---|---|---|---|
| 10 | 1–20 | during | deposit: none | — |
| 20 | 1–20 | outside | deposit $X | "after-hours events require a deposit" |
| 30 | 21–50 | any | deposit $Y | … |
| 40 | 51+ | any | deposit $Z + 50% at −30 days | … |

A 15-person daytime event matches rule 10 and gets **no deposit**.

> **Record it as a decision, not an absence.** Store `deposit_required = false`
> *with the id of the rule that decided it*. NULL cannot distinguish "we decided no
> deposit" from "nobody has evaluated this yet", and that difference matters the
> first time a customer asks why they were not charged.

### "During business hours" is computed, not typed

`hoursResolver.resolveDay(hours, specials, date)` already returns `{ opens, closes,
closed }` per venue per date, honouring `hours_special` and seasonal `from_date`/
`to_date` overrides (e.g. the "Hot August Nights" row extending Saturdays to 22:00).

```
isDuringBusinessHours(location_id, date, start_time, end_time)
  → the whole requested window sits inside opens..closes
```

Three decisions to make explicit:

- **A window straddling opening or closing counts as OUTSIDE.** Safer, and easy to
  explain to a customer.
- **A closed day is outside hours AND means opening specially.** The Creek has no
  Monday row at all. That probably deserves its own rule and its own price, not
  just the after-hours deposit.
- **Snapshot the resolved hours onto the proposal**, so a later hours edit cannot
  retroactively reclassify a quoted event.

### Snapshot everything

The existing tier code already does this and says why:

> "The quote is taken NOW and stored by value: tiers get edited, and what we told
> this guest must not change under them afterwards."

**Rules need identical treatment.** Editing a deposit threshold must never rewrite
the terms of a booking already quoted or signed. The evaluated rule set, the
amounts, and the resolved hours are all frozen onto the proposal.

---

## 4. The state machine

Not linear. Contract, deposit and insurance are **requirements generated by rules**,
not fixed stages.

> **A booking is confirmed when every requirement its rules generated has been met.**

- 15 people, daytime → rules generate nothing → accepting the proposal confirms it
  immediately.
- 150 people, Saturday evening → contract + insurance + deposit + 50% at −30 days →
  stays unconfirmed until all four are satisfied.

One model, both paths, no special-casing. Note the thresholds need not be shared:
a contract might be required from 30 guests while a deposit starts at 60.

```
new ──▶ reviewing ──▶ proposed ──┬──▶ declined
                                 ├──▶ withdrawn
                                 └──▶ accepted ──▶ [outstanding requirements] ──▶ confirmed
                                                              │
                                                              └──▶ cancelled
```

---

## 5. Proposals are rows, not a status

Negotiation is expected — "we suggest 2pm instead", they counter, we re-propose. A
single status field cannot hold that.

```
event_proposals
  id, request_id, version
  proposed_date, start_time, end_time, location_id, guests
  price_cents, min_alcohol_cents
  rules_snapshot (jsonb)        -- the frozen evaluated rule set
  hours_snapshot (jsonb)        -- resolved opens/closes for that date+venue
  requirements (jsonb)          -- deposit/contract/insurance/payments derived
  body_html                     -- exactly what was sent
  token, token_expires_at
  sent_at, accepted_at, declined_at, declined_reason
  created_by
```

---

## 6. Contract and signing

Required only when a rule says so.

- Rendered to an **immutable snapshot** at send time; store a **hash of exactly what
  was displayed**.
- Customer signs online: tokenised link → contract page → types their name.
- Signature record: typed name, timestamp, IP, user-agent, document hash.
- Counter-signed by Kindred to complete.

The hash is what makes it defensible: it proves *what* was agreed, not merely that
someone clicked.

```
event_contracts
  id, request_id, proposal_id
  template_id, body_html, body_hash
  customer_signed_name, customer_signed_at, customer_ip, customer_ua
  countersigned_by, countersigned_at
  status            -- draft | sent | customer_signed | executed | void
```

> **Legal review needed.** A typed-name signature with an audit trail is generally
> workable under ESIGN/UETA, but this contract carries liability and insurance terms
> for a venue serving alcohol. An attorney should see it before it goes live. That
> is not a judgement this document makes.

**Even a no-contract booking should get terms in writing** — cancellation, headcount
changes, liability — in the confirmation email. "No contract" should mean "no
signature ceremony", not "no record of what was agreed".

---

## 7. Payments

A deposit plus 50% at −30 days is a schedule, not two columns.

```
event_payments
  id, request_id
  type              -- deposit | progress | balance
  amount_cents, due_date
  status            -- pending | invoiced | paid | waived | overdue
  square_invoice_id, square_invoice_url, square_invoice_status
  paid_at
```

Reuses the Square invoicing already present on `event_requests`. Also yields "what
is owed this month" for free.

---

## 8. Correspondence — all of it, journaled

### Outbound

`server/mail.js` (nodemailer/SMTP) already exists. Every outbound message carries a
plus-addressed Reply-To containing the thread token:

```
From:     Kindred Vineyards <events@kindredvineyards.com>
Reply-To: events+pe_7f3a91@kindredvineyards.com
```

### Inbound

Reuse the Harvester pattern — Gmail API with a service account, poll with a query,
apply a done-label so nothing is processed twice. `email-invoice.js` does this today.

Match an incoming reply in this order:

1. **plus-address token** in To / Delivered-To — the reliable one
2. `In-Reply-To` / `References` message-id
3. sender email matches the request
4. **unmatched queue** for a human to assign

Step 4 is not optional. People reply from their phone, from a different address, or
with the subject rewritten; without a queue those replies simply vanish.

### The journal

```
event_messages
  id, request_id, direction            -- out | in
  message_id, in_reply_to, thread_token
  from_addr, to_addr, subject
  body_text, body_html                 -- as actually sent/received
  attachments (jsonb → media ids)
  sent_at, received_at
  sent_by, template_id, delivery_status
  raw_headers (jsonb)
```

Store the **rendered** body, not just a template id — templates get edited and the
journal must show what was actually sent.

### Three cautions

- **Deliverability.** Contract and payment-deadline mail must not ride the bulk IP.
  Shared-IP reputation has already burned us once (see `project_email_stack`). Send
  transactional mail via SES directly, separate from listmonk campaigns.
- **You cannot force customers into the app**, only make it the easiest path. Staff
  need to log a phone call into the same journal by hand, or "everything is
  journaled" is false within a week.
- **Polling has latency.** Harvester runs on a schedule; a reply may sit for minutes.
  Fine for bookings — just do not build anything assuming instant.

Attachments: the invoice connector already uploads to TeamHub media. Point insurance
certificates at `insurance_media_id`, which exists.

---

## 9. Calendar

First screen of the module. Full CRUD. Colour by **the earliest unmet requirement**,
not by a fixed stage — so a small event goes red → green with nothing between, which
is correct rather than a gap.

| Colour | Meaning |
|---|---|
| Red | New request, not yet reviewed |
| Amber | Proposal sent, awaiting customer |
| Orange | Customer signed, awaiting our counter-signature |
| Blue | Fully signed, payment outstanding |
| Green | Confirmed, all requirements met |
| Grey | Declined / withdrawn — kept visible; knowing you said no to a date matters |

### Two things not asked for, worth building early

**Conflict detection on the review screen.** Show what else is on that date — public
events, other private bookings, a Thursdays at the Creek — before anyone approves.
Nothing currently stops a private booking being approved at the Creek on a night a
musician is booked there. Given five Thursdays were recently found missing from the
calendar entirely, the calendar is not yet a reliable picture of what is happening.

**A confirmed private event must block the venue on the main events calendar**, not
only inside this module. Otherwise the two calendars disagree and the Creek gets
double-booked.

---

## 10. Decisions needed from Craig

1. Deposit thresholds — guest counts and amounts, per venue if they differ.
2. Contract threshold — same number as the deposit, or its own?
3. Payment schedule — is 50% at −30 days right for every size above the threshold?
4. Does a closed-day booking (e.g. Monday at the Creek) carry its own charge?
5. Which address — `events@`? And is it already receiving into craig@'s mailbox the
   way `invoice@` does?
6. Insurance: what cover, and from what size?
7. Cancellation terms for the no-contract confirmation email.

## 11. Build order

1. Fields and validation — time window, location, phone required
2. `event_rules` + evaluation + snapshotting
3. Calendar with conflict detection
4. Proposals
5. Correspondence journal (outbound first, then inbound matching)
6. Contract and signing — **gated on legal review**
7. Payments

Each step is useful alone, and the legal review sits late enough not to block the
rest.
