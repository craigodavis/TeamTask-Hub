import React, { useState, useEffect } from 'react';
import { triggerCatalogSync, getCatalogSyncStatus, getCatalogTaxGaps } from '../api';
import './SquareCatalogPanel.css';

export function SquareCatalogPanel() {
  const [syncStatus, setSyncStatus]   = useState(null);
  const [syncing, setSyncing]         = useState(false);
  const [syncError, setSyncError]     = useState('');

  const [gapItems, setGapItems]       = useState(null);
  const [gapLoading, setGapLoading]   = useState(false);
  const [gapError, setGapError]       = useState('');

  useEffect(() => {
    getCatalogSyncStatus()
      .then((d) => setSyncStatus(d.job))
      .catch(() => {});
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setSyncError('');
    try {
      await triggerCatalogSync();
      const d = await getCatalogSyncStatus();
      setSyncStatus(d.job);
      // Refresh gaps if they were already showing
      if (gapItems !== null) handleCheckGaps();
    } catch (e) {
      setSyncError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleCheckGaps = async () => {
    setGapLoading(true);
    setGapError('');
    try {
      const d = await getCatalogTaxGaps();
      setGapItems(d.items || []);
    } catch (e) {
      setGapError(e.message);
    } finally {
      setGapLoading(false);
    }
  };

  const syncLabel = () => {
    if (!syncStatus) return 'Never synced';
    if (syncStatus.status === 'running') return 'Sync in progress…';
    if (syncStatus.status === 'error')   return `Last sync failed: ${syncStatus.error}`;
    return `Last synced ${new Date(syncStatus.completed_at).toLocaleString()} — ${syncStatus.items_upserted} items, ${syncStatus.cats_upserted} categories`;
  };

  const syncLabelClass = () => {
    if (!syncStatus || syncStatus.status === 'error') return 'scp-sync-err';
    if (syncStatus.status === 'running') return 'scp-sync-running';
    return 'scp-sync-ok';
  };

  return (
    <div className="scp-panel">
      <h2 className="scp-heading">Square Catalog</h2>
      <p className="scp-desc">
        Pull your Square catalog into TeamHub so you can audit tax setup.
        Run a sync, then check which items have no taxes configured.
      </p>

      {/* Sync row */}
      <div className="scp-sync-row">
        <span className={`scp-sync-label ${syncLabelClass()}`}>{syncLabel()}</span>
        <button
          type="button"
          className="scp-btn-primary"
          onClick={handleSync}
          disabled={syncing}
        >
          {syncing ? 'Syncing…' : '↻ Sync from Square'}
        </button>
      </div>
      {syncError && <p className="scp-error">{syncError}</p>}

      {/* Gap check */}
      <div className="scp-gap-header">
        <div>
          <h3 className="scp-subheading">Items with no tax configured</h3>
          <p className="scp-desc">
            These items have no taxes applied in Square — they will never collect
            sales tax at the register. Sync first, then check.
          </p>
        </div>
        <button
          type="button"
          className="scp-btn-secondary"
          onClick={handleCheckGaps}
          disabled={gapLoading || syncing}
        >
          {gapLoading ? 'Checking…' : 'Check Now'}
        </button>
      </div>

      {gapError && <p className="scp-error">{gapError}</p>}

      {gapItems !== null && (
        gapItems.length === 0 ? (
          <div className="scp-all-good">
            ✅ All catalog items have at least one tax configured.
          </div>
        ) : (
          <>
            <div className="scp-gap-summary">
              ⚠️ <strong>{gapItems.length} item{gapItems.length !== 1 ? 's' : ''}</strong> have
              no tax configured. Fix these in Square to start collecting tax.
            </div>
            <table className="scp-table">
              <thead>
                <tr>
                  <th>Item Name</th>
                  <th>Category</th>
                  <th>Type</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {gapItems.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.category_name
                      ? <span className="scp-badge">{item.category_name}</span>
                      : <span className="scp-muted">—</span>}
                    </td>
                    <td className="scp-muted">{item.product_type || '—'}</td>
                    <td className="scp-muted">
                      {item.updated_at ? new Date(item.updated_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      )}
    </div>
  );
}
