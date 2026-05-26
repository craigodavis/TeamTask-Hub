import React, { useState, useEffect, useCallback } from 'react';
import { getSquareSyncObjects, updateSquareSyncObject, runSquareSyncObject, getCatalogTaxGaps } from '../api';
import './SquareSyncPanel.css';

const FREQUENCIES = [
  { value: 'hourly',    label: 'Every hour'    },
  { value: 'every_6h',  label: 'Every 6 hours' },
  { value: 'every_12h', label: 'Every 12 hours' },
  { value: 'nightly',   label: 'Nightly (2am)'  },
];

function statusBadge(obj) {
  if (!obj.last_sync_status) return <span className="ssync-badge ssync-badge-none">Never run</span>;
  if (obj.last_sync_status === 'running') return <span className="ssync-badge ssync-badge-running">Running…</span>;
  if (obj.last_sync_status === 'error')   return <span className="ssync-badge ssync-badge-error" title={obj.last_sync_error}>Error</span>;
  return <span className="ssync-badge ssync-badge-ok">OK</span>;
}

function formatRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function SquareSyncPanel() {
  const [objects, setObjects]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [running, setRunning]       = useState({});   // { [id]: true }

  // Catalog tax gaps (shown inline for catalog_item row)
  const [gaps, setGaps]             = useState(null);
  const [gapsLoading, setGapsLoading] = useState(false);
  const [gapsError, setGapsError]   = useState('');
  const [gapsObjId, setGapsObjId]   = useState(null); // which row is expanded

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await getSquareSyncObjects();
      setObjects(d.objects || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (obj) => {
    const next = !obj.enabled;
    setObjects((prev) => prev.map((o) => o.id === obj.id ? { ...o, enabled: next } : o));
    try {
      const r = await updateSquareSyncObject(obj.id, { enabled: next });
      setObjects((prev) => prev.map((o) => o.id === obj.id ? r.object : o));
    } catch (e) {
      setError(e.message);
      setObjects((prev) => prev.map((o) => o.id === obj.id ? obj : o)); // revert
    }
  };

  const handleFrequency = async (obj, freq) => {
    setObjects((prev) => prev.map((o) => o.id === obj.id ? { ...o, sync_frequency: freq } : o));
    try {
      const r = await updateSquareSyncObject(obj.id, { sync_frequency: freq });
      setObjects((prev) => prev.map((o) => o.id === obj.id ? r.object : o));
    } catch (e) {
      setError(e.message);
    }
  };

  const handleRunNow = async (obj) => {
    setRunning((r) => ({ ...r, [obj.id]: true }));
    setError('');
    try {
      const r = await runSquareSyncObject(obj.id);
      setObjects((prev) => prev.map((o) => o.id === obj.id ? r.object : o));
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning((r) => ({ ...r, [obj.id]: false }));
    }
  };

  const handleCheckGaps = async (objId) => {
    if (gapsObjId === objId) { setGapsObjId(null); setGaps(null); return; }
    setGapsObjId(objId);
    setGapsLoading(true);
    setGapsError('');
    setGaps(null);
    try {
      const d = await getCatalogTaxGaps();
      setGaps(d.items || []);
    } catch (e) {
      setGapsError(e.message);
    } finally {
      setGapsLoading(false);
    }
  };

  if (loading) return <div className="ssync-loading">Loading sync objects…</div>;

  return (
    <div className="ssync-panel">
      <div className="ssync-header">
        <div>
          <h2 className="ssync-heading">Square Data Sync</h2>
          <p className="ssync-desc">
            Enable each object type to have TeamHub pull fresh data from Square on a schedule.
            Use <strong>Sync Now</strong> to pull immediately.
          </p>
        </div>
      </div>

      {error && <div className="ssync-error">{error}</div>}

      <table className="ssync-table">
        <thead>
          <tr>
            <th>Object</th>
            <th>Enabled</th>
            <th>Frequency</th>
            <th>Last Sync</th>
            <th>Records</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {objects.map((obj) => (
            <React.Fragment key={obj.id}>
              <tr className={obj.enabled ? '' : 'ssync-row-disabled'}>
                <td className="ssync-label">{obj.label}</td>
                <td>
                  <label className="ssync-toggle">
                    <input
                      type="checkbox"
                      checked={obj.enabled}
                      onChange={() => handleToggle(obj)}
                    />
                    <span className="ssync-toggle-slider" />
                  </label>
                </td>
                <td>
                  <select
                    className="ssync-freq-select"
                    value={obj.sync_frequency}
                    onChange={(e) => handleFrequency(obj, e.target.value)}
                    disabled={!obj.enabled}
                  >
                    {FREQUENCIES.map((f) => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </td>
                <td className="ssync-meta">{formatRelative(obj.last_synced_at)}</td>
                <td className="ssync-meta">
                  {obj.record_count != null
                    ? obj.record_count.toLocaleString()
                    : '—'}
                </td>
                <td>{statusBadge(obj)}</td>
                <td className="ssync-actions">
                  <button
                    type="button"
                    className="ssync-btn-run"
                    onClick={() => handleRunNow(obj)}
                    disabled={!!running[obj.id]}
                  >
                    {running[obj.id] ? '…' : 'Sync Now'}
                  </button>
                  {obj.object_type === 'catalog_item' && (
                    <button
                      type="button"
                      className="ssync-btn-gaps"
                      onClick={() => handleCheckGaps(obj.id)}
                    >
                      {gapsObjId === obj.id ? 'Hide gaps' : 'Tax gaps'}
                    </button>
                  )}
                </td>
              </tr>

              {/* Inline tax gap results */}
              {gapsObjId === obj.id && (
                <tr className="ssync-gaps-row">
                  <td colSpan={7}>
                    {gapsLoading && <div className="ssync-gaps-loading">Checking…</div>}
                    {gapsError  && <div className="ssync-error">{gapsError}</div>}
                    {gaps !== null && (
                      gaps.length === 0 ? (
                        <div className="ssync-gaps-clear">✅ All items have at least one tax configured.</div>
                      ) : (
                        <>
                          <div className="ssync-gaps-summary">
                            ⚠️ {gaps.length} item{gaps.length !== 1 ? 's' : ''} have no tax configured in Square
                          </div>
                          <table className="ssync-gaps-table">
                            <thead>
                              <tr><th>Item</th><th>Category</th><th>Status</th><th>Price</th></tr>
                            </thead>
                            <tbody>
                              {gaps.map((g) => (
                                <tr key={g.id}>
                                  <td>{g.name}</td>
                                  <td>{g.category_name
                                    ? <span className="ssync-badge">{g.category_name}</span>
                                    : <span className="ssync-muted">—</span>}
                                  </td>
                                  <td>
                                    {g.is_active
                                      ? <span className="ssync-badge ssync-badge-ok">Active — fix in Square</span>
                                      : <span className="ssync-badge ssync-badge-none">Inactive — mark exempt</span>}
                                  </td>
                                  <td className="ssync-muted">
                                    ${(g.min_price / 100).toFixed(2)}
                                    {g.max_price !== g.min_price && ` – $${(g.max_price / 100).toFixed(2)}`}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      )
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
