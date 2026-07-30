import React, { useState, useEffect, useCallback } from 'react';
import {
  getSkynetAgents, getSkynetSchedules, createSkynetSchedule,
  updateSkynetSchedule, deleteSkynetSchedule, runSkynetScheduleNow,
  getSkynetConfig, saveSkynetConfig, testSkynetRun,
} from '../api';
import './Skynet.css';

const DAYS_OF_WEEK = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const MODELS = [
  { id: 'claude-haiku-3-5',  label: 'Haiku 3.5',  input: '$0.80/MTok', output: '$4/MTok',   speed: '⚡ Fast',      desc: 'Simple lookups, summaries, quick classification' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5',  input: '$3/MTok',   output: '$15/MTok',  speed: '✦ Balanced',  desc: 'Default workhorse — most coding, analysis' },
  { id: 'claude-sonnet-4-7', label: 'Sonnet 4.7',  input: '$3/MTok',   output: '$15/MTok',  speed: '✦ Balanced',  desc: 'Sonnet 4 generation, extended thinking capable' },
  { id: 'claude-opus-4-5',   label: 'Opus 4.5',    input: '$15/MTok',  output: '$75/MTok',  speed: '🐢 Slower',   desc: 'Deep reasoning, hard problems, architecture' },
  { id: 'claude-opus-4-7',   label: 'Opus 4.7',    input: '$15/MTok',  output: '$75/MTok',  speed: '🐢 Slower',   desc: 'Most capable, extended thinking, complex multi-step' },
];

function ModelSelect({ value, onChange }) {
  const [showInfo, setShowInfo] = useState(false);
  return (
    <div className="skynet-model-wrap">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="skynet-model-select">
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
      <button
        type="button"
        className="skynet-model-info-btn"
        onClick={() => setShowInfo((v) => !v)}
        title="Model pricing & capabilities"
        aria-label="Model info"
      >ℹ</button>
      {showInfo && (
        <div className="skynet-model-info-popup">
          <table className="skynet-model-table">
            <thead>
              <tr><th>Model</th><th>Input</th><th>Output</th><th>Speed</th><th>Best for</th></tr>
            </thead>
            <tbody>
              {MODELS.map((m) => (
                <tr key={m.id} className={m.id === value ? 'skynet-model-active' : ''}>
                  <td>{m.label}</td>
                  <td>{m.input}</td>
                  <td>{m.output}</td>
                  <td style={{whiteSpace:'nowrap'}}>{m.speed}</td>
                  <td>{m.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="skynet-model-info-close" onClick={() => setShowInfo(false)}>✕ Close</button>
        </div>
      )}
    </div>
  );
}

function scheduleLabel(s) {
  const cfg = s.schedule_config || {};
  const t = (h, m) => `${String(h).padStart(2,'0')}:${String(m||0).padStart(2,'0')}`;
  switch (s.schedule_type) {
    case 'once':     return `Once — ${s.fire_at ? new Date(s.fire_at).toLocaleString() : '—'}`;
    case 'hourly':   return 'Every hour';
    case 'daily':    return `Daily at ${t(cfg.hour||8, cfg.minute||0)}`;
    case 'weekly':   return `Weekly on ${DAYS_OF_WEEK[cfg.dayOfWeek||1]} at ${t(cfg.hour||8, cfg.minute||0)}`;
    case 'monthly':  return `Monthly on the ${cfg.dayOfMonth||1} at ${t(cfg.hour||8, cfg.minute||0)}`;
    case 'annually': return `Annually — ${MONTHS[(cfg.month||1)-1]} ${cfg.dayOfMonth||1} at ${t(cfg.hour||8, cfg.minute||0)}`;
    default:         return s.schedule_type;
  }
}

function TestPanel({ agents, onSaveAsSchedule }) {
  const [open,      setOpen]      = useState(false);
  const [agentId,   setAgentId]   = useState('');
  const [prompt,    setPrompt]    = useState('');
  const [running,   setRunning]   = useState(false);
  const [result,    setResult]    = useState(null); // { ok, issue } | { error }

  async function handleRun(e) {
    e.preventDefault();
    setRunning(true);
    setResult(null);
    try {
      const data = await testSkynetRun({ agentId, prompt });
      setResult({ ok: true, issue: data.issue });
    } catch (err) {
      setResult({ ok: false, error: err.message });
    } finally {
      setRunning(false);
    }
  }

  function handleSaveAsSchedule() {
    onSaveAsSchedule({ agentId, prompt });
    setOpen(false);
  }

  return (
    <div className="skynet-test-panel">
      <button
        type="button"
        className="skynet-test-toggle"
        onClick={() => { setOpen((v) => !v); setResult(null); }}
        aria-expanded={open}
      >
        <span className="skynet-test-toggle-icon">{open ? '▾' : '▸'}</span>
        Test an agent
        <span className="skynet-test-badge">Run without scheduling</span>
      </button>

      {open && (
        <form className="skynet-test-form" onSubmit={handleRun}>
          <div className="skynet-form-row">
            <label>Agent</label>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} required>
              <option value="">Select an agent…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} — {a.title || a.role}</option>
              ))}
            </select>
          </div>
          <div className="skynet-form-row">
            <label>Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do?"
              rows={4}
              required
            />
          </div>

          {result && (
            <div className={`skynet-test-result ${result.ok ? 'skynet-test-ok' : 'skynet-test-err'}`}>
              {result.ok ? (
                <>
                  <span className="skynet-test-result-icon">✓</span>
                  Issue created in Paperclip
                  {result.issue?.id && (
                    <span className="skynet-test-issue-id"> #{result.issue.id.slice(0, 8)}…</span>
                  )}
                </>
              ) : (
                <>
                  <span className="skynet-test-result-icon">✕</span>
                  {result.error}
                </>
              )}
            </div>
          )}

          <div className="skynet-form-actions">
            <button type="submit" className="btn-primary" disabled={running}>
              {running ? 'Running…' : '▶ Run Test'}
            </button>
            {result?.ok && (
              <button
                type="button"
                className="btn-secondary"
                onClick={handleSaveAsSchedule}
                title="Open the schedule form pre-filled with this agent and prompt"
              >
                Save as Schedule →
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function ScheduleForm({ agents, onSave, onCancel, initial, isEditing }) {
  // `initial` can be a DB schedule row (snake_case) or a test-panel prefill (camelCase)
  const cfg = initial?.schedule_config || {};
  const [name,         setName]         = useState(initial?.name || '');
  const [agentId,      setAgentId]      = useState(initial?.agent_id || initial?.agentId || '');
  const [prompt,       setPrompt]       = useState(initial?.prompt || '');
  const [schedType,    setSchedType]    = useState(initial?.schedule_type || 'daily');
  const [fireAt,       setFireAt]       = useState(
    initial?.fire_at ? new Date(initial.fire_at).toISOString().slice(0, 16) : ''
  );
  const [hour,         setHour]         = useState(cfg.hour ?? 8);
  const [minute,       setMinute]       = useState(cfg.minute ?? 0);
  const [dayOfWeek,    setDayOfWeek]    = useState(cfg.dayOfWeek ?? 1);
  const [dayOfMonth,   setDayOfMonth]   = useState(cfg.dayOfMonth ?? 1);
  const [month,        setMonth]        = useState(cfg.month ?? 1);
  const [model,        setModel]        = useState(initial?.model || 'claude-haiku-3-5');
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const agent = agents.find((a) => a.id === agentId);
      await onSave({
        name,
        agentId,
        agentName: agent?.name || agentId,
        prompt,
        model,
        scheduleType: schedType,
        fireAt:       schedType === 'once' ? fireAt : undefined,
        scheduleConfig: { hour, minute, dayOfWeek, dayOfMonth, month },
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="skynet-form" onSubmit={handleSubmit}>
      <div className="skynet-form-row">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Betty 6-hour tax check" required />
      </div>
      <div className="skynet-form-row">
        <label>Agent</label>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} required>
          <option value="">Select an agent…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name} — {a.title || a.role}</option>
          ))}
        </select>
      </div>
      <div className="skynet-form-row">
        <label>Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do? Be specific — this becomes the Paperclip issue description."
          rows={5}
          required
        />
      </div>
      <div className="skynet-form-row">
        <label>Model</label>
        <ModelSelect value={model} onChange={setModel} />
      </div>
      <div className="skynet-form-row">
        <label>Frequency</label>
        <select value={schedType} onChange={(e) => setSchedType(e.target.value)}>
          <option value="once">Once</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="annually">Annually</option>
        </select>
      </div>

      {schedType === 'once' && (
        <div className="skynet-form-row">
          <label>Run at</label>
          <input type="datetime-local" value={fireAt} onChange={(e) => setFireAt(e.target.value)} required />
        </div>
      )}
      {['daily','weekly','monthly','annually'].includes(schedType) && (
        <div className="skynet-form-row">
          <label>Time</label>
          <div className="skynet-time-row">
            <select value={hour} onChange={(e) => setHour(+e.target.value)}>
              {Array.from({length:24},(_,i)=>(
                <option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>
              ))}
            </select>
            <select value={minute} onChange={(e) => setMinute(+e.target.value)}>
              {[0,15,30,45].map((m)=>(
                <option key={m} value={m}>:{String(m).padStart(2,'0')}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      {schedType === 'weekly' && (
        <div className="skynet-form-row">
          <label>Day</label>
          <select value={dayOfWeek} onChange={(e) => setDayOfWeek(+e.target.value)}>
            {DAYS_OF_WEEK.map((d,i)=><option key={i} value={i}>{d}</option>)}
          </select>
        </div>
      )}
      {['monthly','annually'].includes(schedType) && (
        <div className="skynet-form-row">
          <label>Day of month</label>
          <select value={dayOfMonth} onChange={(e) => setDayOfMonth(+e.target.value)}>
            {Array.from({length:28},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
          </select>
        </div>
      )}
      {schedType === 'annually' && (
        <div className="skynet-form-row">
          <label>Month</label>
          <select value={month} onChange={(e) => setMonth(+e.target.value)}>
            {MONTHS.map((m,i)=><option key={i+1} value={i+1}>{m}</option>)}
          </select>
        </div>
      )}

      {error && <p className="skynet-form-error">{error}</p>}
      <div className="skynet-form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : isEditing ? 'Save Changes' : 'Save Schedule'}
        </button>
      </div>
    </form>
  );
}

function ConfigPanel({ onConfigured }) {
  const [baseUrl,    setBaseUrl]    = useState('');
  const [apiKey,     setApiKey]     = useState('');
  const [companyId,  setCompanyId]  = useState('');
  const [goalId,     setGoalId]     = useState('');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await saveSkynetConfig({ baseUrl, apiKey, companyId, goalId });
      onConfigured();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="skynet-config-panel">
      <h2>Connect to Skynet</h2>
      <p>Enter your Paperclip instance details to enable agent scheduling.</p>
      <form onSubmit={handleSave}>
        <div className="skynet-form-row">
          <label>Paperclip base URL</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://skynet.kindredvineyards.com" required />
        </div>
        <div className="skynet-form-row">
          <label>API key</label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="pcp_…" required />
        </div>
        <div className="skynet-form-row">
          <label>Paperclip company ID</label>
          <input value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="UUID" required />
        </div>
        <div className="skynet-form-row">
          <label>Default goal ID <span className="skynet-optional">(optional)</span></label>
          <input value={goalId} onChange={(e) => setGoalId(e.target.value)} placeholder="UUID" />
        </div>
        {error && <p className="skynet-form-error">{error}</p>}
        <div className="skynet-form-actions">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function Skynet() {
  const [agents,          setAgents]          = useState([]);
  const [schedules,       setSchedules]       = useState([]);
  const [configured,      setConfigured]      = useState(null); // null=loading, true/false
  const [showForm,        setShowForm]        = useState(false);
  const [prefillForm,     setPrefillForm]     = useState(null); // { agentId, prompt } from test panel
  const [editingSchedule, setEditingSchedule] = useState(null); // full schedule row being edited
  const [loadError,       setLoadError]       = useState('');
  const [runningId,       setRunningId]       = useState(null);
  const [deletingId,      setDeletingId]      = useState(null);
  const [baseUrl,         setBaseUrl]         = useState('');

  const load = useCallback(async () => {
    try {
      const cfg = await getSkynetConfig();
      if (cfg.baseUrl) setBaseUrl(cfg.baseUrl);
      if (!cfg.baseUrl || !cfg.companyId || !cfg.hasApiKey) {
        setConfigured(false);
        return;
      }
      setConfigured(true);
      const [agentData, schedData] = await Promise.all([getSkynetAgents(), getSkynetSchedules()]);
      setAgents(agentData.agents || []);
      setSchedules(schedData.schedules || []);
    } catch (err) {
      setLoadError(err.message);
      setConfigured(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function closeForm() {
    setShowForm(false);
    setPrefillForm(null);
    setEditingSchedule(null);
  }

  async function handleCreate(data) {
    await createSkynetSchedule(data);
    closeForm();
    load();
  }

  async function handleUpdate(data) {
    await updateSkynetSchedule(editingSchedule.id, data);
    closeForm();
    load();
  }

  function handleEdit(s) {
    setEditingSchedule(s);
    setPrefillForm(null);
    setShowForm(true);
    setTimeout(() => document.querySelector('.skynet-form-wrapper')?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  function handleSaveAsSchedule({ agentId, prompt }) {
    setPrefillForm({ agentId, prompt });
    setEditingSchedule(null);
    setShowForm(true);
    // Scroll to form
    setTimeout(() => document.querySelector('.skynet-form-wrapper')?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  async function handleToggle(s) {
    await updateSkynetSchedule(s.id, { enabled: !s.enabled });
    setSchedules((prev) => prev.map((x) => x.id === s.id ? { ...x, enabled: !x.enabled } : x));
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this schedule?')) return;
    setDeletingId(id);
    try {
      await deleteSkynetSchedule(id);
      setSchedules((prev) => prev.filter((x) => x.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRunNow(id) {
    setRunningId(id);
    try {
      await runSkynetScheduleNow(id);
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setRunningId(null);
    }
  }

  if (configured === null) return <div className="skynet-loading">Loading…</div>;

  if (configured === false) {
    return (
      <div className="skynet-page">
        <div className="skynet-header">
          <h1>Skynet</h1>
        </div>
        {loadError && <p className="skynet-error">{loadError}</p>}
        <ConfigPanel onConfigured={() => { setConfigured(true); load(); }} />
      </div>
    );
  }

  return (
    <div className="skynet-page">
      <div className="skynet-header">
        <div>
          <h1>Skynet</h1>
          <p className="skynet-subtitle">Schedule tasks for your AI agents on Paperclip</p>
        </div>
        <div className="skynet-header-actions">
          {baseUrl && (
            <a
              className="btn-secondary"
              href={baseUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Skynet ↗
            </a>
          )}
          <button className="btn-primary" onClick={() => setShowForm(true)}>+ New Schedule</button>
        </div>
      </div>

      <TestPanel agents={agents} onSaveAsSchedule={handleSaveAsSchedule} />

      {showForm && (
        <div className="skynet-form-wrapper">
          <h2>{editingSchedule ? 'Edit Schedule' : 'New Schedule'}</h2>
          <ScheduleForm
            agents={agents}
            onSave={editingSchedule ? handleUpdate : handleCreate}
            onCancel={closeForm}
            initial={editingSchedule || prefillForm}
            isEditing={!!editingSchedule}
          />
        </div>
      )}

      {schedules.length === 0 && !showForm ? (
        <div className="skynet-empty">
          <p>No schedules yet. Create one to start automating agent tasks.</p>
        </div>
      ) : (
        <div className="skynet-list">
          {schedules.map((s) => (
            <div key={s.id} className={`skynet-card ${s.enabled ? '' : 'skynet-card-disabled'}`}>
              <div className="skynet-card-top">
                <div className="skynet-card-meta">
                  <span className="skynet-card-name">{s.name}</span>
                  <span className="skynet-card-agent">{s.agent_name}</span>
                  {!s.enabled && <span className="skynet-card-paused-badge">Off the automatic schedule — Run still works</span>}
                </div>
                <div className="skynet-card-actions">
                  <button
                    className="btn-run"
                    onClick={() => handleRunNow(s.id)}
                    disabled={runningId === s.id}
                    title="Run now"
                  >
                    {runningId === s.id ? '… Running' : <>▶ Run</>}
                  </button>
                  <button
                    className="btn-edit"
                    onClick={() => handleEdit(s)}
                    title="Edit"
                  >
                    ✎
                  </button>
                  <label className="skynet-toggle" title={s.enabled ? 'Enabled' : 'Disabled'}>
                    <input type="checkbox" checked={s.enabled} onChange={() => handleToggle(s)} />
                    <span className="skynet-toggle-slider" />
                  </label>
                  <button
                    className="btn-delete"
                    onClick={() => handleDelete(s.id)}
                    disabled={deletingId === s.id}
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <p className="skynet-card-schedule">{scheduleLabel(s)}</p>
              <p className="skynet-card-prompt">{s.prompt}</p>
              <div className="skynet-card-footer">
                {s.last_run_at && <span>Last run: {new Date(s.last_run_at).toLocaleString()}</span>}
                {s.next_run_at && s.enabled && <span>Next: {new Date(s.next_run_at).toLocaleString()}</span>}
                {s.run_count > 0 && <span>{s.run_count} run{s.run_count !== 1 ? 's' : ''}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
