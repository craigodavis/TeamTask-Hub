# Customer Identity

How one person is assembled from several systems, which system owns which fact,
and how club membership reaches the mailing list.

Read this before touching `club_steward.customer_identity`, the Commerce7
webhooks, or anything that decides who receives email.

---

## Who owns what

| System | Owns | Covers |
|---|---|---|
| **Commerce7** | Club membership | Only people who signed up to join a club |
| **Square POS** | Transactions | Everyone else who has bought something |
| **Resos** | Reservations | Visitors, whether or not they bought |
| **listmonk** | **Email consent** | Anyone we might email |
| **TeamHub / ClubSteward** | Identity resolution | Stitching the above into one person |

There are no leads. Every person in the master record has done something —
joined a club, transacted, or booked a table.

**Email consent is not owned here.** listmonk decides who may be emailed, and
nothing else may override it. This is not a preference; it is the lesson of the
Campaign Monitor migration (2026-08-10): Commerce7 reported 952 customers as
`email_marketing_status = 'Subscribed'`, of whom **188 had already opted out,
bounced, or reported us as spam**. Commerce7 records what someone ticked at
signup and never hears about anything after. Any design that lets a CRM assert
consent rebuilds that trap.

---

## What is true today (verified 2026-08-10)

**The webhook chain works.** Commerce7 fires authenticated webhooks into
ClubSteward (`/api/webhooks/members`, `/club-membership`, `/order`,
`/order-fulfillment`). The handler calls `syncSingleCustomer`, which maintains
`club_steward.club_members` and its children including
`customer_club_memberships`. Those tables are current.

**The master record is not on that path.** Nothing in the running server calls
the identity code. `resolvePerson()` — the only function that writes
`customer_identity` — has exactly one scheduled caller:
`scripts/reconcile-square.js`, via cron at 03:15 daily. The master record is
refreshed as a *side effect of Square reconciliation*, up to 24 hours late.

**Derived state on the identity row is decaying.**

```
                                    rows
customer_identity                  1,656     767 carry a Commerce7 id
club_members                         797
customer_club_memberships            849     385 active (cancel_date IS NULL)

identity flagged, genuinely active   366
identity flagged, CANCELLED            1     ← grows, never shrinks
active but NOT flagged                18
club_tier stale                        1
```

**Join key gotcha:** `club_members.id` *is* the Commerce7 customer UUID. The
separate `club_members.commerce7_customer_id` column is a later addition that
was never backfilled — 14 of 797 rows. Joining on it silently returns almost
nothing. Join `customer_identity.commerce7_customer_id = club_members.id::text`.

---

## The defect

`resolvePerson()` is **accretive by design**, and correctly so. It merges one
person out of reservations, Square, club records and app accounts, and never
lets a later source destroy what an earlier one established — a Square record
that says nothing about clubs must not unset a club flag Commerce7 set.

```sql
is_club_member = is_club_member OR $9,      -- false -> true only, never back
club_tier      = COALESCE(club_tier, $10),  -- set once, never updated
```

`is_active` is never written at all; all 1,656 rows read `true`, including the
1,280 people who are not members.

**The bug is not the `OR`.** The bug is that membership was stored on the
identity row. Membership is a fact Commerce7 owns and changes; identity
resolution is an accretive merge. One column cannot be both current and
accretive, so no amount of care in the webhook fixes this. The state has to
move off the identity row.

---

## Target model — three layers

**1. Identity — who someone is.**
`customer_identity`, `customer_identifier`, `customer_identity_source`.
Names, contact points, external ids, provenance. Accretive and merge-aware.
**Holds no derived state**: `is_club_member`, `club_tier` and `is_active` come
off it.

**2. Owned facts — what each system asserts.**
`customer_club_memberships` already is this and is already correct. Each fact
lives once, in the system authoritative for it.

**3. Projection — the answer.**
A view, `v_customer_current`, joining identity → club_members → memberships to
compute `is_active_club_member`, `club_tier`, `member_since`. Correct by
construction: there is no stored copy to drift. Consumers — mailing lists,
the host station, reporting — read the view, never the raw flags.

This is the same discipline as the labor-percentage views: encode the definition
once so no consumer can get it wrong.

---

## Webhook responsibilities

**Create / Update** — call `resolvePerson()` inline with the Commerce7 payload
and record a `customer_identity_source` row with `source_type = 'commerce7'`.
Identity becomes current in seconds rather than waiting for the nightly job.

