import React, { useState, useEffect, useCallback } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { getDaySummary, setTaskStatus, getActiveAnnouncements, acknowledgeAnnouncement } from '../api';
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
  const [taskTab, setTaskTab] = useState('active'); // 'active' | 'reviewed'
  const [announcementTab, setAnnouncementTab] = useState('unread'); // 'unread' | 'read'
  const [taskSectionsOpen, setTaskSectionsOpen] = useState({ daily: true, weekly: true, monthly: true, yearly: true, adhoc: true });
  const [reasonInput, setReasonInput] = useState({}); // `${assignmentId}:${taskTemplateId}` → text
  const [showReasonFor, setShowReasonFor] = useState(null); // key of task showing reason input

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

  // Poll every 30 s so teammates' completions appear automatically
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const goDate = (delta) => {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(d.toISOString().slice(0, 10));
  };

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

  const handleAck = async (id) => {
    try {
      await acknowledgeAnnouncement(id);
      setAnnouncements((prev) => prev.map((a) => (a.id === id ? { ...a, _acknowledged: true } : a)));
    } catch (err) {
      setError(err.message);
    }
  };

  const isToday = date === todayStr();

  // "To Do" = no completion record (my_status is null)
  // "Reviewed" = completed OR not_completed
  const assignmentsWithActiveTasks = daySummary.assignments?.map((a) => ({
    ...a,
    tasks: (a.tasks || []).filter((t) => !t.my_status),
  })).filter((a) => a.tasks.length > 0) ?? [];

  const assignmentsWithReviewedTasks = daySummary.assignments?.map((a) => ({
    ...a,
    tasks: (a.tasks || []).filter((t) => !!t.my_status),
  })).filter((a) => a.tasks.length > 0) ?? [];

  const reviewedCount = assignmentsWithReviewedTasks.reduce((n, a) => n + a.tasks.length, 0);

  const periodSectionOrder = ['daily', 'weekly', 'monthly', 'yearly', 'adhoc'];
  const periodSectionLabel = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', adhoc: 'Ad-Hoc' };
  const periodTypeToSection = (period_type) => (period_type === 'one_time' ? 'adhoc' : (period_type || 'adhoc'));

  const getAssignmentsBySection = (assignments) => {
    const bySection = { daily: [], weekly: [], monthly: [], yearly: [], adhoc: [] };
    for (const a of assignments) {
      const section = periodTypeToSection(a.period_type);
      if (bySection[section]) bySection[section].push(a);
    }
    return bySection;
  };

  const toggleTaskSection = (section) => {
    setTaskSectionsOpen((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const isRead = (a) => !!(a.my_acknowledged_at || a._acknowledged);
  const unreadAnnouncements = announcements.filter((a) => !isRead(a));
  const readAnnouncements = [...announcements.filter(isRead)].sort((a, b) => {
    const da = a.effective_from || a.created_at || '';
    const db = b.effective_from || b.created_at || '';
    return db.localeCompare(da);
  });

  const renderActiveTasks = (assignments) => (
    assignments.length === 0 ? (
      <p className="empty">No tasks to do for this day.</p>
    ) : (
      assignments.map((a) => (
        <div key={a.id} className="assignment-block">
          <h3 className="template-name">{a.template_name}</h3>
          <ul className="task-list">
            {a.tasks.map((t) => {
              const key = `${a.id}:${t.task_template_id}`;
              const showingReason = showReasonFor === key;
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
                        onKeyDown={(e) => { if (e.key === 'Enter') handleNotDoneSubmit(a.id, t.task_template_id); if (e.key === 'Escape') handleReasonCancel(key); }}
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
        </div>
      ))
    )
  );

  const renderReviewedTasks = (assignments) => (
    assignments.length === 0 ? (
      <p className="empty">No reviewed tasks for this day.</p>
    ) : (
      assignments.map((a) => (
        <div key={a.id} className="assignment-block">
          <h3 className="template-name">{a.template_name}</h3>
          <ul className="task-list">
            {a.tasks.map((t) => (
              <li
                key={t.task_template_id}
                className={`task-card ${t.my_status === 'completed' ? 'task-done' : 'task-not-done'}`}
              >
                <div className="task-title-block">
                  <span className="task-title">{t.title}</span>
                  {t.my_status === 'not_completed' && t.my_reason && (
                    <span className="task-not-done-reason">Reason: {t.my_reason}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="toggle-incomplete"
                  onClick={() => handleUndo(a.id, t.task_template_id)}
                  aria-label="Undo"
                  title="Undo — return to To Do"
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))
    )
  );

  const activeBySection = getAssignmentsBySection(assignmentsWithActiveTasks);
  const reviewedBySection = getAssignmentsBySection(assignmentsWithReviewedTasks);

  const renderTaskSections = (reviewed) =>
    periodSectionOrder.map((sectionKey) => {
      const assignments = reviewed ? reviewedBySection[sectionKey] : activeBySection[sectionKey];
      const isOpen = taskSectionsOpen[sectionKey];
      const label = periodSectionLabel[sectionKey];
      const count = assignments.length;
      return (
        <div key={sectionKey} className="task-section">
          <button
            type="button"
            className="task-section-header"
            onClick={() => toggleTaskSection(sectionKey)}
            aria-expanded={isOpen}
          >
            <span className="task-section-title">{label}</span>
            <span className="task-section-count">{count}</span>
            <span className="task-section-chevron" aria-hidden>{isOpen ? '−' : '+'}</span>
          </button>
          {isOpen && (
            <div className="task-section-content">
              {reviewed ? renderReviewedTasks(assignments) : renderActiveTasks(assignments)}
            </div>
          )}
        </div>
      );
    });

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
      </header>

      {error && <p className="dashboard-error">{error}</p>}

      <div className="dashboard-main">
        <section className="section-tasks">
          <h2>Tasks</h2>
          {loading ? (
            <p>Loading…</p>
          ) : daySummary.assignments?.length === 0 ? (
            <p className="empty">No tasks assigned for this day.</p>
          ) : (
            <>
              <div className="task-tabs">
                <button
                  type="button"
                  className={taskTab === 'active' ? 'active' : ''}
                  onClick={() => setTaskTab('active')}
                >
                  To do
                </button>
                <button
                  type="button"
                  className={taskTab === 'reviewed' ? 'active' : ''}
                  onClick={() => setTaskTab('reviewed')}
                >
                  Reviewed {reviewedCount > 0 && `(${reviewedCount})`}
                </button>
              </div>
              {taskTab === 'active'
                ? renderTaskSections(false)
                : renderTaskSections(true)}
            </>
          )}
        </section>

        <section className="section-announcements">
          <h2>Announcements</h2>
          {loading ? (
            <p>Loading…</p>
          ) : announcements.length === 0 ? (
            <p className="empty">No announcements for this day.</p>
          ) : (
            <>
              <div className="announcement-tabs">
                <button
                  type="button"
                  className={announcementTab === 'unread' ? 'active' : ''}
                  onClick={() => setAnnouncementTab('unread')}
                >
                  Unread {unreadAnnouncements.length > 0 && `(${unreadAnnouncements.length})`}
                </button>
                <button
                  type="button"
                  className={announcementTab === 'read' ? 'active' : ''}
                  onClick={() => setAnnouncementTab('read')}
                >
                  Read
                </button>
              </div>
              {announcementTab === 'unread' && (
                unreadAnnouncements.length === 0 ? (
                  <p className="empty">No unread announcements.</p>
                ) : (
                  <ul className="announcement-list">
                    {unreadAnnouncements.map((a) => (
                      <li key={a.id} className="announcement-card">
                        <h4>{a.title}</h4>
                        {a.body && <p className="announcement-body">{a.body}</p>}
                        <button type="button" className="btn-ack btn-mark-read" onClick={() => handleAck(a.id)}>
                          Mark Read
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              )}
              {announcementTab === 'read' && (
                readAnnouncements.length === 0 ? (
                  <p className="empty">No read announcements yet. Mark items as read from the Unread tab.</p>
                ) : (
                  <ul className="announcement-list">
                    {readAnnouncements.map((a) => (
                      <li key={a.id} className="announcement-card announcement-read">
                        <h4>{a.title}</h4>
                        {a.body && <p className="announcement-body">{a.body}</p>}
                        <p className="ack-status">Read</p>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
