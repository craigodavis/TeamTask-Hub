/**
 * Example data for the Reservations screens that are not wired up yet.
 *
 * Shaped to match what the real tables will hold, so the screens show the
 * right structure while they are still shells:
 *
 *   area     -> a physical space in a venue
 *   table    -> a durable table, owned by the area, identity stable across layouts
 *   layout   -> a named arrangement: a mode per table, plus standing capacity
 *   offer    -> something bookable: a layout, a time rule, a price
 *
 * Modes: seated (assignable), open (counts to a seat pool), standing (headcount
 * against the layout's floor capacity), held (there, deliberately not for sale).
 * A table simply left out of a layout is absent from it.
 *
 * Nothing here is written anywhere. Replace each export with its query.
 */

export const MODES = {
  seated:   { label: 'Seated',   hint: 'Assignable table' },
  open:     { label: 'Open',     hint: 'Counts to a seat pool' },
  standing: { label: 'Standing', hint: 'Headcount on the floor' },
  held:     { label: 'Held',     hint: 'There, not for sale' },
};

const isCreek = (venue) => /creek/i.test(venue?.name || venue?.venue || '');

// A row of round tables, laid out left to right. Positions are the same
// numbers room_layout_tables already stores: logical pixels in the room.
function row(prefix, count, startNo, y, seats) {
  const gap = 760 / (count + 1);
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${startNo + i}`,
    name: `${startNo + i}`,
    shape: 'circle',
    x: Math.round(gap * (i + 1)),
    y,
    radius: 34,
    seatsMin: 2,
    seatsMax: seats,
  }));
}

function wineryAreas() {
  return [
    {
      id: 'win-indoor',
      name: 'Indoor Tasting',
      bookableOnline: true,
      priority: 1,
      tables: [...row('t', 4, 1, 90, 6), ...row('t', 4, 5, 230, 6), ...row('t', 4, 9, 370, 4)],
    },
    {
      id: 'win-patio',
      name: 'Patio',
      bookableOnline: false,
      priority: 2,
      tables: [...row('p', 4, 21, 520, 6), ...row('p', 3, 25, 640, 4)],
    },
  ];
}

function creekAreas() {
  return [
    {
      id: 'crk-inside',
      name: 'Inside',
      bookableOnline: true,
      priority: 1,
      tables: [...row('c', 4, 1, 90, 6), ...row('c', 4, 5, 230, 4), ...row('c', 4, 9, 370, 4)],
    },
    {
      id: 'crk-firepit',
      name: 'Firepit Patio',
      bookableOnline: false,
      priority: 2,
      tables: [...row('f', 7, 21, 520, 8), ...row('f', 7, 28, 630, 6)],
    },
    {
      id: 'crk-front',
      name: 'Front Patio',
      bookableOnline: false,
      priority: 3,
      tables: row('n', 4, 41, 740, 4),
    },
  ];
}

export function areasFor(venue) {
  return isCreek(venue) ? creekAreas() : wineryAreas();
}

export function allTables(venue) {
  return areasFor(venue).flatMap((a) => a.tables.map((t) => ({ ...t, areaId: a.id, areaName: a.name })));
}

/**
 * Layouts for a venue. `modes` maps a table id to its mode in this layout;
 * anything missing is absent. `moves` nudges a table to a different spot for
 * this arrangement only, the way room_layout_tables already stores geometry
 * per layout.
 */
export function layoutsFor(venue) {
  const tables = allTables(venue);
  const everythingSeated = Object.fromEntries(tables.map((t) => [t.id, 'seated']));

  if (isCreek(venue)) {
    const inside = tables.filter((t) => t.areaId === 'crk-inside');
    return [
      {
        id: 'crk-standard', name: 'Standard', isDefault: true,
        standingCapacity: 0, changeoverMinutes: 0,
        modes: everythingSeated,
        note: 'Every day the Creek is open for tastings.',
      },
      {
        id: 'crk-music', name: 'Thursday Live Music',
        standingCapacity: 60, changeoverMinutes: 20,
        modes: {
          ...everythingSeated,
          ...Object.fromEntries(inside.slice(4).map((t) => [t.id, 'held'])),
        },
        note: 'Inside opens up for the band; the patios keep their tables.',
      },
    ];
  }

  const indoor = tables.filter((t) => t.areaId === 'win-indoor');
  const patio  = tables.filter((t) => t.areaId === 'win-patio');

  return [
    {
      id: 'win-standard', name: 'Standard', isDefault: true,
      standingCapacity: 0, changeoverMinutes: 0,
      modes: everythingSeated,
      note: 'Regular tasting service.',
    },
    {
      id: 'win-dance', name: 'Dance Floor',
      standingCapacity: 80, changeoverMinutes: 30,
      modes: {
        ...Object.fromEntries(indoor.slice(0, 8).map((t) => [t.id, 'held'])),
        ...Object.fromEntries(indoor.slice(8).map((t) => [t.id, 'seated'])),
        ...Object.fromEntries(patio.map((t) => [t.id, 'seated'])),
      },
      moves: Object.fromEntries(indoor.slice(0, 8).map((t, i) => [t.id, { x: 70 + i * 92, y: 440 }])),
      note: 'Middle of the room cleared, eight tables to the wall, four high-tops kept.',
    },
    {
      id: 'win-harvest', name: 'Harvest Long Tables',
      standingCapacity: 0, changeoverMinutes: 45, openSeats: 40,
      modes: {
        ...Object.fromEntries(indoor.map((t) => [t.id, 'held'])),
        ...Object.fromEntries(patio.map((t) => [t.id, 'open'])),
      },
      note: 'Banquet seating on the patio. Replaces the 25 pseudo-tables in ResOS.',
    },
  ];
}

export function offersFor(venue) {
  const creek = isCreek(venue);
  const layouts = layoutsFor(venue);
  const byName = (n) => layouts.find((l) => l.name === n);

  if (creek) {
    return [
      {
        id: 'crk-tasting', name: 'Tasting', kind: 'Regular service',
        when: 'Weekly, from the venue hours', layout: byName('Standard'),
        party: '2–8', price: null, visibility: 'Always', slug: 'book/creek',
        mode: 'resos',
      },
      {
        id: 'crk-thursday', name: 'Thursdays at the Creek', kind: 'Event',
        when: 'Thursdays, 6–9 PM', layout: byName('Thursday Live Music'),
        party: '1–10', price: null, visibility: 'Public, dated', slug: 'book/creek/thursdays',
        mode: 'resos',
      },
    ];
  }

  return [
    {
      id: 'win-tasting', name: 'Tasting', kind: 'Regular service',
      when: 'Weekly, from the venue hours', layout: byName('Standard'),
      party: '2–6', price: null, visibility: 'Always', slug: 'book/estate',
      mode: 'resos',
    },
    {
      id: 'win-groove', name: "70's & 80's Groove Party", kind: 'Experience',
      when: 'One date, 7–10 PM', layout: byName('Dance Floor'),
      party: '1–8', price: '$30 public · $20 club', visibility: 'Public, dated',
      slug: 'book/estate/70s-80s', mode: 'resos',
    },
    {
      id: 'win-harvest', name: 'Harvest Dinner', kind: 'Event',
      when: 'One date, one seating', layout: byName('Harvest Long Tables'),
      party: '2–10', price: 'Flat, deposit', visibility: 'Public, dated',
      slug: 'book/estate/harvest-dinner', mode: 'resos',
    },
    {
      id: 'win-buyout', name: 'Private Buyout', kind: 'Private',
      when: 'One date, all day', layout: byName('Harvest Long Tables'),
      party: '25+', price: 'Contract', visibility: 'Never — staff only',
      slug: null, mode: 'resos',
    },
  ];
}

/** A plausible service day, so the floor screen shows seated tables. */
export function seatingsFor(venue) {
  const tables = allTables(venue);
  const pick = (i) => tables[i]?.id;
  return [
    { id: 's1', tableId: pick(0), name: 'Whitfield',  party: 4, time: '14:00', status: 'arrived', club: 'Voyager' },
    { id: 's2', tableId: pick(2), name: 'Ortega',     party: 2, time: '14:30', status: 'arrived', club: null },
    { id: 's3', tableId: pick(5), name: 'Bruhn',      party: 6, time: '15:00', status: 'approved', club: 'Club 77' },
    { id: 's4', tableId: pick(9), name: 'Kaplan',     party: 2, time: '15:30', status: 'approved', club: null },
    { id: 's5', tableId: pick(10), name: 'Osei',      party: 3, time: '16:00', status: 'request', club: null },
  ];
}
