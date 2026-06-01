import React, { useState, useEffect } from 'react';
import { getShoppingItems, createShoppingItem, updateShoppingItem, deleteShoppingItem } from '../api';
import './ShoppingCatalog.css';

const BLANK = { name: '', category: '', par_qty: '', par_unit: 'box', is_routine: true, notes: '' };

export function ShoppingCatalog() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null); // null = closed, BLANK = new, item = edit
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const load = async () => {
    try {
      const d = await getShoppingItems();
      setItems(d.items || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const filtered = items.filter((i) =>
    !search || i.name.toLowerCase().includes(search.toLowerCase()) ||
    (i.category || '').toLowerCase().includes(search.toLowerCase())
  );

  const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();

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

  if (loading) return <div className="catalog-loading">Loading…</div>;

  return (
    <div className="catalog-page">
      {error && <div className="catalog-error">{error}</div>}

      <div className="catalog-toolbar">
        <input
          type="search"
          placeholder="Search items…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="catalog-search"
        />
        <button type="button" className="btn-primary" onClick={() => setForm({ ...BLANK })}>
          + Add Item
        </button>
      </div>

      <table className="catalog-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Category</th>
            <th>Par</th>
            <th>Routine</th>
            <th>Last Purchased</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr><td colSpan={6} className="catalog-empty">No items yet. Add one above.</td></tr>
          )}
          {filtered.map((item) => (
            <tr key={item.id} className={item.is_routine ? '' : 'catalog-row-inactive'}>
              <td className="catalog-name">{item.name}</td>
              <td>{item.category || '—'}</td>
              <td>{item.par_qty != null ? `${item.par_qty} ${item.par_unit}` : '—'}</td>
              <td>
                <label className="catalog-toggle" title={item.is_routine ? 'On routine list' : 'Not on routine list'}>
                  <input type="checkbox" checked={item.is_routine} onChange={() => toggleRoutine(item)} />
                  <span className="catalog-toggle-slider" />
                </label>
              </td>
              <td className="catalog-date">
                {item.last_purchase_date
                  ? new Date(item.last_purchase_date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
                  : '—'}
              </td>
              <td className="catalog-actions">
                <button type="button" className="btn-small" onClick={() => setForm({ ...item, par_qty: item.par_qty ?? '' })}>Edit</button>
                <button type="button" className="btn-small btn-danger" onClick={() => handleDelete(item)}>Del</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Form modal */}
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
                <datalist id="catalog-cats">
                  {categories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </label>
              <div className="catalog-form-row">
                <label>Par Qty
                  <input type="number" min="0" step="0.5" value={form.par_qty}
                    onChange={(e) => setForm((f) => ({ ...f, par_qty: e.target.value }))} />
                </label>
                <label>Unit
                  <input value={form.par_unit} onChange={(e) => setForm((f) => ({ ...f, par_unit: e.target.value }))}
                    placeholder="box, case, roll…" />
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
