/**
 * QueryActionsTab — Advanced tab on the Scheduled Report form.
 * Lets users define per-row actions (SMS, etc.) triggered by query results.
 */
import React, { useState, useEffect, useCallback } from 'react';
import './QueryActionsTab.css';

const token = () => localStorage.getItem('teamtask_token');
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` });
const actionsApi = (reportId) => `/api/reports/scheduled/${reportId}/actions`;

const ACTION_TYPES = [{ value: 1, label: 'Send SMS' }];

const OPERATORS = [
  { value: '=',           label: 'equals' },
  { value: '!=',          label: 'does not equal' },
  { value: '>',           label: 'greater than' },
  { value: '<',           label: 'less than' },
  { value: '>=',          label: 'greater than or equal' },
  { value: '<=',          label: 'less than or equal' },
  { value: 'contains',    label: 'contains' },
  { value: 'not_contains',label: 'does not contain' },
  { value: 'in',          label: 'is one of (comma-separated)' },
  { value: 'not_in',      label: 'is not one of (comma-separated)' },
];

const BLANK_CONDITION = { field_name: '', operator: '=', field_value: '', condition_group: 1, sort_order: 0 };
const BLANK_RECIPIENT = { channel: 'sms', recipient_type: 'field', value: '', label: '' };

const BLANK_ACTION = {
  name: '',
  action_type: 1,
  config: { phone_field: '', message: '' },
  notify_once_per_status: false,
  is_active: true,
  conditions: [],
  recipients: [{ ...BLANK_RECIPIENT }],
};

// ── Condition Row ─────────────────────────────────────────────────────────────
function ConditionRow({ cond, index, queryFields, onChange, onRemove }) {
  return (
    <div className="qa-cond-row">
      <span className="qa-cond-prefix">{index === 0 ? 'IF' : 'AND'}</span>

      {queryFields.length > 0 ? (
        <select
          className="qa-cond-field"
          value={cond.field_name}
          onChange={(e) => onChange({ ...cond, field_name: e.target.value })}
        >
          <option value="">— field —</option>
          {queryFields.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      ) : (
        <input
          className="qa-cond-field"
          placeholder="Field name"
          value={cond.field_name}
          onChange={(e) => onChange({ ...cond, field_name: e.target.value })}
        />
      )}

      <select
        className="qa-cond-op"
        value={cond.operator}
        onChange={(e) => onChange({ ...cond, operator: e.target.value })}
      >
        {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      <input
        className="qa-cond-val"
        placeholder="Value"
        value={cond.field_value}
        onChange={(e) => onChange({ ...cond, field_value: e.target.value })}
      />

      <button className="qa-remove-btn" onClick={onRemove} title="Remove condition">✕</button>
    </div>
  );
}

// ── Recipient Row ─────────────────────────────────────────────────────────────
function RecipientRow({ rec, index, queryFields, teamMembers, onChange, onRemove }) {
  return (
    <div className="qa-recip-row">
      <select
        className="qa-recip-type"
        value={rec.recipient_type}
        onChange={(e) => onChange({ ...rec, recipient_type: e.target.value, value: '' })}
      >
        <option value="field">From query column</option>
        <option value="static">Static phone number</option>
        <option value="user">Team member</option>
      </select>

      {rec.recipient_type === 'field' && (
        queryFields.length > 0 ? (
          <select
            className="qa-recip-val"
            value={rec.value}
            onChange={(e) => onChange({ ...rec, value: e.target.value })}
          >
            <option value="">— column with phone —</option>
            {queryFields.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        ) : (
          <input
            className="qa-recip-val"
            placeholder="Column name (e.g. phone_number)"
            value={rec.value}
            onChange={(e) => onChange({ ...rec, value: e.target.value })}
          />
        )
      )}

      {rec.recipient_type === 'static' && (
        <input
          className="qa-recip-val"
          placeholder="+12085550000"
          value={rec.value}
          onChange={(e) => onChange({ ...rec, value: e.target.value })}
        />
      )}

      {rec.recipient_type === 'user' && (
        <select
          className="qa-recip-val"
          value={rec.value}
          onChange={(e) => onChange({ ...rec, value: e.target.value })}
        >
          <option value="">— select team member —</option>
          {teamMembers.map((m) => (
            <option key={m.id} value={m.id}>{m.name}{m.phone ? ` · ${m.phone}` : ''}</option>
          ))}
        </select>
      )}

      <input
        className="qa-recip-label"
        placeholder="Label (e.g. manager)"
        value={rec.label}
        onChange={(e) => onChange({ ...rec, label: e.target.value })}
      />

      {index > 0 && (
        <button className="qa-remove-btn" onClick={onRemove} title="Remove recipient">✕</button>
      )}
    </div>
  );
}

// ── Action Editor ─────────────────────────────────────────────────────────────
function ActionEditor({ initial, reportId, queryFields, teamMembers, onSave, onCancel }) {
  const [form, setForm] = useState(initial
    ? { ...initial, config: { phone_field: '', message: '', ...initial.config } }
    : { ...BLANK_ACTION, recipients: [{ ...BLANK_RECIPIENT }] }
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setConfig = (k, v) => setForm((f) => ({ ...f, config: { ...f.config, [k]: v } }));

  const updateCondition = (i, updated) =>
    setForm((f) => ({ ...f, conditions: f.conditions.map((c, idx) => idx === i ? updated : c) }));
  const addCondition = () =>
    setForm((f) => ({ ...f, conditions: [...f.conditions, { ...BLANK_CONDITION, sort_order: f.conditions.length }] }));
  const removeCondition = (i) =>
    setForm((f) => ({ ...f, conditions: f.conditions.filter((_, idx) => idx !== i) }));

  const updateRecipient = (i, updated) =>
    setForm((f) => ({ ...f, recipients: f.recipients.map((r, idx) => idx === i ? updated : r) }));
  const addRecipient = () =>
    setForm((f) => ({ ...f, recipients: [...f.recipients, { ...BLANK_RECIPIENT, sort_order: f.recipients.length }] }));
  const removeRecipient = (i) =>
    setForm((f) => ({ ...f, recipients: f.recipients.filter((_, idx) => idx !== i) }));

  const insertToken = (field) => {
    setConfig('message', (form.config.message || '') + `{${field}}`);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return setError('Action name is required');
    if (form.action_type === 1 && !form.config.message?.trim()) return setError('Message is required');
    setSaving(true);
    setError('');
    try {
      await onSave(form);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="qa-editor">
      <div className="qa-editor-header">
        <h4>{initial?.id ? 'Edit Action' : 'New Action'}</h4>
      </div>

      {/* Name + Type */}
      <div className="qa-field-row">
        <div className="qa-field qa-field-grow">
          <label>Action Name *</label>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Warn employee of overtime risk"
          />
        </div>
        <div className="qa-field">
          <label>Type</label>
          <select
            value={form.action_type}
            onChange={(e) => setForm((f) => ({ ...f, action_type: parseInt(e.target.value) }))}
          >
            {ACTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
      </div>

      {/* Conditions */}
      <div className="qa-section">
        <div className="qa-section-header">
          <label>Trigger Conditions</label>
          <span className="qa-section-hint">All conditions must match (AND). Leave empty to fire for every row.</span>
        </div>
        {form.conditions.length === 0 && (
          <p className="qa-empty-hint">No conditions — action fires for every row.</p>
        )}
        {form.conditions.map((cond, i) => (
          <ConditionRow
            key={i}
            cond={cond}
            index={i}
            queryFields={queryFields}
            onChange={(updated) => updateCondition(i, updated)}
            onRemove={() => removeCondition(i)}
          />
        ))}
        <button className="qa-add-btn" onClick={addCondition}>+ Add Condition</button>
      </div>

      {/* SMS Config */}
      {form.action_type === 1 && (
        <div className="qa-section">
          <label className="qa-section-label">SMS Message *</label>
          <p className="qa-section-hint">
            Use <code>{'{FieldName}'}</code> to insert values from the row.
            {queryFields.length > 0 && ' Click a field to insert:'}
          </p>
          {queryFields.length > 0 && (
            <div className="qa-token-chips">
              {queryFields.map((f) => (
                <button key={f} className="qa-token-chip" onClick={() => insertToken(f)}>{f}</button>
              ))}
            </div>
          )}
          <textarea
            className="qa-message-input"
            rows={4}
            value={form.config.message || ''}
            onChange={(e) => setConfig('message', e.target.value)}
            placeholder="Hi {Employee}, you've worked {Hours Worked} hrs this week and are projected to reach {Projected Total} hrs. Please check with your manager."
            spellCheck={false}
          />
        </div>
      )}

      {/* Recipients */}
      <div className="qa-section">
        <div className="qa-section-header">
          <label>Recipients</label>
          <span className="qa-section-hint">Who receives this message when the action fires.</span>
        </div>
        {form.recipients.map((rec, i) => (
          <RecipientRow
            key={i}
            rec={rec}
            index={i}
            queryFields={queryFields}
            teamMembers={teamMembers}
            onChange={(updated) => updateRecipient(i, updated)}
            onRemove={() => removeRecipient(i)}
          />
        ))}
        <button className="qa-add-btn" onClick={addRecipient}>+ Add Recipient</button>
      </div>

      {/* Options */}
      <div className="qa-section qa-section-options">
        <label className="qa-checkbox-label">
          <input
            type="checkbox"
            checked={form.notify_once_per_status}
            onChange={(e) => setForm((f) => ({ ...f, notify_once_per_status: e.target.checked }))}
          />
          <span>
            <strong>Send once per status change</strong>
            <span className="qa-option-hint"> — suppress duplicate messages if the same row stays in the same status across runs this week</span>
          </span>
        </label>
        <label className="qa-checkbox-label">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
          />
          <span><strong>Active</strong></span>
        </label>
      </div>

      {error && <p className="qa-error">{error}</p>}

      <div className="qa-editor-footer">
        <button className="qa-cancel-btn" onClick={onCancel}>Cancel</button>
        <button className="qa-save-btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : (initial?.id ? 'Save Action' : 'Add Action')}
        </button>
      </div>
    </div>
  );
}

// ── Action Card ───────────────────────────────────────────────────────────────
function ActionCard({ action, onEdit, onDelete, onToggle }) {
  const condSummary = action.conditions?.length
    ? action.conditions.map((c) => `${c.field_name} ${c.operator} "${c.field_value}"`).join(' AND ')
    : 'Always fires';
  const recipSummary = action.recipients?.length
    ? action.recipients.map((r) => r.label || r.value || r.recipient_type).join(', ')
    : 'No recipients';

  return (
    <div className={`qa-card ${!action.is_active ? 'qa-card-inactive' : ''}`}>
      <div className="qa-card-left">
        <div className="qa-card-top">
          <span className={`qa-dot ${action.is_active ? 'qa-dot-on' : 'qa-dot-off'}`} />
          <span className="qa-card-name">{action.name}</span>
          <span className="qa-type-badge">SMS</span>
        </div>
        <div className="qa-card-meta">
          <span className="qa-card-cond" title={condSummary}>
            ⚡ {action.conditions?.length ? `${action.conditions.length} condition${action.conditions.length !== 1 ? 's' : ''}` : 'Always fires'}
          </span>
          <span className="qa-card-recip">
            📨 {action.recipients?.length ?? 0} recipient{action.recipients?.length !== 1 ? 's' : ''}
          </span>
          {action.notify_once_per_status && (
            <span className="qa-card-dedup">🔕 Once per status</span>
          )}
        </div>
      </div>
      <div className="qa-card-actions">
        <button className="qa-card-btn" onClick={() => onEdit(action)} title="Edit">✎</button>
        <button
          className={`qa-card-btn qa-toggle-btn ${action.is_active ? 'qa-toggle-on' : 'qa-toggle-off'}`}
          onClick={() => onToggle(action)}
          title={action.is_active ? 'Deactivate' : 'Activate'}
        >
          {action.is_active ? 'Active' : 'Inactive'}
        </button>
        <button className="qa-card-btn qa-delete-btn" onClick={() => onDelete(action)} title="Delete">✕</button>
      </div>
    </div>
  );
}

// ── Main Tab Component ────────────────────────────────────────────────────────
export function QueryActionsTab({ reportId, queryFields }) {
  const [actions, setActions]         = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [editing, setEditing]         = useState(null);   // null | 'new' | action object
  const [running, setRunning]         = useState(false);
  const [runResult, setRunResult]     = useState(null);
  const [saveFlash, setSaveFlash]     = useState('');

  const loadActions = useCallback(async () => {
    setLoading(true);
    try {
      const [ad, td] = await Promise.allSettled([
        fetch(actionsApi(reportId), { headers: { Authorization: `Bearer ${token()}` } }).then((r) => r.json()),
        fetch(`${actionsApi(reportId)}/team-members`, { headers: { Authorization: `Bearer ${token()}` } }).then((r) => r.json()),
      ]);
      if (ad.status === 'fulfilled') setActions(ad.value.actions || []);
      if (td.status === 'fulfilled') setTeamMembers(td.value.team_members || []);
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => { loadActions(); }, [loadActions]);

  const handleSave = async (form) => {
    const isEdit = !!form.id;
    const url    = isEdit ? `${actionsApi(reportId)}/${form.id}` : actionsApi(reportId);
    const method = isEdit ? 'PATCH' : 'POST';
    const r = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(form) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Save failed');
    setEditing(null);
    setSaveFlash(isEdit ? 'Action updated.' : 'Action saved.');
    setTimeout(() => setSaveFlash(''), 3000);
    loadActions();
  };

  const handleDelete = async (action) => {
    if (!window.confirm(`Delete action "${action.name}"?`)) return;
    await fetch(`${actionsApi(reportId)}/${action.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token()}` },
    });
    loadActions();
  };

  const handleToggle = async (action) => {
    await fetch(`${actionsApi(reportId)}/${action.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ is_active: !action.is_active }),
    });
    loadActions();
  };

  const handleRunNow = async () => {
    setRunning(true);
    setRunResult(null);
    try {
      const r = await fetch(`${actionsApi(reportId)}/run`, {
        method: 'POST', headers: { Authorization: `Bearer ${token()}` },
      });
      const d = await r.json();
      setRunResult(d);
    } catch (e) {
      setRunResult({ error: e.message });
    } finally {
      setRunning(false);
    }
  };

  if (!reportId) {
    return <p className="qa-unsaved">Save the report first, then configure actions here.</p>;
  }

  return (
    <div className="qa-tab">
      <div className="qa-tab-header">
        <div>
          <p className="qa-tab-desc">
            Actions fire after each scheduled run — each matching row triggers a delivery.
          </p>
        </div>
        <div className="qa-tab-header-actions">
          {actions.length > 0 && (
            <button className="qa-run-btn" onClick={handleRunNow} disabled={running}>
              {running ? 'Running…' : '▶ Run Actions Now'}
            </button>
          )}
          {editing === null && (
            <button className="qa-new-btn" onClick={() => setEditing('new')}>+ Add Action</button>
          )}
        </div>
      </div>

      {saveFlash && <div className="qa-save-flash">{saveFlash}</div>}

      {runResult && (
        <div className={`qa-run-result ${runResult.error ? 'qa-run-error' : 'qa-run-ok'}`}>
          {runResult.error
            ? `Error: ${runResult.error}`
            : `✓ ${runResult.rows} rows processed · ${runResult.triggered} triggered · ${runResult.sent} sent · ${runResult.suppressed} suppressed · ${runResult.failed} failed`
          }
          <button className="qa-run-dismiss" onClick={() => setRunResult(null)}>✕</button>
        </div>
      )}

      {loading && <p className="qa-state">Loading…</p>}

      {!loading && editing === null && actions.length === 0 && (
        <div className="qa-empty">
          <p>No actions configured yet.</p>
          <button className="qa-new-btn" onClick={() => setEditing('new')}>Add your first action</button>
        </div>
      )}

      {!loading && editing === null && actions.length > 0 && (
        <div className="qa-list">
          {actions.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              onEdit={(a) => setEditing(a)}
              onDelete={handleDelete}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}

      {editing !== null && (
        <ActionEditor
          initial={editing === 'new' ? null : editing}
          reportId={reportId}
          queryFields={queryFields}
          teamMembers={teamMembers}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}
