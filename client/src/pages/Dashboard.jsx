import React, { useState, useEffect, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { getDaySummary, setTaskStatus, getActiveAnnouncements, acknowledgeAnnouncement, closeAssignment, getStaffSchedule, getCompanyUsers } from '../api';
import { todayInTimezone } from '../utils/dateUtils';
import { SetPinModal } from '../components/SetPinModal';
import { PolicySignBox } from '../components/PolicySignBox';
import './Dashboard.css';

export function Dashboard() {
  const { user, emulateRole, setAvailableRoles, timezone } = useOutletContext();
  const isManager = user?.role === 'manager' || user?.role === 'owner';
  const date = todayInTimezone(timezone);
  const [daySummary, setDaySummary] = useState({ assignments: [] });
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Per-assignment state: tab ('active'|'reviewed') and open/collapsed
  const [assignmentTabs, setAssignmentTabs] = useState({});   // { [id]: 'active'|'reviewed' }
  const [assignmentOpen, setAssignmentOpen] = useState({});   // { [id]: bool }

  const [reasonInput, setReasonInput] = useState({});
  const [showReasonFor, setShowReasonFor] = useState(null);
  const [closeNoteFor, setCloseNoteFor] = useState(null);
  const [closeNoteInput, setCloseNoteInput] = useState({});
  const [showPastAnnouncements, setShowPastAnnouncements] = useState(false);
  const [showStaff, setShowStaff] = useState(false);
  const [staffData, setStaffData] = useState([]);         // { user_id, display_name, role, location_name }
  const [staffLocationFilter, setStaffLocationFilter] = useState(null); // null = all; string = location name

  // PIN setup prompt (once per session for users without a PIN)
  const [showPinModal, setShowPinModal] = useState(false);

  useEffect(() => {
    if (user && !user.has_pin && !sessionStorage.getItem('pin_prompt_shown')) {
      sessionStorage.setItem('pin_prompt_shown', '1');
      setShowPinModal(true);
    }
  }, [user]);

  // Manager-only: emulate another user's dashboard view for troubleshooting
  const [viewAsUserId, setViewAsUserId] = useState('');
  const [allUsers, setAllUsers] = useState([]);
  const viewAsUser = viewAsUserId ? allUsers.find((u) => u.id === viewAsUserId) : null;

  useEffect(() => {
    if (isManager && user?.company_id) {
      getCompanyUsers(user.company_id)
        .then((data) => setAllUsers((data.users || []).filter((u) => u.role !== 'manager' && u.role !== 'owner')))
        .catch(() => {});
    }
  }, [isManager, user?.company_id]);

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [summaryRes, annRes, staffRes] = await Promise.all([
        getDaySummary(date, viewAsUserId || null),
        getActiveAnnouncements(date),
        getStaffSchedule(date),
      ]);
      // Derive available roles for sidebar emulation picker
      const roles = isManager
        ? [...new Set((summaryRes.assignments || []).map((a) => a.wage_title).filter(Boolean))].sort()
        : [];
      setDaySummary(summaryRes);
      setAvailableRoles(roles);
      setAnnouncements(annRes.announcements || []);
      setStaffData(staffRes.staff || []);
      // Default filter to user's own location for the day (null if no shift / manager)
      setStaffLocationFilter(staffRes.my_location || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [date, isManager, setAvailableRoles, viewAsUserId]);

  useEffect(() => { load(); }, [load]);

  // ── Per-assignment helpers ───────────────────────────────
  const getTab = (id) => assignmentTabs[id] || 'active';
  const setTab = (id, tab) => setAssignmentTabs((prev) => ({ ...prev, [id]: tab }));
  const isOpen = (id) => !!assignmentOpen[id]; // default collapsed on all screen sizes
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

  const handleSigned = (id, signedAt) => {
    setAnnouncements((prev) => prev.map((a) => (a.id === id ? { ...a, _signed_at: signedAt } : a)));
  };

  // When emulating, filter assignments to the selected role; otherwise show all
  const visibleAssignments = emulateRole
    ? (daySummary.assignments || []).filter((a) => a.wage_title === emulateRole)
    : (daySummary.assignments || []);

  // A policy blocks the gate until signed; a normal announcement blocks until acknowledged.
  const isRead = (a) => a.is_policy
    ? !!(a.my_signed_at || a._signed_at)
    : !!(a.my_acknowledged_at || a._acknowledged);
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
      {showPinModal && (
        <SetPinModal
          required={false}
          onClose={() => setShowPinModal(false)}
          onSuccess={() => setShowPinModal(false)}
        />
      )}
      {error && <p className="dashboard-error">{error}</p>}

      {isManager && (
        <div className={`view-as-bar${viewAsUserId ? ' view-as-bar--active' : ''}`}>
          <label htmlFor="view-as-select">🔍 View as:</label>
          <select
            id="view-as-select"
            value={viewAsUserId}
            onChange={(e) => setViewAsUserId(e.target.value)}
          >
            <option value="">— yourself (manager view) —</option>
            {allUsers
              .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''))
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name || u.email}
                </option>
              ))}
          </select>
          {viewAsUser && (
            <span className="view-as-label">
              Viewing as <strong>{viewAsUser.display_name || viewAsUser.email}</strong> — this is exactly what they see
              {daySummary.debug && (
                <span className="view-as-debug">
                  {' | '}
                  {!daySummary.debug.squareTmId
                    ? '⚠ No Square ID linked'
                    : daySummary.no_shift
                    ? `⚠ No shift found today (Square ID: ${daySummary.debug.squareTmId})`
                    : daySummary.debug.wageTitles?.length
                    ? `✓ Shift found · roles: ${daySummary.debug.wageTitles.join(', ')}`
                    : '⚠ Shift found but no wage title resolved'}
                </span>
              )}
            </span>
          )}
          {viewAsUserId && (
            <button type="button" className="view-as-clear" onClick={() => setViewAsUserId('')}>✕ Exit</button>
          )}
        </div>
      )}

      <div className="dashboard-main">
        {loading ? (
          <p className="dashboard-loading">Loading…</p>
        ) : unreadAnnouncements.length > 0 && !emulateRole ? (
          /* ── Announcement Gate ── (skipped when emulating a role) */
          <div className="announcement-gate">
            <div className="gate-header">
              <div className="gate-icon" aria-hidden>📢</div>
              <h2 className="gate-title">
                {unreadAnnouncements.length === 1
                  ? 'You have 1 announcement'
                  : `You have ${unreadAnnouncements.length} announcements`}
              </h2>
              <p className="gate-subtitle">
                Please read{unreadAnnouncements.some((a) => a.is_policy) ? ', and sign any policies,' : ' and acknowledge'} {unreadAnnouncements.length === 1 ? 'it' : 'each one'} before starting your tasks.
              </p>
            </div>
            <div className="gate-list">
              {unreadAnnouncements.map((a) => (
                <div key={a.id} className={`gate-card${a.is_policy ? ' gate-card-policy' : ''}`}>
                  {a.is_policy && <div className="policy-header-banner">POLICY</div>}
                  <h3 className="gate-card-title">{a.title}</h3>
                  {a.body && (
                    <div
                      className="gate-card-body"
                      dangerouslySetInnerHTML={{ __html: a.body }}
                    />
                  )}
                  {a.is_policy ? (
                    <PolicySignBox
                      policy={a}
                      currentUserName={user?.display_name}
                      onSigned={(signedAt) => handleSigned(a.id, signedAt)}
                    />
                  ) : (
                    <button type="button" className="btn-ack" onClick={() => handleAck(a.id)}>
                      Mark as Read
                    </button>
                  )}
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

            {/* Staff & Roles */}
            {staffData.length > 0 && (() => {
              const locationNames = [...new Set(staffData.map((s) => s.location_name).filter(Boolean))].sort();
              const filtered = staffLocationFilter
                ? staffData.filter((s) => s.location_name === staffLocationFilter)
                : staffData;
              // When showing all, group by location
              const grouped = staffLocationFilter
                ? null
                : locationNames.reduce((acc, loc) => {
                    acc[loc] = staffData.filter((s) => s.location_name === loc);
                    return acc;
                  }, {});
              const unlocated = staffData.filter((s) => !s.location_name);

              return (
                <div className="staff-section-wrap">
                  <button
                    type="button"
                    className="btn-past-toggle"
                    onClick={() => setShowStaff((v) => !v)}
                    aria-expanded={showStaff}
                  >
                    <span>👥 Staff Today ({staffData.length})</span>
                    <span className="past-chevron" aria-hidden>{showStaff ? '−' : '+'}</span>
                  </button>
                  {showStaff && (
                    <div className="staff-section-body">
                      {locationNames.length > 1 && (
                        <div className="staff-location-pills">
                          <button
                            type="button"
                            className={`btn-role-pill${!staffLocationFilter ? ' active' : ''}`}
                            onClick={() => setStaffLocationFilter(null)}
                          >
                            All
                          </button>
                          {locationNames.map((loc) => (
                            <button
                              key={loc}
                              type="button"
                              className={`btn-role-pill${staffLocationFilter === loc ? ' active' : ''}`}
                              onClick={() => setStaffLocationFilter(loc)}
                            >
                              {loc}
                            </button>
                          ))}
                        </div>
                      )}

                      {staffLocationFilter ? (
                        // Single location — flat list
                        <ul className="staff-list">
                          {filtered.map((s, i) => (
                            <li key={`${s.user_id}-${i}`} className="staff-row">
                              <span className="staff-name">{s.display_name}</span>
                              {s.role && <span className="staff-role">{s.role}</span>}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        // All locations — grouped
                        <>
                          {locationNames.map((loc) => (
                            <div key={loc} className="staff-group">
                              <p className="staff-group-label">{loc}</p>
                              <ul className="staff-list">
                                {grouped[loc].map((s, i) => (
                                  <li key={`${s.user_id}-${i}`} className="staff-row">
                                    <span className="staff-name">{s.display_name}</span>
                                    {s.role && <span className="staff-role">{s.role}</span>}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                          {unlocated.length > 0 && (
                            <div className="staff-group">
                              <p className="staff-group-label">Unassigned location</p>
                              <ul className="staff-list">
                                {unlocated.map((s, i) => (
                                  <li key={`${s.user_id}-${i}`} className="staff-row">
                                    <span className="staff-name">{s.display_name}</span>
                                    {s.role && <span className="staff-role">{s.role}</span>}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

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
                        <h4 className="past-card-title">
                          {a.is_policy && <span className="policy-inline-tag">POLICY</span>}
                          {a.title}
                        </h4>
                        {a.is_policy && (
                          <p className="hint">
                            ✓ Signed {(a.my_signed_at || a._signed_at) ? new Date(a.my_signed_at || a._signed_at).toLocaleDateString() : ''}
                          </p>
                        )}
                        {a.body && (
                          <div
                            className="announcement-body"
                            dangerouslySetInnerHTML={{ __html: a.body }}
                          />
                        )}
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
