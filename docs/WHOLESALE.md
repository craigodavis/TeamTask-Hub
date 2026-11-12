# Wholesale — design

Status: **design only, nothing built.** Companion to `PRODUCTS.md`.
Amended 2026-09-11: account status, document storage and the buyer portal (§4.12).

A Wholesale tab under Wine: accounts, orders, settings, and a wholesale case price
visible on variants and on the product table.

**Scope note.** A buyer-facing portal — wholesale accounts logging in, uploading their
own paperwork, and ordering at their price level — is **explicitly deferred**. No
interface work of any kind is in scope yet. What §4.12 fixes is the *data model*, so
that building it later is an auth layer over existing tables rather than a rewrite of
the accounts module.

---

## 1. What already exists (and why it changes the design)

The price-levels migration already shipped two tables that were built for exactly this:

| Table | State |
|---|---|
| `product.price_levels` | 3 rows: retail, club, **wholesale** (`sku_suffix = '-w'`) |
| `product.variant_prices` | **0 rows** — created, never populated |

`variant_prices` is empty, so there is no migration cost and no legacy to respect.
That matters for the one change I want to make to the spec (§3.1).

Also relevant:

- `product_variants` has `price_cents`, `sku`, `is_default`, `is_glass`. No case size.
- `product_inventory` has `total_bottles` / `library_bottles` per product per location,
  with `product_inventory_log` for an audit trail.
- `products.wine_style` is `Red` (13 wines), `White` (3), **`Rosé` (1 — 25 Love Letter)**.

---

## 2. Current price reality

Active wines, default bottle variant:

| Style | Retail | Wines |
|---|---|---|
| Red | $45 | 11 Sails, Gypsy Soul, Papa's, Into the Mystic |
| Red | $39 | Peacemaker, 23 + 24 Summer Silhouette |
| Red | $36 | Homestead, Legacy |
| Red | $35 | Cerceau Rivière, Mama's, Moonlit Cello, Sailor's Hold |
| Rosé | $26 | Love Letter |
| White | $26 | A Souvenir, Paso a Paso, Paso a Paso Wild |

At **60% of retail**:

| Retail | Wholesale bottle | Wholesale case (12) |
|---|---|---|
| $45 | $27.00 | $324.00 |
| $39 | $23.40 | $280.80 |
| $36 | $21.60 | $259.20 |
| $35 | $21.00 | $252.00 |
| $26 | $15.60 | $187.20 |

---

## 3. Changes to the spec

### 3.1 The wholesale case price should be derived, not a stored column

The ask was "a new column on the variants table: wholesale case price."

As a **column in the variants grid** — yes, exactly as described. Underneath it should
not be a stored `wholesale_case_price` column on `product_variants`, because the moment
someone edits a retail price the stored copy is silently wrong, and nothing tells you.
That is the same class of bug as the stale `comparePrice` in Commerce7.

Instead:

- The percentage lives in settings (one row per wine style).
- The displayed case price is **computed**: `round(price_cents × pct) × bottles_per_case`.
- If someone types a number into the cell, it writes a row to **`variant_prices`**
  (`variant_id`, `price_level_id = wholesale`, `price_cents`, `is_override = true`).
- The cell shows the computed value in normal weight, an override in bold with a
  "revert to calculated" affordance.

One source of truth, overrides are explicit and visible, and `variant_prices` finally
gets used for the thing it was built for.

### 3.2 The seeded percentage is the inverse of what you want

`price_levels.wholesale.rule_value = 50.0` with `rule_kind = 'discount_pct'` — that is
**50% off list**, i.e. $22.50 on a $45 bottle.

"60% of retail" is $27.00 — a **40% discount**. Same field, opposite sense.

Pick one convention and label the UI so it cannot be misread. My preference:
store `rule_kind = 'pct_of_retail'`, `rule_value = 60`, and label the setting
**"Wholesale price = ___% of retail"** with a live example underneath
(*"a $45 bottle becomes $27.00/btl, $324.00/case"*). Nobody should have to remember
which direction the number runs.

