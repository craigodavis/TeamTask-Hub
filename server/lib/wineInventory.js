// Case size is fixed at 12 bottles for all wines. Kept in one place so
// case/bottle conversion never drifts between the entry form, the list
// response, and report totals.
export const CASE_SIZE = 12;

export function toTotalBottles(cases, bottles) {
  return (parseInt(cases, 10) || 0) * CASE_SIZE + (parseInt(bottles, 10) || 0);
}

export function fromTotalBottles(totalBottles) {
  const total = totalBottles || 0;
  return {
    cases: Math.floor(total / CASE_SIZE),
    bottles: total % CASE_SIZE,
  };
}

const GALLONS_PER_LITER = 0.264172;

// Commerce7 volume_format strings look like "750ml", "1L", "1.5L". Falls
// back to a standard 750ml bottle when missing or unparseable.
export function parseVolumeMl(format) {
  const s = String(format || '').trim().toLowerCase();
  const ml = s.match(/^([\d.]+)\s*ml$/);
  if (ml) return parseFloat(ml[1]);
  const l = s.match(/^([\d.]+)\s*l$/);
  if (l) return parseFloat(l[1]) * 1000;
  return 750;
}

export function mlToLitersGallons(totalMl) {
  const liters = totalMl / 1000;
  return { liters, gallons: liters * GALLONS_PER_LITER };
}
