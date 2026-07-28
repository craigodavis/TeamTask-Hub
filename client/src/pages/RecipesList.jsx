import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRecipes, createRecipe, getLocations, getRecipesCategories, getSquareSkus } from '../api';

const STATUS_BADGE = { active: 'badge-active', seasonal: 'badge-seasonal', retired: 'badge-retired' };

function fmt(price) {
  if (price == null) return null;
  return `$${parseFloat(price).toFixed(2)}`;
}

function NewRecipeModal({ locations, categories, onCreate, onClose }) {
  const [name, setName]     = useState('');
  const [category, setCat]  = useState('');
  const [status, setStatus] = useState('active');
  const [locs, setLocs]     = useState([]);
  const [menuTitle, setMenuTitle] = useState('');
  const [menuDesc, setMenuDesc]   = useState('');
  const [sku, setSku]             = useState('');
  const [skus, setSkus]           = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => { getSquareSkus().then((d) => setSkus(d.skus || [])).catch(() => {}); }, []);

  const toggle = (id) => setLocs((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim())      { setError('Name is required'); return; }
    if (!menuTitle.trim()) { setError('Menu title is required'); return; }
    if (!menuDesc.trim())  { setError('Menu description is required'); return; }
    if (!sku.trim())       { setError('Square SKU is required'); return; }
    setSaving(true);
    setError('');
    try {
      const r = await createRecipe({
        name: name.trim(), category: category || null, status, location_ids: locs,
        menu_title: menuTitle.trim(), menu_description: menuDesc.trim(), square_sku: sku.trim(),
      });
      onCreate(r.recipe.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New Recipe</h3>
        {error && <p className="recipes-error">{error}</p>}
        <form onSubmit={handleSave}>
          <div className="form-group" style={{ marginBottom: '0.75rem' }}>
            <label>Name *</label>
            <input type="text" placeholder="Margherita Pizza" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="form-group" style={{ marginBottom: '0.75rem' }}>
            <label>Menu title *</label>
            <input type="text" placeholder="What guests see on the menu" value={menuTitle}
                   onChange={(e) => setMenuTitle(e.target.value)} required />
          </div>
          <div className="form-group" style={{ marginBottom: '0.75rem' }}>
            <label>Menu description *</label>
            <textarea placeholder="1–3 short sentences" value={menuDesc}
                      onChange={(e) => setMenuDesc(e.target.value)} required style={{ minHeight: 70 }} />
            <small style={{ color: '#777' }}>
              Add ingredients after creating, then use ✨ Generate on the recipe to rewrite this from them.
            </small>
          </div>
          <div className="form-group" style={{ marginBottom: '0.75rem' }}>
            <label>Square SKU *</label>
            <input type="text" list="square-sku-options" placeholder="Pick or type a SKU" value={sku}
                   onChange={(e) => setSku(e.target.value)} required />
            <datalist id="square-sku-options">
              {skus.filter((s2) => !s2.claimedByRecipe).map((s2) => (
                <option key={s2.sku} value={s2.sku}>{s2.label}</option>
              ))}
            </datalist>
            {skus.find((s2) => s2.sku === sku.trim())?.claimedByRecipe && (
              <small style={{ color: '#b3261e' }}>
                Already used by "{skus.find((s2) => s2.sku === sku.trim()).claimedByRecipe}".
              </small>
            )}
          </div>
          <div className="form-group" style={{ marginBottom: '0.75rem' }}>
            <label>Category</label>
            <select value={category} onChange={(e) => setCat(e.target.value)}>
              <option value="">— Select —</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: '0.75rem' }}>
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option>
              <option value="seasonal">Seasonal</option>
              <option value="retired">Retired</option>
            </select>
          </div>
          {locations.length > 0 && (
            <div className="form-group" style={{ marginBottom: '1rem' }}>
              <label>Locations</label>
              <div className="location-checkboxes">
                {locations.map((l) => (
                  <label key={l.id}>
                    <input type="checkbox" checked={locs.includes(l.id)} onChange={() => toggle(l.id)} />
                    {l.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="modal-footer">
            <button type="button" className="btn-sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create & Edit'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function RecipesList() {
  const navigate                    = useNavigate();
  const [recipes, setRecipes]       = useState([]);
  const [locations, setLocations]   = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [filterCat, setFilterCat]   = useState('');
  const [filterLoc, setFilterLoc]   = useState('');
  const [filterStatus, setFilterStatus] = useState('active');
  const [showNew, setShowNew]       = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = {};
      if (filterCat)    params.category    = filterCat;
      if (filterLoc)    params.location_id = filterLoc;
      if (filterStatus) params.status      = filterStatus;
      const [recipesRes, locsRes, catsRes] = await Promise.all([
        getRecipes(params),
        getLocations(),
        getRecipesCategories(),
      ]);
      setRecipes(recipesRes.recipes || []);
      setLocations(locsRes.locations || []);
      setCategories(catsRes.categories || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filterCat, filterLoc, filterStatus]);

  useEffect(() => { load(); }, [load]);

  // Group by category
  const grouped = recipes.reduce((acc, r) => {
    const cat = r.category || 'Uncategorized';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(r);
    return acc;
  }, {});

  return (
    <div>
      <div className="recipes-toolbar">
        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="seasonal">Seasonal</option>
          <option value="retired">Retired</option>
        </select>
        {locations.length > 0 && (
          <select value={filterLoc} onChange={(e) => setFilterLoc(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        <button className="btn-primary" onClick={() => setShowNew(true)}>+ New Recipe</button>
      </div>

      {error && <p className="recipes-error">{error}</p>}

      {loading ? (
        <p style={{ color: 'var(--text-muted,#888)', fontSize: '0.875rem' }}>Loading…</p>
      ) : recipes.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: '2.5rem' }}>🍕</div>
          <p>No recipes yet. Click <strong>+ New Recipe</strong> to get started.</p>
        </div>
      ) : (
        Object.entries(grouped).map(([cat, items]) => (
          <div key={cat}>
            <h2 className="recipe-category-header">{cat}</h2>
            <div className="recipes-grid">
              {items.map((r) => (
                <div key={r.id} className="recipe-card" onClick={() => navigate(`/recipes/${r.id}`)}>
                  {r.photo_path ? (
                    <img className="recipe-card-photo" src={r.photo_path} alt={r.name} />
                  ) : (
                    <div className="recipe-card-no-photo">🍽️</div>
                  )}
                  <div className="recipe-card-body">
                    <p className="recipe-card-name">{r.name}</p>
                    <div className="recipe-card-meta">
                      <span className={`badge ${STATUS_BADGE[r.status] || 'badge-pending'}`}>{r.status}</span>
                      {r.prep_time_minutes && <span>⏱ {r.prep_time_minutes} min</span>}
                      {fmt(r.menu_price) && <span>{fmt(r.menu_price)}</span>}
                      {r.ingredient_count > 0 && <span>{r.ingredient_count} ingredient{r.ingredient_count !== 1 ? 's' : ''}</span>}
                      {r.location_names?.length > 0 && <span>{r.location_names.join(', ')}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {showNew && (
        <NewRecipeModal
          locations={locations}
          categories={categories}
          onCreate={(id) => { setShowNew(false); navigate(`/recipes/${id}`); }}
          onClose={() => setShowNew(false)}
        />
      )}
    </div>
  );
}
