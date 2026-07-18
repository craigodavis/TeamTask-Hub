import React, { useState, useEffect } from 'react';
import { getLocations, getKitchenShoppingList } from '../api';
import './ShoppingLists.css';

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const qty = (n) => {
  if (n == null) return '—';
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
};

// Generated shopping list per location, grouped by store. Each store's trip
// cost (cost to shop) is spread across only that store's items by dollar value,
// so each item shows its price before / after its share of the trip.
export function ShoppingLists() {
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [data, setData] = useState({ items: [], stores: [], total_before: 0, total_trip_cost: 0, total_after: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    getLocations()
      .then((d) => {
        const locs = d.locations || [];
        setLocations(locs);
        if (locs.length > 0) setLocationId(locs[0].id);
        else setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!locationId) return;
    setLoading(true);
    setError('');
    getKitchenShoppingList(locationId)
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [locationId]);

  const toggle = (id) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  const items = data.items || [];
  const storeSummaries = (data.stores || []).slice().sort((a, b) => a.store.localeCompare(b.store));
  const itemsByStore = new Map();
  for (const it of items) {
    const key = it.store || 'Unassigned';
    if (!itemsByStore.has(key)) itemsByStore.set(key, []);
    itemsByStore.get(key).push(it);
  }
  const hasTripCost = (data.total_trip_cost || 0) > 0;

  const renderItem = (item) => {
    const sources = item.sources || [];
    const isOpen = !!expanded[item.id];
    return (
      <li key={`${item.id}-${item.location_id}`} className="sl-item">
        <div className="sl-item-head">
          <div className="sl-item-main">
            <span className="sl-item-name">{item.name}</span>
            <span className="sl-item-buy">
              Buy {qty(item.needed_qty)} {item.par_unit || ''}
              <span className="sl-item-have"> (have {qty(item.current_qty || 0)} / par {qty(item.par_qty)})</span>
            </span>
            {item.default_price != null && (
              <span className="sl-item-src">{money(item.default_price)} each</span>
            )}
          </div>
          <div className="sl-item-cost">
            {hasTripCost && item.shop_cost_share > 0 ? (
              <>
                <span className="sl-cost-before">{money(item.price_before)}</span>
                <span className="sl-cost-after">{money(item.price_after)}</span>
                <span className="sl-cost-label">+{money(item.shop_cost_share)} trip</span>
              </>
            ) : (
              <span className="sl-cost-after">{money(item.price_before)}</span>
            )}
          </div>
        </div>
        {sources.length > 0 && (
          <button type="button" className="sl-src-toggle" onClick={() => toggle(item.id)}>
            {isOpen ? '▾' : '▸'} {sources.length} source{sources.length !== 1 ? 's' : ''}
          </button>
        )}
        {isOpen && (
          <ul className="sl-src-list">
            {sources.map((s) => (
              <li key={s.id} className={`sl-src-row${s.is_primary ? ' primary' : ''}`}>
                <span className="sl-src-vendor">{s.vendor || '—'}{s.is_primary ? ' ★' : ''}</span>
                <span className="sl-src-name">{s.product_name || s.description || ''}</span>
                <span className="sl-src-price">{money(s.last_price)}{s.unit ? ` / ${s.unit}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="sl-page">
      {error && <div className="sl-error">{error}</div>}

      {locations.length > 1 && (
        <div className="sl-location-bar">
          {locations.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`sl-loc-btn${locationId === l.id ? ' active' : ''}`}
              onClick={() => setLocationId(l.id)}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="sl-summary">
          <span>Items: <strong>{money(data.total_before)}</strong>{hasTripCost && <> → <strong>{money(data.total_after)}</strong> landed</>}</span>
          {hasTripCost && <span>Trip costs: <strong>{money(data.total_trip_cost)}</strong></span>}
        </div>
      )}

      {loading ? (
        <div className="sl-loading">Loading shopping list…</div>
      ) : items.length === 0 ? (
        <div className="sl-empty">
          <p>Nothing below par at this location.</p>
          <p>Set par levels and count inventory in <strong>Kitchen → Inventory</strong>.</p>
        </div>
      ) : (
        [...itemsByStore.keys()].sort((a, b) => a.localeCompare(b)).map((store) => {
          const summary = storeSummaries.find((s) => s.store === store);
          return (
            <div key={store} className="sl-store-group">
              <div className="sl-store-head">
                <span className="sl-store-name">{store}</span>
                {summary && summary.trip_cost > 0 && (
                  <span className="sl-store-trip">
                    {money(summary.items_before)} + {money(summary.trip_cost)} trip = <strong>{money(summary.items_after)}</strong>
                  </span>
                )}
              </div>
              <ul className="sl-list">
                {itemsByStore.get(store).map(renderItem)}
              </ul>
            </div>
          );
        })
      )}
    </div>
  );
}
