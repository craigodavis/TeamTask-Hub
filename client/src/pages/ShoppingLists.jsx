import React, { useState, useEffect } from 'react';
import { getLocations, getKitchenShoppingList } from '../api';
import './ShoppingLists.css';

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const qty = (n) => {
  if (n == null) return '—';
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
};

// Generated shopping list per location: ingredients under par, shortage qty,
// fulfilling vendor sources (default first), and each item's price before /
// after its share of the single company "cost to shop".
export function ShoppingLists() {
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [data, setData] = useState({ items: [], cost_to_shop: 0, total_before: 0, total_after: 0 });
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

      {!loading && data.cost_to_shop > 0 && items.length > 0 && (
        <div className="sl-summary">
          <span>Cost to shop: <strong>{money(data.cost_to_shop)}</strong></span>
          <span>Items: <strong>{money(data.total_before)}</strong> → <strong>{money(data.total_after)}</strong> landed</span>
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
        <ul className="sl-list">
          {items.map((item) => {
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
                    {item.default_vendor && (
                      <span className="sl-item-src">
                        {item.default_vendor}{item.default_price != null ? ` @ ${money(item.default_price)}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="sl-item-cost">
                    {data.cost_to_shop > 0 ? (
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
          })}
        </ul>
      )}
    </div>
  );
}
