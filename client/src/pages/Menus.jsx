import React, { useState, useEffect, useCallback } from 'react';
import { getMenu, saveMenuOrder, printMenu } from '../api';
import './Menus.css';

const price = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`);

const SECTIONS = [
  { key: 'white', label: 'White & Rosé' },
  { key: 'red', label: 'Red' },
];

export function Menus() {
  const [menuKey, setMenuKey] = useState('creek');
  const [data, setData] = useState(null);
  const [wines, setWines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [dragging, setDragging] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getMenu(menuKey)
      .then((d) => { setData(d); setWines(d.wines || []); })
      .catch((e) => { setError(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, [menuKey]);

  useEffect(() => { load(); }, [load]);

  const persist = async (next) => {
    setWines(next);
    setSaving(true);
    try {
      await saveMenuOrder(menuKey, next.map((w, i) => ({
        product_id: w.id, section: w.section, sort_order: i, excluded: w.excluded,
      })));
      // Reload so the capacity warnings reflect what was just saved rather
      // than what was on screen before the change.
      const d = await getMenu(menuKey);
      setData(d);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const onDrop = (target) => {
    if (!dragging || dragging.id === target.id) return;
    const next = wines.filter((w) => w.id !== dragging.id);
    const at = next.findIndex((w) => w.id === target.id);
    // Dropping onto a row in the other table moves the wine between sections.
    next.splice(at, 0, { ...dragging, section: target.section });
    setDragging(null);
    persist(next);
  };

  const toggleExcluded = (w) =>
    persist(wines.map((x) => (x.id === w.id ? { ...x, excluded: !x.excluded } : x)));

  const doPrint = async () => {
    setPrinting(true);
    setError('');
    try {
      const blob = await printMenu(menuKey);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setError(e.message); }
    finally { setPrinting(false); }
  };

  return (
    <div className="menus-page">
      <h2 className="menus-title">Menus</h2>
      <p className="menus-sub">
        Wines available for sale appear here. Drag to set the printed order, and
        drag between the two tables to move a wine. A wine with no glass price
        prints as bottle-only.
      </p>

      <div className="menus-toolbar">
        {(data?.menus || []).map((m) => (
          <button
            key={m.key}
            type="button"
            className={`menus-tab${menuKey === m.key ? ' active' : ''}`}
            onClick={() => setMenuKey(m.key)}
          >
            {m.name}
          </button>
        ))}
        <span className="menus-spacer" />
        {saving && <span className="menus-saving">Saving…</span>}
        <button type="button" className="menus-print" onClick={doPrint} disabled={printing}>
          {printing ? 'Building PDF…' : 'Print Menu'}
        </button>
      </div>

      {error && <p className="menus-error">{error}</p>}
      {loading && <p className="menus-loading">Loading…</p>}

      {/* Capacity is a print constraint, not a data one — past this the table
          crowds the footnotes and the page needs re-laying out. */}
      {data?.warnings?.map((w) => (
        <div key={w.section} className="menus-warning">⚠ {w.message}</div>
      ))}

      {!loading && data && (
        <div className="menus-grid">
          {SECTIONS.map((sec) => {
            const rows = wines.filter((w) => w.section === sec.key);
            const printingCount = rows.filter((w) => !w.excluded).length;
            const cap = data.capacity?.[sec.key];
            return (
              <div key={sec.key} className="menus-col">
                <h3 className="menus-col-head">
                  {sec.label}
                  <span className={`menus-count${printingCount > cap ? ' over' : ''}`}>
                    {printingCount} / {cap}
                  </span>
                </h3>
                <ul className="menus-list">
                  {rows.map((w) => (
                    <li
                      key={w.id}
                      className={`menus-row${w.excluded ? ' excluded' : ''}`}
                      draggable
                      onDragStart={() => setDragging(w)}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDrop(w)}
                    >
                      <span className="menus-grip" aria-hidden>⠿</span>
                      <span className="menus-name">
                        {w.vintage ? `${String(w.vintage).slice(-2)} ` : ''}{w.name}
                        <em>{w.varietal}</em>
                      </span>
                      <span className="menus-price">
                        {w.glass === null
                          ? <span className="menus-nogl">bottle only</span>
                          : `${price(w.glass)} glass`}
                        <em>{price(w.bottle)} btl</em>
                      </span>
                      <button
                        type="button"
                        className="menus-toggle"
                        onClick={() => toggleExcluded(w)}
                        title={w.excluded ? 'Put back on the menu' : 'Keep off this menu'}
                      >
                        {w.excluded ? 'Add' : 'Hide'}
                      </button>
                    </li>
                  ))}
                  {!rows.length && <li className="menus-empty">Nothing here yet.</li>}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
