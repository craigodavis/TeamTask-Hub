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

## 3. Terms

### Why one row per condition set, not one per effect

The first version of this had one row per **effect**: a deposit row, an insurance row,
a contract row, each with its own conditions. Craig rejected it, and he was right. The
way the business actually thinks is:

> if over X people at a certain location during business hours or after hours, then
> the rate could change, availability change, deposit change, security deposit change,
> min wine purchase change, insurance required change, contract content sections
> change, and the need for a contract at all change.

That is **one condition set producing a whole package**. Splitting it across eight rows
meant eight copies of the same conditions that could drift apart with nobody noticing.

```
event_terms
  id, company_id, name, active

  -- conditions; NULL means "any"
  min_guests, max_guests
  location_id                   -- NULL = either venue
  during_business_hours         -- NULL = either, true, false

  -- outcomes; NULL means "this row says nothing about it"
  availability                  -- available | on_request | unavailable
  base_price_cents              -- flat rental fee
  min_wine_purchase_cents
  booking_deposit_cents         -- flat; wins over the pct when both are set
  booking_deposit_pct           -- % of the rental fee
  security_deposit_cents        -- refundable, damage
  balance_due_days_before
  planning_meeting_days
  insurance_required
  contract_required
  contract_section_keys[]       -- which clauses this adds
  setup_task_keys[]             -- staff run-sheet steps
  parking_attendant_over
  notes_to_customer

  created_at, updated_at
```

Three condition dimensions only: **headcount × venue × inside-or-outside opening
hours**. Nothing else has ever come up. Day-of-week and lead-time conditions were in
the first draft and were removed unused.

### Resolution: narrowest match wins, per field

1. Gather every active row whose conditions match the booking.
2. Order them **most specific first**, where specificity is the number of *dimensions*
   pinned (0–3). Ties break on the tighter guest band, then on `created_at`, so the
   order is total and stable — two rows must never swap places between page loads and
   change a quote.
3. For each outcome, take the **first row that has an opinion** about it.

Rows therefore **layer**, the way CSS does. A broad row sets the house position, a
narrow row states only what differs.

Specificity counts dimensions and not columns, which matters: counting columns would
score `min_guests`+`max_guests` as 2 and let the 10–24 band outrank a row pinning
headcount *and* hours — quietly putting a contract and a deposit back on a small
daytime party. `server/lib/eventTerms.test.mjs` holds that case.

Worked example — the seeded set, derived from the live `event_tiers` rows:

| Row | Guests | Hours | States |
|---|---|---|---|
| Lawn Gathering | 10–24 | any | $550 rental, $300 min wine, $200 deposit, contract, no insurance |
| Large Group | 25–50 | any | $1,100 rental, $600 min wine, $500 deposit, contract, insurance |
| Small gathering during open hours | ≤15 | during | no deposit, no security deposit, no contract, no insurance |

A 12-person daytime event matches the first and the third. The third pins two
dimensions so it wins the contract, deposit and insurance questions; the rental fee and
the min wine purchase fall through to Lawn Gathering. So: **$550 lawn fee, $300 of
wine, no contract, no deposit** — which is Craig's "15 people may not even need a
contract" without a 15 appearing anywhere in the code.

The same party after hours matches only Lawn Gathering, and the contract and deposit
come back.

### Unknowns are not zeroes

A blank outcome means "nothing configured" and renders as `—`, never as `$0`. A zero is
a decision ("no deposit here"); a blank is an absence. The same distinction applies to
the hours answer: a request with no time given resolves to `null`, and a row requiring
`during_business_hours` either way will not match it — otherwise a request submitted
without a time silently picks up after-hours pricing.

### Provenance

`sources` names the row that supplied each field, so "why am I being charged a security
deposit" is answerable with a row name rather than a number. Removing a row deactivates
it rather than deleting it, because a quote already given points back at its id.

### Still duplicated

The public pricing page reads the old `event_tiers` table; these rows drive what we
quote and contract. Both are editable, which means they can drift. One of the two has
to go, and it should be `event_tiers` — the website should read the broad `event_terms`
rows. Not done yet.

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

**Terms need identical treatment.** Editing a deposit threshold must never rewrite
the terms of a booking already quoted or signed. The evaluated rule set, the
amounts, and the resolved hours are all frozen onto the proposal.

---

## 4. The state machine

Not linear. Contract, deposit and insurance are **requirements generated by the terms**,
not fixed stages.

> **A booking is confirmed when every requirement its terms generated has been met.**

- 15 people, daytime → the terms require nothing → accepting the proposal confirms it
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
  requirements (jsonb)          -- the frozen evaluated terms
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
2. `event_terms` + evaluation + snapshotting
3. Calendar with conflict detection
4. Proposals
5. Correspondence journal (outbound first, then inbound matching)
6. Contract and signing — **gated on legal review**
7. Payments

Each step is useful alone, and the legal review sits late enough not to block the
rest.
