import React from 'react';

/**
 * How a table is drawn, in one place.
 *
 * ResOS draws a table as a rounded rectangle with its seats as grey ellipses
 * tucked behind it — a "round" four-top is a rounded SQUARE, and the seats
 * around it are what say how many it takes. The floor and the table catalogue
 * both draw from here so the room and the list can never disagree about what
 * a six-top looks like.
 */

/** A table's box and seat positions, derived from the number it seats. */
export function geometry(seats) {
  if (seats <= 4) {
    const half = 32;
    const spots = [[0, -half], [half, 0], [0, half], [-half, 0]].slice(0, Math.max(seats, 1));
    return { w: 64, h: 64, spots };
  }
  // More than four sits down the two long sides, as a real long table does.
  const perSide = Math.ceil(seats / 2);
  const w = perSide * 44 + 12;
  const h = 58;
  const spots = [];
  for (let i = 0; i < perSide; i += 1) {
    const x = -w / 2 + 22 + i * 44;
    spots.push([x, -h / 2]);
    if (spots.length < seats) spots.push([x, h / 2]);
  }
  return { w, h, spots: spots.slice(0, seats) };
}

export const MODE_FILL = {
  seated: 'var(--rs-table)',
  open: 'var(--rs-table-open)',
  held: 'var(--rs-table-held)',
  booked: 'var(--rs-table-booked)',
};

/**
 * The table itself — seats first so the top overlaps them, as ResOS has it.
 * Used full size on the floor and shrunk to a row glyph in the catalogue.
 */
export function TableShape({ seats, name, mode = 'seated', label = true, children }) {
  const { w, h, spots } = geometry(seats);
  const held = mode === 'held';
  return (
    <>
      {spots.map(([sx, sy], i) => (
        <ellipse key={i} cx={sx} cy={sy} rx="15" ry="13"
                 fill="var(--rs-seat)" opacity={held ? 0.35 : 0.85} />
      ))}
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx="8"
            fill={MODE_FILL[mode] || MODE_FILL.seated}
            stroke={held ? 'var(--rs-canvas-edge)' : 'none'}
            strokeWidth="2" strokeDasharray={held ? '6 5' : undefined} />
      {label && (
        <text x="0" y={children ? -4 : 5} textAnchor="middle"
              fontSize="15" fontStyle="italic" fontWeight="500"
              fill={held ? 'var(--rs-on-canvas-muted)' : '#ffffff'}>
          {name}
        </text>
      )}
      {children}
    </>
  );
}

/**
 * A table on its own, sized to sit in a table row. The dark plate is kept —
 * the green only reads against it, and it makes the catalogue and the floor
 * obviously the same objects.
 */
export function TableGlyph({ seats, name, mode = 'seated', height = 40 }) {
  const { w, h } = geometry(seats);
  const pad = 18;
  const vw = w + pad * 2;
  const vh = h + pad * 2;
  return (
    <svg className="rs-glyph" height={height} width={(vw / vh) * height}
         viewBox={`${-vw / 2} ${-vh / 2} ${vw} ${vh}`} role="img"
         aria-label={`Table ${name}, seats ${seats}`}>
      <TableShape seats={seats} name={name} mode={mode} />
    </svg>
  );
}
