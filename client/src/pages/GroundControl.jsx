import React, { useState, useEffect, useCallback } from 'react';
import {
  getGCZones, startGCZone, stopAllGCZones,
  getGCSchedules, createGCSchedule, updateGCSchedule, deleteGCSchedule,
} from '../api';
import './GroundControl.css';

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DURATION_PRESETS = [5, 10, 15, 30, 60];
const VINEYARD_DEFAULT_MINUTES = 480; // 8 hours

function formatNextRun(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatLastRun(ts) {
  if (!ts) return 'Never';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ── Duration Picker Modal ─────────────────────────────────────────────────────
function DurationModal({ zone, onConfirm, onClose }) {
  const defaultMinutes = zone?.is_vineyard ? VINEYARD_DEFAULT_MINUTES : 15;
  const [minutes, setMinutes] = useState(defaultMinutes);
  const [custom, setCustom] = useState(false);

  function handlePreset(m) {
    setMinutes(m);
    setCustom(false);
  }

  return (
    <div className="gc-modal-overlay" onClick={onClose}>
      <div className="gc-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Start Zone: {zone?.name}</h3>
        <p className="gc-modal-subtitle">Choose duration</p>
        <div className="gc-duration-presets">
          {DURATION_PRESETS.map((m) => (
            <button
              key={m}
              type="button"
              className={`gc-preset-btn${minutes === m && !custom ? ' active' : ''}`}
              onClick={() => handlePreset(m)}
            >
              {m} min
            </button>
          ))}
          {zone?.is_vineyard && (
            <button
              type="button"
              className={`gc-preset-btn gc-preset-vineyard${minutes === VINEYARD_DEFAULT_MINUTES && !custom ? ' active' : ''}`}
              onClick={() => handlePreset(VINEYARD_DEFAULT_MINUTES)}
            >
              8 hr
            </button>
          )}
          <button
            type="button"
            className={`gc-preset-btn${custom ? ' active' : ''}`}
            onClick={() => setCustom(true)}
          >
            Custom
          </button>
        </div>
        {custom && (
          <div className="gc-custom-duration">
            <input
              type="number"
              min={1}
              max={480}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="gc-input"
            />
            <span className="gc-input-unit">minutes</span>
          </div>
        )}
        <div className="gc-modal-actions">
          <button type="button" className="gc-btn gc-btn-primary" onClick={() => onConfirm(minutes)}>
            Start {minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`.trim() : `${minutes} min`}
          </button>
          <button type="button" className="gc-btn gc-btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── New Schedule Form ─────────────────────────────────────────────────────────
function NewScheduleForm({ zones, onSave, onCancel }) {
  const [zoneId, setZoneId] = useState('');
  const [name, setName] = useState('');
  const [dayOfWeek, setDayOfWeek] = useState(1); // Monday
  const [startTime, setStartTime] = useState('07:00');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [startDate, setStartDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Auto-set duration when a vineyard zone is selected
  useEffect(() => {
    const zone = zones.find((z) => z.id === zoneId);
    if (zone?.is_vineyard) {
      setDurationMinutes(VINEYARD_DEFAULT_MINUTES);
      if (!name) setName(`${zone.name} Biweekly`);
    }
  }, [zoneId, zones]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e) {
    e.preventDefault();
    if (!zoneId) { setError('Please select a zone'); return; }
    setSaving(true);
    setError(null);
    try {
      const zone = zones.find((z) => z.id === zoneId);
      await onSave({
        zone_id: zoneId,
        zone_name: zone?.name || '',
        device_id: zone?.device_id || '',
        name: name || `${zone?.name} Biweekly`,
        duration_minutes: Number(durationMinutes),
        day_of_week: Number(dayOfWeek),
        start_time: startTime,
        start_date: startDate || undefined,
      });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const selectedZone = zones.find((z) => z.id === zoneId);

  return (
    <form className="gc-schedule-form" onSubmit={handleSubmit}>
      <h3>New Biweekly Schedule</h3>
      {error && <div className="gc-error">{error}</div>}
      <div className="gc-form-row">
        <label className="gc-label">Zone</label>
        <select className="gc-select" value={zoneId} onChange={(e) => setZoneId(e.target.value)} required>
          <option value="">— select zone —</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.device_name} — {z.name}{z.is_vineyard ? ' 🍇' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="gc-form-row">
        <label className="gc-label">Schedule Name</label>
        <input
          className="gc-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={selectedZone ? `${selectedZone.name} Biweekly` : 'Schedule name'}
        />
      </div>
      <div className="gc-form-row">
        <label className="gc-label">Day of Week</label>
        <select className="gc-select" value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
          {DAYS_OF_WEEK.map((d, i) => (
            <option key={i} value={i}>{d}</option>
          ))}
        </select>
      </div>
      <div className="gc-form-row">
        <label className="gc-label">Start Time</label>
        <input
          className="gc-input gc-input-time"
          type="time"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          required
        />
      </div>
      <div className="gc-form-row">
        <label className="gc-label">Duration</label>
        <div className="gc-duration-inline">
          <input
            className="gc-input gc-input-num"
            type="number"
            min={1}
            max={480}
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(Number(e.target.value))}
          />
          <span className="gc-input-unit">minutes{durationMinutes >= 60 ? ` (${(durationMinutes / 60).toFixed(1)}h)` : ''}</span>
        </div>
        {selectedZone?.is_vineyard && (
          <span className="gc-vineyard-hint">Vineyard default: 8 hours (480 min)</span>
        )}
      </div>
      <div className="gc-form-row">
        <label className="gc-label">Start Date <span className="gc-label-optional">(optional)</span></label>
        <input
          className="gc-input"
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
      </div>
      <div className="gc-form-actions">
        <button type="submit" className="gc-btn gc-btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Create Schedule'}
        </button>
        <button type="button" className="gc-btn gc-btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ── Schedule Row ──────────────────────────────────────────────────────────────
function ScheduleRow({ schedule, onToggle, onDelete }) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!window.confirm(`Delete schedule "${schedule.name}"?`)) return;
    setDeleting(true);
    await onDelete(schedule.id).catch(() => setDeleting(false));
  }

  return (
    <div className={`gc-schedule-row${schedule.is_vineyard || /vineyard/i.test(schedule.zone_name || '') ? ' gc-schedule-vineyard' : ''}`}>
      <div className="gc-schedule-main">
        <span className="gc-schedule-name">{schedule.name}</span>
        {/vineyard/i.test(schedule.zone_name || '') && (
          <span className="gc-vineyard-badge">Vineyard</span>
        )}
        <span className="gc-schedule-meta">
          {DAYS_OF_WEEK[schedule.day_of_week]} at {schedule.start_time} &mdash;{' '}
          {schedule.duration_minutes >= 60
            ? `${Math.floor(schedule.duration_minutes / 60)}h${schedule.duration_minutes % 60 > 0 ? ` ${schedule.duration_minutes % 60}m` : ''}`
            : `${schedule.duration_minutes} min`}
        </span>
      </div>
      <div className="gc-schedule-info">
        <span className="gc-schedule-next">
          Next: {formatNextRun(schedule.next_run_at)}
        </span>
        <span className="gc-schedule-last">
          Last run: {formatLastRun(schedule.last_run_at)}
        </span>
      </div>
      <div className="gc-schedule-actions">
        <label className="gc-toggle" title={schedule.enabled ? 'Disable' : 'Enable'}>
          <input
            type="checkbox"
            checked={schedule.enabled}
            onChange={() => onToggle(schedule)}
          />
          <span className="gc-toggle-slider" />
        </label>
        <button
          type="button"
          className="gc-btn gc-btn-danger-sm"
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting ? '…' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export function GroundControl() {
  const [zones, setZones] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [durationModal, setDurationModal] = useState(null); // zone object
  const [startingZone, setStartingZone] = useState(null);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);
  const [showNewSchedule, setShowNewSchedule] = useState(false);

  const showStatus = (msg, isError = false) => {
    setStatusMsg({ msg, isError });
    setTimeout(() => setStatusMsg(null), 4000);
  };

  const loadData = useCallback(async () => {
    try {
      const [zoneData, scheduleData] = await Promise.all([getGCZones(), getGCSchedules()]);
      setZones(zoneData.zones || []);
      setSchedules(scheduleData.schedules || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Group zones by device
  const zonesByDevice = zones.reduce((acc, z) => {
    const key = z.device_name || z.device_id;
    if (!acc[key]) acc[key] = { device_name: key, device_id: z.device_id, zones: [] };
    acc[key].zones.push(z);
    return acc;
  }, {});

  async function handleStartZone(durationMinutes) {
    const zone = durationModal;
    setDurationModal(null);
    setStartingZone(zone.id);
    try {
      await startGCZone(zone.id, durationMinutes);
      showStatus(`Started "${zone.name}" for ${durationMinutes} min`);
    } catch (err) {
      showStatus(`Failed to start zone: ${err.message}`, true);
    } finally {
      setStartingZone(null);
    }
  }

  async function handleStopAll() {
    if (!window.confirm('Stop all watering now?')) return;
    setStoppingAll(true);
    try {
      await stopAllGCZones();
      showStatus('All watering stopped');
    } catch (err) {
      showStatus(`Failed to stop: ${err.message}`, true);
    } finally {
      setStoppingAll(false);
    }
  }

  async function handleCreateSchedule(data) {
    const result = await createGCSchedule(data);
    setSchedules((prev) => [...prev, result.schedule]);
    setShowNewSchedule(false);
    showStatus(`Schedule "${result.schedule.name}" created`);
  }

  async function handleToggleSchedule(schedule) {
    try {
      const result = await updateGCSchedule(schedule.id, { enabled: !schedule.enabled });
      setSchedules((prev) => prev.map((s) => s.id === schedule.id ? result.schedule : s));
    } catch (err) {
      showStatus(`Failed to update schedule: ${err.message}`, true);
    }
  }

  async function handleDeleteSchedule(id) {
    await deleteGCSchedule(id);
    setSchedules((prev) => prev.filter((s) => s.id !== id));
  }

  if (loading) return <div className="gc-loading">Loading Ground Control…</div>;
  if (error) return <div className="gc-error-page">Error: {error}</div>;

  return (
    <div className="gc-page">
      <div className="gc-header">
        <div>
          <h1>Ground Control</h1>
          <p className="gc-subtitle">Irrigation management via Rachio</p>
        </div>
        <button
          type="button"
          className="gc-btn gc-btn-danger"
          onClick={handleStopAll}
          disabled={stoppingAll}
        >
          {stoppingAll ? 'Stopping…' : 'Stop All Watering'}
        </button>
      </div>

      {statusMsg && (
        <div className={`gc-status-msg${statusMsg.isError ? ' gc-status-error' : ' gc-status-ok'}`}>
          {statusMsg.msg}
        </div>
      )}

      {/* Zones Section */}
      <section className="gc-section">
        <h2>Zones</h2>
        {Object.values(zonesByDevice).map((device) => (
          <div key={device.device_id} className="gc-device-group">
            <h3 className="gc-device-name">{device.device_name}</h3>
            <div className="gc-zone-grid">
              {device.zones.map((zone) => (
                <div key={zone.id} className={`gc-zone-card${zone.is_vineyard ? ' gc-zone-vineyard' : ''}`}>
                  <div className="gc-zone-header">
                    <span className="gc-zone-name">{zone.name}</span>
                    {zone.is_vineyard && <span className="gc-vineyard-badge">Vineyard</span>}
                    {!zone.enabled && <span className="gc-zone-disabled">Disabled</span>}
                  </div>
                  <div className="gc-zone-actions">
                    <button
                      type="button"
                      className="gc-btn gc-btn-primary gc-btn-sm"
                      onClick={() => setDurationModal(zone)}
                      disabled={startingZone === zone.id}
                    >
                      {startingZone === zone.id ? 'Starting…' : 'Start'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {zones.length === 0 && (
          <p className="gc-empty">No zones found. Check Rachio connection.</p>
        )}
      </section>

      {/* Biweekly Schedules Section */}
      <section className="gc-section">
        <div className="gc-section-header">
          <h2>Biweekly Schedules</h2>
          <button
            type="button"
            className="gc-btn gc-btn-primary"
            onClick={() => setShowNewSchedule((v) => !v)}
          >
            {showNewSchedule ? 'Cancel' : '+ New Schedule'}
          </button>
        </div>

        {showNewSchedule && (
          <div className="gc-form-card">
            <NewScheduleForm
              zones={zones}
              onSave={handleCreateSchedule}
              onCancel={() => setShowNewSchedule(false)}
            />
          </div>
        )}

        {schedules.length === 0 && !showNewSchedule && (
          <p className="gc-empty">No biweekly schedules yet.</p>
        )}

        <div className="gc-schedule-list">
          {schedules.map((s) => (
            <ScheduleRow
              key={s.id}
              schedule={s}
              onToggle={handleToggleSchedule}
              onDelete={handleDeleteSchedule}
            />
          ))}
        </div>
      </section>

      {/* Duration modal */}
      {durationModal && (
        <DurationModal
          zone={durationModal}
          onConfirm={handleStartZone}
          onClose={() => setDurationModal(null)}
        />
      )}
    </div>
  );
}
