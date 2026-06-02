import React, { useState, useEffect, useMemo } from 'react';
import {
  getShoppingItems, createShoppingItem, updateShoppingItem, deleteShoppingItem, bulkUpdateShoppingItems,
  getRawShoppingItems, matchRawShoppingItem, ignoreRawShoppingItem, syncRawShoppingItems,
  mergeShoppingCategories, getLocations,
  findShoppingDuplicates, mergeShoppingItems,
} from '../api';
import './ShoppingCatalog.css';

const BLANK = { name: '', category: '', par_qty: '', par_unit: 'box', notes: '', location_ids: [] };
const ADD_CATEGORY = '__add_new__';
const UNCATEGORIZED_FILTER = '__uncategorized__';

const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const WEEK_ORDINALS = ['','1st','2nd','3rd','4th','5th'];

const BUY_FREQUENCIES = [
  { value: '',                 label: '— not set —' },
  { value: 'daily',            label: 'Daily' },
  { value: 'weekly',           label: 'Weekly on…' },
  { value: 'biweekly',         label: 'Bi-Weekly on…' },
  { value: 'monthly',          label: 'Monthly on day…' },
  { value: 'monthly_weekday',  label: 'Monthly on Nth weekday…' },
  { value: 'adhoc',            label: 'Ad-Hoc' },
];

