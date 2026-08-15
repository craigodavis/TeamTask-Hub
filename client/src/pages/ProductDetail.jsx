import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getProduct, updateProduct, createProduct } from '../api';
import { RichEditor } from '../components/RichEditor';
import './ProductDetail.css';
import './ProductLines.css';
import { defaultVariantSku, isGlassVolume } from '../utils/skuNomenclature';

const WINE_STYLES = ['Red', 'White', 'Rosé', 'Sparkling', 'Dessert', 'Fortified', 'Orange', 'Other'];

// ── Tags pill input component ─────────────────────────────────────────────────
function TagInput({ tags, onChange }) {
  const [input, setInput] = useState('');
  const inputRef = useRef(null);

  function addTag(raw) {
    const val = raw.trim().replace(/,+$/, '').trim();
    if (!val) return;
    if (!tags.includes(val)) onChange([...tags, val]);
    setInput('');
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input);
    } else if (e.key === 'Backspace' && !input && tags.length) {
      onChange(tags.slice(0, -1));
    }
  }

  function handleChange(e) {
    const val = e.target.value;
    if (val.endsWith(',')) {
      addTag(val);
    } else {
      setInput(val);
    }
  }

  function removeTag(tag) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div className="tag-input-wrap" onClick={() => inputRef.current?.focus()}>
      {tags.map((tag) => (
        <span key={tag} className="tag-pill">
          {tag}
          <button type="button" onClick={(e) => { e.stopPropagation(); removeTag(tag); }} aria-label={`Remove ${tag}`}>×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="tag-text-input"
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={tags.length === 0 ? 'Add tags…' : ''}
      />
    </div>
  );
}

// ── Inherited HTML, rendered read-only ────────────────────────────────────────
// The line owns this copy; showing it here as a disabled editor would imply it
// is editable, so it renders as plain content instead.
function ReadOnlyHtml({ html, empty }) {
  if (!html) return <div className="pd-readonly-html pd-readonly-empty">{empty}</div>;
  return <div className="pd-readonly-html" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── Sync badge ────────────────────────────────────────────────────────────────
function SyncBadge({ sync }) {
  const c7 = sync?.commerce7;
  if (!c7) return <span className="pd-sync-badge pd-sync-none">C7 Not Linked</span>;
  if (c7.sync_error) return <span className="pd-sync-badge pd-sync-error" title={c7.sync_error}>C7 Error</span>;
  if (c7.needs_push) return <span className="pd-sync-badge pd-sync-pending">C7 Pending</span>;
  return <span className="pd-sync-badge pd-sync-ok">C7 Synced</span>;
}

// ── Main component ────────────────────────────────────────────────────────────
export function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('details');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [c7Warn, setC7Warn] = useState('');

  // Form state — product fields
  const [name, setName]               = useState('');
  const [teaser, setTeaser]           = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive]       = useState(true);
  const [isAvailable, setIsAvailable] = useState(true);
  const [isWebAvailable, setIsWebAvailable] = useState(true);
  const [isArchived, setIsArchived]   = useState(false);

  // Wine details
  const [vintage, setVintage]         = useState('');
  const [varietal, setVarietal]       = useState('');
  const [wineStyle, setWineStyle]     = useState('');
  const [productType, setProductType] = useState('');
  const [appellation, setAppellation] = useState('');
  const [region, setRegion]           = useState('');
  const [country, setCountry]         = useState('USA');

  // C7 / Commerce7 fields
  const [slug, setSlug]               = useState('');
  const [seoTitle, setSeoTitle]       = useState('');
  const [seoDesc, setSeoDesc]         = useState('');
  const [tastingNotes, setTastingNotes]     = useState('');
  const [winemakerNotes, setWinemakerNotes] = useState('');
  const [pairingNotes, setPairingNotes]     = useState('');
  const [releaseDate, setReleaseDate]       = useState('');
  const [casesProduced, setCasesProduced]   = useState('');
  const [originVineyard, setOriginVineyard] = useState('');
  const [labelStory, setLabelStory]         = useState('');
  const [tags, setTags]               = useState([]);
  const [awards, setAwards]           = useState('');

  // The product-level SKU stem, used to suggest variant SKUs.
  const [productSku, setProductSku] = useState('');

  // Variants
  const [variants, setVariants] = useState([]);

  // Original product data (for sync badge)
  const [productSync, setProductSync] = useState(null);

  // The product line this vintage belongs to. When set, the line owns the wine-level
  // fields and they render read-only here — edited once on the line, not per vintage.
  const [line, setLine] = useState(null);

  // ── Load product ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isNew) return;
    setLoading(true);
    getProduct(id)
      .then((p) => {
        setName(p.name || '');
        setTeaser(p.c7?.teaser || '');
        setDescription(p.description || '');
        setIsActive(p.is_active !== false);
        setIsAvailable(Boolean(p.is_available));
        // Defaults on: an older product predating the column reads as true.
        setIsWebAvailable(p.is_web_available !== false);
        setIsArchived(Boolean(p.is_archived));
        setVintage(p.vintage ? String(p.vintage) : '');
        setVarietal(p.varietal || '');
        setWineStyle(p.wine_style || '');
        setProductType(p.product_type || '');
        setAppellation(p.appellation || '');
        setRegion(p.region || '');
        setCountry(p.country || 'USA');
        setSlug(p.c7?.c7_handle || '');
        setSeoTitle(p.c7?.seo_title || '');
        setSeoDesc(p.c7?.seo_description || '');
        // These are Commerce7 metaData fields, now stored locally so the form can
        // round-trip them. Loading them blank and saving would clear them in C7.
        setTastingNotes(p.c7?.tasting_notes || '');
        setWinemakerNotes(p.c7?.winemaker_notes || '');
        setPairingNotes(p.c7?.pairing_notes || '');
        setReleaseDate(p.c7?.release_date || '');
        setCasesProduced(p.c7?.cases_produced != null ? String(p.c7.cases_produced) : '');
        setOriginVineyard(p.c7?.origin_vineyard || '');
        setLabelStory(p.c7?.label_story || '');
        setTags(Array.isArray(p.c7?.tags) ? p.c7.tags : []);
        setAwards(typeof p.c7?.awards === 'string' ? p.c7.awards : '');
        setLine(p.line || null);
        setVariants((p.variants || []).map((v) => ({ ...v, _price: v.price_cents != null ? (v.price_cents / 100).toFixed(2) : '' })));
        setProductSku(p.sku || '');
        setProductSync(p.sync || null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  // ── Build payload ───────────────────────────────────────────────────────────
  function buildPayload() {
    const payload = {
      name: name.trim(),
      description: description || null,
      teaser: teaser || null,
      is_active: isActive,
      is_available: isAvailable,
      is_web_available: isWebAvailable,
      is_archived: isArchived,
      vintage: vintage ? parseInt(vintage, 10) : null,
      varietal: varietal || null,
      wine_style: wineStyle || null,
      product_type: productType || null,
      appellation: appellation || null,
      region: region || null,
      country: country || 'USA',
      slug: slug || undefined,
      seo_title: seoTitle || null,
      seo_description: seoDesc || null,
      tasting_notes: tastingNotes || null,
      winemaker_notes: winemakerNotes || null,
      pairing_notes: pairingNotes || null,
      release_date: releaseDate || null,
      cases_produced: casesProduced ? parseInt(casesProduced, 10) : null,
      origin_vineyard: originVineyard || null,
      label_story: labelStory || null,
      tags,
      awards: awards || null,
    };

    if (variants.length) {
      payload.variants = variants.map((v) => ({
        id: v.id,
        sku: v.sku || null,
        price_cents: v._price !== '' && v._price != null ? Math.round(parseFloat(v._price) * 100) : null,
        volume_format: v.volume_format || null,
        is_available: Boolean(v.is_available),
        alcohol_pct: v.alcohol_pct || null,
      }));
    }

    return payload;
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  async function handleSave() {
    setError('');
    setSuccess('');
    setC7Warn('');
    if (!name.trim()) { setError('Product name is required.'); return; }

    setSaving(true);
    try {
      const payload = buildPayload();

      let result;
      if (isNew) {
        result = await createProduct(payload);
        if (result?.product?.id) {
          navigate(`/products/${result.product.id}`, { replace: true });
        }
      } else {
        result = await updateProduct(id, payload);
        if (result?.product?.sync) setProductSync(result.product.sync);
        // Re-seed the variants from what was actually saved. Without this a
        // variant added in this session keeps id === null in the form, so the
        // next save re-sends it as new and collides with the row it just
        // created. It also picks up the SKU the server defaulted and the
        // Commerce7 variant id it was just linked to.
        if (Array.isArray(result?.product?.variants)) {
          setVariants(result.product.variants.map((v) => ({
            ...v,
            _price: v.price_cents != null ? (v.price_cents / 100).toFixed(2) : '',
          })));
        }
      }

      if (result?.c7Error) {
        setC7Warn(`Saved locally. Commerce7 sync failed: ${result.c7Error}`);
      } else {
        setSuccess(isNew ? 'Product created.' : 'Changes saved.');
        setTimeout(() => setSuccess(''), 4000);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Variant helpers ─────────────────────────────────────────────────────────
  function updateVariantField(idx, field, value) {
    setVariants((prev) => prev.map((v, i) => {
      if (i !== idx) return v;
      const next = { ...v, [field]: value };
      // Retarget the suggested SKU when the volume changes on a row that has
      // not been saved yet -- switching 750ml to 5oz has to pick up `-gls`, or
      // the pour ships with the bottle's SKU and stops matching Square.
      // Only while the SKU is still the untouched suggestion; anything typed
      // by hand is left alone.
      if (field === 'volume_format' && v.id == null) {
        const previousSuggestion = defaultVariantSku(
          { sku: productSku, vintage, name },
          { volume_format: v.volume_format }
        );
        if (!v.sku || v.sku === previousSuggestion) {
          next.sku = defaultVariantSku({ sku: productSku, vintage, name }, { volume_format: value });
        }
      }
      return next;
    }));
  }

  function addVariant() {
    setVariants((prev) => {
      // A bottle unless there already is one, in which case the next thing
      // anyone adds is the glass pour.
      const volumeFormat = prev.some((v) => !isGlassVolume(v.volume_format)) ? '5oz' : '750ml';
      return [
        ...prev,
        {
          id: null,
          volume_format: volumeFormat,
          // Filled in rather than left blank so the house format is visible and
          // editable before saving. The server applies the same rule to an
          // empty one.
          sku: defaultVariantSku({ sku: productSku, vintage, name }, { volume_format: volumeFormat }),
          _price: '',
          is_available: true,
          c7_variant_id: null,
          ordinal: prev.length,
        },
      ];
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) return <div className="pd-loading">Loading product…</div>;

  const pageTitle = isNew ? 'New Product' : name || 'Product Detail';

  return (
    <div className="pd-wrap">
      <button className="pd-back-link" onClick={() => navigate('/products')}>
        ← Back to Products
      </button>

      <div className="pd-header">
        <div className="pd-header-left">
          <h1 className="pd-header-title">{pageTitle}</h1>
          {!isNew && (
            <p className="pd-header-subtitle">
              {vintage && `${vintage} · `}{varietal && `${varietal} · `}{wineStyle || 'Wine'}
            </p>
          )}
        </div>
        <div className="pd-header-right">
          {!isNew && <SyncBadge sync={productSync} />}
          <button className="pd-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create Product' : 'Save Changes'}
          </button>
        </div>
      </div>

      {error   && <div className="pd-error">{error}</div>}
      {c7Warn  && <div className="pd-warning">{c7Warn}</div>}
      {success && <div className="pd-success">{success}</div>}

      <div className="pd-tabs">
        <button className={`pd-tab-btn${tab === 'details' ? ' active' : ''}`} onClick={() => setTab('details')}>
          Details
        </button>
        <button className={`pd-tab-btn${tab === 'variants' ? ' active' : ''}`} onClick={() => setTab('variants')}>
          Variants {variants.length > 0 && `(${variants.length})`}
        </button>
      </div>

      {tab === 'details' && (
        <>
          {/* Inherited from the product line — read-only here by design. These are
              facts about the wine, not the vintage, so they are edited in one place. */}
          {line ? (
            <div className="pd-inherited">
              <div className="pd-inherited-head">
                <p className="pd-inherited-title">From product line — {line.name}</p>
                <button type="button" className="pd-inherited-edit"
                        onClick={() => navigate(`/product-lines/${line.id}`)}>
                  Edit line →
                </button>
              </div>
              <div className="pd-inherited-grid">
                {[
                  ['SKU Base', line.sku_base],
                  ['UPC', line.upc],
                  ['TTB Label ID', line.ttb_label_id],
                  ['Varietal', line.varietal],
                  ['Style', line.wine_style],
                  ['Appellation', line.appellation],
                  ['Region', line.region],
                  ['Country', line.country],
                  ['Origin Project', line.origin_project],
                  ['Club Eligible', line.club_eligible ? 'Yes' : 'No'],
                ].map(([label, val]) => (
                  <div className="pd-inh-item" key={label}>
                    <span className="pd-inh-label">{label}</span>
                    <span className="pd-inh-value">
                      {val || <span className="pd-inh-empty">not set</span>}
                    </span>
                  </div>
                ))}
              </div>
              <p className="pd-inherited-note">
                Changing any of these on the line updates every vintage of {line.name}.
              </p>
            </div>
          ) : !isNew && (
            <div className="pd-unlinked">
              This product isn’t attached to a product line, so its varietal, appellation
              and label data are stored on the vintage alone and have to be retyped for the
              next one. Attach it from the line screen.
            </div>
          )}

          {/* Product Info */}
          <div className="pd-section">
            <p className="pd-section-title">Product Info</p>

            <div className="pd-field">
              <label htmlFor="pd-name">Name *</label>
              <input
                id="pd-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. 2021 Cabernet Sauvignon Reserve"
              />
            </div>

            <div className="pd-field">
              <label htmlFor="pd-teaser">Teaser</label>
              <input
                id="pd-teaser"
                type="text"
                value={teaser}
                onChange={(e) => setTeaser(e.target.value)}
                placeholder="Short one-line description for listings"
              />
            </div>

            <div className="pd-field">
              <label htmlFor="pd-description">Description</label>
              {/* Description, label story, tasting notes and awards describe the
                  wine, not the vintage, so the line owns them. Read-only here. */}
              {line ? (
                <ReadOnlyHtml html={line.description} empty="No description on the line yet." />
              ) : (
                <RichEditor
                  initialContent={description}
                  onChange={setDescription}
                  placeholder="Full product description…"
                />
              )}
            </div>

            {line ? (
              <>
                <div className="pd-field">
                  <label>Label Story</label>
                  <ReadOnlyHtml html={line.label_story} empty="No label story on the line yet." />
                </div>
                <div className="pd-field">
                  <label>Tasting Notes</label>
                  <ReadOnlyHtml html={line.tasting_notes} empty="No tasting notes on the line yet." />
                </div>
                <div className="pd-field">
                  <label>Awards</label>
                  <ReadOnlyHtml html={line.awards} empty="No awards on the line yet." />
                </div>
                <p className="pd-inherited-note">
                  These belong to {line.name} and are shared by every vintage.{' '}
                  <button type="button" className="pd-inherited-edit"
                          onClick={() => navigate(`/product-lines/${line.id}`)}>
                    Edit on the line →
                  </button>
                </p>
              </>
            ) : (
              <div className="pd-field">
                <label htmlFor="pd-label-story">Label Story</label>
                <RichEditor
                  initialContent={labelStory}
                  onChange={setLabelStory}
                  placeholder="The story behind the label…"
                />
                <span className="pd-field-hint">
                  Commerce7 <code>label-story</code>. Attach this product to a line to
                  share it across vintages.
                </span>
              </div>
            )}

            <div className="pd-row">
              <div className="pd-field-check">
                <input
                  id="pd-active"
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setIsActive(on);
                    // A wine that doesn't physically exist can't be for sale.
                    if (!on) setIsAvailable(false);
                  }}
                />
                <label htmlFor="pd-active">Active</label>
                <span className="pd-field-hint">On the shelf — appears on the inventory count sheet.</span>
              </div>
              <div className="pd-field-check">
                <input
                  id="pd-available"
                  type="checkbox"
                  checked={isAvailable}
                  disabled={!isActive}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setIsAvailable(on);
                    // Web can't outrank Admin: nothing should be on the
                    // storefront that staff aren't allowed to sell.
                    if (!on) setIsWebAvailable(false);
                  }}
                />
                <label htmlFor="pd-available">Admin available</label>
                <span className="pd-field-hint">
                  {isActive
                    ? "Commerce7 Admin Status. Staff can sell it — club releases, phone and internal orders. Bottled but not yet released? Leave this off."
                    : 'Requires Active.'}
                </span>
              </div>
              <div className="pd-field-check">
                <input
                  id="pd-web-available"
                  type="checkbox"
                  checked={isWebAvailable}
                  disabled={!isAvailable}
                  onChange={(e) => setIsWebAvailable(e.target.checked)}
                />
                <label htmlFor="pd-web-available">Web available</label>
                <span className="pd-field-hint">
                  {isAvailable
                    ? "Commerce7 Web Status. On the storefront, and live in Square. Turning this off also archives it in Square, so it leaves the POS grid — that is the club-release state: Admin on, Web off."
                    : 'Requires Admin available.'}
                </span>
              </div>
              {!isNew && (
                <div className="pd-field-check">
                  <input
                    id="pd-archived"
                    type="checkbox"
                    checked={isArchived}
                    onChange={(e) => setIsArchived(e.target.checked)}
                  />
                  <label htmlFor="pd-archived">Archived</label>
                </div>
              )}
            </div>
          </div>

          {/* Wine Details */}
          <div className="pd-section">
            <p className="pd-section-title">Wine Details</p>

            <div className="pd-row">
              <div className="pd-field">
                <label htmlFor="pd-vintage">Vintage</label>
                <input
                  id="pd-vintage"
                  type="number"
                  value={vintage}
                  onChange={(e) => setVintage(e.target.value)}
                  placeholder="e.g. 2021"
                  min="1900"
                  max="2100"
                />
              </div>
              <div className="pd-field">
                <label htmlFor="pd-varietal">Varietal</label>
                <input
                  id="pd-varietal"
                  type="text"
                  value={varietal}
                  onChange={(e) => setVarietal(e.target.value)}
                  disabled={Boolean(line)}
                  placeholder="e.g. Cabernet Sauvignon"
                />
              </div>
              <div className="pd-field">
                <label htmlFor="pd-style">Wine Style</label>
                <select id="pd-style" value={wineStyle} onChange={(e) => setWineStyle(e.target.value)} disabled={Boolean(line)}>
                  <option value="">— Select —</option>
                  {WINE_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="pd-field">
                <label htmlFor="pd-type">Type</label>
                <input
                  id="pd-type"
                  type="text"
                  value={productType}
                  onChange={(e) => setProductType(e.target.value)}
                  disabled={Boolean(line)}
                  placeholder="e.g. Wine"
                />
                <span className="pd-field-hint">Commerce7's top-level product type (Wine vs Non-Wine) — used to filter the catalog.</span>
              </div>
            </div>

            <div className="pd-row">
              <div className="pd-field">
                <label htmlFor="pd-appellation">Appellation</label>
                <input
                  id="pd-appellation"
                  type="text"
                  value={appellation}
                  onChange={(e) => setAppellation(e.target.value)}
                  disabled={Boolean(line)}
                  placeholder="e.g. Napa Valley"
                />
              </div>
              <div className="pd-field">
                <label htmlFor="pd-region">Region</label>
                <input
                  id="pd-region"
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  disabled={Boolean(line)}
                  placeholder="e.g. North Coast"
                />
              </div>
              <div className="pd-field">
                <label htmlFor="pd-country">Country</label>
                <input
                  id="pd-country"
                  type="text"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  disabled={Boolean(line)}
                  placeholder="e.g. USA"
                />
              </div>
            </div>
          </div>

          {/* Commerce7 */}
          <div className="pd-section">
            <p className="pd-section-title">Commerce7</p>

            <div className="pd-row">
              <div className="pd-field">
                <label htmlFor="pd-slug">Slug (URL handle)</label>
                <input
                  id="pd-slug"
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="e.g. 2021-cabernet-sauvignon-reserve"
                />
              </div>
            </div>

            <div className="pd-row">
              <div className="pd-field">
                <label htmlFor="pd-seo-title">SEO Title</label>
                <input
                  id="pd-seo-title"
                  type="text"
                  value={seoTitle}
                  onChange={(e) => setSeoTitle(e.target.value)}
                  placeholder="Page title for search engines"
                />
              </div>
              <div className="pd-field">
                <label htmlFor="pd-seo-desc">SEO Description</label>
                <input
                  id="pd-seo-desc"
                  type="text"
                  value={seoDesc}
                  onChange={(e) => setSeoDesc(e.target.value)}
                  placeholder="Meta description"
                />
              </div>
            </div>

            <div className="pd-field">
              <label htmlFor="pd-tasting">Tasting Notes</label>
              <textarea
                id="pd-tasting"
                value={tastingNotes}
                onChange={(e) => setTastingNotes(e.target.value)}
                placeholder="Aromas, flavors, finish…"
              />
            </div>

            <div className="pd-field">
              <label htmlFor="pd-winemaker">Winemaker Notes</label>
              <textarea
                id="pd-winemaker"
                value={winemakerNotes}
                onChange={(e) => setWinemakerNotes(e.target.value)}
                placeholder="Notes from the winemaker"
              />
            </div>

            <div className="pd-row">
              <div className="pd-field">
                <label htmlFor="pd-pairing">Pairing Notes</label>
                <input
                  id="pd-pairing"
                  type="text"
                  value={pairingNotes}
                  onChange={(e) => setPairingNotes(e.target.value)}
                  placeholder="e.g. Grilled lamb, aged cheeses"
                />
              </div>
              <div className="pd-field">
                <label htmlFor="pd-release">Release Date</label>
                <input
                  id="pd-release"
                  type="date"
                  value={releaseDate}
                  onChange={(e) => setReleaseDate(e.target.value)}
                />
              </div>
            </div>

            <div className="pd-row">
              <div className="pd-field">
                <label htmlFor="pd-cases">Cases Produced</label>
                <input
                  id="pd-cases"
                  type="number"
                  value={casesProduced}
                  onChange={(e) => setCasesProduced(e.target.value)}
                  placeholder="e.g. 250"
                  min="0"
                />
              </div>
              <div className="pd-field">
                <label htmlFor="pd-origin">Origin Vineyard</label>
                <input
                  id="pd-origin"
                  type="text"
                  value={originVineyard}
                  onChange={(e) => setOriginVineyard(e.target.value)}
                  placeholder="e.g. Beckstoffer To Kalon"
                />
              </div>
            </div>

            <div className="pd-field">
              <label htmlFor="pd-awards">Awards</label>
              <input
                id="pd-awards"
                type="text"
                value={awards}
                onChange={(e) => setAwards(e.target.value)}
                placeholder="e.g. 95 pts Wine Spectator"
              />
            </div>

            <div className="pd-field">
              <label>Tags</label>
              <TagInput tags={tags} onChange={setTags} />
            </div>
          </div>
        </>
      )}

      {tab === 'variants' && (
        <div className="pd-section">
          <p className="pd-section-title">Variants</p>

          {variants.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: '0.875rem' }}>No variants yet.</p>
          ) : (
            <table className="pd-variants-table">
              <thead>
                <tr>
                  <th>Volume</th>
                  <th>SKU</th>
                  <th>Price (USD)</th>
                  <th>Available</th>
                  <th>C7 Variant ID</th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v, idx) => (
                  <tr key={v.id ?? `new-${idx}`}>
                    <td>
                      <input
                        type="text"
                        value={v.volume_format || ''}
                        onChange={(e) => updateVariantField(idx, 'volume_format', e.target.value)}
                        placeholder="750ml"
                        style={{ width: 80 }}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="pd-variant-sku"
                        value={v.sku || ''}
                        onChange={(e) => updateVariantField(idx, 'sku', e.target.value)}
                        placeholder="SKU"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={v._price || ''}
                        onChange={(e) => updateVariantField(idx, '_price', e.target.value)}
                        placeholder="0.00"
                        step="0.01"
                        min="0"
                        style={{ width: 80 }}
                      />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        className="avail-check"
                        checked={Boolean(v.is_available)}
                        onChange={(e) => updateVariantField(idx, 'is_available', e.target.checked)}
                      />
                    </td>
                    <td>
                      <span className="pd-c7id">{v.c7_variant_id || '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <button className="pd-add-variant-btn" onClick={addVariant}>
            + Add variant
          </button>
        </div>
      )}
    </div>
  );
}
