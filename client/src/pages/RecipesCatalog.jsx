import React, { useState, useEffect, useCallback } from 'react';
import {
  getRecipesCatalog, patchRecipesCatalogItem, bulkSetCatalogUnit,
  getRecipesIngredients, createRecipesIngredient, convertCatalogItemToIngredient,
  backfillRecipesCatalog, enrichRecipesCatalog, getCatalogItemPurchases,
} from '../api';

const UNIT_OPTIONS = ['each', 'case', 'lb', 'oz', 'g', 'kg'];

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

// Live link to the vendor's product page for a given item number.
function vendorItemUrl(vendor, itemNumber) {
  if (!itemNumber) return null;
  const v = (vendor || '').toLowerCase();
  if (v.includes('chef'))  return `https://www.chefstore.com/search/fullsearch/${encodeURIComponent(itemNumber)}/`;
  if (v.includes('sysco')) return `https://shop.sysco.com/app/catalog?q=${encodeURIComponent(itemNumber)}`;
  return null;
}

export function PurchaseHistoryModal({ item, onClose }) {
  const [purchases, setPurchases] = useState(null);
  const [error, setError]         = useState('');

  useEffect(() => {
    getCatalogItemPurchases(item.id)
      .then((d) => setPurchases(d.purchases))
      .catch((e) => setError(e.message));
  }, [item.id]);

  const totalSpent = purchases
    ? purchases.reduce((s, p) => s + (parseFloat(p.total) || 0), 0)
    : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 780, width: '95vw' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginBottom: '0.25rem' }}>Purchase History</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted,#888)', marginTop: 0, marginBottom: '1rem' }}>
          {item.product_name
            ? <><strong>{item.product_name}</strong>{item.pack || item.uom ? ` · ${[item.pack, item.uom].filter(Boolean).join(' × ')}` : ''}<br /><span style={{ fontSize: '0.75rem' }}>{item.description_raw}</span></>
            : <strong>{item.description_raw}</strong>}
          {item.vendor ? <><br />{item.vendor}{item.vendor_item_number ? ` · #${item.vendor_item_number}` : ''}</> : ''}
        </p>

        {error && <p style={{ color: 'var(--danger,#c33)' }}>{error}</p>}

        {purchases === null && !error && (
          <p style={{ color: 'var(--text-muted,#888)', fontSize: '0.875rem' }}>Loading…</p>
        )}

        {purchases && purchases.length === 0 && (
          <p style={{ color: 'var(--text-muted,#888)', fontSize: '0.875rem' }}>No purchase records found.</p>
        )}

        {purchases && purchases.length > 0 && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="recipes-table" style={{ fontSize: '0.82rem' }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Order #</th>
                    <th>Vendor</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th>Unit</th>
                    <th style={{ textAlign: 'right' }}>Unit Price</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((p, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'nowrap' }}>{p.order_date ? p.order_date.slice(0, 10) : '—'}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{p.order_number || '—'}</td>
                      <td>{p.vendor || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{p.quantity != null ? p.quantity : '—'}</td>
                      <td>{p.quantity_unit || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{p.unit_price != null ? `$${parseFloat(p.unit_price).toFixed(2)}` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{p.total != null ? `$${parseFloat(p.total).toFixed(2)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                {totalSpent > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'right', fontWeight: 600, paddingTop: '0.5rem' }}>Total spent</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, paddingTop: '0.5rem' }}>${totalSpent.toFixed(2)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted,#888)', marginTop: '0.5rem' }}>
              {purchases.length} line item{purchases.length !== 1 ? 's' : ''}
            </p>
          </>
        )}

        <div className="modal-footer">
          <button type="button" className="btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
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

function ConvertToIngredientModal({ item, onDone, onClose }) {
  const [name, setName] = useState(item.product_name || item.description_raw || '');
  const [description, setDescription] = useState('');
  const [baseUnit, setBaseUnit] = useState('g');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const r = await convertCatalogItemToIngredient(item.id, {
        name: name.trim(),
        description: description.trim() || null,
        base_unit: baseUnit,
      });
      onDone(r);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Convert to Ingredient</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted,#888)', marginTop: 0 }}>
          Creates an ingredient from <strong>{item.product_name || item.description_raw}</strong>
          {item.vendor ? ` (${item.vendor})` : ''} and links this item — plus any other stores
          carrying the same product — as its sources.
        </p>
        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label>Ingredient name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label>Description (optional)</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional notes" />
        </div>
        <div className="form-group" style={{ marginBottom: '1rem', maxWidth: 180 }}>
          <label>Base unit (recipes)</label>
          <select value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)}>
            <option value="g">g (grams)</option>
            <option value="oz">oz (ounces)</option>
            <option value="ml">ml</option>
            <option value="each">each</option>
            <option value="lb">lb</option>
            <option value="kg">kg</option>
          </select>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? 'Converting…' : 'Convert'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RecipesCatalog() {
  const [items, setItems]               = useState([]);
  const [ingredients, setIngredients]   = useState([]);
  const [total, setTotal]               = useState(0);
  const [status, setStatus]             = useState('unignored');
  const [search, setSearch]             = useState('');
  const [groceryOnly, setGroceryOnly]   = useState(true);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState('');
  const [assocItem, setAssocItem]       = useState(null);
  const [convertItem, setConvertItem]   = useState(null);
  const [purchaseItem, setPurchaseItem] = useState(null);
  const [backfilling, setBackfilling]   = useState(false);
  const [selected, setSelected]         = useState(new Set());
  const [bulkUnit, setBulkUnit]         = useState('lb');
  const [bulkSaving, setBulkSaving]     = useState(false);
  const [enriching, setEnriching]       = useState(false);
  const [enrichResult, setEnrichResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [catalogRes, ingRes] = await Promise.all([
        getRecipesCatalog({ status, search, grocery: groceryOnly }),
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
  }, [status, search, groceryOnly]);

  useEffect(() => { load(); }, [load]);

  const allIds = items.map((i) => i.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const toggleSelect = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(allIds));
  };

  const applyBulkUnit = async () => {
    if (!selected.size) return;
    setBulkSaving(true);
    setError('');
    try {
      await bulkSetCatalogUnit([...selected], bulkUnit);
      setSelected(new Set());
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBulkSaving(false);
    }
  };

  const toggleIgnore = async (item) => {
    try {
      await patchRecipesCatalogItem(item.id, { ignored: !item.ignored });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const runEnrich = async (ids) => {
    setEnriching(true);
    setEnrichResult(null);
    setError('');
    try {
      const r = await enrichRecipesCatalog(ids);
      setEnrichResult(r);
      setSelected(new Set());
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setEnriching(false);
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
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', color: 'var(--text-muted,#888)', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={groceryOnly} onChange={(e) => setGroceryOnly(e.target.checked)} />
          Grocery only
        </label>
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
        <button
          type="button"
          className="btn-sm"
          onClick={() => runEnrich(null)}
          disabled={enriching}
          title="Look up clean product name, pack & unit of measure from the vendor catalogs (Chef Store + Sysco) for items with an item number"
        >
          {enriching ? 'Extracting…' : 'Extract UOM'}
        </button>
      </div>
      {enrichResult && (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted,#888)', margin: '0 0 0.5rem' }}>
          Enriched {enrichResult.enriched} item{enrichResult.enriched !== 1 ? 's' : ''} from vendor catalogs
          {enrichResult.failed > 0 ? `, ${enrichResult.failed} not found` : ''}.
        </p>
      )}

      {error && <p className="recipes-error">{error}</p>}

      {selected.size > 0 && (
        <div className="catalog-bulk-bar">
          <span>{selected.size} selected</span>
          <label>Set unit:</label>
          <select value={bulkUnit} onChange={(e) => setBulkUnit(e.target.value)}>
            {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <button className="btn-primary btn-sm" onClick={applyBulkUnit} disabled={bulkSaving}>
            {bulkSaving ? 'Saving…' : 'Apply'}
          </button>
          <button className="btn-sm" onClick={() => runEnrich([...selected])} disabled={enriching}>
            {enriching ? 'Extracting…' : 'Extract UOM'}
          </button>
          <button className="btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

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
                <th style={{ width: '2rem' }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} title="Select all" />
                </th>
                <th>Description</th>
                <th>Vendor</th>
                <th>Item #</th>
                <th style={{ textAlign: 'right' }}>Last Price</th>
                <th>Last Purchased</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th>Unit</th>
                <th style={{ textAlign: 'right' }}>Container (g)</th>
                <th>Ingredient</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ opacity: item.ignored ? 0.5 : 1 }}>
                  <td>
                    <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelect(item.id)} />
                  </td>
                  <td style={{ minWidth: 220, maxWidth: 380, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                    {item.product_name ? (
                      <div>
                        <div style={{ fontWeight: 600 }}>
                          {item.product_name}
                          {item.pack || item.uom
                            ? <span style={{ fontWeight: 400, color: 'var(--text-muted,#888)', fontSize: '0.78rem' }}>
                                {' '}· {[item.pack, item.uom].filter(Boolean).join(' × ')}
                              </span>
                            : null}
                        </div>
                        <div style={{ color: 'var(--text-muted,#888)', fontSize: '0.72rem' }}>
                          {item.description_raw}
                        </div>
                      </div>
                    ) : (
                      item.description_raw
                    )}
                  </td>
                  <td style={{ fontSize: '0.8rem' }}>
                    <button
                      className="btn-link"
                      title="View purchase history"
                      onClick={() => setPurchaseItem(item)}
                    >
                      {item.vendor || '—'}
                    </button>
                  </td>
                  <td style={{ fontSize: '0.8rem', color: 'var(--text-muted,#888)', fontFamily: 'monospace' }}>
                    {(() => {
                      if (!item.vendor_item_number) return '—';
                      const url = vendorItemUrl(item.vendor, item.vendor_item_number);
                      return url
                        ? <a href={url} target="_blank" rel="noopener noreferrer" title={`View on ${item.vendor}`} style={{ color: 'var(--accent, #2a7)' }}>{item.vendor_item_number}</a>
                        : item.vendor_item_number;
                    })()}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(item.last_price)}</td>
                  <td style={{ fontSize: '0.8rem' }}>{item.last_purchase_date ? item.last_purchase_date.slice(0, 10) : '—'}</td>
                  <td style={{ textAlign: 'right', fontSize: '0.8rem' }}>
                    {item.last_quantity != null ? item.last_quantity : '—'}
                  </td>
                  <td style={{ fontSize: '0.8rem' }}>
                    <select
                      className="catalog-unit-select"
                      value={item.unit || item.last_quantity_unit || 'each'}
                      onChange={async (e) => {
                        try {
                          await patchRecipesCatalogItem(item.id, { unit: e.target.value });
                          load();
                        } catch (err) {
                          setError(err.message);
                        }
                      }}
                    >
                      {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
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
                      {!item.ingredient_id && (
                        <button className="btn-sm btn-primary" onClick={() => setConvertItem(item)}>Convert</button>
                      )}
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

      {convertItem && (
        <ConvertToIngredientModal
          item={convertItem}
          onDone={() => { setConvertItem(null); load(); }}
          onClose={() => setConvertItem(null)}
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
