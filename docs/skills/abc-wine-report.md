# Skill: File the Idaho ABC monthly wine report

**Agent:** Betty (CFO)
**Runs:** monthly, on the 5th
**Portal:** https://apps.isp.idaho.gov/AbcReporting

---

## Current mode: PREPARE AND NOTIFY ONLY

**Steps 3 and 4 below are switched off.** Do not open the state portal, do not log in
anywhere, do not enter anything on a government site. Craig keys the numbers in himself.

Your job right now is steps 1, 2, 4 (record the draft) and 5 (notify). The portal steps
stay off until the ISP credentials are stored and the portal's terms of service have been
checked — some state systems prohibit automated access, and that question is unresolved.

---

## The one rule

**You prepare and save. You never submit.**

This is a legal filing against Kindred Vineyards' Idaho alcohol licence. The submission
carries an attestation that only the licensee can make. Your job ends when the form is
saved as a draft on the portal and Craig has been notified. If you cannot save without
submitting, **stop and report that** — do not submit to get unstuck.

Never invent, estimate, round to a nicer figure, or plug a number to make the form
balance. If it doesn't balance, that's a finding, not an obstacle.

---

## Step 1 — Pull the numbers

```
GET /api/abc/filing/{YYYY-MM}
```

Use **last month** — on August 5th you file for July, so `2026-07`.

The response gives you:

- `lines` — the ABC form, field for field, already in gallons
- `readyToFile` — boolean
- `blocking` — which checks failed, if any
- `checks[]` — every preflight check with a human-readable reason
- `detail` — the backup: residual, counted bottles, sales mix, bottling runs

## Step 2 — Stop if it isn't ready

**If `readyToFile` is false, do not open the portal.** Notify Craig with the contents
of `blocking` and stop. The usual causes:

| Failed check | What it means | Who fixes it |
|---|---|---|
| `physical_count` / `count_is_current` | The crew hasn't finished counting, or the count is from an earlier period | Craig / floor crew |
| `prior_filing` | Last month was never recorded as filed | Craig |
| `production_complete` | A bottling run in vintly has no case count, so it would report as **zero** production | Craig |
| `residual_within_tolerance` | More wine is missing than breakage explains — usually a data bug, not real loss | Investigate before filing |

That last one matters most. The residual is the difference between what the books expect
and what was physically counted. It is a **check, not a line item**. Every data bug in
the sales pipeline lands there, and filing it as "spoilage" reports a bug to the state as
if it were wine. Past bugs that surfaced exactly this way: a timezone boundary error, a
refund sign error, a Square payment sync that silently covered only one location, and a
catalog sync that orphaned line items. See `docs/ABC_FILING.md` §3.

## Step 3 — Enter it on the portal

Log in with the ISP credentials from company integrations. Fill the wine report for the
period using `lines`, exactly as returned:

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

**Save. Do not submit.** Capture a screenshot of the saved form.

If any portal value fails to match what you entered after saving, report the mismatch
rather than correcting it silently — the discrepancy itself is the useful information.

## Step 4 — Record the draft

```
POST /api/abc/filing/{YYYY-MM}/draft
```

This stores the prepared figures. It refuses drafts that failed preflight, and it will
not overwrite a month already marked as filed.

## Step 5 — Notify Craig

Text Craig with:

1. The period
2. The headline: total gallons sold, production, and the unexplained residual
3. Whether anything looked off on the portal
4. **The review link:** `https://team.kindredvineyards.com/abc`

Keep it short. The link shows him counted inventory vs. what the books expect, the
residual, the full line sheet, and where every number came from. He reviews there,
submits on the portal himself, and clicks *"I submitted this"* to close the month.

Example:

> July ABC wine report is saved on the portal, ready for your review.
> Sold 123.51 gal, produced 266.29 gal (Sangiovese WS KV), unexplained loss 3.2 gal —
> within tolerance. Nothing looked off. Review and submit:
> https://team.kindredvineyards.com/abc

---

## What you must never do

- Submit or file the report
- Change a number to make the form balance
- File when `readyToFile` is false
- Treat the residual as spoilage without checking it first
- Overwrite a month already marked as filed
- Call `POST /api/abc/filing/{month}/filed` — that endpoint rejects service tokens by
  design, because recording a filing is the licensee's act, not yours

---

## Reference

- `docs/ABC_FILING.md` — the full method: conversion constants, per-line data sources,
  the five known data hazards, the residual rule, and the Apr–Jul 2026 reconciliation
- `server/lib/abcFiling.js` — the computation
