import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { landingFor } from '../lib/apps';
import './AppSwitcher.css';

/**
 * The hamburger, top left. It switches APPS, not pages.
 *
 * That distinction is the whole design: the nav below the header belongs to
 * whichever app you are in, so the corner can hold the switcher without
 * stealing the navigation. It also means the control behaves identically on a
 * phone and on a desktop, which is unusual for a hamburger and is the point --
 * one idea, two layouts.
 *
 * Picking an app NAVIGATES rather than setting state. The shell then reads the
 * app back off the URL, so a pasted link lands in the right app with the right
 * menu and there is no "current app" that can disagree with what is on screen.
 *
 * Somebody who holds one app gets no button at all. That is 15 of 22 people
 * here, and it is the single most valuable thing the split buys them: not a
 * greyed-out control, not a menu with one entry -- nothing.
 */
export function AppSwitcher({ apps, current, user, can, isOwner }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const wrapRef = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
    };
    // Pointer rather than click: a mousedown outside should dismiss before the
    // thing underneath gets its click, or you close the panel and activate
    // whatever happened to be behind it.
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  // One app, or none: no switcher. Still render the app's name so the header
  // says where you are.
  if (apps.length <= 1) {
    return (
      <div className="app-switcher app-switcher-static">
        {current && <span className="app-switcher-dot" aria-hidden="true" />}
        <span className="app-switcher-name">{current ? current.name : 'Team Hub'}</span>
      </div>
    );
  }

  const go = (app) => {
    setOpen(false);
    navigate(landingFor(app, user, can, isOwner));
  };

  return (
    <div className="app-switcher" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="app-switcher-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={current ? `Switch app — currently ${current.name}` : 'Switch app'}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        {current && <span className="app-switcher-dot" aria-hidden="true" />}
        <span className="app-switcher-name">{current ? current.name : 'Team Hub'}</span>
        <svg className="app-switcher-chev" width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
             aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <>
          <div className="app-switcher-scrim" aria-hidden="true" />
          <div className="app-switcher-panel" role="menu" aria-label="Apps">
            <div className="app-switcher-grip" aria-hidden="true" />
            <p className="app-switcher-heading">Your apps</p>
            <div className="app-switcher-grid">
              {apps.map(({ app }) => {
                const on = current?.id === app.id;
                return (
                  <button
                    key={app.id}
                    type="button"
                    role="menuitem"
                    className={`app-switcher-card${on ? ' is-current' : ''}`}
                    style={{ '--app-accent-light': app.color[0], '--app-accent-dark': app.color[1] }}
                    aria-current={on ? 'true' : undefined}
                    onClick={() => go(app)}
                  >
                    <span className="app-switcher-card-icon" aria-hidden="true">
                      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                        <path d={app.icon} />
                      </svg>
                    </span>
                    <span className="app-switcher-card-text">
                      <span className="app-switcher-card-name">{app.name}</span>
                      <span className="app-switcher-card-blurb">{app.blurb}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="app-switcher-foot">
              Apps appear here because of what you are granted — there is no separate switch.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
