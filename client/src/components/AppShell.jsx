import React, { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
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

export function AppShell({ user, onLogout, children }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true'
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false');
  }, [collapsed]);

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
          <NavLink
            to="/"
            end
            className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
            data-icon="🏠"
            title="Dashboard"
          >
            <span>Dashboard</span>
          </NavLink>
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
          {isOwner && (
            <NavLink
              to="/quickbooks"
              className={({ isActive }) => `app-shell-nav-item${isActive ? ' active' : ''}`}
              data-icon="📒"
              title="QuickBooks"
            >
              <span>QuickBooks</span>
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
