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

// Auto-saves a case+bottle count (debounced) for one wine — no explicit Save button.
function WineCountCard({ item, locationId, onSaved }) {
  const [cases, setCases] = useState(item.cases ?? 0);
  const [bottles, setBottles] = useState(item.bottles ?? 0);
  const [savedFlash, setSavedFlash] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    setCases(item.cases ?? 0);
    setBottles(item.bottles ?? 0);
  }, [item.id]);

  const scheduleSave = useCallback((nextCases, nextBottles) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSave(nextCases, nextBottles), 500);
  }, []);

  const doSave = async (nextCases, nextBottles) => {
    // 0 cases + 0 bottles is indistinguishable from "never touched this
    // field" (that's the default state) — don't record it as a real count
    // or mark the card completed just because focus passed through it.
    if ((parseInt(nextCases, 10) || 0) === 0 && (parseInt(nextBottles, 10) || 0) === 0) return;
    try {
      await saveWineInventoryCount({
        product_id: item.id,
        location_id: locationId,
        cases: nextCases,
        bottles: nextBottles,
      });
      setSavedFlash(true);
      // Let the "✓ saved" flash be visible before this card can filter out of
      // the Uncompleted view (onSaved flips counted_today, which drives that).
      setTimeout(() => {
        setSavedFlash(false);
        onSaved(item.id, nextCases, nextBottles);
      }, 900);
    } catch {
      // Leave the values as typed; user can retry by editing again.
    }
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Rolls any full cases' worth of loose bottles into the case count —
  // e.g. 49 bottles -> +4 cases, 1 bottle remaining.
  const bottleCount = parseInt(bottles, 10) || 0;
  const canConvert = bottleCount >= CASE_SIZE;
  const handleConvert = () => {
    if (!canConvert) return;
    const extraCases = Math.floor(bottleCount / CASE_SIZE);
    const remainder = bottleCount % CASE_SIZE;
    const newCases = (parseInt(cases, 10) || 0) + extraCases;
    setCases(newCases);
    setBottles(remainder);
    clearTimeout(timerRef.current);
    doSave(newCases, remainder);
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
            onBlur={() => doSave(cases, bottles)}
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
            onBlur={() => doSave(cases, bottles)}
          />
        </label>
        <button
          type="button"
          className="wine-count-convert"
          onClick={handleConvert}
          disabled={!canConvert}
          title="Convert loose bottles into whole cases"
        >
          ⇄
        </button>
        {savedFlash && <span className="wine-count-saved">✓ saved</span>}
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
  // Defaults to "all" so counts entered in a prior session (or before a
  // refresh) stay visible. The Uncompleted view is opt-in, for actively
  // working a checklist top-to-bottom in one sitting.
  const [statusView, setStatusView] = useState('all');

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
            <WineCountCard key={item.id} item={item} locationId={locationId} onSaved={handleSaved} />
          ))}
        </div>
      )}
    </div>
  );
}
