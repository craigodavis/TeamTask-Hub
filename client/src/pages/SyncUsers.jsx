import React, { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { squareSync, squareAddUsers, squareSyncUsers, setSquareUserExcluded } from '../api';
import './SyncUsers.css';

export function SyncUsers() {
  const { user } = useOutletContext();
  const [squareTeamMembers, setSquareTeamMembers] = useState([]);
  const [squareSelections, setSquareSelections] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const isManager = user?.role === 'manager' || user?.role === 'owner';
  if (!isManager) {
    return (
      <div className="sync-users-page">
        <p>Manager access required.</p>
        <Link to="/">Back to dashboard</Link>
      </div>
    );
  }

  const handleLoadFromSquare = async () => {
    setError('');
    setLoading(true);
    try {
      const r = await squareSync();
      const list = r.team_members || [];
      setSquareTeamMembers(list);
      const next = {};
      list.forEach((tm) => {
        next[tm.id] = {
          role: tm.already_in_system ? (tm.role || 'member') : 'member',
          addToSystem: false,
          excluded: !!tm.excluded,
        };
      });
      setSquareSelections(next);
      setMessage(`Fetched ${list.length} team member(s) from Square`);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const setSquareRole = (id, role) => {
    setSquareSelections((prev) => ({ ...prev, [id]: { ...prev[id], role } }));
  };
  const setSquareAddToSystem = (id, addToSystem) => {
    setSquareSelections((prev) => ({ ...prev, [id]: { ...prev[id], addToSystem } }));
  };
  const setSquareExcluded = async (id, excluded) => {
    setError('');
    setLoading(true);
    try {
      await setSquareUserExcluded(id, excluded);
      if (excluded) {
        // Backend may have removed the existing user record; refetch to refresh `already_in_system`.
        const refetch = await squareSync();
        const list = refetch.team_members || [];
        setSquareTeamMembers(list);
        const next = {};
        list.forEach((tm) => {
          next[tm.id] = {
            role: tm.already_in_system ? (tm.role || 'member') : 'member',
            addToSystem: false,
            excluded: !!tm.excluded,
          };
        });
        setSquareSelections(next);
      } else {
        setSquareSelections((prev) => ({
          ...prev,
          [id]: { ...prev[id], excluded: false },
        }));
      }
      setMessage(excluded ? 'User excluded from auto-add' : 'User re-enabled for auto-add');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddSelected = async () => {
    const toAdd = squareTeamMembers.filter(
      (tm) => !tm.already_in_system && !squareSelections[tm.id]?.excluded && squareSelections[tm.id]?.addToSystem
    );
    if (toAdd.length === 0) {
      setError('Select at least one user to add');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const users = toAdd.map((tm) => ({
        id: tm.id,
        email_address: tm.email_address,
        given_name: tm.given_name,
        family_name: tm.family_name,
        phone_number: tm.phone_number,
        role: squareSelections[tm.id]?.role === 'manager' ? 'manager' : 'member',
      }));
      const r = await squareAddUsers(users);
      setMessage(`Added ${r.added} user(s), ${r.skipped} already in system`);
      if (r.added > 0) {
        const refetch = await squareSync();
        const list = refetch.team_members || [];
        setSquareTeamMembers(list);
        const next = {};
        list.forEach((tm) => {
          next[tm.id] = {
            role: tm.already_in_system ? (tm.role || 'member') : 'member',
            addToSystem: false,
            excluded: !!tm.excluded,
          };
        });
        setSquareSelections(next);
      }
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
      setMessage(`Sync: ${r.added || 0} added, ${r.updated} updated, ${r.skipped} skipped, ${r.removed} removed, ${r.excluded || 0} excluded`);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sync-users-page">
      <h1 className="sync-users-page-title">Get Square Users</h1>
      <p className="sync-users-back">
        <Link to="/manage" className="back">← Back to manager</Link>
      </p>

      {error && <p className="sync-users-error">{error}</p>}
      {message && <p className="sync-users-message">{message}</p>}

      <section className="sync-users-section">
        <p>Load users from Square, then add selected users to the system or run Sync to update/remove existing users.</p>
        <button type="button" onClick={handleLoadFromSquare} disabled={loading}>
          {loading ? 'Loading…' : 'Load users from Square'}
        </button>

        {squareTeamMembers.length > 0 && (
          <div className="square-team-members">
            <h3>Square team members</h3>
            <ul className="square-team-list">
              {squareTeamMembers.map((tm) => {
                const displayName = [tm.given_name, tm.family_name].filter(Boolean).join(' ') || tm.email_address || '—';
                const alreadyIn = !!tm.already_in_system;
                const sel = squareSelections[tm.id] || { role: 'member', addToSystem: false, excluded: false };
                return (
                  <li key={tm.id} className="square-team-row">
                    <span className="square-team-name">
                      {displayName} {tm.email_address && `(${tm.email_address})`} {tm.phone_number && ` · ${tm.phone_number}`}
                      {sel.excluded && <span className="square-team-badge-excluded">Excluded</span>}
                    </span>
                    {alreadyIn && !sel.excluded && (
                      <span className="square-team-status">Already in system</span>
                    )}
                    {!alreadyIn && !sel.excluded && (
                      <>
                        <select
                          value={sel.role}
                          onChange={(e) => setSquareRole(tm.id, e.target.value)}
                          className="square-team-role"
                        >
                          <option value="member">User</option>
                          <option value="manager">Manager</option>
                        </select>
                        <label className="square-team-add">
                          <input
                            type="checkbox"
                            checked={sel.addToSystem}
                            onChange={(e) => setSquareAddToSystem(tm.id, e.target.checked)}
                          />
                          Add to system
                        </label>
                      </>
                    )}
                    <label className="square-team-add">
                      <input
                        type="checkbox"
                        checked={!!sel.excluded}
                        onChange={(e) => setSquareExcluded(tm.id, e.target.checked)}
                      />
                      Exclude from auto-add
                    </label>
                  </li>
                );
              })}
            </ul>
            <button type="button" onClick={handleAddSelected} disabled={loading} className="btn-add-selected">
              Add selected
            </button>
            <button type="button" onClick={handleSync} disabled={loading} className="btn-sync">
              Sync
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
