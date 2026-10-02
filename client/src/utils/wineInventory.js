// Mirrors server/lib/wineInventory.js — case size is fixed at 12 bottles.
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

// A "row" is how the wine is physically stacked in the Winerage — usually 16
// cases, which is why counting by rows is faster than counting cases. "Usually"
// is the important word: a short row is entered as plain cases, so nothing here
// ever converts cases UP into rows. The arithmetic only ever goes one way.
export const CASES_PER_ROW = 16;

export function toTotalBottlesFromRows(rows, cases, bottles) {
  return ((parseInt(rows, 10) || 0) * CASES_PER_ROW + (parseInt(cases, 10) || 0)) * CASE_SIZE
    + (parseInt(bottles, 10) || 0);
}
