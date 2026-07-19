import React, { useState, useEffect, useCallback } from 'react';
import {
  getHarvesterSources, getHarvesterConnectorTypes,
  createHarvesterSource, updateHarvesterSource, deleteHarvesterSource, runHarvesterSource,
} from '../api';
import './KitchenSources.css';

const SCHEDULE_OPTIONS = [
  { label: 'Every hour',     cron: '0 * * * *' },
  { label: 'Every 2 hours',  cron: '0 */2 * * *' },
  { label: 'Every 4 hours',  cron: '0 */4 * * *' },
  { label: 'Every 6 hours',  cron: '0 */6 * * *' },
  { label: 'Every 12 hours', cron: '0 */12 * * *' },
  { label: 'Daily at 3am',   cron: '0 3 * * *' },
  { label: 'Daily at 6am',   cron: '0 6 * * *' },
];

const scheduleLabel = (cron) => SCHEDULE_OPTIONS.find((o) => o.cron === cron)?.label || cron;

const formatTime = (ts) => {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const statusBadge = (source) => {
  if (source.last_status === 'running') return { cls: 'running', text: '⏳ Running…' };
  if (source.run_requested_at)          return { cls: 'running', text: '⏳ Queued…' };
  if (!source.active)                   return { cls: 'paused',  text: '⏸ Paused' };
  if (source.last_status === 'ok')      return { cls: 'ok',      text: '✓ OK' };
  if (source.last_status === 'error')   return { cls: 'error',   text: '✗ Error' };
  return { cls: 'idle', text: 'Idle' };
};

export function KitchenSources() {
  const [sources, setSources] = useState([]);
  const [connectorTypes, setConnectorTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [running, setRunning] = useState({});
  const [editing, setEditing] = useState(null);      // source object being edited, or {} for new
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, ct] = await Promise.all([getHarvesterSources(), getHarvesterConnectorTypes()]);
      setSources(s.sources || []);
      setConnectorTypes(ct.connector_types || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh while anything is running/queued
  useEffect(() => {
    const anyBusy = sources.some((s) => s.last_status === 'running' || s.run_requested_at);
    if (!anyBusy) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [sources, load]);

  const typeMeta = (key) => connectorTypes.find((c) => c.key === key);

  const handleToggleActive = async (source) => {
    try {
      const updated = await updateHarvesterSource(source.id, { active: !source.active });
      setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, ...updated } : s)));
    } catch (e) { setError(e.message); }
  };

  const handleSchedule = async (source, cron) => {
    try {
      const updated = await updateHarvesterSource(source.id, { cron_schedule: cron });
      setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, ...updated } : s)));
      setMessage(`Schedule updated for ${source.name}`);
    } catch (e) { setError(e.message); }
  };

  const handleRunNow = async (source) => {
    setRunning((p) => ({ ...p, [source.id]: true }));
    setMessage(''); setError('');
    try {
      const r = await runHarvesterSource(source.id);
      setMessage(r.message);
      setTimeout(load, 5000);
    } catch (e) { setError(e.message); }
    finally { setRunning((p) => ({ ...p, [source.id]: false })); }
  };

  const handleDelete = async (source) => {
    try {
      await deleteHarvesterSource(source.id);
      setSources((prev) => prev.filter((s) => s.id !== source.id));
      setConfirmDelete(null);
      setMessage(`Removed ${source.name}`);
    } catch (e) { setError(e.message); }
  };

  const handleSaved = (saved, isNew) => {
    setSources((prev) => isNew ? [...prev, saved].sort((a, b) => a.name.localeCompare(b.name))
                                : prev.map((s) => (s.id === saved.id ? { ...s, ...saved } : s)));
    setEditing(null);
    setMessage(isNew ? `Added ${saved.name}` : `Updated ${saved.name}`);
  };

  if (loading) return <div className="ksrc-loading">Loading sources…</div>;

  return (
    <div className="ksrc-page">
      <div className="ksrc-header">
        <div>
          <h1>Receipt Sources</h1>
          <p className="ksrc-sub">Where Harvester automatically collects invoices and receipts from. Runs on skynet on each source's schedule.</p>
        </div>
        <button type="button" className="ksrc-btn ksrc-btn-primary" onClick={() => setEditing({})}>+ Add source</button>
      </div>

      {message && <div className="ksrc-banner ksrc-banner-ok">{message}</div>}
      {error && <div className="ksrc-banner ksrc-banner-err">{error}</div>}

      {sources.length === 0 && (
        <div className="ksrc-empty">
          <p>No sources configured yet.</p>
          <p>Add one to start collecting receipts automatically.</p>
        </div>
      )}

      <div className="ksrc-list">
        {sources.map((source) => {
          const badge = statusBadge(source);
          const meta = typeMeta(source.connector_type);
          const busy = source.last_status === 'running' || !!source.run_requested_at;
          return (
            <div key={source.id} className={`ksrc-card ksrc-card-${badge.cls}`}>
              <div className="ksrc-card-top">
                <div className="ksrc-card-title">
                  <span className="ksrc-name">{source.name}</span>
                  <span className="ksrc-type">{meta?.label || source.connector_type}</span>
                </div>
                <span className={`ksrc-badge ksrc-badge-${badge.cls}`}>{badge.text}</span>
              </div>

              <div className="ksrc-meta">
                <span>Last run: {formatTime(source.last_run_at)}</span>
                <span>Last success: {formatTime(source.last_success_at)}</span>
                {source.last_records != null && <span>Records: {source.last_records}</span>}
                <span>Schedule: {scheduleLabel(source.cron_schedule)}</span>
              </div>

              {source.last_error && <div className="ksrc-error-detail">{source.last_error}</div>}

              <div className="ksrc-controls">
                <label className="ksrc-toggle">
                  <input type="checkbox" checked={source.active} onChange={() => handleToggleActive(source)} />
                  <span className="ksrc-toggle-slider" />
                  <span className="ksrc-toggle-label">{source.active ? 'Active' : 'Paused'}</span>
                </label>

                <label className="ksrc-sched">
                  Schedule
                  <select value={source.cron_schedule} onChange={(e) => handleSchedule(source, e.target.value)}>
                    {SCHEDULE_OPTIONS.map((o) => <option key={o.cron} value={o.cron}>{o.label}</option>)}
                    {!SCHEDULE_OPTIONS.find((o) => o.cron === source.cron_schedule) && (
                      <option value={source.cron_schedule}>{source.cron_schedule}</option>
                    )}
                  </select>
                </label>

                <div className="ksrc-actions">
                  <button type="button" className="ksrc-btn ksrc-btn-primary" disabled={busy || running[source.id]} onClick={() => handleRunNow(source)}>
                    {busy ? 'Running…' : 'Run now'}
                  </button>
                  <button type="button" className="ksrc-btn" onClick={() => setEditing(source)}>Edit</button>
                  <button type="button" className="ksrc-btn ksrc-btn-danger" onClick={() => setConfirmDelete(source)}>Remove</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <SourceModal
          source={editing}
          connectorTypes={connectorTypes}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}

      {confirmDelete && (
        <div className="ksrc-modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="ksrc-modal ksrc-modal-sm" onClick={(e) => e.stopPropagation()}>
            <h3>Remove source?</h3>
            <p>Remove <strong>{confirmDelete.name}</strong>? Harvester will stop collecting from it. Receipts already imported stay.</p>
            <div className="ksrc-modal-footer">
              <button type="button" className="ksrc-btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button type="button" className="ksrc-btn ksrc-btn-danger" onClick={() => handleDelete(confirmDelete)}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Add / edit modal ──────────────────────────────────────────────────────────

function SourceModal({ source, connectorTypes, onClose, onSaved }) {
  const isNew = !source.id;
  const [name, setName] = useState(source.name || '');
  const [connectorType, setConnectorType] = useState(source.connector_type || '');
  const [cron, setCron] = useState(source.cron_schedule || '0 */2 * * *');
  const [config, setConfig] = useState(source.config || {});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const meta = connectorTypes.find((c) => c.key === connectorType);

  // When picking a connector type for a NEW source, seed config defaults + a name.
  const pickType = (key) => {
    setConnectorType(key);
    const m = connectorTypes.find((c) => c.key === key);
    if (m) {
      const seeded = {};
      (m.config_fields || []).forEach((f) => { if (f.default != null) seeded[f.key] = f.default; });
      setConfig(seeded);
      if (!name.trim()) setName(m.label);
    }
  };

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      const body = { name, cron_schedule: cron, config };
      let saved;
      if (isNew) {
        saved = await createHarvesterSource({ ...body, connector_type: connectorType });
      } else {
        saved = await updateHarvesterSource(source.id, body);
      }
      onSaved(saved, isNew);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="ksrc-modal-overlay" onClick={onClose}>
      <div className="ksrc-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? 'Add receipt source' : `Edit ${source.name}`}</h3>
        {err && <div className="ksrc-banner ksrc-banner-err">{err}</div>}

        <label className="ksrc-field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alsco linens" />
        </label>

        {isNew ? (
          <label className="ksrc-field">
            Type
            <div className="ksrc-type-grid">
              {connectorTypes.map((ct) => {
                const disabled = ct.status !== 'live';
                return (
                  <button
                    key={ct.key}
                    type="button"
                    disabled={disabled}
                    className={`ksrc-type-card${connectorType === ct.key ? ' selected' : ''}${disabled ? ' disabled' : ''}`}
                    onClick={() => !disabled && pickType(ct.key)}
                  >
                    <span className="ksrc-type-name">
                      {ct.label}
                      {disabled && <span className="ksrc-type-soon">coming soon</span>}
                    </span>
                    <span className="ksrc-type-desc">{ct.description}</span>
                  </button>
                );
              })}
            </div>
          </label>
        ) : (
          <div className="ksrc-field">
            Type
            <div className="ksrc-type-static">{meta?.label || source.connector_type}</div>
          </div>
        )}

        {meta?.config_fields?.length > 0 && (
          <div className="ksrc-config">
            {meta.config_fields.map((f) => (
              <label key={f.key} className="ksrc-field">
                {f.label}
                <input
                  value={config[f.key] ?? ''}
                  onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                  placeholder={f.default != null ? String(f.default) : ''}
                />
              </label>
            ))}
          </div>
        )}

        <label className="ksrc-field">
          Schedule
          <select value={cron} onChange={(e) => setCron(e.target.value)}>
            {SCHEDULE_OPTIONS.map((o) => <option key={o.cron} value={o.cron}>{o.label}</option>)}
            {!SCHEDULE_OPTIONS.find((o) => o.cron === cron) && <option value={cron}>{cron}</option>}
          </select>
        </label>

        <div className="ksrc-modal-footer">
          <button type="button" className="ksrc-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="ksrc-btn ksrc-btn-primary"
            disabled={saving || !name.trim() || (isNew && !connectorType)}
            onClick={save}
          >
            {saving ? 'Saving…' : isNew ? 'Add source' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
