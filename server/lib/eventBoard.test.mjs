import { boardRow, buildBoard, daysUntil } from './eventBoard.js';

const TODAY = new Date('2026-10-12T12:00:00');
const base = (o) => ({
  id: o.id || 'x', first_name: 'A', last_name: 'B', email: 'a@b.c',
  event_date: '2026-11-01', guests: 40, status: 'approved',
  rules_evaluated_at: '2026-10-01', requirements: {},
  contract_sent_at: null, contract_customer_signed_at: null, contract_executed_at: null,
  insurance_required: false, insurance_uploaded_at: null, insurance_ok: false,
  deposit_paid_at: null, location_name: 'Creek', ...o,
});

let fails = 0;
const is = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label} = ${JSON.stringify(got)}`);
};
const gate = (row, k) => row.gates.find((g) => g.key === k);

// Craig's small daytime event: no gates at all once approved.
let r = boardRow(base({ requirements: { contract_required: false, insurance_required: false, due_now_cents: null } }), TODAY);
is('small event: contract', gate(r, 'contract').state, 'not_required');
is('small event: insurance', gate(r, 'insurance').state, 'not_required');
is('small event: deposit', gate(r, 'deposit').state, 'not_required');
is('small event: turn', r.turn, 'done');
is('small event: buckets', r.buckets, ['no_contract']);
is('small event: no action', r.action, null);

// It must still be visible somewhere — that is what the branch is for.
is('small event appears under the branch', r.buckets.includes('no_contract'), true);

// Unevaluated: must NOT claim four dashes it has not earned.
r = boardRow(base({ rules_evaluated_at: null, requirements: null }), TODAY);
is('unevaluated: one gate only', r.gates.length, 1);
is('unevaluated: gate', gate(r, 'terms').state, 'outstanding');
is('unevaluated: turn', r.turn, 'ours');
is('unevaluated: action', r.action.label, 'Check terms');

// A full-requirement booking, nothing done yet.
const full = { contract_required: true, insurance_required: true, due_now_cents: 50000 };
r = boardRow(base({ requirements: full }), TODAY);
is('full: contract is ours to send', gate(r, 'contract').turn, 'ours');
is('full: insurance is theirs', gate(r, 'insurance').turn, 'theirs');
is('full: deposit is theirs', gate(r, 'deposit').turn, 'theirs');
is('full: turn is ours', r.turn, 'ours');
is('full: action', r.action.label, 'Send contract');
is('full: in two buckets at once', r.buckets.sort(), ['contracts', 'outstanding']);

// Sent, awaiting their signature — now it is THEIR move, so not red.
r = boardRow(base({ requirements: full, contract_sent_at: '2026-10-03' }), TODAY);
is('sent: contract turn', gate(r, 'contract').turn, 'theirs');
is('sent: row turn', r.turn, 'theirs');
is('sent: action is a chase', r.action.label, 'Chase');

// They signed; the holdup is us again.
r = boardRow(base({ requirements: full, contract_sent_at: '2026-10-03', contract_customer_signed_at: '2026-10-09' }), TODAY);
is('signed: back to us', r.turn, 'ours');
is('signed: action', r.action.label, 'Counter-sign');

// Insurance uploaded is not insurance accepted.
r = boardRow(base({ requirements: { ...full, contract_required: false }, insurance_uploaded_at: '2026-10-05' }), TODAY);
is('uploaded insurance needs us', gate(r, 'insurance').turn, 'ours');
is('uploaded insurance action', r.action.label, 'Check insurance');

// Everything satisfied.
r = boardRow(base({ requirements: full, contract_executed_at: '2026-10-05',
  insurance_ok: true, deposit_paid_at: '2026-10-06' }), TODAY);
is('all done: turn', r.turn, 'done');
is('all done: no buckets', r.buckets, []);

// Awaiting approval.
r = boardRow(base({ status: 'new', requirements: { contract_required: false, insurance_required: false } }), TODAY);
is('new: needs approval', gate(r, 'approval').state, 'outstanding');
is('new: in requests', r.buckets.includes('requests'), true);

// Urgency.
is('days until', daysUntil('2026-10-24', TODAY), 12);
is('days until past', daysUntil('2026-10-01', TODAY), -11);

// Sorted soonest first; an undated enquiry sorts LAST, not first.
const board = buildBoard([
  base({ id: 'far', event_date: '2027-01-01', requirements: full }),
  base({ id: 'none', event_date: null, requirements: full }),
  base({ id: 'soon', event_date: '2026-10-20', requirements: full }),
], TODAY);
is('sort order', board.rows.map((x) => x.id), ['soon', 'far', 'none']);
is('needsYou', board.needsYou, 3);

// Counts overlap on purpose, and proposals is unwired rather than a confident zero.
is('contracts count', board.counts.contracts.total, 3);
is('outstanding count', board.counts.outstanding.total, 3);
is('proposals unwired', board.counts.proposals.unwired, true);

// A booking waiting on them still counts, but not as "ours".
const mixed = buildBoard([
  base({ id: 'a', requirements: full, contract_sent_at: '2026-10-01' }),
  base({ id: 'b', requirements: full }),
], TODAY);
is('mixed: ours', mixed.counts.contracts.ours, 1);
is('mixed: theirs', mixed.counts.contracts.theirs, 1);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
