import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getProducts, getProductFilters, getSquareItems, getTaxExemptItems, addTaxExemptItem, removeTaxExemptItem, getTaxGap, importC7Products } from '../api';
import './Products.css';

function syncBadge(needsPush, syncError) {
  if (syncError)    return <span className="prod-sync-badge prod-sync-error" title={syncError}>Error</span>;
  if (needsPush)    return <span className="prod-sync-badge prod-sync-pending">Pending</span>;
  if (needsPush === false) return <span className="prod-sync-badge prod-sync-ok">Synced</span>;
  return <span className="prod-sync-badge prod-sync-none">—</span>;
}

function formatPrice(cents) {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function ProductCard({ product, onClick }) {
  const img = product.images?.[0]?.url || null;
  return (
    <div className="prod-card" onClick={onClick} role="button" tabIndex={0}
         onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="prod-card-img">
        {img
          ? <img src={img} alt={product.name} />
          : <div className="prod-card-no-img">🍷</div>
        }
      </div>
      <div className="prod-card-body">
        <div className="prod-card-name">{product.name}</div>
        <div className="prod-card-meta">
          {product.vintage && <span className="prod-meta-pill">{product.vintage}</span>}
          {product.varietal && <span className="prod-meta-pill">{product.varietal}</span>}
          {product.wine_style && <span className="prod-meta-pill">{product.wine_style}</span>}
          {product.appellation && <span className="prod-meta-pill prod-meta-light">{product.appellation}</span>}
        </div>
        <div className="prod-card-footer">
          <span className="prod-card-price">{formatPrice(product.min_price_cents)}</span>
          <span className="prod-card-variants">{product.variant_count} SKU{product.variant_count !== 1 ? 's' : ''}</span>
          <span className="prod-card-avail">{product.is_available ? '● Active' : '○ Inactive'}</span>
        </div>
        <div className="prod-card-sync">
          <span className="prod-sync-label">C7</span>{syncBadge(product.c7_needs_push, product.c7_sync_error)}
          <span className="prod-sync-label">SQ</span>{syncBadge(product.sq_needs_push, product.sq_sync_error)}
        </div>
      </div>
    </div>
  );
}

// ── Tax Exempt Tab ──────────────────────────────────────────────────────────
function TaxExemptTab() {
  const [allItems, setAllItems]     = useState([]);
  const [exemptItems, setExemptItems] = useState([]);
  const [search, setSearch]         = useState('');
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');

  // Gap checker
  const [gapItems, setGapItems]     = useState(null);
  const [gapLoading, setGapLoading] = useState(false);
  const [gapError, setGapError]     = useState('');

  // Drag state (left → right)
  const [dragItem, setDragItem]     = useState(null);
  const [dragOver, setDragOver]     = useState(null); // 'left' | 'right'

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [sqRes, exRes] = await Promise.all([getSquareItems(), getTaxExemptItems()]);
      setAllItems(sqRes.items || []); // [{ name, category_name }]
      setExemptItems(exRes.items || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);


  const exemptNames = new Set(exemptItems.map((i) => i.item_name));
  const availableItems = allItems.filter((item) => !exemptNames.has(item.name));
  const filtered = search
    ? availableItems.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()) || (item.category_name || '').toLowerCase().includes(search.toLowerCase()))
    : availableItems;

  const handleAddExempt = async (itemName) => {
    try {
      await addTaxExemptItem(itemName);
      setExemptItems((prev) => [...prev, { id: Date.now().toString(), item_name: itemName, created_at: new Date().toISOString() }].sort((a, b) => a.item_name.localeCompare(b.item_name)));
      // Re-fetch to get the real server id
      getTaxExemptItems().then((d) => setExemptItems(d.items || [])).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
  };

  const handleRemoveExempt = async (id, itemName) => {
    try {
      await removeTaxExemptItem(id);
      setExemptItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) {
      setError(e.message);
    }
  };

  // Drag handlers
  const handleDragStart = (name) => setDragItem(name);
  const handleDragEnd   = () => { setDragItem(null); setDragOver(null); };

  const handleDropRight = async (e) => {
    e.preventDefault();
    setDragOver(null);
    if (dragItem) await handleAddExempt(typeof dragItem === 'object' ? dragItem.name : dragItem);
    setDragItem(null);
  };

  const handleRunGap = async () => {
    setGapLoading(true);
    setGapError('');
    setGapItems(null);
    try {
      const data = await getTaxGap();
      setGapItems(data.items || []);
    } catch (e) {
      setGapError(e.message);
    } finally {
      setGapLoading(false);
    }
  };

  if (loading) return <div className="prod-loading">Loading…</div>;

  return (
    <div className="tax-exempt-wrap">
      {error && <div className="prod-error">{error}</div>}

      <div className="tax-exempt-intro">
        <p>
          Items dragged (or clicked) to <strong>Tax Exempt</strong> are excluded from the tax gap check.
          Items sold without tax that are <em>not</em> on this list will trigger a monthly SMS alert to managers.
        </p>
      </div>

      {/* Two-column picker */}
      <div className="tax-exempt-columns">
        {/* Left — all Square items */}
        <div className="tax-col">
          <div className="tax-col-header">
            <h3>All Square Items <span className="tax-col-count">({availableItems.length})</span></h3>
            <input
              className="tax-col-search"
              type="search"
              placeholder="Filter…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <ul className="tax-item-list">
            {filtered.length === 0 && (
              <li className="tax-item-empty">{search ? 'No matches' : 'All items are tax-exempt'}</li>
            )}
            {filtered.map((item) => (
              <li
                key={item.name}
                className="tax-item"
                draggable
                onDragStart={() => handleDragStart(item)}
                onDragEnd={handleDragEnd}
              >
                <span className="tax-item-name">
                  {item.name}
                  {item.category_name && (
                    <span className="tax-category-badge">{item.category_name}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn-tax-add"
                  onClick={() => handleAddExempt(item.name)}
                  title="Mark as tax exempt"
                >
                  Exempt →
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Right — exempt items (drop target) */}
        <div
          className={`tax-col tax-col-exempt ${dragOver === 'right' ? 'tax-drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver('right'); }}
          onDragLeave={() => setDragOver(null)}
          onDrop={handleDropRight}
        >
          <div className="tax-col-header">
            <h3>Tax Exempt <span className="tax-col-count">({exemptItems.length})</span></h3>
          </div>
          <ul className="tax-item-list">
            {exemptItems.length === 0 && (
              <li className="tax-item-empty">Drag items here or click Exempt →</li>
            )}
            {exemptItems.map((item) => (
              <li key={item.id} className="tax-item tax-item-exempt">
                <span className="tax-item-name">{item.item_name}</span>
                <button
                  type="button"
                  className="btn-tax-remove"
                  onClick={() => handleRemoveExempt(item.id, item.item_name)}
                  title="Remove from exempt list"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Tax gap checker */}
      <div className="tax-gap-section">
        <h3>Tax Gap Check</h3>
        <p className="tax-gap-hint">
          Finds catalog items with no tax configured in Square that aren't on the exempt list.
          These items will never charge tax at the POS.
        </p>
        <div className="tax-gap-controls">
          <button type="button" className="btn-tax-gap-run" onClick={handleRunGap} disabled={gapLoading}>
            {gapLoading ? 'Checking…' : 'Run Check'}
          </button>
        </div>

        {gapError && <div className="prod-error">{gapError}</div>}

        {gapItems !== null && (
          gapItems.length === 0 ? (
            <div className="tax-gap-clear">
              ✅ All active catalog items either have tax configured or are on the exempt list.
            </div>
          ) : (
            <>
              <div className="tax-gap-summary">
                ⚠️ <strong>{gapItems.length} item{gapItems.length !== 1 ? 's' : ''}</strong> have no tax configured in Square and are not exempt.
              </div>
              <table className="tax-gap-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th>Price</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {gapItems.map((item) => (
                    <tr key={item.id}>
                      <td>{item.name}</td>
                      <td>{item.category_name ? <span className="tax-category-badge">{item.category_name}</span> : <span className="tax-no-category">—</span>}</td>
                      <td>
                        {item.min_price != null
                          ? item.min_price === item.max_price
                            ? `$${(item.min_price / 100).toFixed(2)}`
                            : `$${(item.min_price / 100).toFixed(2)} – $${(item.max_price / 100).toFixed(2)}`
                          : '—'}
                      </td>
                      <td>{item.is_active
                        ? <span className="ssync-badge ssync-badge-ok">Active</span>
                        : <span className="ssync-badge ssync-badge-none">Inactive</span>}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-tax-add-small"
                          onClick={() => handleAddExempt(item.name)}
                        >
                          Mark Exempt
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        )}
      </div>

    </div>
  );
}

// ── Main Products page ────────────────────────────────────────────────────────
export function Products() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') || 'catalog';

  const [products, setProducts] = useState([]);
  const [filters, setFilters] = useState({ vintages: [], varietals: [], wine_styles: [], product_types: [] });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [filterVintage, setFilterVintage]   = useState('');
  const [filterVarietal, setFilterVarietal] = useState('');
  const [filterStyle, setFilterStyle]       = useState('');
  const [filterAvail, setFilterAvail]       = useState('true');
  const [filterType, setFilterType]         = useState('Wine');
  const [search, setSearch]                 = useState('');
  const [offset, setOffset]                 = useState(0);
  const [syncing, setSyncing]               = useState(false);
  const [syncMessage, setSyncMessage]       = useState('');
  const LIMIT = 48;

  const load = useCallback(async () => {
    if (tab !== 'catalog') return;
    setLoading(true);
    setError('');
    try {
      const params = { limit: LIMIT, offset };
      if (filterVintage)  params.vintage      = filterVintage;
      if (filterVarietal) params.varietal     = filterVarietal;
      if (filterStyle)    params.wine_style   = filterStyle;
      if (filterType)     params.product_type = filterType;
      if (filterAvail)    params.available    = filterAvail;
      if (search)         params.search       = search;
      const data = await getProducts(params);
      setProducts(data.products || []);
      setTotal(data.total || 0);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [tab, filterVintage, filterVarietal, filterStyle, filterType, filterAvail, search, offset]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    getProductFilters().then(setFilters).catch(() => {});
  }, []);

  const resetFilters = () => {
    setFilterVintage(''); setFilterVarietal(''); setFilterStyle('');
    setFilterType(''); setFilterAvail(''); setSearch(''); setOffset(0);
  };

  const hasFilters = filterVintage || filterVarietal || filterStyle || filterType || filterAvail || search;

  const handleSyncC7 = async () => {
    setSyncing(true);
    setSyncMessage('');
    setError('');
    try {
      const r = await importC7Products();
      const failedCount = r.failed?.length || 0;
      setSyncMessage(
        `Synced from Commerce7 — ${r.imported} new, ${r.updated} updated (${r.total} total)` +
        (failedCount
          ? `. ${failedCount} failed: ${r.failed.map((f) => f.title || f.c7_id).join(', ')}`
          : '.')
      );
      getProductFilters().then(setFilters).catch(() => {});
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };
  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <div className="prod-wrap">
      <div className="prod-toolbar">
        <div>
          <h2 className="prod-title">Products</h2>
        </div>
        {tab === 'catalog' && (
          <div className="prod-toolbar-actions">
            <button className="prod-sync-btn" onClick={handleSyncC7} disabled={syncing} title="Pull the latest products from Commerce7 into the wine catalog">
              {syncing ? 'Syncing…' : '⟳ Sync from Commerce7'}
            </button>
            <button className="prod-add-btn" onClick={() => navigate('/products/new')}>
              + New Product
            </button>
          </div>
        )}
      </div>
      {syncMessage && <p className="prod-sync-message">{syncMessage}</p>}

      {/* Tab bar */}
      <div className="prod-tabs">
        <button
          type="button"
          className={tab === 'catalog' ? 'active' : ''}
          onClick={() => setSearchParams({ tab: 'catalog' })}
        >
          Wine Catalog
        </button>
        <button
          type="button"
          className={tab === 'tax-exempt' ? 'active' : ''}
          onClick={() => setSearchParams({ tab: 'tax-exempt' })}
        >
          Tax Exempt
        </button>
      </div>

      {/* Catalog tab */}
      {tab === 'catalog' && (
        <>
          <p className="prod-subtitle">
            {total > 0 ? `${total} wine${total !== 1 ? 's' : ''}` : 'Wine catalog'}
            {' — sourced from Commerce7'}
          </p>

          <div className="prod-filters">
            <input
              className="prod-search"
              type="search"
              placeholder="Search by name or varietal…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
            />
            <select value={filterVintage} onChange={(e) => { setFilterVintage(e.target.value); setOffset(0); }}>
              <option value="">All vintages</option>
              {filters.vintages?.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <select value={filterVarietal} onChange={(e) => { setFilterVarietal(e.target.value); setOffset(0); }}>
              <option value="">All varietals</option>
              {filters.varietals?.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <select value={filterStyle} onChange={(e) => { setFilterStyle(e.target.value); setOffset(0); }}>
              <option value="">All styles</option>
              {filters.wine_styles?.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={filterType} onChange={(e) => { setFilterType(e.target.value); setOffset(0); }}>
              <option value="">All types</option>
              {filters.product_types?.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={filterAvail} onChange={(e) => { setFilterAvail(e.target.value); setOffset(0); }}>
              <option value="">Any availability</option>
              <option value="true">Active only</option>
              <option value="false">Inactive only</option>
            </select>
            {hasFilters && (
              <button className="prod-clear-btn" onClick={resetFilters}>✕ Clear</button>
            )}
          </div>

          {error && <div className="prod-error">{error}</div>}
          {loading && <div className="prod-loading">Loading products…</div>}

          {!loading && products.length === 0 && (
            <div className="prod-empty">
              {hasFilters ? 'No products match your filters.' : 'No products yet. Run the Commerce7 import to populate.'}
            </div>
          )}

          {!loading && products.length > 0 && (
            <>
              <div className="prod-grid">
                {products.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    onClick={() => navigate(`/products/${p.id}`)}
                  />
                ))}
              </div>

              {totalPages > 1 && (
                <div className="prod-pagination">
                  <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
                    ← Prev
                  </button>
                  <span>Page {currentPage} of {totalPages}</span>
                  <button disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Tax Exempt tab */}
      {tab === 'tax-exempt' && <TaxExemptTab />}
    </div>
  );
}
