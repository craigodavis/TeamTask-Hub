import React, { useState, useEffect, useCallback } from 'react';
import {
  getEventRequests, updateEventRequest,
  getEventTiers, saveEventTier, deleteEventTier,
  getEventRequestSettings, saveEventRequestSettings,
} from '../api';
import './EventRequests.css';

/**
 * Marketing → Event Requests.
 *
 * Three things in one place because they are one job: the requests that come in,
 * the tiers that decide what each one costs and requires, and the copy the guest
 * reads. Splitting them across screens would mean editing a price without seeing
 * who it applies to.
 */

const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};
const dollars = (cents) => (cents == null ? '' : (cents / 100).toString());

const BLANK_TIER = {
  min_guests: '', max_guests: '', title: '', base_price: '', min_alcohol: '', rules: '',
  deposit_required: false, deposit: '', deposit_description: '',
  insurance_required: false, insurance_description: '', planning_meeting_days: '',
};

const toForm = (t) => ({
  id: t.id,
  min_guests: t.min_guests ?? '',
  max_guests: t.max_guests ?? '',
  title: t.title || '',
  base_price: dollars(t.base_price_cents),
  min_alcohol: dollars(t.min_alcohol_cents),
  rules: t.rules || '',
  deposit_required: !!t.deposit_required,
  deposit: dollars(t.deposit_cents),
  deposit_description: t.deposit_description || '',
  insurance_required: !!t.insurance_required,
  insurance_description: t.insurance_description || '',
  planning_meeting_days: t.planning_meeting_days ?? '',
});

export default function EventRequests() {
  const [tab, setTab] = useState('requests');
  const [error, setError] = useState('');
  return (
    <div className="evr">
      <header className="evr-head">
        <div>
          <h2>Event Requests</h2>
          <p className="evr-sub">
            Special event enquiries from the website, the tiers that price them, and the
            copy guests read.
          </p>
        </div>
        <nav className="evr-tabs">
          {[['requests', 'Requests'], ['tiers', 'Tiers & pricing'], ['copy', 'Message']].map(([k, label]) => (
            <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setError(''); }}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      {error && <p className="evr-error">{error}</p>}
      {tab === 'requests' && <Requests onError={setError} />}
      {tab === 'tiers' && <Tiers onError={setError} />}
      {tab === 'copy' && <Copy onError={setError} />}
    </div>
  );
}

/* -------------------------------------------------------------- requests */

function Requests({ onError }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows((await getEventRequests(filter || undefined)).requests); }
    catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [filter, onError]);
  useEffect(() => { load(); }, [load]);

  const patch = async (id, body) => {
    try {
      const { request } = await updateEventRequest(id, body);
      setRows((rs) => rs.map((r) => (r.id === id ? request : r)));
    } catch (e) { onError(e.message); }
  };

  return (
    <>
      <div className="evr-filters">
        <label>
          Status
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            <option value="new">New</option>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
            <option value="complete">Complete</option>
          </select>
        </label>
      </div>

      {loading ? <p className="evr-empty">Loading…</p>
        : !rows.length ? <p className="evr-empty">No requests yet.</p>
        : rows.map((r) => (
          <article key={r.id} className={`evr-card status-${r.status}`}>
            <div className="evr-card-head">
              <div>
                <h3>{r.name}</h3>
                <p className="evr-meta">
                  {fmtDate(r.event_date)} · {r.guests} {r.guests === 1 ? 'guest' : 'guests'}
                </p>
              </div>
              <span className={`evr-pill ${r.status}`}>{r.status}</span>
            </div>

            <dl className="evr-detail">
              <dt>Email</dt><dd><a href={`mailto:${r.email}`}>{r.email}</a></dd>
              {r.phone && <><dt>Phone</dt><dd><a href={`tel:${r.phone}`}>{r.phone}</a></dd></>}
              {r.address && <><dt>Address</dt><dd>{r.address}</dd></>}
              {r.quotedBase && <><dt>Venue fee</dt><dd>{r.quotedBase}</dd></>}
              {r.quotedMinAlcohol && <><dt>Min. bar</dt><dd>{r.quotedMinAlcohol}</dd></>}
              {r.deposit_required && <><dt>Deposit</dt><dd>{r.quotedDeposit}</dd></>}
              {r.notes && <><dt>Notes</dt><dd className="evr-notes">{r.notes}</dd></>}
            </dl>

            {r.status === 'approved' && (
              <div className="evr-steps">
                {/* The planning meeting is ours to book, so it sits with the
                    guest's outstanding items rather than somewhere separate. */}
                {r.planningMeetingDue && (
                  <label className="evr-step">
                    <input type="checkbox" checked={!!r.planning_meeting_booked}
                           onChange={(e) => patch(r.id, { planning_meeting_booked: e.target.checked })} />
                    Planning meeting booked <span className="evr-due">by {r.planningMeetingDue}</span>
                  </label>
                )}
                {r.steps.map((s) => s.key === 'deposit' ? (
                  <span key={s.key} className={`evr-step readonly${s.done ? ' done' : ''}`}>
                    {s.done ? '✓' : '○'} Security deposit {s.done ? 'paid' : 'outstanding'}
                  </span>
                ) : (
                  <label key={s.key} className="evr-step">
                    <input type="checkbox" checked={!!r.insurance_ok}
                           disabled={!r.insurance_uploaded_at}
                           onChange={(e) => patch(r.id, { insurance_ok: e.target.checked })} />
                    Proof of insurance accepted
                    {!r.insurance_uploaded_at && <span className="evr-due">nothing uploaded yet</span>}
                  </label>
                ))}
              </div>
            )}

            <div className="evr-actions">
              {r.status === 'new' && (
                <>
                  <button className="evr-approve" onClick={() => patch(r.id, { status: 'approved' })}>Approve</button>
                  <button className="evr-decline" onClick={() => {
                    const reason = window.prompt('Reason for declining? (optional, not sent to the guest)') ?? null;
                    patch(r.id, { status: 'declined', declined_reason: reason });
                  }}>Decline</button>
                </>
              )}
              {r.status === 'approved' && r.ready && (
                <button className="evr-approve" onClick={() => patch(r.id, { status: 'complete' })}>Mark complete</button>
              )}
              {r.status === 'approved' && !r.ready && (
                <span className="evr-waiting">Waiting on the guest</span>
              )}
            </div>
          </article>
        ))}
    </>
  );
}

