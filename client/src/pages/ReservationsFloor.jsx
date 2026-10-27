import React, { useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { areasFor, layoutsFor, seatingsFor, MODES } from './reservationsExample';

/**
 * Reservations → Floor.
 *
 * The service view: one room, one day, under whichever layout that day's offer
 * calls for. Tables are drawn from the venue's own table list and coloured by
 * their mode in the selected layout, so switching layout re-reads the same
 * tables instead of showing a different set of them.
 */

const STATUS_LABEL = {
  arrived: 'Seated',
  approved: 'Expected',
  request: 'Requested',
  left: 'Left',
};

const today = () => new Date().toISOString().slice(0, 10);

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
        <div className="rs-panel-head">
          <div>
            <h2>{venue.name} — {layout.name}</h2>
            <p className="rs-panel-sub">{layout.note}</p>
          </div>
        </div>

        <div className="rs-floor">
          <svg viewBox="0 0 820 820" role="img"
               aria-label={`${venue.name} floor under the ${layout.name} layout`}>
            <defs>
              <pattern id="rs-hatch" width="10" height="10" patternTransform="rotate(45)"
                       patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="10" stroke="var(--border-strong, var(--border))"
                      strokeWidth="1.5" />
              </pattern>
            </defs>

            <rect x="8" y="8" width="804" height="804" rx="6" fill="none"
                  stroke="var(--border)" strokeWidth="2" />

            {layout.standingCapacity > 0 && (
              <>
                <rect x="40" y="60" width="700" height="330" fill="url(#rs-hatch)"
                      stroke="var(--border-strong, var(--border))" strokeWidth="2" />
                <text x="390" y="210" textAnchor="middle" fontSize="26" fontWeight="600"
                      fill="var(--text-muted)">STANDING</text>
                <text x="390" y="250" textAnchor="middle" fontSize="30"
                      fill="var(--text)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {layout.standingCapacity}
                </text>
              </>
            )}

            {drawn.map((t) => {
              const booked = Boolean(t.seating);
              const held = t.mode === 'held';
              const fill = held ? 'none'
                : booked ? 'var(--accent-soft)'
                : t.mode === 'open' ? 'var(--primary-soft)'
                : 'var(--card)';
              const stroke = held ? 'var(--border)'
                : booked ? 'var(--primary)'
                : 'var(--border-strong, var(--border))';
              const r = held ? 22 : t.radius;
              return (
                <g key={t.id}>
                  <circle cx={t.x} cy={t.y} r={r} fill={fill} stroke={stroke} strokeWidth="2.5"
                          strokeDasharray={held ? '6 5' : undefined} />
                  <text x={t.x} y={t.y + (booked ? -6 : 5)} textAnchor="middle"
                        fontSize={held ? 13 : 15} fontWeight="600"
                        fill={held ? 'var(--text-muted)' : 'var(--text)'}>
                    {t.name}
                  </text>
                  {booked && (
                    <>
                      <text x={t.x} y={t.y + 10} textAnchor="middle" fontSize="12"
                            fill="var(--text)">{t.seating.name}</text>
                      <text x={t.x} y={t.y + 24} textAnchor="middle" fontSize="11"
                            fill="var(--text-muted)">{t.seating.party} · {t.seating.time}</text>
                    </>
                  )}
                </g>
              );
            })}
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
                <th>Time</th><th>Guest</th><th>Party</th><th>Table</th><th>Status</th><th>Club</th>
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