### 3.3 Reds and whites is one bucket short

Love Letter is `wine_style = 'Rosé'`. A two-field settings screen drops it on the floor.

Make settings **one row per `wine_style`** with a default that catches anything new,
so adding a style later doesn't silently produce a null price.

### 3.4 Case size shouldn't be hardcoded to 12

Add `bottles_per_case` to `product_variants`, default 12. Everything is 12 today, but
magnums, half-bottles, and 6-packs all break a hardcoded multiplier, and it's one column
now versus a hunt through the code later.

### 3.5 "Reorder point" doesn't quite work as an account field

You can't see a restaurant's shelf. What actually drives the sales call is *time and
history*, not their stock level. I'd replace it with:

- `reorder_cadence_days` on the account ("check in every 45 days")
- a computed **days since last order** and **last order contents** per account
- a Wholesale dashboard list: *accounts due for a call*

If you do want a true reorder point, it belongs on an account+variant pair
(`wholesale_account_products`: par level, typical quantity), not on the account.

### 3.6 60% is a modest cut from historical practice

Correction to an earlier claim of mine: I said existing `-w` prices ran 68–97% of
retail. That range came from comparing rows that included deleted Square items against
current-vintage prices, and it was wrong.

The actual picture — every `-w` SKU alive in Square:

| Square item | SKU | Price | Status |
|---|---|---|---|
| 22 Peacemaker | `22-peacemaker-w` | $32.25 | archived |
| 24 Love Letter | `24-love-letter-w` | $18.00 | archived |
| 24 Paso a Paso | `24-paso-a-paso-w` | $18.00 | archived |

Three SKUs, all archived, all prior vintages, **none on an active product**. So there is
no live wholesale price list to realign — this is a clean start. The only signal is that
those three sat at roughly **70% of retail**, making 60% a modest cut from past practice.

Two edges still worth weighing:

- **Restaurants.** A 2.5–3× markup lists a $27 bottle at $67–81 — a stretch for a $45
  wine. The norm for restaurant placement is closer to 50% of SRP.
- **Shops.** A ~1.5× markup lands at $40, *under* your own tasting-room price.

60% works for **direct** accounts with nobody in the middle. A distributor needs 50% or
less because they mark up too, so keep the ability to put an account on its own level.

---

## 4. What's missing

Ordered by how much it hurts to leave out.

### 4.1 Inventory: allocate a wholesale pool

**Decided.** Rather than letting wholesale orders eat freely into general stock, a fixed
number of bottles per wine is *allocated* to wholesale. Wholesale orders draw only
against that pool. This caps the downside at the front instead of catching it at the
back: a 20-case order cannot take wine the club needed, because it was never available
to wholesale in the first place.

**Model.** Add `wholesale_allocated_bottles` to `product.product_inventory`:

```
DTC available        = total_bottles − library_bottles − wholesale_allocated_bottles
Wholesale available  = wholesale_allocated_bottles − committed − shipped
```

**Order lifecycle against it** — this resolves the confirm-vs-fulfilled question:

| Moment | What happens |
|---|---|
| **Confirmed** | Bottles become **committed**. Still physically on the shelf, no longer available to promise to anyone else. |
| **Fulfilled** | Bottles physically leave. `total_bottles` and `wholesale_allocated_bottles` both drop; committed clears. |

Doing both, with different words, is what keeps the physical count honest *and* stops
double-promising. Every movement writes to `product_inventory_log`, the way counts
already do.

Because wholesale draws from its own pool, the tasting room was never counting those
bottles anyway — so the split matters much less than it would without allocation.

**Guardrails against the 20-case problem:**

- **Hard block** on an order line exceeding remaining allocation. Owner override only,
  and the override is logged.
- **Warning** when an allocation drops below a set floor, or when a single order takes
  more than a set share of what's left.
