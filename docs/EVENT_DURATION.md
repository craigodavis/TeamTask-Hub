# Converting existing events to start + duration

**Status: design only. Nothing here is built.**
**Scope: upcoming events only — past ones are not worth touching.**

---

## 1. There is nothing to convert

Duration is arithmetic on two columns that already exist: `end_at - start_at`
*is* the duration, and `start + duration` is what gets written back. No new
column, no backfill, no migration.

Scoped to events that have not happened yet, as of 28 Oct 2026 there are **17**,
running to 5 December:

| duration | count |
|---|---|
| 2 hours | 11 |
| 2½ hours | 3 |
| **7 hours** | **2** |
| 8 hours | 1 |

And, across those 17:

- **0** with a missing `end_at`
- **0** ending before they start
- **0** longer than 24 hours

So the entire remaining job is one line:

> **Add 7 hours to `DURATIONS` in `client/src/pages/Events.jsx`.**

That covers the two Black Friday barrel tastings (27–29 Nov), which are the only
upcoming events whose length has no matching option. Everything else already
lands on one.

The mess worth knowing about — an abandoned `-copy1` with null timestamps, two
zero-length events, a 119-minute typo, *12 Days of Kindred* at 733 hours — is
entirely in 2024 and 2025. It stays there.

---

## 2. Multi-day, deferred but not gone

Multi-day events have fallen away on their own: **10 in 2024, 8 in 2025, 1 in
2026**. Thanksgiving weekend used to be a single 55-hour block; this year it is
entered as three separate single-day events, which is what the calendar draws
best anyway.

None are upcoming, so the 24-hour cap costs nothing today. The thing to watch is
December — *12 Days of Kindred* ran 1–31 Dec in 2024 and the 2026 calendar only
reaches 5 Dec, so December is still being filled in. If something like it is
entered, the cap bites.

What it would look like if it does: a duration list whose longest option is 24
hours has nothing to match a 733-hour event, so the select renders blank or
falls to the first option. Change the title, save, and a month-long event is now
30 minutes — with nobody told.

That is the same shape as both failures already recorded in this code: every
edit shifting events 6 hours earlier, and *"70s & 80s Night"* vanishing from the
website with its end date left a month behind. Both silent, both found late,
both an editor writing a field the user never looked at.

Hence the rule, whatever the cap ends up being:

> **Never write a duration the user did not choose.** Either every real value is
> in the list, or an unmatched one renders read-only — "31 hours (unusual)" —
> until deliberately changed.

---

## 3. Verifying it works

The property that matters is **lossless round-trip**: open an event, save it
without touching anything, and `start_at` / `end_at` must come back identical.
Everything else is cosmetic next to that.

**Read-only audit, before and after.** For each upcoming event, compute
`end_at - start_at`, feed it back through the *same helper the form uses*
(`addMinutes`), and assert it reproduces the stored `end_at` exactly. Report any
mismatch with title and both timestamps. It writes nothing, so it is safe
against production, and it doubles as the dropdown-coverage check: list any
upcoming event whose duration has no exact option. After step 1 that list should
be empty.

With 17 events this runs in a second and can be eyeballed in full — no sampling.

**Then in the browser**, on a draft (there are seven to choose from):

- open a 2-hour event, change nothing, save — then confirm in the **database**
  that both timestamps are unchanged, not just that the page looks right
- open *Black Friday XYZ Barrel Tasting* and confirm it pre-selects 7 hours
  rather than blank
- create from a calendar click and confirm the date matches the day clicked
- set a start of 11:00 PM and confirm the preview reads "the next day"

**Afterwards**, re-run the audit and diff against the before run. Any event whose
stored times moved without someone intending it is a failure.

---

## 4. Open questions

- **The detail editor still uses two `datetime-local` fields.** Leaving it is
  safe but inconsistent with the add form. Converting it is what makes §2's risk
  real, so it should wait until the duration list demonstrably covers everything
  upcoming.
- **December is unfilled.** Worth asking whether anything multi-day is coming
  before the cap decision is made for real.
