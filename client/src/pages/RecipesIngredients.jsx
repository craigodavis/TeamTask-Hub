import React, { useState, useEffect, useCallback } from 'react';
import {
  getRecipesIngredients, createRecipesIngredient, updateRecipesIngredient, deleteRecipesIngredient,
  getRecipesCatalog, patchRecipesCatalogItem, getLocations,
} from '../api';
import { PurchaseHistoryModal } from './RecipesCatalog';

const UNITS = ['g', 'oz', 'ml', 'each', 'lb', 'kg'];
const PAR_UNITS = ['each', 'box', 'case', 'lb', 'oz', 'g', 'kg', 'bag', 'bottle', 'can'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th'];
const BUY_FREQUENCIES = [
  { value: '',                label: '— not set —' },
  { value: 'daily',           label: 'Daily' },
  { value: 'weekly',          label: 'Weekly on…' },
  { value: 'biweekly',        label: 'Bi-Weekly on…' },
  { value: 'monthly',         label: 'Monthly on day…' },
  { value: 'monthly_weekday', label: 'Monthly on Nth weekday…' },
  { value: 'adhoc',           label: 'Ad-Hoc' },
];

function buyFrequencyLabel(ing) {
  if (!ing.buy_frequency) return null;
  if (ing.buy_frequency === 'daily')           return 'Daily';
  if (ing.buy_frequency === 'adhoc')           return 'Ad-Hoc';
  if (ing.buy_frequency === 'weekly')          return `Weekly · ${WEEKDAYS[ing.buy_day_of_week] || '?'}`;
  if (ing.buy_frequency === 'biweekly')        return `Bi-Weekly · ${WEEKDAYS[ing.buy_day_of_week] || '?'}`;
  if (ing.buy_frequency === 'monthly')         return `Monthly · day ${ing.buy_day_of_month || '?'}`;
  if (ing.buy_frequency === 'monthly_weekday') return `Monthly · ${WEEK_ORDINALS[ing.buy_week_of_month] || '?'} ${WEEKDAYS[ing.buy_day_of_week] || '?'}`;
  return ing.buy_frequency;
}

function fmt(price) {
  if (price == null) return '—';
  return `$${parseFloat(price).toFixed(2)}`;
}

function fmtDate(d) {
  if (!d) return '—';
  return d.slice(0, 10);
}

function vendorItemUrl(vendor, itemNumber) {
  if (!itemNumber) return null;
  const v = (vendor || '').toLowerCase();
  if (v.includes('chef'))  return `https://www.chefstore.com/search/fullsearch/${encodeURIComponent(itemNumber)}/`;
  if (v.includes('sysco')) return `https://shop.sysco.com/app/catalog?q=${encodeURIComponent(itemNumber)}`;
  return null;
}

function IngredientForm({ onCreated }) {
  const [name, setName]         = useState('');
  const [description, setDesc]  = useState('');
  const [baseUnit, setBaseUnit] = useState('g');
  const [saving, setSaving]     = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createRecipesIngredient({ name: name.trim(), description: description.trim() || undefined, base_unit: baseUnit });
      setName(''); setDesc(''); setBaseUnit('g');
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem', alignItems: 'flex-end' }}>
      <div className="form-group" style={{ flex: '2 1 180px' }}>
        <label>Ingredient name</label>
        <input type="text" placeholder="e.g. Mozzarella" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="form-group" style={{ flex: '3 1 200px' }}>
        <label>Description (optional)</label>
        <input type="text" placeholder="Whole milk, shredded…" value={description} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <div className="form-group" style={{ flex: '1 1 100px' }}>
        <label>Base unit</label>
        <select value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)}>
          {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
      <button type="submit" className="btn-primary" disabled={saving} style={{ marginBottom: 2 }}>
        {saving ? 'Adding…' : '+ Add Item'}
      </button>
    </form>
  );
}

