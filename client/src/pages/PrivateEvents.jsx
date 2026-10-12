import { useState, useEffect, useCallback } from 'react';
import {
  getPrivateEventCalendar, getEventRules, createEventRule, updateEventRule,
  deleteEventRule, previewEventRules, evaluateEventRequest, updateEventRequest,
  getLocations,
} from '../api';
import Drawer from '../components/Drawer';
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
  if (need.contract?.required && !r.contract_executed_at) {
    return r.contract_customer_signed_at ? 'signed' : 'proposed';
  }
  if (need.deposit?.required && !r.deposit_paid_at) return 'unpaid';
  if (need.insurance?.required && !r.insurance_ok) return 'unpaid';
  if (r.status === 'approved' || r.approved_at) return 'confirmed';
  return 'proposed';
}

const LABEL = {
  new: 'New request', proposed: 'Awaiting customer', signed: 'Awaiting our signature',
  unpaid: 'Payment / insurance outstanding', confirmed: 'Confirmed', declined: 'Declined',
};

export function PrivateEvents() {
  const [tab, setTab] = useState('calendar');
  return (
    <div className="pe">
      <h2 style={{ marginBottom: 4 }}>Private Events</h2>
      <p style={{ fontSize: 13, color: 'var(--vin-muted)', marginTop: 0, marginBottom: 14 }}>
        Enquiries from the website, what they require, and what else is already booked that day.
      </p>
      <div className="pe-tabs" style={{ marginBottom: 14 }}>
        {[['calendar', 'Calendar'], ['rules', 'Rules']].map(([k, l]) => (
          <button key={k} className={`vin-btn${tab === k ? ' vin-btn-primary' : ''}`}
                  onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'calendar' ? <CalendarTab /> : <RulesTab />}
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
                    {sel.rules_evaluated_at ? 'Re-check rules' : 'Check rules'}
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
            Not checked yet — press “Check rules”.
            {(!r.start_time || !r.location_id) &&
              ' Note this request has no time or venue, so hours-based rules cannot apply.'}
          </p>
        ) : (
          <>
            {['deposit', 'contract', 'insurance'].map((k) => (
              <div className="pe-req-line" key={k}>
                <span style={{ textTransform: 'capitalize' }}>{k}</span>
                <span style={{ textAlign: 'right' }}>
                  <strong>{need[k]?.required ? 'Required' : 'Not required'}</strong>
                  {k === 'deposit' && need.deposit?.amountCents ? ` — ${money(need.deposit.amountCents)}` : ''}
                  {/* Which rule decided, so "no deposit" reads as a decision rather
                      than as something nobody got round to. */}
                  <div className="pe-req-why">{need[k]?.ruleName || need[k]?.reason || ''}</div>
                </span>
              </div>
            ))}
            {need.payments?.length > 0 && need.payments.map((p, i) => (
              <div className="pe-req-line" key={i}>
                <span>Payment</span>
                <span style={{ textAlign: 'right' }}>
                  <strong>{p.amountPct ? `${p.amountPct}%` : money(p.amountCents)}</strong>
                  <div className="pe-req-why">
                    {p.dueOffsetDays != null ? `due ${Math.abs(p.dueOffsetDays)} days before` : ''} · {p.name}
                  </div>
                </span>
              </div>
            ))}
            <p className="pe-req-why" style={{ marginTop: 8 }}>
              During business hours:{' '}
              {need.duringBusinessHours === null ? 'unknown (no time or venue given)'
                : need.duringBusinessHours ? 'yes' : 'no'}
              {need.matched?.length ? ` · ${need.matched.length} rule(s) matched` : ' · no rules matched'}
            </p>
          </>
        )}
      </div>
    </>
  );
}

