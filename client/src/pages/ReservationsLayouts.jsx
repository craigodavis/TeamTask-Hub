import React, { useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { layoutsFor, allTables, offersFor, MODES } from './reservationsExample';

/**
 * Reservations → Layouts.
 *
 * A layout is not a second floor plan. It is a set of modes over the venue's
 * one table list, plus a standing capacity and the minutes it takes to get the
 * room into this arrangement. That is why re-saving a layout cannot orphan a
 * booking, and why Table 7 is recognisably Table 7 in all of them.
 */

export default function ReservationsLayouts() {
  const { venue } = useOutletContext() || {};
  const layouts = useMemo(() => layoutsFor(venue), [venue]);
  const tables = useMemo(() => allTables(venue), [venue]);
  const offers = useMemo(() => offersFor(venue), [venue]);

  if (!venue) return <p className="rs-empty">Pick a venue to see its layouts.</p>;

  return (
    <>
      <p className="rs-stub">
        <strong>Not wired up.</strong>
        Reads and writes land on the venue&apos;s layout records; the mode column is the part
        that does not exist yet.
      </p>

      <div className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h2>{venue.name} layouts</h2>
            <p className="rs-panel-sub">
              {tables.length} tables in this venue. Every layout arranges those same tables —
              a table left out of a layout is simply absent from it.
            </p>
          </div>
          <button type="button" className="rs-btn primary" disabled>New layout</button>
        </div>

        <div className="rs-table-wrap">
          <table className="rs-table">
            <thead>
              <tr>
                <th>Layout</th><th>Seated</th><th>Open</th><th>Standing</th><th>Held</th>
                <th>Absent</th><th>Changeover</th><th>Used by</th>
              </tr>
            </thead>
            <tbody>
              {layouts.map((l) => {
                const modes = l.modes || {};
                const n = (m) => Object.values(modes).filter((v) => v === m).length;
                const absent = tables.length - Object.keys(modes).length;
                const used = offers.filter((o) => o.layout?.id === l.id);
                return (
                  <tr key={l.id}>
                    <td>
                      <strong>{l.name}</strong>
                      {l.isDefault && <> <span className="rs-pill open">default</span></>}
                      <div className="rs-panel-sub">{l.note}</div>
                    </td>
                    <td className="rs-num">{n('seated')}</td>
                    <td className="rs-num">{l.openSeats ? `${n('open')} (${l.openSeats} seats)` : n('open')}</td>
                    <td className="rs-num">{l.standingCapacity || '—'}</td>
                    <td className="rs-num">{n('held') || '—'}</td>
                    <td className="rs-num">{absent || '—'}</td>
                    <td className="rs-num">{l.changeoverMinutes ? `${l.changeoverMinutes} min` : '—'}</td>
                    <td>{used.length ? used.map((o) => o.name).join(', ') : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="rs-legend">
          {Object.entries(MODES).map(([k, m]) => (
            <span key={k}><span className={`rs-pill ${k}`}>{m.label}</span> {m.hint}</span>
          ))}
        </div>
      </div>

      <div className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h2>Table modes</h2>
            <p className="rs-panel-sub">
              One row per table, one column per layout. This grid is the whole editor —
              the drawing stays where it is.
            </p>
          </div>
        </div>
        <div className="rs-table-wrap">
          <table className="rs-table">
            <thead>
              <tr>
                <th>Area</th><th>Table</th><th>Seats</th>
                {layouts.map((l) => <th key={l.id}>{l.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.id}>
                  <td>{t.areaName}</td>
                  <td><strong>{t.name}</strong></td>
                  <td className="rs-num">{t.seatsMin}–{t.seatsMax}</td>
                  {layouts.map((l) => {
                    const m = l.modes?.[t.id];
                    return (
                      <td key={l.id}>
                        {m
                          ? <span className={`rs-pill ${m}`}>{MODES[m].label}</span>
                          : <span className="rs-panel-sub">absent</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
