import React, { useState, useEffect } from 'react';
import {
  getShoppingItems, createShoppingItem, updateShoppingItem, deleteShoppingItem,
  getRawShoppingItems, matchRawShoppingItem, ignoreRawShoppingItem, syncRawShoppingItems,
} from '../api';
import './ShoppingCatalog.css';

const BLANK = { name: '', category: '', par_qty: '', par_unit: 'box', is_routine: true, notes: '' };

export function ShoppingCatalog() {
  const [tab, setTab] = useState('queue'); // 'queue' | 'catalog'
  const [items, setItems] = useState([]);
  const [rawItems, setRawItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rawLoading, setRawLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  // Matching state
  const [matchingRaw, setMatchingRaw] = useState(null); // raw item being matched
  const [matchMode, setMatchMode] = useState('existing'); // 'existing' | 'new'
  const [matchItemId, setMatchItemId] = useState('');
  const [newItemName, setNewItemName] = useState('');

  const loadCatalog = async () => {
    try { const d = await getShoppingItems(); setItems(d.items || []); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const loadQueue = async () => {
    setRawLoading(true);
    try { const d = await getRawShoppingItems('false'); setRawItems(d.raw || []); }
    catch (e) { setError(e.message); }
    finally { setRawLoading(false); }
  };

  useEffect(() => { loadCatalog(); loadQueue(); }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await syncRawShoppingItems();
      setError('');
      await loadQueue();
      setError(`Synced ${r.synced} items from receipt history.`);
    } catch (e) { setError(e.message); }
    finally { setSyncing(false); }
  };

  const handleMatch = async () => {
    if (!matchingRaw) return;
    setSaving(true);
    try {
      if (matchMode === 'existing') {
        if (!matchItemId) return;
        await matchRawShoppingItem(matchingRaw.id, { shopping_item_id: matchItemId });
      } else {
        if (!newItemName.trim()) return;
        await matchRawShoppingItem(matchingRaw.id, { create_new: { name: newItemName.trim() } });
        await loadCatalog();
      }
      setRawItems((prev) => prev.filter((r) => r.id !== matchingRaw.id));
      setMatchingRaw(null);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const handleIgnore = async (raw) => {
    try {
      await ignoreRawShoppingItem(raw.id);
      setRawItems((prev) => prev.filter((r) => r.id !== raw.id));
    } catch (e) { setError(e.message); }
  };

  const handleSave = async () => {
    if (!form.name?.trim()) return;
    setSaving(true);
    try {
      if (form.id) {
        const updated = await updateShoppingItem(form.id, form);
        setItems((prev) => prev.map((i) => i.id === form.id ? updated : i));
      } else {
        const created = await createShoppingItem(form);
        setItems((prev) => [...prev, created]);
      }
      setForm(null);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (item) => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    try {
      await deleteShoppingItem(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e) { setError(e.message); }
  };

  const toggleRoutine = async (item) => {
    try {
      const updated = await updateShoppingItem(item.id, { is_routine: !item.is_routine });
      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, ...updated } : i));
    } catch (e) { setError(e.message); }
  };

  const filtered = items.filter((i) =>
    !search || i.name.toLowerCase().includes(search.toLowerCase()) ||
    (i.category || '').toLowerCase().includes(search.toLowerCase())
  );

  const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();

  const fmt = (ts) => ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' }) : '—';

  return (
    <div className="catalog-page">
      {error && <div className={error.startsWith('Synced') ? 'catalog-success' : 'catalog-error'}>{error}</div>}

      {/* Sub-tabs */}
      <div className="catalog-tabs">
        <button type="button" className={`catalog-tab${tab === 'queue' ? ' active' : ''}`} onClick={() => setTab('queue')}>
          Matching Queue {rawItems.length > 0 && <span className="catalog-badge">{rawItems.length}</span>}
        </button>
        <button type="button" className={`catalog-tab${tab === 'catalog' ? ' active' : ''}`} onClick={() => setTab('catalog')}>
          Item Catalog
        </button>
      </div>

      {/* ── Matching Queue ── */}
      {tab === 'queue' && (
        <div className="catalog-queue">
          <div className="catalog-queue-header">
            <p className="catalog-queue-desc">
              These items came from your receipts. Match each one to a catalog item (or create a new one), or ignore it.
            </p>
            <button type="button" className="btn-secondary" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Syncing…' : '↻ Sync from receipt history'}
            </button>
          </div>

          {rawLoading && <div className="catalog-loading">Loading…</div>}
          {!rawLoading && rawItems.length === 0 && (
            <div className="catalog-empty">
              <p>Queue is empty — all items have been matched or ignored.</p>
              <p>Click "Sync from receipt history" to import items from past receipts.</p>
            </div>
          )}

          {rawItems.map((raw) => (
            <div key={raw.id} className="catalog-raw-row">
              <div className="catalog-raw-info">
                <span className="catalog-raw-desc">{raw.description_raw}</span>
                <div className="catalog-raw-meta">
                  <span className="catalog-raw-vendor">{raw.vendor || '—'}</span>
                  {raw.last_price && <span>${parseFloat(raw.last_price).toFixed(2)}</span>}
                  <span>{fmt(raw.last_purchase_date)}</span>
                  <span>{raw.purchase_count}× purchased</span>
                </div>
              </div>
              <div className="catalog-raw-actions">
                <button type="button" className="btn-primary btn-small"
                  onClick={() => { setMatchingRaw(raw); setMatchMode('existing'); setMatchItemId(''); setNewItemName(raw.description_raw); }}>
                  Match
                </button>
                <button type="button" className="btn-small btn-danger" onClick={() => handleIgnore(raw)}>Ignore</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Item Catalog ── */}
      {tab === 'catalog' && (
        <>
          <div className="catalog-toolbar">
            <input type="search" placeholder="Search items…" value={search}
              onChange={(e) => setSearch(e.target.value)} className="catalog-search" />
            <button type="button" className="btn-primary" onClick={() => setForm({ ...BLANK })}>+ Add Item</button>
          </div>

          {loading ? <div className="catalog-loading">Loading…</div> : (
            <table className="catalog-table">
              <thead>
                <tr>
                  <th>Name</th><th>Category</th><th>Par</th><th>Routine</th><th>Last Purchased</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && <tr><td colSpan={6} className="catalog-empty">No items yet.</td></tr>}
                {filtered.map((item) => (
                  <tr key={item.id} className={item.is_routine ? '' : 'catalog-row-inactive'}>
                    <td className="catalog-name">{item.name}</td>
                    <td>{item.category || '—'}</td>
                    <td>{item.par_qty != null ? `${item.par_qty} ${item.par_unit}` : '—'}</td>
                    <td>
                      <label className="catalog-toggle">
                        <input type="checkbox" checked={item.is_routine} onChange={() => toggleRoutine(item)} />
                        <span className="catalog-toggle-slider" />
                      </label>
                    </td>
                    <td className="catalog-date">{fmt(item.last_purchase_date)}</td>
                    <td className="catalog-actions">
                      <button type="button" className="btn-small" onClick={() => setForm({ ...item, par_qty: item.par_qty ?? '' })}>Edit</button>
                      <button type="button" className="btn-small btn-danger" onClick={() => handleDelete(item)}>Del</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {/* Match modal */}
      {matchingRaw && (
        <div className="catalog-modal-overlay" onClick={() => setMatchingRaw(null)}>
          <div className="catalog-modal" onClick={(e) => e.stopPropagation()}>
            <div className="catalog-modal-header">
              <h3>Match Item</h3>
              <button type="button" onClick={() => setMatchingRaw(null)}>✕</button>
            </div>
            <div className="catalog-form">
              <div className="catalog-raw-match-item">
                <strong>{matchingRaw.description_raw}</strong>
                <span>{matchingRaw.vendor} · {matchingRaw.last_price ? `$${parseFloat(matchingRaw.last_price).toFixed(2)}` : ''}</span>
              </div>
              <div className="catalog-match-modes">
                <label className="catalog-match-mode">
                  <input type="radio" checked={matchMode === 'existing'} onChange={() => setMatchMode('existing')} />
                  Match to existing item
                </label>
                <label className="catalog-match-mode">
                  <input type="radio" checked={matchMode === 'new'} onChange={() => setMatchMode('new')} />
                  Create new item
                </label>
              </div>
              {matchMode === 'existing' ? (
                <label>Select item
                  <select value={matchItemId} onChange={(e) => setMatchItemId(e.target.value)}>
                    <option value="">— select —</option>
                    {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </select>
                </label>
              ) : (
                <label>New item name
                  <input value={newItemName} onChange={(e) => setNewItemName(e.target.value)} />
                </label>
              )}
            </div>
            <div className="catalog-modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setMatchingRaw(null)}>Cancel</button>
              <button type="button" className="btn-primary" onClick={handleMatch} disabled={saving}>
                {saving ? 'Saving…' : 'Confirm Match'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Item form modal */}
      {form && (
        <div className="catalog-modal-overlay" onClick={() => setForm(null)}>
          <div className="catalog-modal" onClick={(e) => e.stopPropagation()}>
            <div className="catalog-modal-header">
              <h3>{form.id ? 'Edit Item' : 'Add Item'}</h3>
              <button type="button" onClick={() => setForm(null)}>✕</button>
            </div>
            <div className="catalog-form">
              <label>Name *
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Nitrile Gloves, Small, Box/1000" />
              </label>
              <label>Category
                <input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  placeholder="e.g. PPE, Cleaning, Kitchen" list="catalog-cats" />
                <datalist id="catalog-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
              </label>
              <div className="catalog-form-row">
                <label>Par Qty
                  <input type="number" min="0" step="0.5" value={form.par_qty}
                    onChange={(e) => setForm((f) => ({ ...f, par_qty: e.target.value }))} />
                </label>
                <label>Unit
                  <input value={form.par_unit} onChange={(e) => setForm((f) => ({ ...f, par_unit: e.target.value }))} placeholder="box, case, roll…" />
                </label>
              </div>
              <label className="catalog-form-check">
                <input type="checkbox" checked={form.is_routine} onChange={(e) => setForm((f) => ({ ...f, is_routine: e.target.checked }))} />
                Include on routine shopping list
              </label>
              <label>Notes
                <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
              </label>
            </div>
            <div className="catalog-modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setForm(null)}>Cancel</button>
              <button type="button" className="btn-primary" onClick={handleSave} disabled={saving || !form.name?.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
