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

/** Buckets the strip filters by. 'proposals' has no data layer yet — see below. */
export const BUCKETS = ['requests', 'proposals', 'contracts', 'outstanding', 'no_contract'];

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
  const req = r.requirements || {};
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
  if (gate('contract')?.state === 'outstanding') out.add('contracts');
  if (gate('contract')?.state === 'not_required' && r.rules_evaluated_at) out.add('no_contract');
  for (const k of ['insurance', 'deposit']) {
    if (gate(k)?.state === 'outstanding') out.add('outstanding');
  }
  return [...out];
}

/** The single thing to do next, which is whichever gate is waiting on us. */
function nextAction(gates) {
  const mine = gates.find((g) => g.state === 'outstanding' && g.turn === 'ours');
  if (mine) return { key: mine.key, label: mine.label };
  const theirs = gates.find((g) => g.state === 'outstanding' && g.turn === 'theirs');
  return theirs ? { key: theirs.key, label: 'Chase' } : null;
}

export function boardRow(r, today) {
  const gates = gatesFor(r);
  const outstandingGates = gates.filter((g) => g.state === 'outstanding');
  const turn = outstandingGates.some((g) => g.turn === 'ours') ? 'ours'
    : outstandingGates.length ? 'theirs' : 'done';

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
    action: nextAction(gates),
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
  // No messages table exists yet, so this is reported as unwired rather than as a
  // confident zero — "nothing waiting" and "we cannot see" must not look the same.
  counts.proposals = { total: 0, ours: 0, theirs: 0, unwired: true };

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

export async function board(companyId, today = new Date()) {
  const { rows } = await query(
    `SELECT r.*, l.name AS location_name
       FROM kindred_web.event_requests r
       LEFT JOIN locations l ON l.id = r.location_id
      WHERE r.status NOT IN ('declined', 'withdrawn')
      ORDER BY r.event_date NULLS LAST
      LIMIT 500`, []);
  return buildBoard(rows, today);
}

/** Closed business, kept out of the live board but not out of sight. */
export async function closedBoard() {
  const { rows } = await query(
    `SELECT r.id, r.first_name, r.last_name, r.event_date, r.guests, r.status,
            r.declined_reason, l.name AS location_name
       FROM kindred_web.event_requests r
       LEFT JOIN locations l ON l.id = r.location_id
      WHERE r.status IN ('declined', 'withdrawn')
      ORDER BY r.updated_at DESC LIMIT 100`, []);
  return rows.map((r) => ({
    id: r.id,
    name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    event_date: isoDate(r.event_date),
    venue: r.location_name, guests: r.guests,
    status: r.status, reason: r.declined_reason,
  }));
}
