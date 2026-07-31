# Skill: File the Idaho ABC monthly wine report

**Agent:** Betty (CFO)
**Runs:** monthly, on the 5th — plus one-off runs while catching up April/May/June
**Portal:** https://apps.isp.idaho.gov/AbcReporting/login

---

## The one rule

**You prepare and save. You never submit.**

This is a legal filing against Kindred Vineyards' Idaho alcohol licence. The submission
carries an attestation that only the licensee can make. Your job ends when the form is
**saved** on the state portal and Craig has been notified to review it there himself. If
you cannot save without submitting, **stop and report that** — do not submit to get
unstuck.

Never invent, estimate, round to a nicer figure, or plug a number to make the form
balance. If it doesn't balance, that's a finding, not an obstacle.

---

## One month at a time, in order

The ABC portal only allows **one report in progress at a time.** Do not start the next
month until Craig has confirmed the current one is fully submitted.

```
GET /api/abc/next-month
```

Returns the one month you should be working on:

- `month: null, reason: "no_filing_history"` — nothing to chain from. Stop and tell Craig.
- any month returned — **this is the month to prepare now.** Continue to the next step.

**Do not over-read `reason`.** Both `"awaiting_submission"` and `"next_in_sequence"` mean
the same thing to the caller: this month is not yet confirmed filed, so it is this run's
job. `awaiting_submission` is derived purely from this database —

```sql
SELECT period_month FROM abc_filings WHERE status <> 'filed' AND has_detail = true
```

— so it says **nothing** about whether anything exists on the Idaho portal. A month that
has never been touched on the portal reports `awaiting_submission` too. Never describe a
report as "already saved on the portal" without having seen it there, and never stop early
on the strength of this field. (Doing exactly that is what caused April 2026 to be
reported as portal-ready when nothing had been saved.)

---

## Step 1 — Pull the numbers

```
GET /api/abc/filing/{month}
```

`{month}` comes from `/next-month` above — don't guess it, and don't assume it's "last
month." April, May and June 2026 are being caught up on one at a time; only once all three
are confirmed filed does the sequence reach July and settle into "always last month."

The response tells you which situation you're in:

- **`detail.source === "stored"`** — this month was already hand-reconciled once. **Use
  `lines` exactly as returned. Do not recompute, do not re-derive, do not "double check"
  the math against vintly or Square yourself.** These figures intentionally don't match a
  fresh calculation — a prior decision routed some production from one month onto another
  to correct an old estimate, and a live recompute will flag that as a residual failure
  even though the stored figures are correct. That failure is the automation doing its job
  on a case it wasn't built to re-derive, not a sign something is wrong. April, May and
  June 2026 are all `stored`.
- **No `detail.source`, ordinary `checks[]` present** — this is a fresh month with nothing
  reconciled yet (July 2026 onward). This is the normal case going forward: verify
  `readyToFile`, respect the checks, proceed as below.

## Step 2 — Stop if it isn't ready

Only applies to freshly computed months (not `stored` ones — those are always ready unless
already filed).

**If `readyToFile` is false, do not open the portal.** Notify Craig with the contents of
`blocking` and stop.

| Failed check | What it means | Who fixes it |
|---|---|---|
| `physical_count` / `count_is_current` | The crew hasn't finished counting, or the count is from an earlier period | Craig / floor crew |
| `prior_filing` | Last month was never recorded as filed | Craig |
| `production_complete` | A bottling run in vintly has no case count, so it would report as **zero** production | Craig |
| `residual_within_tolerance` | More wine is missing than breakage explains — usually a data bug, not real loss | Investigate before filing |

The residual is the difference between what the books expect and what was physically
counted. It is a **check, not a line item**. Filing it as "spoilage" without looking would
report a bug to the state as if it were wine. Past bugs that surfaced exactly this way: a
timezone boundary error, a refund sign error, a Square payment sync that silently covered
only one location, and a catalog sync that orphaned line items. See `docs/ABC_FILING.md` §3.

## Step 3 — The portal is Craig's, not yours

**Do not log in to apps.isp.idaho.gov. You cannot, and you must not claim you did.**

