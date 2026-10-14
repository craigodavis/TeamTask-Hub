import { useState, useEffect, useCallback, Fragment } from 'react';
import {
  getPrivateEventCalendar, getPrivateEventBoard, sendEventContract, sendEventProposal,
  countersignEventContract,
  getEventTerms, createEventTerm, updateEventTerm,
  deleteEventTerm, duplicateEventTerm, previewEventTerms, evaluateEventRequest, updateEventRequest,
  getSpecialRequests, addSpecialRequest, decideSpecialRequest, saveStaffNotes, saveEventOverrides,
  getEventJournal, markResosBooked, getNotifySettings, saveNotifySettings,
  getLocations, getContractSections, createContractSection,
  updateContractSection, deleteContractSection,
} from '../api';
import Drawer from '../components/Drawer';
import { Requests, Copy } from './EventRequests';
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
        {[['flow', 'Flow'], ['calendar', 'Calendar'], ['requests', 'Requests inbox'],
          ['terms', 'Terms'], ['copy', 'Message'], ['contract', 'Contract'], ['settings', 'Settings']].map(([k, l]) => (
          <button key={k} className={`vin-btn${tab === k ? ' vin-btn-primary' : ''}`}
                  onClick={() => { setTab(k); setErr(''); }}>{l}</button>
        ))}
      </div>
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}
      {tab === 'flow' && <FlowTab />}
      {tab === 'calendar' && <CalendarTab />}
      {tab === 'requests' && <RequestsInbox onError={setErr} />}
      {tab === 'copy' && <Copy onError={setErr} />}
      {tab === 'terms' && <TermsTab />}
      {tab === 'contract' && <ContractSectionsTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}

/** The inbox, with the same slide-out the calendar uses. */
function RequestsInbox({ onError }) {
  const [sel, setSel] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <>
      <Requests key={reloadKey} onError={onError} onOpen={setSel} />
      <RequestDrawer request={sel} onClose={() => setSel(null)}
                     onChanged={() => { setSel(null); setReloadKey((k) => k + 1); }} />
    </>
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

      <RequestDrawer request={sel} onClose={() => setSel(null)} onChanged={load} />
    </>
  );
}

/**
 * Change the proposal for this one booking.
 *
 * Every field shows what the terms worked out, and an empty box means "leave it at
 * that". Typing a number overrides it for this booking only; clearing the box gives
 * it back to the terms rather than pinning it to nothing. The two are stored apart,
 * so months later "what are we charging" and "why is it different from the price
 * list" both still have answers.
 */
