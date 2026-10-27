import React, { useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { areasFor } from './reservationsExample';

/**
 * Reservations → Areas & Tables.
 *
 * The venue's durable catalogue: the areas it has and the tables in them. This
 * is the list every layout arranges, so a table's identity lives here and not
 * in any one arrangement — which is what lets a booking survive a layout being
 * re-saved.
 *
 * Both venues are managed from here. Switching the venue in the header is the
 * whole mechanism; there is no Creek login.
 */

export default function ReservationsTables() {
  const { venue, venues } = useOutletContext() || {};
  const areas = useMemo(() => areasFor(venue), [venue]);

  if (!venue) return <p className="rs-empty">Pick a venue to see its areas and tables.</p>;

  const other = (venues || []).filter((v) => v.id !== venue.id);
  const totalTables = areas.reduce((n, a) => n + a.tables.length, 0);
  const totalSeats = areas.reduce(
    (n, a) => n + a.tables.reduce((m, t) => m + t.seatsMax, 0), 0,
  );

  return (
    <>
      <p className="rs-stub">
        <strong>Not wired up.</strong>
        Example areas and tables. The real ones carry a venue-level id of their own, so they
        stop depending on a ResOS table id to stay identifiable.
      </p>

      <div className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h2>{venue.name}</h2>
            <p className="rs-panel-sub">
              {areas.length} areas · {totalTables} tables · {totalSeats} seats at maximum.
              {other.length > 0 && (
                <> Managing {other.map((v) => v.name).join(' and ')} is the venue picker above,
                not a different sign-in.</>
              )}
            </p>
          </div>
          <button type="button" className="rs-btn primary" disabled>New area</button>
        </div>

        {areas.map((area) => (
          <div key={area.id} className="rs-panel" style={{ margin: '0 0 0.85rem' }}>
            <div className="rs-panel-head">
              <div>
                <h2>{area.name}</h2>
                <p className="rs-panel-sub">
                  {area.tables.length} tables · priority {area.priority} ·{' '}
                  {area.bookableOnline
                    ? 'offered online'
                    : 'staff booking only — guests are never seated here from the website'}
                </p>
              </div>
              <button type="button" className="rs-btn" disabled>Add table</button>
            </div>
            <div className="rs-table-wrap">
              <table className="rs-table">
                <thead>
                  <tr><th>Table</th><th>Shape</th><th>Seats</th><th>Position</th><th /></tr>
                </thead>
                <tbody>
                  {area.tables.map((t) => (
                    <tr key={t.id}>
                      <td><strong>{t.name}</strong></td>
                      <td>{t.shape}</td>
                      <td className="rs-num">{t.seatsMin}–{t.seatsMax}</td>
                      <td className="rs-num">{t.x}, {t.y}</td>
                      <td><button type="button" className="rs-btn" disabled>Edit</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <div className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h2>Why seats and areas sit here</h2>
            <p className="rs-panel-sub">
              A table&apos;s minimum and maximum belong to the table, not to a layout: a
              six-top is a six-top whichever arrangement the room is in. An area carries the
              booking priority and whether guests can be seated there from the website, which
              is how the patios stay staff-only without being taken out of the room.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
