import React, { useState, useEffect, useCallback } from 'react';
import {
  getRecipesCatalog, patchRecipesCatalogItem,
  getRecipesIngredients, createRecipesIngredient,
  backfillRecipesCatalog,
} from '../api';

const STATUSES = [
  { value: 'unignored', label: 'Active' },
  { value: 'pending',   label: 'Unlinked' },
  { value: 'linked',    label: 'Linked' },
  { value: 'ignored',   label: 'Ignored' },
  { value: 'all',       label: 'All' },
];

function fmt(price) {
  if (price == null) return '—';
  return `$${parseFloat(price).toFixed(2)}`;
}

function AssociateModal({ item, ingredients, onDone, onClose }) {
  const [ingredientId, setIngredientId] = useState(item.ingredient_id || '');
  const [newName, setNewName]     = useState('');
  const [baseUnit, setBaseUnit]   = useState('g');
  const [creating, setCreating]   = useState(false);
  const [primary, setPrimary]     = useState(!!item.is_recipe_primary);
  const [saving, setSaving]       = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      let targetId = ingredientId;
      if (creating && newName.trim()) {
        const r = await createRecipesIngredient({ name: newName.trim(), base_unit: baseUnit });
        targetId = r.ingredient.id;
      }
      await patchRecipesCatalogItem(item.id, {
        ingredient_id: targetId || null,
        is_recipe_primary: targetId ? primary : false,
      });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Associate to Ingredient</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted,#888)', marginTop: 0 }}>
          <strong>{item.description_raw}</strong> — {item.vendor || 'Unknown vendor'}
        </p>

        <div className="form-group" style={{ marginBottom: '1rem' }}>
          <label>Ingredient</label>
          {creating ? (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Friendly name (e.g. Mozzarella)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                style={{ flex: 1, padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card)', color: 'var(--text)' }}
              />
              <select
                value={baseUnit}
                onChange={(e) => setBaseUnit(e.target.value)}
                style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card)', color: 'var(--text)' }}
              >
                <option value="g">g (grams)</option>
                <option value="oz">oz (ounces)</option>
                <option value="ml">ml</option>
                <option value="each">each</option>
              </select>
              <button type="button" className="btn-sm" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <select
                value={ingredientId}
                onChange={(e) => setIngredientId(e.target.value)}
                style={{ flex: 1, padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card)', color: 'var(--text)' }}
              >
                <option value="">— None —</option>
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}{i.base_unit ? ` (${i.base_unit})` : ''}</option>
                ))}
              </select>
              <button type="button" className="btn-sm" onClick={() => setCreating(true)}>+ New</button>
            </div>
          )}
        </div>

        {(ingredientId || creating) && (
          <div className="form-group" style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', textTransform: 'none', letterSpacing: 0 }}>
              <input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} />
              Use as primary price source for COGS (replaces any current primary)
            </label>
          </div>
        )}

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

export function RecipesCatalog() {
  const [items, setItems]           = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [total, setTotal]           = useState(0);
  const [status, setStatus]         = useState('unignored');
  const [search, setSearch]         = useState('');
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [assocItem, setAssocItem]   = useState(null);
  const [backfilling, setBackfilling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [catalogRes, ingRes] = await Promise.all([
        getRecipesCatalog({ status, search }),
        getRecipesIngredients(),
      ]);
      setItems(catalogRes.items || []);
      setTotal(catalogRes.total || 0);
      setIngredients(ingRes.ingredients || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => { load(); }, [load]);

  const toggleIgnore = async (item) => {
    try {
      await patchRecipesCatalogItem(item.id, { ignored: !item.ignored });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const runBackfill = async () => {
    setBackfilling(true);
    setError('');
    try {
      const r = await backfillRecipesCatalog();
      await load();
      if (r.inserted === 0) {
        // Already up to date — no alert needed, the table refresh is enough
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div>
      <div className="recipes-toolbar">
        <input
          type="text"
          placeholder="Search items…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted,#888)' }}>{total} items</span>
        <button
          type="button"
          className="btn-sm"
          onClick={runBackfill}
          disabled={backfilling}
          title="Sync all historical receipt items into the catalog (safe to run multiple times)"
        >
          {backfilling ? 'Syncing…' : 'Sync from receipts'}
        </button>
      </div>

      {error && <p className="recipes-error">{error}</p>}

      {loading ? (
        <p style={{ color: 'var(--text-muted,#888)', fontSize: '0.875rem' }}>Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: '2rem' }}>🧾</div>
          <p>No items found. Import receipts to populate the catalog.</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="recipes-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Vendor</th>
                <th style={{ textAlign: 'right' }}>Last Price</th>
                <th>Last Purchased</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Container (g)</th>
                <th>Ingredient</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ opacity: item.ignored ? 0.5 : 1 }}>
                  <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.description_raw}
                  </td>
                  <td style={{ fontSize: '0.8rem', color: 'var(--text-muted,#888)' }}>{item.vendor || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(item.last_price)}</td>
                  <td style={{ fontSize: '0.8rem' }}>{item.last_purchase_date ? item.last_purchase_date.slice(0, 10) : '—'}</td>
                  <td style={{ textAlign: 'right', fontSize: '0.8rem' }}>
                    {item.last_quantity != null
                      ? `${item.last_quantity}${item.last_quantity_unit && item.last_quantity_unit !== 'each' ? ' ' + item.last_quantity_unit : ''}`
                      : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontSize: '0.8rem' }}>
                    {item.last_quantity_grams != null
                      ? <span>{parseFloat(item.last_quantity_grams).toLocaleString(undefined, { maximumFractionDigits: 1 })}g</span>
                      : <span style={{ color: 'var(--text-muted,#888)' }}>—</span>}
                  </td>
                  <td>
                    {item.ingredient_name
                      ? <span><strong>{item.ingredient_name}</strong>{item.is_recipe_primary ? ' ⭐' : ''}</span>
                      : <span style={{ color: 'var(--text-muted,#888)', fontSize: '0.8rem' }}>Unlinked</span>}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                      <button className="btn-sm" onClick={() => setAssocItem(item)}>
                        {item.ingredient_id ? 'Edit link' : 'Link'}
                      </button>
                      <button
                        className={`btn-sm${item.ignored ? '' : ' btn-danger'}`}
                        onClick={() => toggleIgnore(item)}
                      >
                        {item.ignored ? 'Restore' : 'Ignore'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {assocItem && (
        <AssociateModal
          item={assocItem}
          ingredients={ingredients}
          onDone={() => { setAssocItem(null); load(); }}
          onClose={() => setAssocItem(null)}
        />
      )}
    </div>
  );
}
