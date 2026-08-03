import React, { useState, useEffect } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { UserMenu } from './UserMenu';
import { appHubTitle } from '../appHubTitle';
import './AppShell.css';

const STORAGE_KEY = 'teamtask_sidebar_collapsed';

function isManageTabActive(location, tab) {
  if (location.pathname !== '/manage') return false;
  const t = new URLSearchParams(location.search).get('tab');
  if (tab === 'announcements') return !t || t === 'announcements';
  return t === tab;
}

// Any route that lives under the Kitchen parent menu.
function isKitchenPath(pathname) {
  return pathname.startsWith('/food')
    || pathname.startsWith('/recipes')
    || pathname.startsWith('/kitchen')
    || pathname.startsWith('/quickbooks');
}

// Any route that lives under the Wine parent menu.
function isWinePath(pathname) {
  return pathname.startsWith('/products');
}

// Any route that lives under the Marketing parent menu. Events keeps its
// top-level /events path but is presented under Marketing, so it counts here.
function isMarketingPath(pathname) {
  return pathname.startsWith('/marketing') || pathname.startsWith('/events');
}

export function AppShell({ user, onLogout, children, emulateRole, setEmulateRole, availableRoles }) {
  const location = useLocation();
  const isMobile = () => typeof window !== 'undefined' && window.innerWidth <= 640;

  const [dashboardExpanded, setDashboardExpanded] = useState(false);
  const [kitchenExpanded, setKitchenExpanded] = useState(() => isKitchenPath(location.pathname));
  const [wineExpanded, setWineExpanded] = useState(() => isWinePath(location.pathname));
  const [marketingExpanded, setMarketingExpanded] = useState(() => isMarketingPath(location.pathname));

  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (isMobile()) return true; // always start hidden on mobile
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });

  useEffect(() => {
    if (!isMobile()) {
      localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false');
    }
  }, [collapsed]);

  // Auto-close menu on mobile when navigating
  useEffect(() => {
    if (isMobile()) setCollapsed(true);
  }, [location.pathname, location.search]);

  const isManager = user?.role === 'manager' || user?.role === 'owner';
  const isOwner = user?.role === 'owner';
  const canAccessGC = user?.role === 'gc' || user?.role === 'manager' || user?.role === 'owner';
  const canAccessInventory = user?.role === 'inventory' || isManager;
  const canAccessSchedule = user?.role === 'schedule' || isManager;
  const appTitle = appHubTitle(user);

  const managerLinks = isManager
    ? [
        { to: '/manage?tab=reports', label: 'Reports', icon: '📊', tab: 'reports' },
        { to: '/manage?tab=integrations', label: 'SMS Send', icon: '💬', tab: 'integrations' },
      ]
    : [];

  return (
    <div className={`app-shell ${collapsed ? 'app-shell-collapsed' : ''}`}>
      <header className="app-shell-header">
        <div className="app-shell-header-left">
          <button
            type="button"
            className="app-shell-sidebar-toggle"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Expand menu' : 'Collapse menu'}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            ☰
          </button>
        </div>
        <h1 className="app-shell-title">{appTitle}</h1>
        <div className="app-shell-header-right">
          <UserMenu user={user} onLogout={onLogout} />
        </div>
      </header>

      <div className="app-shell-body">
        <nav className="app-shell-sidebar" id="app-sidebar" aria-label="Main navigation">
          {/* Dashboard + collapsible sub-items */}
          <div className="nav-item-row">
            <NavLink
              to="/"
              end
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="🏠"
              title="Tasks"
            >
              <span>Tasks</span>
            </NavLink>
            {isManager && (
              <button
                type="button"
                className="nav-sub-chevron"
                onClick={() => setDashboardExpanded((v) => !v)}
                aria-expanded={dashboardExpanded}
                aria-label={dashboardExpanded ? 'Collapse Tasks menu' : 'Expand Tasks menu'}
              >
                {dashboardExpanded ? '−' : '+'}
              </button>
            )}
          </div>
          {isManager && dashboardExpanded && (
            <div className="nav-sub-group">
              <Link
                to="/manage?tab=tasks"
                className={`nav-sub-item${location.pathname === '/manage' && new URLSearchParams(location.search).get('tab') === 'tasks' ? ' active' : ''}`}
                onClick={() => { if (isMobile()) setCollapsed(true); }}
              >
                <span className="nav-sub-icon">✓</span>
                <span>Manage Tasks</span>
              </Link>
            </div>
          )}
          {isManager && (
            <NavLink
              to="/manage?tab=announcements"
              className={() => `app-shell-nav-item${isManageTabActive(location, 'announcements') ? ' active' : ''}`}
              data-icon="📢"
              title="Announcements"
              onClick={() => { if (isMobile()) setCollapsed(true); }}
            >
              <span>Announcements</span>
            </NavLink>
          )}
          <NavLink
            to="/policies"
            className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
            data-icon="📋"
            title="Policies"
            onClick={() => { if (isMobile()) setCollapsed(true); }}
          >
            <span>Policies</span>
          </NavLink>
          {canAccessSchedule && (
            <NavLink
              to="/scheduling"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="📅"
              title="Scheduling"
              onClick={() => { if (isMobile()) setCollapsed(true); }}
            >
              <span>Scheduling</span>
            </NavLink>
          )}
          {isManager && (
            <NavLink
              to="/square"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="✨"
              title="Kindred AI"
            >
              <span>Kindred AI</span>
            </NavLink>
          )}
          {isManager && (
            <NavLink
              to="/kindred-app"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="🍷"
              title="Kindred App"
            >
              <span>Kindred App</span>
            </NavLink>
          )}
          {isManager && (
            <NavLink
              to="/skynet"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="🤖"
              title="Skynet"
            >
              <span>Skynet</span>
            </NavLink>
          )}
          {/* Kitchen — collapsible parent grouping Receipts, Item Catalog,
              Ingredients, Recipes and Shopping. Shopping is available to all
              roles; the manager-only items are gated individually below. */}
          {(isManager || canAccessSchedule) && (
            <>
              <div className="nav-item-row">
                <button
                  type="button"
                  className={`app-shell-nav-item${isMarketingPath(location.pathname) ? ' active' : ''}`}
                  data-icon="📣"
                  title="Marketing"
                  onClick={() => setMarketingExpanded((v) => !v)}
                  aria-expanded={marketingExpanded}
                >
                  <span>Marketing</span>
                </button>
                <button
                  type="button"
                  className="nav-sub-chevron"
                  onClick={() => setMarketingExpanded((v) => !v)}
                  aria-expanded={marketingExpanded}
                  aria-label={marketingExpanded ? 'Collapse Marketing menu' : 'Expand Marketing menu'}
                >
                  {marketingExpanded ? '−' : '+'}
                </button>
              </div>
              {marketingExpanded && (
                <div className="nav-sub-group">
                  {canAccessSchedule && (
                    <Link
                      to="/events"
                      className={`nav-sub-item${location.pathname.startsWith('/events') ? ' active' : ''}`}
                      onClick={() => { if (isMobile()) setCollapsed(true); }}
                    >
                      <span className="nav-sub-icon">🎪</span>
                      <span>Events</span>
                    </Link>
                  )}
                  {isManager && (
                  <>
                  <Link
                    to="/marketing/media"
                    className={`nav-sub-item${location.pathname.startsWith('/marketing/media') ? ' active' : ''}`}
                    onClick={() => { if (isMobile()) setCollapsed(true); }}
                  >
                    <span className="nav-sub-icon">🖼️</span>
                    <span>Website Media</span>
                  </Link>
                  <Link
                    to="/marketing/hours"
                    className={`nav-sub-item${location.pathname.startsWith('/marketing/hours') ? ' active' : ''}`}
                    onClick={() => { if (isMobile()) setCollapsed(true); }}
                  >
                    <span className="nav-sub-icon">🕒</span>
                    <span>Store Hours</span>
                  </Link>
                  <Link
                    to="/marketing/loyalty"
                    className={`nav-sub-item${location.pathname.startsWith('/marketing/loyalty') ? ' active' : ''}`}
                    onClick={() => { if (isMobile()) setCollapsed(true); }}
                  >
                    <span className="nav-sub-icon">★</span>
                    <span>Loyalty</span>
                  </Link>
                  <Link
                    to="/marketing/images"
                    className={`nav-sub-item${location.pathname.startsWith('/marketing/images') ? ' active' : ''}`}
                    onClick={() => { if (isMobile()) setCollapsed(true); }}
                  >
                    <span className="nav-sub-icon">🎞️</span>
                    <span>Website Images</span>
                  </Link>
                  <Link
                    to="/marketing/settings"
                    className={`nav-sub-item${location.pathname.startsWith('/marketing/settings') ? ' active' : ''}`}
                    onClick={() => { if (isMobile()) setCollapsed(true); }}
                  >
                    <span className="nav-sub-icon">⚙️</span>
                    <span>Website Settings</span>
                  </Link>
                  </>
                  )}
                </div>
              )}
            </>
          )}

          <div className="nav-item-row">
            <button
              type="button"
              className={`app-shell-nav-item${isKitchenPath(location.pathname) ? ' active' : ''}`}
              data-icon="🍳"
              title="Kitchen"
              onClick={() => setKitchenExpanded((v) => !v)}
              aria-expanded={kitchenExpanded}
            >
              <span>Kitchen</span>
            </button>
            <button
              type="button"
              className="nav-sub-chevron"
              onClick={() => setKitchenExpanded((v) => !v)}
              aria-expanded={kitchenExpanded}
              aria-label={kitchenExpanded ? 'Collapse Kitchen menu' : 'Expand Kitchen menu'}
            >
              {kitchenExpanded ? '−' : '+'}
            </button>
          </div>
          {kitchenExpanded && (
            <div className="nav-sub-group">
              {isManager && (
                <Link
                  to="/recipes/scan"
                  className={`nav-sub-item${location.pathname.startsWith('/recipes/scan') ? ' active' : ''}`}
                  onClick={() => { if (isMobile()) setCollapsed(true); }}
                >
                  <span className="nav-sub-icon">📸</span>
                  <span>Scan Receipt</span>
                </Link>
              )}
              {isManager && (
                <Link
                  to="/quickbooks"
                  className={`nav-sub-item${location.pathname === '/quickbooks' ? ' active' : ''}`}
                  onClick={() => { if (isMobile()) setCollapsed(true); }}
                >
                  <span className="nav-sub-icon">🧾</span>
                  <span>Receipts</span>
                </Link>
              )}
              {isOwner && (
                <Link
                  to="/kitchen/sources"
                  className={`nav-sub-item${location.pathname === '/kitchen/sources' ? ' active' : ''}`}
                  onClick={() => { if (isMobile()) setCollapsed(true); }}
                >
                  <span className="nav-sub-icon">📥</span>
                  <span>Receipt Sources</span>
                </Link>
              )}
              {isManager && (
                <Link
                  to="/recipes/catalog"
                  className={`nav-sub-item${location.pathname === '/recipes/catalog' ? ' active' : ''}`}
                  onClick={() => { if (isMobile()) setCollapsed(true); }}
                >
                  <span className="nav-sub-icon">📒</span>
                  <span>Item Catalog</span>
                </Link>
              )}
              {isManager && (
                <Link
                  to="/recipes/ingredients"
                  className={`nav-sub-item${location.pathname.startsWith('/recipes/ingredients') ? ' active' : ''}`}
                  onClick={() => { if (isMobile()) setCollapsed(true); }}
                >
                  <span className="nav-sub-icon">🧀</span>
                  <span>Ingredients</span>
                </Link>
              )}
              {canAccessInventory && (
                <Link
                  to="/kitchen/inventory"
                  className={`nav-sub-item${location.pathname.startsWith('/kitchen/inventory') ? ' active' : ''}`}
                  onClick={() => { if (isMobile()) setCollapsed(true); }}
                >
                  <span className="nav-sub-icon">📦</span>
                  <span>Inventory</span>
                </Link>
              )}
              {isManager && (
                <Link
                  to="/recipes/list"
                  className={`nav-sub-item${(location.pathname === '/recipes' || location.pathname === '/recipes/list' || (location.pathname.startsWith('/recipes/') && !location.pathname.startsWith('/recipes/catalog') && !location.pathname.startsWith('/recipes/ingredients') && !location.pathname.startsWith('/recipes/inventory'))) ? ' active' : ''}`}
                  onClick={() => { if (isMobile()) setCollapsed(true); }}
                >
                  <span className="nav-sub-icon">🍕</span>
                  <span>Recipes</span>
                </Link>
              )}
              <Link
                to="/food"
                className={`nav-sub-item${location.pathname.startsWith('/food') ? ' active' : ''}`}
                onClick={() => { if (isMobile()) setCollapsed(true); }}
              >
                <span className="nav-sub-icon">🛒</span>
                <span>Shopping</span>
              </Link>
            </div>
          )}
          {canAccessInventory && (
            <div className="nav-item-row">
              <button
                type="button"
                className={`app-shell-nav-item${isWinePath(location.pathname) ? ' active' : ''}`}
                data-icon="🍷"
                title="Wine"
                onClick={() => setWineExpanded((v) => !v)}
                aria-expanded={wineExpanded}
              >
                <span>Wine</span>
              </button>
              <button
                type="button"
                className="nav-sub-chevron"
                onClick={() => setWineExpanded((v) => !v)}
                aria-expanded={wineExpanded}
                aria-label={wineExpanded ? 'Collapse Wine menu' : 'Expand Wine menu'}
              >
                {wineExpanded ? '−' : '+'}
              </button>
            </div>
          )}
          {canAccessInventory && wineExpanded && (
            <div className="nav-sub-group">
              {isManager && (
                <Link
                  to="/products"
                  className={`nav-sub-item${location.pathname === '/products' ? ' active' : ''}`}
                  onClick={() => { if (isMobile()) setCollapsed(true); }}
                >
                  <span className="nav-sub-icon">🍇</span>
                  <span>Products</span>
                </Link>
              )}
              <Link
                to="/products/inventory"
                className={`nav-sub-item${location.pathname === '/products/inventory' ? ' active' : ''}`}
                onClick={() => { if (isMobile()) setCollapsed(true); }}
              >
                <span className="nav-sub-icon">📋</span>
                <span>Inventory</span>
              </Link>
              <Link
                to="/products/inventory/report"
                className={`nav-sub-item${location.pathname === '/products/inventory/report' ? ' active' : ''}`}
                onClick={() => { if (isMobile()) setCollapsed(true); }}
              >
                <span className="nav-sub-icon">📊</span>
                <span>Reports</span>
              </Link>
            </div>
          )}
          {isManager && (
            <NavLink
              to="/betty"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="📊"
              title="Betty Bookkeeper"
            >
              <span>Betty Bookkeeper</span>
            </NavLink>
          )}
          {isManager && (
            <NavLink
              to="/gateway"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="🔀"
              title="Gateway"
            >
              <span>Gateway</span>
            </NavLink>
          )}
          {canAccessGC && (
            <NavLink
              to="/ground-control"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="🌱"
              title="Ground Control"
            >
              <span>Ground Control</span>
            </NavLink>
          )}
          {managerLinks.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={() =>
                `app-shell-nav-item${isManageTabActive(location, item.tab) ? ' active' : ''}`
              }
              data-icon={item.icon}
              title={item.label}
            >
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <main className="app-shell-main">{children}</main>
      </div>
    </div>
  );
}
