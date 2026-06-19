import React, { useState, useEffect, useRef } from 'react';
import { getLocations, getKitchenInventory, updateKitchenInventoryCount, reorderKitchenInventory } from '../api';
import './ShoppingInventory.css';

// On-hand counting per ingredient × location. An ingredient appears here once it
// is stocked at a location (set in Kitchen → Ingredients → edit → "Stock at locations").
export function KitchenInventory() {
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [inventory, setInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});
  const [error, setError] = useState('');
  const [countingId, setCountingId] = useState(null);
  const [countInput, setCountInput] = useState('');
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const listRef = useRef(null);

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
    getKitchenInventory(locationId)
      .then((d) => setInventory(d.inventory || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [locationId]);

  const openNumpad = (item) => {
    setCountingId(item.id);
    setCountInput(item.current_qty != null ? String(item.current_qty) : '');
  };

  const numpadPress = (val) => {
    if (val === 'del') setCountInput((p) => p.slice(0, -1));
    else if (val === '.') { if (!countInput.includes('.')) setCountInput((p) => p + '.'); }
    else setCountInput((p) => p + val);
  };

  const saveCount = async () => {
    const item = inventory.find((i) => i.id === countingId);
    if (!item || !locationId) return;
    const qty = parseFloat(countInput);
    if (isNaN(qty)) { setCountingId(null); return; }
    setSaving((p) => ({ ...p, [item.id]: true }));
    try {
      await updateKitchenInventoryCount(item.id, locationId, { current_qty: qty });
      setInventory((prev) => prev.map((i) =>
        i.id === item.id ? { ...i, current_qty: qty, last_counted_at: new Date().toISOString() } : i
      ));
    } catch (e) { setError(e.message); }
    finally {
      setSaving((p) => ({ ...p, [item.id]: false }));
      setCountingId(null);
    }
  };

  const onDragStart = (e, idx) => { setDragIndex(idx); e.dataTransfer.effectAllowed = 'move'; };
  const onDragOver = (e, idx) => { e.preventDefault(); setDragOverIndex(idx); };
  const onDrop = async (e, idx) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === idx) { setDragIndex(null); setDragOverIndex(null); return; }
    const reordered = [...inventory];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(idx, 0, moved);
    setInventory(reordered);
    setDragIndex(null);
    setDragOverIndex(null);
    const order = reordered.map((item, i) => ({ ingredient_id: item.id, sort_order: i }));
    try { await reorderKitchenInventory(locationId, order); } catch (e) { setError(e.message); }
  };

  const needsReorder = (item) => item.par_qty != null && (item.current_qty ?? 0) < item.par_qty;
  const needed = (item) => item.par_qty != null ? Math.max(0, item.par_qty - (item.current_qty ?? 0)) : null;
  const formatDate = (ts) => {
    if (!ts) return null;
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  if (loading) return <div className="inv-loading">Loading inventory…</div>;

  return (
    <div className="inv-page">
      {error && <div className="inv-error">{error}</div>}

      {locations.length > 1 && (
        <div className="inv-location-bar">
          {locations.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`inv-loc-btn${locationId === l.id ? ' active' : ''}`}
              onClick={() => setLocationId(l.id)}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}

      {inventory.length === 0 && (
        <div className="inv-empty">
          <p>No items stocked at this location yet.</p>
          <p>In <strong>Ingredients</strong>, edit an item and check this location under &quot;Stock at locations.&quot;</p>
        </div>
      )}

      <ul className="inv-list" ref={listRef}>
        {inventory.map((item, idx) => (
          <li
            key={item.id}
            className={`inv-item${needsReorder(item) ? ' needs-reorder' : ''}${dragOverIndex === idx ? ' drag-over' : ''}`}
            draggable
            onDragStart={(e) => onDragStart(e, idx)}
            onDragOver={(e) => onDragOver(e, idx)}
            onDrop={(e) => onDrop(e, idx)}
            onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
          >
            <div className="inv-drag-handle">⠿</div>
            <div className="inv-item-info">
              <span className="inv-item-name">{item.name}</span>
              <span className="inv-item-par">
                Par: {item.par_qty != null ? `${item.par_qty} ${item.par_unit || ''}` : '—'}
                {needsReorder(item) && (
                  <span className="inv-need-badge"> need {needed(item)} {item.par_unit}</span>
                )}
              </span>
              {item.last_counted_at && (
                <span className="inv-last-count">counted {formatDate(item.last_counted_at)}</span>
              )}
            </div>
            <button
              type="button"
              className={`inv-count-btn${needsReorder(item) ? ' low' : ''}`}
              onClick={() => openNumpad(item)}
              disabled={saving[item.id]}
            >
              {saving[item.id] ? '…' : item.current_qty != null ? item.current_qty : '—'}
            </button>
          </li>
        ))}
      </ul>

      {countingId && (() => {
        const item = inventory.find((i) => i.id === countingId);
        return (
          <div className="inv-numpad-overlay" onClick={() => setCountingId(null)}>
            <div className="inv-numpad" onClick={(e) => e.stopPropagation()}>
              <div className="inv-numpad-title">{item?.name}</div>
              <div className="inv-numpad-display">{countInput || '0'} <span className="inv-numpad-unit">{item?.par_unit}</span></div>
              <div className="inv-numpad-keys">
                {['7','8','9','4','5','6','1','2','3','.','0','del'].map((k) => (
                  <button key={k} type="button" className={`inv-key${k === 'del' ? ' del' : ''}`} onClick={() => numpadPress(k)}>
                    {k === 'del' ? '⌫' : k}
                  </button>
                ))}
              </div>
              <div className="inv-numpad-actions">
                <button type="button" className="inv-key-cancel" onClick={() => setCountingId(null)}>Cancel</button>
                <button type="button" className="inv-key-save" onClick={saveCount}>Save</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
