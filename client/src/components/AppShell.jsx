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

export function AppShell({ user, onLogout, children, emulateRole, setEmulateRole, availableRoles }) {
  const location = useLocation();
  const isMobile = () => typeof window !== 'undefined' && window.innerWidth <= 640;

  const [dashboardExpanded, setDashboardExpanded] = useState(false);

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
              title="Dashboard"
            >
              <span>Dashboard</span>
            </NavLink>
            {isManager && (
              <button
                type="button"
                className="nav-sub-chevron"
                onClick={() => setDashboardExpanded((v) => !v)}
                aria-expanded={dashboardExpanded}
                aria-label={dashboardExpanded ? 'Collapse Dashboard menu' : 'Expand Dashboard menu'}
              >
                {dashboardExpanded ? '−' : '+'}
              </button>
            )}
          </div>
          {isManager && dashboardExpanded && (
            <div className="nav-sub-group">
              <Link
                to="/manage?tab=announcements"
                className={`nav-sub-item${location.pathname === '/manage' && new URLSearchParams(location.search).get('tab') === 'announcements' ? ' active' : ''}`}
                onClick={() => { if (isMobile()) setCollapsed(true); }}
              >
                <span className="nav-sub-icon">📢</span>
                <span>Announcements</span>
              </Link>
              <Link
                to="/manage?tab=tasks"
                className={`nav-sub-item${location.pathname === '/manage' && new URLSearchParams(location.search).get('tab') === 'tasks' ? ' active' : ''}`}
                onClick={() => { if (isMobile()) setCollapsed(true); }}
              >
                <span className="nav-sub-icon">✓</span>
                <span>Manage Tasks</span>
              </Link>
              <div className="nav-sub-item nav-view-as">
                <span className="nav-sub-icon">👁</span>
                <span className="nav-view-as-label">View As</span>
                {availableRoles && availableRoles.length > 0 && (
                  <div className="nav-role-pills">
                    <button
                      type="button"
                      className={`nav-role-pill${!emulateRole ? ' active' : ''}`}
                      onClick={() => setEmulateRole(null)}
                    >All</button>
                    {availableRoles.map((role) => (
                      <button
                        key={role}
                        type="button"
                        className={`nav-role-pill${emulateRole === role ? ' active' : ''}`}
                        onClick={() => setEmulateRole(role)}
                      >{role}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <NavLink
            to="/food"
            className={({ isActive }) =>
              `app-shell-nav-item${isActive || location.pathname.startsWith('/food') ? ' active' : ''}`
            }
            data-icon="🍽️"
            title="Food"
          >
            <span>Food</span>
          </NavLink>
          {isManager && (
            <NavLink
              to="/quickbooks"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="📒"
              title="QuickBooks"
            >
              <span>QuickBooks</span>
            </NavLink>
          )}
          {isManager && (
            <NavLink
              to="/square"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="◼"
              title="Square"
            >
              <span>Square</span>
            </NavLink>
          )}
          {isManager && (
            <NavLink
              to="/products"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="🍷"
              title="Products"
            >
              <span>Products</span>
            </NavLink>
          )}
          {isManager && (
            <NavLink
              to="/betty"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="📊"
              title="Betty vs Bookkeeper"
            >
              <span>Betty</span>
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