function EditIngredientModal({ ingredient, onSave, onClose }) {
  const [name, setName]         = useState(ingredient.name);
  const [description, setDesc]  = useState(ingredient.description || '');
  const [baseUnit, setBaseUnit] = useState(ingredient.base_unit || 'g');
  const [isActive, setActive]   = useState(ingredient.is_active !== false);
  const [parQty, setParQty]     = useState(ingredient.par_qty ?? '');
  const [parUnit, setParUnit]   = useState(ingredient.par_unit || 'each');
  const [freq, setFreq]         = useState(ingredient.buy_frequency || '');
  const [dow, setDow]           = useState(ingredient.buy_day_of_week ?? 1);
  const [dom, setDom]           = useState(ingredient.buy_day_of_month ?? 1);
  const [wom, setWom]           = useState(ingredient.buy_week_of_month ?? 1);
  const [locations, setLocations]   = useState([]);
  const [locIds, setLocIds]         = useState(new Set(ingredient.location_ids || []));
  const [saving, setSaving]     = useState(false);

  useEffect(() => { getLocations().then((d) => setLocations(d.locations || [])).catch(() => {}); }, []);

  const toggleLoc = (id) => setLocIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateRecipesIngredient(ingredient.id, {
        name: name.trim(),
        description: description.trim() || null,
        base_unit: baseUnit,
        is_active: isActive,
        par_qty: parQty === '' ? null : parQty,
        par_unit: parUnit,
        buy_frequency: freq || null,
        buy_day_of_week:  (freq === 'weekly' || freq === 'biweekly' || freq === 'monthly_weekday') ? dow : null,
        buy_day_of_month: (freq === 'monthly') ? dom : null,
        buy_week_of_month:(freq === 'monthly_weekday') ? wom : null,
        location_ids: [...locIds],
      });
      onSave();
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = { padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card)', color: 'var(--text)' };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560, width: '95vw' }} onClick={(e) => e.stopPropagation()}>
        <h3>Edit Item</h3>
        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label>Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label>Description</label>
          <input type="text" value={description} onChange={(e) => setDesc(e.target.value)} placeholder="Optional notes" />
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ flex: '1 1 120px' }}>
            <label>Base unit (recipes)</label>
            <select value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ flex: '1 1 100px' }}>
            <label>Par qty</label>
            <input type="number" min="0" step="any" value={parQty} onChange={(e) => setParQty(e.target.value)} placeholder="—" />
          </div>
          <div className="form-group" style={{ flex: '1 1 100px' }}>
            <label>Par unit</label>
            <select value={parUnit} onChange={(e) => setParUnit(e.target.value)}>
              {PAR_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>

        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label>Buy frequency</label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <select value={freq} onChange={(e) => setFreq(e.target.value)} style={{ ...inputStyle, flex: '1 1 180px' }}>
              {BUY_FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            {(freq === 'weekly' || freq === 'biweekly') && (
              <select value={dow} onChange={(e) => setDow(Number(e.target.value))} style={inputStyle}>
                {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            )}
            {freq === 'monthly' && (
              <select value={dom} onChange={(e) => setDom(Number(e.target.value))} style={inputStyle}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
            {freq === 'monthly_weekday' && (
              <>
                <select value={wom} onChange={(e) => setWom(Number(e.target.value))} style={inputStyle}>
                  {[1, 2, 3, 4, 5].map((w) => <option key={w} value={w}>{WEEK_ORDINALS[w]}</option>)}
                </select>
                <select value={dow} onChange={(e) => setDow(Number(e.target.value))} style={inputStyle}>
                  {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </>
            )}
          </div>
        </div>

        {locations.length > 0 && (
          <div className="form-group" style={{ marginBottom: '0.75rem' }}>
            <label>Stock at locations (enables inventory counting)</label>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              {locations.map((l) => (
                <label key={l.id} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                  <input type="checkbox" checked={locIds.has(l.id)} onChange={() => toggleLoc(l.id)} />
                  {l.name}
                </label>
              ))}
            </div>
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', marginBottom: '1rem' }}>
          <input type="checkbox" checked={isActive} onChange={(e) => setActive(e.target.checked)} />
          Active (available for recipe use)
        </label>
        <div className="modal-footer">
          <button type="button" className="btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Inline "add source" row shown at the bottom of an expanded ingredient's sources.
function AddSourceRow({ ingredientId, catalog, catalogLoading, onAdd }) {
  const [selectedId, setSelectedId] = useState('');

  // Catalog items not yet linked to any ingredient
  const available = (catalog || []).filter((c) => !c.ingredient_id);

  const handleAdd = async () => {
    if (!selectedId) return;
    await onAdd(selectedId);
    setSelectedId('');
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', paddingLeft: '2rem', paddingTop: '0.4rem' }}>
      {catalogLoading ? (
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted,#888)' }}>Loading catalog…</span>
      ) : (
        <>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{ flex: 1, maxWidth: 460, padding: '0.35rem 0.5rem', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card)', color: 'var(--text)', fontSize: '0.8rem' }}
          >
            <option value="">— Link a catalog item as a source —</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.product_name || c.description_raw}
                {c.vendor ? ` · ${c.vendor}` : ''}
                {c.vendor_item_number ? ` · #${c.vendor_item_number}` : ''}
                {c.last_price ? ` · ${fmt(c.last_price)}` : ''}
              </option>
            ))}
          </select>
          <button className="btn-sm btn-primary" onClick={handleAdd} disabled={!selectedId}>Add</button>
        </>
      )}
    </div>
  );
}

export function RecipesIngredients() {
  const [ingredients, setIngredients]   = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [expanded, setExpanded]         = useState(new Set());
  const [editFor, setEditFor]           = useState(null);
  const [purchaseItem, setPurchaseItem] = useState(null);

  // Catalog for "add source" dropdowns — loaded once lazily
  const [catalog, setCatalog]           = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await getRecipesIngredients();
      setIngredients(r.ingredients || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadCatalog = useCallback(async () => {
    if (catalog !== null || catalogLoading) return;
    setCatalogLoading(true);
    try {
      const r = await getRecipesCatalog({ status: 'unignored', limit: 1000, grocery: false });
      setCatalog(r.items || []);
    } finally {
      setCatalogLoading(false);
    }
  }, [catalog, catalogLoading]);

  const toggleExpand = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        loadCatalog();
      }
      return next;
    });
  };

  const handleAddSource = async (ingredientId, rawId) => {
    await patchRecipesCatalogItem(rawId, { ingredient_id: ingredientId });
    setCatalog(null); // invalidate so it reloads fresh next time
    load();
  };

  const handleRemoveSource = async (rawId) => {
    await patchRecipesCatalogItem(rawId, { ingredient_id: null, is_recipe_primary: false });
    load();
  };

  const handleSetPrimary = async (rawId, ingredientId) => {
    await patchRecipesCatalogItem(rawId, { ingredient_id: ingredientId, is_recipe_primary: true });
    load();
  };

  const handleDelete = async (ing) => {
    if (!window.confirm(`Delete "${ing.name}"? This cannot be undone.`)) return;
    try {
      await deleteRecipesIngredient(ing.id);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div>
      <IngredientForm onCreated={load} />
      {error && <p className="recipes-error">{error}</p>}

      {loading ? (
        <p style={{ color: 'var(--text-muted,#888)', fontSize: '0.875rem' }}>Loading…</p>
      ) : ingredients.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: '2rem' }}>🥘</div>
          <p>No items yet. Add one above, or link items from the Item Catalog.</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="recipes-table">
            <thead>
              <tr>
                <th style={{ width: '1.5rem' }}></th>
                <th>Item</th>
                <th>Unit</th>
                <th>Par / Buy</th>
                <th style={{ textAlign: 'center' }}>Sources</th>
                <th>Primary vendor</th>
                <th style={{ textAlign: 'right' }}>Price</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {ingredients.map((ing) => {
                const sources     = ing.sources || [];
                const primary     = sources.find((s) => s.is_recipe_primary);
                const isExpanded  = expanded.has(ing.id);

                return (
                  <React.Fragment key={ing.id}>
                    {/* ── Ingredient header row ── */}
                    <tr
                      style={{ opacity: ing.is_active === false ? 0.5 : 1, cursor: 'pointer' }}
                      onClick={() => toggleExpand(ing.id)}
                    >
                      <td style={{ textAlign: 'center', fontSize: '0.7rem', color: 'var(--text-muted,#888)', userSelect: 'none' }}>
                        {isExpanded ? '▼' : '▶'}
                      </td>
                      <td>
                        <strong>{ing.name}</strong>
                        {ing.is_active === false && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted,#888)' }}> (inactive)</span>}
                        {ing.description && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted,#888)' }}>{ing.description}</div>}
                      </td>
                      <td>{ing.base_unit || '—'}</td>
                      <td style={{ fontSize: '0.78rem', color: 'var(--text-muted,#888)' }}>
                        {ing.par_qty != null ? <div>Par: {ing.par_qty} {ing.par_unit || ''}</div> : null}
                        {buyFrequencyLabel(ing) ? <div>{buyFrequencyLabel(ing)}</div> : null}
                        {ing.par_qty == null && !buyFrequencyLabel(ing) ? '—' : null}
                      </td>
                      <td style={{ textAlign: 'center', color: sources.length ? 'var(--text)' : 'var(--text-muted,#888)', fontSize: '0.85rem' }}>
                        {sources.length}
                      </td>
                      <td style={{ fontSize: '0.82rem', color: 'var(--text-muted,#888)' }}>
                        {primary ? (primary.vendor || '—') : <span style={{ color: 'var(--text-muted,#888)' }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {primary ? fmt(primary.last_price) : '—'}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: '0.35rem' }}>
                          <button className="btn-sm" onClick={() => setEditFor(ing)}>Edit</button>
                          <button className="btn-sm btn-danger" onClick={() => handleDelete(ing)}>Delete</button>
                        </div>
                      </td>
                    </tr>

                    {/* ── Vendor source sub-rows (when expanded) ── */}
                    {isExpanded && (
                      <tr>
                        <td colSpan={8} style={{ padding: 0, borderTop: 'none' }}>
                          <div style={{ background: 'var(--bg, #f5f5f5)', borderTop: '1px solid var(--border)', paddingBottom: '0.5rem' }}>

                            {sources.length === 0 ? (
                              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted,#888)', padding: '0.5rem 2rem', margin: 0 }}>
                                No vendor sources linked yet.
                              </p>
                            ) : (
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                                <thead>
                                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                    <th style={{ width: '2rem', paddingLeft: '2rem' }}></th>
                                    <th style={{ padding: '0.3rem 0.5rem', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted,#888)', fontSize: '0.75rem' }}>Description</th>
                                    <th style={{ padding: '0.3rem 0.5rem', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted,#888)', fontSize: '0.75rem' }}>Vendor</th>
                                    <th style={{ padding: '0.3rem 0.5rem', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted,#888)', fontSize: '0.75rem' }}>Item #</th>
                                    <th style={{ padding: '0.3rem 0.5rem', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted,#888)', fontSize: '0.75rem' }}>Last price</th>
                                    <th style={{ padding: '0.3rem 0.5rem', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted,#888)', fontSize: '0.75rem' }}>Last purchased</th>
                                    <th style={{ padding: '0.3rem 0.5rem' }}></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {sources.map((s) => {
                                    const itemUrl = vendorItemUrl(s.vendor, s.vendor_item_number);
                                    return (
                                      <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                        <td style={{ paddingLeft: '2rem', textAlign: 'center' }}>
                                          {s.is_recipe_primary
                                            ? <span title="Primary price source for COGS">⭐</span>
                                            : <button className="btn-link" style={{ fontSize: '0.75rem', color: 'var(--text-muted,#888)' }} title="Set as primary" onClick={() => handleSetPrimary(s.id, ing.id)}>○</button>}
                                        </td>
                                        <td style={{ padding: '0.35rem 0.5rem', maxWidth: 300 }}>
                                          {s.product_name
                                            ? <><span style={{ fontWeight: 500 }}>{s.product_name}</span>
                                                {(s.pack || s.uom) && <span style={{ color: 'var(--text-muted,#888)', fontSize: '0.75rem' }}> · {[s.pack, s.uom].filter(Boolean).join(' × ')}</span>}
                                                <div style={{ color: 'var(--text-muted,#888)', fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>{s.description_raw}</div>
                                              </>
                                            : <span style={{ color: 'var(--text-muted,#888)' }}>{s.description_raw}</span>}
                                        </td>
                                        <td style={{ padding: '0.35rem 0.5rem' }}>
                                          <button className="btn-link" onClick={() => setPurchaseItem(s)}>
                                            {s.vendor || '—'}
                                          </button>
                                        </td>
                                        <td style={{ padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                                          {s.vendor_item_number
                                            ? itemUrl
                                              ? <a href={itemUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent,#2a7)' }}>{s.vendor_item_number}</a>
                                              : s.vendor_item_number
                                            : '—'}
                                        </td>
                                        <td style={{ padding: '0.35rem 0.5rem', textAlign: 'right' }}>{fmt(s.last_price)}</td>
                                        <td style={{ padding: '0.35rem 0.5rem' }}>{fmtDate(s.last_purchase_date)}</td>
                                        <td style={{ padding: '0.35rem 0.5rem', whiteSpace: 'nowrap' }}>
                                          <button className="btn-sm btn-danger" onClick={() => handleRemoveSource(s.id)}>Remove</button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            )}

                            <AddSourceRow
                              ingredientId={ing.id}
                              catalog={catalog}
                              catalogLoading={catalogLoading}
                              onAdd={(rawId) => handleAddSource(ing.id, rawId)}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editFor && (
        <EditIngredientModal
          ingredient={editFor}
          onSave={() => { setEditFor(null); load(); }}
          onClose={() => setEditFor(null)}
        />
      )}

      {purchaseItem && (
        <PurchaseHistoryModal
          item={purchaseItem}
          onClose={() => setPurchaseItem(null)}
        />
      )}
    </div>
  );
}
