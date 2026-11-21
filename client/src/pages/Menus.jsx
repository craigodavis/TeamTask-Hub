import React, { useState, useEffect, useCallback } from 'react';
import { getMenu, saveMenuOrder, printMenu } from '../api';
import { MenuItems } from '../components/MenuItems';
import './Menus.css';

const price = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`);

// Fallback only. The server now says which lists a menu has, because the Wine
// Menu has three (a tasting list plus the two bottle lists) and hard-coding
// white and red meant a tasting wine was fetched and then never rendered.
const DEFAULT_SECTIONS = [
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
  const sections = data?.sections?.length ? data.sections : DEFAULT_SECTIONS;
  // Lists a wine must be added to deliberately, rather than being on until hidden.
  const optIn = new Set(data?.optIn || []);

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

  // A wine is identified by product AND list now, because the Wine Menu can
  // hold the same bottle as a pour and as a bottle at once. Matching on id
  // alone moved both copies.
  const same = (a, b) => a.id === b.id && a.section === b.section;

  const onDrop = (target) => {
    if (!dragging || same(dragging, target)) return;
    const toOptIn = optIn.has(target.section) && !optIn.has(dragging.section);
    // Dragging onto an opt-in list ADDS the wine there and leaves it where it
    // was -- a wine poured by the glass is usually sold by the bottle too, so
    // moving it off the bottle list would be the wrong read of the gesture.
    const next = toOptIn ? [...wines] : wines.filter((w) => !same(w, dragging));
    const at = next.findIndex((w) => same(w, target));
    next.splice(at, 0, { ...dragging, section: target.section });
    setDragging(null);
    persist(next);
  };

  const toggleExcluded = (w) =>
    persist(wines.map((x) => (same(x, w) ? { ...x, excluded: !x.excluded } : x)));

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

      {/* The food and drink rows. Separate from the wine tables because a wine
          is a product that may appear on a menu, while these ARE the menu. */}
      {!loading && data && <MenuItems menuKey={menuKey} />}

      {!loading && data && (
        <div className="menus-grid">
          {sections.map((sec) => {
            const rows = wines.filter((w) => w.section === sec.key);
            const printingCount = rows.filter((w) => !w.excluded).length;
            const cap = data.capacity?.[sec.key];
            return (
              <div key={sec.key} className="menus-col">
                <h3 className="menus-col-head">
                  {sec.label}
                  {/* The bottle tables have a crowding limit; the tasting list
                      is a deliberate four and has none, so it shows a plain
                      count rather than "4 / undefined". */}
                  <span className={`menus-count${cap && printingCount > cap ? ' over' : ''}`}>
                    {cap ? `${printingCount} / ${cap}` : printingCount}
                  </span>
                </h3>
                <ul className="menus-list">
                  {rows.map((w) => (
                    <li
                      key={`${sec.key}:${w.id}`}
                      className={`menus-row${w.excluded ? ' excluded' : ''}`}
                      draggable
                      onDragStart={() => setDragging(w)}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDrop(w)}
                    >
                      <span className="menus-grip" aria-hidden>⠿</span>
                      <span className="menus-name">
                        {/* No vintage prefix: every vintaged product's name
                            already begins with its year, so prefixing printed
                            it twice ("23 23 Papa's"). */}
                        {w.name}
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
