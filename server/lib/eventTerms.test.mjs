import { resolveTerms, specificity, termMatches } from './eventTerms.js';

const CREEK = 'creek-uuid', WINERY = 'winery-uuid';
const row = (o) => ({
  id: o.name, active: true, created_at: '2026-01-01',
  min_guests: null, max_guests: null, location_id: null, during_business_hours: null,
  availability: null, hourly_rate_cents: null, base_price_cents: null, min_wine_purchase_cents: null,
  security_deposit_cents: null, booking_deposit_cents: null, booking_deposit_pct: null,
  balance_due_days_before: null, planning_meeting_days: null, insurance_required: null,
  contract_required: null, contract_section_keys: null, setup_task_keys: null,
  parking_attendant_over: null, notes_to_customer: null, ...o,
});

// The seeded set, as the migration will create it.
const SEED = [
  row({ name: 'Lawn Gathering', min_guests: 10, max_guests: 24, base_price_cents: 55000,
        min_wine_purchase_cents: 30000, booking_deposit_cents: 20000,
        insurance_required: false, contract_required: true, planning_meeting_days: 14 }),
  row({ name: 'Large Group', min_guests: 25, max_guests: 50, base_price_cents: 110000,
        min_wine_purchase_cents: 60000, booking_deposit_cents: 50000,
        insurance_required: true, contract_required: true, planning_meeting_days: 21 }),
  row({ name: 'Small gathering during open hours', max_guests: 15, during_business_hours: true,
        availability: 'available', booking_deposit_cents: 0, security_deposit_cents: 0,
        insurance_required: false, contract_required: false }),
];

let fails = 0;
const is = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label} = ${JSON.stringify(got)}`);
};

// Craig's case: 12 people, during business hours.
let r = resolveTerms(SEED, { guests: 12, locationId: CREEK }, true);
is('12 daytime: contract', r.contract_required, false);
is('12 daytime: booking deposit', r.booking_deposit_cents, 0);
is('12 daytime: security deposit', r.security_deposit_cents, 0);
is('12 daytime: still pays the lawn fee', r.base_price_cents, 55000);
is('12 daytime: fee came from the tier', r.sources.base_price_cents.name, 'Lawn Gathering');
is('12 daytime: contract call came from the small row', r.sources.contract_required.name, 'Small gathering during open hours');
is('12 daytime: min wine', r.min_wine_purchase_cents, 30000);

// Same party, after hours: the small row must NOT apply.
r = resolveTerms(SEED, { guests: 12, locationId: CREEK }, false);
is('12 after hours: contract', r.contract_required, true);
is('12 after hours: deposit', r.booking_deposit_cents, 20000);

// No time given at all — the hours answer is unknown and must not match either way.
r = resolveTerms(SEED, { guests: 12, locationId: CREEK }, null);
is('12 unknown hours: contract', r.contract_required, true);

// The 25-guest boundary that used to match both tiers.
r = resolveTerms(SEED, { guests: 25, locationId: CREEK }, false);
is('25 guests: tier', r.sources.base_price_cents.name, 'Large Group');
is('25 guests: insurance', r.insurance_required, true);

// 14 people during hours: the small row caps at 15, the tier floor is 10.
r = resolveTerms(SEED, { guests: 15, locationId: CREEK }, true);
is('15 daytime: no contract', r.contract_required, false);
r = resolveTerms(SEED, { guests: 16, locationId: CREEK }, true);
is('16 daytime: contract comes back', r.contract_required, true);

// Nothing configured must read as a gap, never as a zero that looks decided.
r = resolveTerms([], { guests: 80, locationId: CREEK }, false);
is('unconfigured: base price', r.base_price_cents, null);
is('unconfigured: availability defaults open', r.availability, 'available');
is('unconfigured: contract', r.contract_required, false);
is('unconfigured: sections', r.contract_section_keys, []);

// A venue-specific override layers over the tier without restating it.
const withVenue = [...SEED, row({ name: 'Winery after hours', location_id: WINERY,
  during_business_hours: false, security_deposit_cents: 50000, insurance_required: true })];
r = resolveTerms(withVenue, { guests: 30, locationId: WINERY }, false);
is('winery after hours: security deposit', r.security_deposit_cents, 50000);
is('winery after hours: tier fee still applies', r.base_price_cents, 110000);
r = resolveTerms(withVenue, { guests: 30, locationId: CREEK }, false);
is('creek unaffected by the winery row', r.security_deposit_cents, null);

// An unavailable row must win outright.
const blocked = [...SEED, row({ name: 'No 100+ at the winery', min_guests: 100,
  location_id: WINERY, availability: 'unavailable' })];
r = resolveTerms(blocked, { guests: 120, locationId: WINERY }, false);
is('120 at winery: unavailable', r.availability, 'unavailable');

// Percentage fallback when no flat deposit is set.
const pct = [row({ name: 'Half up front', base_price_cents: 200000, booking_deposit_pct: 50 })];
r = resolveTerms(pct, { guests: 60, locationId: CREEK }, false);
is('pct deposit', r.booking_deposit_cents, 100000);

// Specificity counts dimensions, not columns.
is('spec: both guest bounds = 1 dimension', specificity({ min_guests: 10, max_guests: 24 }), 1);
is('spec: guests + hours = 2', specificity({ max_guests: 15, during_business_hours: true }), 2);
is('spec: all three', specificity({ min_guests: 1, location_id: CREEK, during_business_hours: false }), 3);

// Guests unknown must not satisfy a bounded row.
is('no headcount vs bounded row', termMatches({ min_guests: 10, max_guests: 24 }, { guests: null }, true), false);

// ── Per-hour venue fee ───────────────────────────────────────────────────────
const hourly = [row({ name: 'Creek after hours', location_id: CREEK, during_business_hours: false,
  hourly_rate_cents: 25000, booking_deposit_pct: 50 })];
r = resolveTerms(hourly, { guests: 40, locationId: CREEK, startTime: '18:00', endTime: '22:00' }, false);
is('hourly: 4 hours at $250', r.rental_total_cents, 100000);
is('hourly: basis', r.rental_basis, 'hourly');
is('hourly: deposit is 50% of the TOTAL, not the rate', r.booking_deposit_cents, 50000);

r = resolveTerms(hourly, { guests: 40, locationId: CREEK, startTime: '18:00', endTime: '20:30' }, false);
is('hourly: half hours count', r.rental_total_cents, 62500);

// An hourly rate with no times cannot be totalled, and must not read as free.
r = resolveTerms(hourly, { guests: 40, locationId: CREEK }, false);
is('hourly: no times given', r.rental_total_cents, null);
is('hourly: no deposit either', r.booking_deposit_cents, null);

// Rows with no hourly rate keep working on the old flat fee.
r = resolveTerms(SEED, { guests: 12, locationId: CREEK }, false);
is('flat fallback: total', r.rental_total_cents, 55000);
is('flat fallback: basis', r.rental_basis, 'flat');

// An hourly rate on a narrower row beats the flat fee on a broader one.
const mixed = [...SEED, row({ name: 'Creek hourly', location_id: CREEK, hourly_rate_cents: 20000 })];
r = resolveTerms(mixed, { guests: 12, locationId: CREEK, startTime: '18:00', endTime: '21:00' }, false);
is('hourly beats flat', r.rental_total_cents, 60000);
is('hourly beats flat: basis', r.rental_basis, 'hourly');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
