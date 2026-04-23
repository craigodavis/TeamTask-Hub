import React, { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getFoodWasteEntry, getIngredients, addFoodWasteItem, updateFoodWasteEntry, getLocations } from '../api';
import './WasteEntry.css';

const GRAMS_UNIT = 'g';

export function WasteEntry() {
  const { entryId } = useParams();
  const [entry, setEntry] = useState(null);
  const [ingredients, setIngredients] = useState([]);
  const [locations, setLocations] = useState([]);
  const [editTitle, setEditTitle] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editLocationId, setEditLocationId] = useState('');
  const [selectedIngredient, setSelectedIngredient] = useState('');
  const [grams, setGrams] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [savingHeader, setSavingHeader] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [e, i, locs] = await Promise.all([
          getFoodWasteEntry(entryId),
          getIngredients(),
          getLocations().catch(() => ({ locations: [] })),
        ]);
        if (!cancelled) {
          setEntry(e);
          setEditTitle(e.title || 'Waste log');
          setEditDate(e.entry_date || new Date().toISOString().slice(0, 10));
          setEditLocationId(e.location_id || '');
          setIngredients(i.ingredients || []);
          setLocations(locs.locations || []);
          if ((i.ingredients || []).length > 0) setSelectedIngredient((i.ingredients || [])[0].id);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [entryId]);

  const handleSaveHeader = async (e) => {
    if (e) e.preventDefault();
    if (!entry) return;
    if (!editDate || !String(editDate).trim()) {
      setError('Date is required.');
      return;
    }
    const sameTitle = editTitle === (entry.title || '');
    const sameDate = editDate === (entry.entry_date || '');
    const sameLocation = (editLocationId || null) === (entry.location_id || null);
    if (sameTitle && sameDate && sameLocation) return;
    setError('');
    setSavingHeader(true);
    try {
      const body = { title: editTitle.trim() || 'Waste log', entry_date: editDate.trim() };
      if (locations.length > 0) body.location_id = editLocationId || null;
      await updateFoodWasteEntry(entryId, body);
      setEntry((prev) => prev ? { ...prev, title: body.title, entry_date: body.entry_date, location_id: body.location_id } : prev);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingHeader(false);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!selectedIngredient || grams === '' || grams === null || Number(grams) < 0) {
      setError('Select ingredient and enter amount (grams)');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await addFoodWasteItem(entryId, selectedIngredient, Number(grams), GRAMS_UNIT);
      const updated = await getFoodWasteEntry(entryId);
      setEntry(updated);
      setGrams('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="waste-entry-page"><p>Loading…</p></div>;
  if (!entry) return <div className="waste-entry-page"><p>Entry not found.</p><Link to="/food/waste">Back</Link></div>;

  const ingredientName = (id) => ingredients.find((i) => i.id === id)?.name || id;

  return (
    <div className="waste-entry-page">
      <header className="waste-entry-header">
        <Link to="/food/waste">← Food waste</Link>
        <form onSubmit={handleSaveHeader} className="waste-entry-title-row">
          <label className="waste-entry-title-label">
            Name
            <input
              type="text"
              className="waste-entry-title-input"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Waste log"
            />
          </label>
          <label className="waste-entry-date-label">
            Date <span className="required">*</span>
            <input
              type="date"
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              required
            />
          </label>
          {locations.length > 0 && (
            <label className="waste-entry-location-label">
              Location
              <select
                value={editLocationId}
                onChange={(e) => setEditLocationId(e.target.value)}
              >
                <option value="">—</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>{loc.name}</option>
                ))}
              </select>
            </label>
          )}
          <button type="submit" className="waste-entry-save-header" disabled={savingHeader}>
            {savingHeader ? 'Saving…' : 'Save header'}
          </button>
        </form>
      </header>
      {error && <p className="waste-entry-error">{error}</p>}

      <section className="waste-entry-detail">
        <h2>Waste logged</h2>
        <ul className="waste-items">
          {entry.items?.map((item) => (
            <li key={item.id}>
              {ingredientName(item.ingredient_id)}: {item.quantity} g – {item.discarded_by_name || 'Unknown'} @ {item.discarded_at ? new Date(item.discarded_at).toLocaleString() : ''}
            </li>
          ))}
        </ul>
        {(!entry.items || entry.items.length === 0) && <p className="empty">No waste logged yet. Add items below.</p>}
      </section>

      <section className="waste-entry-add">
        <h2>Add waste</h2>
        <form onSubmit={handleAdd} className="waste-add-form">
          <label>
            Ingredient
            <select value={selectedIngredient} onChange={(e) => setSelectedIngredient(e.target.value)}>
              {ingredients.length === 0 ? (
                <option value="">No ingredients – a manager adds them under Food → Ingredients</option>
              ) : (
                ingredients.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))
              )}
            </select>
          </label>
          <label>
            Amount (grams)
            <input
              type="number"
              step="1"
              min="0"
              value={grams}
              onChange={(e) => setGrams(e.target.value)}
              placeholder="e.g. 150"
            />
          </label>
          <button type="submit" disabled={submitting || ingredients.length === 0}>Add waste</button>
        </form>
      </section>
    </div>
  );
}
