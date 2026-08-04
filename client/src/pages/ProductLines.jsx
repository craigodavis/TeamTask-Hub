import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getProductLines } from '../api';
import './ProductLines.css';

function vintageRange(first, last) {
  if (!first && !last) return '—';
  if (!first || !last || first === last) return String(first || last);
  return `${first}–${last}`;
}

function LineCard({ line, onClick }) {
  const img = line.images?.[0]?.url || null;
  const missing = line.product_type === 'Wine'
    ? ['upc', 'ttb_label_id'].filter((f) => !line[f])
    : [];

  return (
    <div className="pl-card" onClick={onClick} role="button" tabIndex={0}
         onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="pl-card-img">
        {img ? <img src={img} alt={line.name} /> : <div className="pl-card-no-img">🍷</div>}
      </div>
      <div className="pl-card-body">
        <div className="pl-card-name">{line.name}</div>
        <div className="pl-card-sku">{line.sku_base}</div>
        <div className="pl-card-meta">
          {line.varietal && <span className="pl-pill">{line.varietal}</span>}
          {line.wine_style && <span className="pl-pill">{line.wine_style}</span>}
          {line.appellation && <span className="pl-pill pl-pill-light">{line.appellation}</span>}
        </div>
        <div className="pl-card-footer">
          <span className="pl-count">
            {line.product_count} vintage{line.product_count !== 1 ? 's' : ''}
          </span>
          <span className="pl-range">{vintageRange(line.first_vintage, line.last_vintage)}</span>
          <span className={line.available_count > 0 ? 'pl-avail' : 'pl-avail pl-avail-none'}>
            {line.available_count} available
          </span>
        </div>
        {missing.length > 0 && (
          <div className="pl-card-warn">
            Missing {missing.map((f) => (f === 'ttb_label_id' ? 'TTB label ID' : 'UPC')).join(' and ')}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProductLines() {
  const navigate = useNavigate();
  const [lines, setLines]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getProductLines({ search: search || undefined, archived: showArchived ? 'true' : 'false' })
      .then(setLines)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [search, showArchived]);

  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  return (
    <div className="pl-page">
      <div className="pl-header">
        <div>
          <h1 className="pl-title">Product Lines</h1>
          <p className="pl-subtitle">
            The wine itself, across every vintage. Varietal, appellation and label data
            are entered here once — each vintage inherits them.
          </p>
        </div>
        <button className="pl-new-btn" onClick={() => navigate('/product-lines/new')}>
          + New Line
        </button>
      </div>

      <div className="pl-toolbar">
        <input
          className="pl-search"
          placeholder="Search name, SKU base or varietal…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="pl-check">
          <input type="checkbox" checked={showArchived}
                 onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {error && <div className="pl-error">{error}</div>}

      {loading ? (
        <div className="pl-empty">Loading…</div>
      ) : lines.length === 0 ? (
        <div className="pl-empty">
          <p>No product lines yet.</p>
          <p className="pl-empty-hint">
            A line groups every vintage of one wine. Create one, then attach its vintages
            from the line screen.
          </p>
        </div>
      ) : (
        <div className="pl-grid">
          {lines.map((l) => (
            <LineCard key={l.id} line={l} onClick={() => navigate(`/product-lines/${l.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}
