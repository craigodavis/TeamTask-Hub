import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getReservations, downloadOptIns } from '../api';
import './Reservations.css';

/**
 * Tasting Room → Reservations.
 *
 * ResOS owns the bookings; this exists for the two things ResOS makes hard —
 * seeing both venues in one list, and getting the newsletter opt-ins out as a
 * mailing list instead of one red badge at a time.
 */

const iso = (d) => d.toISOString().slice(0, 10);
const daysFromToday = (n) => iso(new Date(Date.now() + n * 86400000));

// "14:30" -> "2:30 pm"
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'am' : 'pm';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`;
}

// 'YYYY-MM-DD' parsed as local. Left to Date alone it is read as UTC and shows
// the previous day west of Greenwich.
function fmtDate(d) {
  if (!d) return '';
  const [y, mo, da] = d.split('-').map(Number);
  return new Date(y, mo - 1, da).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

// Statuses worth showing. approved/arrived/left are a booking progressing
// normally; pilling those would be noise on every row.
const NOTABLE = {
  canceled: 'Cancelled',
  no_show: 'No show',
  request: 'Requested',
  confirm: 'To confirm',
};

export default function Reservations() {
  const [from, setFrom] = useState(() => daysFromToday(-30));
  const [to, setTo] = useState(() => daysFromToday(60));
  const [venue, setVenue] = useState('');
  const [onlyOptIns, setOnlyOptIns] = useState(false);
  const [search, setSearch] = useState('');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await getReservations({ from, to, venue }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [from, to, venue]);

  useEffect(() => { load(); }, [load]);

  const bookings = data?.bookings || [];

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bookings.filter((b) => {
      if (onlyOptIns && !b.optedIn) return false;
      if (!q) return true;
      return `${b.name} ${b.email} ${b.phone}`.toLowerCase().includes(q);
    });
  }, [bookings, onlyOptIns, search]);

  // Counted off everything in range, not off what the filters are showing — the
  // headline number shouldn't move when you type in the search box.
  const stats = useMemo(() => {
    const optIns = bookings.filter((b) => b.optedIn);
    const emails = new Set(optIns.map((b) => b.email.trim().toLowerCase()).filter(Boolean));
    return { total: bookings.length, answered: bookings.filter((b) => b.fields.length).length,
             optIns: optIns.length, unique: emails.size };
  }, [bookings]);

  const doExport = async () => {
    setExporting(true);
    setError('');
    try {
      await downloadOptIns({ from, to, venue });
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="reservations">
      <header className="rv-head">
        <div>
          <h2>Reservations</h2>
          <p className="rv-sub">
            Live from ResOS. Bookings are managed there — this is for seeing both venues
            at once and getting the newsletter opt-ins out.
          </p>
        </div>
        <button
          type="button"
          className="rv-export"
          onClick={doExport}
          disabled={exporting || !stats.unique}
          title={stats.unique ? 'Download the opt-ins as a CSV' : 'No opt-ins in this range'}
        >
          {exporting ? 'Building…' : `Export ${stats.unique} opt-in${stats.unique === 1 ? '' : 's'}`}
        </button>
      </header>

      <div className="rv-filters">
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>
          Venue
          <select value={venue} onChange={(e) => setVenue(e.target.value)}>
            <option value="">All venues</option>
            {(data?.venues || []).map((v) => <option key={v.slug} value={v.slug}>{v.name}</option>)}
          </select>
        </label>
        <label className="rv-search">
          Search
          <input type="search" placeholder="name, email or phone" value={search}
                 onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="rv-check">
          <input type="checkbox" checked={onlyOptIns} onChange={(e) => setOnlyOptIns(e.target.checked)} />
          Newsletter opt-ins only
        </label>
      </div>

      {error && <p className="rv-error">{error}</p>}
      {(data?.errors || []).map((e) => <p key={e} className="rv-error">{e}</p>)}

      {!loading && (
        <p className="rv-stats">
          <strong>{stats.total}</strong> bookings · <strong>{stats.answered}</strong> answered the
          booking questions · <strong>{stats.optIns}</strong> opted in to the newsletter
          {stats.optIns !== stats.unique && <> (<strong>{stats.unique}</strong> unique emails)</>}
        </p>
      )}

      {loading ? (
        <p className="rv-empty">Loading…</p>
      ) : !shown.length ? (
        <p className="rv-empty">No bookings match.</p>
      ) : (
        <div className="rv-table-wrap">
          <table className="rv-table">
            <thead>
              <tr>
                <th>When</th><th>Venue</th><th>Guest</th><th>Party</th>
                <th>Answers</th><th>Source</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id} className={b.optedIn ? 'rv-optin' : ''}>
                  <td className="rv-when">
                    <span className="rv-date">{fmtDate(b.date)}</span>
                    <span className="rv-time">{fmtTime(b.time)}</span>
                  </td>
                  <td>
                    {b.venueName}
                    {NOTABLE[b.status] && <span className={`rv-status ${b.status}`}>{NOTABLE[b.status]}</span>}
                  </td>
                  <td className="rv-guest">
                    <span className="rv-name">{b.name || '—'}</span>
                    {b.email && <a className="rv-email" href={`mailto:${b.email}`}>{b.email}</a>}
                    {b.phone && <span className="rv-phone">{b.phone}</span>}
                  </td>
                  <td className="rv-party">{b.people}</td>
                  <td className="rv-answers">
                    {b.fields.length
                      ? b.fields.map((f) => (
                          <span key={f.label} className={`rv-tag${/^yes$/i.test(f.answer) ? ' yes' : ''}`}>
                            {f.label}: {f.answer}
                          </span>
                        ))
                      : <span className="rv-none">—</span>}
                  </td>
                  <td className="rv-source">{b.source || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
