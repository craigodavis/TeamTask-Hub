import { useState, useEffect, useCallback, Fragment } from 'react';
import {
  getPrivateEventCalendar, getPrivateEventBoard, getEventTerms, createEventTerm, updateEventTerm,
  deleteEventTerm, previewEventTerms, evaluateEventRequest, updateEventRequest,
  getLocations, getContractSections, createContractSection,
  updateContractSection, deleteContractSection,
} from '../api';
import Drawer from '../components/Drawer';
import { Requests, Tiers, Copy } from './EventRequests';
import '../styles/vintly.css';
import './PrivateEvents.css';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const money = (c) => (c == null ? '—' : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`);

/**
 * Colour by the earliest UNMET requirement rather than by a fixed stage.
 *
 * A booking is confirmed when everything its rules generated has been met, and a
 * small daytime event generates nothing — so it goes red straight to green. Keying
 * off a stage list would show that as a skipped step instead of a correct one.
 */
function stateOf(r) {
  if (r.status === 'declined' || r.status === 'withdrawn') return 'declined';
  if (r.status === 'new' || !r.rules_evaluated_at) return 'new';
  const need = r.requirements || {};
  // Terms that say we will not host this, or will not quote it without a manager,
  // stay red: it needs a human, which is exactly what red already means here.
  if (need.availability && need.availability !== 'available') return 'new';
  if (need.contract_required && !r.contract_executed_at) {
    return r.contract_customer_signed_at ? 'signed' : 'proposed';
  }
  if ((need.due_now_cents ?? 0) > 0 && !r.deposit_paid_at) return 'unpaid';
  if (need.insurance_required && !r.insurance_ok) return 'unpaid';
  if (r.status === 'approved' || r.approved_at) return 'confirmed';
  return 'proposed';
}

const LABEL = {
  new: 'New request', proposed: 'Awaiting customer', signed: 'Awaiting our signature',
  unpaid: 'Payment / insurance outstanding', confirmed: 'Confirmed', declined: 'Declined',
};

export function PrivateEvents() {
  const [tab, setTab] = useState('flow');
  const [err, setErr] = useState('');
  return (
    <div className="pe">
      <h2 style={{ marginBottom: 4 }}>Private Events</h2>
      <p style={{ fontSize: 13, color: 'var(--vin-muted)', marginTop: 0, marginBottom: 14 }}>
        Enquiries from the website, what they require, and what else is already booked that day.
      </p>
      {/* One flat row. Event Requests used to be its own sidebar entry; it belongs
          here, and nesting its tabs inside these would be worse than the split. */}
      <div className="pe-tabs" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        {[['flow', 'Flow'], ['calendar', 'Calendar'], ['requests', 'Requests'], ['tiers', 'Website tiers'],
          ['copy', 'Message'], ['terms', 'Terms'], ['contract', 'Contract']].map(([k, l]) => (
          <button key={k} className={`vin-btn${tab === k ? ' vin-btn-primary' : ''}`}
                  onClick={() => { setTab(k); setErr(''); }}>{l}</button>
        ))}
      </div>
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}
      {tab === 'flow' && <FlowTab />}
      {tab === 'calendar' && <CalendarTab />}
      {tab === 'requests' && <Requests onError={setErr} />}
      {tab === 'tiers' && <Tiers onError={setErr} />}
      {tab === 'copy' && <Copy onError={setErr} />}
      {tab === 'terms' && <TermsTab />}
      {tab === 'contract' && <ContractSectionsTab />}
    </div>
  );
}

function CalendarTab() {
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [data, setData] = useState({ requests: [], events: [] });
  const [sel, setSel] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const first = new Date(month.y, month.m, 1);
  const from = ymd(first);
  const to = ymd(new Date(month.y, month.m + 1, 0));

  const load = useCallback(() => {
    getPrivateEventCalendar(from, to).then(setData).catch((e) => setErr(e.message));
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const byDay = {};
  for (const r of data.requests) (byDay[r.event_date] ??= []).push(r);
  const evByDay = {};
  for (const e of data.events) (evByDay[e.start_at.slice(0, 10)] ??= []).push(e);

  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(null);
  for (let d = 1; d <= new Date(month.y, month.m + 1, 0).getDate(); d++) cells.push(d);
  const todayStr = ymd(new Date());

  const runEvaluate = async (r) => {
    setBusy(true);
    try { const out = await evaluateEventRequest(r.id); setSel({ ...r, requirements: out, rules_evaluated_at: out.evaluatedAt }); load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const setStatus = async (r, status) => {
    setBusy(true);
    try { await updateEventRequest(r.id, { status }); setSel(null); load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="pe-head">
        <button className="vin-btn" onClick={() => setMonth((m) => (m.m ? { ...m, m: m.m - 1 } : { y: m.y - 1, m: 11 }))}>←</button>
        <strong className="pe-month">{first.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</strong>
        <button className="vin-btn" onClick={() => setMonth((m) => (m.m < 11 ? { ...m, m: m.m + 1 } : { y: m.y + 1, m: 0 }))}>→</button>
        <div className="pe-key" style={{ marginLeft: 'auto' }}>
          {Object.entries(LABEL).map(([k, l]) => (
            <span key={k}><i className={`pe-dot pe-dot-${k}`} />{l}</span>
          ))}
        </div>
      </div>
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}

      <div className="pe-grid">
        {DOW.map((d) => <div key={d} className="pe-dow">{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={`b${i}`} className="pe-cell is-empty" />;
          const date = ymd(new Date(month.y, month.m, d));
          return (
            <div key={date} className={`pe-cell${date === todayStr ? ' is-today' : ''}`}>
              <span className="pe-daynum">{d}</span>
              {(byDay[date] || []).map((r) => (
                <button key={r.id} className={`pe-chip pe-chip-${stateOf(r)}`}
                        title={`${r.name} — ${r.guests} guests — ${LABEL[stateOf(r)]}`}
                        onClick={() => setSel(r)}>
                  {r.guests}p {r.name}
                </button>
              ))}
              {(evByDay[date] || []).map((e) => (
                <span key={e.id} className="pe-chip pe-chip-event" title={`${e.title} (public event)`}>
                  {e.title}
                </span>
              ))}
            </div>
          );
        })}
      </div>

      {data.requests.length === 0 && <div className="pe-empty">No private event requests this month.</div>}

      <Drawer open={!!sel} title={sel ? `${sel.name} — ${sel.guests} guests` : ''}
              onClose={() => setSel(null)}
              footer={sel && (
                <>
                  <button className="vin-btn vin-btn-danger" disabled={busy}
                          onClick={() => setStatus(sel, 'declined')}>Decline</button>
                  <button className="vin-btn" disabled={busy} onClick={() => runEvaluate(sel)}>
                    {sel.rules_evaluated_at ? 'Re-check terms' : 'Check terms'}
                  </button>
                  <button className="vin-btn vin-btn-primary" disabled={busy}
                          onClick={() => setStatus(sel, 'approved')}>Approve</button>
                </>
              )}>
        {sel && <RequestDetail r={sel} />}
      </Drawer>
    </>
  );
}

function RequestDetail({ r }) {
  const need = r.requirements;
  return (
    <>
      {/* Conflicts first. This is the thing that stops a private booking being
          approved at the Creek on a night a musician is already playing there. */}
      {r.conflicts?.length > 0 && (
        <div className="vin-pill vin-pill-danger" style={{ display: 'block', padding: 10 }}>
          <strong>Clash at {r.location_name}:</strong>{' '}
          {r.conflicts.map((c) => c.title).join(', ')}
        </div>
      )}
      {r.conflicts?.length === 0 && r.sameDayEvents?.length > 0 && (
        <div className="vin-pill vin-pill-accent" style={{ display: 'block', padding: 10 }}>
          Also on that date (other venue): {r.sameDayEvents.map((c) => c.title).join(', ')}
        </div>
      )}

      <div>
        <div className="pe-req-line"><span>Date</span><strong>{r.event_date}</strong></div>
        <div className="pe-req-line"><span>Time</span>
          <strong>{r.start_time ? `${String(r.start_time).slice(0,5)}–${String(r.end_time||'').slice(0,5)}` : 'not given'}</strong></div>
        <div className="pe-req-line"><span>Venue</span><strong>{r.location_name || 'not given'}</strong></div>
        <div className="pe-req-line"><span>Guests</span><strong>{r.guests}</strong></div>
        <div className="pe-req-line"><span>Email</span><strong>{r.email}</strong></div>
        <div className="pe-req-line"><span>Phone</span><strong>{r.phone || '—'}</strong></div>
      </div>

      {r.notes && <div><div className="vin-label">Notes</div>
        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{r.notes}</div></div>}

      <div>
        <div className="vin-label">Requirements</div>
        {!need ? (
          <p style={{ fontSize: 13, color: 'var(--vin-muted)', margin: 0 }}>
            Not checked yet — press “Check terms”.
            {(!r.start_time || !r.location_id) &&
              ' This request has no time or venue, so anything that depends on opening hours cannot apply.'}
          </p>
        ) : <TermsResult t={need} />}
      </div>
    </>
  );
}

/**
 * The board — the default screen.
 *
 * The strip at the top is a FILTER, not a set of destinations. Clicking a box
 * narrows the list beneath it instead of navigating, so you never lose your place,
 * and a new member of staff sees the shape of the process every time they land
 * without a separate screen to go and find.
 *
 * The dashed branch is load-bearing. Bookings whose terms require no contract never
 * pass through that stage, and without somewhere to count them they would be absent
 * from this screen entirely — which is exactly how one gets forgotten.
 *
 * Boxes filter on "has this outstanding", not "is at this stage", so a booking that
 * is unsigned AND owes a deposit appears under both and the counts overlap. That is
 * why the labels read "2 unsigned" rather than "2 in contracts": the second implies
 * an exclusive place to be, and then the numbers stop adding up.
 */
function FlowTab() {
  const [data, setData] = useState(null);
  const [bucket, setBucket] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    getPrivateEventBoard().then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (row, patch) => {
    setBusy(row.id);
    try { await updateEventRequest(row.id, patch); load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  // What the one button on a row does. Chasing is a conversation, which has no
  // data layer yet, so it opens the request rather than pretending to send.
  const doAction = (row) => {
    const k = row.action?.key;
    if (k === 'contract') {
      if (row.gates.find((g) => g.key === 'contract')?.turn === 'ours'
          && row.gates.find((g) => g.key === 'contract')?.label === 'Counter-sign') {
        return act(row, { contract_executed: true });
      }
      return act(row, { contract_sent: true });
    }
    if (k === 'insurance') return act(row, { insurance_ok: true });
    if (k === 'deposit') return act(row, { deposit_paid: true });
    if (k === 'approval') return act(row, { status: 'approved' });
    return null;
  };

  if (err) return <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>;
  if (!data) return <div className="pe-empty">Loading…</div>;

  const rows = bucket ? data.rows.filter((r) => r.buckets.includes(bucket)) : data.rows;
  const BOXES = [
    ['requests', 'Requests'], ['proposals', 'Proposals'],
    ['contracts', 'Contracts'], ['outstanding', 'Outstanding'],
  ];
  const sub = (k) => {
    const c = data.counts[k] || {};
    if (c.unwired) return 'not wired yet';
    if (!c.total) return 'nothing';
    if (c.ours && c.theirs) return `${c.ours} you · ${c.theirs} them`;
    return c.ours ? `${c.ours} need you` : `${c.theirs} with them`;
  };

  return (
    <>
      <div className="pe-tallies">
        <button className={`pe-tally${bucket === null ? ' on' : ''}`} onClick={() => setBucket(null)}>
          <span className="pe-tally-n" style={{ color: data.needsYou ? 'var(--vin-text-danger)' : undefined }}>
            {data.needsYou}</span>
          <span>Need you</span>
        </button>
        <div className="pe-tally"><span className="pe-tally-n">{data.withThem}</span><span>With them</span></div>
        <div className="pe-tally"><span className="pe-tally-n">{data.settled}</span><span>Settled</span></div>
      </div>

      {/* The strip. On a phone the arrows do not survive the width, so it falls
          back to a row of chips — the counts and the branch are what matter. */}
      <div className="pe-strip">
        {BOXES.map(([k, label], i) => (
          <Fragment key={k}>
            {i > 0 && <span className="pe-strip-arrow" aria-hidden="true">→</span>}
            <button className={`pe-box${bucket === k ? ' on' : ''}${data.counts[k]?.ours ? ' urgent' : ''}`}
                    onClick={() => setBucket(bucket === k ? null : k)}>
              <strong>{label}</strong>
              <span>{sub(k)}</span>
            </button>
          </Fragment>
        ))}
      </div>
      <button className={`pe-branch${bucket === 'no_contract' ? ' on' : ''}`}
              onClick={() => setBucket(bucket === 'no_contract' ? null : 'no_contract')}>
        ⌞ No contract needed · {data.counts.no_contract?.total || 0}
      </button>

      <div className="pe-filterbar">
        <span>Showing</span>
        <strong>{bucket ? BOXES.concat([['no_contract', 'No contract needed']])
          .find(([k]) => k === bucket)?.[1] : 'Everything live'} · {rows.length}</strong>
        {bucket && <button className="vin-btn" onClick={() => setBucket(null)}>Show all</button>}
      </div>

      {rows.length === 0 && (
        <div className="pe-empty">
          {bucket ? 'Nothing in that one.'
            : data.closed?.length ? 'Nothing live. Everything is settled or closed.'
            : 'No enquiries yet. The board fills itself as requests come in.'}
        </div>
      )}

      {rows.map((r) => (
        <div key={r.id} className="pe-boardrow">
          <div className="pe-boardrow-top">
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{r.name}</strong>
              <div className="pe-req-why">
                {r.event_date || 'no date'}
                {r.start_time ? ` ${r.start_time}–${r.end_time || ''}` : ''}
                {r.venue ? ` · ${r.venue}` : ''}
                {r.guests != null ? ` · ${r.guests} guests` : ''}
              </div>
            </div>
            {/* Days to the event, not a stage. This is how the work goes wrong. */}
            <span className={`pe-days${r.days_to_event != null && r.days_to_event <= 14 ? ' near' : ''}`}>
              {r.days_to_event == null ? '—'
                : r.days_to_event < 0 ? `${Math.abs(r.days_to_event)}d ago`
                : `${r.days_to_event} days`}
            </span>
            {r.action && (
              <button className="vin-btn" disabled={busy === r.id} onClick={() => doAction(r)}>
                {busy === r.id ? '…' : r.action.label}
              </button>
            )}
          </div>
          <div className="pe-gates">
            {r.gates.map((g) => (
              <span key={g.key} className={`pe-gate ${g.state}`}>
                {g.label}{g.state === 'not_required' ? ' —' : ''}
              </span>
            ))}
          </div>
        </div>
      ))}

      {data.closed?.length > 0 && (
        <details className="pe-closed">
          <summary>Closed · {data.closed.length}</summary>
          {data.closed.map((c) => (
            <div key={c.id} className="pe-req-line">
              <span>
                <strong>{c.name}</strong>
                <div className="pe-req-why">
                  {c.event_date || 'no date'} · {c.status}
                  {c.reason ? ` · ${c.reason}` : ''}
                </div>
              </span>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

/** Cents <-> dollars for the inputs, so nobody types 55000 meaning $550. */
const toDollars = (c) => (c == null || c === '' ? '' : String(c / 100));
const toCents = (d) => (d === '' || d == null ? '' : Math.round(Number(d) * 100));

/**
 * One row = one condition set (guests x venue x hours) -> the whole package of terms.
 *
 * Rows layer: the most specific row that has an opinion about a field supplies it, so
 * "15 or fewer during open hours" can switch the contract off without restating the
 * rental fee. Blank means "this row says nothing", which is why every number shows
 * which row it came from.
 */
function TermsTab() {
  const [terms, setTerms] = useState([]);
  const [venues, setVenues] = useState([]);
  const [sections, setSections] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(null);
  const [trial, setTrial] = useState({ guests: 15, location_id: '', event_date: '', start_time: '', end_time: '' });

  const load = useCallback(() => {
    getEventTerms().then((d) => setTerms(d.terms || [])).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    getLocations('venue').then((d) => setVenues(d.locations || [])).catch(() => {});
    getContractSections().then((d) => setSections(d.sections || [])).catch(() => {});
  }, [load]);

  const blank = {
    name: '', active: true,
    min_guests: '', max_guests: '', location_id: '', during_business_hours: '',
    availability: '', hourly_rate_cents: '', base_price_cents: '', min_wine_purchase_cents: '',
    security_deposit_cents: '', booking_deposit_cents: '', booking_deposit_pct: '',
    balance_due_days_before: '', planning_meeting_days: '', parking_attendant_over: '',
    insurance_required: '', contract_required: '',
    contract_section_keys: [], notes_to_customer: '',
  };

  const edit = (t) => setForm({
    ...t,
    during_business_hours: t.during_business_hours == null ? '' : String(t.during_business_hours),
    insurance_required: t.insurance_required == null ? '' : String(t.insurance_required),
    contract_required: t.contract_required == null ? '' : String(t.contract_required),
    availability: t.availability || '',
    contract_section_keys: t.contract_section_keys || [],
  });

  const save = async () => {
    try {
      const body = { ...form };
      // '' has to reach the server as null. A blank coerced to 0 would read as a real
      // decision: security deposit 0 says "none here", not "this row does not say".
      for (const k of ['during_business_hours', 'insurance_required', 'contract_required']) {
        body[k] = body[k] === '' ? null : body[k] === 'true';
      }
      if (body.availability === '') body.availability = null;
      if (form.id) await updateEventTerm(form.id, body); else await createEventTerm(body);
      setForm(null); setErr(''); load();
    } catch (e) { setErr(e.message); }
  };

  const runPreview = async () => {
    try { setErr(''); setPreview(await previewEventTerms(trial)); } catch (e) { setErr(e.message); }
  };

  // What this row actually asserts, so the list reads as terms and not as a schema.
  const asserts = (t) => {
    const out = [];
    if (t.availability) out.push(t.availability === 'available' ? 'bookable' : t.availability.replace('_', ' '));
    if (t.hourly_rate_cents != null) out.push(`${money(t.hourly_rate_cents)}/hour`);
    else if (t.base_price_cents != null) out.push(`${money(t.base_price_cents)} flat`);
    if (t.min_wine_purchase_cents != null) out.push(`${money(t.min_wine_purchase_cents)} min wine`);
    if (t.booking_deposit_cents != null) {
      out.push(t.booking_deposit_cents === 0 ? 'no booking deposit' : `${money(t.booking_deposit_cents)} deposit`);
    } else if (t.booking_deposit_pct != null) out.push(`${Number(t.booking_deposit_pct)}% deposit`);
    if (t.security_deposit_cents != null) {
      out.push(t.security_deposit_cents === 0 ? 'no security deposit' : `${money(t.security_deposit_cents)} security`);
    }
    if (t.insurance_required != null) out.push(t.insurance_required ? 'insurance' : 'no insurance');
    if (t.contract_required != null) out.push(t.contract_required ? 'contract' : 'no contract');
    if (t.contract_section_keys?.length) out.push(`${t.contract_section_keys.length} clause(s)`);
    if (t.parking_attendant_over != null) out.push(`parking over ${t.parking_attendant_over}`);
    if (t.planning_meeting_days != null) out.push(`planning ${t.planning_meeting_days}d ahead`);
    return out;
  };

  const conditions = (t) => {
    const out = [];
    if (t.min_guests != null || t.max_guests != null) {
      out.push(`${t.min_guests ?? 1}–${t.max_guests ?? '∞'} guests`);
    } else out.push('any size');
    out.push(t.location_name || 'either venue');
    out.push(t.during_business_hours == null ? 'any hours'
      : t.during_business_hours ? 'during open hours' : 'after hours');
    return out.join(' · ');
  };

  return (
    <>
      <div className="pe-head">
        <button className="vin-btn vin-btn-primary" onClick={() => setForm({ ...blank })}>Add terms</button>
        <span style={{ fontSize: 12, color: 'var(--vin-muted)' }}>
          {terms.filter((t) => t.active).length} active — the most specific row wins each
          number, so a narrow row only states what differs
        </span>
      </div>
      {/* Honest about the duplication rather than letting the two drift silently: the
          public pricing page still reads the old tiers table, these rows drive what we
          actually quote and contract. One of the two has to go. */}
      <p className="pe-req-why" style={{ marginTop: 0 }}>
        These rows decide what we quote and contract. The public pricing page still
        reads <strong>Website tiers</strong> — if you change a price here, change it there too
        until we point the website at this table.
      </p>
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}

      {terms.length === 0 && (
        <div className="pe-empty">
          Nothing configured, so no booking gets a price or a requirement.<br />
          Start broad — one row per guest band — then add narrow rows for a venue or for after hours.
        </div>
      )}

      {terms.map((t) => (
        <div key={t.id} className="pe-req-line" style={{ opacity: t.active ? 1 : 0.55 }}>
          <span>
            <strong>{t.name}</strong>
            {!t.active && <em style={{ color: 'var(--vin-muted)' }}> (inactive)</em>}
            <div className="pe-req-why">{conditions(t)}</div>
            <div className="pe-req-why" style={{ color: 'var(--vin-text)' }}>
              {asserts(t).join(' · ') || 'states nothing — this row has no effect'}
            </div>
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="vin-btn" onClick={() => edit(t)}>Edit</button>
            {t.active && (
              <button className="vin-btn vin-btn-danger"
                onClick={async () => {
                  if (window.confirm(`Stop applying “${t.name}”? Quotes already given keep their own copy.`)) {
                    await deleteEventTerm(t.id); load();
                  }
                }}>Remove</button>
            )}
          </span>
        </div>
      ))}

      {/* Try a booking before a customer runs into it. */}
      <div style={{ marginTop: 20, paddingTop: 14, borderTop: '0.5px solid var(--vin-border)' }}>
        <div className="vin-label">Try a booking</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ width: 90 }}><label className="vin-label">Guests</label>
            <input className="vin-input" type="number" value={trial.guests}
                   onChange={(e) => setTrial({ ...trial, guests: e.target.value })} /></div>
          <div style={{ width: 150 }}><label className="vin-label">Venue</label>
            <select className="vin-select" value={trial.location_id}
                    onChange={(e) => setTrial({ ...trial, location_id: e.target.value })}>
              <option value="">—</option>
              {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></div>
          <div style={{ width: 150 }}><label className="vin-label">Date</label>
            <input className="vin-input" type="date" value={trial.event_date}
                   onChange={(e) => setTrial({ ...trial, event_date: e.target.value })} /></div>
          <div style={{ width: 110 }}><label className="vin-label">From</label>
            <input className="vin-input" type="time" value={trial.start_time}
                   onChange={(e) => setTrial({ ...trial, start_time: e.target.value })} /></div>
          <div style={{ width: 110 }}><label className="vin-label">To</label>
            <input className="vin-input" type="time" value={trial.end_time}
                   onChange={(e) => setTrial({ ...trial, end_time: e.target.value })} /></div>
          <button className="vin-btn" onClick={runPreview}>Check</button>
        </div>
        {preview && <TermsResult t={preview} />}
      </div>

      <Drawer open={!!form} title={form?.id ? form.name : 'New terms'}
              onClose={() => setForm(null)}
              footer={form && (<>
                <button className="vin-btn" onClick={() => setForm(null)}>Cancel</button>
                <button className="vin-btn vin-btn-primary" disabled={!form.name} onClick={save}>Save</button>
              </>)}>
        {form && (<>
          <div><label className="vin-label">Name — this is what explains the charge to a customer</label>
            <input className="vin-input" value={form.name}
                   onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>

          <div className="vin-label" style={{ marginTop: 14 }}>Applies when</div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">Min guests</label>
              <input className="vin-input" type="number" placeholder="any" value={form.min_guests ?? ''}
                     onChange={(e) => setForm({ ...form, min_guests: e.target.value })} /></div>
            <div><label className="vin-label">Max guests</label>
              <input className="vin-input" type="number" placeholder="any" value={form.max_guests ?? ''}
                     onChange={(e) => setForm({ ...form, max_guests: e.target.value })} /></div>
          </div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">Venue</label>
              <select className="vin-select" value={form.location_id || ''}
                      onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
                <option value="">Either</option>
                {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select></div>
            <div><label className="vin-label">Hours</label>
              <select className="vin-select" value={form.during_business_hours ?? ''}
                      onChange={(e) => setForm({ ...form, during_business_hours: e.target.value })}>
                <option value="">Either</option>
                <option value="true">During open hours</option>
                <option value="false">After hours</option>
              </select></div>
          </div>

          <div className="vin-label" style={{ marginTop: 16 }}>
            Then — leave anything blank that this row should not decide
          </div>
          <div><label className="vin-label">Availability</label>
            <select className="vin-select" value={form.availability || ''}
                    onChange={(e) => setForm({ ...form, availability: e.target.value })}>
              <option value="">Doesn’t say</option>
              <option value="available">Bookable</option>
              <option value="on_request">By request only — needs a manager to agree</option>
              <option value="unavailable">Not available</option>
            </select></div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">Venue fee ($ per hour)</label>
              <input className="vin-input" type="number" step="0.01" placeholder="—"
                     value={toDollars(form.hourly_rate_cents)}
                     onChange={(e) => setForm({ ...form, hourly_rate_cents: toCents(e.target.value) })} /></div>
            <div><label className="vin-label">Min wine purchase ($)</label>
              <input className="vin-input" type="number" step="0.01" placeholder="—"
                     value={toDollars(form.min_wine_purchase_cents)}
                     onChange={(e) => setForm({ ...form, min_wine_purchase_cents: toCents(e.target.value) })} /></div>
          </div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">Booking deposit ($) — 0 means none</label>
              <input className="vin-input" type="number" step="0.01" placeholder="—"
                     value={toDollars(form.booking_deposit_cents)}
                     onChange={(e) => setForm({ ...form, booking_deposit_cents: toCents(e.target.value) })} /></div>
            <div><label className="vin-label">Security deposit ($) — refundable</label>
              <input className="vin-input" type="number" step="0.01" placeholder="—"
                     value={toDollars(form.security_deposit_cents)}
                     onChange={(e) => setForm({ ...form, security_deposit_cents: toCents(e.target.value) })} /></div>
          </div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">…or deposit as % of rental</label>
              <input className="vin-input" type="number" step="1" placeholder="—"
                     value={form.booking_deposit_pct ?? ''}
                     onChange={(e) => setForm({ ...form, booking_deposit_pct: e.target.value })} /></div>
            <div><label className="vin-label">Balance due days before</label>
              <input className="vin-input" type="number" placeholder="—"
                     value={form.balance_due_days_before ?? ''}
                     onChange={(e) => setForm({ ...form, balance_due_days_before: e.target.value })} /></div>
          </div>
          <p className="pe-req-why" style={{ margin: '2px 0 10px' }}>
            A dollar deposit wins over the percentage when both are set.
          </p>
          {form.base_price_cents != null && form.base_price_cents !== '' && (
            <div>
              <label className="vin-label">Old flat fee ($) — used only until an hourly rate is set</label>
              <input className="vin-input" type="number" step="0.01"
                     value={toDollars(form.base_price_cents)}
                     onChange={(e) => setForm({ ...form, base_price_cents: toCents(e.target.value) })} />
              <p className="pe-req-why">
                Clear this once the hourly rate is right. It was not converted
                automatically because that needs a number of hours nobody has stated.
              </p>
            </div>
          )}
          <div className="vin-drawer-row">
            <div><label className="vin-label">Insurance</label>
              <select className="vin-select" value={form.insurance_required ?? ''}
                      onChange={(e) => setForm({ ...form, insurance_required: e.target.value })}>
                <option value="">Doesn’t say</option>
                <option value="true">Required</option>
                <option value="false">Not required</option>
              </select></div>
            <div><label className="vin-label">Contract</label>
              <select className="vin-select" value={form.contract_required ?? ''}
                      onChange={(e) => setForm({ ...form, contract_required: e.target.value })}>
                <option value="">Doesn’t say</option>
                <option value="true">Required</option>
                <option value="false">Not required</option>
              </select></div>
          </div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">Planning meeting, days ahead</label>
              <input className="vin-input" type="number" placeholder="—"
                     value={form.planning_meeting_days ?? ''}
                     onChange={(e) => setForm({ ...form, planning_meeting_days: e.target.value })} /></div>
            <div><label className="vin-label">Parking attendant over</label>
              <input className="vin-input" type="number" placeholder="—"
                     value={form.parking_attendant_over ?? ''}
                     onChange={(e) => setForm({ ...form, parking_attendant_over: e.target.value })} /></div>
          </div>

          {sections.length > 0 && (
            <div>
              <label className="vin-label">Contract clauses this adds</label>
              <div style={{ display: 'grid', gap: 4, maxHeight: 190, overflowY: 'auto' }}>
                {sections.map((sec) => {
                  const on = (form.contract_section_keys || []).includes(sec.key);
                  return (
                    <label key={sec.key} style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'baseline' }}>
                      <input type="checkbox" checked={on} onChange={(e) => {
                        const cur = new Set(form.contract_section_keys || []);
                        if (e.target.checked) cur.add(sec.key); else cur.delete(sec.key);
                        setForm({ ...form, contract_section_keys: [...cur] });
                      }} />
                      <span>{sec.heading || sec.key}</span>
                    </label>
                  );
                })}
              </div>
              <p className="pe-req-why">
                Leave all unticked for “this row doesn’t decide the clauses”.
              </p>
            </div>
          )}

          <div><label className="vin-label">Note to the customer — appears in the proposal</label>
            <textarea rows={3} className="vin-textarea" value={form.notes_to_customer || ''}
                      onChange={(e) => setForm({ ...form, notes_to_customer: e.target.value })} /></div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={form.active !== false}
                   onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            <span>Active</span>
          </label>
        </>)}
      </Drawer>
    </>
  );
}

/**
 * The resolved package, with the row that supplied each number.
 *
 * The provenance is the point: "why am I being charged a security deposit" has to be
 * answerable with a row name, and a blank has to read as "nothing configured" rather
 * than as a decision to charge nothing.
 */
function TermsResult({ t }) {
  const line = (label, value, src) => (
    <div className="pe-req-line" key={label}>
      <span>{label}</span>
      <span style={{ textAlign: 'right' }}>
        <strong>{value}</strong>
        <div className="pe-req-why">{src ? src.name : 'nothing configured'}</div>
      </span>
    </div>
  );
  const s = t.sources || {};
  const amt = (c) => (c == null ? '—' : c === 0 ? 'none' : money(c));

  return (
    <div style={{ marginTop: 10 }}>
      <p className="pe-req-why" style={{ marginTop: 0 }}>
        {t.guests ?? '?'} guests ·{' '}
        {t.duringBusinessHours === null ? 'hours unknown — no time or venue given'
          : t.duringBusinessHours ? 'during open hours' : 'after hours'}
        {t.matched?.length ? ` · ${t.matched.length} row(s) applied` : ' · no rows applied'}
      </p>
      {t.availability !== 'available' && (
        <div className="vin-pill vin-pill-danger" style={{ display: 'block', padding: 10, marginBottom: 8 }}>
          {t.availability === 'unavailable'
            ? 'Not available — this booking should be declined.'
            : 'By request only — a manager has to agree before quoting.'}
        </div>
      )}
      {line('Venue fee',
        t.rental_total_cents != null
          ? `${money(t.rental_total_cents)}${t.rental_basis === 'hourly' && t.hours ? ` (${t.hours}h × ${money(t.hourly_rate_cents)})` : ''}`
          : t.hourly_rate_cents != null ? `${money(t.hourly_rate_cents)}/hour — needs times` : '—',
        s.hourly_rate_cents || s.base_price_cents)}
      {line('Min wine purchase', amt(t.min_wine_purchase_cents), s.min_wine_purchase_cents)}
      {line('Booking deposit', amt(t.booking_deposit_cents),
        s.booking_deposit_cents || s.booking_deposit_pct)}
      {line('Security deposit', amt(t.security_deposit_cents), s.security_deposit_cents)}
      {t.due_now_cents != null && (
        <div className="pe-req-line"><span>Due up front</span>
          <span style={{ textAlign: 'right' }}><strong>{money(t.due_now_cents)}</strong>
            <div className="pe-req-why">booking deposit + security deposit</div></span></div>
      )}
      {line('Contract', t.contract_required ? 'Required' : 'Not required', s.contract_required)}
      {line('Insurance', t.insurance_required ? 'Required' : 'Not required', s.insurance_required)}
      {t.balance_due_days_before != null &&
        line('Balance due', `${t.balance_due_days_before} days before`, s.balance_due_days_before)}
      {t.planning_meeting_days != null &&
        line('Planning meeting', `${t.planning_meeting_days} days ahead`, s.planning_meeting_days)}
      {t.parking_attendant_over != null && (t.guests ?? 0) > t.parking_attendant_over &&
        line('Parking attendant', 'Required', s.parking_attendant_over)}
      {t.contract_required && (
        line('Contract clauses', t.contract_section_keys?.length
          ? `${t.contract_section_keys.length} selected` : 'all defaults', s.contract_section_keys)
      )}
      {t.notes_to_customer && (
        <div style={{ marginTop: 8 }}>
          <div className="vin-label">Note to the customer</div>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{t.notes_to_customer}</div>
        </div>
      )}
    </div>
  );
}

/**
 * The clause library a contract is assembled from.
 *
 * Which sections a given booking's contract carries is decided by the terms; this
 * is what they choose from. Sections marked "always" go in every contract; the rest
 * are pulled in by key.
 *
 * Editing a section here does NOT alter a contract already signed — that is rendered
 * to a snapshot with a hash of exactly what was shown. This is the source for future
 * contracts, not the record of past ones.
 */
function ContractSectionsTab() {
  const [list, setList] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    getContractSections().then((d) => setList(d.sections || [])).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const blank = { title: '', key: '', body: '', sort_order: (list.length + 1) * 10,
    always_include: false, active: true };

  const save = async () => {
    try {
      if (form.id) await updateContractSection(form.id, form);
      else await createContractSection(form);
      setForm(null); setErr(''); load();
    } catch (e) { setErr(e.message); }
  };

  return (
    <>
      <div className="pe-head">
        <button className="vin-btn vin-btn-primary" onClick={() => setForm({ ...blank })}>
          Add section
        </button>
        <span style={{ fontSize: 12, color: 'var(--vin-muted)' }}>
          {list.filter((x) => x.always_include).length} always included ·{' '}
          {list.filter((x) => !x.always_include).length} chosen by terms
        </span>
      </div>
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}

      {list.length === 0 && (
        <div className="pe-empty">
          No contract sections yet.<br />
          Start with the clauses every contract needs — cancellation, liability,
          alcohol service — and mark them “always include”.
        </div>
      )}

      {list.map((sec) => (
        <div key={sec.id} className="pe-req-line">
          <span style={{ minWidth: 0 }}>
            <strong>{sec.title}</strong>
            {sec.always_include && <span className="vin-pill vin-pill-accent" style={{ marginLeft: 6 }}>always</span>}
            {!sec.active && <span className="vin-pill vin-pill-muted" style={{ marginLeft: 6 }}>inactive</span>}
            <div className="pe-req-why">
              <code>{sec.key}</code> · order {sec.sort_order} ·{' '}
              {(sec.body || '').trim() ? `${sec.body.trim().slice(0, 70)}…` : 'no text yet'}
            </div>
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="vin-btn" onClick={() => setForm({ ...sec })}>Edit</button>
            <button className="vin-btn vin-btn-danger" onClick={async () => {
              if (!window.confirm(`Delete “${sec.title}”?\n\nContracts already signed keep their text — they are stored as a snapshot. Any term referencing “${sec.key}” will stop finding it.`)) return;
              await deleteContractSection(sec.id); load();
            }}>Delete</button>
          </span>
        </div>
      ))}

      <Drawer open={!!form} title={form?.id ? `Edit ${form.title}` : 'New contract section'}
              onClose={() => setForm(null)}
              footer={form && (<>
                <button className="vin-btn" onClick={() => setForm(null)}>Cancel</button>
                <button className="vin-btn vin-btn-primary" disabled={!form.title} onClick={save}>Save</button>
              </>)}>
        {form && (<>
          <div><label className="vin-label">Title</label>
            <input className="vin-input" value={form.title}
                   onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
          <div><label className="vin-label">
            Key — what the terms reference. Changing it orphans any term pointing at the old one.
          </label>
            <input className="vin-input" value={form.key}
                   placeholder="left blank, made from the title"
                   onChange={(e) => setForm({ ...form, key: e.target.value })} /></div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">Order in the contract</label>
              <input className="vin-input" type="number" value={form.sort_order}
                     onChange={(e) => setForm({ ...form, sort_order: e.target.value })} /></div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, paddingBottom: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={!!form.always_include}
                       onChange={(e) => setForm({ ...form, always_include: e.target.checked })} />
                <span>Always</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={form.active !== false}
                       onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                <span>Active</span>
              </label>
            </div>
          </div>
          <div><label className="vin-label">Clause text</label>
            <textarea rows={10} className="vin-textarea" value={form.body || ''}
                      onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
          <p style={{ fontSize: 11.5, color: 'var(--vin-muted)', margin: 0 }}>
            Editing this does not change a contract already signed — those are stored
            as a snapshot of exactly what the customer saw.
          </p>
        </>)}
      </Drawer>
    </>
  );
}

export default PrivateEvents;
