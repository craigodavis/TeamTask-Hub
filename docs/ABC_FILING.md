# Idaho ABC Wine Report — Method & Reconciliation

Monthly wine report filed at https://apps.isp.idaho.gov/AbcReporting
All quantities in **US gallons**. Licensee: Kindred Vineyards.

---

## 1. Conversion constants

| Quantity | Gallons |
|---|---|
| 1 gallon | 3785.411784 ml |
| 750 ml bottle | **0.19812903** gal |
| 1 case (12 × 750ml) | 2.37754836 gal |
| Tasting pour (2 oz) | 0.015625 gal |
| Wine glass (5 oz) | 0.0390625 gal |

---

## 2. Line-by-line data sources

| ABC line | Source | Notes |
|---|---|---|
| Beginning Inventory | Prior month's filed Ending Inventory | Must equal it exactly — never recompute |
| Purchases / In-State Transfer | 0 | Kindred does not purchase bulk or bottled wine |
| **Production** | `vintly.projects` — rows with `bottling_date` in the month | `starting_case_qty × 12 × 0.19812903` |
| **Spoilage / Samples / Tastings** | POS free tastings + unexplained residual | See §4 |
| Sales to Wholesalers / Retailers / Other | 0 | Direct-to-consumer only |
| **Sales to Consumers** | Square (bottles, glasses, paid tastings) + Commerce7 positive-quantity lines | See §3 |
| **Returned Product** | Commerce7 negative-quantity order lines | Quantities are **already signed** — do not negate |
| **Ending Inventory** | Physical bottle count | Required; no count → do not file |

### Production query

```sql
SELECT to_char(bottling_date,'YYYY-MM') AS month,
       sum(starting_case_qty::numeric) AS cases,
       round(sum(starting_case_qty::numeric * 12 * 0.19812903), 2) AS gallons
  FROM vintly.projects
 WHERE company_id = '8d2df498-b5c0-4f73-94cd-323956036113'   -- Kindred, NOT the vintly company id
   AND bottling_date IS NOT NULL
   AND deleted_at IS NULL
 GROUP BY 1;
```

> **Gotcha:** these projects live under the **Kindred** `company_id`, not the vintly one.
> Filtering on the vintly company id returns zero rows and silently reports no production.

> **Gotcha:** a project with a `bottling_date` but a NULL `starting_case_qty` contributes
> **zero gallons silently**. Three such rows exist (23 Cab Sauv KV, 23 Cab Sauv WS,
> 23 Cab Franc KV — all June 2025). Any automation must **hard-fail**, not report 0.

---

## 3. Known data hazards

These have each caused a wrong number at least once. Re-check them whenever the query changes.

| Hazard | Symptom | Fix |
|---|---|---|
| Timezone boundary | `date_trunc('month', make_date(...)) AT TIME ZONE` picks the `timestamptz` overload; window starts 18:00 the prior day | Cast with `::timestamp` |
| Refund double-negation | Commerce7 quantities are already signed; `CASE WHEN 'Refund' THEN -qty` *adds* refunds | Sum the signed quantity as-is |
| Exchanges | 1,147 of 1,149 exchange lines are negative returns — they do **not** wash out | Include them as returns |
| Square payment sync | `/v2/payments` without `location_id` returns the **main location only** — the Creek was missing entirely | Loop every mapped location |
| Catalog variation gap | `ITEM_VARIATION` objects not fetched → orphaned line items | Fetch `ITEM_VARIATION` alongside `ITEM` |

---

## 4. Waste / residual — the important rule

The ABC form combines spoilage, samples and tastings on one line. Internally, keep them apart:

```
Known removals = sales + free tastings          (both measured from POS)
Residual       = Beginning + Production − Known removals − Physical count
```

**Do not treat the residual as an input.** It is a *check*. A plug silently absorbs every
error in every other line and reports it to the state as spoilage.

- Residual within ~2% of beginning inventory → normal (breakage, over-pours, miscount). File it.
- Residual beyond that → **stop and investigate before filing.**

Free tastings are real measured data and are currently the only tracked waste. Breakage,
spillage and dumped bottles are not separately recorded and fall into the residual.

---

## 5. Reconciliation — April to July 2026

The March-end inventory of **1,778.00** was an estimate. The July 3–4 physical count
(10,018 bottles across 16 wines × 2 locations = **1,984.86 gal**) is actual. Bridging the
two requires 940.55 gallons.

**Decision (Craig, 2026-07-27): the full 940.55 is reported as April production**, bringing
the balance where it needs to be in the month being corrected.

