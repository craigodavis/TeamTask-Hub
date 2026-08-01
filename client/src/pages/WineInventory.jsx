import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getLocations, getWineInventoryList, saveWineInventoryCount } from '../api';
import { CASE_SIZE } from '../utils/wineInventory';
import './WineInventory.css';

const STATUS_VIEWS = [
  { value: 'uncompleted', label: 'Uncompleted' },
  { value: 'completed',   label: 'Completed' },
  { value: 'all',         label: 'All' },
];

const LOCATION_STORAGE_KEY = 'wine_inventory_last_location';

function matchesSearch(item, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  return (item.name || '').toLowerCase().includes(t) || (item.varietal || '').toLowerCase().includes(t);
}

// Cases/Bottles auto-save a draft in the background as you type (so nothing
// is lost if you navigate away), but that alone never marks a wine
// completed. Only pressing "Done" does — it also auto-normalizes any bottle
// overflow (>= 12) into cases first. This removes all the timing-based
// auto-complete logic that made items disappear unpredictably.
function WineCountCard({ item, locationId, allowsLibrary, onSaved }) {
  const [cases, setCases] = useState(item.cases ?? 0);
  const [bottles, setBottles] = useState(item.bottles ?? 0);
  // Library is a slice of the count above, not an extra pile of wine.
  const [libCases, setLibCases] = useState(item.library?.cases ?? 0);
  const [libBottles, setLibBottles] = useState(item.library?.bottles ?? 0);
  const [showLibrary, setShowLibrary] = useState(
    (item.library?.cases ?? 0) > 0 || (item.library?.bottles ?? 0) > 0);
  const canLibrary = allowsLibrary !== false;
  const [savedFlash, setSavedFlash] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const timerRef = useRef(null);
  // True once the user actually presses a key in either field — distinguishes
  // "deliberately typed 0" (skip nothing) from "just tapped through without
  // typing anything" (skip the pointless background draft save).
  const touchedRef = useRef(false);

  useEffect(() => {
    setCases(item.cases ?? 0);
    setBottles(item.bottles ?? 0);
    setLibCases(item.library?.cases ?? 0);
    setLibBottles(item.library?.bottles ?? 0);
    setShowLibrary((item.library?.cases ?? 0) > 0 || (item.library?.bottles ?? 0) > 0);
    touchedRef.current = false;
  }, [item.id]);

  const persistDraft = async (nextCases, nextBottles) => {
    const casesNum = parseInt(nextCases, 10) || 0;
    const bottlesNum = parseInt(nextBottles, 10) || 0;
    if (!touchedRef.current && casesNum === 0 && bottlesNum === 0) return;
    try {
      await saveWineInventoryCount({
        product_id: item.id,
        location_id: locationId,
        cases: nextCases,
        bottles: nextBottles,
        library_cases: libCases,
        library_bottles: libBottles,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 900);
    } catch {
      // Leave the values as typed; the next edit (or Done) will retry.
    }
  };

  const scheduleSave = useCallback((nextCases, nextBottles) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => persistDraft(nextCases, nextBottles), 500);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const bottleCount = parseInt(bottles, 10) || 0;
  const caseCount = parseInt(cases, 10) || 0;

  // The only path that marks a wine completed. Rolls any full case's worth
  // of loose bottles into the case count first, then saves and completes —
  // whatever the values are, even 0/0, since pressing this is unambiguous
  // deliberate intent.
  const handleDone = async () => {
    clearTimeout(timerRef.current);
    let finalCases = caseCount;
    let finalBottles = bottleCount;
    if (finalBottles >= CASE_SIZE) {
      finalCases += Math.floor(finalBottles / CASE_SIZE);
      finalBottles = finalBottles % CASE_SIZE;
      setCases(finalCases);
      setBottles(finalBottles);
    }
    const totalB = finalCases * CASE_SIZE + finalBottles;
    const libB = (parseInt(libCases, 10) || 0) * CASE_SIZE + (parseInt(libBottles, 10) || 0);
    if (libB > totalB) {
      window.alert(
        `Library (${libB} bottles) is more than the ${totalB} counted.\n\n`
        + `Library bottles are part of the count, not on top of it.`);
      return;
    }
    setFinishing(true);
    try {
      await saveWineInventoryCount({
        product_id: item.id,
        location_id: locationId,
        cases: finalCases,
        bottles: finalBottles,
        library_cases: libCases,
        library_bottles: libBottles,
      });
      onSaved(item.id, finalCases, finalBottles);
    } catch {
      setFinishing(false);
      // Leave as-is; user can press Done again to retry.
    }
  };

  return (
    <div className={`wine-count-card${item.counted_today ? ' completed' : ' uncompleted'}${savedFlash ? ' just-saved' : ''}`}>
      <div className="wine-count-info">
        <div className="wine-count-name">
          {item.name}{item.vintage ? ` (${item.vintage})` : ''}
        </div>
        <div className="wine-count-last">
          {item.last_counted_at
            ? `Last: ${item.cases} cases, ${item.bottles} btl — ${new Date(item.last_counted_at).toLocaleDateString()}${item.last_counted_by_name ? ` by ${item.last_counted_by_name}` : ''}`
            : 'Never counted'}
        </div>
      </div>
      {canLibrary && showLibrary && (
        <div className="wine-count-library">
          <span className="wine-count-library-label">
            Of that count, library:
          </span>
          <label className="wine-count-field">
            <span>Cases</span>
            <input
              type="number" inputMode="numeric" min="0" value={libCases}
              onChange={(e) => { setLibCases(e.target.value); touchedRef.current = true; }}
              onFocus={(e) => e.target.select()}
              onBlur={() => persistDraft(cases, bottles)}
            />
          </label>
          <label className="wine-count-field">
            <span>Bottles</span>
            <input
              type="number" inputMode="numeric" min="0" value={libBottles}
              onChange={(e) => { setLibBottles(e.target.value); touchedRef.current = true; }}
              onFocus={(e) => e.target.select()}
              onBlur={() => persistDraft(cases, bottles)}
            />
          </label>
        </div>
      )}
      <div className="wine-count-inputs">
        <label className="wine-count-field">
          <span>Cases</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={cases}
            onChange={(e) => { const v = e.target.value; setCases(v); scheduleSave(v, bottles); }}
            onFocus={(e) => e.target.select()}
            onKeyDown={() => { touchedRef.current = true; }}
            onBlur={() => persistDraft(cases, bottles)}
          />
        </label>
        <label className="wine-count-field">
          <span>Bottles</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={bottles}
            onChange={(e) => { const v = e.target.value; setBottles(v); scheduleSave(cases, v); }}
            onFocus={(e) => e.target.select()}
            onKeyDown={() => { touchedRef.current = true; }}
            onBlur={() => persistDraft(cases, bottles)}
          />
        </label>
        {canLibrary && (
        <button
          type="button"
          className={`wine-count-library-toggle${showLibrary ? ' on' : ''}`}
          onClick={() => setShowLibrary((v) => !v)}
          title="Mark some (or all) of this count as library stock"
        >
          Library
        </button>
        )}
        <button
          type="button"
          className="wine-count-done"
          onClick={handleDone}
          disabled={finishing}
          title="Save this count and mark it done (auto-converts bottle overflow into cases)"
        >
          {finishing ? '…' : '✓ Done'}
        </button>
        {savedFlash && <span className="wine-count-saved">saved</span>}
      </div>
    </div>
  );
}

export function WineInventory() {
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusView, setStatusView] = useState('uncompleted');

  useEffect(() => {
    getLocations()
      .then((d) => {
        const locs = d.locations || [];
        setLocations(locs);
        const remembered = localStorage.getItem(LOCATION_STORAGE_KEY);
        const initial = (remembered && locs.some((l) => l.id === remembered)) ? remembered : locs[0]?.id;
        if (initial) setLocationId(initial);
        else setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const load = useCallback(() => {
    if (!locationId) return;
    setLoading(true);
    setError('');
    getWineInventoryList(locationId)
      .then((d) => setItems(d.items || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

  const handleLocationChange = (id) => {
    setLocationId(id);
    localStorage.setItem(LOCATION_STORAGE_KEY, id);
  };

  const handleSaved = (productId, cases, bottles) => {
    setItems((prev) => prev.map((i) => (i.id === productId ? {
      ...i,
      counted_today: true,
      cases: parseInt(cases, 10) || 0,
      bottles: parseInt(bottles, 10) || 0,
      last_counted_at: new Date().toISOString(),
    } : i)));
  };

  const remaining = items.filter((i) => !i.counted_today).length;

  // Live-filtered — completing an item removes it from the Uncompleted view
  // immediately. This never touches which pill is selected (statusView only
  // changes from an explicit tab click), so it can't "flip tabs" on its own.
  const visible = items
    .filter((i) => matchesSearch(i, search))
    .filter((i) => {
      if (statusView === 'uncompleted') return !i.counted_today;
      if (statusView === 'completed') return i.counted_today;
      return true;
    });

  return (
    <div className="wine-inv-page">
      <h2 className="wine-inv-title">Wine Inventory</h2>

      <div className="wine-inv-header">
        <select value={locationId} onChange={(e) => handleLocationChange(e.target.value)}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input
          type="text"
          placeholder="Search name or varietal…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="wine-inv-status-pills">
          {STATUS_VIEWS.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`wine-inv-pill${statusView === s.value ? ' active' : ''}`}
              onClick={() => setStatusView(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {items.length > 0 && (
        <p className="wine-inv-progress">{remaining} of {items.length} remaining</p>
      )}

      {error && <p className="wine-inv-error">{error}</p>}

      {loading ? (
        <p className="wine-inv-loading">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="wine-inv-empty">
          {items.length === 0 ? 'No available-for-sale wines found.' : 'Nothing matches the current filters.'}
        </p>
      ) : (
        <div className="wine-count-list">
          {visible.map((item) => (
            <WineCountCard
              key={item.id}
              item={item}
              locationId={locationId}
              allowsLibrary={locations.find((l) => l.id === locationId)?.allows_library !== false}
              onSaved={handleSaved}
            />
          ))}
        </div>
      )}
    </div>
  );
}
