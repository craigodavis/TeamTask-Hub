import React from 'react';
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom';
import './FoodLayout.css';

export function FoodLayout() {
  const outletContext = useOutletContext();
  const { user } = outletContext || {};
  const location = useLocation();
  const isManager = user?.role === 'manager' || user?.role === 'owner';
  const wasteActive = location.pathname.startsWith('/food/waste');

  return (
    <div className="food-layout">
      <h1 className="food-layout-title">Food</h1>
      <nav className="food-layout-tabs" aria-label="Food sections">
        {isManager && (
          <NavLink
            to="/food/ingredients"
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            Ingredients
          </NavLink>
        )}
        <NavLink
          to="/food/waste"
          className={() => (wasteActive ? 'active' : '')}
        >
          Food Waste
        </NavLink>
      </nav>
      <Outlet context={outletContext} />
    </div>
  );
}
