import React, { useState } from 'react';
import { createIngredient, updateIngredient, deleteIngredient } from '../api';

export function IngredientForm({ onCreated }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      await createIngredient(name.trim());
      setName('');
      onCreated();
    } finally {
      setLoading(false);
    }
  };
  return (
    <form onSubmit={submit} className="form-inline">
      <input placeholder="Ingredient name" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" disabled={loading}>Add ingredient</button>
    </form>
  );
}

export function IngredientRow({ ingredient, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ingredient.name);
  const [loading, setLoading] = useState(false);

  const handleSave = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await updateIngredient(ingredient.id, name);
      setEditing(false);
      onUpdate();
    } catch (e) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete ingredient "${ingredient.name}"?`)) return;
    try {
      await deleteIngredient(ingredient.id);
      onUpdate();
    } catch (e) {
      alert(e.message);
    }
  };

  if (editing) {
    return (
      <li>
        <form onSubmit={handleSave} className="form-inline">
          <input value={name} onChange={(e) => setName(e.target.value)} required />
          <button type="submit" disabled={loading}>Save</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      </li>
    );
  }
  return (
    <li>
      {ingredient.name}
      <button type="button" className="btn-small" onClick={() => setEditing(true)}>Edit</button>
      <button type="button" className="btn-remove btn-small" onClick={handleDelete}>Delete</button>
    </li>
  );
}