- **Months of supply** shown on the line — *"this order is 8 months of stock at current
  depletion"* is the number that actually stops a bad decision.
- **Block** on allocating more bottles than physically exist.

**The caveat that matters.** Reducing the number in TeamHub does *not* by itself reduce
what Commerce7 and Square will sell — they hold their own inventory counts. Push to
Commerce7 exists; the reverse sync does not. Until allocation changes trigger that push,
the allocation is **advisory inside TeamHub only**, and C7 can still oversell an
allocated bottle. Decide for v1: push on allocation change, or warn and reconcile
manually. See open question 3.

### 4.2 The ABC filing

`abcFiling.js` currently reconciles physical counts. Wholesale bottles leave through a
different door and are reported separately from retail sales. Once wholesale orders
exist, the filing has to account for them or the numbers stop tying out.

### 4.3 Licence tracking with expiry — regulatory teeth

You cannot legally sell to an unlicensed buyer or one whose licence has lapsed. Store
licence number, issuing state, and expiry — on the document row, not the account
(§4.12) — and keep the scan itself, not just the number. Warn on the account and
**block or warn on the order screen** when it's expired. This is the item with actual
liability attached. An expiry sweep moves a lapsed account to `suspended` so the block
is a state rather than a screen check.

### 4.4 Resale certificate — required to *approve* an account

**Decided, amended 2026-09-11.** The resale certificate is required before an account can
be **approved**, not before it can be **saved**. You need it for tax purposes, and an
account with no cert on file is an account you cannot legally sell to untaxed.

The original rule was "required to save", and it accepted the consequence that you could
not record a lead while the cert was still in the post. That rule is incompatible with
any flow where the buyer supplies their own documents (§4.12): an application
necessarily exists before its attachments have been verified. Moving the gate from
*save* to *approve* keeps the whole of the legal protection — nothing can be ordered
against an account that is not `approved` — while letting a pending application exist.

Store the cert number and its **expiry**, and flag the account when expiry approaches.
Orders default to tax-exempt and reference the cert on the invoice. An account may not
leave `pending` until a verified resale certificate is on file.

### 4.5 Order lifecycle and getting paid

Draft → Confirmed → Fulfilled → Invoiced → Paid, plus Cancelled.

With it: payment terms (Net 30 is standard), invoice date, due date, and an
**open receivables view**. Without it you'll ship wine and lose track of the money —
which is the same failure mode as the 451 unfulfilled club orders, in a place where
it costs cash rather than goodwill.

### 4.6 Invoicing into QuickBooks

A wholesale order is an invoice. You already have the `qbo` CLI and QBO tooling —
pushing a confirmed order to QBO as an invoice is the natural integration here.
Commerce7 is not; this shouldn't touch it.

### 4.7 Margin visibility

Show gross margin on the order line. At $21/bottle you want to see at a glance whether
you're above cost, especially before agreeing to a distributor number.

### 4.8 Minimums and split cases

- Case minimum per SKU (typically 1), or a dollar/case minimum for free delivery.
- Do you allow 6-packs? It changes the price math and needs deciding before build.

### 4.9 Delivery and jurisdiction

Self-delivery in Idaho vs common carrier vs out of state. Out of state is Vinoshipper's
lane with entirely different licensing. **Recommend scoping v1 to Idaho self-delivery**
and leaving the rest for later.

### 4.10 Permissions

Gate on capabilities — `wholesale.view` / `wholesale.manage` — using the existing
capability system. Wholesale pricing is not something the whole tasting room needs.

### 4.11 The `-w` SKU

No change needed. `price_levels.sku_suffix = '-w'` and `product_channels.external_sku`
already handle it, per `PRODUCTS.md`. Wholesale stays a price level, not a variant.

### 4.12 Account status, documents, and the buyer portal

Listed last only to avoid renumbering; by the "how much it hurts to leave it out" order
of this section it belongs near the top, because two of the three pieces are legal
records.