function Overrides({ request, onSaved }) {
  const base = request.requirements || {};
  const over = request.overrides || {};
  const [form, setForm] = useState(() => ({
    rental_total_cents: over.rental_total_cents ?? '',
    min_wine_purchase_cents: over.min_wine_purchase_cents ?? '',
    booking_deposit_cents: over.booking_deposit_cents ?? '',
    security_deposit_cents: over.security_deposit_cents ?? '',
    insurance_required: over.insurance_required === undefined ? '' : String(over.insurance_required),
    contract_required: over.contract_required === undefined ? '' : String(over.contract_required),
    notes_to_customer: over.notes_to_customer ?? '',
  }));
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  const dollars = (c) => (c == null ? '' : String(c / 100));
  const asCents = (d) => (d === '' || d == null ? '' : Math.round(Number(d) * 100));
  const was = (k) => (base[k] == null ? 'not set' : `${money(base[k])} from the terms`);

  const money$ = (key, label) => (
    <div key={key}>
      <label className="vin-label">{label}</label>
      <input className="vin-input" type="number" step="0.01" placeholder={was(key)}
             value={dollars(form[key] === '' ? null : form[key])}
             onChange={(e) => { setForm({ ...form, [key]: asCents(e.target.value) }); setSaved(false); }} />
    </div>
  );

  const yesNo = (key, label) => (
    <div key={key}>
      <label className="vin-label">{label}</label>
      <select className="vin-select" value={form[key]}
              onChange={(e) => { setForm({ ...form, [key]: e.target.value }); setSaved(false); }}>
        <option value="">Leave as the terms say ({base[key] ? 'required' : 'not required'})</option>
        <option value="true">Required</option>
        <option value="false">Not required</option>
      </select>
    </div>
  );

  const save = async () => {
    try {
      const body = {};
      for (const [k, v] of Object.entries(form)) {
        if (v === '') continue;
        body[k] = (k === 'insurance_required' || k === 'contract_required') ? v === 'true' : v;
      }
      // Fields left blank are sent as null so the server releases them back to the
      // terms; sending nothing at all would leave an old override in place.
      for (const k of Object.keys(form)) if (!(k in body)) body[k] = null;
      await saveEventOverrides(request.id, body);
      setErr(''); setSaved(true); onSaved?.();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '0.5px solid var(--vin-border)' }}>
      <div className="vin-label">Change this proposal</div>
      <p className="pe-req-why" style={{ marginTop: 0 }}>
        Leave a box empty to keep what the terms worked out. Anything you set here
        applies to this booking only.
      </p>
      <div className="vin-drawer-row">
        {money$('rental_total_cents', 'Venue fee ($)')}
        {money$('min_wine_purchase_cents', 'Minimum wine purchase ($)')}
      </div>
      <div className="vin-drawer-row">
        {money$('booking_deposit_cents', 'Booking deposit ($)')}
        {money$('security_deposit_cents', 'Security deposit ($)')}
      </div>
      <div className="vin-drawer-row">
        {yesNo('insurance_required', 'Insurance')}
        {yesNo('contract_required', 'Contract')}
      </div>
      <div>
        <label className="vin-label">Note to the customer — appears on the proposal</label>
        <textarea rows={2} className="vin-textarea" value={form.notes_to_customer || ''}
                  onChange={(e) => { setForm({ ...form, notes_to_customer: e.target.value }); setSaved(false); }} />
      </div>
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}
      <button className="vin-btn vin-btn-primary" style={{ marginTop: 8 }} onClick={save}>
        {saved ? 'Saved — resend the proposal to show them' : 'Save changes'}
      </button>
    </div>
  );
}

/**
 * What the customer asked for, and what we agreed to.
 *
 * Every item is decided explicitly. Asking is not agreeing, so nothing reaches the
 * contract until somebody rules on it — and "modified" carries OUR wording, because
 * agreeing to a changed version of a request means agreeing to the change, not to
 * what was asked.
 */
function SpecialRequests({ requestId, onChanged }) {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState(null);   // { id, text }

  const load = useCallback(() => {
    getSpecialRequests(requestId).then((d) => setItems(d.items || [])).catch((e) => setErr(e.message));
  }, [requestId]);
  useEffect(() => { load(); }, [load]);

  const decide = async (it, status, agreed_text) => {
    try {
      await decideSpecialRequest(it.id, { status, agreed_text });
      setEditing(null); setErr(''); load(); onChanged?.();
    } catch (e) { setErr(e.message); }
  };

  if (!items) return <p className="pe-req-why">Loading…</p>;

  const LABEL = { pending: 'Not decided', approved: 'Agreed', modified: 'Agreed, reworded', rejected: 'Declined' };

  return (
    <div style={{ marginTop: 16 }}>
      <div className="vin-label">Special requests</div>
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}
      {items.length === 0 && <p className="pe-req-why">Nothing asked for yet.</p>}

      {items.map((it) => (
        <div key={it.id} className="pe-boardrow" style={{ padding: '10px 2px' }}>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{it.body}</div>
          <div className="pe-req-why">
            {it.source === 'staff' ? 'added by us' : 'from the customer'} · {LABEL[it.status]}
          </div>
          {it.agreed_text && (
            <div style={{ fontSize: 13, marginTop: 6, paddingLeft: 10,
                          borderLeft: '2px solid var(--vin-text-accent)' }}>
              {it.agreed_text}
            </div>
          )}

          {editing?.id === it.id ? (
            <div style={{ marginTop: 8 }}>
              <label className="vin-label">What we are agreeing to — this is what goes in the contract</label>
              <textarea rows={3} className="vin-textarea" value={editing.text}
                        onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button className="vin-btn vin-btn-primary" disabled={!editing.text.trim()}
                        onClick={() => decide(it, 'modified', editing.text)}>Agree to this wording</button>
                <button className="vin-btn" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {it.status !== 'approved' && (
                <button className="vin-btn" onClick={() => decide(it, 'approved')}>Agree as asked</button>
              )}
              <button className="vin-btn"
                      onClick={() => setEditing({ id: it.id, text: it.agreed_text || it.body })}>
                Agree with changes
              </button>
              {it.status !== 'rejected' && (
                <button className="vin-btn vin-btn-danger" onClick={() => decide(it, 'rejected')}>Decline</button>
              )}
              {it.status !== 'pending' && (
                <button className="vin-btn" onClick={() => decide(it, 'pending')}>Undo</button>
              )}
            </div>
          )}
        </div>
      ))}

      <div style={{ marginTop: 10 }}>
        <label className="vin-label">Add one — what was asked for on the phone belongs here too</label>
        <textarea rows={2} className="vin-textarea" value={adding}
                  onChange={(e) => setAdding(e.target.value)} />
        <button className="vin-btn" disabled={!adding.trim()} style={{ marginTop: 6 }}
                onClick={async () => {
                  try { await addSpecialRequest(requestId, adding); setAdding(''); setErr(''); load(); }
                  catch (e) { setErr(e.message); }
                }}>Add</button>
      </div>
    </div>
  );
}

