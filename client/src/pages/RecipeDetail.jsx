import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getRecipe, updateRecipe, deleteRecipe, uploadRecipePhoto,
  putRecipeIngredients, getRecipesIngredients, getLocations, getRecipesCategories,
} from '../api';

const UNITS = ['g', 'oz', 'ml', 'each', 'lb', 'kg'];
const STATUS_OPTIONS = ['active', 'seasonal', 'retired'];

function fmt(n) {
  if (n == null || isNaN(parseFloat(n))) return null;
  return `$${parseFloat(n).toFixed(2)}`;
}

function CogsTable({ ingredients }) {
  const rows = ingredients.filter((i) => i.cogs_contribution != null);
  if (rows.length === 0) return (
    <p style={{ color: 'var(--text-muted,#888)', fontSize: '0.85rem', margin: '0.5rem 0' }}>
      COGS requires receipt line items with a weight unit (lb/oz/g) and a linked primary source in the ingredient catalog.
    </p>
  );
  const total = rows.reduce((s, i) => s + parseFloat(i.cogs_contribution), 0);
  return (
    <table className="cogs-table">
      <thead>
        <tr>
          <th>Ingredient</th>
          <th style={{ textAlign: 'right' }}>Qty</th>
          <th style={{ textAlign: 'right' }}>Container (g)</th>
          <th style={{ textAlign: 'right' }}>Price/container</th>
          <th style={{ textAlign: 'right' }}>Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((i) => (
          <tr key={i.id}>
            <td>{i.ingredient_name}</td>
            <td style={{ textAlign: 'right' }}>{i.quantity} {i.unit || ''}</td>
            <td style={{ textAlign: 'right' }}>
              {i.container_grams != null
                ? `${parseFloat(i.container_grams).toLocaleString(undefined, { maximumFractionDigits: 0 })}g`
                : '—'}
            </td>
            <td style={{ textAlign: 'right' }}>{fmt(i.source_last_price) || '—'}</td>
            <td style={{ textAlign: 'right' }}><strong>{fmt(i.cogs_contribution)}</strong></td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={4} style={{ textAlign: 'right', fontWeight: 700, paddingTop: '0.5rem' }}>Total COGS</td>
          <td style={{ textAlign: 'right', fontWeight: 700, paddingTop: '0.5rem' }}>{fmt(total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

export function RecipeDetail() {
  const { id }     = useParams();
  const navigate   = useNavigate();
  const photoInput = useRef(null);

  const [recipe, setRecipe]           = useState(null);
  const [allIngredients, setAllIngr]  = useState([]);
  const [allLocations, setAllLocs]    = useState([]);
  const [categories, setCategories]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [photoUploading, setPhotoUp]  = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');

  // Form state
  const [name, setName]             = useState('');
  const [category, setCat]          = useState('');
  const [description, setDesc]      = useState('');
  const [instructions, setInstr]    = useState('');
  const [prepTime, setPrepTime]     = useState('');
  const [status, setStatus]         = useState('active');
  const [menuPrice, setMenuPrice]   = useState('');
  const [locationIds, setLocIds]    = useState([]);
  const [ingredients, setIngr]      = useState([]);
  const [addIngId, setAddIngId]     = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [recipeRes, allIngrRes, locsRes, catsRes] = await Promise.all([
        getRecipe(id),
        getRecipesIngredients(),
        getLocations(),
        getRecipesCategories(),
      ]);
      const r = recipeRes.recipe;
      setRecipe(r);
      setName(r.name || '');
      setCat(r.category || '');
      setDesc(r.description || '');
      setInstr(r.instructions || '');
      setPrepTime(r.prep_time_minutes ?? '');
      setStatus(r.status || 'active');
      setMenuPrice(r.menu_price ?? '');
      setLocIds(r.location_ids || []);
      setIngr(r.ingredients || []);
      setAllIngr((allIngrRes.ingredients || []).filter((i) => i.is_active !== false));
      setAllLocs(locsRes.locations || []);
      setCategories(catsRes.categories || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const flash = (msg) => { setSuccess(msg); setTimeout(() => setSuccess(''), 2500); };

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError('');
    try {
      await updateRecipe(id, {
        name: name.trim(),
        category: category || null,
        description: description || null,
        instructions: instructions || null,
        prep_time_minutes: prepTime !== '' ? parseInt(prepTime, 10) : null,
        status,
        menu_price: menuPrice !== '' ? parseFloat(menuPrice) : null,
        location_ids: locationIds,
      });
      await putRecipeIngredients(id, ingredients.map((i, idx) => ({
        ingredient_id: i.ingredient_id,
        quantity: i.quantity,
        unit: i.unit || null,
        note: i.note || null,
        position: idx,
      })));
      flash('Saved');
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete recipe "${name}"?`)) return;
    try {
      await deleteRecipe(id);
      navigate('/recipes/list');
    } catch (e) {
      setError(e.message);
    }
  };

  const handlePhotoChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoUp(true);
    try {
      await uploadRecipePhoto(id, file);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setPhotoUp(false);
      if (photoInput.current) photoInput.current.value = '';
    }
  };

  const toggleLoc = (lid) => setLocIds((prev) => prev.includes(lid) ? prev.filter((x) => x !== lid) : [...prev, lid]);

  const addIngredient = () => {
    if (!addIngId) return;
    const ing = allIngredients.find((i) => i.id === addIngId);
    if (!ing) return;
    setIngr((prev) => [...prev, { ingredient_id: ing.id, ingredient_name: ing.name, base_unit: ing.base_unit, quantity: 1, unit: ing.base_unit || 'g', note: '', cogs_contribution: null }]);
    setAddIngId('');
  };

  const removeIngredient = (idx) => setIngr((prev) => prev.filter((_, i) => i !== idx));

  const updateIngredientField = (idx, field, val) => {
    setIngr((prev) => prev.map((row, i) => i === idx ? { ...row, [field]: val } : row));
  };

  if (loading) return <p style={{ color: 'var(--text-muted,#888)', padding: '1rem' }}>Loading…</p>;
  if (!recipe && error) return <p className="recipes-error" style={{ padding: '1rem' }}>{error}</p>;

  const usedIngIds = new Set(ingredients.map((i) => i.ingredient_id));
  const availableIngr = allIngredients.filter((i) => !usedIngIds.has(i.id));

  return (
    <div className="recipe-detail">
      <div className="recipe-detail-header">
        <button className="btn-sm" onClick={() => navigate('/recipes/list')}>← Back</button>
        <h2>{name || 'Untitled Recipe'}</h2>
        <span className={`badge ${status === 'active' ? 'badge-active' : status === 'seasonal' ? 'badge-seasonal' : 'badge-retired'}`}>{status}</span>
      </div>

      {error   && <p className="recipes-error">{error}</p>}
      {success && <p className="recipes-success">{success}</p>}

      {/* Photo */}
      <div style={{ marginBottom: '1.25rem' }}>
        {recipe.photo_path ? (
          <img className="recipe-photo-preview" src={recipe.photo_path} alt={name} />
        ) : null}
        <div
          className="photo-upload-area"
          onClick={() => photoInput.current?.click()}
          style={{ marginTop: recipe.photo_path ? '0.5rem' : 0 }}
        >
          {photoUploading ? 'Uploading…' : recipe.photo_path ? '📷 Replace photo' : '📷 Add photo (click to upload)'}
        </div>
        <input ref={photoInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoChange} />
      </div>

      {/* Main fields */}
      <div className="recipe-form-grid" style={{ marginBottom: '1.25rem' }}>
        <div className="form-group recipe-form-full">
          <label>Recipe name *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Category</label>
          <select value={category} onChange={(e) => setCat(e.target.value)}>
            <option value="">— None —</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Prep time (minutes)</label>
          <input type="number" min="0" value={prepTime} onChange={(e) => setPrepTime(e.target.value)} placeholder="e.g. 30" />
        </div>
        <div className="form-group">
          <label>Menu price</label>
          <input type="number" min="0" step="0.01" value={menuPrice} onChange={(e) => setMenuPrice(e.target.value)} placeholder="e.g. 18.00" />
        </div>
        <div className="form-group recipe-form-full">
          <label>Description</label>
          <input type="text" value={description} onChange={(e) => setDesc(e.target.value)} placeholder="Short description for menu display" />
        </div>
        <div className="form-group recipe-form-full">
          <label>Cooking instructions</label>
          <textarea value={instructions} onChange={(e) => setInstr(e.target.value)} placeholder="Step-by-step instructions…" style={{ minHeight: 160 }} />
        </div>
      </div>

      {/* Locations */}
      {allLocations.length > 0 && (
        <div className="form-group" style={{ marginBottom: '1.25rem' }}>
          <label>Locations</label>
          <div className="location-checkboxes">
            {allLocations.map((l) => (
              <label key={l.id}>
                <input type="checkbox" checked={locationIds.includes(l.id)} onChange={() => toggleLoc(l.id)} />
                {l.name}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Ingredients */}
      <div style={{ marginBottom: '1.25rem' }}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Ingredients</h3>
        {ingredients.length === 0 ? (
          <p style={{ color: 'var(--text-muted,#888)', fontSize: '0.875rem' }}>No ingredients added yet.</p>
        ) : (
          <div>
            {ingredients.map((ing, idx) => (
              <div key={`${ing.ingredient_id}-${idx}`} className="ingredient-line">
                <span className="ingredient-line-name">{ing.ingredient_name}</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={ing.quantity}
                  onChange={(e) => updateIngredientField(idx, 'quantity', e.target.value)}
                  title="Quantity"
                />
                <select
                  value={ing.unit || ing.base_unit || 'g'}
                  onChange={(e) => updateIngredientField(idx, 'unit', e.target.value)}
                >
                  {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
                <input
                  type="text"
                  placeholder="Note"
                  value={ing.note || ''}
                  onChange={(e) => updateIngredientField(idx, 'note', e.target.value)}
                  style={{ width: 120 }}
                />
                <button className="btn-sm btn-danger" onClick={() => removeIngredient(idx)}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="ingredient-picker">
          <select value={addIngId} onChange={(e) => setAddIngId(e.target.value)}>
            <option value="">— Add ingredient —</option>
            {availableIngr.map((i) => (
              <option key={i.id} value={i.id}>{i.name}{i.base_unit ? ` (${i.base_unit})` : ''}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={addIngredient} disabled={!addIngId}>Add</button>
        </div>
      </div>

      {/* COGS */}
      {ingredients.length > 0 && (
        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>Cost of Goods (COGS)</h3>
          <CogsTable ingredients={recipe.ingredients || []} />
          {recipe.total_cogs != null && (
            <div className="cogs-total">
              Total COGS: <strong>{fmt(recipe.total_cogs)}</strong>
              {recipe.menu_price && parseFloat(recipe.menu_price) > 0 && (
                <span style={{ marginLeft: '1rem', fontSize: '0.85rem', color: 'var(--text-muted,#888)' }}>
                  ({Math.round((recipe.total_cogs / parseFloat(recipe.menu_price)) * 100)}% food cost)
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action bar */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Recipe'}
        </button>
        <button className="btn-sm btn-danger" onClick={handleDelete}>Delete Recipe</button>
      </div>
    </div>
  );
}