/* ----------------------------------------------------------------- tiers */

function Tiers({ onError }) {
  const [tiers, setTiers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setTiers((await getEventTiers()).tiers); }
    catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [onError]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    try { await saveEventTier(editing); setEditing(null); await load(); }
    catch (e) { onError(e.message); }
  };
  const remove = async (id) => {
    if (!window.confirm('Delete this tier? Requests already quoted from it keep their prices.')) return;
    try { await deleteEventTier(id); await load(); } catch (e) { onError(e.message); }
  };

  const band = (t) => `${t.min_guests}–${t.max_guests ?? '∞'}`;

  return (
    <>
      <div className="evr-filters">
        <button className="evr-approve" onClick={() => setEditing({ ...BLANK_TIER })}>Add a tier</button>
      </div>

      {loading ? <p className="evr-empty">Loading…</p>
        : !tiers.length ? <p className="evr-empty">No tiers yet. Add one so the form can quote.</p>
        : (
          <div className="evr-table-wrap">
            <table className="evr-table">
              <thead>
                <tr>
                  <th>Guests</th><th>Name</th><th>Venue fee</th><th>Min. bar</th>
                  <th>Deposit</th><th>Insurance</th><th>Meeting</th><th />
                </tr>
              </thead>
              <tbody>
                {tiers.map((t) => (
                  <tr key={t.id}>
                    <td className="nowrap">{band(t)}</td>
                    <td>{t.title || '—'}</td>
                    <td>${dollars(t.base_price_cents)}</td>
                    <td>${dollars(t.min_alcohol_cents)}</td>
                    <td>{t.deposit_required ? `$${dollars(t.deposit_cents)}` : '—'}</td>
                    <td>{t.insurance_required ? 'Required' : '—'}</td>
                    <td className="nowrap">{t.planning_meeting_days ? `${t.planning_meeting_days}d before` : '—'}</td>
                    <td className="nowrap">
                      <button className="evr-link" onClick={() => setEditing(toForm(t))}>Edit</button>
                      <button className="evr-link danger" onClick={() => remove(t.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {editing && (
        <div className="evr-modal" role="dialog" aria-label="Edit tier">
          <div className="evr-modal-box">
            <h3>{editing.id ? 'Edit tier' : 'New tier'}</h3>
            <div className="evr-grid">
              <label>Min guests<input type="number" min="1" value={editing.min_guests}
                onChange={(e) => setEditing({ ...editing, min_guests: e.target.value })} /></label>
              <label>Max guests <span className="hint">blank = and above</span>
                <input type="number" value={editing.max_guests}
                  onChange={(e) => setEditing({ ...editing, max_guests: e.target.value })} /></label>
              <label className="wide">Name <span className="hint">shown to the guest</span>
                <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label>
              <label>Venue fee ($)<input value={editing.base_price}
                onChange={(e) => setEditing({ ...editing, base_price: e.target.value })} /></label>
              <label>Min. bar purchase ($)<input value={editing.min_alcohol}
                onChange={(e) => setEditing({ ...editing, min_alcohol: e.target.value })} /></label>
              <label className="wide">Rules<textarea rows="3" value={editing.rules}
                onChange={(e) => setEditing({ ...editing, rules: e.target.value })} /></label>

              <label className="wide check">
                <input type="checkbox" checked={editing.deposit_required}
                  onChange={(e) => setEditing({ ...editing, deposit_required: e.target.checked })} />
                Security deposit required
              </label>
              {editing.deposit_required && (
                <>
                  <label>Deposit ($)<input value={editing.deposit}
                    onChange={(e) => setEditing({ ...editing, deposit: e.target.value })} /></label>
                  <label className="wide">Deposit description <span className="hint">the guest reads this</span>
                    <textarea rows="2" value={editing.deposit_description}
                      onChange={(e) => setEditing({ ...editing, deposit_description: e.target.value })} /></label>
                </>
              )}

              <label className="wide check">
                <input type="checkbox" checked={editing.insurance_required}
                  onChange={(e) => setEditing({ ...editing, insurance_required: e.target.checked })} />
                Proof of insurance required
              </label>
              {editing.insurance_required && (
                <label className="wide">Insurance description <span className="hint">the guest reads this</span>
                  <textarea rows="2" value={editing.insurance_description}
                    onChange={(e) => setEditing({ ...editing, insurance_description: e.target.value })} /></label>
              )}

              <label className="wide">Planning meeting <span className="hint">days before the event we should have met</span>
                <input type="number" min="0" value={editing.planning_meeting_days}
                  onChange={(e) => setEditing({ ...editing, planning_meeting_days: e.target.value })} /></label>
            </div>
            <div className="evr-modal-actions">
              <button className="evr-approve" onClick={save}>Save</button>
              <button className="evr-link" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ copy */

function Copy({ onError }) {
  const [v, setV] = useState({ intro: '', approvedEmail: '' });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getEventRequestSettings().then(setV).catch((e) => onError(e.message));
  }, [onError]);

  const save = async () => {
    try { await saveEventRequestSettings(v); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    catch (e) { onError(e.message); }
  };

  return (
    <div className="evr-copy">
      <label>
        Form introduction <span className="hint">the paragraph at the top of the request form</span>
        <textarea rows="4" value={v.intro} onChange={(e) => setV({ ...v, intro: e.target.value })} />
      </label>
      <label>
        Approval email <span className="hint">sent to the guest when you approve their request</span>
        <textarea rows="8" value={v.approvedEmail} onChange={(e) => setV({ ...v, approvedEmail: e.target.value })} />
      </label>
      <div className="evr-modal-actions">
        <button className="evr-approve" onClick={save}>Save</button>
        {saved && <span className="evr-waiting">Saved</span>}
      </div>
    </div>
  );
}