**Primary contact must follow the owner.** Today
`primary_email = COALESCE(primary_email, $4)` means a customer who changes their
email keeps the old one as primary forever. The new address does attach as a
second identifier, so nothing is lost, but "primary" becomes a lie. Primary
should track the owning system's current value; superseded addresses remain as
known identifiers.

**Delete — never hard-delete the person.** A Commerce7 delete means "this record
left Commerce7", not "this human never existed", and the identity may be the
only thread holding their Square orders and reservations together. Remove the
Commerce7 source link and id; keep the person. A genuine erasure request is a
different operation with different obligations and must be modelled separately.

---

## Invariants

1. **Idempotent and order-safe.** Webhooks are redelivered and arrive out of
   order. Upsert on external id and ignore payloads older than what is stored,
   or a replayed Create will overwrite newer state.
2. **Never auto-merge.** Keep logging to `customer_identity_merge_review` and
   stopping. A wrong merge blends two customers' histories, is very hard to
   unpick, and can expose one person's data to another.
3. **Consent lives in listmonk.** Nothing else may mark someone emailable.
4. **Failed webhooks must be replayable.** A failure inside the handler
   currently loses the update until the nightly job. Store the raw payload,
   process, mark done.

---

## Mailing lists

**listmonk's list model is flat and many-to-many.** A subscriber belongs to any
number of lists; each membership carries its own status
(`unconfirmed` / `confirmed` / `unsubscribed`). Blocklisting is at the
**subscriber** level and overrides every list. There is no hierarchy.

**A campaign targeting several lists sends one email per person.** Measured
2026-08-10: two lists, one subscriber on both, `to_send: 1, sent: 1`. So
per-club lists can be multi-selected freely, and a combined "all club members"
list is unnecessary duplication.

### Shape

One list per club, named for the club, plus lists for the other cohorts:

```
Club — Navigator's 4 Bottle Mix        Club — Captain's 6 Bottle Red
Club — Navigator's 4 Bottle Red        Club — Admiral's Mix Case Club
Club — 2 Bottle Mix                    Club — 2 Bottle Red
Club — Captain's 6 Bottle Mix
Past club members
Square customers
```

Membership in these is **derived, never hand-edited**. A club write updates the
relevant list immediately — the same webhook that records the membership change
adds or removes the subscriber — so a cancellation stops club email at once
rather than at the next nightly run.

### Rules the sync must obey

- **A sync may add; it may never resurrect.** listmonk's blocklist wins
  absolutely. Someone suppressed stays suppressed regardless of what any CRM
  says about them.
- **Removing from a list is not unsubscribing.** An ex-member is removed from
  their club list — that is a change in *eligibility*. Their consent is
  untouched, and they may still belong to other lists.
- **Never create a subscriber as `confirmed` on the strength of a CRM record
  alone.** Consent came from somewhere; record where.

---

## Lapsed Commerce7 contacts

Roughly 400 people are in `club_members` without a current membership. They
joined a club at some point and have almost certainly been receiving email, so
they are warm — but they are not current members and must not receive club
mail.

Before they are mailed anything, cross-check every address against the
Campaign Monitor suppression list already loaded into listmonk (2,212 records:
1,921 unsubscribed, 230 bounced, 61 spam complaints) **and** against Campaign
Monitor's active subscriber export. Three cohorts result:

- **Warm** — in Campaign Monitor's active list. Safe to mail.
- **Cold** — never in Campaign Monitor. Never emailed by us. Introducing them
  all at once produces bounces and complaints that damage a young sending
  reputation; send in small batches, if at all.
- **Suppressed** — already blocklisted, and stays that way.

---

## Migration

No flag day required.

1. Add `v_customer_current`; point new consumers at it.
2. Move the Commerce7 webhook to call `resolvePerson()` inline.
3. Add the listmonk club-list sync to the same webhook path.
4. Backfill the 18 active members the identity table is missing.
5. Drop `is_club_member`, `club_tier`, `is_active` once nothing reads them.

`reconcile-square.js` keeps working throughout; it simply stops being the only
thing holding identity together.

---

## Open questions

- **What does a Commerce7 delete mean?** Merged duplicate, erasure request, or
  clean-up of a bad record? Three different behaviours; the webhook cannot tell
  them apart unaided.
- **Should the 188 stale opt-outs be pushed back into Commerce7** so its own
  records stop being wrong? It is a write to Commerce7 and needs a decision.
- **`campaignMonitorReservationSyncScheduler.js`** in ClubSteward still pushes
  reservations to Campaign Monitor on a timer. It breaks when Campaign Monitor
  is retired, and needs repointing or removing.
