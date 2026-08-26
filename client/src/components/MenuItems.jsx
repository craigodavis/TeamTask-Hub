import React, { useState, useEffect, useCallback } from 'react';
import { getMenuItems, updateMenuItem, saveMenuItemOrder } from '../api';
import './MenuItems.css';

const money = (c) => (c === null || c === undefined ? '—'
  : `$${(Number(c) / 100).toFixed(Number(c) % 100 ? 2 : 0)}`);

/**
 * The printed food and drink rows.
 *
 * Price is shown but never editable: the till is what charges the guest, so
 * Square is the authority. An editable copy here could only ever become a way
 * to print a price nobody is actually charged.
 */
export function MenuItems({ menuKey, onChanged }) {
  const [data, setData] = useState(null);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // item id
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setError('');
    getMenuItems(menuKey)
      .then((d) => { setData(d); setItems(d.items || []); })
      .catch((e) => { setError(e.message); setData(null); setItems([]); })
      .finally(() => setLoading(false));
  }, [menuKey]);

  useEffect(() => { load(); }, [load]);

  const startEdit = (it) => {
    setEditing(it.id);
    setDraft({
      name: it.name || '', description: it.description || '',
      note: it.note || '', serves: it.serves || '',
    });
  };

  const save = async (it) => {
    setSaving(true); setError('');
    try {
      await updateMenuItem(menuKey, it.id, draft);
      setEditing(null);
      load();
      onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const toggleActive = async (it) => {
    setSaving(true); setError('');
    try {
      await updateMenuItem(menuKey, it.id, { active: !it.active });
      load(); onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const onDrop = async (target) => {
    if (!dragging || dragging.id === target.id) return;
    // Reordering only ever happens WITHIN a section: the sections sit on
    // different panels of the booklet, so dragging a dessert into the brunch
    // drinks would move it to another page rather than just up the list.
    if (dragging.section !== target.section) { setDragging(null); return; }
    const next = items.filter((x) => x.id !== dragging.id);
    next.splice(next.findIndex((x) => x.id === target.id), 0, dragging);
    setDragging(null);
    setItems(next);
    setSaving(true);
    try {
      await saveMenuItemOrder(menuKey, next.map((x, i) => ({ id: x.id, sort_order: (i + 1) * 10 })));
      load(); onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  if (loading) return <p className="mi-loading">Loading items…</p>;
  if (!data) return error ? <p className="mi-error">{error}</p> : null;
  if (!items.length) {
    return <p className="mi-empty">This menu has no food or drink rows — its card is hand-authored.</p>;
  }

  const sections = [...new Set(items.map((i) => i.section))];
  const drifted = items.filter((i) => i.price_drifted);

  return (
    <div className="mi-wrap">
      <div className="mi-head">
        <h3 className="mi-title">Food &amp; Drink</h3>
        {saving && <span className="mi-saving">Saving…</span>}
      </div>
      <p className="mi-note">{data.priceNote}</p>
      {error && <p className="mi-error">{error}</p>}

      {/* Drift is worth surfacing rather than silently preferring one side:
          it usually means the local copy is behind a Square edit. */}
      {drifted.length > 0 && (
        <div className="mi-drift">
          ⚠ {drifted.length} item{drifted.length > 1 ? 's' : ''} whose last known price differs
          from Square. The menu prints the Square price.
        </div>
      )}

      {sections.map((sec) => (
        <div key={sec} className="mi-sec">
          <h4 className="mi-sec-head">{sec}</h4>
          <ul className="mi-list">
            {items.filter((i) => i.section === sec).map((it) => (
              <li key={it.id}
                  className={`mi-row${it.active ? '' : ' inactive'}${editing === it.id ? ' editing' : ''}`}
                  draggable={editing !== it.id}
                  onDragStart={() => setDragging(it)}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(it)}>
                {editing === it.id ? (
                  <div className="mi-edit">
                    <label className="mi-f">
                      <span>Name</span>
                      <input value={draft.name}
                             onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                    </label>
                    <label className="mi-f">
                      <span>Description</span>
                      <textarea rows={3} value={draft.description}
                                onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                      <small>A line break here prints as a line break on the menu.</small>
                    </label>
                    <div className="mi-two">
                      <label className="mi-f">
                        <span>Serves</span>
                        <input value={draft.serves} placeholder="Serves 2–3"
                               onChange={(e) => setDraft({ ...draft, serves: e.target.value })} />
                      </label>
                      <label className="mi-f">
                        <span>Note</span>
                        <input value={draft.note} placeholder="Comes with…"
                               onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
                      </label>
                    </div>
                    <label className="mi-f mi-locked">
                      <span>Price</span>
                      <input value={money(it.effective_cents)} readOnly disabled />
                      <small>
                        {it.sku
                          ? <>Set in Square on <b>{it.square_name || it.sku}</b> · SKU <code>{it.sku}</code></>
                          : <>Not linked to Square — this row prints no price.</>}
                      </small>
                    </label>
                    <div className="mi-actions">
                      <button type="button" className="mi-save" disabled={saving}
                              onClick={() => save(it)}>Save</button>
                      <button type="button" className="mi-cancel"
                              onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="mi-grip" aria-hidden>⠿</span>
                    <span className="mi-body">
                      <span className="mi-name">
                        {it.name}
                        <span className="mi-price">{money(it.effective_cents)}</span>
                        {it.price_drifted && (
                          <span className="mi-badge" title={`Last known here: ${money(it.price_cents)}`}>
                            Square differs
                          </span>
                        )}
                        {!it.sku && <span className="mi-badge unlinked">no Square link</span>}
                      </span>
                      {it.description && <span className="mi-desc">{it.description}</span>}
                      {it.serves && <span className="mi-serves">{it.serves}</span>}
                      {it.note && <span className="mi-serves">{it.note}</span>}
                    </span>
                    <span className="mi-btns">
                      <button type="button" onClick={() => startEdit(it)}>Edit</button>
                      <button type="button" onClick={() => toggleActive(it)}
                              title={it.active ? 'Keep off the printed menu' : 'Put back on the menu'}>
                        {it.active ? 'Hide' : 'Show'}
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
