import React, { useState, useEffect, useCallback } from 'react';
import {
  getSkynetAgents, getSkynetSchedules, createSkynetSchedule,
  updateSkynetSchedule, deleteSkynetSchedule, runSkynetScheduleNow,
  getSkynetConfig, saveSkynetConfig,
} from '../api';
import './Skynet.css';

const DAYS_OF_WEEK = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

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

function ScheduleForm({ agents, onSave, onCancel, initial }) {
  const [name,         setName]         = useState(initial?.name || '');
  const [agentId,      setAgentId]      = useState(initial?.agent_id || '');
  const [prompt,       setPrompt]       = useState(initial?.prompt || '');
  const [schedType,    setSchedType]    = useState(initial?.schedule_type || 'daily');
  const [fireAt,       setFireAt]       = useState('');
  const [hour,         setHour]         = useState(8);
  const [minute,       setMinute]       = useState(0);
  const [dayOfWeek,    setDayOfWeek]    = useState(1);
  const [dayOfMonth,   setDayOfMonth]   = useState(1);
  const [month,        setMonth]        = useState(1);
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
          {saving ? 'Saving…' : 'Save Schedule'}
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
  const [agents,      setAgents]      = useState([]);
  const [schedules,   setSchedules]   = useState([]);
  const [configured,  setConfigured]  = useState(null); // null=loading, true/false
  const [showForm,    setShowForm]    = useState(false);
  const [loadError,   setLoadError]   = useState('');
  const [runningId,   setRunningId]   = useState(null);
  const [deletingId,  setDeletingId]  = useState(null);

  const load = useCallback(async () => {
    try {
      const cfg = await getSkynetConfig();
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

  async function handleCreate(data) {
    await createSkynetSchedule(data);
    setShowForm(false);
    load();
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
        <button className="btn-primary" onClick={() => setShowForm(true)}>+ New Schedule</button>
      </div>

      {showForm && (
        <div className="skynet-form-wrapper">
          <h2>New Schedule</h2>
          <ScheduleForm agents={agents} onSave={handleCreate} onCancel={() => setShowForm(false)} />
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
                </div>
                <div className="skynet-card-actions">
                  <button
                    className="btn-run"
                    onClick={() => handleRunNow(s.id)}
                    disabled={runningId === s.id}
                    title="Run now"
                  >
                    {runningId === s.id ? '…' : '▶'}
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
