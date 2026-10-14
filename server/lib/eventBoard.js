/**
 * The private-events board: what is outstanding on every live booking, and whose
 * move it is.
 *
 * Deliberately NOT a pipeline. A pipeline claims a sequence this domain does not
 * have — the terms produce a SET of conditional requirements and a booking is done
 * when every applicable one is met. Insurance can arrive before the signature, and
 * a small daytime event has no gates at all. Modelling that as stages would mean
 * either faking a stage such a booking passes through, or dropping it off the board.
 *
 * So a booking does not live in one bucket. It appears under every gate it still
 * owes, which means the bucket counts OVERLAP — one booking that is unsigned and
 * owes a deposit is counted by both. That is honest rather than a bug, and it is why
 * the labels read "2 unsigned" rather than "2 in contracts": the second phrasing
 * implies an exclusive location and the numbers would then stop adding up in a way
 * nobody could explain.
 *
 * Everything here is computed from the FROZEN requirements snapshot, never from the
 * live terms table, so editing a term never rewrites what a booking was already told.
 */
import { query } from '../db.js';
import { effectiveTerms } from './eventTerms.js';

/** Buckets the strip filters by. 'proposals' has no data layer yet — see below. */
export const BUCKETS = ['requests', 'proposals', 'contracts', 'outstanding', 'no_contract'];

/**
 * Statuses that take a booking off the live board.
 *
 * One list, used by every query that divides live from closed. They were written out
 * by hand in each place, which is how 'withdrawn' came to be excluded everywhere and
 * settable nowhere — a status that filtered real rows while being impossible to
 * reach.
 */
export const CLOSED_STATUSES = ['declined', 'withdrawn', 'cancelled'];

