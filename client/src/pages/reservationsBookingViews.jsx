import React, { useMemo } from 'react';
import { areasFor } from './reservationsExample';
import { iso, parseISO } from './reservationsDateNav';

/**
 * The Calendar and Schedule views of Bookings.
 *
 * ResOS shows the same bookings three ways — a month of counts, a day against
 * the tables, and a list — and every one of them is driven by the same date
 * control. These two are the ones TeamHub did not have.
 *
 * Calendar runs on real bookings: the month's counts are the ones ResOS
 * returns. Schedule can only draw the grid, because /api/reservations does not
 * return which table a booking is on — ResOS owns that and does not hand it
 * over. Rather than invent an assignment, the day's real bookings sit in an
 * unassigned lane above the tables, which is an honest picture of exactly what
 * we have and what is still missing.
 */

const MINUTES = (t) => {
  const [h, m] = (t || '0:0').split(':').map(Number);
  return h * 60 + (m || 0);
};

/* ── Calendar ────────────────────────────────────────────────────────────── */

export function CalendarView({ anchor, bookings, onPickDay }) {
  const cells = useMemo(() => {
    const d = parseISO(anchor);
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay()); // back up to the Sunday

    const byDay = {};
    for (const b of bookings) {
      if (!b.date) continue;
      const slot = (byDay[b.date] ||= { bookings: 0, people: 0 });
      slot.bookings += 1;
      slot.people += Number(b.people) || 0;
    }

    return Array.from({ length: 42 }, (_, i) => {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = iso(day);
      return {
        key,
        n: day.getDate(),
        inMonth: day.getMonth() === d.getMonth(),
        isToday: key === iso(new Date()),
        ...(byDay[key] || { bookings: 0, people: 0 }),
      };
    });
  }, [anchor, bookings]);

  // A trailing week that is entirely next month is noise, so drop it.
  const weeks = [];
  for (let i = 0; i < 42; i += 7) weeks.push(cells.slice(i, i + 7));
  while (weeks.length > 4 && weeks[weeks.length - 1].every((c) => !c.inMonth)) weeks.pop();

  return (
    <div className="rs-cal">
      <div className="rs-cal-head">
        {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
          .map((d) => <div key={d}>{d}</div>)}
      </div>
      {weeks.map((week, wi) => (
        <div className="rs-cal-week" key={wi}>
          {week.map((c) => (
            <button type="button" key={c.key}
                    className={`rs-cal-day${c.inMonth ? '' : ' out'}${c.bookings ? ' has' : ''}`}
                    onClick={() => onPickDay?.(c.key)}>
              <span className={`rs-cal-n${c.isToday ? ' today' : ''}`}>{c.n}</span>
              {c.bookings > 0 && (
                <>
                  <span className="rs-pill seated">{c.bookings} bookings</span>
                  <span className="rs-pill held">{c.people} people</span>
                </>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Schedule ────────────────────────────────────────────────────────────── */

const FROM = 10 * 60;
const TO = 22 * 60;
const STEP = 15;

export function ScheduleView({ venue, bookings }) {
  const areas = useMemo(() => areasFor(venue), [venue]);

  const slots = useMemo(() => {
    const out = [];
    for (let m = FROM; m < TO; m += STEP) out.push(m);
    return out;
  }, []);

  const placed = bookings
    .map((b) => ({ ...b, min: MINUTES(b.time) }))
    .filter((b) => b.min >= FROM && b.min < TO)
    .sort((a, b) => a.min - b.min);

  const col = (m) => ((m - FROM) / STEP) + 2; // +2: the row label is column 1

  return (
    <div className="rs-sched-wrap">
      <div className="rs-sched" style={{ '--rs-cols': slots.length }}>
        <div className="rs-sched-corner" />
        {slots.map((m) => (
          <div key={m} className={`rs-sched-time${m % 60 === 0 ? ' hour' : ''}`}>
            {m % 60 === 0 ? `${(Math.floor(m / 60) % 12) || 12}${m < 720 ? 'a' : 'p'}` : ''}
          </div>
        ))}

        {/* The real bookings for the day. ResOS keeps the table assignment, so
            they cannot be put on a row — they sit here instead of being faked. */}
        <div className="rs-sched-row-label unassigned">
          Booked<span>{placed.length} today</span>
        </div>
        {slots.map((m) => <div key={`u${m}`} className="rs-sched-cell" />)}
        {placed.map((b) => (
          <div key={b.id} className="rs-sched-block"
               style={{ gridColumn: `${col(b.min)} / span 6`, gridRow: 2 }}
               title={`${b.name} · ${b.people} · ${b.time}`}>
            {b.name} · {b.people}
          </div>
        ))}

        {areas.map((area) => (
          <React.Fragment key={area.id}>
            <div className="rs-sched-area">{area.name}</div>
            {slots.map((m) => <div key={`${area.id}-${m}`} className="rs-sched-cell area" />)}
            {area.tables.map((t) => (
              <React.Fragment key={t.id}>
                <div className="rs-sched-row-label">
                  {t.name}<span>{t.seatsMin}-{t.seatsMax}</span>
                </div>
                {slots.map((m) => (
                  <div key={`${t.id}-${m}`}
                       className={`rs-sched-cell${m % 60 === 0 ? ' hour' : ''}`} />
                ))}
              </React.Fragment>
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
