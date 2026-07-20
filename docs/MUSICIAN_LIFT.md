# Musician / Event Lift Score — spec for the Event Planner module

**Goal:** compute a **dynamic per-performer "lift" score** (how much an act moves POS sales), stored, **regularly re-evaluated**, and exposed via API so the Scheduling forecast can optionally consume it (behind a toggle, default OFF). This doc hands off the methodology the Scheduling side researched — including a **backtest that says the naive numbers do NOT hold**, so build it rigorously.

## The hard-won finding (read this first)
A backtest (2026-07) compared a **naive** lift (act's nights vs an all-time same-weekday, no-event baseline) to a **season-controlled** lift (baseline = same weekday, no-event, **within ±28 days of each show**). Result: most lift **evaporated or went negative**, and most acts beat their baseline on **fewer than half** their nights. Example: Bob Rawleigh went from naive **+63%** to season-controlled **−22%** (won 1 of 4 nights). Causes:
1. **Small samples** (2–4 shows) → noise.
2. **Season confound** — acts in peak weeks look good for reasons unrelated to them. **You MUST control for time-of-year.**
3. **Near-constant-music venues** — at the Creek, music plays almost every Thursday, so there's no clean "same venue, same weekday, no music" baseline; per-performer lift there is currently **not measurable** against a same-venue baseline.

**Implication:** the score must be honest about confidence and often conclude "not enough signal yet." Do not ship raw naive lift.

## CORRECTION (2026-07) — measure the CATEGORY effect, not the performer
Per-performer lift is unreliable (above). But the **category effect — "does the day have live music?" — is real and sizable.** Creek avg net sales by weekday: Sun $911, Mon $265, Tue $569, Wed $401, **Thu $866**, Fri $929, Sat $1236. Thursday (the only music day) performs like a near-weekend, sandwiched between ordinary midweek days — ≈ **+75% vs a comparable no-music midweek day**. Nothing but the music explains it.
- **Build a per-venue CATEGORY lift ("has live music" vs the day's no-music norm), not a per-performer score.** Per-performer stays an optional, low-confidence overlay for later.
- **The forecast already captures *recurring* music** (it's built from same-weekday last-week/last-year history, which had music). So the only useful explicit adjustment is the **deviation from the norm**: a music-free day that normally has music → forecast *lower* (remove the premium); a special show on a normally-quiet day → forecast *higher*.
- Net: the Scheduling forecast lever should be **"is music present vs. this day's historical norm,"** applied per venue with confidence — reliable — rather than "+X% for performer Y."

## Method (do this)
- **Lift per show** = `night_sales / seasonal_baseline`, where `seasonal_baseline` = mean POS net sales on the **same weekday, same location, on non-event days within ±28 days** of the show.
- **Score** = mean of per-show lifts, PLUS:
  - `sample_n` (number of shows scored)
  - `consistency` = fraction of shows with lift > 1 (beat baseline)
  - `confidence` = low/med/high from sample_n + consistency (e.g. high needs `n ≥ 6` AND `consistency ≥ 0.6`)
- **Regularly re-evaluate** (e.g. nightly/weekly): recompute as new shows + sales land; stamp `updated_at`.
- **Future controls (note, not required v1):** also subtract weather and holidays, not just season/weekday — those still confound.

## Data
- Events + performers: `kindred_events` (`performer`, `location_id`, `event_date`) — already synced from WordPress by the Scheduling factor sync.
- Sales: `team_square.v_square_net_sales_daily` (per location per day, dollars — the reconciled canonical view).
- Exclude ALL event days from any baseline.

## Storage (suggested)
`performer_scores` (company_id, performer, location_id, lift_pct, sample_n, consistency, confidence, method, updated_at). One row per performer × location.

## Expose to Scheduling
A read function/endpoint the Scheduling forecast can call: `getPerformerLift(companyId, performer, locationId) → { lift_pct, confidence, sample_n }`. Scheduling will only apply it when its toggle is on AND `confidence` clears a bar (so unproven acts don't move the forecast).

## What Scheduling will do with it
`scheduling_settings.forecast_include_performer_lift` (BOOLEAN, default **false**). When true, a day with a booked performer scales its forecast by `(1 + lift_pct)` — but only for scores above a confidence threshold. Default off until the scores prove out.
