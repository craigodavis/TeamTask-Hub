import React, { useState, useEffect, useCallback } from 'react';
import {
  getRecipesIngredients, createRecipesIngredient, updateRecipesIngredient, deleteRecipesIngredient,
  getRecipesIngredient, getRecipesCatalog, patchRecipesCatalogItem,
} from '../api';

const UNITS = ['g', 'oz', 'ml', 'each', 'lb', 'kg'];

function fmt(price) {
  if (price == null) return '—';
  return `$${parseFloat(price).toFixed(2)}`;
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
        <input
          type="text"
          placeholder="e.g. Mozzarella"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
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
        {saving ? 'Adding…' : '+ Add Ingredient'}
      </button>
    </form>
  );
}

function SourcePanel({ ingredientId, companyIngredient, onClose, onChanged }) {
  const [detail, setDetail]   = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [addId, setAddId]     = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detailRes, catRes] = await Promise.all([
        getRecipesIngredient(ingredientId),
        getRecipesCatalog({ status: 'unignored', limit: 500 }),
      ]);
      setDetail(detailRes);
      const linkedIds = new Set((detailRes.sources || []).map((s) => s.id));
      setCatalog((catRes.items || []).filter((c) => !linkedIds.has(c.id)));
    } finally {
      setLoading(false);
    }
  }, [ingredientId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!addId) return;
    await patchRecipesCatalogItem(addId, { ingredient_id: ingredientId });
    setAddId('');
    load(); onChanged();
  };

  const handleRemove = async (rawId) => {
    await patchRecipesCatalogItem(rawId, { ingredient_id: null, is_recipe_primary: false });
    load(); onChanged();
  };

  const handleSetPrimary = async (rawId) => {
    await patchRecipesCatalogItem(rawId, { ingredient_id: ingredientId, is_recipe_primary: true });
    load(); onChanged();
  };

  const sources = detail?.sources || [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Sources for "{companyIngredient.name}"</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted,#888)', marginTop: 0 }}>
          Base unit: <strong>{companyIngredient.base_unit || '—'}</strong>
          {companyIngredient.description && <> — {companyIngredient.description}</>}
        </p>

        {loading ? <p>Loading…</p> : (
          <>
            {sources.length === 0 ? (
              <p style={{ color: 'var(--text-muted,#888)', fontSize: '0.875rem' }}>No receipt items linked yet.</p>
            ) : (
              <table className="recipes-table" style={{ marginBottom: '1rem' }}>
                <thead>
                  <tr>
                    <th>Receipt item</th>
                    <th>Vendor</th>
                    <th style={{ textAlign: 'right' }}>Last price</th>
                    <th>Primary</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontSize: '0.8rem', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description_raw}</td>
                      <td style={{ fontSize: '0.8rem' }}>{s.vendor || '—'}</td>
                      <td style={{ textAlign: 'right', fontSize: '0.85rem' }}>{fmt(s.last_price)}</td>
                      <td>
                        {s.is_recipe_primary
                          ? <span title="Primary price source">⭐</span>
                          : <button className="btn-sm" onClick={() => handleSetPrimary(s.id)}>Set primary</button>}
                      </td>
                      <td>
                        <button className="btn-sm btn-danger" onClick={() => handleRemove(s.id)}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <select
                value={addId}
                onChange={(e) => setAddId(e.target.value)}
                style={{ flex: 1, padding: '0.4rem 0.6rem', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card)', color: 'var(--text)', fontSize: '0.875rem' }}
              >
                <option value="">— Add a receipt item —</option>
                {catalog.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.description_raw}{c.vendor ? ` (${c.vendor})` : ''} — {fmt(c.last_price)}
                  </option>
                ))}
              </select>
              <button className="btn-primary" onClick={handleAdd} disabled={!addId}>Add</button>
            </div>
          </>
        )}

        <div className="modal-footer">
          <button type="button" className="btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function EditIngredientModal({ ingredient, onSave, onClose }) {
  const [name, setName]         = useState(ingredient.name);
  const [description, setDesc]  = useState(ingredient.description || '');
  const [baseUnit, setBaseUnit] = useState(ingredient.base_unit || 'g');
  const [isActive, setActive]   = useState(ingredient.is_active !== false);
  const [saving, setSaving]     = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateRecipesIngredient(ingredient.id, { name: name.trim(), description: description.trim() || null, base_unit: baseUnit, is_active: isActive });
      onSave();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Edit Ingredient</h3>
        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label>Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label>Description</label>
          <input type="text" value={description} onChange={(e) => setDesc(e.target.value)} placeholder="Optional notes" />
        </div>
        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label>Base unit</label>
          <select value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
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

export function RecipesIngredients() {
  const [ingredients, setIngredients] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [sourceFor, setSourceFor]     = useState(null);
  const [editFor, setEditFor]         = useState(null);

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

  const handleDelete = async (ing) => {
    if (!window.confirm(`Delete ingredient "${ing.name}"? This cannot be undone.`)) return;
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
          <p>No ingredients yet. Add one above, or link items from the Item Catalog.</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="recipes-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Unit</th>
                <th>Primary source</th>
                <th style={{ textAlign: 'right' }}>Last price</th>
                <th style={{ textAlign: 'center' }}>Sources</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {ingredients.map((ing) => (
                <tr key={ing.id} style={{ opacity: ing.is_active === false ? 0.5 : 1 }}>
                  <td><strong>{ing.name}</strong>{ing.is_active === false && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted,#888)' }}> (inactive)</span>}</td>
                  <td style={{ fontSize: '0.8rem', color: 'var(--text-muted,#888)' }}>{ing.description || '—'}</td>
                  <td>{ing.base_unit || '—'}</td>
                  <td style={{ fontSize: '0.8rem', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ing.primary_source_desc
                      ? <span title={ing.primary_source_desc}>{ing.primary_source_desc}</span>
                      : <span style={{ color: 'var(--text-muted,#888)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(ing.primary_last_price)}</td>
                  <td style={{ textAlign: 'center' }}>
                    <button className="btn-sm" onClick={() => setSourceFor(ing)}>
                      {ing.source_count} source{ing.source_count !== 1 ? 's' : ''}
                    </button>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.35rem' }}>
                      <button className="btn-sm" onClick={() => setEditFor(ing)}>Edit</button>
                      <button className="btn-sm btn-danger" onClick={() => handleDelete(ing)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sourceFor && (
        <SourcePanel
          ingredientId={sourceFor.id}
          companyIngredient={sourceFor}
          onClose={() => setSourceFor(null)}
          onChanged={load}
        />
      )}

      {editFor && (
        <EditIngredientModal
          ingredient={editFor}
          onSave={() => { setEditFor(null); load(); }}
          onClose={() => setEditFor(null)}
        />
      )}
    </div>
  );
}
