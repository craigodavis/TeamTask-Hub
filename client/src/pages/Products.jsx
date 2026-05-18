import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getProducts, getProductFilters } from '../api';
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

export function Products() {
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [filters, setFilters] = useState({ vintages: [], varietals: [], wine_styles: [] });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [filterVintage, setFilterVintage]   = useState('');
  const [filterVarietal, setFilterVarietal] = useState('');
  const [filterStyle, setFilterStyle]       = useState('');
  const [filterAvail, setFilterAvail]       = useState('');
  const [search, setSearch]                 = useState('');
  const [offset, setOffset]                 = useState(0);
  const LIMIT = 48;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { limit: LIMIT, offset };
      if (filterVintage)  params.vintage   = filterVintage;
      if (filterVarietal) params.varietal  = filterVarietal;
      if (filterStyle)    params.wine_style = filterStyle;
      if (filterAvail)    params.available  = filterAvail;
      if (search)         params.search    = search;
      const data = await getProducts(params);
      setProducts(data.products || []);
      setTotal(data.total || 0);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filterVintage, filterVarietal, filterStyle, filterAvail, search, offset]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    getProductFilters().then(setFilters).catch(() => {});
  }, []);

  const resetFilters = () => {
    setFilterVintage(''); setFilterVarietal(''); setFilterStyle('');
    setFilterAvail(''); setSearch(''); setOffset(0);
  };

  const hasFilters = filterVintage || filterVarietal || filterStyle || filterAvail || search;
  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <div className="prod-wrap">
      <div className="prod-toolbar">
        <div>
          <h2 className="prod-title">Products</h2>
          <p className="prod-subtitle">
            {total > 0 ? `${total} wine${total !== 1 ? 's' : ''}` : 'Wine catalog'}
            {' — sourced from Commerce7'}
          </p>
        </div>
        <button
          className="prod-add-btn"
          onClick={() => navigate('/products/new')}
        >
          + New Product
        </button>
      </div>

      {/* Filters */}
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
          {hasFilters
            ? 'No products match your filters.'
            : 'No products yet. Run the Commerce7 import to populate.'}
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
              <button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              >
                ← Prev
              </button>
              <span>Page {currentPage} of {totalPages}</span>
              <button
                disabled={offset + LIMIT >= total}
                onClick={() => setOffset(offset + LIMIT)}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