function ordinal(n) {
  if (!n) return '?';
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function buyFrequencyLabel(item) {
  if (!item.buy_frequency) return '—';
  if (item.buy_frequency === 'daily')            return 'Daily';
  if (item.buy_frequency === 'adhoc')            return 'Ad-Hoc';
  if (item.buy_frequency === 'weekly')           return `Weekly — ${WEEKDAYS[item.buy_day_of_week] || '?'}`;
  if (item.buy_frequency === 'biweekly')         return `Bi-Weekly — ${WEEKDAYS[item.buy_day_of_week] || '?'}`;
  if (item.buy_frequency === 'monthly')          return `Monthly — ${ordinal(item.buy_day_of_month)}`;
  if (item.buy_frequency === 'monthly_weekday')  return `Monthly — ${WEEK_ORDINALS[item.buy_week_of_month] || '?'} ${WEEKDAYS[item.buy_day_of_week] || '?'}`;
  return item.buy_frequency;
}

function normName(s) {
  return (s || '').trim().toLowerCase();
}

function buildCategories(items) {
  const seen = new Map();
  for (const item of items) {
    const c = (item.category || '').trim();
    if (!c) continue;
    const key = c.toLowerCase();
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function resolveCategory(value, categories) {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  const match = categories.find((c) => c.toLowerCase() === trimmed.toLowerCase());
  return match || trimmed;
}

function formatLocationSummary(item, locations) {
  const ids = item.location_ids || [];
  if (!ids.length) return '—';
  const names = ids
    .map((id) => locations.find((l) => l.id === id)?.name)
    .filter(Boolean);
  if (names.length === 0) return `${ids.length} location${ids.length === 1 ? '' : 's'}`;
  if (names.length <= 2) return names.join(', ');
  return `${names.length} locations`;
}

export function ShoppingCatalog() {
  const [tab, setTab] = useState('queue'); // 'queue' | 'catalog'
  const [items, setItems] = useState([]);
  const [rawItems, setRawItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rawLoading, setRawLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [addingId, setAddingId] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [dupGroups, setDupGroups] = useState(null);
  // Bulk selection
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkFreq, setBulkFreq] = useState('');
  const [bulkDayOfWeek, setBulkDayOfWeek] = useState(1);
  const [bulkDayOfMonth, setBulkDayOfMonth] = useState(1);
  const [bulkWeekOfMonth, setBulkWeekOfMonth] = useState(1);
  const [bulkApplying, setBulkApplying] = useState(false); // null=not scanned, []=none found, [...]= groups
  const [scanningDups, setScanningDups] = useState(false);
  const [mergingIds, setMergingIds] = useState(null); // {keepId, mergeId}
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [categoryAddingNew, setCategoryAddingNew] = useState(false);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [showCategoryManage, setShowCategoryManage] = useState(false);
  const [moveTargets, setMoveTargets] = useState({});
  const [categoryBusy, setCategoryBusy] = useState(null);
  const [locations, setLocations] = useState([]);

  const catalogNames = useMemo(
    () => new Set(items.map((i) => normName(i.name))),
    [items]
  );

  const queueItems = useMemo(
    () => rawItems.filter((r) => !catalogNames.has(normName(r.description_raw))),
    [rawItems, catalogNames]
  );

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

  useEffect(() => {
    loadCatalog();
    loadQueue();
    getLocations()
      .then((d) => setLocations(d.locations || []))
      .catch(() => {});
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await syncRawShoppingItems();
      setError('');
      await loadCatalog();
      await loadQueue();
      setError(`Synced ${r.synced} items from receipt history.`);
    } catch (e) { setError(e.message); }
    finally { setSyncing(false); }
  };

  const handleAdd = async (raw) => {
    const name = (raw.description_raw || '').trim();
    if (!name || catalogNames.has(normName(name))) return;
    setAddingId(raw.id);
    setError('');
    try {
      const result = await matchRawShoppingItem(raw.id, { create_new: { name } });
      setRawItems((prev) => prev.filter((r) => r.id !== raw.id));
      if (result.shopping_item) {
        setItems((prev) => [...prev, result.shopping_item]);
      } else {
        await loadCatalog();
      }
    } catch (e) { setError(e.message); }
    finally { setAddingId(null); }
  };

  const handleIgnore = async (raw) => {
    try {
      await ignoreRawShoppingItem(raw.id);
      setRawItems((prev) => prev.filter((r) => r.id !== raw.id));
    } catch (e) { setError(e.message); }
  };

  const handleSave = async () => {
    if (!form.name?.trim()) return;
    if (categoryAddingNew && !newCategoryInput.trim()) return;
    const payload = {
      ...form,
      category: categoryAddingNew
        ? resolveCategory(newCategoryInput, categories)
        : resolveCategory(form.category, categories),
      par_qty: form.par_qty === '' || form.par_qty == null ? null : Number(form.par_qty),
      location_ids: form.location_ids || [],
    };
    setSaving(true);
    try {
      if (form.id) {
        const updated = await updateShoppingItem(form.id, payload);
        setItems((prev) => prev.map((i) => i.id === form.id ? updated : i));
      } else {
        const created = await createShoppingItem(payload);
        setItems((prev) => [...prev, created]);
      }
      closeForm();
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

  const categories = useMemo(() => buildCategories(items), [items]);

  const categoryStats = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      const c = (item.category || '').trim();
      if (!c) continue;
      const key = c.toLowerCase();
      if (!map.has(key)) map.set(key, { name: c, count: 0 });
      map.get(key).count += 1;
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      const cat = (i.category || '').trim();
      if (categoryFilter === UNCATEGORIZED_FILTER) {
        if (cat) return false;
      } else if (categoryFilter) {
        if (cat.toLowerCase() !== categoryFilter.toLowerCase()) return false;
      }
      if (!q) return true;
      return i.name.toLowerCase().includes(q) || cat.toLowerCase().includes(q);
    });
  }, [items, search, categoryFilter]);

  const openForm = (item) => {
    const data = item
      ? { ...item, par_qty: item.par_qty ?? '', location_ids: [...(item.location_ids || [])] }
      : {
        ...BLANK,
        location_ids: locations.length === 1 ? [locations[0].id] : [],
      };
    const cat = (data.category || '').trim();
    const canonical = cat
      ? categories.find((c) => c.toLowerCase() === cat.toLowerCase())
      : '';
    if (canonical) {
      data.category = canonical;
      setCategoryAddingNew(false);
      setNewCategoryInput('');
    } else if (cat) {
      data.category = '';
      setCategoryAddingNew(true);
      setNewCategoryInput(cat);
    } else {
      setCategoryAddingNew(false);
      setNewCategoryInput('');
    }
    setForm(data);
  };

  const closeForm = () => {
    setForm(null);
    setCategoryAddingNew(false);
    setNewCategoryInput('');
  };

  const toggleFormLocation = (locationId) => {
    setForm((f) => {
      const ids = f.location_ids || [];
      return {
        ...f,
        location_ids: ids.includes(locationId)
          ? ids.filter((id) => id !== locationId)
          : [...ids, locationId],
      };
    });
  };

  const setAllFormLocations = (checked) => {
    setForm((f) => ({
      ...f,
      location_ids: checked ? locations.map((l) => l.id) : [],
    }));
  };

  const handleCategorySelect = (e) => {
    const value = e.target.value;
    if (value === ADD_CATEGORY) {
      setCategoryAddingNew(true);
      setNewCategoryInput('');
      setForm((f) => ({ ...f, category: '' }));
      return;
    }
    setCategoryAddingNew(false);
    setNewCategoryInput('');
    setForm((f) => ({ ...f, category: value }));
  };

  const fmt = (ts) => ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' }) : '—';

  const applyCategoryMerge = async (fromName, toValue, { skipConfirm = false } = {}) => {
    const toCategory = toValue === UNCATEGORIZED_FILTER ? null : toValue;
    const label = toCategory || 'Uncategorized';
    if (!skipConfirm && !window.confirm(`Move all items from "${fromName}" to "${label}"?`)) return;
    setCategoryBusy(fromName);
    setError('');
    try {
      const r = await mergeShoppingCategories(fromName, toCategory);
      await loadCatalog();
      setMoveTargets((prev) => {
        const next = { ...prev };
        delete next[fromName];
        return next;
      });
      if (
        categoryFilter === fromName
        || (categoryFilter && categoryFilter.toLowerCase() === fromName.toLowerCase())
      ) {
        setCategoryFilter(toCategory || UNCATEGORIZED_FILTER);
      }
      const verb = toCategory ? 'Moved' : 'Uncategorized';
      setError(`${verb} ${r.updated} item${r.updated === 1 ? '' : 's'}${toCategory ? ` under "${label}"` : ''}.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setCategoryBusy(null);
    }
  };

  const removeCategory = async (name, count) => {
    if (!window.confirm(
      `Remove category "${name}"? ${count} item${count === 1 ? '' : 's'} will become uncategorized.`
    )) return;
    await applyCategoryMerge(name, UNCATEGORIZED_FILTER, { skipConfirm: true });
  };

  const closeCategoryManage = () => {
    setShowCategoryManage(false);
    setMoveTargets({});
  };

  return (
    <div className="catalog-page">
      {error && (
        <div className={
          /^(Synced|Moved|Uncategorized) /.test(error) ? 'catalog-success' : 'catalog-error'
        }
        >
          {error}
        </div>
      )}

      {/* Sub-tabs */}
      <div className="catalog-tabs">
        <button type="button" className={`catalog-tab${tab === 'queue' ? ' active' : ''}`} onClick={() => setTab('queue')}>
          New from receipts {queueItems.length > 0 && <span className="catalog-badge">{queueItems.length}</span>}
        </button>
        <button type="button" className={`catalog-tab${tab === 'catalog' ? ' active' : ''}`} onClick={() => setTab('catalog')}>
          Item Catalog
        </button>
      </div>

      {/* ── Receipt queue (not yet in catalog) ── */}
      {tab === 'queue' && (
        <div className="catalog-queue">
          <div className="catalog-queue-header">
            <p className="catalog-queue-desc">
              Items from your receipts that are not in the catalog yet. Add them to the catalog or ignore them.
              {' '}NOTE: Only add items that you want to shop regularly.
            </p>
            <button type="button" className="btn-secondary" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Syncing…' : '↻ Sync from receipt history'}
            </button>
          </div>

          {rawLoading && <div className="catalog-loading">Loading…</div>}
          {!rawLoading && queueItems.length === 0 && (
            <div className="catalog-empty">
              <p>Nothing new — every receipt item is already in the catalog or ignored.</p>
              <p>Click &quot;Sync from receipt history&quot; to import items from past receipts.</p>
            </div>
          )}

          {queueItems.map((raw) => (
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
                <button
                  type="button"
                  className="btn-primary btn-small"
                  disabled={addingId === raw.id}
                  onClick={() => handleAdd(raw)}
                >
                  {addingId === raw.id ? 'Adding…' : 'Add'}
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
            <input
              type="search"
              placeholder="Search items…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="catalog-search"
            />
            <label className="catalog-filter">
              Category
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                aria-label="Filter by category"
              >
                <option value="">All categories</option>
                <option value={UNCATEGORIZED_FILTER}>Uncategorized</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowCategoryManage(true)}
              disabled={categoryStats.length === 0}
            >
              Manage categories
            </button>
            <button type="button" className="btn-primary" onClick={() => openForm(null)}>+ Add Item</button>
            <button
              type="button"
              className="btn-secondary"
              disabled={scanningDups || items.length < 2}
              onClick={async () => {
                setScanningDups(true);
                try {
                  const d = await findShoppingDuplicates();
                  setDupGroups(d.groups || []);
                } catch (e) { setError(e.message); }
                finally { setScanningDups(false); }
              }}
            >
              {scanningDups ? '🔍 Scanning…' : '🔍 Find Duplicates'}
            </button>
          </div>

          {/* Duplicate groups */}
          {dupGroups !== null && (
            <div className="catalog-dup-panel">
              {dupGroups.length === 0 ? (
                <div className="catalog-dup-none">✓ No duplicates found.</div>
              ) : (
                <>
                  <div className="catalog-dup-header">
                    {dupGroups.length} likely duplicate group{dupGroups.length !== 1 ? 's' : ''} found
                  </div>
                  {dupGroups.map((g, gi) => (
                    <div key={gi} className="catalog-dup-group">
                      <div className="catalog-dup-reason">{g.reason}</div>
                      {g.items.map((it) => (
                        <div key={it.id} className="catalog-dup-item">
                          <span>{it.name}</span>
                          {g.items.length === 2 && it.id !== g.items[0].id && (
                            <button
                              type="button"
                              className="btn-small btn-danger"
                              onClick={() => setMergingIds({ keepId: g.items[0].id, keepName: g.items[0].name, mergeId: it.id, mergeName: it.name })}
                            >
                              Merge into above
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </>
              )}
              <button type="button" className="btn-secondary btn-small" onClick={() => setDupGroups(null)} style={{ marginTop: '0.5rem' }}>Dismiss</button>
            </div>
          )}

          {/* Merge confirmation */}
          {mergingIds && (
            <div className="catalog-modal-overlay" onClick={() => setMergingIds(null)}>
              <div className="catalog-modal" onClick={(e) => e.stopPropagation()}>
                <div className="catalog-modal-header">
                  <h3>Confirm Merge</h3>
                  <button type="button" onClick={() => setMergingIds(null)}>✕</button>
                </div>
                <div className="catalog-form">
                  <p>Keep: <strong>{mergingIds.keepName}</strong></p>
                  <p>Delete: <strong>{mergingIds.mergeName}</strong></p>
                  <p className="hint">All purchase history and inventory counts from the deleted item will be moved to the kept item.</p>
                </div>
                <div className="catalog-modal-footer">
                  <button type="button" className="btn-secondary" onClick={() => setMergingIds(null)}>Cancel</button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={async () => {
                      try {
                        await mergeShoppingItems(mergingIds.keepId, mergingIds.mergeId);
                        setItems((prev) => prev.filter((i) => i.id !== mergingIds.mergeId));
                        setDupGroups(null);
                        setMergingIds(null);
                      } catch (e) { setError(e.message); }
                    }}
                  >
                    Merge
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Bulk action bar ── */}
          {selectedIds.size > 0 && (
            <div className="catalog-bulk-bar">
              <span className="catalog-bulk-count">{selectedIds.size} selected</span>
              <label>Buy Frequency
                <select value={bulkFreq} onChange={(e) => setBulkFreq(e.target.value)}>
                  {BUY_FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </label>
              {(bulkFreq === 'weekly' || bulkFreq === 'biweekly' || bulkFreq === 'monthly_weekday') && (
                <label>Day
                  <select value={bulkDayOfWeek} onChange={(e) => setBulkDayOfWeek(Number(e.target.value))}>
                    {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </label>
              )}
              {bulkFreq === 'monthly_weekday' && (
                <label>Which
                  <select value={bulkWeekOfMonth} onChange={(e) => setBulkWeekOfMonth(Number(e.target.value))}>
                    {[1,2,3,4,5].map((w) => <option key={w} value={w}>{WEEK_ORDINALS[w]}</option>)}
                  </select>
                </label>
              )}
              {bulkFreq === 'monthly' && (
                <label>Day of month
                  <select value={bulkDayOfMonth} onChange={(e) => setBulkDayOfMonth(Number(e.target.value))}>
                    {Array.from({length:31},(_,i)=>i+1).map((d) => <option key={d} value={d}>{ordinal(d)}</option>)}
                  </select>
                </label>
              )}
              <button type="button" className="btn-primary btn-small" disabled={!bulkFreq || bulkApplying}
                onClick={async () => {
                  setBulkApplying(true);
                  try {
                    const updates = { buy_frequency: bulkFreq || null };
                    if (bulkFreq === 'weekly' || bulkFreq === 'biweekly') updates.buy_day_of_week = bulkDayOfWeek;
                    if (bulkFreq === 'monthly_weekday') { updates.buy_day_of_week = bulkDayOfWeek; updates.buy_week_of_month = bulkWeekOfMonth; }
                    if (bulkFreq === 'monthly') updates.buy_day_of_month = bulkDayOfMonth;
                    await bulkUpdateShoppingItems([...selectedIds], updates);
                    await loadCatalog();
                    setSelectedIds(new Set());
                    setBulkFreq('');
                  } catch (e) { setError(e.message); }
                  finally { setBulkApplying(false); }
                }}>
                {bulkApplying ? 'Applying…' : 'Apply'}
              </button>
              <button type="button" className="btn-small" onClick={() => setSelectedIds(new Set())}>Clear</button>
            </div>
          )}

          {loading ? <div className="catalog-loading">Loading…</div> : (
            <table className="catalog-table">
              <thead>
                <tr>
                  <th style={{width:'2rem'}}>
                    <input type="checkbox"
                      checked={filtered.length > 0 && filtered.every((i) => selectedIds.has(i.id))}
                      onChange={(e) => setSelectedIds(e.target.checked ? new Set(filtered.map((i) => i.id)) : new Set())}
                    />
                  </th>
                  <th>Name</th><th>Category</th><th>Par</th><th>Buy Frequency</th><th>Routine</th><th>Locations</th><th>Last Purchased</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="catalog-empty">
                      {items.length === 0 ? 'No items yet.' : 'No items match your filters.'}
                    </td>
                  </tr>
                )}
                {filtered.map((item) => (
                  <tr key={item.id} className={`${(item.location_ids?.length ?? 0) > 0 ? '' : 'catalog-row-inactive'}${selectedIds.has(item.id) ? ' catalog-row-selected' : ''}`}>
                    <td>
                      <input type="checkbox" checked={selectedIds.has(item.id)}
                        onChange={(e) => setSelectedIds((prev) => {
                          const next = new Set(prev);
                          e.target.checked ? next.add(item.id) : next.delete(item.id);
                          return next;
                        })} />
                    </td>
                    <td className="catalog-name">{item.name}</td>
                    <td>{item.category || '—'}</td>
                    <td>{item.par_qty != null ? `${item.par_qty} ${item.par_unit}` : '—'}</td>
                    <td className="catalog-freq">{buyFrequencyLabel(item)}</td>
                    <td>
                      <label className="catalog-toggle" title={item.is_routine ? 'On routine list — click to remove' : 'Not on routine list — click to add'}>
                        <input type="checkbox" checked={!!item.is_routine} onChange={async () => {
                          try {
                            const updated = await updateShoppingItem(item.id, { is_routine: !item.is_routine });
                            setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, ...updated } : i));
                          } catch (e) { setError(e.message); }
                        }} />
                        <span className="catalog-toggle-slider" />
                      </label>
                    </td>
                    <td className="catalog-locations-cell">{formatLocationSummary(item, locations)}</td>
                    <td className="catalog-date">{fmt(item.last_purchase_date)}</td>
                    <td className="catalog-actions">
                      <button type="button" className="btn-small" onClick={() => openForm(item)}>Edit</button>
                      <button type="button" className="btn-small btn-danger" onClick={() => handleDelete(item)}>Del</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {/* Manage categories modal */}
      {showCategoryManage && (
        <div className="catalog-modal-overlay" onClick={closeCategoryManage}>
          <div className="catalog-modal catalog-modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="catalog-modal-header">
              <h3>Manage categories</h3>
              <button type="button" onClick={closeCategoryManage}>✕</button>
            </div>
            <p className="catalog-manage-desc">
              Move all items from one category to another, or remove a category to leave those items uncategorized.
            </p>
            {categoryStats.length === 0 ? (
              <p className="catalog-empty">No categories in the catalog yet.</p>
            ) : (
              <table className="catalog-cat-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Items</th>
                    <th>Move to</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {categoryStats.map(({ name, count }) => {
                    const busy = categoryBusy === name;
                    const moveTo = moveTargets[name] || '';
                    const targets = categories.filter(
                      (c) => c.toLowerCase() !== name.toLowerCase()
                    );
                    return (
                      <tr key={name}>
                        <td className="catalog-cat-name">{name}</td>
                        <td>{count}</td>
                        <td>
                          <select
                            value={moveTo}
                            disabled={busy}
                            onChange={(e) => setMoveTargets((prev) => ({
                              ...prev,
                              [name]: e.target.value,
                            }))}
                            aria-label={`Move ${name} to`}
                          >
                            <option value="">— select —</option>
                            <option value={UNCATEGORIZED_FILTER}>Uncategorized</option>
                            {targets.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                        </td>
                        <td className="catalog-cat-actions">
                          <button
                            type="button"
                            className="btn-small btn-primary"
                            disabled={busy || !moveTo}
                            onClick={() => applyCategoryMerge(name, moveTo)}
                          >
                            {busy ? 'Moving…' : 'Move'}
                          </button>
                          <button
                            type="button"
                            className="btn-small btn-danger"
                            disabled={busy}
                            onClick={() => removeCategory(name, count)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="catalog-modal-footer">
              <button type="button" className="btn-secondary" onClick={closeCategoryManage}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Item form modal */}
      {form && (
        <div className="catalog-modal-overlay" onClick={closeForm}>
          <div className="catalog-modal" onClick={(e) => e.stopPropagation()}>
            <div className="catalog-modal-header">
              <h3>{form.id ? 'Edit Item' : 'Add Item'}</h3>
              <button type="button" onClick={closeForm}>✕</button>
            </div>
            <div className="catalog-form">
              <label>Name *
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Nitrile Gloves, Small, Box/1000" />
              </label>
              <label>Category
                <select
                  value={categoryAddingNew ? ADD_CATEGORY : (form.category || '')}
                  onChange={handleCategorySelect}
                >
                  <option value="">— None —</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                  <option value={ADD_CATEGORY}>+ Add new category…</option>
                </select>
                {categoryAddingNew && (
                  <input
                    className="catalog-category-new"
                    value={newCategoryInput}
                    onChange={(e) => setNewCategoryInput(e.target.value)}
                    placeholder="e.g. PPE, Cleaning, Kitchen"
                    autoFocus
                  />
                )}
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
              {locations.length > 0 && (
                <fieldset className="catalog-locations-field">
                  <legend>Stock at locations</legend>
                  <p className="catalog-locations-hint">
                    Checked locations show this item on the Inventory tab for counting and reorder.
                  </p>
                  {locations.length > 1 && (
                    <div className="catalog-locations-actions">
                      <button type="button" className="catalog-loc-link" onClick={() => setAllFormLocations(true)}>
                        Select all
                      </button>
                      <button type="button" className="catalog-loc-link" onClick={() => setAllFormLocations(false)}>
                        Clear all
                      </button>
                    </div>
                  )}
                  <div className="catalog-locations-list">
                    {locations.map((loc) => (
                      <label key={loc.id} className="catalog-loc-check">
                        <input
                          type="checkbox"
                          checked={(form.location_ids || []).includes(loc.id)}
                          onChange={() => toggleFormLocation(loc.id)}
                        />
                        {loc.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <label>Notes
                <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
              </label>
            </div>
            <div className="catalog-modal-footer">
              <button type="button" className="btn-secondary" onClick={closeForm}>Cancel</button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSave}
                disabled={saving || !form.name?.trim() || (categoryAddingNew && !newCategoryInput.trim())}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
