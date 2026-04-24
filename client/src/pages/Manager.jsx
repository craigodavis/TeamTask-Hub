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
} from '../api';
import { DebtReportSection } from '../components/DebtReportSection';
import './Manager.css';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

const VALID_TABS = new Set(['announcements', 'tasks', 'reports', 'integrations', 'users']);

export function Manager() {
  const { user } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab = tabParam && VALID_TABS.has(tabParam) ? tabParam : 'announcements';

  const setTab = (t) => {
    if (t === 'announcements') setSearchParams({}, { replace: true });
    else setSearchParams({ tab: t }, { replace: true });
  };
  const [templates, setTemplates] = useState([]);
  const [assignDate, setAssignDate] = useState(todayStr());
  const [assignments, setAssignments] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [companyUsers, setCompanyUsers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [smsLog, setSmsLog] = useState([]);
  const [loading, setLoading] = useState(false);
  const [reportFrom, setReportFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [reportTo, setReportTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [reportLocationId, setReportLocationId] = useState('');
  const [foodWasteReport, setFoodWasteReport] = useState(null);
  const [taskReport, setTaskReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [activeReport, setActiveReport] = useState('food-waste');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

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

  useEffect(() => {
    if (tab === 'tasks') {
      loadTemplates();
      loadAssignments();
      loadLocations();
    } else if (tab === 'announcements') {
      loadAnnouncements();
      loadLocations();
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

  const handleCreateAssignment = async (templateId) => {
    setError('');
    try {
      await createAssignment(templateId, assignDate, null);
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
          <TaskListTemplateForm locations={locations} onCreated={loadTemplates} />
          <ul className="template-list">
            {templates.map((t) => (
              <TaskTemplateRow
                key={t.id}
                template={t}
                locations={locations}
                onUpdate={loadTemplates}
                onAssign={() => handleCreateAssignment(t.id)}
                assignDate={assignDate}
              />
            ))}
          </ul>
          <h2>Assign task list to day</h2>
          <div className="assign-row">
            <input type="date" value={assignDate} onChange={(e) => setAssignDate(e.target.value)} />
            <button type="button" onClick={loadAssignments}>Load</button>
          </div>
          <p>Assignments for {assignDate}:</p>
          <ul className="assignment-list">
            {assignments.map((a) => (
              <li key={a.id}>
                {a.template_name} ({a.template_type})
                <button type="button" className="btn-remove" onClick={() => handleDeleteAssignment(a.id)}>Remove</button>
              </li>
            ))}
          </ul>
          {templates.length > 0 && (
            <p className="hint">To assign a template to this day, use &quot;Assign to this day&quot; above.</p>
          )}
        </section>
      )}

      {tab === 'announcements' && (
        <section className="manager-section">
          <h2>Announcements</h2>
          <AnnouncementForm locations={locations} onCreated={loadAnnouncements} />
          <ul className="announcement-list">
            {announcements.map((a) => (
              <li key={a.id}>
                <strong>{a.title}</strong> {a.effective_from} – {a.effective_until}
                <WhoRead id={a.id} />
                <AnnouncementEditDelete announcement={a} locations={locations} onUpdate={loadAnnouncements} />
              </li>
            ))}
          </ul>
        </section>
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
          </nav>

          <p className="hint">
            {activeReport === 'debt'
              ? 'Debt report compares month-end balances for two calendar years. Edit the table and save.'
              : 'Pick a report, set the date range, then run. More reports can be added here over time.'}
          </p>

          {activeReport !== 'debt' && (
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
          <p className="hint">Send SMS via Twilio. Sync Square team under <Link to="/settings?tab=square">Settings → Square users</Link>.</p>
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
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');

  const handleAdd = async (e) => {
    e.preventDefault();
    const name = newLocationName.trim();
    if (!name) return;
    onError('');
    onSavingChange(true);
    try {
      await createLocation(name);
      setNewLocationName('');
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
      await updateLocation(editingId, { name });
      setEditingId(null);
      setEditingName('');
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
      onUpdate();
      onMessage('Location deleted.');
    } catch (err) {
      onError(err.message);
    } finally {
      onSavingChange(false);
    }
  };

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
                  <button type="submit" disabled={saving}>Save</button>
                  <button type="button" onClick={() => { setEditingId(null); setEditingName(''); }}>Cancel</button>
                </form>
              ) : (
                <>
                  <span>{loc.name}</span>
                  <button type="button" className="btn-small" onClick={() => { setEditingId(loc.id); setEditingName(loc.name); }}>Edit</button>
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

function AnnouncementForm({ locations, onCreated }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [locationIds, setLocationIds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const toggleLocation = (id) => {
    setLocationIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      await createAnnouncement(title, body, from, to, locationIds.length > 0 ? locationIds : undefined);
      setTitle('');
      setBody('');
      setLocationIds([]);
      onCreated();
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="form-announcement">
      <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      <textarea placeholder="Body" value={body} onChange={(e) => setBody(e.target.value)} />
      <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      {locations && locations.length > 0 && (
        <div className="form-locations">
          <span>Locations (leave empty = all):</span>
          {locations.map((loc) => (
            <label key={loc.id} className="location-checkbox">
              <input
                type="checkbox"
                checked={locationIds.includes(loc.id)}
                onChange={() => toggleLocation(loc.id)}
              />
              {loc.name}
            </label>
          ))}
        </div>
      )}
      {err && <p className="form-error">{err}</p>}
      <button type="submit" disabled={loading}>Create announcement</button>
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

function TaskListTemplateForm({ locations, onCreated }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('opening');
  const [period_type, setPeriodType] = useState('daily');
  const [day_of_week, setDayOfWeek] = useState(1);
  const [day_of_month, setDayOfMonth] = useState(1);
  const [recur_month, setRecurMonth] = useState(1);
  const [recur_day, setRecurDay] = useState(1);
  const [locationIds, setLocationIds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
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
    setLoading(true);
    try {
      const options = {};
      if (period_type === 'weekly') options.day_of_week = day_of_week;
      if (period_type === 'monthly') options.day_of_month = day_of_month;
      if (period_type === 'yearly') { options.recur_month = recur_month; options.recur_day = recur_day; }
      if (locationIds.length > 0) options.location_ids = locationIds;
      await createTaskListTemplate(name.trim(), type.trim(), period_type, options);
      setName('');
      setLocationIds([]);
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
      {locations && locations.length > 0 && (
        <span className="form-locations-inline">
          Locations (empty = all):{' '}
          {locations.map((loc) => (
            <label key={loc.id} className="location-checkbox">
              <input type="checkbox" checked={locationIds.includes(loc.id)} onChange={() => toggleLocation(loc.id)} />
              {loc.name}
            </label>
          ))}
        </span>
      )}
      {err && <span className="form-error">{err}</span>}
      <button type="submit" disabled={loading}>Create template</button>
    </form>
  );
}

function TaskTemplateRow({ template, locations, onUpdate, onAssign, assignDate }) {
  const [tasks, setTasks] = useState([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');

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
      await createTaskItem(template.id, newTaskTitle.trim());
      setNewTaskTitle('');
      loadTasks();
      onUpdate();
    } finally {
      setAdding(false);
    }
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
      <span>
        <button type="button" className="btn-expand" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? '−' : '+'}
        </button>
        {template.name} ({TASK_TEMPLATE_TYPES.find((t) => t.value === template.type)?.label ?? template.type}, {template.period_type}
        {template.period_type === 'weekly' && template.day_of_week != null ? `, ${taskDayNames[template.day_of_week]}` : ''}
        {template.period_type === 'monthly' && template.day_of_month != null ? `, day ${template.day_of_month}` : ''}
        {template.period_type === 'yearly' && template.recur_month != null && template.recur_day != null ? `, ${taskMonthNames[template.recur_month - 1]} ${template.recur_day}` : ''})
      </span>
      <span>
        {template.period_type === 'weekly' ? (
          <span className="template-weekly-hint">Shows every {taskDayNames[template.day_of_week ?? 0]}</span>
        ) : template.period_type === 'daily' ? (
          <span className="template-daily-hint">Shows every day</span>
        ) : template.period_type === 'monthly' ? (
          <span className="template-monthly-hint">Shows on day {template.day_of_month ?? 1} each month</span>
        ) : template.period_type === 'yearly' ? (
          <span className="template-yearly-hint">Shows {template.recur_month != null && template.recur_day != null ? `${taskMonthNames[template.recur_month - 1]} ${template.recur_day} each year` : 'yearly'}</span>
        ) : (
          <button type="button" onClick={onAssign}>Assign to this day</button>
        )}
        <button type="button" className="btn-remove" onClick={handleDeleteTemplate}>Delete template</button>
      </span>
      {open && (
        <div className="template-tasks">
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
          <ul>
            {tasks.map((t) => (
              <li key={t.id}>
                {t.title}
                <button type="button" className="btn-remove small" onClick={() => handleDeleteTask(t.id)}>Remove</button>
              </li>
            ))}
          </ul>
          <form onSubmit={handleAddTask} className="form-inline">
            <input placeholder="New task title" value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} />
            <button type="submit" disabled={adding}>Add task</button>
          </form>
        </div>
      )}
    </li>
  );
}

function AnnouncementEditDelete({ announcement, locations, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(announcement.title);
  const [body, setBody] = useState(announcement.body || '');
  const [from, setFrom] = useState(announcement.effective_from);
  const [to, setTo] = useState(announcement.effective_until);
  const [locationIds, setLocationIds] = useState(Array.isArray(announcement.location_ids) ? announcement.location_ids : []);
  const [loading, setLoading] = useState(false);

  const toggleLocation = (id) => {
    setLocationIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await updateAnnouncement(announcement.id, { title, body, effective_from: from, effective_until: to, location_ids: locationIds });
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

  if (editing) {
    return (
      <form onSubmit={handleSave} className="form-announcement-inline">
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} />
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {locations && locations.length > 0 && (
          <div className="form-locations">
            Locations (empty = all):{' '}
            {locations.map((loc) => (
              <label key={loc.id} className="location-checkbox">
                <input type="checkbox" checked={locationIds.includes(loc.id)} onChange={() => toggleLocation(loc.id)} />
                {loc.name}
              </label>
            ))}
          </div>
        )}
        <button type="submit" disabled={loading}>Save</button>
        <button type="button" onClick={() => setEditing(false)}>Cancel</button>
      </form>
    );
  }
  return (
    <span>
      <button type="button" className="btn-small" onClick={() => setEditing(true)}>Edit</button>
      <button type="button" className="btn-remove btn-small" onClick={handleDelete}>Delete</button>
    </span>
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
