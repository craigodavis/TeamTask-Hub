/**
 * Is a venue free for a private event, and if not, is the other one?
 *
 * Checked against both kinds of thing that occupy a venue: our own public events
 * (music nights, Oktoberfest) and private bookings already taken. A private party
 * booked over Hot August Nights is not a double booking the calendar can absorb —
 * the space is already full of other people's guests.
 *
 * TIMES. Events store wall-clock time as UTC: "Thursdays at the Creek, 6:30–8:30 PM"
 * is stored as 18:30Z. So the comparison uses (start_at AT TIME ZONE 'UTC')::time.
 * Using ::time directly reads 12:30 — six hours out, and every check would pass.
 * That failure is invisible: nothing errors, clashes simply stop being found.
 */
import { query } from '../db.js';

/** Overlap, exclusive at the joins: an event ending at 6 does not block one at 6. */
const OVERLAPS = `($3::time, $4::time) OVERLAPS`;

async function clashesAt(locationId, date, startTime, endTime, exceptRequestId) {
  const events = (await query(
    `SELECT e.title, (e.start_at AT TIME ZONE 'UTC')::time AS starts,
            (e.end_at   AT TIME ZONE 'UTC')::time AS ends
       FROM events e
      WHERE e.location_id = $1
        AND (e.start_at AT TIME ZONE 'UTC')::date = $2::date
        AND COALESCE(e.status, '') NOT IN ('cancelled', 'withdrawn')
        AND ${OVERLAPS} ((e.start_at AT TIME ZONE 'UTC')::time,
                         (e.end_at   AT TIME ZONE 'UTC')::time)`,
    [locationId, date, startTime, endTime])).rows;

  const bookings = (await query(
    `SELECT r.first_name, r.last_name, r.start_time AS starts, r.end_time AS ends
       FROM kindred_web.event_requests r
      WHERE r.location_id = $1
        AND r.event_date = $2::date
        AND r.status NOT IN ('declined', 'withdrawn')
        AND r.start_time IS NOT NULL AND r.end_time IS NOT NULL
        AND ($5::uuid IS NULL OR r.id <> $5::uuid)
        AND ${OVERLAPS} (r.start_time, r.end_time)`,
    [locationId, date, startTime, endTime, exceptRequestId || null])).rows;

  return [
    ...events.map((e) => ({ kind: 'event', title: e.title,
      starts: String(e.starts).slice(0, 5), ends: String(e.ends).slice(0, 5) })),
    // Never the customer's name: this answer is public, and who else has booked the
    // Creek that Saturday is not a thing an enquirer gets to find out.
    ...bookings.map((b) => ({ kind: 'booking', title: 'A private event',
      starts: String(b.starts).slice(0, 5), ends: String(b.ends).slice(0, 5) })),
  ];
}

/**
 * The answer the form needs: can we take this, and if not, where else.
 *
 * The suggestion is only offered when the other venue is genuinely free for the same
 * window. Suggesting a date that turns out to be taken too is worse than saying no,
 * because it spends the enquirer's goodwill twice.
 */
export async function venueAvailability(companyId, opts) {
  const { locationId, date, startTime, endTime, exceptRequestId } = opts;
  if (!locationId || !date || !startTime || !endTime) {
    return { known: false, available: true, clashes: [], alternative: null };
  }

  const clashes = await clashesAt(locationId, date, startTime, endTime, exceptRequestId);
  if (!clashes.length) return { known: true, available: true, clashes: [], alternative: null };

  const others = (await query(
    `SELECT id, name, web_slug FROM locations
      WHERE company_id = $1 AND web_slug IS NOT NULL AND id <> $2`,
    [companyId, locationId])).rows;

  let alternative = null;
  for (const o of others) {
    const c = await clashesAt(o.id, date, startTime, endTime, exceptRequestId);
    if (!c.length) { alternative = { venue: o.web_slug, name: o.name }; break; }
  }

  return { known: true, available: false, clashes, alternative };
}