**Every account holds a required set of three compliance documents:**

| Document | Issue date | Expires | Notes |
|---|---|---|---|
| State retail alcohol beverage licence | yes | **yes** | `issuing_state` matters; Idaho today, not assumed |
| Resale / seller's permit | yes | **yes** | the §4.4 certificate |
| W-9 | yes | **no** | does not expire; `expires_on` is null |

Each row stores the **uploaded file**, an **issue date**, an **expiration date where
applicable**, and a **verified flag** set by a person who has actually looked at the
file. An account cannot leave `pending` until all three are present and verified (§4.4).

**We currently store none of them.** The schema holds `license_number` and
`resale_cert_number` with their expiry dates — numbers, not files. There is nowhere to
put the licence PDF or the certificate scan, and the **W-9 does not appear in the model
at all**, in any form. An auditor asking for the resale certificate gets a number, not a
copy. That gap exists whether or not a portal is ever built, and it is the reason this
section is not purely about the portal.

**Renewals mean a document type has a history, not a value.** A renewed licence is a new
row, not an edit: the superseded one stays for the audit trail with `superseded_by`
pointing forward. "The licence" means the verified, unsuperseded row of that type — at
most one per account per type, which is worth a partial unique index rather than a
convention.

**An account needs a status, not a boolean.** `is_active` cannot express the difference
between *applied and waiting on us*, *rejected*, and *was fine, licence has since
lapsed*. Replace it with `pending | approved | rejected | suspended`. Only `approved`
may have orders written against it; `suspended` is what an expiry sweep sets when a
licence or certificate lapses, so §4.3's regulatory block becomes a state rather than a
screen-level check that something else can route around.

**Store the file, derive the numbers.** Put each document in its own row (schema in §5)
and treat the currently-verified document of each type as the source of the number and
the expiry date. Do not keep a second copy on the account: that is precisely the stale
`comparePrice` failure §3.1 already argues against, and an out-of-date licence expiry is
a legal exposure rather than a pricing annoyance.

**The portal is deferred, but the model should not assume staff entry.** Two fields carry
the difference and cost nothing now: `uploaded_by` is null when the buyer uploaded a
document themselves, and `is_verified` separates *submitted* from *checked by a person*.
With those present, adding the portal later does not touch the accounts module.

**What it would be built on, when it is built.** None of this needs inventing:

- `server/routes/kindredSignup.js` already runs a public signup that issues an opaque
  32-byte session token into `club_steward.member_sessions` behind an httpOnly
  `member_session` cookie, deliberately sharing one session store rather than two.
  `/api/website`, `/api/feedback` and `/api/reports/view` are already public surfaces
  with their own token and PIN patterns. A wholesale login is that pattern again.
- Upload and extraction exist: `server/uploads` with static serving,
  `compressReceiptImage()`, `processReceiptPDF.js`, and the Anthropic vision path the
  kitchen receipts use. A licence could have its number and expiry read off the scan and
  presented for confirmation rather than retyped — the same guess-then-verify shape as
  receipt extraction, and for the same reason: a human confirms before it counts.

### 4.13 Expiry monitoring, and renewal requests

**Phase 1 — notify us.** A document inside **30 days of expiry** raises a notice to
staff. The house pattern for this already exists and should be copied rather than
reinvented: `server/lib/promoReminders.js` is a `runX(companyId, { force })` export that
queries for due rows, fires once per mark by recording what it has already sent on the
row, and is started from `index.js` with `setInterval`. `abcPortalScheduler.js` does the
same on a daily tick. A `runWholesaleDocExpiry()` on a daily interval is the same shape,
with `reminders_sent` on the document row playing the part `promo_tasks.reminders_sent`
plays there.

The ask was a month's warning. One notice at 30 days is thin for something with a
legal consequence, and the same mechanism gives escalation for free, so the
**recommendation** (not a decision) is marks at **30 / 14 / 7 / 0 days**, the last being
the day it lapses.

