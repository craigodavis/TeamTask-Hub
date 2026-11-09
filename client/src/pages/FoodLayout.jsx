import React from 'react';
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { can } from '../utils/can';
import './FoodLayout.css';

export function FoodLayout() {
  const outletContext = useOutletContext();
  const { user } = outletContext || {};
  const location = useLocation();
  // Capabilities, not roles. These were the last two client gates reading
  // user.role, and the `inventory` one mattered: the two inventory-role users
  // became plain members when the legacy roles were retired, so a role check
  // here would have quietly taken Shopping Lists away from Tristan and Zoe.
  //
  // Both mirror what is already enforced elsewhere rather than inventing a
  // rule: App.jsx gates /food/lists on kitchen.inventory, and the server gates
  // writing waste items on kitchen.ingredients (routes/foodWaste.js).
  const canAccessInventory = can(user, 'kitchen.inventory');
  const canEditWasteItems = can(user, 'kitchen.ingredients');
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
        {canEditWasteItems && (
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
