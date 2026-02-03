import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getDaySummary, setTaskComplete, getActiveAnnouncements, acknowledgeAnnouncement } from '../api';
import './Dashboard.css';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function Dashboard({ user, onLogout }) {
  const [date, setDate] = useState(todayStr());
  const [daySummary, setDaySummary] = useState({ assignments: [] });
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [taskTab, setTaskTab] = useState('active'); // 'active' | 'completed'
  const [announcementTab, setAnnouncementTab] = useState('unread'); // 'unread' | 'read'
  const [taskSectionsOpen, setTaskSectionsOpen] = useState({ daily: true, weekly: true, monthly: true, yearly: true, adhoc: true });

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

  const handleToggle = async (assignmentId, taskTemplateId, currentlyCompleted) => {
    const completed = !currentlyCompleted;
    try {
      await setTaskComplete(assignmentId, taskTemplateId, completed);
      setDaySummary((prev) => ({
        ...prev,
        assignments: prev.assignments.map((a) =>
          a.id === assignmentId
            ? {
                ...a,
                tasks: a.tasks.map((t) =>
                  t.task_template_id === taskTemplateId ? { ...t, my_completed_at: completed ? new Date().toISOString() : null } : t
                ),
              }
            : a
        ),
      }));
    } catch (err) {
      setError(err.message);
    }
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

  const assignmentsWithActiveTasks = daySummary.assignments?.map((a) => ({
    ...a,
    tasks: (a.tasks || []).filter((t) => !t.my_completed_at),
  })).filter((a) => a.tasks.length > 0) ?? [];

  const assignmentsWithCompletedTasks = daySummary.assignments?.map((a) => ({
    ...a,
    tasks: (a.tasks || []).filter((t) => t.my_completed_at),
  })).filter((a) => a.tasks.length > 0) ?? [];

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

  const renderTaskList = (assignments, showCompleted) => (
    assignments.length === 0 ? (
      <p className="empty">
        {showCompleted ? 'No completed tasks for this day.' : 'No tasks to do for this day.'}
      </p>
    ) : (
      assignments.map((a) => (
        <div key={a.id} className="assignment-block">
          <h3 className="template-name">{a.template_name}</h3>
          <ul className="task-list">
            {a.tasks.map((t) => (
              <li key={t.task_template_id} className={`task-card ${showCompleted ? 'task-done' : ''}`}>
                <span className="task-title">{t.title}</span>
                <button
                  type="button"
                  className={showCompleted ? 'toggle-incomplete' : 'toggle-complete'}
                  onClick={() => handleToggle(a.id, t.task_template_id, showCompleted)}
                  aria-label={showCompleted ? 'Mark incomplete' : 'Mark complete'}
                  title={showCompleted ? 'Mark incomplete' : 'Mark complete'}
                >
                  {showCompleted ? (
                    <span aria-hidden>Undo</span>
                  ) : (
                    <span className="circle" aria-hidden />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))
    )
  );

  const activeBySection = getAssignmentsBySection(assignmentsWithActiveTasks);
  const completedBySection = getAssignmentsBySection(assignmentsWithCompletedTasks);

  const renderTaskSections = (showCompleted) =>
    periodSectionOrder.map((sectionKey) => {
      const assignments = showCompleted ? completedBySection[sectionKey] : activeBySection[sectionKey];
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
              {renderTaskList(assignments, showCompleted)}
            </div>
          )}
        </div>
      );
    });

  return (
    <div className="dashboard">
      <header className="dashboard-header">
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
        <div className="user-row">
          <span className="user-name">{user?.display_name || user?.email}</span>
          {(user?.role === 'manager' || user?.role === 'owner') && (
            <Link to="/manage" className="link-manage">
              Manage
            </Link>
          )}
          {user?.role === 'owner' && (
            <Link to="/settings" className="link-manage">
              Settings
            </Link>
          )}
          <Link to="/waste" className="link-manage">
            Food waste
          </Link>
          <button type="button" className="btn-logout" onClick={onLogout}>
            Out
          </button>
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
                  className={taskTab === 'completed' ? 'active' : ''}
                  onClick={() => setTaskTab('completed')}
                >
                  Completed
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