function RulesTab() {
  const [rules, setRules] = useState([]);
  const [venues, setVenues] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(null);
  const [trial, setTrial] = useState({ guests: 15, location_id: '', event_date: '', start_time: '', end_time: '' });

  const load = useCallback(() => {
    getEventRules().then((d) => setRules(d.rules || [])).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); getLocations('venue').then((d) => setVenues(d.locations || [])).catch(() => {}); }, [load]);

  const blank = { name: '', active: true, priority: 100, effect_type: 'deposit',
    min_guests: '', max_guests: '', location_id: '', during_business_hours: '',
    amount_cents: '', due_offset_days: '', customer_text: '' };

  const save = async () => {
    try {
      const body = { ...form };
      if (body.during_business_hours === '') body.during_business_hours = null;
      else body.during_business_hours = body.during_business_hours === 'true';
      if (form.id) await updateEventRule(form.id, body); else await createEventRule(body);
      setForm(null); load();
    } catch (e) { setErr(e.message); }
  };

  const runPreview = async () => {
    try { setPreview(await previewEventRules(trial)); } catch (e) { setErr(e.message); }
  };

  return (
    <>
      <div className="pe-head">
        <button className="vin-btn vin-btn-primary" onClick={() => setForm({ ...blank })}>Add rule</button>
        <span style={{ fontSize: 12, color: 'var(--vin-muted)' }}>
          {rules.length} rule{rules.length === 1 ? '' : 's'} — lower priority wins, one per effect
        </span>
      </div>
      {err && <p style={{ color: 'var(--vin-text-danger)', fontSize: 13 }}>{err}</p>}

      {rules.length === 0 && (
        <div className="pe-empty">
          No rules yet, so no booking generates any requirement.<br />
          Start with a deposit rule — e.g. “no deposit, 1–20 guests, during hours”.
        </div>
      )}

      {rules.map((r) => (
        <div key={r.id} className="pe-req-line">
          <span>
            <strong>{r.name}</strong>{!r.active && <em style={{ color: 'var(--vin-muted)' }}> (inactive)</em>}
            <div className="pe-req-why">
              {r.effect_type} · priority {r.priority}
              {r.min_guests != null || r.max_guests != null ? ` · ${r.min_guests ?? 0}–${r.max_guests ?? '∞'} guests` : ''}
              {r.during_business_hours != null ? (r.during_business_hours ? ' · during hours' : ' · outside hours') : ''}
              {r.location_name ? ` · ${r.location_name}` : ''}
              {r.amount_cents != null ? ` · ${money(r.amount_cents)}` : ''}
            </div>
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="vin-btn" onClick={() => setForm({ ...r,
              during_business_hours: r.during_business_hours == null ? '' : String(r.during_business_hours) })}>Edit</button>
            <button className="vin-btn vin-btn-danger"
              onClick={async () => { if (window.confirm(`Delete “${r.name}”?`)) { await deleteEventRule(r.id); load(); } }}>
              Delete</button>
          </span>
        </div>
      ))}

      {/* Try a booking against the rules before a customer meets them. */}
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
        {preview && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <div>During business hours: <strong>
              {preview.duringBusinessHours === null ? 'unknown' : preview.duringBusinessHours ? 'yes' : 'no'}</strong></div>
            <div>Deposit: <strong>{preview.deposit.required ? money(preview.deposit.amountCents) : 'not required'}</strong>
              <span className="pe-req-why"> — {preview.deposit.ruleName || preview.deposit.reason}</span></div>
            <div>Contract: <strong>{preview.contract.required ? 'required' : 'not required'}</strong>
              <span className="pe-req-why"> — {preview.contract.ruleName || preview.contract.reason}</span></div>
            <div>Insurance: <strong>{preview.insurance.required ? 'required' : 'not required'}</strong>
              <span className="pe-req-why"> — {preview.insurance.ruleName || preview.insurance.reason}</span></div>
          </div>
        )}
      </div>

      <Drawer open={!!form} title={form?.id ? `Edit ${form.name}` : 'New rule'}
              onClose={() => setForm(null)}
              footer={form && (<>
                <button className="vin-btn" onClick={() => setForm(null)}>Cancel</button>
                <button className="vin-btn vin-btn-primary" disabled={!form.name} onClick={save}>Save</button>
              </>)}>
        {form && (<>
          <div><label className="vin-label">Name — this is what explains the charge to a customer</label>
            <input className="vin-input" value={form.name}
                   onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">Effect</label>
              <select className="vin-select" value={form.effect_type}
                      onChange={(e) => setForm({ ...form, effect_type: e.target.value })}>
                {['deposit','payment','contract','insurance','staffing','surcharge','block']
                  .map((t) => <option key={t} value={t}>{t}</option>)}
              </select></div>
            <div><label className="vin-label">Priority (lower wins)</label>
              <input className="vin-input" type="number" value={form.priority}
                     onChange={(e) => setForm({ ...form, priority: e.target.value })} /></div>
          </div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">Min guests</label>
              <input className="vin-input" type="number" value={form.min_guests ?? ''}
                     onChange={(e) => setForm({ ...form, min_guests: e.target.value })} /></div>
            <div><label className="vin-label">Max guests</label>
              <input className="vin-input" type="number" value={form.max_guests ?? ''}
                     onChange={(e) => setForm({ ...form, max_guests: e.target.value })} /></div>
          </div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">Venue</label>
              <select className="vin-select" value={form.location_id || ''}
                      onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
                <option value="">Either</option>
                {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select></div>
            <div><label className="vin-label">Business hours</label>
              <select className="vin-select" value={form.during_business_hours ?? ''}
                      onChange={(e) => setForm({ ...form, during_business_hours: e.target.value })}>
                <option value="">Either</option>
                <option value="true">During hours only</option>
                <option value="false">Outside hours only</option>
              </select></div>
          </div>
          <div className="vin-drawer-row">
            <div><label className="vin-label">Amount (cents) — 0 means explicitly none</label>
              <input className="vin-input" type="number" value={form.amount_cents ?? ''}
                     onChange={(e) => setForm({ ...form, amount_cents: e.target.value })} /></div>
            <div><label className="vin-label">Due days before event</label>
              <input className="vin-input" type="number" value={form.due_offset_days ?? ''}
                     onChange={(e) => setForm({ ...form, due_offset_days: e.target.value })} /></div>
          </div>
          <div><label className="vin-label">Customer text — appears in the proposal</label>
            <textarea rows={2} className="vin-textarea" value={form.customer_text || ''}
                      onChange={(e) => setForm({ ...form, customer_text: e.target.value })} /></div>
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

export default PrivateEvents;
