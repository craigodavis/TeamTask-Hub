import React, { useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { offersFor } from './reservationsExample';

/**
 * Reservations → Hours & Limits.
 *
 * ResOS calls these opening hours, and they are the piece TeamHub was missing
 * entirely. An opening hour there is not just a time: it is a named period
 * that carries which seating areas are open, how far apart the bookable times
 * are, how long a booking lasts, how many guests may be taken in the period
 * and per interval, whether it is prepaid, and which custom fields the guest
 * is asked. That bundle is what actually decides whether a slot is offered.
 *
 * The times themselves are NOT re-entered here. They come from the hours
 * TeamHub already keeps for the website (kindred_web.hours and hours_special),
 * which is what this screen lists. What is added on top is the reservation
 * layer — the settings above — so a change of hours is made once and this
 * follows it. Copying the times into a second table is exactly the double
 * entry the whole design is trying to avoid.
 *
 * Regular, Special and Experiences are ResOS's own three tabs, and they mean
 * what they mean there: a weekly rule, a dated override that can also close
 * the day, and a dated paid event.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TABS = [
  ['regular', 'Regular'],
  ['special', 'Special'],
  ['experiences', 'Experiences'],
];

const fmt = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

const fmtDate = (d) => {
  if (!d) return '';
  const [y, mo, da] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(y, mo - 1, da).toLocaleDateString('en-US', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
};

/** The settings a period carries once this is wired. None are stored yet. */
function Settings({ areas }) {
  return (
    <div className="rs-hours-settings">
      <span className="rs-pill held">Areas: {areas}</span>
      <span className="rs-pill held">Interval —</span>
      <span className="rs-pill held">Duration —</span>
      <span className="rs-pill held">Limits —</span>
    </div>
  );
}

export default function ReservationsHours() {
  const { venue } = useOutletContext() || {};
  const [tab, setTab] = useState('regular');

  const regular = useMemo(() => {
    const rows = venue?.regular || [];
    return [...rows].sort((a, b) => (a.day_of_week - b.day_of_week) || (a.sort - b.sort));
  }, [venue]);

  const specials = useMemo(() => venue?.specials || [], [venue]);
  const experiences = useMemo(
    () => offersFor(venue).filter((o) => o.price),
    [venue],
  );

  if (!venue) return <p className="rs-empty">Pick a venue to see its hours.</p>;

  return (
    <>
      <p className="rs-stub">
        <strong>Hours are real; the reservation settings are not wired up.</strong>
        The times below are the venue&apos;s actual hours, read from the same place the
        website reads them. What is missing is the layer on top — areas, interval,
        duration and limits — which is what decides whether a slot is offered at all.
      </p>

      <div className="rs-tabs rs-subtabs">
        {TABS.map(([k, l]) => (
          <button type="button" key={k} className={tab === k ? 'active' : ''}
                  onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'regular' && (
        <div className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h2>{venue.name} — weekly</h2>
              <p className="rs-panel-sub">
                {regular.length} periods. A day can hold more than one: a tasting
                window and an evening music set are two periods, not one long day,
                because they take different areas and different durations.
              </p>
            </div>
            <button type="button" className="rs-btn primary" disabled>+ Add period</button>
          </div>
          {regular.length === 0
            ? <p className="rs-empty">No weekly hours set for this venue.</p>
            : (
              <div className="rs-table-wrap">
                <table className="rs-table">
                  <thead>
                    <tr><th>Day</th><th>Time</th><th>Reservation settings</th><th /></tr>
                  </thead>
                  <tbody>
                    {regular.map((r) => (
                      <tr key={r.id}>
                        <td><strong>{DAYS[r.day_of_week] || '—'}</strong></td>
                        <td className="rs-num">{fmt(r.opens)} – {fmt(r.closes)}</td>
                        <td><Settings areas="not set" /></td>
                        <td><button type="button" className="rs-btn" disabled>Edit</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      {tab === 'special' && (
        <div className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h2>{venue.name} — dated</h2>
              <p className="rs-panel-sub">
                {specials.length} upcoming overrides. A dated period replaces the weekly
                one for that day, and a closed one takes the day off sale entirely —
                which is how a private buyout stops being bookable rather than merely
                being warned about.
              </p>
            </div>
            <button type="button" className="rs-btn primary" disabled>+ Add date</button>
          </div>
          {specials.length === 0
            ? <p className="rs-empty">No upcoming special hours.</p>
            : (
              <div className="rs-table-wrap">
                <table className="rs-table">
                  <thead>
                    <tr><th>Date</th><th>Status</th><th>Time</th><th>Reservation settings</th><th /></tr>
                  </thead>
                  <tbody>
                    {specials.map((s) => {
                      const closed = s.closed || (!s.opens && !s.closes);
                      return (
                        <tr key={s.id}>
                          <td><strong>{fmtDate(s.on_date)}</strong>
                            {s.note && <div className="rs-panel-sub">{s.note}</div>}</td>
                          <td>
                            <span className={`rs-status ${closed ? 'closed' : 'open'}`}>
                              {closed ? 'Closed' : 'Open'}
                            </span>
                          </td>
                          <td className="rs-num">
                            {closed ? '—' : `${fmt(s.opens)} – ${fmt(s.closes)}`}
                          </td>
                          <td>{closed ? <span className="rs-panel-sub">Not bookable</span>
                                      : <Settings areas="not set" />}</td>
                          <td><button type="button" className="rs-btn" disabled>Edit</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      {tab === 'experiences' && (
        <div className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h2>{venue.name} — experiences</h2>
              <p className="rs-panel-sub">
                A dated period with a price. Same record as an offer — this tab is the
                hours-shaped view of it, which is how ResOS presents the same thing.
              </p>
            </div>
            <button type="button" className="rs-btn primary" disabled>+ Add experience</button>
          </div>
          {experiences.length === 0
            ? <p className="rs-empty">No paid experiences for this venue.</p>
            : experiences.map((o) => (
              <div className="rs-offer" key={o.id}>
                <div className="rs-offer-plate">
                  <span>{o.name}</span>
                  <span className="rs-offer-price">{o.price}</span>
                </div>
                <div className="rs-offer-meta">
                  <span>{o.when}</span>
                  <span>{o.layout?.name || 'No layout'} · parties of {o.party}</span>
                  <span>Prepayment, interval and duration — not set</span>
                </div>
              </div>
            ))}
        </div>
      )}

      <div className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h2>What a period will carry</h2>
            <p className="rs-panel-sub">
              Taken from what ResOS actually stores against an opening hour, because
              these are the settings that decide what a guest is offered.
            </p>
          </div>
        </div>
        <div className="rs-kv">
          <div><span className="k">Areas</span>
            <span className="v">Which seating areas this period opens. An area left off is
              not bookable in this period, however many tables it holds.</span></div>
          <div><span className="k">Time interval</span>
            <span className="v">The gap between the times a guest is shown. 0:30 offers
              10:00, 10:30, 11:00.</span></div>
          <div><span className="k">Default duration</span>
            <span className="v">How long a booking holds the table, turnaround included.
              With it the last bookable slot is derived rather than entered — open 12:00,
              leave by 6:00, duration 1:30 means the last slot is 4:30.</span></div>
          <div><span className="k">Duration by party size</span>
            <span className="v">Optional rules: 1–3 people for 2 hours, 4 or more for 3.
              No rule matching falls back to the default.</span></div>
          <div><span className="k">Limits, for the period</span>
            <span className="v">Max bookings and max guests taken across the whole period.</span></div>
          <div><span className="k">Limits, per interval</span>
            <span className="v">Max bookings and max guests at any one time, so arrivals
              stay at a pace the room can actually handle.</span></div>
          <div><span className="k">Count online only</span>
            <span className="v">Whether staff-made bookings count against those limits.</span></div>
          <div><span className="k">Payment</span>
            <span className="v">Prepayment or a no-show fee, per guest or per booking, with
              a minimum party size and a cancellation window.</span></div>
          <div><span className="k">Fields</span>
            <span className="v">Which questions the guest is asked — the newsletter and wine
              club answers this section already exports.</span></div>
        </div>
      </div>
    </>
  );
}