**On the day it lapses**, the sweep sets the account to `suspended` (§4.12). That is what
makes §4.3's regulatory block a state rather than a screen check — an expired licence
stops orders because the account is suspended, not because someone remembered to look at
a badge.

The passive surface already exists in the design: the licence badge on the Accounts tab
(§6) turns red near expiry. The sweep is the active half, for the case where nobody
opens the tab.

**Phase 2 — ask the account for a replacement.** When a document is inside the warning
window, email the address on the wholesale account asking for a current one. This is a
campaign with a template, and that machinery exists too:

- `server/lib/listmonk.js` — `upsertCampaign()`, `getTemplates()`, `kindredTemplateId()`,
  `findSubscriber()`, `sendTest()` against the listmonk instance.
- `server/lib/email/` — `render.js`, `blocks.js`, `brand.js` for a branded body.
- `server/lib/promoEmailSender.js` is a worked example of a scheduled sender on an hourly
  tick.

One template, parameterised by document type, account name, expiry date and a return
route. Until the portal exists (§4.12) that return route is "reply to this email" and a
person uploads the file on the account's behalf; once it exists, the same template links
straight to the upload screen and nothing else about the flow changes.

Two things to settle before building this half: it must not re-send every day (the
`reminders_sent` marks cover that), and a renewal that arrives must supersede rather than
overwrite, or the audit trail is lost.

---

## 5. Proposed schema

```
product.wholesale_accounts
  id, company_id
  company_name, dba
  contact_name, contact_title, phone, email
  billing_address_1/2, city, state, postal, country
  shipping_* (same shape, "same as billing" flag)
  account_type            enum: restaurant | retailer | distributor | other
  price_level_id          -> price_levels (default: wholesale)
  status                  enum: pending | approved | rejected | suspended  (§4.12)
  approved_at, approved_by, rejection_reason
  is_tax_exempt
  payment_terms           enum: prepay | cod | net_15 | net_30 | net_60
  credit_limit_cents
  reorder_cadence_days
  notes
  created_at/by, updated_at/by
  -- licence and resale-cert numbers/expiries are NOT stored here. They are read
  -- from the verified wholesale_account_documents row of that type (§4.12).

product.wholesale_account_documents
  id, account_id          -> wholesale_accounts
  doc_type                enum: license | resale_cert | w9 | other
  file_path               server/uploads/wholesale/<account_id>/<uuid>.<ext>
  original_filename, content_type, byte_size
  doc_number              licence no. / certificate no.; null for a W-9
  issuing_state           null for a W-9
  issued_on               date the document was issued
  expires_on              date it lapses; null for a W-9 -- it does not expire
  is_verified             bool default false -- a person has looked at the file
  verified_at, verified_by
  extracted               jsonb -- what vision read off the scan, before a human agreed
  reminders_sent          text[] -- expiry marks already fired, so each fires once (§4.13)
  superseded_by           -> wholesale_account_documents, set when a renewal replaces it
  uploaded_at, uploaded_by        -- uploaded_by null == the buyer uploaded it (§4.12)
  notes
  -- at most one verified, unsuperseded row per (account_id, doc_type):
  --   unique index where is_verified and superseded_by is null

product.wholesale_orders
  id, company_id, account_id
  order_number            (sequential, human-facing)
  status                  draft|confirmed|fulfilled|invoiced|paid|cancelled
  ordered_on, requested_delivery_on, fulfilled_on
  customer_po
  delivery_method         pickup | our_delivery | carrier
  subtotal_cents, discount_cents, delivery_cents, tax_cents, total_cents
  qbo_invoice_id, invoiced_on, due_on, paid_on
  notes
  created_at/by, updated_at/by

product.wholesale_order_items
  id, order_id
  variant_id -> product_variants
  cases, bottles              (bottles = cases * bottles_per_case + loose)
  unit_price_cents            (per bottle, snapshotted at confirm)
  case_price_cents            (snapshotted)
  extended_cents
  price_source                calculated | override | manual
  -- committed bottles are derived from status, not stored per line

product.wholesale_settings          -- one row per wine_style + a default
  id, company_id
  wine_style                  'Red' | 'White' | 'Rosé' | null (= default)
  pct_of_retail               numeric, default 60.00
  updated_at/by
```

