import React, { useState, useEffect, useCallback } from 'react';
import { getHours, saveHours, saveVenueDetails, addSpecialHours, deleteSpecialHours } from '../api';
import './HoursEditor.css';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// "14:30" -> "2:30 pm"
function fmt(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'am' : 'pm';
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

export function HoursEditor() {
  const [locations, setLocations] = useState([]);
  const [sched, setSched] = useState({}); // locId -> array[7] of [{opens,closes}]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [savedId, setSavedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { locations } = await getHours();
      setLocations(locations);
      const s = {};
      for (const loc of locations) {
        const days = Array.from({ length: 7 }, () => []);
        for (const r of loc.regular) days[r.day_of_week].push({ opens: r.opens, closes: r.closes });
        s[loc.id] = days;
      }
      setSched(s);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setDay = (locId, dow, intervals) =>
    setSched((prev) => ({ ...prev, [locId]: prev[locId].map((iv, i) => (i === dow ? intervals : iv)) }));
  const updateIv = (locId, dow, idx, key, val) =>
    setDay(locId, dow, sched[locId][dow].map((iv, i) => (i === idx ? { ...iv, [key]: val } : iv)));
  const addIv = (locId, dow) =>
    setDay(locId, dow, [...sched[locId][dow], { opens: '11:00', closes: '17:00' }]);
  const removeIv = (locId, dow, idx) =>
    setDay(locId, dow, sched[locId][dow].filter((_, i) => i !== idx));

  const copyPrevDay = (locId, dow) => {
    if (dow === 0) return;
    setDay(locId, dow, sched[locId][dow - 1].map((iv) => ({ ...iv })));
  };

  const save = async (locId) => {
    setSavingId(locId);
    setError('');
    try {
      const intervals = [];
      sched[locId].forEach((list, dow) =>
        list.forEach((iv) => { if (iv.opens && iv.closes) intervals.push({ day_of_week: dow, opens: iv.opens, closes: iv.closes }); })
      );
      await saveHours(locId, intervals);
      setSavedId(locId);
      setTimeout(() => setSavedId((s) => (s === locId ? null : s)), 1800);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingId(null);
    }
  };

  const delSpecial = async (id) => {
    try { await deleteSpecialHours(id); await load(); } catch (e) { setError(e.message); }
  };

  if (loading) return <div className="hours-editor"><h1>Store Hours</h1><p className="hint">Loading…</p></div>;

  return (
    <div className="hours-editor">
      <h1>Store Hours</h1>
      <p className="subtitle">
        Marketing → Hours. The single source of truth for hours — published to the website now, and to
        Google, Apple &amp; Twilio later. Edit once here.
      </p>
      {error && <div className="hours-error">{error}</div>}

      {locations.length === 0 && (
        <p className="hint">No website venues found. Give a location a web key (estate/creek) first.</p>
      )}

      {locations.map((loc) => (
        <div className="venue-card" key={loc.id}>
          <div className="venue-head">
            <h2>{loc.name} <span className="venue-key">{loc.venue}</span></h2>
            <button className="btn btn-primary" onClick={() => save(loc.id)} disabled={savingId === loc.id}>
              {savingId === loc.id ? 'Saving…' : savedId === loc.id ? 'Saved ✓' : 'Save hours'}
            </button>
          </div>

          <VenueDetails locId={loc.id} initial={loc.details} onError={setError} />

          <div className="week">
            {DAYS.map((label, dow) => {
              const list = sched[loc.id]?.[dow] || [];
              return (
                <div className="day-row" key={dow}>
                  <div className="day-name">{label}</div>
                  <div className="day-hours">
                    {list.length === 0 ? (
                      <span className="closed">Closed</span>
                    ) : (
                      list.map((iv, idx) => (
                        <div className="interval" key={idx}>
                          <input type="time" value={iv.opens} onChange={(e) => updateIv(loc.id, dow, idx, 'opens', e.target.value)} />
                          <span className="dash">–</span>
                          <input type="time" value={iv.closes} onChange={(e) => updateIv(loc.id, dow, idx, 'closes', e.target.value)} />
                          <button className="mini" title="Remove" onClick={() => removeIv(loc.id, dow, idx)}>✕</button>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="day-actions">
                    <button className="mini" onClick={() => addIv(loc.id, dow)}>+ hours</button>
                    {dow > 0 && <button className="mini" onClick={() => copyPrevDay(loc.id, dow)} title="Copy previous day">↑ copy</button>}
                    {list.length > 0 && <button className="mini" onClick={() => setDay(loc.id, dow, [])}>Closed</button>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="specials">
            <h3>Holidays &amp; closures</h3>
            {loc.specials.length === 0 && <p className="hint">None upcoming.</p>}
            {loc.specials.map((sp) => (
              <div className="special-row" key={sp.id}>
                <span className="sp-date">{sp.on_date}</span>
                <span className="sp-hours">{sp.is_closed ? 'Closed' : `${fmt(sp.opens)} – ${fmt(sp.closes)}`}</span>
                <span className="sp-note">{sp.note}</span>
                <button className="mini" onClick={() => delSpecial(sp.id)}>✕</button>
              </div>
            ))}
            <SpecialAdd locId={loc.id} onAdded={load} onError={setError} />
          </div>
        </div>
      ))}
    </div>
  );
}

function VenueDetails({ locId, initial, onError }) {
  const init = initial || {};
  const [d, setD] = useState({
    street: init.street || '', city: init.city || '', region: init.region || '',
    postal: init.postal || '', country: init.country || 'US', phone: init.phone || '',
    lat: init.lat ?? '', lng: init.lng ?? '', price_range: init.price_range || '',
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = (k) => (e) => setD((prev) => ({ ...prev, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      await saveVenueDetails(locId, d);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <details className="venue-details">
      <summary>Location details <span className="hint">(address, phone, map — used by search engines &amp; the hours push)</span></summary>
      <div className="det-grid">
        <label className="wide">Street<input value={d.street} onChange={set('street')} placeholder="123 Vineyard Ln" /></label>
        <label>City<input value={d.city} onChange={set('city')} placeholder="Caldwell" /></label>
        <label>State<input value={d.region} onChange={set('region')} placeholder="ID" /></label>
        <label>ZIP<input value={d.postal} onChange={set('postal')} placeholder="83607" /></label>
        <label>Phone<input value={d.phone} onChange={set('phone')} placeholder="(208) 555-1234" /></label>
        <label>Price<input value={d.price_range} onChange={set('price_range')} placeholder="$$" /></label>
        <label>Latitude<input value={d.lat} onChange={set('lat')} placeholder="43.598" /></label>
        <label>Longitude<input value={d.lng} onChange={set('lng')} placeholder="-116.752" /></label>
      </div>
      <button className="btn btn-ghost" onClick={save} disabled={busy}>{busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save details'}</button>
    </details>
  );
}

function SpecialAdd({ locId, onAdded, onError }) {
  const [date, setDate] = useState('');
  const [closed, setClosed] = useState(true);
  const [opens, setOpens] = useState('11:00');
  const [closes, setCloses] = useState('17:00');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!date) return;
    setBusy(true);
    try {
      await addSpecialHours(locId, { on_date: date, is_closed: closed, opens, closes, note });
      setDate(''); setNote(''); setClosed(true);
      onAdded();
    } catch (e) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="special-add">
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <label className="chk"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Closed</label>
      {!closed && (
        <>
          <input type="time" value={opens} onChange={(e) => setOpens(e.target.value)} />
          <span className="dash">–</span>
          <input type="time" value={closes} onChange={(e) => setCloses(e.target.value)} />
        </>
      )}
      <input className="note-in" placeholder="Note (e.g. Thanksgiving)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn btn-ghost" onClick={add} disabled={busy || !date}>Add</button>
    </div>
  );
}
