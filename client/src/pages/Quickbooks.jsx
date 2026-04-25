import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getQBOStatus, syncQBO } from '../api';
import './Quickbooks.css';

export function Quickbooks({ user }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const isOwner = user?.role === 'owner';

  const loadStatus = useCallback(() => {
    setLoading(true);
    setError('');
    getQBOStatus()
      .then(setStatus)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleSync = async () => {
    setSyncing(true);
    setError('');
    setMessage('');
    try {
      const r = await syncQBO();
      setMessage(`Synced ${r.accounts} accounts and ${r.classes} classes from QuickBooks.`);
      loadStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  if (!isOwner) {
    return (
      <div className="qb-page">
        <p>Owner access required.</p>
        <Link to="/">Back to dashboard</Link>
      </div>
    );
  }

  return (
    <div className="qb-page">
      <div className="qb-header">
        <h2>QuickBooks</h2>
      </div>

      {error && <p className="qb-error">{error}</p>}
      {message && <p className="qb-message">{message}</p>}

      {loading ? (
        <p className="qb-loading">Loading…</p>
      ) : !status?.connected ? (
        <div className="qb-not-connected">
          <p>QuickBooks is not connected.</p>
          <Link to="/settings">Connect in Settings → Integrations</Link>
        </div>
      ) : (
        <>
          <div className="qb-status-card">
            <div className="qb-status-row">
              <span className="qb-status-dot connected" />
              <span>Connected — Realm {status.realm_id}</span>
              <span className="qb-env-badge">{status.environment}</span>
            </div>
            <div className="qb-sync-info">
              {status.last_synced ? (
                <span>Last synced: {new Date(status.last_synced).toLocaleString()}</span>
              ) : (
                <span className="qb-sync-never">Never synced — run a sync to import accounts and classes.</span>
              )}
              <div className="qb-counts">
                <span>{status.accounts} accounts</span>
                <span>{status.classes} classes</span>
              </div>
            </div>
            <button
              type="button"
              className="qb-btn-sync"
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>

          <div className="qb-sections">
            <div className="qb-section-card qb-coming-soon">
              <h3>📄 Receipt Import</h3>
              <p>Upload Amazon order PDFs to extract line items, categorize expenses, and push to QuickBooks bank transactions.</p>
              <span className="qb-badge">Coming soon</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
