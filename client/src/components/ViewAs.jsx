import { useEffect, useState } from 'react';
import './ViewAs.css';

const REAL_TOKEN = 'teamtask_token_real';
const TOKEN = 'teamtask_token';

export const isViewingAs = () => Boolean(localStorage.getItem(REAL_TOKEN));

/** Put the owner back in their own session. */
export function exitViewAs() {
  const real = localStorage.getItem(REAL_TOKEN);
  if (real) {
    localStorage.setItem(TOKEN, real);
    localStorage.removeItem(REAL_TOKEN);
  }
  window.location.href = '/';
}

/**
 * Pick somebody and see the app as they see it.
 *
 * The owner's own token is kept aside rather than thrown away, so leaving is
 * one click and never a re-login. The session token the server hands back is
 * read-only and expires after thirty minutes.
 */
export function ViewAsPicker({ onClose }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/permissions/users', {
      headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN)}` },
    })
      .then((r) => r.json())
      .then((d) => setUsers(d.users || []))
      .catch((e) => setError(e.message));
  }, []);

  const start = async (u) => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/auth/view-as/${u.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem(TOKEN)}`,
        },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not start');
      // Keep the real one FIRST. If the swap were the other way round and the
      // page died between the two writes, the owner would be stranded in
      // somebody else's session with no way back.
      localStorage.setItem(REAL_TOKEN, localStorage.getItem(TOKEN));
      localStorage.setItem(TOKEN, d.token);
      window.location.href = '/';
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="va-backdrop" onClick={onClose}>
      <div className="va-modal" onClick={(e) => e.stopPropagation()}>
        <div className="va-head">
          <h2>View as…</h2>
          <button type="button" className="va-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="va-hint">
          See the whole app exactly as they see it — their menus, their tasks, their data.
          Read-only: nothing can be changed while you are looking. Ends after 30 minutes.
        </p>
        {error && <p className="va-error">{error}</p>}
        {users === null && <p className="va-empty">Loading…</p>}
        <div className="va-list">
          {(users || []).map((u) => (
            <button key={u.id} type="button" className="va-user" disabled={busy} onClick={() => start(u)}>
              <span className="va-name">{u.display_name || u.email}</span>
              <span className="va-role">{u.role}</span>
              <span className="va-caps">{u.capabilities.length} permissions</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Always-visible reminder that this is not your own account. */
export function ViewAsBanner({ user }) {
  if (!isViewingAs()) return null;
  return (
    <div className="va-banner" role="status">
      <span className="va-banner-text">
        Viewing as <strong>{user?.display_name || user?.email || 'another user'}</strong>
        <span className="va-banner-ro"> · read-only</span>
      </span>
      <button type="button" className="va-banner-exit" onClick={exitViewAs}>Exit</button>
    </div>
  );
}
