import React, { useState, useEffect, useCallback } from 'react';
import './ScheduledReports.css';

const API = '/api/reports/scheduled';
const token = () => localStorage.getItem('teamtask_token');
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` });

const FREQUENCIES = [
  { value: 'daily',   label: 'Daily' },
  { value: 'weekly',  label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly',  label: 'Yearly' },
];
const DAYS_OF_WEEK = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Date expression presets
const DATE_PRESETS = [
  { label: 'Today',                value: "now()" },
  { label: 'Yesterday',            value: "now() - interval '1 day'" },
  { label: '7 days ago',           value: "now() - interval '7 days'" },
  { label: '30 days ago',          value: "now() - interval '30 days'" },
  { label: '90 days ago',          value: "now() - interval '90 days'" },
  { label: 'Start of this month',  value: "date_trunc('month', now())" },
  { label: 'Start of last month',  value: "date_trunc('month', now() - interval '1 month')" },
  { label: 'End of last month',    value: "date_trunc('month', now()) - interval '1 day'" },
  { label: 'Start of this year',   value: "date_trunc('year', now())" },
  { label: 'Custom…',              value: '__custom__' },
];

function freqSummary(r) {
  if (!r) return '';
  switch (r.frequency) {
    case 'daily':   return `Daily at ${r.send_time?.slice(0,5)}`;
    case 'weekly':  return `Every ${DAYS_OF_WEEK[r.day_of_week] || '?'} at ${r.send_time?.slice(0,5)}`;
    case 'monthly': return `${ordinal(r.day_of_month)} of every month at ${r.send_time?.slice(0,5)}`;
    case 'yearly':  return `${MONTHS[(r.send_month||1)-1]} ${ordinal(r.day_of_month)} at ${r.send_time?.slice(0,5)}`;
    default: return r.frequency;
  }
}
function ordinal(n) {
  if (!n) return '1st';
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}

// Extract {token_names} from a SQL string
function extractTokens(sql) {
  const matches = [...(sql || '').matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

// Merge detected tokens with existing params — preserve values, drop removed tokens
function syncParams(sql, existing) {
  const tokens = extractTokens(sql);
  return tokens.map((name) => {
    const prev = existing.find((p) => p.name === name);
    return prev || { name, type: 'date_expr', value: '' };
  });
}

// ── Param Row ────────────────────────────────────────────────────────────────
function ParamRow({ param, onChange }) {
  // A value that doesn't match any preset (and isn't empty) means it was previously saved as custom
  const isCustomValue = param.type === 'date_expr' &&
    param.value !== '' &&
    !DATE_PRESETS.find((p) => p.value === param.value && p.value !== '__custom__');

  // param.preset tracks the dropdown selection independently from the value
  // so selecting "Custom…" shows the input immediately even before the user types
  const showCustomInput = param.type === 'date_expr' && (param.preset === '__custom__' || isCustomValue);

  const presetValue = showCustomInput
    ? '__custom__'
    : (DATE_PRESETS.find((p) => p.value === param.value)?.value ?? '');

  const handlePresetChange = (val) => {
    if (val === '__custom__') {
      // Mark as custom and preserve any existing value so the user can edit it
      onChange({ ...param, preset: '__custom__' });
    } else {
      onChange({ ...param, preset: val, value: val });
    }
  };

  return (
    <div className="sr-param-row">
      <span className="sr-param-name">{'{' + param.name + '}'}</span>

      <select
        className="sr-param-type"
        value={param.type}
        onChange={(e) => onChange({ ...param, type: e.target.value, value: '', preset: undefined })}
      >
        <option value="date_expr">Date expression</option>
        <option value="static">Fixed value</option>
      </select>

      {param.type === 'date_expr' ? (
        <>
          <select
            className="sr-param-preset"
            value={presetValue}
            onChange={(e) => handlePresetChange(e.target.value)}
          >
            <option value="">— pick a preset —</option>
            {DATE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          {showCustomInput && (
            <input
              className="sr-param-custom"
              value={param.value}
              onChange={(e) => onChange({ ...param, value: e.target.value })}
              placeholder="e.g. now() - interval '60 days'"
              autoFocus
              spellCheck={false}
            />
          )}
        </>
      ) : (
        <input
          className="sr-param-static"
          value={param.value}
          onChange={(e) => onChange({ ...param, value: e.target.value })}
          placeholder="e.g. 'Kindred by the Creek' or 100"
          spellCheck={false}
        />
      )}
    </div>
  );
}

// ── Report Form ───────────────────────────────────────────────────────────────
const BLANK = {
  name: '', description: '', sql_query: '', frequency: 'daily',
  day_of_week: 1, day_of_month: 1, send_month: 1,
  send_time: '08:00', start_date: '', end_date: '', active: true,
  recipient_ids: [], params: [],
};

function ReportForm({ initial, users, onSave, onCancel }) {
  const [form, setForm]       = useState({ ...BLANK, ...initial });
  const [saving, setSaving]   = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError]   = useState('');
  const [aiQuery, setAiQuery]       = useState('');
  const [aiLoading, setAiLoading]   = useState(false);
  const [showAi, setShowAi]         = useState(false);
  const [showHelp, setShowHelp]     = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Auto-sync params whenever SQL changes
  useEffect(() => {
    setForm((f) => ({
      ...f,
      params: syncParams(f.sql_query, f.params),
    }));
  }, [form.sql_query]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateParam = (name, updated) => {
    setForm((f) => ({
      ...f,
      params: f.params.map((p) => p.name === name ? updated : p),
    }));
  };

  const toggleRecipient = (id) => {
    setForm((f) => ({
      ...f,
      recipient_ids: f.recipient_ids.includes(id)
        ? f.recipient_ids.filter((x) => x !== id)
        : [...f.recipient_ids, id],
    }));
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null); setTestError('');
    try {
      const r = await fetch(`${API}/test-sql`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ sql_query: form.sql_query, params: form.params }),
      });
      const d = await r.json();
      if (!r.ok) setTestError(d.error || 'Query failed');
      else setTestResult(d);
    } catch (e) { setTestError(e.message); }
    finally { setTesting(false); }
  };

  const handleAiGenerate = async () => {
    if (!aiQuery.trim()) return;
    setAiLoading(true);
    try {
      const r = await fetch('/api/square/ask', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ question: aiQuery, history: [] }),
      });
      const d = await r.json();
      if (d.sql) { set('sql_query', d.sql); setShowAi(false); setAiQuery(''); }
      else setTestError(d.error || 'No SQL generated');
    } catch (e) { setTestError(e.message); }
    finally { setAiLoading(false); }
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.sql_query.trim()) return;
    setSaving(true);
    setTestError('');
    try {
      await onSave(form);
    } catch (e) {
      setTestError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // Tokens present in SQL that have no value yet
  const unboundParams = form.params.filter((p) => !p.value);

  return (
    <div className="sr-form-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="sr-form">
        <div className="sr-form-header">
          <h3>{initial?.id ? 'Edit Report' : 'New Scheduled Report'}</h3>
          <button className="sr-form-close" onClick={onCancel}>✕</button>
        </div>

        <div className="sr-form-body">
          {/* Name & Description */}
          <div className="sr-field">
            <label>Report Name *</label>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Daily Sales Summary" />
          </div>
          <div className="sr-field">
            <label>Description</label>
            <input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Optional description" />
          </div>

          {/* SQL Query */}
          <div className="sr-field">
            <div className="sr-field-row">
              <label>SQL Query *</label>
              <div className="sr-sql-label-actions">
                <button className="sr-help-btn" onClick={() => setShowHelp(!showHelp)} title="Query builder help">
                  {showHelp ? '✕ Close help' : '? Help'}
                </button>
                <button className="sr-ai-toggle" onClick={() => setShowAi(!showAi)}>
                  {showAi ? '✕ Close AI' : '✦ Generate with AI'}
                </button>
              </div>
            </div>

            {showHelp && (
              <div className="sr-help-panel">

                <div className="sr-help-section">
                  <strong>Step 1 — put a name placeholder in the SQL</strong>
                  <p>Type <code>{'{any_name}'}</code> in your SQL — the name is just a label you choose, letters and underscores only. A parameter row appears automatically below the editor for each one you add.</p>
                  <pre className="sr-help-example">{`SELECT location_name, SUM(total_amount) AS revenue