/** Notes only we see. Kept apart from anything the customer wrote or will read. */
function StaffNotes({ r }) {
  const [text, setText] = useState(r.staff_notes || '');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setText(r.staff_notes || ''); setSaved(false); }, [r.id, r.staff_notes]);
  return (
    <div style={{ marginTop: 16 }}>
      <div className="vin-label">Our notes — the customer never sees these</div>
      <textarea rows={3} className="vin-textarea" value={text}
                onChange={(e) => { setText(e.target.value); setSaved(false); }} />
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}
      <button className="vin-btn" style={{ marginTop: 6 }}
              onClick={async () => {
                try { await saveStaffNotes(r.id, text); setSaved(true); setErr(''); }
                catch (e) { setErr(e.message); }
              }}>{saved ? 'Saved' : 'Save notes'}</button>
    </div>
  );
}

/**
 * The slide-out for one request, with the decisions that can be made on it.
 *
 * Shared by the calendar and the inbox rather than written twice: the same booking
 * reached two ways should offer the same actions, and a second copy is how one of
 * them quietly falls behind.
 *
 * Cancel is not decline. Declining is us saying no; cancelling is an enquiry that
 * went quiet and is being cleared off the list. They read differently a year later,
 * so they are separate buttons rather than one with a dropdown.
 */
/**
 * Who hears about what, by text.
 *
 * A grid rather than one "notify the managers" list: somebody can take contract
 * signings without also taking every new enquiry. A single list is how people end up
 * muting the lot, and then nobody hears about the one that mattered.
 */
