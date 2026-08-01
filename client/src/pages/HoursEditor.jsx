import React, { useState, useEffect, useCallback } from 'react';
import { getHours, saveHours, saveVenueDetails, addSpecialHours, deleteSpecialHours, confirmHoursPublished } from '../api';
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

// A tasting room lives in the afternoon and evening, so hours entry defaults to
// PM. Native <input type="time"> always defaults its AM/PM segment to AM, which
// is how "12 pm" kept getting saved as "12 am" (midnight) — so we use an
// explicit hour / minute / AM-PM control instead.
const HOURS_12 = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];

// "HH:MM" (24h) -> { h12, min, ap }. Empty defaults to noon (12:00 PM).
function parse24(v) {
  if (!v) return { h12: 12, min: '00', ap: 'PM' };
  const [hRaw, mRaw] = v.split(':');
  const h = parseInt(hRaw, 10) || 0;
  return { h12: h % 12 || 12, min: (mRaw || '00').padStart(2, '0'), ap: h >= 12 ? 'PM' : 'AM' };
}
// { h12, min, ap } -> "HH:MM" (24h). 12 AM -> 00, 12 PM -> 12.
function to24(h12, min, ap) {
  const h = (h12 % 12) + (ap === 'PM' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${min}`;
}

// Dates a seasonal rule actually covers. Shown under the rule so "August
// Saturdays" is concrete before it's saved — this is what catches an off-by-one
// or a window that quietly covers nothing.
function seasonDates(dow, from, to, cap = 40) {
  if (!from || !to || to < from) return [];
  const out = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let t = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (t <= end && out.length < cap) {
    const d = new Date(t);
    if (d.getUTCDay() === Number(dow)) out.push(d);
    t += 86400000;
  }
  return out;
}

// A half-finished seasonal rule used to be dropped on save without a word, so
// you'd enter August, hit Save, and it would simply not be there. Saving now
// refuses and says which rule and why.
function seasonProblems(rows) {
  const out = [];
  (rows || []).forEach((r, i) => {
    const who = DAYS[r.day_of_week] + 's' + (r.label ? ' (' + r.label + ')' : '');
    if (!r.from_date && !r.to_date) out.push({ i, msg: `${who}: needs a first and last date.` });
    else if (!r.from_date) out.push({ i, msg: `${who}: needs a first date.` });
    else if (!r.to_date) out.push({ i, msg: `${who}: needs a last date.` });
    else if (r.to_date < r.from_date) out.push({ i, msg: `${who}: the last date is before the first.` });
    else if (seasonDates(r.day_of_week, r.from_date, r.to_date).length === 0)
      out.push({ i, msg: `${who}: no ${DAYS[r.day_of_week]}s fall between those dates.` });
    else if (!r.opens || !r.closes) out.push({ i, msg: `${who}: needs an opening and closing time.` });
  });
  return out;
}

function TimeField({ value, onChange }) {
  const { h12, min, ap } = parse24(value);
  const emit = (nh, nm, na) => onChange(to24(nh, nm, na));
  // Keep an off-grid stored minute (e.g. legacy :23) selectable.
  const minutes = MINUTES.includes(min) ? MINUTES : [...MINUTES, min].sort();
  return (
    <span className="timefield">
      <select value={h12} onChange={(e) => emit(Number(e.target.value), min, ap)} aria-label="Hour">
        {HOURS_12.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <span className="colon">:</span>
      <select value={min} onChange={(e) => emit(h12, e.target.value, ap)} aria-label="Minute">
        {minutes.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <select className="ap" value={ap} onChange={(e) => emit(h12, min, e.target.value)} aria-label="AM or PM">
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </span>
  );
}

// Where each venue's listings live, so the dialog can link straight to them
// rather than making someone hunt. Facebook is a different page per venue.
const LISTINGS = {
  estate: { facebook: 'https://www.facebook.com/kindredvineyards' },
  creek:  { facebook: 'https://www.facebook.com/kindredbythecreek' },
};
const GOOGLE_URL = 'https://business.google.com/';
const APPLE_URL = 'https://businessconnect.apple.com/';

/**
 * Shown after hours are saved. Google, Apple and Facebook are still updated by
 * hand, so saving here can silently disagree with what customers actually see.
 * All three must be ticked before Completed enables, and the confirmation is
 * recorded so there's a receipt of who said the listings were updated, and when.
 */
function PublishDialog({ loc, onDone, onDismiss }) {
  const [checks, setChecks] = useState({ google: false, apple: false, facebook: false });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const all = checks.google && checks.apple && checks.facebook;
  const fb = LISTINGS[loc.venue]?.facebook || 'https://www.facebook.com/';

  const rows = [
    { key: 'google', name: 'Google Business Profile', url: GOOGLE_URL,
      text: 'I confirm that I have updated the opening hours on the Google Business Profile for ' + loc.name +
            ' so that they match the hours entered above, including any seasonal or holiday changes.' },
    { key: 'apple', name: 'Apple Business Connect', url: APPLE_URL,
      text: 'I confirm that I have updated the opening hours in Apple Business Connect for ' + loc.name +
            ' so that they match the hours entered above, including any seasonal or holiday changes.' },
    { key: 'facebook', name: 'Facebook Page', url: fb,
      text: 'I confirm that I have updated the opening hours on the Facebook page for ' + loc.name +
            '. Facebook holds weekly hours only, so seasonal and holiday changes cannot be shown there.' },
  ];

  const submit = async () => {
    setSaving(true); setErr('');
    try { await confirmHoursPublished(loc.id, checks); onDone(); }
    catch (e) { setErr(e.message); setSaving(false); }
  };

  return (
    <div className="pub-backdrop" role="dialog" aria-modal="true" aria-labelledby="pub-title">
      <div className="pub-modal">
        <h2 id="pub-title">Update the listings for {loc.name}</h2>
        <p className="pub-lead">
          The hours are saved and the website will show them. Google, Apple and Facebook
          are not connected yet, so they still have to be changed by hand &mdash; otherwise
          customers will keep seeing the old hours.
        </p>

        {rows.map((r) => (
          <label className={'pub-row' + (checks[r.key] ? ' on' : '')} key={r.key}>
            <input type="checkbox" checked={checks[r.key]}
                   onChange={(e) => setChecks((c) => ({ ...c, [r.key]: e.target.checked }))} />
            <span>
              <span className="pub-name">
                {r.name}
                <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Open &#8599;</a>
              </span>
              <span className="pub-text">{r.text}</span>
            </span>
          </label>
        ))}

        {err && <p className="pub-err">{err}</p>}
        <div className="pub-actions">
          <button className="pub-later" onClick={onDismiss} disabled={saving}>I&rsquo;ll do it later</button>
          <button className="btn btn-primary" onClick={submit} disabled={!all || saving}>
            {saving ? 'Recording…' : 'Completed'}
          </button>
        </div>
        {!all && <p className="pub-hint">Tick all three to enable Completed.</p>}
      </div>
    </div>
  );
}

export function HoursEditor() {
  const [locations, setLocations] = useState([]);
  const [sched, setSched] = useState({}); // locId -> array[7] of [{opens,closes}]
  const [seasons, setSeasons] = useState({}); // locId -> [{day_of_week,opens,closes,from_date,to_date,label}]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [publishFor, setPublishFor] = useState(null);
  const [seasonErrs, setSeasonErrs] = useState({}); // locId -> { rowIndex: message }

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { locations } = await getHours();
      setLocations(locations);
      const s = {}, sea = {};
      for (const loc of locations) {
        const days = Array.from({ length: 7 }, () => []);
        const seasonal = [];
        for (const r of loc.regular) {
          // A row with a date window is a season; without one it's the year-round rule.
          if (r.from_date || r.to_date) {
            seasonal.push({ day_of_week: r.day_of_week, opens: r.opens, closes: r.closes,
                            from_date: r.from_date || '', to_date: r.to_date || '', label: r.label || '' });
          } else {
            days[r.day_of_week].push({ opens: r.opens, closes: r.closes });
          }
        }
        s[loc.id] = days;
        sea[loc.id] = seasonal;
      }
      setSched(s);
      setSeasons(sea);
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
    setDay(locId, dow, [...sched[locId][dow], { opens: '12:00', closes: '21:00' }]);
  const removeIv = (locId, dow, idx) =>
    setDay(locId, dow, sched[locId][dow].filter((_, i) => i !== idx));

  const setSeason = (locId, idx, key, val) =>
    setSeasons((prev) => ({ ...prev, [locId]: prev[locId].map((r, i) => (i === idx ? { ...r, [key]: val } : r)) }));
  const addSeason = (locId) =>
    setSeasons((prev) => ({ ...prev, [locId]: [...(prev[locId] || []),
      { day_of_week: 6, opens: '12:00', closes: '22:00', from_date: '', to_date: '', label: '' }] }));
  const removeSeason = (locId, idx) =>
    setSeasons((prev) => ({ ...prev, [locId]: prev[locId].filter((_, i) => i !== idx) }));

  const copyPrevDay = (locId, dow) => {
    if (dow === 0) return;
    setDay(locId, dow, sched[locId][dow - 1].map((iv) => ({ ...iv })));
  };

  const save = async (locId) => {
    // Validate before touching the server — an incomplete seasonal rule should
    // stop the save and say so, not vanish while everything else succeeds.
    const problems = seasonProblems(seasons[locId]);
    setSeasonErrs((p) => ({ ...p, [locId]: problems.reduce((m, x) => ({ ...m, [x.i]: x.msg }), {}) }));
    if (problems.length) {
      setError('Nothing was saved. ' + problems.map((x) => x.msg).join(' '));
      return;
    }
    setSavingId(locId);
    setError('');
    try {
      const intervals = [];
      sched[locId].forEach((list, dow) =>
        list.forEach((iv) => { if (iv.opens && iv.closes) intervals.push({ day_of_week: dow, opens: iv.opens, closes: iv.closes }); })
      );
      (seasons[locId] || []).forEach((r) => intervals.push({ ...r }));
      await saveHours(locId, intervals);
      setSavedId(locId);
      setTimeout(() => setSavedId((s) => (s === locId ? null : s)), 1800);
      setPublishFor(locId); // hours changed here — now nudge the outside listings
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

      {publishFor && (
        <PublishDialog
          loc={locations.find((l) => l.id === publishFor)}
          onDone={() => setPublishFor(null)}
          onDismiss={() => setPublishFor(null)}
        />
      )}

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
                          <TimeField value={iv.opens} onChange={(v) => updateIv(loc.id, dow, idx, 'opens', v)} />
                          <span className="dash">–</span>
                          <TimeField value={iv.closes} onChange={(v) => updateIv(loc.id, dow, idx, 'closes', v)} />
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
            <h3>Seasonal hours</h3>
            <p className="hint">
              A different closing time for one weekday over a stretch of dates &mdash; &ldquo;Saturdays in
              August we&rsquo;re open until 10&rdquo;. These beat the weekly hours above, and a holiday
              below beats both.
            </p>
            {(seasons[loc.id] || []).map((r, idx) => {
              const hits = seasonDates(r.day_of_week, r.from_date, r.to_date);
              const rowErr = seasonErrs[loc.id]?.[idx];
              return (
                <div className={'season-row' + (rowErr ? ' bad' : '')} key={idx}>
                  <div className="season-line">
                    <select value={r.day_of_week} onChange={(e) => setSeason(loc.id, idx, 'day_of_week', Number(e.target.value))} aria-label="Weekday">
                      {DAYS.map((d, i) => <option key={i} value={i}>{d}s</option>)}
                    </select>
                    <span className="lbl">from</span>
                    <input type="date" value={r.from_date} onChange={(e) => setSeason(loc.id, idx, 'from_date', e.target.value)} aria-label="First date" />
                    <span className="lbl">to</span>
                    <input type="date" value={r.to_date} onChange={(e) => setSeason(loc.id, idx, 'to_date', e.target.value)} aria-label="Last date" />
                    <TimeField value={r.opens} onChange={(v) => setSeason(loc.id, idx, 'opens', v)} />
                    <span className="dash">&ndash;</span>
                    <TimeField value={r.closes} onChange={(v) => setSeason(loc.id, idx, 'closes', v)} />
                    <button className="mini" title="Remove" onClick={() => removeSeason(loc.id, idx)}>&#10005;</button>
                  </div>
                  <div className="season-line">
                    <input className="season-label" type="text" placeholder="Name it, e.g. August late Saturdays"
                           value={r.label} onChange={(e) => setSeason(loc.id, idx, 'label', e.target.value)} aria-label="Label" />
                    <span className={hits.length ? 'season-hits' : 'season-hits warn'}>
                      {!r.from_date || !r.to_date
                        ? 'Pick a first and last date'
                        : hits.length === 0
                          ? 'No ' + DAYS[r.day_of_week] + 's fall in that range'
                          : 'Affects ' + hits.length + ' ' + DAYS[r.day_of_week] + (hits.length === 1 ? '' : 's') + ': '
                            + hits.slice(0, 6).map((d) => d.getUTCDate() + ' ' +
                                ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]).join(', ')
                            + (hits.length > 6 ? '\u2026' : '')}
                    </span>
                  </div>
                  {rowErr && <div className="season-err">{rowErr}</div>}
                </div>
              );
            })}
            <button className="mini" onClick={() => addSeason(loc.id)}>+ seasonal hours</button>
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
  const [opens, setOpens] = useState('12:00');
  const [closes, setCloses] = useState('21:00');
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
          <TimeField value={opens} onChange={setOpens} />
          <span className="dash">–</span>
          <TimeField value={closes} onChange={setCloses} />
        </>
      )}
      <input className="note-in" placeholder="Note (e.g. Thanksgiving)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn btn-ghost" onClick={add} disabled={busy || !date}>Add</button>
    </div>
  );
}