const isoDate = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Whole days from today to the event. Negative once it has passed. */
export function daysUntil(dateStr, today) {
  const iso = isoDate(dateStr);
  if (!iso) return null;
  const target = new Date(`${iso}T12:00:00`);
  const now = new Date(`${isoDate(today) || isoDate(new Date())}T12:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target - now) / 86400000);
}

/**
 * What a booking still owes.
 *
 * `turn` on each gate is the point: 'ours' means we are the holdup, 'theirs' means
 * they are. A board that only counted outstanding things would stay red while we
 * waited on a customer, and a badge that is permanently red is one people stop
 * seeing within a week.
 */
export function gatesFor(r) {
  // Effective, not evaluated: a waived insurance requirement or a reduced deposit has
  // to change what the board asks for, or staff keep chasing something we agreed to
  // drop.
  const req = effectiveTerms(r);
  const evaluated = !!r.rules_evaluated_at;
  const gates = [];

  // Nothing can be judged before the terms have been worked out, so this comes
  // first and suppresses the rest — otherwise an unevaluated booking would show
  // four confident "not required" dashes it has not earned.
  if (!evaluated) {
    gates.push({ key: 'terms', label: 'Check terms', state: 'outstanding', turn: 'ours' });
    return gates;
  }

  if (r.status === 'new') {
    gates.push({ key: 'approval', label: 'Needs approval', state: 'outstanding', turn: 'ours' });
  }

  // A proposal comes before a contract: the price is agreed first, then the legal
  // clauses. Only where there is actually something to agree — a booking that costs
  // nothing and requires nothing has nothing to propose.
  const costs = (req.rental_total_cents ?? 0) + (req.min_wine_purchase_cents ?? 0)
    + (req.due_now_cents ?? 0);
  if (costs > 0 && !r.proposal_accepted_at) {
    // A decline comes back to us, not to them. Leaving it as "awaiting their answer"
    // would park a booking in the customer's court that is sitting in ours, and it
    // is the one state where somebody is definitely waiting on a reply.
    if (r.proposal_declined_at) {
      gates.push({ key: 'proposal', label: 'They turned it down', state: 'outstanding',
        turn: 'ours', since: r.proposal_declined_at, reason: r.proposal_decline_reason || null });
    } else {
      gates.push(r.proposal_sent_at
        ? { key: 'proposal', label: 'Awaiting their answer', state: 'outstanding', turn: 'theirs',
            since: r.proposal_sent_at }
        : { key: 'proposal', label: 'Send proposal', state: 'outstanding', turn: 'ours' });
    }
  } else if (r.proposal_accepted_at) {
    gates.push({ key: 'proposal', label: 'Proposal accepted', state: 'done', turn: null });
  }

  // Anything they asked for that nobody has ruled on yet stands between the
  // proposal and the contract. Sending the agreement first would put our signature
  // under a document that silently omits what they asked for, and the Agreed
  // Additions clause would leave it out — the customer would read a contract that
  // simply does not mention the thing they requested.
  const undecided = Number(r.pending_requests || 0);
  if (undecided > 0) {
    gates.push({ key: 'asks', state: 'outstanding', turn: 'ours',
      label: undecided === 1 ? '1 request to decide' : `${undecided} requests to decide` });
  }

  // Prefer the frozen snapshot; fall back to the flags the evaluate route also
  // writes, so a booking evaluated before the snapshot existed still reads right.
  const contractRequired = req.contract_required ?? false;
  if (!contractRequired) {
    gates.push({ key: 'contract', label: 'No contract', state: 'not_required', turn: null });
  } else if (r.contract_executed_at) {
    gates.push({ key: 'contract', label: 'Contract signed', state: 'done', turn: null });
  } else if (r.contract_customer_signed_at) {
    gates.push({ key: 'contract', label: 'Counter-sign', state: 'outstanding', turn: 'ours' });
  } else if (r.contract_sent_at) {
    gates.push({ key: 'contract', label: 'Unsigned', state: 'outstanding', turn: 'theirs',
      since: r.contract_sent_at });
  } else {
    gates.push({ key: 'contract', label: 'Send contract', state: 'outstanding', turn: 'ours' });
  }

  const insuranceRequired = req.insurance_required ?? !!r.insurance_required;
  if (!insuranceRequired) {
    gates.push({ key: 'insurance', label: 'No insurance', state: 'not_required', turn: null });
  } else if (r.insurance_ok) {
    gates.push({ key: 'insurance', label: 'Insured', state: 'done', turn: null });
  } else if (r.insurance_uploaded_at) {
    // Uploaded is not accepted — somebody still has to look at it, and that
    // somebody is us.
    gates.push({ key: 'insurance', label: 'Check insurance', state: 'outstanding', turn: 'ours' });
  } else {
    gates.push({ key: 'insurance', label: 'Insurance', state: 'outstanding', turn: 'theirs' });
  }

  // Reserving the tables in ResOS. Craig: "If someone forgets to book resos, we
  // could be screwed." It becomes a step the board asks for once the deposit is in,
  // rather than something somebody is meant to remember — its absence is invisible
  // until the day, when the guests arrive and there are no tables.
  const depositIn = !!r.deposit_paid_at || !(req.due_now_cents > 0);
  if (r.proposal_accepted_at && depositIn && !r.resos_booked_at) {
    gates.push({ key: 'resos', label: 'Reserve tables in ResOS', state: 'outstanding', turn: 'ours' });
  } else if (r.resos_booked_at) {
    gates.push({ key: 'resos', label: 'Tables reserved', state: 'done', turn: null });
  }

  const dueCents = req.due_now_cents
    ?? ((req.booking_deposit_cents ?? 0) + (req.security_deposit_cents ?? 0))
    ?? 0;
  if (!dueCents) {
    gates.push({ key: 'deposit', label: 'No deposit', state: 'not_required', turn: null });
  } else if (r.deposit_paid_at) {
    gates.push({ key: 'deposit', label: 'Deposit paid', state: 'done', turn: null });
  } else {
    gates.push({ key: 'deposit', label: 'Deposit', state: 'outstanding', turn: 'theirs',
      cents: dueCents });
  }

  return gates;
}

/** Which strip boxes this booking belongs under. Overlapping, by design. */
export function bucketsFor(r, gates) {
  const out = new Set();
  const gate = (k) => gates.find((g) => g.key === k);

  if (gate('terms') || gate('approval')) out.add('requests');
  if (gate('proposal')?.state === 'outstanding') out.add('proposals');
  // An undecided ask belongs with the proposals: it is still the conversation.
  if (gate('asks')) out.add('proposals');
  if (gate('contract')?.state === 'outstanding') out.add('contracts');
  if (gate('contract')?.state === 'not_required' && r.rules_evaluated_at) out.add('no_contract');
  for (const k of ['insurance', 'deposit', 'resos']) {
    if (gate(k)?.state === 'outstanding') out.add('outstanding');
  }
  return [...out];
}

/**
 * The single thing to do next.
 *
 * Every action names what it DOES. The first version labelled the
 * waiting-on-them case "Chase" while still carrying the gate's key, and the client
 * mapped that key to the our-move action — so "Chase" on a deposit row recorded the
 * deposit as paid, and on an insurance row approved the certificate sight unseen. A
 * button that quietly records money you have not received is worse than no button.
 *
 * There is no messaging yet, so nothing here can actually chase anyone. What staff
 * genuinely can do while waiting is resend the contract, or record something that
 * has arrived — and both now say exactly that.
 */
const GATE_ORDER = ['terms', 'approval', 'proposal', 'asks', 'contract', 'insurance', 'deposit', 'resos'];

/**
 * The gate that governs this booking: the first outstanding one in sequence.
 *
 * The row's turn follows it, rather than being "any gate is ours". A contract we
 * have not sent is technically ours, but while the proposal sits unanswered it is
 * not ours to do — and a board that called that our move would send staff chasing
 * a step the customer has not reached.
 */
export function governingGate(gates) {
  for (const k of GATE_ORDER) {
    const g = gates.find((x) => x.key === k && x.state === 'outstanding');
    if (g) return g;
  }
  return null;
}

function nextAction(gates, r) {
  const outstanding = (k) => gates.find((g) => g.key === k && g.state === 'outstanding');

  if (outstanding('terms')) return { kind: 'evaluate', label: 'Check terms' };
  if (outstanding('approval')) return { kind: 'approve', label: 'Approve' };

  // The proposal is answered before the contract is drawn: agreeing the price first
  // means nobody reads ten clauses about an amount they were going to argue with.
  const proposal = outstanding('proposal');
  if (proposal) {
    if (r.proposal_declined_at) return { kind: 'review_asks', label: 'Revise the proposal' };
    return r.proposal_sent_at
      ? { kind: 'send_proposal', label: 'Resend proposal' }
      : { kind: 'send_proposal', label: 'Send proposal' };
  }

  const asks = outstanding('asks');
  if (asks) return { kind: 'review_asks', label: 'Review their requests' };

  const contract = outstanding('contract');
  if (contract) {
    if (r.contract_customer_signed_at) return { kind: 'countersign', label: 'Counter-sign' };
    // Sent but unsigned is still a send: the one useful thing when a customer says
    // the email never arrived, which is exactly how this gap was found.
    return { kind: 'send_contract', label: r.contract_sent_at ? 'Resend contract' : 'Send contract' };
  }

  const insurance = outstanding('insurance');
  if (insurance) return { kind: 'insurance_ok', label: 'Mark insurance OK' };

  if (outstanding('deposit')) return { kind: 'deposit_paid', label: 'Mark deposit paid' };
  if (outstanding('resos')) return { kind: 'resos_booked', label: 'Reserve tables in ResOS' };
  return null;
}

export function boardRow(r, today) {
  const gates = gatesFor(r);
  const governing = governingGate(gates);
  const turn = governing ? governing.turn : 'done';

  return {
    id: r.id,
    name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email,
    email: r.email,
    phone: r.phone,
    event_date: isoDate(r.event_date),
    days_to_event: daysUntil(r.event_date, today),
    start_time: r.start_time ? String(r.start_time).slice(0, 5) : null,
    end_time: r.end_time ? String(r.end_time).slice(0, 5) : null,
    venue: r.location_name || null,
    guests: r.guests,
    status: r.status,
    gates,
    buckets: bucketsFor(r, gates),
    turn,
    action: nextAction(gates, r),
  };
}

/**
 * Sort by how soon the event is, not by stage.
 *
 * This work does not go wrong by sitting in the wrong place; it goes wrong by
 * arriving late. A booking nine days out with an unsigned contract is an emergency
 * and the same booking in April is fine, and only the date says which.
 *
 * A booking with no date at all sorts last rather than first — an undated enquiry is
 * not urgent, and treating a null as zero would park it permanently at the top.
 */
export function buildBoard(rows, today) {
  const live = rows.map((r) => boardRow(r, today));

  const counts = {};
  for (const b of BUCKETS) {
    const inBucket = live.filter((r) => r.buckets.includes(b));
    counts[b] = {
      total: inBucket.length,
      ours: inBucket.filter((r) => r.turn === 'ours').length,
      theirs: inBucket.filter((r) => r.turn === 'theirs').length,
    };
  }

  live.sort((a, b) => {
    if (a.days_to_event == null) return 1;
    if (b.days_to_event == null) return -1;
    return a.days_to_event - b.days_to_event;
  });

  return {
    rows: live,
    counts,
    needsYou: live.filter((r) => r.turn === 'ours').length,
    withThem: live.filter((r) => r.turn === 'theirs').length,
    settled: live.filter((r) => r.turn === 'done').length,
  };
}

/**
 * Close out bookings whose date has passed.
 *
 * An approved event that happened last month is not outstanding work, but nothing
 * moved it on — so the inbox slowly filled with things nobody could action, which is
 * how an inbox stops being read.
 *
 * Done on read rather than by a nightly job: it is idempotent, costs one indexed
 * update, and a job that quietly stops running would leave exactly the mess it was
 * meant to prevent. Journaled without a text, because nobody needs a message saying
 * last month's party is over.
 */
export async function completePastEvents(companyId) {
  const { rows } = await query(
    `UPDATE kindred_web.event_requests
        SET status = 'complete', updated_at = NOW()
      WHERE status = 'approved' AND event_date IS NOT NULL AND event_date < CURRENT_DATE
      RETURNING id`, []);
  for (const r of rows) {
    try {
      await query(
        `INSERT INTO kindred_web.event_request_activity
           (company_id, request_id, action, detail, actor_name)
         VALUES ($1,$2,'complete','the event date has passed','Kindred')`,
        [companyId, r.id]);
    } catch { /* the status is what matters; a missed line must not undo it */ }
  }
  return rows.length;
}

export async function board(companyId, today = new Date()) {
  await completePastEvents(companyId);
  const { rows } = await query(
    `SELECT r.*, l.name AS location_name,
            (SELECT count(*) FROM kindred_web.event_special_requests s
              WHERE s.request_id = r.id AND s.status = 'pending') AS pending_requests
       FROM kindred_web.event_requests r
       LEFT JOIN locations l ON l.id = r.location_id
      WHERE r.status <> ALL($1::text[])
      ORDER BY r.event_date NULLS LAST
      LIMIT 500`, [CLOSED_STATUSES]);
  return buildBoard(rows, today);
}

/** Closed business, kept out of the live board but not out of sight. */
export async function closedBoard() {
  const { rows } = await query(
    `SELECT r.id, r.first_name, r.last_name, r.event_date, r.guests, r.status,
            r.declined_reason, l.name AS location_name
       FROM kindred_web.event_requests r
       LEFT JOIN locations l ON l.id = r.location_id
      WHERE r.status = ANY($1::text[])
      ORDER BY r.updated_at DESC LIMIT 100`, [CLOSED_STATUSES]);
  return rows.map((r) => ({
    id: r.id,
    name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    event_date: isoDate(r.event_date),
    venue: r.location_name, guests: r.guests,
    status: r.status, reason: r.declined_reason,
  }));
}
