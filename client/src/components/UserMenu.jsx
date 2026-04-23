import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import './UserMenu.css';

/**
 * @param {object} props
 * @param {object} props.user
 * @param {() => void} props.onLogout
 * @param {boolean} [props.compact] - Manager shell: only Users & Roles, Settings, Log out (no Dashboard/Manage links).
 */
export function UserMenu({ user, onLogout, compact = false }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const navigate = useNavigate();

  const isManager = user?.role === 'manager' || user?.role === 'owner';
  const isOwner = user?.role === 'owner';
  const label = user?.display_name?.trim() || user?.email || 'Account';

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="user-menu" ref={wrapRef}>
      <button
        type="button"
        className="user-menu-trigger"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-menu-label">{label}</span>
        <span className="user-menu-chevron" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="user-menu-dropdown" role="menu">
          {!compact && (
            <>
              <Link to="/" className="user-menu-item" role="menuitem" onClick={close}>
                Dashboard
              </Link>
              {isManager && (
                <Link to="/manage" className="user-menu-item" role="menuitem" onClick={close}>
                  Manage
                </Link>
              )}
            </>
          )}
          {isManager && (
            <button
              type="button"
              className="user-menu-item"
              role="menuitem"
              onClick={() => {
                navigate('/manage?tab=users');
                close();
              }}
            >
              Users &amp; Roles
            </button>
          )}
          {isManager && (
            <Link to="/settings" className="user-menu-item" role="menuitem" onClick={close}>
              Settings
            </Link>
          )}
          <div className="user-menu-divider" />
          <button
            type="button"
            className="user-menu-item user-menu-item-danger"
            role="menuitem"
            onClick={() => {
              close();
              onLogout();
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