FROM square.order
WHERE created_at >= {start_date}
  AND created_at <  {end_date}
  AND location_name = {location}
GROUP BY 1 ORDER BY 2 DESC`}</pre>
                </div>

                <div className="sr-help-section">
                  <strong>Step 2 — set each parameter's value below the editor</strong>
                  <p>For each <code>{'{name}'}</code> you added, choose a type and value in the Parameters section that appears:</p>
                  <table className="sr-help-table sr-help-table-wide">
                    <thead>
                      <tr><th>Name in SQL</th><th>Type</th><th>Value you enter</th><th>What runs</th></tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td><code>{'{start_date}'}</code></td>
                        <td>Date expression</td>
                        <td><em>30 days ago preset</em></td>
                        <td><code>now() - interval '30 days'</code></td>
                      </tr>
                      <tr>
                        <td><code>{'{end_date}'}</code></td>
                        <td>Date expression</td>
                        <td><em>Today preset</em></td>
                        <td><code>now()</code></td>
                      </tr>
                      <tr>
                        <td><code>{'{location}'}</code></td>
                        <td>Fixed value</td>
                        <td><code>'Kindred by the Creek'</code></td>
                        <td><code>'Kindred by the Creek'</code></td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="sr-help-cols">
                  <div className="sr-help-section">
                    <strong>Date expression — common values</strong>
                    <p>Recalculated by PostgreSQL every time the report runs.</p>
                    <table className="sr-help-table">
                      <tbody>
                        <tr><td>Today</td><td><code>now()</code></td></tr>
                        <tr><td>14 days ago</td><td><code>now() - interval '14 days'</code></td></tr>
                        <tr><td>30 days ago</td><td><code>now() - interval '30 days'</code></td></tr>
                        <tr><td>Start of month</td><td><code>date_trunc('month', now())</code></td></tr>
                        <tr><td>Start of year</td><td><code>date_trunc('year', now())</code></td></tr>
                      </tbody>
                    </table>
                  </div>

                  <div className="sr-help-section">
                    <strong>Fixed value — SQL literals</strong>
                    <p>Hard-coded — wrap text in single quotes exactly as in SQL.</p>
                    <table className="sr-help-table">
                      <tbody>
                        <tr><td>Text</td><td><code>'Kindred by the Creek'</code></td></tr>
                        <tr><td>Number</td><td><code>100</code></td></tr>
                        <tr><td>Status</td><td><code>'COMPLETED'</code></td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <p className="sr-help-tip">
                  💡 Click <strong>▶ Test Query</strong> after filling in your parameters to see real results before saving.
                </p>
              </div>
            )}
            {showAi && (
              <div className="sr-ai-panel">
                <input
                  className="sr-ai-input"
                  value={aiQuery}
                  onChange={(e) => setAiQuery(e.target.value)}
                  placeholder="Describe the report in plain English…"
                  onKeyDown={(e) => e.key === 'Enter' && handleAiGenerate()}
                />
                <button className="sr-ai-btn" onClick={handleAiGenerate} disabled={aiLoading || !aiQuery.trim()}>
                  {aiLoading ? '…' : 'Generate SQL'}
                </button>
              </div>
            )}
            <textarea
              className="sr-sql-input"
              rows={6}
              value={form.sql_query}
              onChange={(e) => set('sql_query', e.target.value)}
              placeholder={'SELECT ...\nFROM square.order\nWHERE created_at >= {start_date}\n  AND created_at < {end_date}'}
              spellCheck={false}
            />
            <div className="sr-test-row">
              <button className="sr-test-btn" onClick={handleTest} disabled={testing || !form.sql_query.trim()}>
                {testing ? 'Running…' : '▶ Test Query'}
              </button>
              {testError && <span className="sr-test-error">{testError}</span>}
              {testResult && <span className="sr-test-ok">✓ {testResult.count} row{testResult.count !== 1 ? 's' : ''} returned</span>}
            </div>
            {testResult && testResult.rows?.length > 0 && (
              <div className="sr-preview-wrap">
                <table className="sr-preview-table">
                  <thead><tr>{testResult.fields.map((f) => <th key={f}>{f}</th>)}</tr></thead>
                  <tbody>
                    {testResult.rows.slice(0, 5).map((row, i) => (
                      <tr key={i}>{testResult.fields.map((f) => <td key={f}>{row[f] == null ? '—' : String(row[f])}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
                {testResult.rows.length > 5 && <p className="sr-preview-more">…and {testResult.rows.length - 5} more rows</p>}
              </div>
            )}
          </div>

          {/* Parameters — auto-detected from {tokens} in SQL */}
          {form.params.length > 0 && (
            <div className="sr-field">
              <div className="sr-params-header">
                <label>Parameters</label>
                {unboundParams.length > 0 && (
                  <span className="sr-params-warning">
                    ⚠ {unboundParams.map((p) => `{${p.name}}`).join(', ')} not bound
                  </span>
                )}
                {unboundParams.length === 0 && (
                  <span className="sr-params-ok">✓ All bound</span>
                )}
              </div>
              <div className="sr-params-list">
                {form.params.map((param) => (
                  <ParamRow
                    key={param.name}
                    param={param}
                    onChange={(updated) => updateParam(param.name, updated)}
                  />
                ))}
              </div>
              <p className="sr-params-hint">
                <strong>How it works:</strong> <code>{'{name}'}</code> in the SQL is just a label. Set its value here — the value is what actually gets substituted when the report runs.
              </p>
            </div>
          )}

          {/* Schedule */}
          <div className="sr-field-group">
            <div className="sr-field sr-field-sm">
              <label>Frequency</label>
              <select value={form.frequency} onChange={(e) => set('frequency', e.target.value)}>
                {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            {form.frequency === 'weekly' && (
              <div className="sr-field sr-field-sm">
                <label>Day of Week</label>
                <select value={form.day_of_week} onChange={(e) => set('day_of_week', parseInt(e.target.value))}>
                  {DAYS_OF_WEEK.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </div>
            )}
            {(form.frequency === 'monthly' || form.frequency === 'yearly') && (
              <div className="sr-field sr-field-sm">
                <label>Day of Month</label>
                <select value={form.day_of_month} onChange={(e) => set('day_of_month', parseInt(e.target.value))}>
                  {Array.from({length: 31}, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{ordinal(d)}</option>
                  ))}
                </select>
              </div>
            )}
            {form.frequency === 'yearly' && (
              <div className="sr-field sr-field-sm">
                <label>Month</label>
                <select value={form.send_month} onChange={(e) => set('send_month', parseInt(e.target.value))}>
                  {MONTHS.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
                </select>
              </div>
            )}
            <div className="sr-field sr-field-sm">
              <label>Send Time</label>
              <input type="time" value={form.send_time} onChange={(e) => set('send_time', e.target.value)} />
            </div>
          </div>

          {/* Date range */}
          <div className="sr-field-group">
            <div className="sr-field sr-field-sm">
              <label>Start Date</label>
              <input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} />
            </div>
            <div className="sr-field sr-field-sm">
              <label>End Date</label>
              <input type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} />
            </div>
          </div>

          {/* Recipients */}
          <div className="sr-field">
            <label>Recipients <span className="sr-label-hint">(must have a phone number)</span></label>
            <div className="sr-recipients">
              {users.filter((u) => u.phone).map((u) => (
                <label key={u.id} className={`sr-recipient ${form.recipient_ids.includes(u.id) ? 'sr-recipient-on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={form.recipient_ids.includes(u.id)}
                    onChange={() => toggleRecipient(u.id)}
                  />
                  <span>{u.display_name}</span>
                  <span className="sr-recipient-phone">{u.phone}</span>
                </label>
              ))}
              {users.filter((u) => u.phone).length === 0 && (
                <p className="sr-no-phones">No users with phone numbers found.</p>
              )}
            </div>
          </div>

          {/* Active */}
          <div className="sr-field sr-field-inline">
            <label>
              <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
              Active (will send on schedule)
            </label>
          </div>
        </div>

        <div className="sr-form-footer">
          {testError && <span className="sr-test-error sr-save-error">{testError}</span>}
          <button className="sr-cancel-btn" onClick={onCancel}>Cancel</button>
          <button
            className="sr-save-btn"
            onClick={handleSave}
            disabled={saving || !form.name.trim() || !form.sql_query.trim()}
          >
            {saving ? 'Saving…' : (initial?.id ? 'Save Changes' : 'Create Report')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Run History Modal ─────────────────────────────────────────────────────────
function RunHistory({ report, onClose }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/${report.id}/runs`, { headers: { Authorization: `Bearer ${token()}` } })
      .then((r) => r.json())
      .then((d) => setRuns(d.runs || []))
      .finally(() => setLoading(false));
  }, [report.id]);

  return (
    <div className="sr-form-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sr-form sr-history-form">
        <div className="sr-form-header">
          <h3>Run History — {report.name}</h3>
          <button className="sr-form-close" onClick={onClose}>✕</button>
        </div>
        <div className="sr-form-body">
          {loading && <p className="sr-state">Loading…</p>}
          {!loading && runs.length === 0 && <p className="sr-state">No runs yet.</p>}
          {!loading && runs.length > 0 && (
            <table className="sr-history-table">
              <thead>
                <tr><th>Ran At</th><th>Status</th><th>Rows</th><th>SMS Sent</th><th>Link</th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.ran_at).toLocaleString()}</td>
                    <td><span className={`sr-status-badge sr-status-${r.status}`}>{r.status}</span></td>
                    <td>{r.rows_returned ?? '—'}</td>
                    <td>{r.sms_sent_count ?? '—'}</td>
                    <td>
                      {r.status === 'success' && (
                        <a href={`/r/${r.view_token}`} target="_blank" rel="noreferrer" className="sr-view-link">
                          View ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export function ScheduledReports() {
  const [reports, setReports]     = useState([]);
  const [users, setUsers]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [showForm, setShowForm]   = useState(false);
  const [editing, setEditing]     = useState(null);
  const [history, setHistory]     = useState(null);
  const [runningNow, setRunningNow] = useState({});

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(API,            { headers: { Authorization: `Bearer ${token()}` } }).then((r) => r.json()),
      fetch('/api/integrations/users', { headers: { Authorization: `Bearer ${token()}` } }).then((r) => r.json()),
    ]).then(([rd, ud]) => {
      setReports(rd.reports || []);
      setUsers(ud.users || []);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (form) => {
    const isEdit = !!editing?.id;
    const url    = isEdit ? `${API}/${editing.id}` : API;
    const method = isEdit ? 'PATCH' : 'POST';
    const r = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(form) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Save failed (${r.status})`);
    setShowForm(false);
    setEditing(null);
    load();
  };

  const handleToggleActive = async (report) => {
    await fetch(`${API}/${report.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ active: !report.active }),
    });
    load();
  };

  const handleDelete = async (report) => {
    if (!window.confirm(`Delete "${report.name}"? This cannot be undone.`)) return;
    await fetch(`${API}/${report.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
    load();
  };

  const handleRunNow = async (report) => {
    setRunningNow((prev) => ({ ...prev, [report.id]: true }));
    try {
      const r = await fetch(`/api/integrations/run-report/${report.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}` },
      });
      const d = await r.json();
      if (!r.ok) {
        alert(`Run failed:\n\n${d.error}`);
      } else {
        const msg = d.smsSent > 0
          ? `✓ "${report.name}" ran successfully — ${d.smsSent} SMS sent.`
          : `✓ "${report.name}" ran successfully but 0 SMS sent.\n\nCheck that Twilio is configured in Settings → Integrations.`;
        alert(msg);
        load();
      }
    } catch (e) {
      alert(`Run failed: ${e.message}`);
    } finally {
      setRunningNow((prev) => ({ ...prev, [report.id]: false }));
    }
  };

  return (
    <div className="sr-wrap">
      <div className="sr-toolbar">
        <div>
          <h3 className="sr-title">Scheduled Reports</h3>
          <p className="sr-subtitle">Define reports that run automatically and send results via SMS.</p>
        </div>
        <button className="sr-new-btn" onClick={() => { setEditing(null); setShowForm(true); }}>
          + New Report
        </button>
      </div>

      {loading && <p className="sr-state">Loading…</p>}

      {!loading && reports.length === 0 && (
        <div className="sr-empty">
          <p>No scheduled reports yet.</p>
          <button className="sr-new-btn" onClick={() => { setEditing(null); setShowForm(true); }}>
            Create your first report
          </button>
        </div>
      )}

      {!loading && reports.length > 0 && (
        <div className="sr-list">
          {reports.map((report) => (
            <div key={report.id} className={`sr-card ${!report.active ? 'sr-card-inactive' : ''}`}>
              <div className="sr-card-left">
                <div className="sr-card-top">
                  <span className={`sr-active-dot ${report.active ? 'sr-dot-on' : 'sr-dot-off'}`} />
                  <span className="sr-card-name">{report.name}</span>
                  {report.description && <span className="sr-card-desc">{report.description}</span>}
                </div>
                <div className="sr-card-meta">
                  <span className="sr-card-freq">🕐 {freqSummary(report)}</span>
                  {report.params?.length > 0 && (
                    <span className="sr-card-params">
                      🔧 {report.params.length} param{report.params.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {report.recipients?.length > 0 && (
                    <span className="sr-card-recips">
                      👤 {report.recipients.length} recipient{report.recipients.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {report.last_ran_at && (
                    <span className="sr-card-last">Last sent {new Date(report.last_ran_at).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
              <div className="sr-card-actions">
                <button
                  className="sr-card-btn sr-run-now-btn"
                  onClick={() => handleRunNow(report)}
                  disabled={!!runningNow[report.id]}
                  title="Run now and send SMS"
                >
                  {runningNow[report.id] ? '…' : '▶ Run Now'}
                </button>
                <button className="sr-card-btn" onClick={() => setHistory(report)} title="View run history">📋</button>
                <button className="sr-card-btn" onClick={() => { setEditing(report); setShowForm(true); }} title="Edit">✎</button>
                <button
                  className={`sr-card-btn sr-toggle-btn ${report.active ? 'sr-toggle-on' : 'sr-toggle-off'}`}
                  onClick={() => handleToggleActive(report)}
                  title={report.active ? 'Deactivate' : 'Activate'}
                >
                  {report.active ? 'Active' : 'Inactive'}
                </button>
                <button className="sr-card-btn sr-delete-btn" onClick={() => handleDelete(report)} title="Delete">✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <ReportForm
          initial={editing ? {
            ...editing,
            recipient_ids: (editing.recipients || []).map((r) => r.id),
            params: editing.params || [],
            send_time: editing.send_time?.slice(0, 5) || '08:00',
            start_date: editing.start_date?.slice(0, 10) || '',
            end_date: editing.end_date?.slice(0, 10) || '',
          } : undefined}
          users={users}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditing(null); }}
        />
      )}

      {history && <RunHistory report={history} onClose={() => setHistory(null)} />}
    </div>
  );
}
