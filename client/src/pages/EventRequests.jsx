import React, { useState, useEffect, useCallback } from 'react';
import {
  getEventRequests, updateEventRequest,
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

// The three panels are exported so Private Events can show them in ONE flat tab row
// alongside its calendar and rules. This page stays as a redirect target for old
// links; nesting its tabs inside another set of tabs would be worse than the problem.
export default function EventRequests() {
  const [tab, setTab] = useState('requests');
  const [error, setError] = useState('');
  // The form link is rendered by the Requests panel itself now, so it follows the
  // panel into Private Events instead of living in a header that stayed behind.
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

/**
 * The public form link, with a copy button.
 *
 * This lives WITH the requests panel rather than in a page header. It used to sit in
 * the EventRequests page header, and when the panel was folded into Private Events as
 * a tab the header stayed behind — so the one thing staff come to this screen wanting
 * silently disappeared. Attached to the panel, it travels wherever the panel is shown.
 *
 * Rendered as readable text and not only a button, because it gets read down the phone
 * as often as it gets pasted.
 */
function FormLink({ url }) {
  const [state, setState] = useState('idle');
  if (!url) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
      setTimeout(() => setState('idle'), 1800);
    } catch {
      // Clipboard access is blocked outside a secure context and on some mobile
      // browsers. Saying so beats a button that silently does nothing — the URL is
      // selectable text, so there is always a way through.
      setState('failed');
    }
  };

  return (
    <div className="evr-formlink">
      <span className="evr-formlink-label">Send customers this link</span>
      <a href={url} target="_blank" rel="noreferrer" className="evr-formlink-url">{url}</a>
      <button type="button" className="evr-formlink-copy" onClick={copy}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it to copy' : 'Copy'}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- requests */

export function Requests({ onError, onOpen }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // Open by default. A cancelled enquiry is kept but stops being something to look
  // at — an inbox that still shows everything you have dealt with is not an inbox.
  // Opens on what needs doing. "Open" is everything still live; this is the subset
  // where the next move is ours, which is the question somebody opening the inbox is
  // actually asking.
  const [filter, setFilter] = useState('attention');
  const [sort, setSort] = useState('newest');
  const [search, setSearch] = useState('');
  // Comes back with the list, so showing it costs no extra request. Served by the API
  // rather than hardcoded, which makes it literally the URL the phone agent texts
  // callers — see server/lib/publicLinks.js.
  const [formUrl, setFormUrl] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getEventRequests(filter, sort);
      setRows(d.requests);
      setFormUrl(d.form_url || '');
    }
    catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [filter, sort, onError]);
  useEffect(() => { load(); }, [load]);

  const patch = async (id, body) => {
    try {
      const { request } = await updateEventRequest(id, body);
      setRows((rs) => rs.map((r) => (r.id === id ? request : r)));
    } catch (e) { onError(e.message); }
  };

  const needle = search.trim().toLowerCase();
  const visible = needle
    ? rows.filter((r) => [r.name, r.email, r.phone]
      .some((v) => String(v || '').toLowerCase().includes(needle)))
    : rows;

  return (
    <>
      <FormLink url={formUrl} />
      {/* Chips rather than a dropdown. Two things went wrong with the select: a
          leftover second select was bound to the same state with a different option
          set, so they fought; and "Open" was the empty string, which reads as "no
          filter" when it actually means "open only" — easy to get wrong and
          impossible to see. Chips show which view you are in without opening
          anything. */}
      <div className="evr-filters">
        <div className="evr-chips">
          {[['attention', 'Needs attention'], ['open', 'Open'], ['new', 'Not reviewed'],
            ['approved', 'Approved'], ['complete', 'Finished'], ['cancelled', 'Cancelled'],
            ['declined', 'Declined'], ['all', 'Everything']].map(([v, label]) => (
            <button key={v} type="button"
                    className={`evr-chip${filter === v ? ' on' : ''}`}
                    aria-pressed={filter === v}
                    onClick={() => setFilter(v)}>
              {label}
            </button>
          ))}
        </div>
        <div className="evr-filter-row">
          <label>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="newest">Newest enquiry</option>
              <option value="oldest">Oldest enquiry</option>
              <option value="event_date">Event date</option>
              <option value="guests">Most guests</option>
              <option value="name">Name</option>
            </select>
          </label>
          <label>
            Find
            {/* Filtered here rather than in a query: the list is capped at 500 and a
                round trip per keystroke buys nothing. */}
            <input value={search} placeholder="name, email or phone"
                   onChange={(e) => setSearch(e.target.value)} />
          </label>
          <span className="evr-count">
            {visible.length}{visible.length !== rows.length ? ` of ${rows.length}` : ''}
          </span>
        </div>
      </div>

      {loading ? <p className="evr-empty">Loading…</p>
        : !visible.length ? (
          <p className="evr-empty">
            {rows.length ? 'Nothing matches that.' : 'Nothing here — the inbox is clear.'}
          </p>)
        : visible.map((r) => (
          <article key={r.id} className={`evr-card status-${r.status}`}>
            <div className="evr-card-head">
              {/* The whole heading opens the slide-out, the same one the calendar
                  uses. A button rather than a click handler on the article, so it
                  reaches the keyboard and does not swallow the actions below it. */}
              <div>
                <h3>
                  {onOpen
                    ? <button type="button" className="evr-open" onClick={() => onOpen(r)}>{r.name}</button>
                    : r.name}
                  {Number(r.pending_requests) > 0 && (
                    // What they asked, not just how many. "1 to decide" tells you
                    // there is something; "can we bring a cake" tells you whether to
                    // open it now.
                    <span className="evr-badge" title={r.first_pending || ''}>
                      {r.first_pending
                        ? `“${String(r.first_pending).replace(/\s+/g, ' ').slice(0, 44)}${String(r.first_pending).length > 44 ? '…' : ''}”`
                        : `${r.pending_requests} to decide`}
                      {Number(r.pending_requests) > 1 && ` +${r.pending_requests - 1}`}
                    </span>
                  )}
                </h3>
                <p className="evr-meta">
                  {fmtDate(r.event_date)}
                  {/* The time block and venue the guest asked for. Older requests
                      predate these fields and say so, rather than showing a blank
                      that reads as "any time, anywhere". Every hours-based term
                      depends on them. */}
                  {r.start_time
                    ? ` · ${String(r.start_time).slice(0, 5)}–${String(r.end_time || '').slice(0, 5)}`
                    : ' · no time given'}
                  {r.location_name ? ` · ${r.location_name}` : ' · no venue given'}
                  {' · '}{r.guests} {r.guests === 1 ? 'guest' : 'guests'}
                </p>
              </div>
              <span className={`evr-pill ${r.status}`}>{r.status}</span>
            </div>

            {/* Everything else — contact details, the quote, notes, the outstanding
                steps — lives in the slide-out. A list you scan to find the one you
                want should not also be the record of each one: eleven lines a row
                meant four requests filled a screen and none of them could be
                compared at a glance. Click the name. */}
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

/* ------------------------------------------------------------------ copy */

export function Copy({ onError }) {
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
