import React from 'react';
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom';
import './FoodLayout.css';

export function FoodLayout() {
  const outletContext = useOutletContext();
  const { user } = outletContext || {};
  const location = useLocation();
  const isManager = user?.role === 'manager' || user?.role === 'owner';
  const canAccessInventory = user?.role === 'inventory' || isManager;
  const wasteActive = location.pathname.startsWith('/food/waste');

  return (
    <div className="food-layout">
      <h1 className="food-layout-title">Shopping</h1>
      <nav className="food-layout-tabs" aria-label="Shopping sections">
        {canAccessInventory && (
          <NavLink
            to="/food/lists"
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            Shopping Lists
          </NavLink>
        )}
        <NavLink
          to="/food/waste"
          className={() => (wasteActive ? 'active' : '')}
        >
          Food Waste
        </NavLink>
        {isManager && (
          <NavLink
            to="/food/ingredients"
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            Waste Items
          </NavLink>
        )}
      </nav>
      <Outlet context={outletContext} />
    </div>
  );
}
