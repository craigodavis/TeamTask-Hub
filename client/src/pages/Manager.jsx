import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
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
  getIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
  getCompanyUsers,
  updateUser,
  deleteUser,
  sendPasswordResetEmail,
  sendSms,
  getSmsLog,
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
import './Manager.css';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function Manager({ user, onLogout }) {
  const [tab, setTab] = useState('tasks');
  const [templates, setTemplates] = useState([]);
  const [assignDate, setAssignDate] = useState(todayStr());
  const [assignments, setAssignments] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [companyUsers, setCompanyUsers] = useState([]);
  const [smsLog, setSmsLog] = useState([]);
  const [loading, setLoading] = useState(false);
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

  const loadIngredients = async () => {
    try {
      const r = await getIngredients();
      setIngredients(r.ingredients || []);
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

  useEffect(() => {
    if (tab === 'tasks') {
      loadTemplates();
      loadAssignments();
    } else if (tab === 'announcements') loadAnnouncements();
    else if (tab === 'ingredients') {
      loadIngredients();
    } else if (tab === 'users') {
      loadUsers();
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

  return (
    <div className="manager-page">
      <header className="manager-header">
        <Link to="/" className="back">← Dashboard</Link>
        <span className="title">Manager</span>
        <Link to="/sync-users" className="link-settings">Get Square Users</Link>
        {user?.role === 'owner' && (
          <Link to="/settings" className="link-settings">Settings</Link>
        )}
        <button type="button" className="btn-logout" onClick={onLogout}>Out</button>
      </header>

      {error && <p className="manager-error">{error}</p>}
      {message && <p className="manager-message">{message}</p>}

      <nav className="manager-tabs">
        {['tasks', 'announcements', 'ingredients', 'users', 'integrations'].map((t) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'tasks' && 'Tasks'}
            {t === 'announcements' && 'Announcements'}
            {t === 'ingredients' && 'Ingredients'}
            {t === 'users' && 'Users'}
            {t === 'integrations' && 'Send SMS'}
          </button>
        ))}
      </nav>

      {tab === 'tasks' && (
        <section className="manager-section">
          <h2>Task list templates</h2>
          <TaskListTemplateForm onCreated={loadTemplates} />
          <ul className="template-list">
            {templates.map((t) => (
              <TaskTemplateRow
                key={t.id}
                template={t}
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
          <AnnouncementForm onCreated={loadAnnouncements} />
          <ul className="announcement-list">
            {announcements.map((a) => (
              <li key={a.id}>
                <strong>{a.title}</strong> {a.effective_from} – {a.effective_until}
                <WhoRead id={a.id} />
                <AnnouncementEditDelete announcement={a} onUpdate={loadAnnouncements} />
              </li>
            ))}
          </ul>
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
                currentUserId={user?.id}
                onRoleChange={(role) => handleUserRoleChange(u.id, role)}
                onSetPassword={(password) => handleUserSetPassword(u.id, password)}
                onSendResetEmail={() => handleSendResetEmail(u.id)}
                onDelete={() => handleDeleteUser(u.id)}
                loading={loading}
              />
            ))}
          </ul>
        </section>
      )}

      {tab === 'ingredients' && (
        <section className="manager-section">
          <h2>Ingredients</h2>
          <p className="hint">Create ingredients here. Everyone can log food waste using these on the Food waste page.</p>
          <IngredientForm onCreated={loadIngredients} />
          <ul className="ingredient-list">
            {ingredients.map((i) => (
              <IngredientRow key={i.id} ingredient={i} onUpdate={loadIngredients} />
            ))}
          </ul>
        </section>
      )}

      {tab === 'integrations' && (
        <section className="manager-section">
          <h2>Square & Twilio</h2>
          <p className="hint">Manage Square users: <Link to="/sync-users">Get Square Users page</Link>.</p>
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

function UserRow({ user, currentUserId, onRoleChange, onSetPassword, onSendResetEmail, onDelete, loading }) {
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

function AnnouncementForm({ onCreated }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      await createAnnouncement(title, body, from, to);
      setTitle('');
      setBody('');
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

function TaskListTemplateForm({ onCreated }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('opening');
  const [period_type, setPeriodType] = useState('daily');
  const [day_of_week, setDayOfWeek] = useState(1);
  const [day_of_month, setDayOfMonth] = useState(1);
  const [recur_month, setRecurMonth] = useState(1);
  const [recur_day, setRecurDay] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
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
      await createTaskListTemplate(name.trim(), type.trim(), period_type, options);
      setName('');
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
      {err && <span className="form-error">{err}</span>}
      <button type="submit" disabled={loading}>Create template</button>
    </form>
  );
}

function TaskTemplateRow({ template, onUpdate, onAssign, assignDate }) {
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

function AnnouncementEditDelete({ announcement, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(announcement.title);
  const [body, setBody] = useState(announcement.body || '');
  const [from, setFrom] = useState(announcement.effective_from);
  const [to, setTo] = useState(announcement.effective_until);
  const [loading, setLoading] = useState(false);

  const handleSave = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await updateAnnouncement(announcement.id, { title, body, effective_from: from, effective_until: to });
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

function IngredientForm({ onCreated }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      await createIngredient(name.trim());
      setName('');
      onCreated();
    } finally {
      setLoading(false);
    }
  };
  return (
    <form onSubmit={submit} className="form-inline">
      <input placeholder="Ingredient name" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" disabled={loading}>Add ingredient</button>
    </form>
  );
}

function IngredientRow({ ingredient, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ingredient.name);
  const [loading, setLoading] = useState(false);

  const handleSave = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await updateIngredient(ingredient.id, name);
      setEditing(false);
      onUpdate();
    } catch (e) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete ingredient "${ingredient.name}"?`)) return;
    try {
      await deleteIngredient(ingredient.id);
      onUpdate();
    } catch (e) {
      alert(e.message);
    }
  };

  if (editing) {
    return (
      <li>
        <form onSubmit={handleSave} className="form-inline">
          <input value={name} onChange={(e) => setName(e.target.value)} required />
          <button type="submit" disabled={loading}>Save</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      </li>
    );
  }
  return (
    <li>
      {ingredient.name}
      <button type="button" className="btn-small" onClick={() => setEditing(true)}>Edit</button>
      <button type="button" className="btn-remove btn-small" onClick={handleDelete}>Delete</button>
    </li>
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
