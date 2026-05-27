import React, { useState, useEffect, useCallback } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { getDaySummary, setTaskStatus, getActiveAnnouncements, acknowledgeAnnouncement, closeAssignment } from '../api';
import './Dashboard.css';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function Dashboard() {
  const { user } = useOutletContext();
  const isManager = user?.role === 'manager' || user?.role === 'owner';
  const [date, setDate] = useState(todayStr());
  const [daySummary, setDaySummary] = useState({ assignments: [] });
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Per-assignment state: tab ('active'|'reviewed') and open/collapsed
  const [assignmentTabs, setAssignmentTabs] = useState({});   // { [id]: 'active'|'reviewed' }
  const [assignmentOpen, setAssignmentOpen] = useState({});   // { [id]: bool }
  const [emulateRole, setEmulateRole] = useState(null);       // null = manager view; string = role name

  const [reasonInput, setReasonInput] = useState({});
  const [showReasonFor, setShowReasonFor] = useState(null);
  const [closeNoteFor, setCloseNoteFor] = useState(null);
  const [closeNoteInput, setCloseNoteInput] = useState({});
  const [showPastAnnouncements, setShowPastAnnouncements] = useState(false);

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [summaryRes, annRes] = await Promise.all([
        getDaySummary(date),
        getActiveAnnouncements(date),
      ]);
      setDaySummary(summaryRes);
      setAnnouncements(annRes.announcements || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);


  const goDate = (delta) => {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(d.toISOString().slice(0, 10));
  };

  // ── Per-assignment helpers ───────────────────────────────
  const getTab = (id) => assignmentTabs[id] || 'active';
  const setTab = (id, tab) => setAssignmentTabs((prev) => ({ ...prev, [id]: tab }));
  // Default open on large screens, collapsed on mobile — respects any explicit user toggle
  const defaultOpen = () => window.innerWidth > 640;
  const isOpen = (id) => assignmentOpen[id] === undefined ? defaultOpen() : assignmentOpen[id];
  const toggleOpen = (id) => setAssignmentOpen((prev) => ({ ...prev, [id]: !isOpen(id) }));

  // ── Task state helpers ───────────────────────────────────
  const updateTaskInState = (assignmentId, taskTemplateId, patch) => {
    setDaySummary((prev) => ({
      ...prev,
      assignments: prev.assignments.map((a) =>
        a.id === assignmentId
          ? { ...a, tasks: a.tasks.map((t) => t.task_template_id === taskTemplateId ? { ...t, ...patch } : t) }
          : a
      ),
    }));
  };

  const handleMarkComplete = async (assignmentId, taskTemplateId) => {
    try {
      await setTaskStatus(assignmentId, taskTemplateId, 'completed');
      updateTaskInState(assignmentId, taskTemplateId, { my_status: 'completed', my_reason: null, my_completed_at: new Date().toISOString() });
    } catch (err) { setError(err.message); }
  };

  const handleUndo = async (assignmentId, taskTemplateId) => {
    try {
      await setTaskStatus(assignmentId, taskTemplateId, null);
      updateTaskInState(assignmentId, taskTemplateId, { my_status: null, my_reason: null, my_completed_at: null });
    } catch (err) { setError(err.message); }
  };

  const handleNotDoneClick = (assignmentId, taskTemplateId) => {
    const key = `${assignmentId}:${taskTemplateId}`;
    setShowReasonFor(key);
    setReasonInput((prev) => ({ ...prev, [key]: '' }));
  };

  const handleNotDoneSubmit = async (assignmentId, taskTemplateId) => {
    const key = `${assignmentId}:${taskTemplateId}`;
    const reason = reasonInput[key]?.trim();
    if (!reason) return;
    try {
      await setTaskStatus(assignmentId, taskTemplateId, 'not_completed', reason);
      updateTaskInState(assignmentId, taskTemplateId, { my_status: 'not_completed', my_reason: reason, my_completed_at: null });
      setShowReasonFor(null);
    } catch (err) { setError(err.message); }
  };

  const handleReasonCancel = (key) => {
    setShowReasonFor(null);
    setReasonInput((prev) => { const n = { ...prev }; delete n[key]; return n; });
  };

  const handleCloseListClick = (assignmentId, hasIncompleteTasks) => {
    if (hasIncompleteTasks) {
      setCloseNoteFor(assignmentId);
      setCloseNoteInput((prev) => ({ ...prev, [assignmentId]: '' }));
    } else {
      handleCloseListSubmit(assignmentId, '');
    }
  };

  const handleCloseListSubmit = async (assignmentId, note) => {
    try {
      await closeAssignment(assignmentId, note);
      setDaySummary((prev) => ({
        ...prev,
        assignments: prev.assignments.map((a) =>
          a.id === assignmentId ? { ...a, archived_at: new Date().toISOString() } : a
        ),
      }));
      setCloseNoteFor(null);
    } catch (err) { setError(err.message); }
  };

  const handleCloseNoteCancel = (assignmentId) => {
    setCloseNoteFor(null);
    setCloseNoteInput((prev) => { const n = { ...prev }; delete n[assignmentId]; return n; });
  };

  const handleAck = async (id) => {
    try {
      await acknowledgeAnnouncement(id);
      setAnnouncements((prev) => prev.map((a) => (a.id === id ? { ...a, _acknowledged: true } : a)));
    } catch (err) { setError(err.message); }
  };

  const isToday = date === todayStr();

  // Roles available today (unique wage_titles from all assignments, for manager emulation)
  const availableRoles = isManager
    ? [...new Set((daySummary.assignments || []).map((a) => a.wage_title).filter(Boolean))].sort()
    : [];

  // When emulating, filter assignments to the selected role; otherwise show all
  const visibleAssignments = emulateRole
    ? (daySummary.assignments || []).filter((a) => a.wage_title === emulateRole)
    : (daySummary.assignments || []);

  const isRead = (a) => !!(a.my_acknowledged_at || a._acknowledged);
  const unreadAnnouncements = announcements.filter((a) => !isRead(a));
  const readAnnouncements = [...announcements.filter(isRead)].sort((a, b) => {
    const da = a.effective_from || a.created_at || '';
    const db = b.effective_from || b.created_at || '';
    return db.localeCompare(da);
  });

  // ── Task item renderer (shared by active + reviewed) ────
  const renderTaskItems = (a, tasks, isActiveTab) => (
    <ul className="task-list">
      {tasks.map((t) => {
        const key = `${a.id}:${t.task_template_id}`;
        const showingReason = showReasonFor === key;

        if (!isActiveTab) {
          // Reviewed tab
          return (
            <li
              key={t.task_template_id}
              className={`task-card ${t.my_status === 'completed' ? 'task-done' : 'task-not-done'}`}
            >
              <div className="task-title-block">
                <span className="task-title">{t.title}</span>
                {t.my_status === 'not_completed' && t.my_reason && (
                  <span className="task-not-done-reason">Reason: {t.my_reason}</span>
                )}
                {t.completed_by_name && !t.completed_by_me && (
                  <span className="task-completed-by">✓ {t.completed_by_name}</span>
                )}
              </div>
              {(t.completed_by_me || isManager) && (
                <button
                  type="button"
                  className="toggle-incomplete"
                  onClick={() => handleUndo(a.id, t.task_template_id)}
                  aria-label="Undo"
                  title="Undo — return to To Do"
                >
                  Undo
                </button>
              )}
            </li>
          );
        }

        // Active tab
        return (
          <li key={t.task_template_id} className="task-card">
            <span className="task-title">
              {t.title}
              {t.priority === 'try' && <span className="task-optional-badge">Optional</span>}
            </span>
            {showingReason ? (
              <div className="reason-input-row">
                <input
                  className="reason-input"
                  type="text"
                  placeholder="Why wasn't this done?"
                  value={reasonInput[key] || ''}
                  onChange={(e) => setReasonInput((prev) => ({ ...prev, [key]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleNotDoneSubmit(a.id, t.task_template_id);
                    if (e.key === 'Escape') handleReasonCancel(key);
                  }}
                  autoFocus
                />
                <button type="button" className="btn-reason-submit" onClick={() => handleNotDoneSubmit(a.id, t.task_template_id)}>Submit</button>
                <button type="button" className="btn-reason-cancel" onClick={() => handleReasonCancel(key)}>Cancel</button>
              </div>
            ) : (
              <div className="task-actions">
                <button
                  type="button"
                  className="toggle-complete"
                  onClick={() => handleMarkComplete(a.id, t.task_template_id)}
                  aria-label="Mark complete"
                  title="Mark complete"
                >
                  <span className="circle" aria-hidden />
                </button>
                <button
                  type="button"
                  className="toggle-not-done"
                  onClick={() => handleNotDoneClick(a.id, t.task_template_id)}
                  aria-label="Mark not done"
                  title="Mark as not done (requires reason)"
                >
                  ✕
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );

  // ── Assignment card ──────────────────────────────────────
  const renderAssignmentCard = (a) => {
    const tab = getTab(a.id);
    const open = isOpen(a.id);
    const activeTasks = (a.tasks || []).filter((t) => !t.my_status);
    const reviewedTasks = (a.tasks || []).filter((t) => !!t.my_status);
    const showingCloseNote = closeNoteFor === a.id;

    return (
      <div key={a.id} className={`assignment-card${a.archived_at ? ' assignment-archived' : ''}`}>
        {/* ── Card header ── */}
        <div
          className="assignment-card-header"
          onClick={() => toggleOpen(a.id)}
          role="button"
          aria-expanded={open}
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(a.id); } }}
        >
          {/* Left: name + location */}
          <div className="assignment-card-title">
            <span className="assignment-card-name">
              {a.template_name}
              {a.archived_at && <span className="badge-archived">Archived</span>}
            </span>
            {a.location_names && (
              <span className="assignment-location-badge">{a.location_names}</span>
            )}
          </div>

          {/* Right: todo/reviewed tabs + close list + chevron */}
          <div className="assignment-card-controls" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`btn-tab-mini${tab === 'active' ? ' active' : ''}`}
              onClick={() => { setTab(a.id, 'active'); setAssignmentOpen((prev) => ({ ...prev, [a.id]: true })); }}
            >
              To Do{activeTasks.length > 0 ? ` (${activeTasks.length})` : ''}
            </button>
            <button
              type="button"
              className={`btn-tab-mini${tab === 'reviewed' ? ' active' : ''}`}
              onClick={() => { setTab(a.id, 'reviewed'); setAssignmentOpen((prev) => ({ ...prev, [a.id]: true })); }}
            >
              Reviewed{reviewedTasks.length > 0 ? ` (${reviewedTasks.length})` : ''}
            </button>
            {isManager && !a.archived_at && (
              <button
                type="button"
                className="btn-close-list"
                onClick={(e) => { e.stopPropagation(); handleCloseListClick(a.id, activeTasks.length > 0); }}
                title="Close this task list"
              >
                Close
              </button>
            )}
            <span
              className="assignment-chevron"
              aria-hidden
              onClick={(e) => { e.stopPropagation(); toggleOpen(a.id); }}
            >
              {open ? '−' : '+'}
            </span>
          </div>
        </div>

        {/* Close list note row (shown below header when needed) */}
        {showingCloseNote && (
          <div className="close-list-note-row">
            <input
              className="close-list-note-input"
              type="text"
              placeholder="Why are you closing early?"
              value={closeNoteInput[a.id] || ''}
              onChange={(e) => setCloseNoteInput((prev) => ({ ...prev, [a.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && closeNoteInput[a.id]?.trim()) handleCloseListSubmit(a.id, closeNoteInput[a.id]);
                if (e.key === 'Escape') handleCloseNoteCancel(a.id);
              }}
              autoFocus
            />
            <button
              type="button"
              className="btn-close-list-confirm"
              disabled={!closeNoteInput[a.id]?.trim()}
              onClick={() => handleCloseListSubmit(a.id, closeNoteInput[a.id])}
            >
              Close List
            </button>
            <button type="button" className="btn-close-list-cancel" onClick={() => handleCloseNoteCancel(a.id)}>
              Cancel
            </button>
          </div>
        )}

        {/* ── Card body ── */}
        {open && (
          <div className="assignment-card-body">
            {tab === 'active' ? (
              activeTasks.length === 0
                ? <p className="empty">All tasks reviewed.</p>
                : renderTaskItems(a, activeTasks, true)
            ) : (
              reviewedTasks.length === 0
                ? <p className="empty">No reviewed tasks yet.</p>
                : renderTaskItems(a, reviewedTasks, false)
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-header-inner">
          <div className="header-row">
            <button type="button" className="nav-date" onClick={() => goDate(-1)} aria-label="Previous day">
              &lt;
            </button>
            <span className="date-label">{date}</span>
            <button type="button" className="nav-date" onClick={() => goDate(1)} aria-label="Next day">
              &gt;
            </button>
            <button type="button" className="btn-today" onClick={() => setDate(todayStr())} disabled={isToday}>
              Today
            </button>
          </div>
          {isManager && (
            <div className="dashboard-header-actions">
              <Link to="/manage?tab=announcements" className="btn-manage-tasks">
                Announcements
              </Link>
              <Link to="/manage?tab=tasks" className="btn-manage-tasks">
                Manage Tasks
              </Link>
            </div>
          )}
        </div>
        {isManager && availableRoles.length > 0 && (
          <div className="emulate-row">
            <span className="emulate-label">View as:</span>
            <button
              type="button"
              className={`btn-role-pill${!emulateRole ? ' active' : ''}`}
              onClick={() => setEmulateRole(null)}
            >
              All
            </button>
            {availableRoles.map((role) => (
              <button
                key={role}
                type="button"
                className={`btn-role-pill${emulateRole === role ? ' active' : ''}`}
                onClick={() => setEmulateRole(role)}
              >
                {role}
              </button>
            ))}
          </div>
        )}
      </header>

      {error && <p className="dashboard-error">{error}</p>}

      <div className="dashboard-main">
        {loading ? (
          <p className="dashboard-loading">Loading…</p>
        ) : unreadAnnouncements.length > 0 && !emulateRole ? (
          /* ── Announcement Gate ── (skipped when manager is emulating a role) */
          <div className="announcement-gate">
            <div className="gate-header">
              <div className="gate-icon" aria-hidden>📢</div>
              <h2 className="gate-title">
                {unreadAnnouncements.length === 1
                  ? 'You have 1 announcement'
                  : `You have ${unreadAnnouncements.length} announcements`}
              </h2>
              <p className="gate-subtitle">
                Please read and acknowledge {unreadAnnouncements.length === 1 ? 'it' : 'each one'} before starting your tasks.
              </p>
            </div>
            <div className="gate-list">
              {unreadAnnouncements.map((a) => (
                <div key={a.id} className="gate-card">
                  <h3 className="gate-card-title">{a.title}</h3>
                  {a.body && <p className="gate-card-body">{a.body}</p>}
                  <button type="button" className="btn-ack" onClick={() => handleAck(a.id)}>
                    Mark as Read
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* ── Tasks View ── */
          <section className="section-tasks">
            {daySummary.no_shift && !emulateRole ? (
              <p className="empty">You have no shift scheduled for this day.</p>
            ) : visibleAssignments.length === 0 ? (
              <p className="empty">
                {emulateRole ? `No tasks assigned for "${emulateRole}" on this day.` : 'No tasks assigned for this day.'}
              </p>
            ) : (
              <div className="assignment-card-list">
                {visibleAssignments.map(renderAssignmentCard)}
              </div>
            )}

            {/* Past Announcements */}
            {readAnnouncements.length > 0 && (
              <div className="past-announcements-wrap">
                <button
                  type="button"
                  className="btn-past-toggle"
                  onClick={() => setShowPastAnnouncements((v) => !v)}
                  aria-expanded={showPastAnnouncements}
                >
                  <span>📢 Past Announcements ({readAnnouncements.length})</span>
                  <span className="past-chevron" aria-hidden>{showPastAnnouncements ? '−' : '+'}</span>
                </button>
                {showPastAnnouncements && (
                  <ul className="past-announcement-list">
                    {readAnnouncements.map((a) => (
                      <li key={a.id} className="past-announcement-card">
                        <h4 className="past-card-title">{a.title}</h4>
                        {a.body && <p className="announcement-body">{a.body}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
