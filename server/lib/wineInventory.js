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
