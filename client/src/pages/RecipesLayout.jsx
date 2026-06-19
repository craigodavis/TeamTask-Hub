import React from 'react';
import { Outlet, useOutletContext, useLocation } from 'react-router-dom';
import './Recipes.css';

// Item Catalog, Ingredients and Recipes are now separate items in the Kitchen
// left-nav, so this layout no longer renders a sub-tab bar — it just provides
// the routing/context wrapper and a heading that reflects the current section.
function sectionTitle(pathname) {
  if (pathname.startsWith('/recipes/scan'))        return 'Scan Receipt';
  if (pathname.startsWith('/recipes/catalog'))     return 'Item Catalog';
  if (pathname.startsWith('/recipes/ingredients')) return 'Ingredients';
  if (pathname.startsWith('/recipes/inventory'))   return 'Inventory';
  return 'Recipes';
}

export function RecipesLayout() {
  const outletContext = useOutletContext();
  const location = useLocation();
  return (
    <div className="recipes-layout">
      <h1 className="recipes-layout-title">{sectionTitle(location.pathname)}</h1>
      <Outlet context={outletContext} />
    </div>
  );
}
