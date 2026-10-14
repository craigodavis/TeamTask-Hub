import { boardRow, buildBoard, daysUntil } from './eventBoard.js';

const TODAY = new Date('2026-10-12T12:00:00');
const base = (o) => ({
  id: o.id || 'x', first_name: 'A', last_name: 'B', email: 'a@b.c',
  event_date: '2026-11-01', guests: 40, status: 'approved',
  rules_evaluated_at: '2026-10-01', requirements: {},
  contract_sent_at: null, contract_customer_signed_at: null, contract_executed_at: null,
  insurance_required: false, insurance_uploaded_at: null, insurance_ok: false,
  deposit_paid_at: null, location_name: 'Creek',
  // Past the proposal by default: these cases are about what happens AFTER the price
  // is agreed. The proposal stage has its own cases below.
  proposal_sent_at: '2026-10-01', proposal_accepted_at: '2026-10-02',
  resos_booked_at: '2026-10-03', ...o,
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
// Never "Chase": the button has to name what it does, and what it does is send again.
is('sent: action resends', r.action.label, 'Resend contract');
is('sent: action kind', r.action.kind, 'send_contract');

// They signed; the holdup is us again.
r = boardRow(base({ requirements: full, contract_sent_at: '2026-10-03', contract_customer_signed_at: '2026-10-09' }), TODAY);
is('signed: back to us', r.turn, 'ours');
is('signed: action', r.action.label, 'Counter-sign');

// Insurance uploaded is not insurance accepted.
r = boardRow(base({ requirements: { ...full, contract_required: false }, insurance_uploaded_at: '2026-10-05' }), TODAY);
is('uploaded insurance needs us', gate(r, 'insurance').turn, 'ours');
is('uploaded insurance action', r.action.label, 'Mark insurance OK');

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
is('proposals: none outstanding once accepted', board.counts.proposals.total, 0);

// A booking waiting on them still counts, but not as "ours".
const mixed = buildBoard([
  base({ id: 'a', requirements: full, contract_sent_at: '2026-10-01' }),
  base({ id: 'b', requirements: full }),
], TODAY);
is('mixed: ours', mixed.counts.contracts.ours, 1);
is('mixed: theirs', mixed.counts.contracts.theirs, 1);

// A deposit we are waiting on must never be actioned by a button that does not say
// it is recording a payment.
r = boardRow(base({ requirements: { contract_required: false, insurance_required: false, due_now_cents: 50000 } }), TODAY);
is('awaiting deposit: label names the act', r.action.label, 'Mark deposit paid');
is('awaiting deposit: kind', r.action.kind, 'deposit_paid');
is('awaiting deposit: turn is still theirs', r.turn, 'theirs');

// ── The proposal comes before the contract ───────────────────────────────────
const costed = { contract_required: true, insurance_required: false, due_now_cents: 50000,
  min_wine_purchase_cents: 60000, rental_total_cents: 110000 };

r = boardRow(base({ requirements: costed, proposal_sent_at: null, proposal_accepted_at: null }), TODAY);
is('unproposed: asks for the proposal first', r.action.label, 'Send proposal');
is('unproposed: not the contract', r.gates.find((g) => g.key === 'proposal').turn, 'ours');
is('unproposed: in the proposals bucket', r.buckets.includes('proposals'), true);

r = boardRow(base({ requirements: costed, proposal_sent_at: '2026-10-10', proposal_accepted_at: null }), TODAY);
is('sent, unanswered: their move', r.turn, 'theirs');
is('sent, unanswered: resend', r.action.label, 'Resend proposal');

r = boardRow(base({ requirements: costed }), TODAY);   // accepted by default
is('accepted: proposal done', r.gates.find((g) => g.key === 'proposal').state, 'done');
is('accepted: contract is next', r.action.label, 'Send contract');

// A booking that costs nothing has nothing to propose.
r = boardRow(base({ requirements: { contract_required: false, insurance_required: false },
  proposal_sent_at: null, proposal_accepted_at: null }), TODAY);
is('free booking: no proposal gate', r.gates.some((g) => g.key === 'proposal'), false);
is('free booking: nothing to do', r.action, null);

// ── Undecided asks hold the contract ─────────────────────────────────────────
r = boardRow(base({ requirements: costed, pending_requests: 2 }), TODAY);
is('undecided asks: they come first', r.action.label, 'Review their requests');
is('undecided asks: our move', r.turn, 'ours');
is('undecided asks: counted in proposals', r.buckets.includes('proposals'), true);
is('undecided asks: gate labelled with the count',
   r.gates.find((g) => g.key === 'asks').label, '2 requests to decide');

r = boardRow(base({ requirements: costed, pending_requests: 0 }), TODAY);
is('all decided: contract is next again', r.action.label, 'Send contract');

// One reads as one, not "1 requests".
r = boardRow(base({ requirements: costed, pending_requests: 1 }), TODAY);
is('a single ask reads properly', r.gates.find((g) => g.key === 'asks').label, '1 request to decide');

// ── A proposal can be turned down ────────────────────────────────────────────
r = boardRow(base({ requirements: costed, proposal_sent_at: '2026-10-10',
  proposal_accepted_at: null, proposal_declined_at: '2026-10-11',
  proposal_decline_reason: 'Too much for the wine minimum' }), TODAY);
is('declined: comes back to us', r.turn, 'ours');
is('declined: says so', r.gates.find((g) => g.key === 'proposal').label, 'They turned it down');
is('declined: next step is to revise', r.action.label, 'Revise the proposal');
is('declined: the reason travels', r.gates.find((g) => g.key === 'proposal').reason,
   'Too much for the wine minimum');

// ── Reserving the tables is a step, not a memory ─────────────────────────────
r = boardRow(base({ requirements: { contract_required: false, insurance_required: false, due_now_cents: 50000 },
  deposit_paid_at: '2026-10-05', resos_booked_at: null }), TODAY);
is('deposit in, tables not booked', r.action.label, 'Reserve tables in ResOS');
is('it is our move', r.turn, 'ours');

// Before the deposit it is not yet asked for — nothing is held until the money is.
r = boardRow(base({ requirements: { contract_required: false, insurance_required: false, due_now_cents: 50000 },
  deposit_paid_at: null, resos_booked_at: null }), TODAY);
is('no deposit yet: tables not asked for', r.gates.some((g) => g.key === 'resos'), false);

// A booking that owes nothing still needs tables.
r = boardRow(base({ requirements: { contract_required: false, insurance_required: false },
  deposit_paid_at: null, resos_booked_at: null }), TODAY);
is('free booking still needs tables', r.action.label, 'Reserve tables in ResOS');

r = boardRow(base({ requirements: { contract_required: false, insurance_required: false } }), TODAY);
is('tables booked: nothing left', r.action, null);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
