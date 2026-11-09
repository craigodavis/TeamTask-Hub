import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { can, isOwner } from '../utils/can';
import { ViewAsBanner } from './ViewAs';
import { UserMenu } from './UserMenu';
import { AppSwitcher } from './AppSwitcher';
import { visibleApps, matchPath } from '../lib/apps';
import './AppShell.css';

const STORAGE_KEY = 'teamtask_sidebar_collapsed';

// Sun/moon theme toggle. Cycles the explicit theme and remembers it; the initial
// value is read before render in main.jsx so there's no flash.
function ThemeToggle() {
  const read = () => {
    try { return localStorage.getItem('teamhub_theme'); } catch { return null; }
  };
  const systemDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const [dark, setDark] = useState(() => { const t = read(); return t ? t === 'dark' : systemDark(); });
  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    setDark(!dark);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('teamhub_theme', next); } catch { /* ignore */ }
  };
  return (
    <button type="button" onClick={toggle} title={dark ? 'Switch to light' : 'Switch to dark'}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="app-shell-icon-btn">
      {dark
        ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" strokeLinecap="round" /></svg>
        : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" strokeLinejoin="round" /></svg>}
    </button>
  );
}

/**
 * The shell: a header with the app switcher, this app's nav, and the screen.
 *
 * What used to be here was ~600 lines of hand-written nested JSX plus six
 * `isKitchenPath`-style predicates, every one of which had to be remembered
 * separately whenever a screen was added. The nav now renders from
 * `lib/apps.js`, so a new screen is one entry in one list and the highlighting,
 * the grouping and the switcher all follow from it.
 *
 * Nothing here decides what anyone may reach. Every route keeps its own guard
 * in App.jsx and its own `requireCapability` on the server; this only chooses
 * what to draw. See docs/APPS.md.
 */
export function AppShell({ user, onLogout, children }) {
  const location = useLocation();
  const isMobile = () => typeof window !== 'undefined' && window.innerWidth <= 640;

  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (isMobile()) return false; // the phone nav is a bottom strip; nothing to collapse
    try { return localStorage.getItem(STORAGE_KEY) === 'true'; } catch { return false; }
  });

  useEffect(() => {
    if (!isMobile()) {
      try { localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false'); } catch { /* ignore */ }
    }
  }, [collapsed]);

  const apps = visibleApps(user, can, isOwner);
  const hit = matchPath(location.pathname, location.search);

  // The app in the switcher is the one that owns the URL. Where nothing claims
  // it -- a route added without an entry in lib/apps.js -- fall back to the
  // first app they hold rather than showing a blank header.
  const current = hit?.app || apps[0]?.app || null;
  const nav = current ? (apps.find((a) => a.app.id === current.id)?.nav || []) : [];

  const accent = current
    ? { '--app-accent-light': current.color[0], '--app-accent-dark': current.color[1] }
    : undefined;

  const isCurrentItem = (item) => hit?.item === item;

  return (
    <div
      className={`app-shell${collapsed ? ' app-shell-collapsed' : ''}`}
      style={accent}
      data-app={current?.id || 'none'}
    >
      <ViewAsBanner user={user} />

      <header className="app-shell-header">
        <AppSwitcher apps={apps} current={current} user={user} can={can} isOwner={isOwner} />
        <div className="app-shell-header-right">
          <ThemeToggle />
          <UserMenu user={user} onLogout={onLogout} />
        </div>
      </header>

      <div className="app-shell-body">
        {nav.length > 0 && (
          <nav
            className="app-nav"
            id="app-sidebar"
            aria-label={current ? `${current.name} sections` : 'Navigation'}
          >
            <div className="app-nav-items">
              {nav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={!!item.exact}
                  className={`app-nav-item${isCurrentItem(item) ? ' active' : ''}`}
                  aria-current={isCurrentItem(item) ? 'page' : undefined}
                  title={item.label}
                >
                  <svg className="app-nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"
                       strokeLinejoin="round" aria-hidden="true">
                    <path d={item.icon} />
                  </svg>
                  <span className="app-nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>

            {/* Desktop only. The phone nav is a bottom strip and has nothing to
                collapse into. */}
            <button
              type="button"
              className="app-nav-collapse"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              aria-controls="app-sidebar"
              title={collapsed ? 'Expand menu' : 'Collapse menu'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} />
              </svg>
              <span className="app-nav-label">Collapse</span>
            </button>
          </nav>
        )}

        <main className="app-shell-main">
          {apps.length === 0 ? (
            <div className="app-shell-empty">
              <h2>Nothing is set up for you yet</h2>
              <p>
                Your account has no sections assigned to it, so there is nothing to show.
                Ask Craig to set up your access and this will fill in.
              </p>
            </div>
          ) : children}
        </main>
      </div>
    </div>
  );
}
