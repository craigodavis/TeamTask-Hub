import React, { useState } from 'react';
import { squareGetTeamMembers, squareSyncUsers, setSquareUserExcluded } from '../api';
import '../pages/SyncUsers.css';

/** Square user exclusion management + sync trigger (used under Settings → Square). */
export function SquareUsersPanel() {
  const [teamMembers, setTeamMembers]     = useState([]);
  const [open, setOpen]                   = useState(false);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState('');
  const [message, setMessage]             = useState('');

  const loadMembers = async () => {
    setError('');
    setLoading(true);
    try {
      const r = await squareGetTeamMembers();
      setTeamMembers(r.team_members || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = async () => {
    setOpen(true);
    setMessage('');
    await loadMembers();
  };

  const handleExclude = async (id, excluded) => {
    setError('');
    setLoading(true);
    try {
      await setSquareUserExcluded(id, excluded);
      setMessage(excluded ? 'User excluded from auto-sync.' : 'User re-enabled for auto-sync.');
      await loadMembers();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    setError('');
    setLoading(true);
    try {
      const r = await squareSyncUsers();
      setMessage(`Sync: ${r.added || 0} added, ${r.updated} updated, ${r.removed} removed`);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="sync-users-section settings-square-panel">
      <p className="settings-intro">
        Square team members are automatically synced to TeamHub. Use the buttons below to run a
        manual sync or exclude specific users from auto-add.
      </p>

      {error   && <p className="sync-users-error">{error}</p>}
      {message && <p className="sync-users-message">{message}</p>}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" onClick={handleOpen} disabled={loading}>
          {loading && open ? 'Loading…' : 'Exclude Square Users'}
        </button>
        <button type="button" onClick={handleSync} disabled={loading} className="btn-sync">
          {loading && !open ? 'Syncing…' : 'Sync Now'}
        </button>
      </div>

      {open && (
        <div className="square-team-members">
          <h3>Square team members</h3>
          {teamMembers.length === 0 && !loading && (
            <p>No active team members found. Run a team member sync first.</p>
          )}
          <ul className="square-team-list">
            {teamMembers.map((tm) => {
              const displayName = [tm.given_name, tm.family_name].filter(Boolean).join(' ') || tm.email_address || '—';
              return (
                <li key={tm.id} className="square-team-row">
                  <span className="square-team-name">
                    {displayName}
                    {tm.email_address && ` (${tm.email_address})`}
                    {tm.phone_number  && ` · ${tm.phone_number}`}
                    {tm.excluded && <span className="square-team-badge-excluded">Excluded</span>}
                    {tm.already_in_system && !tm.excluded && (
                      <span className="square-team-status">In system</span>
                    )}
                  </span>
                  <label className="square-team-add">
                    <input
                      type="checkbox"
                      checked={!!tm.excluded}
                      disabled={loading}
                      onChange={(e) => handleExclude(tm.id, e.target.checked)}
                    />
                    Exclude from auto-add
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
