import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getProductLine, createProductLine, updateProductLine,
  getUnassignedProducts, attachProductsToLine,
} from '../api';
import './ProductLines.css';

const WINE_STYLES = ['Red', 'White', 'Rosé', 'Sparkling', 'Dessert', 'Fortified', 'Orange', 'Other'];
const TYPES = ['Wine', 'General Merchandise', 'Reservation', 'Event Ticket'];

// Mirrors canonSkuBase on the server so the field shows what will be stored.
function canonSkuBase(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function Field({ label, required, hint, children, wide }) {
  return (
    <div className={`pld-field${wide ? ' pld-field-wide' : ''}`}>
      <label className="pld-label">{label}{required && <span className="pld-req">*</span>}</label>
      {children}
      {hint && <span className="pld-hint">{hint}</span>}
    </div>
  );
}

export function ProductLineDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  const [f, setF] = useState({
    name: '', sku_base: '', upc: '', ttb_label_id: '', product_type: 'Wine',
    varietal: '', origin_project: '', wine_style: '', appellation: '',
    region: '', country: 'US', description: '', teaser: '', winemaker_notes: '',
    seo_title: '', seo_description: '', club_eligible: true, is_archived: false,
    display_order: 0,
  });
  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setF((prev) => ({ ...prev, [k]: v }));
  };

  const [products, setProducts]     = useState([]);
  const [unassigned, setUnassigned] = useState([]);
  const [toAttach, setToAttach]     = useState('');

  useEffect(() => {
    if (isNew) return;
    setLoading(true);
    getProductLine(id)
      .then((l) => {
        setF({
          name: l.name || '', sku_base: l.sku_base || '', upc: l.upc || '',
          ttb_label_id: l.ttb_label_id || '', product_type: l.product_type || 'Wine',
          varietal: l.varietal || '', origin_project: l.origin_project || '',
          wine_style: l.wine_style || '', appellation: l.appellation || '',
          region: l.region || '', country: l.country || 'US',
          description: l.description || '', teaser: l.teaser || '',
          winemaker_notes: l.winemaker_notes || '', seo_title: l.seo_title || '',
          seo_description: l.seo_description || '',
          club_eligible: l.club_eligible !== false, is_archived: Boolean(l.is_archived),
          display_order: l.display_order ?? 0,
        });
        setProducts(l.products || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  useEffect(() => {
    if (isNew) return;
    getUnassignedProducts(id).then(setUnassigned).catch(() => {});
  }, [id, isNew]);

  async function save() {
    setError(''); setSuccess(''); setSaving(true);
    try {
      const body = { ...f, sku_base: canonSkuBase(f.sku_base), display_order: Number(f.display_order) || 0 };
      if (isNew) {
        const created = await createProductLine(body);
        navigate(`/product-lines/${created.id}`, { replace: true });
      } else {
        await updateProductLine(id, body);
        setSuccess('Saved.');
        setTimeout(() => setSuccess(''), 2500);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function attach(productId) {
    const ids = [...products.map((p) => p.id), productId];
    try {
      await attachProductsToLine(id, ids);
      const l = await getProductLine(id);
      setProducts(l.products || []);
      setUnassigned(await getUnassignedProducts(id));
      setToAttach('');
    } catch (e) { setError(e.message); }
  }

  async function detach(productId) {
    const ids = products.filter((p) => p.id !== productId).map((p) => p.id);
    try {
      await attachProductsToLine(id, ids);
      const l = await getProductLine(id);
      setProducts(l.products || []);
      setUnassigned(await getUnassignedProducts(id));
    } catch (e) { setError(e.message); }
  }

  if (loading) return <div className="pld-page"><p>Loading…</p></div>;

  const isWine = f.product_type === 'Wine';

  return (
    <div className="pld-page">
      <button className="pld-back" onClick={() => navigate('/product-lines')}>← Product Lines</button>

      <div className="pld-head">
        <div>
          <h1 className="pld-title">{isNew ? 'New Product Line' : f.name || 'Untitled'}</h1>
          {!isNew && <span className="pld-sku">{f.sku_base}</span>}
        </div>
        <div className="pld-actions">
          <button className="pld-save" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create Line' : 'Save'}
          </button>
        </div>
      </div>

      {error   && <div className="pld-msg pld-msg-err">{error}</div>}
      {success && <div className="pld-msg pld-msg-ok">{success}</div>}

      <div className="pld-section">
        <p className="pld-section-title">Identity</p>
        <div className="pld-grid">
          <Field label="Name" required hint="No vintage — “Papa's Malbec”, not “23 Papa's”">
            <input className="pld-input" value={f.name} onChange={set('name')} />
          </Field>
          <Field label="SKU Base" required
                 hint={f.sku_base ? `Stored as ${canonSkuBase(f.sku_base)}` : 'Product SKU minus the vintage prefix'}>
            <input className="pld-input pld-mono" value={f.sku_base} onChange={set('sku_base')} />
          </Field>
          <Field label="Type">
            <select className="pld-select" value={f.product_type} onChange={set('product_type')}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="UPC" required={isWine} hint={isWine ? 'Required for wine — same across vintages' : undefined}>
            <input className="pld-input pld-mono" value={f.upc} onChange={set('upc')} />
          </Field>
          <Field label="TTB Label ID" required={isWine} hint={isWine ? 'Required for wine — the COLA covers the label, not the vintage' : undefined}>
            <input className="pld-input pld-mono" value={f.ttb_label_id} onChange={set('ttb_label_id')} />
          </Field>
          <Field label="Display Order">
            <input className="pld-input" type="number" value={f.display_order} onChange={set('display_order')} />
          </Field>
        </div>
      </div>

      <div className="pld-section">
        <p className="pld-section-title">Wine Details</p>
        <div className="pld-grid">
          <Field label="Varietal"><input className="pld-input" value={f.varietal} onChange={set('varietal')} /></Field>
          <Field label="Style">
            <select className="pld-select" value={f.wine_style} onChange={set('wine_style')}>
              <option value="">—</option>
              {WINE_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Origin Project"><input className="pld-input" value={f.origin_project} onChange={set('origin_project')} /></Field>
          <Field label="Appellation"><input className="pld-input" value={f.appellation} onChange={set('appellation')} /></Field>
          <Field label="Region"><input className="pld-input" value={f.region} onChange={set('region')} /></Field>
          <Field label="Country"><input className="pld-input" value={f.country} onChange={set('country')} /></Field>
        </div>
      </div>

      <div className="pld-section">
        <p className="pld-section-title">Copy</p>
        <div className="pld-grid">
          <Field label="Teaser" wide><input className="pld-input" value={f.teaser} onChange={set('teaser')} /></Field>
          <Field label="Description" wide><textarea className="pld-textarea" value={f.description} onChange={set('description')} /></Field>
          <Field label="Winemaker Notes" wide><textarea className="pld-textarea" value={f.winemaker_notes} onChange={set('winemaker_notes')} /></Field>
          <Field label="SEO Title"><input className="pld-input" value={f.seo_title} onChange={set('seo_title')} /></Field>
          <Field label="SEO Description"><input className="pld-input" value={f.seo_description} onChange={set('seo_description')} /></Field>
        </div>
      </div>

      <div className="pld-section">
        <p className="pld-section-title">Settings</p>
        <div className="pld-grid">
          <Field label="Club Eligible">
            <label className="pl-check">
              <input type="checkbox" checked={f.club_eligible} onChange={set('club_eligible')} /> Available to clubs
            </label>
          </Field>
          <Field label="Archived" hint="Line discontinued — hides it and every vintage from pickers">
            <label className="pl-check">
              <input type="checkbox" checked={f.is_archived} onChange={set('is_archived')} /> Archived
            </label>
          </Field>
        </div>
      </div>

      {!isNew && (
        <div className="pld-section">
          <p className="pld-section-title">Vintages ({products.length})</p>
          {products.length === 0 ? (
            <p className="pld-hint">No vintages attached yet.</p>
          ) : (
            <table className="pld-vintages">
              <thead>
                <tr>
                  <th>Vintage</th><th>Product</th><th>ABV</th><th>Bottles</th>
                  <th>SKUs</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td>{p.vintage || '—'}</td>
                    <td>
                      <button className="pld-vintage-link" onClick={() => navigate(`/products/${p.id}`)}>
                        {p.name}
                      </button>
                    </td>
                    <td>{p.alcohol_pct != null ? `${p.alcohol_pct}%` : <span className="pd-inh-empty">not set</span>}</td>
                    <td>{p.bottles}</td>
                    <td>{p.variant_count}</td>
                    <td>
                      <span className={`pld-badge ${p.is_available ? 'pld-badge-on' : 'pld-badge-off'}`}>
                        {p.is_available ? 'Available' : 'Inactive'}
                      </span>
                    </td>
                    <td><button className="pld-detach" onClick={() => detach(p.id)}>Detach</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="pld-attach-row">
            <select className="pld-select" value={toAttach} onChange={(e) => setToAttach(e.target.value)}>
              <option value="">Attach an existing vintage…</option>
              {unassigned.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.vintage ? `${p.vintage} — ` : ''}{p.name}
                </option>
              ))}
            </select>
            <button className="pld-attach-btn" disabled={!toAttach} onClick={() => attach(toAttach)}>
              Attach
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
