import React, { useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { areasFor, layoutsFor, seatingsFor, MODES } from './reservationsExample';
import { TableShape } from './reservationsTableShape';

/**
 * Reservations → Floor.
 *
 * The service view: one room, one day, under whichever layout that day's offer
 * calls for. Tables are drawn from the venue's own table list and coloured by
 * their mode in the selected layout, so switching layout re-reads the same
 * tables instead of showing a different set of them.
 *
 * Drawn the way ResOS draws it, because staff already read this shape: green
 * rounded tables with grey seats tucked behind them, on a dark canvas, under a
 * fifteen-minute ruler. A round table in ResOS is still a rounded SQUARE — the
 * seats around it are what say how many it takes — so that is what this draws.
 */

const STATUS_LABEL = {
  arrived: 'Seated',
  approved: 'Expected',
  request: 'Requested',
  left: 'Left',
};

const today = () => new Date().toISOString().slice(0, 10);

// Example service window. The real one comes from kindred_web.hours for the
// venue, and from hours_special on a date that overrides them.
const RULER_FROM = 10 * 60;
const RULER_TO = 22 * 60;
const OPEN_FROM = 12 * 60;
const OPEN_TO = 20 * 60;

const hhmm = (mins) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`;
};

function Table({ t }) {
  const booked = Boolean(t.seating);
  const mode = t.mode === 'held' ? 'held' : booked ? 'booked' : t.mode;
  return (
    <g transform={`translate(${t.x} ${t.y})${t.rot ? ` rotate(${t.rot})` : ''}`}>
      <TableShape seats={t.seatsMax || 4} name={t.name} mode={mode}>
        {booked && (
          <>
            <text x="0" y="12" textAnchor="middle" fontSize="11" fill="#ffffff">
              {t.seating.name}
            </text>
            <text x="0" y="25" textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.8)">
              {t.seating.party} · {t.seating.time}
            </text>
          </>
        )}
      </TableShape>
    </g>
  );
}

export default function ReservationsFloor() {
  const { venue } = useOutletContext() || {};
  const [date, setDate] = useState(today);

  const layouts = useMemo(() => layoutsFor(venue), [venue]);
  const [layoutId, setLayoutId] = useState('');
  const layout = layouts.find((l) => l.id === layoutId) || layouts[0];

  const areas = useMemo(() => areasFor(venue), [venue]);
  const seatings = useMemo(() => seatingsFor(venue), [venue]);
  const byTable = useMemo(
    () => Object.fromEntries(seatings.filter((s) => s.tableId).map((s) => [s.tableId, s])),
    [seatings],
  );

  const slots = useMemo(() => {
    const out = [];
    for (let m = RULER_FROM; m < RULER_TO; m += 15) {
      out.push({ m, label: hhmm(m), open: m >= OPEN_FROM && m < OPEN_TO, hour: m % 60 === 0 });
    }
    return out;
  }, []);

  if (!venue || !layout) return <p className="rs-empty">Pick a venue to see its floor.</p>;

  const counts = { seated: 0, open: 0, standing: 0, held: 0 };
  const drawn = [];
  for (const area of areas) {
    for (const t of area.tables) {
      const mode = layout.modes?.[t.id];
      if (!mode) continue;
      counts[mode] = (counts[mode] || 0) + 1;
      const move = layout.moves?.[t.id];
      drawn.push({ ...t, ...(move || {}), areaName: area.name, mode, seating: byTable[t.id] });
    }
  }

  const seatsAvailable = drawn
    .filter((t) => t.mode === 'seated' || t.mode === 'open')
    .reduce((n, t) => n + t.seatsMax, 0);

  const [y, mo, da] = date.split('-').map(Number);
  const pretty = new Date(y, mo - 1, da).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  return (
    <>
      <p className="rs-stub">
        <strong>Not wired up.</strong>
        Tables, layout and the day&apos;s seatings are example data — the real floor comes from
        the venue&apos;s table list and whichever booking source the venue is set to.
      </p>

      <div className="rs-controls">
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Layout
          <select value={layout.id} onChange={(e) => setLayoutId(e.target.value)}>
            {layouts.map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.isDefault ? ' (default)' : ''}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="rs-panel">
        <div className="rs-daybar">
          <h2>{pretty}</h2>
          <span className="rs-status open">Open</span>
          <span className="rs-daybar-right rs-panel-sub">
            {venue.name} — {layout.name}
          </span>
        </div>

        <div className="rs-ruler-wrap">
          <div className="rs-ruler">
            {slots.map((s) => (
              <div key={s.m}
                   className={`rs-slot${s.open ? ' open' : ''}${s.hour ? ' hour' : ''}`}>
                {s.label}
              </div>
            ))}
          </div>
        </div>

        <div className="rs-floor">
          <svg viewBox="0 0 820 820" role="img"
               aria-label={`${venue.name} floor under the ${layout.name} layout`}>
            <defs>
              <pattern id="rs-hatch" width="10" height="10" patternTransform="rotate(45)"
                       patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="10" stroke="var(--rs-canvas-edge)"
                      strokeWidth="2" />
              </pattern>
            </defs>

            {layout.standingCapacity > 0 && (
              <>
                <rect x="40" y="60" width="700" height="330" rx="8" fill="url(#rs-hatch)"
                      stroke="var(--rs-canvas-edge)" strokeWidth="2" />
                <text x="390" y="210" textAnchor="middle" fontSize="24" fontWeight="600"
                      letterSpacing="4" fill="var(--rs-on-canvas-muted)">STANDING</text>
                <text x="390" y="252" textAnchor="middle" fontSize="32"
                      fill="var(--rs-on-canvas)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {layout.standingCapacity}
                </text>
              </>
            )}

            {drawn.map((t) => <Table key={t.id} t={t} />)}
          </svg>
        </div>

        <p className="rs-floor-meta">
          <span>{counts.seated} seated</span>
          {counts.open > 0 && <span>{counts.open} open</span>}
          {layout.standingCapacity > 0 && <span>{layout.standingCapacity} standing</span>}
          {counts.held > 0 && <span>{counts.held} held</span>}
          <span>{seatsAvailable} seats on the floor</span>
          {layout.changeoverMinutes > 0 && (
            <span>{layout.changeoverMinutes} min changeover — last seating ends that far before doors</span>
          )}
        </p>
      </div>

      <div className="rs-panel">
        <div className="rs-panel-head">
          <h2>The day</h2>
          <span className="rs-panel-sub">{seatings.length} bookings</span>
        </div>
        <div className="rs-table-wrap">
          <table className="rs-table">
            <thead>
              <tr>
                <th>Time</th><th>Name</th><th>People</th><th>Table(s)</th>
                <th>Status</th><th>Club</th>
              </tr>
            </thead>
            <tbody>
              {seatings.map((s) => {
                const t = drawn.find((d) => d.id === s.tableId);
                return (
                  <tr key={s.id}>
                    <td className="rs-num">{s.time}</td>
                    <td>{s.name}</td>
                    <td className="rs-num">{s.party}</td>
                    <td>{t ? `${t.areaName} ${t.name}` : '—'}</td>
                    <td>{STATUS_LABEL[s.status] || s.status}</td>
                    <td>{s.club || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rs-legend">
        {Object.entries(MODES).map(([k, m]) => (
          <span key={k}><span className={`rs-pill ${k}`}>{m.label}</span> {m.hint}</span>
        ))}
      </div>
    </>
  );
}