The agent runs with no browser tool and no browser automation library — driving a web
form is outside what it can do. An earlier version of this playbook told it to log in and
save the report anyway. It could not, so it reported `awaiting_submission` from
`/abc/next-month` as though that meant "saved on the portal", and Craig went to the portal
twice to review a draft that was never there.

`GET /api/abc/isp-credentials` still exists but is no longer part of this flow. There is
no reason to hand state portal credentials to something that cannot use them.

If portal automation is ever wanted, it needs three things first, in order: clearance that
the ISP terms of service permit automated access, a real browser automation stack, and a
tested login/form script. It is a project, not a prompt change.

## Step 4 — Hand the numbers to Craig

Post a comment on the task with the plain sentence *"Nothing has been entered on the
portal — that step is yours"*, followed by the full ten-line table using the exact ABC
form field names:

| Portal field | Response field |
|---|---|
| Beginning Inventory | `lines.beginningInventory` |
| Purchases / In-State Transfer | `lines.purchases` |
| Production | `lines.production` |
| Spoilage / Samples / Tastings | `lines.spoilageSamples` |
| Sales to Wholesalers | `lines.salesWholesale` |
| Sales to Retailers | `lines.salesRetail` |
| Sales — Other | `lines.salesOther` |
| Sales to Consumers | `lines.salesConsumers` |
| Returned Product | `lines.returnedProduct` |
| Ending Inventory | `lines.endingInventory` |

Tell him where to go (https://apps.isp.idaho.gov/AbcReporting/login), and that once he has
submitted he records it at **Manage → Reports → Idaho ABC filing** with the
"I submitted this — record it as filed" button. The next month is not prepared until he
does — that button is what advances `/abc/next-month`.

`POST /team/notify` currently logs without sending (`getManagerPhoneNumbers()` in the
Paperclip plugin is a hardcoded empty list), so the task comment is the real channel.
Never rely on the text arriving.

## Step 5 — Record the draft

```
POST /api/abc/filing/{month}/draft
```

Skip this step entirely if `detail.source === "stored"` in Step 1 — that month's figures
are already recorded; this endpoint would just recompute and fail preflight for exactly
the reason explained in Step 1. Only call it for freshly computed months.

## Step 6 — Notify Craig

Text Craig with:

1. The period
2. The headline: total gallons sold, production, and the unexplained residual (skip the
   residual line for a `stored` month — say "previously reconciled figures" instead)
3. Whether anything looked off on the portal
4. **Tell him to review and submit on the ABC site itself** — `https://apps.isp.idaho.gov/AbcReporting/login` — not just the internal review page. He needs to log in there, check the saved draft, and submit it himself.
5. The internal review link as a secondary reference: `https://team.kindredvineyards.com/abc`
6. **A reminder that the next month cannot be prepared until this one is confirmed filed.**

Example (fresh month):

> July ABC wine report is saved on the state portal, ready for your review.
> Sold 123.51 gal, produced 266.29 gal (Sangiovese WS KV), unexplained loss 3.2 gal —
> within tolerance. Nothing looked off.
> Please log in and submit: https://apps.isp.idaho.gov/AbcReporting/login
> (Internal detail: https://team.kindredvineyards.com/abc)
> August's report won't be prepared until this one is confirmed submitted.

Example (stored/reconciled month):

> April's wine report is saved on the state portal — these are the previously
> reconciled figures, entered as-is. Ending inventory 2,610.19 gal.
> Please log in and submit: https://apps.isp.idaho.gov/AbcReporting/login
> May won't be prepared until this one is confirmed submitted.

---

## What you must never do

- Submit or file the report
- Change a number to make the form balance
- Recompute or "correct" a `stored` month's figures — enter them exactly as given
- File when `readyToFile` is false (fresh months only)
- Start the next month before the current one is confirmed filed
- Overwrite a month already marked as filed
- Call `POST /api/abc/filing/{month}/filed` — that endpoint rejects service tokens by
  design, because recording a filing is the licensee's act, not yours

---

## Reference

- `docs/ABC_FILING.md` — the full method: conversion constants, per-line data sources,
  the five known data hazards, the residual rule, and the Apr–Jul 2026 reconciliation
- `server/lib/abcFiling.js` — the computation
- `server/routes/abc.js` — `/next-month`, `/filing/:month`, `/isp-credentials`, `/filing/:month/draft`, `/filing/:month/filed`
