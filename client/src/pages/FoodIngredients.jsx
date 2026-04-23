import React, { useState, useEffect } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import { getIngredients } from '../api';
import { IngredientForm, IngredientRow } from '../components/IngredientCrud';
import './Manager.css';

export function FoodIngredients() {
  const { user } = useOutletContext();
  const [ingredients, setIngredients] = useState([]);
  const [error, setError] = useState('');

  const isManager = user?.role === 'manager' || user?.role === 'owner';

  const loadIngredients = async () => {
    try {
      const r = await getIngredients();
      setIngredients(r.ingredients || []);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    if (isManager) loadIngredients();
  }, [isManager]);

  if (!isManager) {
    return <Navigate to="/food/waste" replace />;
  }

  return (
    <section className="manager-section">
      <h2>Ingredients</h2>
      {error && <p className="manager-error">{error}</p>}
      <p className="hint">Create ingredients here. Everyone can log food waste using these under Food → Food Waste.</p>
      <IngredientForm onCreated={loadIngredients} />
      <ul className="ingredient-list">
        {ingredients.map((i) => (
          <IngredientRow key={i.id} ingredient={i} onUpdate={loadIngredients} />
        ))}
      </ul>
    </section>
  );
}