Plus:
- `product_inventory.wholesale_allocated_bottles` int default 0
- `product_variants.bottles_per_case` int default 12
- `variant_prices` used for overrides only (already exists)
- `price_levels.wholesale` re-expressed as `pct_of_retail` / 60

Snapshotting `unit_price_cents` on the order line matters: an order confirmed in
September must not change its total because someone edited the percentage in November.

---

## 6. Screens

**Wine → Wholesale**, four tabs:

1. **Accounts** — list with company, type, last order, days since, licence status
   (badge turns red near expiry). Detail = the fields above.
2. **Orders** — list by status. Order editor: pick account, add products from the
   product table with variant selection, quantity in cases, live line and order totals,
   margin column, licence/cert warnings inline.
3. **Allocations** — one row per wine: physical bottles, library, allocated to
   wholesale, committed, remaining, months of supply. Editing the allocation is the
   single lever that controls wholesale exposure.
4. **Settings** — one row per wine style, percentage input, live worked example.
   Default 60%.
5. **Dashboard** *(suggested)* — accounts due for a call, open receivables, depletions
   by wine and by account, allocations running low.

**Product table** gains a calculated Wholesale Case column:
`bottle price × pct × bottles_per_case`, with an override indicator.

**Variants grid** gains Wholesale Bottle and Wholesale Case, both calculated, both
overridable.

---

## 7. Open questions

**Closed:**
- ~~Decrement at confirm or fulfilled?~~ → Both: committed at confirm, physical
  decrement at fulfilled, against an allocated pool (§4.1).
- ~~Realign existing Square `-w` prices?~~ → No live `-w` prices exist on active
  products. Clean start (§3.6).
- ~~Resale cert handling?~~ → Required to **approve**, not to save; stored as a
  verified document with issue and expiry dates, not a bare number (§4.4, §4.12).
- ~~What compliance documents does an account hold?~~ → Three: state retail alcohol
  beverage licence, resale/seller's permit, W-9. File, issue date, expiry where
  applicable, verified flag. All three verified before approval (§4.12).

**Open:**

1. 60% of retail confirmed as the default for **direct** accounts? Separate, lower level
   for distributors?
2. Split cases allowed, or 12s only?
3. **Does an allocation change push to Commerce7/Square in v1**, or is the allocation
   advisory inside TeamHub with manual reconciliation? Without the push, C7 can still
   oversell an allocated bottle.
4. Push invoices to QBO in v1, or export/manual first?
5. Idaho self-delivery only for v1?
6. Who sets allocations, and how often — per release, per quarter, ad hoc?
7. **Is the W-9 collected from the buyer, or supplied to them?** A W-9 is normally
   collected from a party you *pay*, not one who pays you — for a wholesale customer the
   usual direction is that *they* ask *you* for one. Some wineries do collect one anyway,
   to open the account in AR or because the buyer's own vendor onboarding demands it.
   Worth confirming which direction is meant before it becomes a required upload. The
   model handles either — `doc_type = 'w9'` with no expiry — but the requirement rule
   differs.
8. Does an approved account see wholesale pricing anywhere before a portal exists, or is
   the price list something staff send out?
9. **What channel carries the expiry notice to staff (§4.13)?** The house reminder
   pattern texts, via `sendSmsToUsers`. A month-out compliance notice is not urgent
   enough to be a text, and the natural audience is whoever holds `wholesale.manage`
   (§4.10) rather than a named person. An emailed digest or an in-app flag may fit
   better; the day-of-expiry mark is the one with a case for a text.
