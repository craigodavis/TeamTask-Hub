# Scheduling Module Spec

**Purpose:** AI-assisted employee scheduling for Kindred's two locations. A manager-scheduler builds a weekly draft that the owner approves and publishes to Square. The draft is driven by a **deterministic, explainable forecast** (not a black box), a **labor-% budget**, and a growing set of **factors** (holidays, special days, events, weather, performers) learned from Kindred's own history. The same factor data powers a standalone **Factor Correlation Report**.

**Status:** PLAN / spec for sign-off. Nothing built yet. Craig said "plan only."

---

## Locations
- **Kindred Vineyards** (Winery / estate — Marsing, ID) — event venue name in WordPress: `Kindred Vineyards`
- **Kindred by the Creek** (Caldwell, ID) — event venue name in WordPress: `Kindred by the Creek`

Each location is scheduled independently; the approver page can view one location or a combined roll-up.

---

## User Roles
- **New role: `schedule`** ("Manager + Schedule") — can open the Scheduling tab, generate/edit drafts, submit for approval. Added to the `users_role_check` CHECK constraint alongside the existing roles (same pattern as the `inventory` role).
- **`owner`** — everything `schedule` can do **plus** approve, adjust, and publish drafts to Square. Publishing is owner-only.
- The **Scheduling tab** is gated to `schedule` + `owner`. Everyone else never sees it.

---

## Confirmed decisions (from Craig)
1. **Deterministic core, AI as explainer.** The forecast/budget/hours are computed in plain code; Kindred AI only explains the draft and answers what-ifs.
2. **POS-only sales basis.** Forecast and labor % use `team_square` (in-person tasting-room) sales only — not Commerce7/online.
3. **Owner approval + adjust before publish.** Flow: `schedule` role builds draft → submits → owner reviews, adjusts any shift, approves → publishes to Square.
4. **One global target labor %,** applied to each day/location's forecast sales — so the budget is naturally **sales-weighted** (busy days/locations get proportionally more labor).
5. **Avoid overtime** — a Scheduling Settings checkbox, **defaulted ON**; engine caps anyone approaching 40h in the workweek.

---

## Week definition (critical)
Her Square **workweek starts Wednesday** (verified via Square `GET /v2/labor/workweek-configs`: `start_of_week: "WED"`, `start_of_day 00:00`). So:
- The scheduler's week is **Wed → Tue**, not Mon–Sun.
- Sales, hours, and the scoreboard all group by the Wed–Tue week.
- **Overtime is computed per this workweek** (matching how Square + payroll tally the 40 hours). Anchoring to Wednesday is required for the avoid-OT logic to be correct.

---

## Forecast engine (deterministic)

Per day × location, two estimates matched by weekday, blended:

- **A = last week, same weekday** — captures current momentum (recent hires, menu, pricing, weather trend).
- **B = last year, same weekday × (1 + YoY growth)** — captures seasonality, scaled to current run-rate. Growth factor = trailing ~4-week actual ÷ same weeks last year.
- **Forecast = wA·A + wB·B.** Default **wA = 0.4, wB = 0.6** (tunable in Settings). Leans on last-year-scaled because a seasonal tasting room's shape repeats, while the knob lets recent momentum take over when needed.

**Special Days / factors override the base** (see Factors below).

**Labor budget & hours:**
- Labor budget ($) = forecast sales × **global target labor %**.
- Target hours = labor budget ÷ blended average wage.
- Draft = **scale the last published Wed–Tue schedule's shape** (from `team_square.scheduled_shift`) to fit target hours, respecting coverage rules and the OT cap. The engine nudges hours; it does **not** invent a new pattern.

**Data availability:** `team_square.order` goes back to **2023-04-30** (20k+ orders) — full last-year and YoY coverage.

**Horizon:** Default one Wed–Tue week at a time (the natural approval unit). Can draft up to ~4 weeks ahead, flagged with a "confidence drops past 2 weeks" info icon (forecast and weather are both reliable ~1–2 weeks out).

---

## Factors framework (the core abstraction)

