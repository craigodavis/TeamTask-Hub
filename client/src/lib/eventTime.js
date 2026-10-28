/**
 * Event date and duration arithmetic.
 *
 * Extracted from pages/Events.jsx so the audit script can exercise exactly the
 * functions the form uses. A test that reimplements the logic it is checking
 * only proves the copy agrees with itself; given this code's history of silent
 * time bugs, that is not worth having.
 *
 * Pure — no React, no DOM. Safe to import from Node.
 */
/**
 * Keeping an event's two dates consistent.
 *
 * An end before its start is always a typo, and there is one way it happens:
 * moving the event's date and leaving the end behind. "70s & 80s Night" was
 * entered for 7 November with its end still on 7 October, and disappeared from
 * the website without a word — the list treats the later of the two as "has
 * this happened yet".
 *
 * Two quiet guards beat one loud one. shiftEnd carries the end along when the
 * start moves, keeping the event's length, so the common path cannot produce a
 * bad pair at all. dateRangeError describes a pair that is still wrong, to be
 * shown beside the field while it is wrong — not as a dialog after the fact,
 * which arrives once the work is done, has to be dismissed before it can be
 * acted on, and does not say which field is at fault.
 *
 * Both take the 'YYYY-MM-DDTHH:mm' strings the datetime-local inputs use.
 */
const pad2 = (n) => String(n).padStart(2, '0');
const parseInput = (s) => { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };
const asInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function shiftEnd(prevStart, nextStart, end) {
  const p = parseInput(prevStart), n = parseInput(nextStart), e = parseInput(end);
  if (!p || !n || !e) return end;
  if (e < p) return end; // already inconsistent — shifting would only bury it
  return asInput(new Date(e.getTime() + (n.getTime() - p.getTime())));
}

function dateRangeError(start, end) {
  const s = parseInput(start), e = parseInput(end);
  if (!s || !e) return '';
  return e < s ? 'This ends before it starts. Check the end date — moving an event leaves the end behind.' : '';
}

/**
 * Adding an event asks for a start and a length, not two timestamps.
 *
 * An end date is a second thing to get wrong, and it is exactly how "70s & 80s
 * Night" ended up finishing a month before it began. A duration cannot be
 * inconsistent with its own start, so that whole class of mistake stops being
 * possible rather than being caught after the fact. end_at is still what gets
 * stored — it is computed from the two here.
 *
 * Times are offered on the hour and half hour only. A free minute field invites
 * 6:47 PM, and the native picker seeds minutes from the wall clock, so an event
 * added at 2:13 quietly defaulted to :13 past.
 */
const DEFAULT_START_TIME = '18:00';
const DEFAULT_DURATION_MIN = 180;

const HALF_HOURS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2), m = i % 2 ? 30 : 0;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { value: `${pad2(h)}:${pad2(m)}`, label: `${h12}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}` };
});

const durLabel = (m) => {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rem = m % 60;
  return `${h} hour${h === 1 ? '' : 's'}${rem ? ` ${rem} min` : ''}`;
};
// Capped at 24 hours. Anything longer is a multi-day run, which wants to be
// separate events so each day draws on the calendar on its own.
// 420 and 540 come from the real calendar, not from guessing: the Black Friday
// barrel tastings run 7 hours, and New Year's Eve at the Creek ran 9. Without
// them the select cannot show the current value and a later save rewrites it.
//
// Stops at 12 hours. Past that the honest answer is not a longer number but
// "we are open" — which is what ALL_DAY means here: the event runs through that
// day's opening hours rather than a span someone has to keep in step with them.
const ALL_DAY = 'all_day';
const DURATION_MINUTES = [30, 60, 90, 120, 150, 180, 210, 240, 300, 360, 420, 480, 540, 600, 720];
const DURATIONS = [
  ...DURATION_MINUTES.map((m) => ({ value: m, label: durLabel(m) })),
  { value: ALL_DAY, label: 'All day (open hours)' },
];
const isAllDay = (v) => v === ALL_DAY;

const splitStart = (v) => { const str = String(v || ''); return { date: str.slice(0, 10), time: str.slice(11, 16) }; };
const joinStart = (date, time) => (date ? `${date}T${time || DEFAULT_START_TIME}` : '');
const addMinutes = (start, mins) => {
  const d = parseInput(start);
  return d && mins ? asInput(new Date(d.getTime() + mins * 60000)) : '';
};
// Shown under the duration so the end is visible without being editable.
const endPreview = (start, mins) => {
  if (isAllDay(mins)) return start ? "Runs that day's opening hours" : '';
  const end = addMinutes(start, mins);
  if (!end) return '';
  const s = splitStart(start), e = splitStart(end);
  const label = HALF_HOURS.find((x) => x.value === e.time)?.label ?? e.time;
  return `Ends ${label}${e.date === s.date ? '' : ' the next day'}`;
};

/**
 * Duration of a stored event, for showing an existing one in a duration
 * control. Returns null rather than a default when the pair is unusable, so a
 * caller must decide what to do instead of silently writing 3 hours over
 * whatever was there.
 */
export function minutesBetween(start, end) {
  const s = parseInput(start), e = parseInput(end);
  if (!s || !e) return null;
  const m = Math.round((e.getTime() - s.getTime()) / 60000);
  return m > 0 ? m : null;
}

/** Does this duration have an exact option in the dropdown? */
export const hasExactOption = (mins) => DURATIONS.some((d) => d.value === mins);

export {
  pad2, parseInput, asInput, shiftEnd, dateRangeError, ALL_DAY, isAllDay,
  DEFAULT_START_TIME, DEFAULT_DURATION_MIN, HALF_HOURS, durLabel, DURATIONS,
  splitStart, joinStart, addMinutes, endPreview,
};
