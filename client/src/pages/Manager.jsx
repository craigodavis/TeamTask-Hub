import React, { useState, useEffect } from 'react';
import { Link, Navigate, useSearchParams, useOutletContext } from 'react-router-dom';
import {
  getTaskTemplates,
  getAssignments,
  createAssignment,
  deleteAssignment,
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  getAnnouncementAcknowledgments,
  getCompanyUsers,
  updateUser,
  deleteUser,
  sendPasswordResetEmail,
  sendSms,
  getSmsLog,
  getLocations,
  createLocation,
  updateLocation,
  deleteLocation,
  getSquareLocations,
  getFoodWasteReport,
  getTaskReport,
  createTaskListTemplate,
  updateTaskListTemplate,
  deleteTaskListTemplate,
  getTemplateTasks,
  createTaskItem,
  updateTaskItem,
  deleteTaskItem,
  taskDayNames,
  taskMonthNames,
  getWageTitles,
  reorderTemplateTasks,
  getSquareSchedule,
  uploadAnnouncementImage,
  approveAnnouncement,
  publishAnnouncement,
  getPendingMyApproval,
} from '../api';
import { DebtReportSection } from '../components/DebtReportSection';
import { ScheduledReports } from './ScheduledReports';
import { RichEditor } from '../components/RichEditor';
import './Manager.css';

import { todayInTimezone } from '../utils/dateUtils';

const VALID_TABS = new Set(['announcements', 'tasks', 'reports', 'integrations', 'users']);

