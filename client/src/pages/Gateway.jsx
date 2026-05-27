/**
 * TeamHub Gateway — approval queue, action log, and rule configuration.
 */
import React, { useState, useEffect, useCallback } from 'react';
import './Gateway.css';

const token = () => localStorage.getItem('teamtask_token');
const authH  = () => ({ Authorization: `Bearer ${token()}` });

const SERVICE_ICONS = { qbo: '📒', square: '◼', commerce7: '🍷' };

function fmt(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function StatusBadge({ status }) {
  const map = {
    pending_approval: ['gw-badge-pending',   '⏳ Pending'],
    executing:        ['gw-badge-executing',  '⚙ Executing'],
    completed:        ['gw-badge-completed',  '✓ Done'],
    failed:           ['gw-badge-failed',     '✗ Failed'],
    rejected:         ['gw-badge-rejected',   '⊘ Rejected'],
  };
  const [cls, label] = map[status] || ['gw-badge-pending', status];
  return <span className={`gw-badge ${cls}`}>{label}</span>;
}

// ── Queue tab ─────────────────────────────────────────────────────────────────
function QueueTab({ onActionChange }) {
  const [queue, setQueue]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy]     = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/gateway/queue', { headers: authH() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setQueue(d.queue);
    } catch (e) { setError(e.message); }
    finally     { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(id, action, note) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fetch(`/api/gateway/${id}/${action}`, {
        method: 'POST',
        headers: { ...authH(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      await load();
      onActionChange?.();
    } catch (e) { alert(e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  }

  if (loading) return <p className="gw-loading">Loading queue…</p>;
  if (error)   return <p className="gw-error">{error}</p>;
  if (!queue.length) return (
    <div className="gw-empty">
      <p>No actions waiting for approval.</p>
      <p className="gw-empty-hint">Actions submitted by agents or users appear here when rules require approval.</p>
    </div>
  );

  return (
    <div className="gw-list">
      {queue.map((item) => (
        <QueueCard
          key={item.id}
          item={item}
          expanded={expanded === item.id}
          onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
          busy={busy[item.id]}
          onApprove={() => act(item.id, 'approve')}
          onReject={(note) => act(item.id, 'reject', note)}
        />
      ))}
    </div>
  );
}

function QueueCard({ item, expanded, onToggle, busy, onApprove, onReject }) {
  const [rejectNote, setRejectNote] = useState('');
  const [rejecting, setRejecting]   = useState(false);

  const autoAt = item.auto_approve_at ? new Date(item.auto_approve_at) : null;
  const remaining = autoAt ? Math.max(0, Math.ceil((autoAt - Date.now()) / 60_000)) : null;

  return (
    <div className={`gw-card ${expanded ? 'gw-card-open' : ''}`}>
      <div className="gw-card-header" onClick={onToggle}>
        <span className="gw-service-icon">{SERVICE_ICONS[item.service] || '🔧'}</span>
        <div className="gw-card-main">
          <div className="gw-card-op">
            <span className="gw-service">{item.service}</span>
            <span className="gw-op">{item.operation}</span>
          </div>
          <div className="gw-card-meta">
            by <strong>{item.submitter_name || item.token_name || item.requested_by_label}</strong>
            {' · '}{fmt(item.created_at)}
          </div>
        </div>
        <div className="gw-card-right">
          {autoAt && (
            <span className="gw-auto-timer" title={`Auto-approves ${fmt(autoAt)}`}>
              ⏱ {remaining > 0 ? `${remaining}m` : 'soon'}
            </span>
          )}
          <StatusBadge status={item.status} />
        </div>
      </div>

      {expanded && (
        <div className="gw-card-body">
          <pre className="gw-payload">{JSON.stringify(item.payload, null, 2)}</pre>

          {!rejecting ? (
            <div className="gw-card-actions">
              <button className="gw-btn-approve" disabled={busy} onClick={onApprove}>
                ✓ Approve
              </button>
              <button className="gw-btn-reject-start" disabled={busy} onClick={() => setRejecting(true)}>
                ✗ Reject…
              </button>
            </div>
          ) : (
            <div className="gw-reject-form">
              <textarea
                className="gw-reject-note"
                placeholder="Reason for rejection (optional)"
                rows={2}
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
              />
              <div className="gw-card-actions">
                <button className="gw-btn-reject-confirm" disabled={busy}
                  onClick={() => onReject(rejectNote)}>Confirm Reject</button>
                <button className="gw-btn-cancel" onClick={() => setRejecting(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Log tab ───────────────────────────────────────────────────────────────────
function LogTab() {
  const [log, setLog]         = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [expanded, setExpanded] = useState(null);
  const [serviceFilter, setServiceFilter] = useState('');
  const [statusFilter, setStatusFilter]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const p = new URLSearchParams({ limit: '100' });
      if (serviceFilter) p.set('service', serviceFilter);
      if (statusFilter)  p.set('status',  statusFilter);
      const r = await fetch(`/api/gateway/log?${p}`, { headers: authH() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setLog(d.log);
    } catch (e) { setError(e.message); }
    finally     { setLoading(false); }
  }, [serviceFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="gw-log-filters">
        <select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)} className="gw-select">
          <option value="">All services</option>
          <option value="qbo">QBO</option>
          <option value="square">AiRon</option>
          <option value="commerce7">Commerce7</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="gw-select">
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="rejected">Rejected</option>
          <option value="pending_approval">Pending</option>
        </select>
      </div>

      {loading && <p className="gw-loading">Loading log…</p>}
      {error   && <p className="gw-error">{error}</p>}
      {!loading && !log.length && <p className="gw-empty"><p>No actions yet.</p></p>}

      {!loading && log.length > 0 && (
        <table className="gw-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Service / Operation</th>
              <th>Submitted by</th>
              <th>Status</th>
              <th>Approved / Rejected by</th>
            </tr>
          </thead>
          <tbody>
            {log.map((row) => {
              const isOpen = expanded === row.id;
              return (
                <React.Fragment key={row.id}>
                  <tr
                    className={`gw-log-row ${isOpen ? 'gw-log-row-open' : ''}`}
                    onClick={() => setExpanded(isOpen ? null : row.id)}
                  >
                    <td className="gw-td-date">{fmt(row.created_at)}</td>
                    <td>
                      <span className="gw-service-sm">{SERVICE_ICONS[row.service]} {row.service}</span>
                      <span className="gw-op-sm">{row.operation}</span>
                    </td>
                    <td>{row.submitter_name || row.token_name || row.requested_by_label}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td className="gw-td-actor">
                      {row.approver_name && <span>✓ {row.approver_name}</span>}
                      {row.rejector_name && <span>⊘ {row.rejector_name}</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="gw-log-detail-row">
                      <td colSpan={5}>
                        <div className="gw-log-detail">
                          <div className="gw-detail-cols">
                            <div>
                              <h5>Payload</h5>
                              <pre className="gw-payload">{JSON.stringify(row.payload, null, 2)}</pre>
                            </div>
                            {(row.result || row.error_message) && (
                              <div>
                                <h5>{row.error_message ? 'Error' : 'Result'}</h5>
                                <pre className={`gw-payload ${row.error_message ? 'gw-payload-err' : ''}`}>
                                  {row.error_message || JSON.stringify(row.result, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                          {row.rejection_note && (
                            <p className="gw-reject-note-display">
                              <strong>Rejection note:</strong> {row.rejection_note}
                            </p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Rules tab ─────────────────────────────────────────────────────────────────
function RulesTab() {
  const [rules, setRules]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [saving, setSaving]   = useState(false);

  const emptyForm = {
    name: '', service_pattern: '', operation_pattern: '',
    require_approval: true, auto_approve_minutes: '', priority: 100, enabled: true,
  };
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/gateway/rules', { headers: authH() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setRules(d.rules);
    } catch (e) { setError(e.message); }
    finally     { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openNew()  { setForm(emptyForm); setEditingRule(null); setShowForm(true); }
  function openEdit(r) {
    setForm({
      name: r.name,
      service_pattern:   r.service_pattern   || '',
      operation_pattern: r.operation_pattern || '',
      require_approval:  r.require_approval,
      auto_approve_minutes: r.auto_approve_minutes ?? '',
      priority: r.priority,
      enabled:  r.enabled,
    });
    setEditingRule(r.id);
    setShowForm(true);
  }

  async function save() {
    if (!form.name.trim()) return alert('Name is required');
    setSaving(true);
    const body = {
      ...form,
      service_pattern:   form.service_pattern   || null,
      operation_pattern: form.operation_pattern || null,
      auto_approve_minutes: form.auto_approve_minutes === '' ? null : Number(form.auto_approve_minutes),
      priority: Number(form.priority),
    };
    try {
      const url    = editingRule ? `/api/gateway/rules/${editingRule}` : '/api/gateway/rules';
      const method = editingRule ? 'PATCH' : 'POST';
      const r = await fetch(url, {
        method,
        headers: { ...authH(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setShowForm(false);
      await load();
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  }

  async function deleteRule(id) {
    if (!confirm('Delete this rule?')) return;
    try {
      const r = await fetch(`/api/gateway/rules/${id}`, {
        method: 'DELETE', headers: authH(),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      await load();
    } catch (e) { alert(e.message); }
  }

  function field(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  return (
    <div className="gw-rules">
      <div className="gw-rules-header">
        <p className="gw-rules-hint">
          Rules are evaluated in priority order (lowest first). The first matching rule wins.
          If no rule matches, the action requires manual approval.
        </p>
        <button className="gw-btn-new-rule" onClick={openNew}>+ New rule</button>
      </div>

      {showForm && (
        <div className="gw-rule-form">
          <h4 className="gw-rule-form-title">{editingRule ? 'Edit rule' : 'New rule'}</h4>
          <div className="gw-rule-form-grid">
            <label>Name
              <input value={form.name} onChange={(e) => field('name', e.target.value)}
                placeholder="e.g. Block all deletes" />
            </label>
            <label>Priority (lower = higher priority)
              <input type="number" value={form.priority} onChange={(e) => field('priority', e.target.value)} />
            </label>
            <label>Service pattern
              <input value={form.service_pattern} onChange={(e) => field('service_pattern', e.target.value)}
                placeholder="qbo  |  square  |  *  (blank = all)" />
            </label>
            <label>Operation pattern
              <input value={form.operation_pattern} onChange={(e) => field('operation_pattern', e.target.value)}
                placeholder="*.delete  |  Bill.*  |  *  (blank = all)" />
            </label>
            <label className="gw-rule-checkbox">
              <input type="checkbox" checked={form.require_approval}
                onChange={(e) => field('require_approval', e.target.checked)} />
              Require approval
            </label>
            <label>Auto-approve after (minutes)
              <input type="number" min="0" value={form.auto_approve_minutes}
                onChange={(e) => field('auto_approve_minutes', e.target.value)}
                placeholder="blank = never, 0 = immediate" disabled={!form.require_approval} />
            </label>
            <label className="gw-rule-checkbox">
              <input type="checkbox" checked={form.enabled}
                onChange={(e) => field('enabled', e.target.checked)} />
              Enabled
            </label>
          </div>
          <div className="gw-rule-form-btns">
            <button className="gw-btn-save-rule" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save rule'}
            </button>
            <button className="gw-btn-cancel" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {loading && <p className="gw-loading">Loading rules…</p>}
      {error   && <p className="gw-error">{error}</p>}
      {!loading && !rules.length && !showForm && (
        <p className="gw-empty-hint">No rules yet. Without rules, all actions require manual approval.</p>
      )}

      {rules.map((r) => (
        <div key={r.id} className={`gw-rule-card ${!r.enabled ? 'gw-rule-disabled' : ''}`}>
          <div className="gw-rule-card-main">
            <span className="gw-rule-priority">#{r.priority}</span>
            <div className="gw-rule-info">
              <div className="gw-rule-name">{r.name}</div>
              <div className="gw-rule-patterns">
                <code>{r.service_pattern || '*'}</code>
                {' / '}
                <code>{r.operation_pattern || '*'}</code>
                {' → '}
                {r.require_approval
                  ? r.auto_approve_minutes != null
                    ? <span className="gw-rule-auto">⏱ auto-approve in {r.auto_approve_minutes}m</span>
                    : <span className="gw-rule-manual">🔒 manual approval</span>
                  : <span className="gw-rule-skip">✓ no approval needed</span>
                }
              </div>
            </div>
          </div>
          <div className="gw-rule-card-actions">
            {!r.enabled && <span className="gw-rule-off-badge">off</span>}
            <button className="gw-btn-edit-rule"   onClick={() => openEdit(r)}>Edit</button>
            <button className="gw-btn-delete-rule" onClick={() => deleteRule(r.id)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function Gateway() {
  const [tab, setTab]         = useState('queue');
  const [queueCount, setQueueCount] = useState(null);

  async function refreshCount() {
    try {
      const r = await fetch('/api/gateway/queue', { headers: authH() });
      const d = await r.json();
      if (r.ok) setQueueCount(d.queue.length);
    } catch { /* ignore */ }
  }

  useEffect(() => { refreshCount(); }, []);

  return (
    <div className="gw-wrap">
      <div className="gw-header">
        <div>
          <h2 className="gw-title">TeamHub Gateway</h2>
          <p className="gw-subtitle">
            Universal proxy for QBO, AiRon &amp; Commerce7 — with audit logs and approval gates.
          </p>
        </div>
      </div>

      <div className="gw-tabs">
        <button
          className={`gw-tab ${tab === 'queue' ? 'gw-tab-active' : ''}`}
          onClick={() => setTab('queue')}
        >
          Queue
          {queueCount > 0 && <span className="gw-tab-badge">{queueCount}</span>}
        </button>
        <button
          className={`gw-tab ${tab === 'log' ? 'gw-tab-active' : ''}`}
          onClick={() => setTab('log')}
        >
          Audit Log
        </button>
        <button
          className={`gw-tab ${tab === 'rules' ? 'gw-tab-active' : ''}`}
          onClick={() => setTab('rules')}
        >
          Approval Rules
        </button>
      </div>

      <div className="gw-tab-content">
        {tab === 'queue' && <QueueTab onActionChange={refreshCount} />}
        {tab === 'log'   && <LogTab />}
        {tab === 'rules' && <RulesTab />}
      </div>
    </div>
  );
}