function SettingsTab() {
  const [data, setData] = useState(null);
  const [chosen, setChosen] = useState(new Set());
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  const key = (u, a) => `${u}|${a}`;
  useEffect(() => {
    getNotifySettings().then((d) => {
      setData(d);
      setChosen(new Set((d.chosen || []).map((c) => key(c.user_id, c.action))));
    }).catch((e) => setErr(e.message));
  }, []);

  if (err) return <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>;
  if (!data) return <div className="pe-empty">Loading…</div>;

  const actions = Object.entries(data.actions);
  // Only people who can actually receive a text. Showing the rest would offer a
  // choice that silently does nothing.
  const people = (data.people || []).filter((p) => p.phone);
  const without = (data.people || []).length - people.length;

  const toggle = (u, a) => {
    const k = key(u, a);
    const next = new Set(chosen);
    if (next.has(k)) next.delete(k); else next.add(k);
    setChosen(next); setSaved(false);
  };

  const save = async () => {
    try {
      await saveNotifySettings([...chosen].map((k) => {
        const [user_id, action] = k.split('|');
        return { user_id, action };
      }));
      setErr(''); setSaved(true);
    } catch (e) { setErr(e.message); }
  };

  return (
    <>
      <div className="vin-label">Who gets a text, and when</div>
      <p className="pe-req-why" style={{ marginTop: 0 }}>
        Every action on a booking is journaled. These are the ones that also send a
        text at the moment they happen.
      </p>

      <div className="pe-notify-wrap">
        <table className="pe-notify">
          <thead>
            <tr>
              <th>Action</th>
              {people.map((p) => <th key={p.id}>{p.display_name || p.email}</th>)}
            </tr>
          </thead>
          <tbody>
            {actions.map(([a, label]) => (
              <tr key={a}>
                <td>{label}</td>
                {people.map((p) => (
                  <td key={p.id}>
                    <input type="checkbox" checked={chosen.has(key(p.id, a))}
                           onChange={() => toggle(p.id, a)}
                           aria-label={`${label} to ${p.display_name || p.email}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {without > 0 && (
        <p className="pe-req-why">
          {without} {without === 1 ? 'person has' : 'people have'} no phone number on file
          and {without === 1 ? 'is' : 'are'} not listed — texts cannot reach them.
        </p>
      )}
      <button className="vin-btn vin-btn-primary" style={{ marginTop: 10 }} onClick={save}>
        {saved ? 'Saved' : 'Save'}
      </button>
    </>
  );
}

/** What has happened to this booking, newest first. */
function Journal({ requestId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { getEventJournal(requestId).then((d) => setRows(d.entries || [])).catch(() => setRows([])); },
    [requestId]);
  if (!rows) return null;
  if (!rows.length) return null;

  const LABEL = {
    request_received: 'Enquiry received', approved: 'Approved', declined: 'Declined',
    cancelled: 'Cancelled', new: 'Reopened', complete: 'Marked finished',
    proposal_sent: 'Proposal sent', proposal_accepted: 'Proposal accepted',
    proposal_declined: 'Proposal turned down', special_request: 'They asked for something',
    ask_approved: 'Request agreed', ask_modified: 'Request agreed, reworded',
    ask_rejected: 'Request declined', ask_pending: 'Request reopened',
    contract_sent: 'Contract sent', contract_signed: 'Contract signed by customer',
    contract_executed: 'Contract counter-signed', deposit_paid: 'Deposit received',
    insurance_ok: 'Insurance accepted', resos_booked: 'Tables reserved in ResOS',
    resos_cleared: 'ResOS booking cleared', terms_changed: 'Terms changed',
  };

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '0.5px solid var(--vin-border)' }}>
      <div className="vin-label">Journal</div>
      {rows.map((e, i) => (
        <div key={i} className="pe-req-line">
          <span>
            <strong>{LABEL[e.action] || e.action}</strong>
            {e.detail && <div className="pe-req-why">{e.detail}</div>}
          </span>
          <span style={{ textAlign: 'right' }}>
            <div className="pe-req-why">{new Date(e.created_at).toLocaleString()}</div>
            {e.actor_name && <div className="pe-req-why">{e.actor_name}</div>}
          </span>
        </div>
      ))}
    </div>
  );
}

function RequestDrawer({ request, onClose, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [row, setRow] = useState(request);
  useEffect(() => { setRow(request); setErr(''); }, [request]);

  if (!row) return <Drawer open={false} onClose={onClose} />;

  const act = async (fn) => {
    setBusy(true);
    try { await fn(); setErr(''); onChanged?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const setStatus = (status) => act(async () => {
    await updateEventRequest(row.id, { status });
    onClose();
  });

  const closed = ['declined', 'cancelled', 'withdrawn'].includes(row.status);

  return (
    <Drawer open={!!row} title={`${row.name} — ${row.guests} guests`} onClose={onClose}
            footer={(
              <>
                {closed ? (
                  <button className="vin-btn" disabled={busy} onClick={() => setStatus('new')}>
                    Reopen
                  </button>
                ) : (<>
                  <button className="vin-btn" disabled={busy} onClick={() => setStatus('cancelled')}>
                    Cancel
                  </button>
                  <button className="vin-btn vin-btn-danger" disabled={busy}
                          onClick={() => setStatus('declined')}>Decline</button>
                  <button className="vin-btn" disabled={busy}
                          onClick={() => act(async () => {
                            const out = await evaluateEventRequest(row.id);
                            setRow({ ...row, requirements: out, rules_evaluated_at: out.evaluatedAt });
                          })}>
                    {row.rules_evaluated_at ? 'Re-check terms' : 'Check terms'}
                  </button>
                  <button className="vin-btn vin-btn-primary" disabled={busy}
                          onClick={() => setStatus('approved')}>Approve</button>
                </>)}
              </>
            )}>
      {err && <p className="vin-pill vin-pill-danger" style={{ display: 'block' }}>{err}</p>}
      <RequestDetail r={row} />
      <Journal requestId={row.id} />
    </Drawer>
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

      <Steps r={r} />
      <SpecialRequests requestId={r.id} />
      <StaffNotes r={r} />
    </>
  );
}

/**
 * The ticks that are ours to make: the planning meeting, the insurance certificate,
 * the ResOS booking.
 *
 * These used to sit on the inbox card. They belong with the request, not in a list
 * somebody scans — but they had to come WITH it when the card was trimmed, or the
 * only way to tick the planning meeting would have quietly disappeared.
 */
function Steps({ r }) {
  const [row, setRow] = useState(r);
  const [err, setErr] = useState('');
  useEffect(() => { setRow(r); }, [r]);

  const set = async (patch) => {
    try { const { request } = await updateEventRequest(row.id, patch); setRow(request); setErr(''); }
    catch (e) { setErr(e.message); }
  };

  const resos = async () => {
    const ref = window.prompt('ResOS booking reference (optional)');
    if (ref === null) return;
    try { const out = await markResosBooked(row.id, ref); setRow(out.request); setErr(''); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div className="vin-label">Ours to do</div>
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}

      {row.planningMeetingDue && (
        <label className="pe-step">
          <input type="checkbox" checked={!!row.planning_meeting_booked}
                 onChange={(e) => set({ planning_meeting_booked: e.target.checked })} />
          <span>Planning meeting booked
            <span className="pe-req-why"> by {row.planningMeetingDue}</span></span>
        </label>
      )}

      <label className="pe-step">
        <input type="checkbox" checked={!!row.insurance_ok}
               disabled={!row.insurance_uploaded_at}
               onChange={(e) => set({ insurance_ok: e.target.checked })} />
        <span>Proof of insurance accepted
          {!row.insurance_uploaded_at && <span className="pe-req-why"> — nothing uploaded yet</span>}</span>
      </label>

      {/* Not a checkbox: it asks for the reference, because a tick records that
          somebody said they did it and a reference records something checkable. */}
      <div className="pe-step">
        <span>
          {row.resos_booked_at
            ? <>Tables reserved in ResOS
                <span className="pe-req-why"> {row.resos_reference || ''} ·{' '}
                  {new Date(row.resos_booked_at).toLocaleDateString()}</span></>
            : 'Tables not yet reserved in ResOS'}
        </span>
        {!row.resos_booked_at && (
          <button className="vin-btn" style={{ marginLeft: 10 }} onClick={resos}>Mark reserved</button>
        )}
      </div>
    </div>
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
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [reviewing, setReviewing] = useState(null);
  const [opened, setOpened] = useState(null);
  const [turn, setTurn] = useState(null);

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

  /**
   * The button dispatches on an explicit kind, never on a gate key.
   *
   * It used to map the key to whichever action belonged to our side of that gate,
   * so a button labelled "Chase" on a deposit row recorded the deposit as paid.
   * The server now names the act; this only has to carry it out.
   */
  const doAction = async (row) => {
    const kind = row.action?.kind;
    // Opens the asks for a decision rather than doing anything: a ruling on what
    // somebody requested is a judgement, not a button press.
    if (kind === 'review_asks') { setReviewing(row); return; }
    if (kind === 'resos_booked') {
      // Asks for the ResOS reference rather than just ticking a box: a tick records
      // that somebody said they did it, a reference records something checkable.
      const ref = window.prompt(
        `Tables reserved in ResOS for ${row.name}?\n\nPaste the ResOS booking reference if you have one.`);
      if (ref === null) return;
      setBusy(row.id);
      try { await markResosBooked(row.id, ref); setErr(''); setNote('Tables marked as reserved.'); load(); }
      catch (e) { setErr(e.message); }
      finally { setBusy(null); }
      return;
    }
    if (kind === 'send_proposal') {
      setBusy(row.id);
      try {
        const out = await sendEventProposal(row.id);
        setErr(''); setNote(`Proposal emailed to ${out.sentTo}.`); load();
      } catch (e) { setErr(e.message); setNote(''); }
      finally { setBusy(null); }
      return;
    }
    if (kind === 'send_contract') {
      setBusy(row.id);
      try {
        const out = await sendEventContract(row.id);
        setErr('');
        setNote(`Contract emailed to ${out.sentTo}.`);
        load();
      } catch (e) { setErr(e.message); setNote(''); }
      finally { setBusy(null); }
      return;
    }
    if (kind === 'countersign') {
      setBusy(row.id);
      try {
        const out = await countersignEventContract(row.id);
        setErr(''); setNote(`Counter-signed by ${out.signedName}.`); load();
      } catch (e) { setErr(e.message); setNote(''); }
      finally { setBusy(null); }
      return;
    }
    const patch = {
      evaluate: null,
      approve: { status: 'approved' },
      insurance_ok: { insurance_ok: true },
      deposit_paid: { deposit_paid: true },
    }[kind];

    if (kind === 'evaluate') {
      setBusy(row.id);
      try { await evaluateEventRequest(row.id); setErr(''); load(); }
      catch (e) { setErr(e.message); }
      finally { setBusy(null); }
      return;
    }
    // Recording money or an approval is not undoable from this screen, so it asks.
    if ((kind === 'deposit_paid' || kind === 'insurance_ok')
        && !window.confirm(`${row.action.label} for ${row.name}?`)) return;
    if (patch) await act(row, patch);
  };

  if (!data) {
    return err ? <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>
      : <div className="pe-empty">Loading…</div>;
  }

  // The two filters narrow together: "Proposals that need you" is a real question
  // and neither axis answers it alone.
  const rows = data.rows
    .filter((r) => (bucket ? r.buckets.includes(bucket) : true))
    .filter((r) => (turn ? r.turn === turn : true));
  const BOXES = [
    ['requests', 'Requests inbox'], ['proposals', 'Proposals'],
    ['contracts', 'Contracts'], ['outstanding', 'Outstanding'],
  ];
  const sub = (k) => {
    const c = data.counts[k] || {};
    if (!c.total) return 'nothing';
    if (k === 'ready') return `${c.total} good to go`;
    if (k === 'completed') return `${c.total} done`;
    if (c.ours && c.theirs) return `${c.ours} you · ${c.theirs} them`;
    return c.ours ? `${c.ours} need you` : `${c.theirs} with them`;
  };

  return (
    <>
      {/* An error here is about one action, not the whole board, so it sits above
          the rows rather than replacing them. */}
      {err && <p className="vin-pill vin-pill-danger" style={{ display: 'block' }}>{err}</p>}
      {note && <p className="vin-pill" style={{ display: 'block' }}>{note}</p>}
      {/* Whose move it is, across every stage. The strip below says where things are;
          these say who is holding them, which is the other question — and the one you
          ask first thing in the morning. Clicking one narrows the list to it. */}
      <div className="pe-tallies">
        {[['ours', 'Need you', data.needsYou], ['theirs', 'With them', data.withThem],
          ['done', 'Settled', data.settled]].map(([k, label, n]) => (
          <button key={k} className={`pe-tally${turn === k ? ' on' : ''}`}
                  aria-pressed={turn === k}
                  onClick={() => setTurn(turn === k ? null : k)}>
            <span className="pe-tally-n"
                  style={{ color: k === 'ours' && n ? 'var(--vin-text-danger)' : undefined }}>{n}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>

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
      <div className="pe-filterbar">
        <span>Showing</span>
        <strong>
          {bucket ? BOXES.find(([k]) => k === bucket)?.[1] : 'Everything'}
          {turn ? ` · ${{ ours: 'needing you', theirs: 'with them', done: 'settled' }[turn]}` : ''}
          {' · '}{rows.length}
        </strong>
        {(bucket || turn) && (
          <button className="vin-btn" onClick={() => { setBucket(null); setTurn(null); }}>Show all</button>
        )}
      </div>

      {rows.length === 0 && (
        <div className="pe-empty">
          {bucket ? 'Nothing in that one.'
            : 'No enquiries yet. The board fills itself as requests come in.'}
        </div>
      )}

      {rows.map((r) => (
        <div key={r.id} className="pe-boardrow">
          <div className="pe-boardrow-top">
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* The name opens the slide-out, the same one the calendar and the
                  inbox use. A button rather than a click on the row, so it reaches
                  the keyboard and does not swallow the action beside it. */}
              <button type="button" className="pe-rowopen" onClick={() => setOpened(r)}>
                {r.name}
              </button>
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

      {/* The full request, reached by clicking any row on the board. */}
      <RequestDrawer request={opened} onClose={() => setOpened(null)}
                     onChanged={() => { setOpened(null); load(); }} />

      <Drawer open={!!reviewing} title={reviewing ? `${reviewing.name} — what they asked for` : ''}
              onClose={() => { setReviewing(null); load(); }}
              footer={<button className="vin-btn" onClick={() => { setReviewing(null); load(); }}>Done</button>}>
        {reviewing && (<>
          <SpecialRequests requestId={reviewing.id} onChanged={load} />
          <Overrides request={reviewing} onSaved={load} />
          {/* Answering an ask usually means the proposal has changed, so resending
              is here rather than back on the board. */}
          <button className="vin-btn" style={{ marginTop: 12 }} disabled={busy === reviewing.id}
                  onClick={async () => {
                    setBusy(reviewing.id);
                    try {
                      const out = await sendEventProposal(reviewing.id);
                      setErr(''); setNote(`Updated proposal emailed to ${out.sentTo}.`); load();
                    } catch (e) { setErr(e.message); }
                    finally { setBusy(null); }
                  }}>Resend the proposal</button>
        </>)}
      </Drawer>

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
  const [notice, setNotice] = useState('');
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
      <p className="pe-req-why" style={{ marginTop: 0 }}>
        One source for everything: the public price list, the quote a customer sees,
        this board and the contract all read these rows.
      </p>
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}
      {notice && <p className="pe-req-why" style={{ marginTop: 0 }}>{notice}</p>}

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
            {/* Opens the copy straight away: nobody duplicates a row in order to
                leave it exactly as it was. */}
            <button className="vin-btn" onClick={async () => {
              try { const copy = await duplicateEventTerm(t.id); load(); edit(copy); }
              catch (e) { setErr(e.message); }
            }}>Copy</button>
            <button className="vin-btn vin-btn-danger"
              onClick={async () => {
                // Says what is being let go of. Quotes already given keep their own
                // frozen copy, including the name of the row that set each number,
                // so deleting this cannot make an old quote unexplainable.
                if (!window.confirm(`Delete “${t.name}”?\n\nBookings already quoted keep their own copy of the numbers and of this name, so nothing already quoted changes.`)) return;
                try {
                  const out = await deleteEventTerm(t.id);
                  setErr('');
                  load();
                  if (out.quotedCount) {
                    setNotice(`Deleted “${out.name}”. ${out.quotedCount} ${out.quotedCount === 1 ? 'booking keeps its' : 'bookings keep their'} frozen copy.`);
                  }
                } catch (e) { setErr(e.message); }
              }}>Delete</button>
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

      <Drawer open={!!form}
              title={form?.id ? (form.active === false ? `${form.name} · off` : form.name) : 'New terms'}
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
