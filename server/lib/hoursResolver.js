/**
 * The one place opening hours are worked out.
 *
 * Three layers, most specific wins:
 *   1. hours_special  — an exact date (Thanksgiving, a one-off closure)
 *   2. a bounded rule — same weekday, inside a from/to window ("Saturdays in August")
 *   3. the year-round rule — same weekday, no window
 * Between two bounded rules the NARROWER window wins, so a one-week override sits
 * on top of a whole-season one.
 *
 * Everything reads through here — the website, the "Open now" badge, and the
 * Google/Apple/Facebook publishers. We already shipped one bug from two systems
 * computing hours independently; this exists so there is only ever one answer.
 *
 * Dates are plain 'YYYY-MM-DD' strings in the venue's own timezone. No Date
 * objects: `new Date('2026-08-01')` is parsed as UTC and lands on July 31st
 * west of Greenwich, which is exactly the class of bug this module must not have.
 */

const DAY_MS = 86400000;

/** 'YYYY-MM-DD' → day of week, 0=Sunday. Pure arithmetic, no timezone involved. */
export function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * DAY_MS;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const inWindow = (date, from, to) =>
  (!from || date >= from) && (!to || date <= to);

/** Narrower window sorts first; unbounded sorts last. */
function bySpecificity(a, b) {
  const span = (r) => (r.from_date && r.to_date)
    ? (Date.parse(r.to_date) - Date.parse(r.from_date)) / DAY_MS
    : (r.from_date || r.to_date) ? 3650 : Infinity;
  return span(a) - span(b);
}

/**
 * @param {object[]} rules    kindred_web.hours rows { day_of_week, opens, closes, from_date, to_date, label }
 * @param {object[]} specials kindred_web.hours_special rows { on_date, is_closed, opens, closes, note }
 * @returns {{ closed:boolean, intervals:{opens,closes}[], source:'special'|'seasonal'|'regular'|'none', label:string|null }}
 */
export function resolveDay(rules, specials, date) {
  const onDate = (specials || []).filter((s) => String(s.on_date).slice(0, 10) === date);
  if (onDate.length) {
    if (onDate.some((s) => s.is_closed)) {
      return { closed: true, intervals: [], source: 'special', label: onDate[0].note || null };
    }
    const iv = onDate.filter((s) => s.opens && s.closes)
      .map((s) => ({ opens: s.opens, closes: s.closes }));
    if (iv.length) return { closed: false, intervals: iv, source: 'special', label: onDate[0].note || null };
  }

  const dow = dowOf(date);
  const matching = (rules || [])
    .filter((r) => r.day_of_week === dow && inWindow(date, r.from_date && String(r.from_date).slice(0, 10), r.to_date && String(r.to_date).slice(0, 10)))
    .sort(bySpecificity);
  if (!matching.length) return { closed: true, intervals: [], source: 'none', label: null };

  // Take every rule sharing the winner's specificity — a day can have split hours.
  const bounded = !!(matching[0].from_date || matching[0].to_date);
  const winners = matching.filter((r) => !!(r.from_date || r.to_date) === bounded);
  return {
    closed: false,
    intervals: winners.map((r) => ({ opens: r.opens, closes: r.closes })),
    source: bounded ? 'seasonal' : 'regular',
    label: bounded ? (winners[0].label || null) : null,
  };
}

/** Every date from `from` to `to` inclusive, resolved. */
export function expandRange(rules, specials, from, to) {
  const out = [];
  for (let d = from, guard = 0; d <= to && guard < 800; d = addDays(d, 1), guard++) {
    out.push({ date: d, ...resolveDay(rules, specials, d) });
  }
  return out;
}

/**
 * Days in the window that DIFFER from the plain weekly pattern.
 *
 * This is what the publishers actually want: Google and Apple both take a weekly
 * schedule plus dated exceptions, so sending 90 identical days would be noise.
 * It's also what the website shows as "different this week".
 */
export function exceptions(rules, specials, from, to) {
  const regularOnly = (rules || []).filter((r) => !r.from_date && !r.to_date);
  return expandRange(rules, specials, from, to).filter((day) => {
    const base = resolveDay(regularOnly, [], day.date);
    if (base.closed !== day.closed) return true;
    const key = (x) => x.intervals.map((i) => `${i.opens}-${i.closes}`).sort().join('|');
    return key(base) !== key(day);
  });
}

const hhmm = (t) => String(t).slice(0, 5);
const GDAY = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

/**
 * Google Business Profile.
 *   regularHours  ← the unbounded weekly rules
 *   specialHours  ← one period per DEVIATING date. Google's SpecialHourPeriod
 *                   allows endDate at most one day after startDate, so a season
 *                   cannot be sent as a range — it has to be per date.
 */
export function toGoogle(rules, specials, from, to) {
  const regular = (rules || []).filter((r) => !r.from_date && !r.to_date);
  return {
    regularHours: {
      periods: regular.map((r) => ({
        openDay: GDAY[r.day_of_week], openTime: hhmm(r.opens),
        closeDay: GDAY[r.day_of_week], closeTime: hhmm(r.closes),
      })),
    },
    specialHours: {
      specialHourPeriods: exceptions(rules, specials, from, to).flatMap((d) =>
        d.closed
          ? [{ startDate: ymd(d.date), closed: true }]
          : d.intervals.map((i) => ({
              startDate: ymd(d.date), endDate: ymd(d.date),
              openTime: hhmm(i.opens), closeTime: hhmm(i.closes), closed: false,
            }))
      ),
    },
  };
}

const ymd = (s) => {
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
};

/** Apple Business Connect: same shape of idea — weekly plus dated exceptions. */
export function toApple(rules, specials, from, to) {
  const regular = (rules || []).filter((r) => !r.from_date && !r.to_date);
  return {
    regularHours: regular.map((r) => ({
      dayOfWeek: GDAY[r.day_of_week], opens: hhmm(r.opens), closes: hhmm(r.closes),
    })),
    specialHours: exceptions(rules, specials, from, to).map((d) => ({
      date: d.date, closed: d.closed,
      intervals: d.intervals.map((i) => ({ opens: hhmm(i.opens), closes: hhmm(i.closes) })),
    })),
  };
}

/**
 * Facebook Page `hours` — mon_1_open / mon_1_close, up to two ranges a day.
 *
 * WEEKLY ONLY. The Page hours field has no dated-exception concept, so seasonal
 * rules and holidays CANNOT be represented. This intentionally sends the
 * year-round pattern and nothing else; overwriting the weekly pattern for a
 * season would leave the wrong hours published if a later push failed.
 */
const FBDAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function toFacebook(rules) {
  const regular = (rules || []).filter((r) => !r.from_date && !r.to_date);
  const byDay = {};
  for (const r of regular) (byDay[r.day_of_week] ||= []).push(r);
  const out = {};
  for (const [dow, list] of Object.entries(byDay)) {
    list.sort((a, b) => String(a.opens).localeCompare(String(b.opens)))
      .slice(0, 2) // Facebook accepts at most two ranges per day
      .forEach((r, i) => {
        out[`${FBDAY[dow]}_${i + 1}_open`] = hhmm(r.opens);
        out[`${FBDAY[dow]}_${i + 1}_close`] = hhmm(r.closes);
      });
  }
  return out;
}