| Line | April | May | June |
|---|---|---|---|
| Beginning Inventory | 1,778.00 | 2,610.19 | 2,384.75 |
| Production | **940.55** | 0.00 | 0.00 |
| Spoilage / Samples / Tastings | 10.88 | 18.00 | 14.44 |
| Sales to Consumers | 103.83 | 216.75 | 401.54 |
| Returned Product | 6.34 | 9.31 | 35.86 |
| **Ending Inventory** | **2,610.19** | **2,384.75** | **2,004.63** |

Carrying June's ending forward through July 1–3 (sales 24.94, tastings 1.38, returns 6.54)
gives **1,984.86** — matching the physical count exactly. Variance **0.0000 gal**.

> **Note for the record:** vintly shows one real bottling run inside this window —
> 25 Viognier WS, 144 cases, bottled 2026-05-28 (342.37 gal). Under the decision above it is
> absorbed into the April figure rather than reported in May. The 940.55 is therefore a
> reconciling entry correcting a prior estimate, not a measured production quantity.
> This is a one-time artifact of the March estimate and does not recur.

### July 2026 (file in August)

- Beginning Inventory: **2,004.63** — June's filed Ending Inventory (i.e. July 1), *not*
  the 1,984.86 physical count. The count was taken July 3–4, three days into the month;
  the July 1–3 activity that bridges the two belongs inside the July report, not before it.
- **Production: 266.29** — Sangiovese WS KV, 112 cases, bottled 2026-07-15.
- Sales / tastings / returns: full month, run at month-end.

---

## 6. From August onward

No estimates remain in the chain:

- Beginning Inventory = prior month's real physical count
- Production = real vintly bottling runs
- Sales, tastings, returns = real POS data
- Residual = genuine error check per §4

Nothing is solved-for. If the residual is large, the answer is to find the bug — not to file it.

---

## 7. Prerequisites for every filing

1. A physical inventory count exists for the period. **No count → no filing.**
2. Every vintly project bottled in the month has a non-null `starting_case_qty`.
3. Residual is within threshold (§4).
4. Beginning Inventory equals the prior month's filed Ending Inventory.

If any check fails, stop and resolve it before filing.

---

## 8. Automation

Betty prepares the filing monthly on the 5th, leaving three days for the crew to finish
counting. **She saves; she never submits.** The attestation is the licensee's.

| Piece | Where |
|---|---|
| Computation | `server/lib/abcFiling.js` |
| API | `server/routes/abc.js` — `GET /api/abc/filing/:month`, `POST .../draft`, `POST .../filed` |
| Review page | `/abc` in TeamHub — counted vs expected, residual, line sheet, backup |
| Betty's instructions | `docs/skills/abc-wine-report.md` |
| Schedule | `skynet_schedules` — "Idaho ABC wine report — prepare & save" |

**The flow:**

1. Crew completes the physical count in the first days of the month.
2. On the 5th, Betty pulls `GET /api/abc/filing/{last month}`.
3. If any preflight check fails, she stops and texts Craig the reason. She does not
   open the portal.
4. Otherwise she enters the lines on the ISP portal, **saves as draft**, and records
   the figures via `POST .../draft`.
5. She texts Craig with the headline numbers and a link to `/abc`.
6. Craig reviews, submits on the portal himself, and clicks *"I submitted this"* —
   which sets `status = 'filed'` and becomes next month's Beginning Inventory.

`POST /api/abc/filing/:month/filed` **rejects service tokens** by design. Only a
signed-in human can record a filing.

### Safeguards

- Preflight blocks the filing on a stale count, a missing prior filing, a bottling run
  with no case count, or an out-of-tolerance residual.
- `POST .../draft` refuses to save anything that failed preflight — a draft that can't
  be filed should never look ready.
- `saveDraft` will not overwrite a month already marked `filed`.
- The physical count is restated to month-end by backing out activity between the close
  of the month and the moment of the count (§5 shows this tying to the cent for June).

### Known gaps

- **ISP portal credentials are not yet stored.** The schedule is created but **disabled**
  until they are. They belong in `company_integrations`, entered through Settings — never
  in a prompt, a commit, or a chat transcript.
- **The portal's terms of service have not been checked.** Many state systems prohibit
  automated access. If Idaho's do, keep steps 1–2 and 5 (Betty prepares and notifies) and
  have Craig key the numbers in manually — that retains most of the value.
- Breakage, spillage and dumped bottles are still not separately recorded; they fall into
  the residual.
