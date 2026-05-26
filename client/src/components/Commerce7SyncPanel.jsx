import React, { useState, useEffect, useCallback } from 'react';
import { getC7SyncObjects, updateC7SyncObject, runC7SyncObject } from '../api';
import './SquareSyncPanel.css'; // reuse same styles

const FREQUENCIES = [
  { value: 'hourly',    label: 'Every hour'     },
  { value: 'every_6h',  label: 'Every 6 hours'  },
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
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function Commerce7SyncPanel() {
  const [objects, setObjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [running, setRunning] = useState({}); // { [id]: true }

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await getC7SyncObjects();
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
      const r = await updateC7SyncObject(obj.id, { enabled: next });
      setObjects((prev) => prev.map((o) => o.id === obj.id ? r.object : o));
    } catch (e) {
      setError(e.message);
      setObjects((prev) => prev.map((o) => o.id === obj.id ? obj : o)); // revert
    }
  };

  const handleFrequency = async (obj, freq) => {
    setObjects((prev) => prev.map((o) => o.id === obj.id ? { ...o, sync_frequency: freq } : o));
    try {
      const r = await updateC7SyncObject(obj.id, { sync_frequency: freq });
      setObjects((prev) => prev.map((o) => o.id === obj.id ? r.object : o));
    } catch (e) {
      setError(e.message);
    }
  };

  const handleRunNow = async (obj) => {
    setRunning((r) => ({ ...r, [obj.id]: true }));
    setError('');
    try {
      const r = await runC7SyncObject(obj.id);
      setObjects((prev) => prev.map((o) => o.id === obj.id ? r.object : o));
    } catch (e) {
      setError(e.message);
      // Reload to get accurate status after error
      load();
    } finally {
      setRunning((r) => ({ ...r, [obj.id]: false }));
    }
  };

  if (loading) return <div className="ssync-loading">Loading sync objects…</div>;

  return (
    <div className="ssync-panel">
      <div className="ssync-header">
        <div>
          <h2 className="ssync-heading">Commerce7 Data Sync</h2>
          <p className="ssync-desc">
            Enable each object type to have TeamHub pull fresh data from Commerce7 on a schedule.
            The scheduler runs every 4 hours automatically. Use <strong>Sync Now</strong> to pull immediately.
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
                </td>
              </tr>

              {/* Show last log entry inline when there's an error */}
              {obj.last_sync_status === 'error' && obj.last_sync_error && (
                <tr className="ssync-gaps-row">
                  <td colSpan={7}>
                    <div className="ssync-error" style={{ margin: 0 }}>
                      ⚠ Last error: {obj.last_sync_error}
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>

      {/* Sync log summary */}
      {objects.some((o) => o.last_log) && (
        <div style={{ marginTop: '1.5rem' }}>
          <h3 style={{ fontSize: '0.9rem', fontWeight: 600, color: '#555', marginBottom: '0.5rem' }}>
            Recent Sync Activity
          </h3>
          <table className="ssync-table" style={{ fontSize: '0.8rem' }}>
            <thead>
              <tr>
                <th>Entity</th>
                <th>Mode</th>
                <th>Records</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {objects.filter((o) => o.last_log).map((obj) => {
                const log = obj.last_log;
                const duration = log.finished_at && log.started_at
                  ? Math.round((new Date(log.finished_at) - new Date(log.started_at)) / 1000)
                  : null;
                return (
                  <tr key={obj.id}>
                    <td className="ssync-label">{obj.label}</td>
                    <td className="ssync-meta">{log.mode}</td>
                    <td className="ssync-meta">{log.records_synced?.toLocaleString() ?? '—'}</td>
                    <td className="ssync-meta">{formatRelative(log.started_at)}</td>
                    <td className="ssync-meta">{duration != null ? `${duration}s` : '—'}</td>
                    <td>
                      {log.error_message
                        ? <span className="ssync-badge ssync-badge-error" title={log.error_message}>Error</span>
                        : <span className="ssync-badge ssync-badge-ok">OK</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