Anything that measurably moves sales is a **factor**: holiday, special day, event, performer, weather, promo, day-of-week, time-of-year. Design principle: **the forecast reads a list of factors active on a given day, each with a multiplier, and applies them** — never hardcoded holiday logic. New factor types plug in with zero engine changes.

Each factor instance carries a **learned influence score** (a multiplier, e.g. 1.4× = draws 40% more) derived from its own sales history vs comparable baseline days. New instances inherit a **category baseline** until they have enough history to sharpen.

**Outcome logging from day one:** every day with a factor logs realized sales vs baseline into the factor data layer — so scores train themselves over the season and there's history to learn from when the scoring engine ships.

### Holidays & special days
- **Match by calendar date, not weekday**, for fixed-date holidays (July 3, July 4, Christmas Eve). July 3 → last year's *July 3*, not "last year's Friday."
- **Weekday-aware adjustment:** July 4 on a Saturday ≠ on a Tuesday. A special day blends its last-year-same-date level toward this year's normal-weekday baseline by how far the weekday shifted.
- **Floating holidays by rule** (Labor Day = 1st Mon Sep, Memorial Day = last Mon May, Thanksgiving, **Mother's Day = 2nd Sun May**) — these stay on their weekday, so rule-matching is correct year to year.
- **Auto-detection:** scan last year's daily sales for outliers and *propose* special days for approval — "July 3, 2025 ran 3.1× a normal Thursday — mark recurring?" / "July 4, 2025 ran 0.3× — recurring slow day?" Confirmed once, they persist.
- **Seeding:** (a) auto-scan last year's data for a proposed list + (b) preload standard US holidays. Both, per Craig.

### Close / promote warnings (day-level alerts)
- **Slow-day recommendation:** for July-4-type days, surface "Last July 4 did $X (very low). Recommend reduced hours / closing?" and offer a skeleton or $0-labor draft for that day (weekday-aware — a July-4-Saturday might still warrant open).
- **>50% labor rule:** if a day's labor % (from **either** last-year-same-date **or** last-week-same-weekday) exceeds **50%** (threshold configurable), flag **"Close or drive business on [day]"** — a structural money-loser needing either a cut or a promotion. First-class alert, distinct from the slow-day one.
- **Recommend closing** proactively for both cases (Craig: "recommending would be a good idea"), owner overrides.

### Events
- **Source: WordPress / The Events Calendar** (confirmed correct — hosting.com MySQL `kindredv_wp677`, prefix `wptq_`, reached read-only via the existing `~/.ssh/hostingcom_db_tunnel` key). **286 events, 2023-05 → 2026-10.**
  - Events = `wptq_posts` where `post_type='tribe_events'`; dates in `wptq_tec_events` (`post_id`, `start_date`, `end_date`); venue via `wptq_postmeta._EventVenueID` → `wptq_posts` title (`Kindred Vineyards`→Winery, `Kindred by the Creek`→Creek).
  - **Performer extraction — two patterns by venue:**
    - **Winery** (`Sunset Music Series: <Performer> @ ...`, `Live Music with <Performer> @ ...`) → from the **title**. ~122 events, 37 distinct artists.
    - **Creek** (recurring "Thursdays at the Creek") → from the **body's `Music this week brought to you by <Performer>` line** (near the end of `post_content`; the body is Elementor page-builder data so parse the readable phrase, not the whole blob). All 25 Creek events resolve this way.
  - **Normalize** artist spellings (e.g. `Hip.Sounds` = `Hip Sounds`), trim double spaces; de-dupe to one canonical performer per artist for scoring.
  - **Read charset `utf8mb4`** to avoid mojibake (`6:30–8:30`). Note: `post_content` is Elementor data — readable copy is interleaved with builder bytes; extract by phrase match, don't expect clean prose.
  - Remaining gap: ~53 "Music (unnamed)" Winery events (generic titles like "August Nights at Kindred") have no title/`brought to you by` performer — mine `_elementor_data` or tag manually.
  - **Venue maps to location:** `Kindred Vineyards` → Winery, `Kindred by the Creek` → Creek. So each event carries a location automatically, matched to `team_square` revenue by date + location.
  - Encoding: export with `utf8mb4` (a few titles have a mojibake en-dash).
- **Integration phasing:** now = read-only pull/sync WordPress→TeamHub (TEC stays source of truth); later = migrate event management into TeamHub, optionally push back to WordPress for the public calendar.
- **Events-this-week panel** on the approver page: top 3 external + Kindred events during the Wed–Tue window, ranked by proximity + expected draw, each with source/date/venue and an ⓘ explaining the ranking. External local sources (Indian Creek Plaza / Destination Caldwell, Caldwell Chamber / Canyon County Fair / Caldwell Night Rodeo) weighted highest; Boise/Nampa ticketed feed for the wider net. Advisory by default; optional "affects [day]" toggle nudges that day; manual add supported.

### Weather
- **Source: Open-Meteo** (free, no API key). Live forecast (~10-day) + **archive/ERA5** for historical backfill (decades). Per location (Marsing ~43.63,-116.81; Caldwell ~43.66,-116.69).
- **Backfill 2+ years** of daily weather per location to match POS history.
- **Phase 1: display only** — hi/lo + condition + rain% chip per day card with an ⓘ ("Advisory — not yet factored into the forecast"). **Later:** becomes a scored factor (learn Kindred's own heat/rain sensitivity from history). Zero risk to display; auto-adjust only after it's learned.

### Time of year / seasonality
Captured as day-of-week, week-of-year, month, and season features in the factor data layer (and already implicit in the last-year-same-week estimate).

### Performers (future enhancement)
Each performer gets a **learned score** from their own sales history (e.g. averaged 1.4× → next booking bumps the night 40% and staffing follows). Cold start = category baseline. Phase 1 builds the hooks (generic factor structure + outcome logging); scoring is a follow-on.

---

## Post-shift feedback prompt

**Default OFF** (Scheduling Settings toggle; build and test dark, Craig flips it on when ready).

- **Sent by SMS after close** (same pipe as overtime/discrepancy alerts) with a link to a mobile questionnaire page. **The user enters their PIN on the page to identify/authenticate, then records** (Craig: "a link to a webpage for that user to pin into and record"). PIN gate means a forwarded link can't be used by the wrong person.
- **Only to people who actually worked that day** — from Square clock-ins (`team_square.shift`), matched to their user record for the phone number. One message per person per day.
- **Three questions, that's it:**
  1. "How did it go today?" → 🙂 / 😐 / 🙁
  2. Staffing: **Overstaffed / Just right / Understaffed**
  3. Optional note.
- **Recorded with the day** (`day_feedback`: date, location, user, sentiment, staffing_read, note) and aggregated into the day's factor record.
- **Resurfaces on the next equivalent day** (attached to the day's factor/special-day rule): when scheduling next Mother's Day / the 3rd weekend of August, the day card shows last year's crew read — "Mother's Day 2025: 🙁 · 4 of 5 said understaffed · 'slammed 2–5pm, needed another pourer.'"
- **Why it matters:** human ground truth on whether staffing was actually right — the training signal revenue/labor% can't capture. Closes the loop: scheduler predicts → crew reports over/under → trains the next equivalent day.

---

## Factor data layer + Correlation Report

**Factor data layer** = a daily fact table (date × location) joining actual revenue + transactions to every factor: weather (hi/lo, precip, condition), holiday flags, events, performer, day-of-week/week/month/season, and crew feedback. **Backfilled from 2023-04-30** (POS history; weather archive covers it; events from WordPress). Feeds both the scheduler's learned factor scores and:

**Factor Correlation Report** (Reports, manager+): explainable stats, not a black box — average revenue lift per factor + correlation, e.g. *"rain days −18% · 100°+ days −7% · live music +22% · July 3 +180% · Fridays +35%."* Standalone deliverable, valuable independent of scheduling.

---

## Scheduling Settings (new section under Settings)
- **Target labor %** (global).
- **Avoid overtime** (checkbox, default ON).
- **Forecast weighting** (wA last-week / wB last-year; default 0.4 / 0.6).
- **>50%-labor warning threshold** (default 50%).
- **Operating hours / open days** per location.
- **Coverage rules** (min staff per role/shift).
- **Per-employee max hours/week.**
- **Post-shift feedback prompt** (checkbox, default OFF).
- Growth factors (YTD/YoY) auto-computed, overridable.

---

## Approver page (elegant + intelligent)

Opens on the **last published Wed–Tue week, read-only** (the exact grid she built in Square) with the new draft beside it — never a blank slate. Above the grid, a **scoreboard** of context cards, each number carrying an ⓘ tooltip:

1. **This week's plan** — forecast sales, labor budget $, scheduled hours, **projected labor % vs target** (green/red variance chip).
2. **Where we stand now (YTD)** — actual labor % YTD vs target, and the gap ("running 3.4 pts hot").
3. **vs last year** — same-week-last-year sales & labor %, YoY growth.
4. **Coverage & OT** — min-staff gaps, anyone near overtime.
5. **Events this week** — top 3, ranked.
6. **Weather** — per-day hi/lo + condition + rain% chips.
7. **Day alerts** — slow-day close recommendations, >50%-labor "close or drive business" flags, resurfaced crew feedback for special days.

Below: the editable shift grid (owner adjusts inline) + a **"Why this schedule"** panel where Kindred AI explains the draft in plain English and answers what-ifs ("what if I cut Sunday by 4 hours?").

**Info icons everywhere** — forecast ("Blend of last week $A and same week last year $B +X% growth → $C"), target %, target hours, each shift's rationale, OT flags. Nothing is a black box.

---

## Publish to Square (owner-only)
- Verified: token has **`TIMECARDS_WRITE`** (+ `TIMECARDS_READ`, `TIMECARDS_SETTINGS_READ/WRITE`), merchant `H4H6FC1M07KPT`. No re-auth needed.
- Flow: draft → owner adjusts/approves → `CreateScheduledShift` per shift (`draft_shift_details`: job_id, location_id, team member, start_at, end_at) → `BulkPublishScheduledShifts` (≤100 shifts/call, batch as needed). Square-Version `2025-05-21`.

---

## Data model (new tables)
- Add `schedule` to `users_role_check`.
- `scheduling_settings` (company-scoped: target_labor_pct, avoid_overtime bool default true, forecast_w_lastweek, forecast_w_lastyear, labor_warn_threshold default 0.50, operating hours JSON, coverage rules JSON, feedback_prompt_enabled bool default false, per-employee max hours).
- `schedule_drafts` (id, company_id, location_id, week_start [Wed], status: draft|pending_approval|approved|published, created_by, approved_by, timestamps).
- `schedule_draft_shifts` (draft_id, team_member_id, job_id, location_id, start_at, end_at, source: scaled|manual).
- `factors` (generic: id, type [holiday|special_day|event|weather|performer|...], location_id, date or recurrence rule, label, score/lift, source, confidence).
- `factor_daily` (date × location fact table: revenue, txns, weather cols, holiday flags, event refs, dow/week/month/season) — the correlation + learning substrate.
- `day_feedback` (date, location_id, user_id, sentiment, staffing_read, note, token).
- Events backfill/sync tables or a materialized pull of WordPress TEC (event, performer, venue→location, start/end).

---

## Phasing
- **Phase 1 — Foundation & visibility:** `schedule` role; Scheduling Settings; last-schedule view + scoreboard/approver page; deterministic forecast + labor budget; draft builder (scale last week); **factor hooks + outcome logging**; weather + events display; holidays/special-days (auto-detect + seed); close/promote warnings. *No Square publish yet — review the draft first.*
- **Phase 2 — Publish:** owner approval → `BulkPublishScheduledShifts` to Square.
- **Phase 3 — Smarts:** learned factor scores (performers, weather sensitivity); post-shift feedback prompt live; Factor Correlation Report; full backfill (weather archive + WordPress events → `factor_daily`); event management migration into TeamHub.

---

## Open inputs / prerequisites
- **Confirm SMS** as the feedback-prompt channel (assumed yes; else email).
- Historical events **backfill is automatic** from WordPress (resolved) — decide sync cadence and whether to migrate management now or later.
- Coverage rules / min-staff per role per location — need Craig's numbers.
- Blended-wage source: confirm wage data (Square `TeamMemberWage` vs a TeamHub table).