export function Manager() {
  const { user, timezone } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab = tabParam && VALID_TABS.has(tabParam) ? tabParam : 'announcements';

  const setTab = (t) => {
    if (t === 'announcements') setSearchParams({}, { replace: true });
    else setSearchParams({ tab: t }, { replace: true });
  };
  const [templates, setTemplates] = useState([]);
  const [assignDate, setAssignDate] = useState(() => todayInTimezone(timezone));
  const [assignments, setAssignments] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [companyUsers, setCompanyUsers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [smsLog, setSmsLog] = useState([]);
  const [loading, setLoading] = useState(false);
  const [reportFrom, setReportFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), dy = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${dy}`;
  });
  const [reportTo, setReportTo] = useState(() => todayInTimezone(timezone));
  const [reportLocationId, setReportLocationId] = useState('');
  const [foodWasteReport, setFoodWasteReport] = useState(null);
  const [taskReport, setTaskReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [activeReport, setActiveReport] = useState('food-waste');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [wageTitles, setWageTitles] = useState([]);
  const [squareSchedule, setSquareSchedule] = useState(null); // null = not loaded, [] = loaded empty
  const [scheduleLoading, setScheduleLoading] = useState(false);
  // assignee selection per template: templateId → userId ('' = unassigned)
  const [assigneeFor, setAssigneeFor] = useState({});

  const isManager = user?.role === 'manager' || user?.role === 'owner';
  if (!isManager) {
    return (
      <div className="manager-page">
        <p>Manager access required.</p>
        <Link to="/">Back to dashboard</Link>
      </div>
    );
  }

  if (tabParam === 'ingredients') {
    return <Navigate to="/food/ingredients" replace />;
  }

  const loadTemplates = async () => {
    try {
      const r = await getTaskTemplates();
      setTemplates(r.templates || []);
    } catch (e) {
      setError(e.message);
    }
  };

  const loadAssignments = async () => {
    try {
      const r = await getAssignments(assignDate);
      setAssignments(r.assignments || []);
    } catch (e) {
      setError(e.message);
    }
  };

  const loadAnnouncements = async () => {
    try {
      const r = await getAnnouncements();
      setAnnouncements(r.announcements || []);
    } catch (e) {
      setError(e.message);
    }
  };

  const loadUsers = async () => {
    if (!user?.company_id) return;
    try {
      const r = await getCompanyUsers(user.company_id);
      setCompanyUsers(r.users || []);
    } catch (e) {
      setError(e.message);
    }
  };

  const loadSmsLog = async () => {
    try {
      const r = await getSmsLog();
      setSmsLog(r.log || []);
    } catch (e) {
      setError(e.message);
    }
  };

  const loadLocations = async () => {
    try {
      const r = await getLocations();
      setLocations(r.locations || []);
    } catch (e) {
      setError(e.message);
    }
  };

  const loadSquareSchedule = async (date) => {
    setScheduleLoading(true);
    setSquareSchedule(null);
    try {
      const r = await getSquareSchedule(date);
      setSquareSchedule(r.schedule || []);
      // Pre-select assignees: for each template with a wage_title, pick the first
      // scheduled staff member whose shift role matches
      setAssigneeFor((prev) => {
        const next = { ...prev };
        // Will be resolved after templates are loaded; see handleAssignDateChange
        return next;
      });
    } catch {
      setSquareSchedule([]); // fail gracefully — don't block the rest of the UI
    } finally {
      setScheduleLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'tasks') {
      loadTemplates();
      loadAssignments();
      loadLocations();
      loadUsers();
      getWageTitles().then((r) => setWageTitles(r.wage_titles || [])).catch(() => {});
      loadSquareSchedule(assignDate);
    } else if (tab === 'announcements') {
      loadAnnouncements();
      loadLocations();
      loadUsers();
    } else if (tab === 'users') {
      loadUsers();
      loadLocations();
    } else if (tab === 'reports') {
      loadLocations();
    } else if (tab === 'integrations') {
      loadUsers();
      loadSmsLog();
    }
  }, [tab, assignDate]);

  const handleCreateAssignment = async (templateId, assigneeId) => {
    setError('');
    try {
      await createAssignment(templateId, assignDate, assigneeId || null);
      loadAssignments();
      setMessage('Assignment created');
    } catch (e) {
      setError(e.message);
    }
  };

  const handleSendSms = async (userIds, messageBody) => {
    if (!userIds?.length) {
      setError('Select at least one recipient');
      return;
    }
    if (!messageBody?.trim()) {
      setError('Enter a message');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await sendSms(userIds, messageBody.trim());
      setMessage('SMS sent');
      loadSmsLog();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAssignment = async (id) => {
    if (!window.confirm('Remove this assignment for this day?')) return;
    setError('');
    try {
      await deleteAssignment(id);
      loadAssignments();
      setMessage('Assignment removed');
    } catch (e) {
      setError(e.message);
    }
  };

  const handleUserRoleChange = async (userId, role) => {
    setError('');
    try {
      await updateUser(user.company_id, userId, { role });
      setMessage('Role updated');
      loadUsers();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleUserSetPassword = async (userId, newPassword) => {
    if (!newPassword || newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await updateUser(user.company_id, userId, { password: newPassword });
      setMessage('Password updated');
      loadUsers();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSendResetEmail = async (userId) => {
    setError('');
    setLoading(true);
    try {
      await sendPasswordResetEmail(userId);
      setMessage('Reset link sent to user email');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async (userId) => {
    if (userId === user?.id) {
      setError('You cannot delete your own account');
      return;
    }
    if (!window.confirm('Remove this user from the company? They will no longer be able to log in.')) return;
    setError('');
    setLoading(true);
    try {
      await deleteUser(user.company_id, userId);
      setMessage('User removed');
      loadUsers();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const runFoodWasteReport = async () => {
    setError('');
    setReportLoading(true);
    setFoodWasteReport(null);
    try {
      const r = await getFoodWasteReport(reportFrom, reportTo, reportLocationId || undefined);
      setFoodWasteReport(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setReportLoading(false);
    }
  };

  const runTaskReport = async () => {
    setError('');
    setReportLoading(true);
    setTaskReport(null);
    try {
      const r = await getTaskReport(reportFrom, reportTo);
      setTaskReport(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setReportLoading(false);
    }
  };

  const handleUserLocationChange = async (userId, location_ids) => {
    setError('');
    try {
      await updateUser(user.company_id, userId, { location_ids });
      setMessage('Locations updated');
      loadUsers();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="manager-page">
      {error && <p className="manager-error">{error}</p>}
      {message && <p className="manager-message">{message}</p>}

      {tab === 'tasks' && (
        <section className="manager-section">
          <h2>Task list templates</h2>
          <TaskListTemplateForm locations={locations} wageTitles={wageTitles} onCreated={loadTemplates} />
          <ul className="template-list">
            {templates.map((t) => (
              <TaskTemplateRow
                key={t.id}
                template={t}
                locations={locations}
                wageTitles={wageTitles}
                onUpdate={loadTemplates}
                onAssign={() => handleCreateAssignment(t.id)}
                assignDate={assignDate}
              />
            ))}
          </ul>
          <h2>Assign task list to day</h2>
          <div className="assign-row">
            <input
              type="date"
              value={assignDate}
              onChange={(e) => {
                setAssignDate(e.target.value);
                loadSquareSchedule(e.target.value);
              }}
            />
          </div>

          {/* Live Square schedule */}
          <div className="schedule-panel">
            <h3 className="schedule-panel-title">
              Scheduled staff for {assignDate}
              <span className="schedule-source-badge">Live from Square</span>
            </h3>
            {scheduleLoading ? (
              <p className="schedule-loading">Loading schedule…</p>
            ) : squareSchedule === null ? null : squareSchedule.length === 0 ? (
              <p className="schedule-empty">No shifts found for this date.</p>
            ) : (
              <ul className="schedule-list">
                {squareSchedule.map((s, i) => {
                  const fmt = (iso) => iso
                    ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                    : '—';
                  return (
                    <li key={i} className="schedule-item">
                      <span className="schedule-name">{s.display_name}</span>
                      <span className="schedule-role">{s.wage_title || 'No role'}</span>
                      <span className="schedule-time">{fmt(s.shift_start)} – {fmt(s.shift_end)}</span>
                      {s.status === 'OPEN' && !s.shift_end && (
                        <span className="schedule-badge-active">Clocked in</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Assign templates */}
          <div className="assign-templates-panel">
            <h3 className="assign-templates-title">Assign templates to {assignDate}</h3>
            <ul className="assign-template-list">
              {templates.map((t) => {
                // Find matching scheduled staff (same wage_title)
                const matchingStaff = (squareSchedule || []).filter(
                  (s) => t.wage_title && s.wage_title === t.wage_title
                );
                const selectedAssignee = assigneeFor[t.id] ?? (matchingStaff[0]?.user_id || '');
                const alreadyAssigned = assignments.some((a) => a.template_id === t.id);
                return (
                  <li key={t.id} className={`assign-template-item${alreadyAssigned ? ' already-assigned' : ''}`}>
                    <span className="assign-template-name">
                      {t.name}
                      {t.wage_title && <span className="wage-title-badge">{t.wage_title}</span>}
                    </span>
                    <div className="assign-template-controls">
                      <select
                        className="assign-user-select"
                        value={assigneeFor[t.id] ?? (matchingStaff[0]?.user_id || '')}
                        onChange={(e) => setAssigneeFor((prev) => ({ ...prev, [t.id]: e.target.value }))}
                      >
                        <option value="">Unassigned</option>
                        {/* Scheduled staff first */}
                        {matchingStaff.length > 0 && (
                          <optgroup label="Scheduled today (matching role)">
                            {matchingStaff.map((s) => (
                              <option key={s.user_id} value={s.user_id}>{s.display_name}</option>
                            ))}
                          </optgroup>
                        )}
                        {/* All other staff */}
                        {companyUsers.length > 0 && (
                          <optgroup label="All staff">
                            {companyUsers
                              .filter((u) => !matchingStaff.some((s) => s.user_id === u.id))
                              .map((u) => (
                                <option key={u.id} value={u.id}>{u.display_name}</option>
                              ))}
                          </optgroup>
                        )}
                      </select>
                      {alreadyAssigned ? (
                        <span className="assign-done-badge">✓ Assigned</span>
                      ) : (
                        <button
                          type="button"
                          className="btn-assign-template"
                          onClick={() => handleCreateAssignment(t.id, assigneeFor[t.id] ?? (matchingStaff[0]?.user_id || ''))}
                        >
                          Assign
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <h3 className="assignments-heading">Current assignments for {assignDate}</h3>
          <ul className="assignment-list">
            {assignments.length === 0 ? (
              <li className="assignment-empty">None yet.</li>
            ) : assignments.map((a) => (
              <li key={a.id}>
                <span className="assignment-name">{a.template_name}</span>
                {a.assignee_name && <span className="assignment-assignee">→ {a.assignee_name}</span>}
                <button type="button" className="btn-remove" onClick={() => handleDeleteAssignment(a.id)}>Remove</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'announcements' && (
        <div>
          <h2>Announcements</h2>
          <PendingMyApproval userId={user?.id} onUpdate={loadAnnouncements} />
          <AnnouncementForm locations={locations} timezone={timezone} users={companyUsers} onCreated={loadAnnouncements} />
          <ul className="announcement-list">
            {announcements.map((a) => (
              <li key={a.id}>
                <AnnouncementEditDelete announcement={a} locations={locations} users={companyUsers} currentUserId={user?.id} onUpdate={loadAnnouncements} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'reports' && (
        <section className="manager-section">
          <h2>Reports</h2>
          <nav className="manager-report-picker" aria-label="Available reports">
            <button
              type="button"
              className={activeReport === 'food-waste' ? 'active' : ''}
              onClick={() => setActiveReport('food-waste')}
            >
              Food waste report
            </button>
            <button
              type="button"
              className={activeReport === 'tasks' ? 'active' : ''}
              onClick={() => setActiveReport('tasks')}
            >
              Task completion report
            </button>
            <button
              type="button"
              className={activeReport === 'debt' ? 'active' : ''}
              onClick={() => setActiveReport('debt')}
            >
              Debt report
            </button>
            {isManager && (
              <button
                type="button"
                className={activeReport === 'scheduled' ? 'active' : ''}
                onClick={() => setActiveReport('scheduled')}
              >
                Scheduled reports
              </button>
            )}
          </nav>

          {activeReport !== 'scheduled' && (
          <p className="hint">
            {activeReport === 'debt'
              ? 'Debt report compares month-end balances for two calendar years. Edit the table and save.'
              : 'Pick a report, set the date range, then run. More reports can be added here over time.'}
          </p>
          )}

          {activeReport !== 'debt' && activeReport !== 'scheduled' && (
          <div className="report-filters">
            <label>
              From
              <input
                type="date"
                value={reportFrom}
                onChange={(e) => setReportFrom(e.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={reportTo}
                onChange={(e) => setReportTo(e.target.value)}
              />
            </label>
          </div>
          )}

          {activeReport === 'food-waste' && (
            <div className="manager-report-panel">
              <h3 className="manager-report-panel-title">Food waste summary</h3>
              <p className="hint">Total quantity (grams) per ingredient for the selected period. Optionally filter by location.</p>
              {locations.length > 0 && (
                <label className="report-location-filter">
                  Location
                  <select value={reportLocationId} onChange={(e) => setReportLocationId(e.target.value)}>
                    <option value="">All locations</option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>{loc.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <div>
                <button type="button" onClick={runFoodWasteReport} disabled={reportLoading}>
                  {reportLoading ? 'Running…' : 'Run report'}
                </button>
              </div>
              {foodWasteReport && (
                <div className="report-result">
                  <p className="report-meta">
                    {foodWasteReport.from} – {foodWasteReport.to}
                    {foodWasteReport.location_name ? ` · ${foodWasteReport.location_name}` : ' · All locations'}
                  </p>
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th>Ingredient</th>
                        <th>Total (g)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {foodWasteReport.rows.length === 0 ? (
                        <tr><td colSpan={2}>No waste recorded in this period.</td></tr>
                      ) : (
                        foodWasteReport.rows.map((row) => (
                          <tr key={row.ingredient_id}>
                            <td>{row.ingredient_name}</td>
                            <td>{Number(row.total_quantity).toLocaleString()}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeReport === 'tasks' && (
            <div className="manager-report-panel">
              <h3 className="manager-report-panel-title">Task completions</h3>
              <p className="hint">Tasks completed in the selected date range (by assigned date).</p>
              <div>
                <button type="button" onClick={runTaskReport} disabled={reportLoading}>
                  {reportLoading ? 'Running…' : 'Run report'}
                </button>
              </div>
              {taskReport && (
                <div className="report-result">
                  <p className="report-meta">{taskReport.from} – {taskReport.to}</p>
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Template</th>
                        <th>Task</th>
                        <th>Assignee</th>
                        <th>Completed by</th>
                        <th>Completed at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {taskReport.rows.length === 0 ? (
                        <tr><td colSpan={6}>No completions in this period.</td></tr>
                      ) : (
                        taskReport.rows.map((row, idx) => (
                          <tr key={idx}>
                            <td>{row.assigned_date}</td>
                            <td>{row.template_name}</td>
                            <td>{row.task_title}</td>
                            <td>{row.assignee_name || '—'}</td>
                            <td>{row.completed_by_name || '—'}</td>
                            <td>{row.completed_at ? new Date(row.completed_at).toLocaleString() : '—'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeReport === 'debt' && <DebtReportSection />}

          {activeReport === 'scheduled' && isManager && <ScheduledReports />}
        </section>
      )}

      {tab === 'users' && (
        <section className="manager-section">
          <h2>Users &amp; roles</h2>
          <p className="hint">Manage roles and passwords. Passwords are not shown; use Set password or Send reset email.</p>
          <ul className="user-list">
            {companyUsers.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                locations={locations}
                currentUserId={user?.id}
                onRoleChange={(role) => handleUserRoleChange(u.id, role)}
                onLocationChange={(locationIds) => handleUserLocationChange(u.id, locationIds)}
                onSetPassword={(password) => handleUserSetPassword(u.id, password)}
                onSendResetEmail={() => handleSendResetEmail(u.id)}
                onDelete={() => handleDeleteUser(u.id)}
                loading={loading}
              />
            ))}
          </ul>
          <h2 className="manager-subsection-title">Locations</h2>
          <p className="hint">Add locations for this company. Then assign users, announcements, and task templates to one or many locations.</p>
          <LocationsCrud
            locations={locations}
            onUpdate={loadLocations}
            saving={loading}
            onSavingChange={setLoading}
            onError={setError}
            onMessage={setMessage}
          />
        </section>
      )}

      {tab === 'integrations' && (
        <section className="manager-section">
          <h2>SMS Send</h2>
          <p className="hint">Send SMS via Twilio. Manage AiRon user exclusions under <Link to="/settings?tab=square">Settings → AiRon</Link>.</p>
          <SmsSendForm
            users={companyUsers}
            loading={loading}
            onSend={handleSendSms}
          />
          <h3>SMS log</h3>
          <ul className="sms-log">
            {smsLog.slice(0, 20).map((s) => (
              <li key={s.id}>{s.created_at} → {s.recipient_name || s.recipient_phone}: {s.status}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function LocationsCrud({ locations, onUpdate, saving, onSavingChange, onError, onMessage }) {
  const [newLocationName, setNewLocationName] = useState('');
  const [newSquareLocationId, setNewSquareLocationId] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [editingSquareId, setEditingSquareId] = useState('');
  const [squareLocations, setSquareLocations] = useState([]);

  useEffect(() => {
    getSquareLocations().then((r) => setSquareLocations(r.locations || [])).catch(() => {});
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    const name = newLocationName.trim();
    if (!name) return;
    onError('');
    onSavingChange(true);
    try {
      await createLocation({ name, square_location_id: newSquareLocationId || null });
      setNewLocationName('');
      setNewSquareLocationId('');
      onUpdate();
      onMessage('Location added.');
    } catch (err) {
      onError(err.message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!editingId) return;
    const name = editingName.trim();
    if (!name) return;
    onError('');
    onSavingChange(true);
    try {
      await updateLocation(editingId, { name, square_location_id: editingSquareId || null });
      setEditingId(null);
      setEditingName('');
      setEditingSquareId('');
      onUpdate();
      onMessage('Location updated.');
    } catch (err) {
      onError(err.message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this location? Users, announcements, and templates will no longer be assigned to it.')) return;
    onError('');
    onSavingChange(true);
    try {
      await deleteLocation(id);
      setEditingId(null);
      setEditingName('');
      setEditingSquareId('');
      onUpdate();
      onMessage('Location deleted.');
    } catch (err) {
      onError(err.message);
    } finally {
      onSavingChange(false);
    }
  };

  const squareSelect = (value, onChange) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: '12rem' }}>
      <option value="">— No Square location —</option>
      {squareLocations.map((sl) => (
        <option key={sl.id} value={sl.id}>{sl.name}</option>
      ))}
    </select>
  );

  return (
    <>
      <form onSubmit={handleAdd} className="form-inline" style={{ marginBottom: '1rem' }}>
        <input
          type="text"
          placeholder="New location name"
          value={newLocationName}
          onChange={(e) => setNewLocationName(e.target.value)}
          autoComplete="off"
        />
        {squareSelect(newSquareLocationId, setNewSquareLocationId)}
        <button type="submit" disabled={saving || !newLocationName.trim()}>{saving ? 'Adding…' : 'Add location'}</button>
      </form>
      {locations.length === 0 ? (
        <p className="hint">No locations yet. Add one above.</p>
      ) : (
        <ul className="manager-locations-list">
          {locations.map((loc) => (
            <li key={loc.id}>
              {editingId === loc.id ? (
                <form onSubmit={handleUpdate} className="form-inline">
                  <input
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    autoFocus
                    autoComplete="off"
                  />
                  {squareSelect(editingSquareId, setEditingSquareId)}
                  <button type="submit" disabled={saving}>Save</button>
                  <button type="button" onClick={() => { setEditingId(null); setEditingName(''); setEditingSquareId(''); }}>Cancel</button>
                </form>
              ) : (
                <>
                  <span>{loc.name}</span>
                  {loc.square_location_id && (
                    <span className="hint" style={{ fontSize: '0.8em', marginLeft: '0.5rem' }}>
                      ({squareLocations.find((sl) => sl.id === loc.square_location_id)?.name || loc.square_location_id})
                    </span>
                  )}
                  <button type="button" className="btn-small" onClick={() => {
                    setEditingId(loc.id);
                    setEditingName(loc.name);
                    setEditingSquareId(loc.square_location_id || '');
                  }}>Edit</button>
                  <button type="button" className="btn-remove btn-small" onClick={() => handleDelete(loc.id)}>Delete</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function UserRow({ user, locations, currentUserId, onRoleChange, onLocationChange, onSetPassword, onSendResetEmail, onDelete, loading }) {
  const [showSetPassword, setShowSetPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const handleSetPassword = (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) return;
    onSetPassword(newPassword);
    setNewPassword('');
    setConfirmPassword('');
    setShowSetPassword(false);
  };

  const userLocationIds = Array.isArray(user.location_ids) ? user.location_ids : [];
  const handleLocationToggle = (locationId) => {
    const next = userLocationIds.includes(locationId)
      ? userLocationIds.filter((id) => id !== locationId)
      : [...userLocationIds, locationId];
    onLocationChange(next);
  };

  const isSelf = user.id === currentUserId;

  return (
    <li className="user-row">
      <span className="user-name">{user.display_name || '—'}</span>
      <span className="user-email">{user.email}</span>
      <select
        value={user.role}
        onChange={(e) => onRoleChange(e.target.value)}
        className="user-role-select"
        disabled={loading}
      >
        <option value="member">User</option>
        <option value="gc">User + GControl</option>
        <option value="manager">Manager</option>
        <option value="owner">Owner</option>
      </select>
      {locations && locations.length > 0 && (
        <span className="user-locations">
          Locations:{' '}
          {locations.map((loc) => (
            <label key={loc.id} className="user-location-checkbox">
              <input
                type="checkbox"
                checked={userLocationIds.includes(loc.id)}
                onChange={() => handleLocationToggle(loc.id)}
                disabled={loading}
              />
              {loc.name}
            </label>
          ))}
        </span>
      )}
      <span className="user-actions">
        <button type="button" className="btn-small" onClick={() => setShowSetPassword(!showSetPassword)} disabled={loading}>
          Set password
        </button>
        <button type="button" className="btn-small" onClick={onSendResetEmail} disabled={loading}>
          Send reset email
        </button>
        {!isSelf && (
          <button type="button" className="btn-remove btn-small" onClick={onDelete} disabled={loading}>
            Delete
          </button>
        )}
      </span>
      {showSetPassword && (
        <form onSubmit={handleSetPassword} className="user-set-password-form">
          <input
            type="password"
            placeholder="New password (min 6)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={6}
            autoComplete="new-password"
          />
          <input
            type="password"
            placeholder="Confirm"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
          <button type="submit" disabled={loading || newPassword.length < 6 || newPassword !== confirmPassword}>Save password</button>
          <button type="button" onClick={() => { setShowSetPassword(false); setNewPassword(''); setConfirmPassword(''); }}>Cancel</button>
        </form>
      )}
    </li>
  );
}

function PendingMyApproval({ userId, onUpdate }) {
  const [items, setItems] = useState([]);
  const [comments, setComments] = useState({});
  const [loading, setLoading] = useState({});

  useEffect(() => {
    getPendingMyApproval()
      .then((r) => setItems(r.announcements || []))
      .catch(() => {});
  }, [userId]);

  const handleDecision = async (id, status) => {
    setLoading((prev) => ({ ...prev, [id]: true }));
    try {
      await approveAnnouncement(id, status, comments[id] || '');
      setItems((prev) => prev.filter((a) => a.id !== id));
      onUpdate();
    } catch (e) {
      alert(e.message);
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }));
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="pending-approvals-section">
      <h3 className="pending-approvals-title">Awaiting Your Approval</h3>
      {items.map((a) => (
        <div key={a.id} className="pending-approval-card">
          <div className="pending-approval-info">
            <strong>{a.title}</strong>
            <span className="ann-meta">
              {a.effective_from} – {a.effective_until} &middot; by {a.created_by_name || 'unknown'}
            </span>
          </div>
          <div className="pending-approval-actions">
            <textarea
              className="approval-comment"
              placeholder="Optional comment…"
              value={comments[a.id] || ''}
              onChange={(e) => setComments((prev) => ({ ...prev, [a.id]: e.target.value }))}
              rows={2}
            />
            <div className="approval-buttons">
              <button
                type="button"
                className="btn-approve"
                disabled={loading[a.id]}
                onClick={() => handleDecision(a.id, 'approved')}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn-reject"
                disabled={loading[a.id]}
                onClick={() => handleDecision(a.id, 'rejected')}
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AnnouncementForm({ locations, timezone, users, onCreated }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [from, setFrom] = useState(() => todayInTimezone(timezone));
  const [to, setTo] = useState(() => todayInTimezone(timezone));
  const [locationIds, setLocationIds] = useState([]);
  const [approverIds, setApproverIds] = useState([]);
  const [isPolicy, setIsPolicy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [editorKey, setEditorKey] = useState(0);

  const toggleLocation = (id) => {
    setLocationIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };
  const toggleApprover = (id) => {
    setApproverIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const handleImageUpload = async (file) => uploadAnnouncementImage(file);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (locationIds.length === 0) {
      setErr('Select at least one location for this announcement.');
      return;
    }
    setLoading(true);
    try {
      await createAnnouncement(title, body, from, to, locationIds, approverIds, isPolicy);
      setTitle('');
      setBody('');
      setLocationIds([]);
      setApproverIds([]);
      setIsPolicy(false);
      setEditorKey((k) => k + 1);
      onCreated();
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  const isDraft = approverIds.length > 0;
  const managers = (users || []).filter((u) => u.role === 'manager' || u.role === 'owner');

  return (
    <form onSubmit={submit} className="form-announcement">
      <div className="ann-edit-field">
        <label className="ann-edit-label">Title <span className="required-star">*</span></label>
        <input
          className="ann-edit-input"
          placeholder="Announcement title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>
      <div className="ann-edit-field">
        <label className="ann-edit-label">Body</label>
        <RichEditor
          key={editorKey}
          initialContent=""
          onChange={setBody}
          onImageUpload={handleImageUpload}
          placeholder="Optional — additional detail, formatting, or images"
        />
      </div>
      <div className="ann-edit-dates">
        <label className="ann-edit-label-inline">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="ann-edit-label-inline">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="form-locations">
        <span className="ann-edit-label">Location <span className="required-star">*</span></span>
        {locations && locations.length > 0 ? locations.map((loc) => (
          <label key={loc.id} className="location-checkbox">
            <input
              type="checkbox"
              checked={locationIds.includes(loc.id)}
              onChange={() => toggleLocation(loc.id)}
            />
            {loc.name}
          </label>
        )) : <span className="hint"> No locations configured.</span>}
      </div>
      <div className="ann-edit-field">
        <label className="location-checkbox">
          <input type="checkbox" checked={isPolicy} onChange={(e) => setIsPolicy(e.target.checked)} />
          This is a Policy (requires every employee to sign)
        </label>
        {isPolicy && (
          <p className="hint">
            Policies never expire on their own — every current and future employee must sign
            before it disappears from their task gate. Mark it "no longer required" later to stop
            requiring new signatures.
          </p>
        )}
      </div>
      {managers.length > 0 && (
        <div className="form-approvers">
          <span className="ann-edit-label">Request approval from (optional)</span>
          <div className="approver-list">
            {managers.map((u) => (
              <label key={u.id} className="location-checkbox">
                <input
                  type="checkbox"
                  checked={approverIds.includes(u.id)}
                  onChange={() => toggleApprover(u.id)}
                />
                {u.display_name || u.email}
              </label>
            ))}
          </div>
          {isDraft && (
            <p className="hint">Announcement will be saved as a draft until you publish it.</p>
          )}
        </div>
      )}
      {err && <p className="form-error">{err}</p>}
      <button type="submit" disabled={loading}>
        {isDraft ? 'Save as draft' : 'Publish announcement'}
      </button>
    </form>
  );
}

function WhoRead({ id }) {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    getAnnouncementAcknowledgments(id).then((r) => setList(r.acknowledgments || [])).catch(() => {});
  }, [id, open]);
  return (
    <span>
      <button type="button" onClick={() => setOpen(!open)}>Who read</button>
      {open && <ul>{list.map((a) => <li key={a.id}>{a.display_name || a.email} @ {a.acknowledged_at}</li>)}</ul>}
    </span>
  );
}

const PERIOD_TYPES = ['daily', 'weekly', 'monthly', 'yearly', 'one_time'];

const TASK_TEMPLATE_TYPES = [
  { value: 'opening', label: 'Opening' },
  { value: 'closing', label: 'Closing' },
  { value: 'free_time', label: 'Free Time' },
];

function TaskListTemplateForm({ locations, wageTitles, onCreated }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('opening');
  const [period_type, setPeriodType] = useState('daily');
  const [day_of_week, setDayOfWeek] = useState(1);
  const [day_of_month, setDayOfMonth] = useState(1);
  const [recur_month, setRecurMonth] = useState(1);
  const [recur_day, setRecurDay] = useState(1);
  const [locationIds, setLocationIds] = useState([]);
  const [wageTitle, setWageTitle] = useState('');
  const [customRole, setCustomRole] = useState('');
  const [useCustomRole, setUseCustomRole] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // Auto-select first option when wageTitles first populates
  useEffect(() => {
    if (wageTitles.length > 0 && !wageTitle) {
      setWageTitle(wageTitles[0]);
    }
  }, [wageTitles]);

  const effectiveWageTitle = useCustomRole ? customRole : wageTitle;

  const handleRoleSelect = (e) => {
    if (e.target.value === '__custom__') {
      setUseCustomRole(true);
      setWageTitle('__custom__');
    } else {
      setUseCustomRole(false);
      setWageTitle(e.target.value);
    }
  };

  const toggleLocation = (id) => {
    setLocationIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (period_type === 'weekly' && (day_of_week == null || day_of_week < 0 || day_of_week > 6)) {
      setErr('Select a day of the week for weekly tasks.');
      return;
    }
    if (period_type === 'monthly' && (day_of_month < 1 || day_of_month > 31)) {
      setErr('Select day of month (1-31) for monthly tasks.');
      return;
    }
    if (period_type === 'yearly' && (recur_month < 1 || recur_month > 12 || recur_day < 1 || recur_day > 31)) {
      setErr('Select month and day for yearly tasks.');
      return;
    }
    if (!effectiveWageTitle.trim()) {
      setErr('A role is required for this task list.');
      return;
    }
    setLoading(true);
    try {
      const options = {};
      if (period_type === 'weekly') options.day_of_week = day_of_week;
      if (period_type === 'monthly') options.day_of_month = day_of_month;
      if (period_type === 'yearly') { options.recur_month = recur_month; options.recur_day = recur_day; }
      options.location_ids = locationIds;
      options.wage_title = effectiveWageTitle.trim();
      await createTaskListTemplate(name.trim(), type.trim(), period_type, options);
      setName('');
      setLocationIds([]);
      setWageTitle('');
      setCustomRole('');
      setUseCustomRole(false);
      onCreated();
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <form onSubmit={submit} className="form-inline">
      <input placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} required />
      <label className="form-inline-label">
        Type
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {TASK_TEMPLATE_TYPES.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </label>
      <select value={period_type} onChange={(e) => setPeriodType(e.target.value)}>
        {PERIOD_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      {period_type === 'weekly' && (
        <label className="form-inline-label">
          Day of week
          <select value={day_of_week} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
            {taskDayNames.map((label, i) => (
              <option key={i} value={i}>{label}</option>
            ))}
          </select>
        </label>
      )}
      {period_type === 'monthly' && (
        <label className="form-inline-label">
          Day of month
          <select value={day_of_month} onChange={(e) => setDayOfMonth(Number(e.target.value))}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>
      )}
      {period_type === 'yearly' && (
        <>
          <label className="form-inline-label">
            Month
            <select value={recur_month} onChange={(e) => setRecurMonth(Number(e.target.value))}>
              {taskMonthNames.map((label, i) => (
                <option key={i} value={i + 1}>{label}</option>
              ))}
            </select>
          </label>
          <label className="form-inline-label">
            Day
            <select value={recur_day} onChange={(e) => setRecurDay(Number(e.target.value))}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="form-inline-label">
        Role <span className="required-star">*</span>
        {wageTitles.length > 0 ? (
          <>
            <select value={useCustomRole ? '__custom__' : wageTitle} onChange={handleRoleSelect}>
              {wageTitles.map((wt) => (
                <option key={wt} value={wt}>{wt}</option>
              ))}
              <option value="__custom__">Other (type below)…</option>
            </select>
            {useCustomRole && (
              <input
                type="text"
                value={customRole}
                onChange={(e) => setCustomRole(e.target.value)}
                placeholder="e.g. Server, Bartender…"
                autoFocus
                style={{ marginTop: '0.3rem' }}
              />
            )}
          </>
        ) : (
          <input
            type="text"
            value={wageTitle}
            onChange={(e) => setWageTitle(e.target.value)}
            placeholder="e.g. Server, Bartender…"
          />
        )}
      </label>
      <span className="form-locations-inline">
        Locations{' '}
        {locations && locations.length > 0 ? (
          <>
            {locations.map((loc) => (
              <label key={loc.id} className="location-checkbox">
                <input type="checkbox" checked={locationIds.includes(loc.id)} onChange={() => toggleLocation(loc.id)} />
                {loc.name}
              </label>
            ))}
            {locationIds.length === 0 && <span className="hint"> (all locations)</span>}
          </>
        ) : <span className="hint">No locations configured — template will apply to all.</span>}
      </span>
      {err && <span className="form-error">{err}</span>}
      <button type="submit" disabled={loading}>Create template</button>
    </form>
  );
}

function TaskTemplateRow({ template, locations, wageTitles, onUpdate, onAssign, assignDate }) {
  const [tasks, setTasks] = useState([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState('must');
  // Drag state
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  // Inline name editing
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(template.name);
  const [nameSaving, setNameSaving] = useState(false);

  const loadTasks = () => {
    getTemplateTasks(template.id).then((r) => setTasks(r.tasks || [])).catch(() => {});
  };

  useEffect(() => {
    if (open) {
      getTemplateTasks(template.id).then((r) => setTasks(r.tasks || [])).catch(() => {});
    }
  }, [open, template.id]);

  const handleAddTask = async (e) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    setAdding(true);
    try {
      await createTaskItem(template.id, newTaskTitle.trim(), undefined, newTaskPriority);
      setNewTaskTitle('');
      setNewTaskPriority('must');
      loadTasks();
      onUpdate();
    } finally {
      setAdding(false);
    }
  };

  const handleTogglePriority = async (taskId, current) => {
    const next = current === 'must' ? 'try' : 'must';
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, priority: next } : t));
    try {
      await updateTaskItem(taskId, { priority: next });
    } catch (e) {
      // Revert on error
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, priority: current } : t));
      alert(e.message);
    }
  };

  // Drag-and-drop handlers
  const handleDragStart = (e, index) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (index !== dragOverIndex) setDragOverIndex(index);
  };

  const handleDrop = async (e, dropIndex) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null); setDragOverIndex(null);
      return;
    }
    const reordered = [...tasks];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(dropIndex, 0, moved);
    setTasks(reordered);
    setDragIndex(null);
    setDragOverIndex(null);
    try {
      await reorderTemplateTasks(template.id, reordered.map((t) => t.id));
    } catch (e) {
      loadTasks(); // revert to server order on error
      alert(e.message);
    }
  };

  const handleDragEnd = () => { setDragIndex(null); setDragOverIndex(null); };

  const handleNameSave = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === template.name) { setEditingName(false); return; }
    setNameSaving(true);
    try {
      await updateTaskListTemplate(template.id, { name: trimmed });
      onUpdate();
      setEditingName(false);
    } catch (e) {
      alert(e.message);
    } finally {
      setNameSaving(false);
    }
  };

  const handleNameKeyDown = (e) => {
    if (e.key === 'Enter') handleNameSave();
    if (e.key === 'Escape') { setNameInput(template.name); setEditingName(false); }
  };

  const handleDeleteTemplate = async () => {
    if (!window.confirm(`Delete template "${template.name}" and its tasks?`)) return;
    try {
      await deleteTaskListTemplate(template.id);
      onUpdate();
    } catch (e) {
      alert(e.message);
    }
  };

  const handleDeleteTask = async (taskId) => {
    try {
      await deleteTaskItem(taskId);
      loadTasks();
      onUpdate();
    } catch (e) {
      alert(e.message);
    }
  };

  return (
    <li className="template-row">
      <span className="template-row-title">
        <button type="button" className="btn-expand" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? '−' : '+'}
        </button>
        {editingName ? (
          <>
            <input
              className="template-name-input"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={handleNameKeyDown}
              onBlur={handleNameSave}
              disabled={nameSaving}
              autoFocus
            />
            <button type="button" className="btn-name-save" onClick={handleNameSave} disabled={nameSaving}>
              {nameSaving ? '…' : '✓'}
            </button>
            <button type="button" className="btn-name-cancel" onClick={() => { setNameInput(template.name); setEditingName(false); }}>
              ✕
            </button>
          </>
        ) : (
          <>
            <span className="template-name-text">
              {template.name}
            </span>
            <button
              type="button"
              className="btn-name-edit"
              onClick={() => { setNameInput(template.name); setEditingName(true); }}
              aria-label="Edit name"
              title="Edit name"
            >
              ✎
            </button>
            {' '}({TASK_TEMPLATE_TYPES.find((t) => t.value === template.type)?.label ?? template.type}, {template.period_type}
            {template.period_type === 'weekly' && template.day_of_week != null ? `, ${taskDayNames[template.day_of_week]}` : ''}
            {template.period_type === 'monthly' && template.day_of_month != null ? `, day ${template.day_of_month}` : ''}
            {template.period_type === 'yearly' && template.recur_month != null && template.recur_day != null ? `, ${taskMonthNames[template.recur_month - 1]} ${template.recur_day}` : ''})
            {template.wage_title && <span className="wage-title-badge">{template.wage_title}</span>}
          </>
        )}
      </span>
      <span className="template-row-actions">
        {template.period_type === 'weekly' ? (
          <span className="template-recurrence-hint">Shows every {taskDayNames[template.day_of_week ?? 0]}</span>
        ) : template.period_type === 'daily' ? (
          <span className="template-recurrence-hint">Shows every day</span>
        ) : template.period_type === 'monthly' ? (
          <span className="template-recurrence-hint">Shows on day {template.day_of_month ?? 1} each month</span>
        ) : template.period_type === 'yearly' ? (
          <span className="template-recurrence-hint">Shows {template.recur_month != null && template.recur_day != null ? `${taskMonthNames[template.recur_month - 1]} ${template.recur_day} each year` : 'yearly'}</span>
        ) : (
          <button type="button" onClick={onAssign}>Assign to this day</button>
        )}
        <button type="button" className="btn-remove" onClick={handleDeleteTemplate}>Delete template</button>
      </span>
      {open && (
        <div className="template-tasks">
          <p className="template-wage-title">
            Assigned role:{' '}
            <select
              value={template.wage_title || ''}
              onChange={(e) => {
                const val = e.target.value || null;
                updateTaskListTemplate(template.id, { wage_title: val ?? '' }).then(onUpdate).catch((err) => alert(err.message));
              }}
            >
              <option value="">All roles</option>
              {wageTitles.map((wt) => (
                <option key={wt} value={wt}>{wt}</option>
              ))}
              {/* Show current value even if not in wageTitles list */}
              {template.wage_title && !wageTitles.includes(template.wage_title) && (
                <option value={template.wage_title}>{template.wage_title}</option>
              )}
            </select>
          </p>
          {template.period_type === 'weekly' && (
            <p className="template-weekly-day">
              Show on:{' '}
              <select
                value={template.day_of_week != null ? template.day_of_week : ''}
                onChange={(e) => {
                  const val = e.target.value === '' ? null : Number(e.target.value);
                  updateTaskListTemplate(template.id, { period_type: 'weekly', day_of_week: val }).then(onUpdate).catch((err) => alert(err.message));
                }}
              >
                <option value="">Select day</option>
                {taskDayNames.map((label, i) => (
                  <option key={i} value={i}>{label}</option>
                ))}
              </select>
            </p>
          )}
          {template.period_type === 'monthly' && (
            <p className="template-monthly-day">
              Day of month:{' '}
              <select
                value={template.day_of_month != null ? Number(template.day_of_month) : ''}
                onChange={(e) => {
                  const val = e.target.value === '' ? null : Number(e.target.value);
                  updateTaskListTemplate(template.id, { period_type: 'monthly', day_of_month: val }).then(onUpdate).catch((err) => alert(err.message));
                }}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </p>
          )}
          {template.period_type === 'yearly' && (
            <p className="template-yearly-date">
              Date:{' '}
              <select
                value={template.recur_month != null ? Number(template.recur_month) : ''}
                onChange={(e) => updateTaskListTemplate(template.id, { period_type: 'yearly', recur_month: Number(e.target.value), recur_day: template.recur_day != null ? Number(template.recur_day) : 1 }).then(onUpdate).catch((err) => alert(err.message))}
              >
                {taskMonthNames.map((label, i) => (
                  <option key={i} value={i + 1}>{label}</option>
                ))}
              </select>
              <select
                value={template.recur_day != null ? Number(template.recur_day) : ''}
                onChange={(e) => updateTaskListTemplate(template.id, { period_type: 'yearly', recur_month: template.recur_month != null ? Number(template.recur_month) : 1, recur_day: Number(e.target.value) }).then(onUpdate).catch((err) => alert(err.message))}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </p>
          )}
          {locations && locations.length > 0 && (
            <p className="template-locations">
              Locations (empty = all):{' '}
              {locations.map((loc) => {
                const templateLocationIds = Array.isArray(template.location_ids) ? template.location_ids : [];
                const checked = templateLocationIds.includes(loc.id);
                return (
                  <label key={loc.id} className="location-checkbox">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? templateLocationIds.filter((id) => id !== loc.id)
                          : [...templateLocationIds, loc.id];
                        updateTaskListTemplate(template.id, { location_ids: next }).then(onUpdate).catch((err) => alert(err.message));
                      }}
                    />
                    {loc.name}
                  </label>
                );
              })}
            </p>
          )}
          <ul className="task-edit-list">
            {tasks.map((t, index) => (
              <li
                key={t.id}
                className={[
                  'task-edit-row',
                  dragIndex === index ? 'task-dragging' : '',
                  dragOverIndex === index && dragIndex !== index ? 'task-drag-over' : '',
                ].filter(Boolean).join(' ')}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
              >
                <span className="drag-handle" aria-hidden>⠿</span>
                <span className="task-edit-title">{t.title}</span>
                <button
                  type="button"
                  className={`priority-toggle priority-${t.priority || 'must'}`}
                  onClick={() => handleTogglePriority(t.id, t.priority || 'must')}
                  title="Toggle priority"
                >
                  {t.priority === 'try' ? 'Try' : 'Must'}
                </button>
                <button type="button" className="btn-remove small" onClick={() => handleDeleteTask(t.id)}>Remove</button>
              </li>
            ))}
          </ul>
          <form onSubmit={handleAddTask} className="form-inline">
            <input placeholder="New task title" value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} />
            <select value={newTaskPriority} onChange={(e) => setNewTaskPriority(e.target.value)} className="priority-select-new">
              <option value="must">Must</option>
              <option value="try">Try</option>
            </select>
            <button type="submit" disabled={adding}>Add task</button>
          </form>
        </div>
      )}
    </li>
  );
}

function AnnouncementEditDelete({ announcement, locations, users, currentUserId, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(announcement.title);
  const [body, setBody] = useState(announcement.body || '');
  const [from, setFrom] = useState(announcement.effective_from);
  const [to, setTo] = useState(announcement.effective_until);
  const [locationIds, setLocationIds] = useState(Array.isArray(announcement.location_ids) ? announcement.location_ids : []);
  const [approverIds, setApproverIds] = useState(
    Array.isArray(announcement.approvals) ? announcement.approvals.map((a) => a.approver_id) : []
  );
  const [loading, setLoading] = useState(false);

  const toggleLocation = (id) => {
    setLocationIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };
  const toggleApprover = (id) => {
    setApproverIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await updateAnnouncement(announcement.id, {
        title, body,
        effective_from: from,
        effective_until: to,
        location_ids: locationIds,
        approver_ids: approverIds,
      });
      setEditing(false);
      onUpdate();
    } catch (e) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this announcement?')) return;
    try {
      await deleteAnnouncement(announcement.id);
      onUpdate();
    } catch (e) {
      alert(e.message);
    }
  };

  const handlePublish = async () => {
    if (!window.confirm('Publish this announcement now? It will become visible to staff.')) return;
    try {
      await publishAnnouncement(announcement.id);
      onUpdate();
    } catch (e) {
      alert(e.message);
    }
  };

  const handleTogglePolicyRequired = async () => {
    const nextRequired = !announcement.policy_required;
    if (nextRequired === false && !window.confirm('Mark this policy as no longer required? Employees who have not yet signed will no longer be blocked by it.')) {
      return;
    }
    try {
      await updateAnnouncement(announcement.id, { policy_required: nextRequired });
      onUpdate();
    } catch (e) {
      alert(e.message);
    }
  };

  const status = announcement.status || 'published';
  const approvals = Array.isArray(announcement.approvals) ? announcement.approvals : [];
  const managers = (users || []).filter((u) => u.role === 'manager' || u.role === 'owner');

  const statusLabel = { draft: 'Draft', pending_approval: 'Pending Approval', published: 'Published' };
  const statusClass = { draft: 'badge-draft', pending_approval: 'badge-pending', published: 'badge-published' };

  if (editing) {
    return (
      <form onSubmit={handleSave} className="form-announcement-edit">
        <div className="ann-edit-field">
          <label className="ann-edit-label">Title</label>
          <input className="ann-edit-input" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        <div className="ann-edit-field">
          <label className="ann-edit-label">Body</label>
          <RichEditor
            key={announcement.id}
            initialContent={body}
            onChange={setBody}
            onImageUpload={uploadAnnouncementImage}
            placeholder="Optional — additional detail, formatting, or images"
          />
        </div>
        <div className="ann-edit-dates">
          <label className="ann-edit-label-inline">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="ann-edit-label-inline">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        {locations && locations.length > 0 && (
          <div className="form-locations">
            <span className="ann-edit-label">Locations</span>
            {locations.map((loc) => (
              <label key={loc.id} className="location-checkbox">
                <input type="checkbox" checked={locationIds.includes(loc.id)} onChange={() => toggleLocation(loc.id)} />
                {loc.name}
              </label>
            ))}
          </div>
        )}
        {managers.length > 0 && (
          <div className="form-approvers">
            <span className="ann-edit-label">Approvers</span>
            {managers.map((u) => (
              <label key={u.id} className="location-checkbox">
                <input type="checkbox" checked={approverIds.includes(u.id)} onChange={() => toggleApprover(u.id)} />
                {u.display_name || u.email}
              </label>
            ))}
          </div>
        )}
        <div className="ann-edit-actions">
          <button type="submit" className="btn-primary" disabled={loading}>Save changes</button>
          <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </form>
    );
  }

  return (
    <div className="announcement-item-card">
      <div className="announcement-item-row">
        <div className="announcement-item-info">
          <div className="announcement-item-header">
            <strong className="announcement-item-title">{announcement.title}</strong>
            <span className={`status-badge ${statusClass[status] || 'badge-published'}`}>
              {statusLabel[status] || status}
            </span>
            {announcement.is_policy && (
              <span className={`status-badge badge-policy${announcement.policy_required ? '' : ' badge-policy-inactive'}`}>
                POLICY{announcement.policy_required ? '' : ' — not required'}
              </span>
            )}
          </div>
          {announcement.is_policy && (
            <div className="policy-manage-row">
              <span className="hint">
                {announcement.signed_count ?? 0} / {announcement.total_employees ?? '?'} employees signed
              </span>
              <button type="button" className="btn-small" onClick={handleTogglePolicyRequired}>
                {announcement.policy_required ? 'Mark as no longer required' : 'Reactivate policy'}
              </button>
            </div>
          )}
          <span className="announcement-item-dates">{announcement.effective_from} – {announcement.effective_until}</span>
          {announcement.body && (
            <div className="announcement-item-body" dangerouslySetInnerHTML={{ __html: announcement.body }} />
          )}
          {approvals.length > 0 && (
            <div className="approval-status-row">
              {approvals.map((ap) => (
                <span key={ap.approver_id} className={`approval-chip approval-chip--${ap.status}`} title={ap.comment || ''}>
                  {ap.display_name || ap.email}
                  {ap.status === 'approved' && ' ✓'}
                  {ap.status === 'rejected' && ' ✗'}
                  {ap.status === 'pending' && ' …'}
                  {ap.comment && <span className="approval-chip-comment"> "{ap.comment}"</span>}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="announcement-item-actions">
          {status !== 'published' && (
            <button type="button" className="btn-publish btn-small" onClick={handlePublish}>
              Publish
            </button>
          )}
          <WhoRead id={announcement.id} />
          <button type="button" className="btn-small" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="btn-remove btn-small" onClick={handleDelete}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function SmsSendForm({ users, loading, onSend }) {
  const usersWithPhone = users.filter((u) => u.phone);
  const [selected, setSelected] = useState(() => usersWithPhone.map((u) => u.id));
  const [message, setMessage] = useState('');

  const toggle = (id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const selectAll = () => setSelected(usersWithPhone.map((u) => u.id));
  const selectNone = () => setSelected([]);

  const submit = (e) => {
    e.preventDefault();
    onSend(selected, message);
    setMessage('');
  };

  if (usersWithPhone.length === 0) {
    return <p>No users with phone numbers. Sync from Square or add phone in user profile.</p>;
  }
  return (
    <form onSubmit={submit} className="sms-send-form">
      <p>Select recipients:</p>
      <div className="sms-recipients">
        <button type="button" onClick={selectAll}>All</button>
        <button type="button" onClick={selectNone}>None</button>
        {usersWithPhone.map((u) => (
          <label key={u.id} className="sms-checkbox">
            <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} />
            {u.display_name || u.email} {u.phone && `(${u.phone})`}
          </label>
        ))}
      </div>
      <label>
        Message
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} required rows={3} placeholder="SMS body" />
      </label>
      <button type="submit" disabled={loading || selected.length === 0}>
        Send to {selected.length} selected
      </button>
    </form>
  );
}
