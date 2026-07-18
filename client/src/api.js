const API = '/api';

function getToken() {
  return localStorage.getItem('teamtask_token');
}

function headers(includeAuth = true) {
  const h = { 'Content-Type': 'application/json' };
  if (includeAuth && getToken()) h['Authorization'] = `Bearer ${getToken()}`;
  return h;
}

export async function login(email, password, company_slug) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: headers(false),
    body: JSON.stringify({ email, password, company_slug: company_slug || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || (typeof data === 'string' ? data : 'Login failed');
    throw new Error(msg);
  }
  return data;
}

export async function register(company_id, email, password, display_name, role) {
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: headers(false),
    body: JSON.stringify({ company_id, email, password, display_name, role }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Registration failed');
  return data;
}

export async function me() {
  const res = await fetch(`${API}/auth/me`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Not authenticated');
  return data;
}

export async function setPin(pin) {
  const res = await fetch(`${API}/auth/set-pin`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ pin }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to set PIN');
  // Remember that this device's last user has a PIN, so the login page can
  // safely show the PIN pad on return.
  localStorage.setItem('teamtask_has_pin', '1');
  return data;
}

export async function pinLogin(email, pin) {
  const res = await fetch(`${API}/auth/pin-login`, {
    method: 'POST',
    headers: headers(false),
    body: JSON.stringify({ email, pin }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Invalid PIN');
  return data;
}

export async function getLocations() {
  const res = await fetch(`${API}/locations`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load locations');
  return data;
}

export async function getSquareLocations() {
  const res = await fetch(`${API}/locations/square`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load Square locations');
  return data;
}

export async function createLocation(body) {
  const payload = typeof body === 'string' ? { name: body.trim() } : body;
  const res = await fetch(`${API}/locations`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to create location');
  return data;
}

export async function updateLocation(id, body) {
  const res = await fetch(`${API}/locations/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update location');
  return data;
}

export async function deleteLocation(id) {
  const res = await fetch(`${API}/locations/${id}`, { method: 'DELETE', headers: headers() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete location');
  }
}

export async function getDaySummary(date, asUserId = null) {
  const params = new URLSearchParams({ date });
  if (asUserId) params.set('as_user_id', asUserId);
  const res = await fetch(`${API}/task-lists/day-summary?${params}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load tasks');
  return data;
}

// status: 'completed' | 'not_completed' | null (null = reset/undo)
// reason: required when status === 'not_completed'
export async function setTaskStatus(assignmentId, taskTemplateId, status, reason = null) {
  const res = await fetch(
    `${API}/task-lists/assignments/${assignmentId}/tasks/${taskTemplateId}/complete`,
    { method: 'PUT', headers: headers(), body: JSON.stringify({ status, reason }) }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update');
  return data;
}

// Legacy alias
export async function setTaskComplete(assignmentId, taskTemplateId, completed) {
  return setTaskStatus(assignmentId, taskTemplateId, completed ? 'completed' : null);
}

export async function getWageTitles() {
  const res = await fetch(`${API}/task-lists/wage-titles`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load wage titles');
  return data;
}

export async function getStaffSchedule(date) {
  const res = await fetch(`${API}/task-lists/staff-schedule?date=${encodeURIComponent(date)}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load staff schedule');
  return data;
}

export async function getActiveAnnouncements(date) {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await fetch(`${API}/announcements/active${q}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load announcements');
  return data;
}

export async function acknowledgeAnnouncement(id) {
  const res = await fetch(`${API}/announcements/${id}/acknowledge`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to acknowledge');
  return data;
}

export async function getTaskTemplates() {
  const res = await fetch(`${API}/task-lists/templates`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load templates');
  return data;
}

export async function getAssignments(date) {
  const res = await fetch(`${API}/task-lists/assignments?date=${encodeURIComponent(date)}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load assignments');
  return data;
}

export async function createAssignment(template_id, assigned_date, assignee_id) {
  const res = await fetch(`${API}/task-lists/assignments`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ template_id, assigned_date, assignee_id: assignee_id || null }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to create assignment');
  return data;
}

export async function deleteAssignment(id) {
  const res = await fetch(`${API}/task-lists/assignments/${id}`, { method: 'DELETE', headers: headers() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete assignment');
  }
}

export async function getSquareSchedule(date) {
  const res = await fetch(`${API}/task-lists/square-schedule?date=${encodeURIComponent(date)}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load schedule');
  return data;
}

export async function closeAssignment(id, note) {
  const res = await fetch(`${API}/task-lists/assignments/${id}/close`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to close task list');
  return data;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export async function createTaskListTemplate(name, type, period_type, options = {}) {
  const body = { name, type, period_type };
  if (period_type === 'weekly' && options.day_of_week != null) body.day_of_week = options.day_of_week;
  if (period_type === 'monthly' && options.day_of_month != null) body.day_of_month = options.day_of_month;
  if (period_type === 'yearly' && options.recur_month != null) body.recur_month = options.recur_month;
  if (period_type === 'yearly' && options.recur_day != null) body.recur_day = options.recur_day;
  if (options.location_ids != null && Array.isArray(options.location_ids)) body.location_ids = options.location_ids;
  if (options.wage_title != null) body.wage_title = options.wage_title;
  const res = await fetch(`${API}/task-lists/templates`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to create template');
  return data;
}

export { DAY_NAMES as taskDayNames, MONTH_NAMES as taskMonthNames };

export async function updateTaskListTemplate(id, body) {
  const res = await fetch(`${API}/task-lists/templates/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update template');
  return data;
}

export async function deleteTaskListTemplate(id) {
  const res = await fetch(`${API}/task-lists/templates/${id}`, { method: 'DELETE', headers: headers() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete template');
  }
}

export async function getTemplateTasks(templateId) {
  const res = await fetch(`${API}/task-lists/templates/${templateId}/tasks`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load tasks');
  return data;
}

export async function reorderTemplateTasks(templateId, taskIds) {
  const res = await fetch(`${API}/task-lists/templates/${templateId}/tasks/reorder`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ task_ids: taskIds }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to reorder tasks');
  return data;
}

export async function createTaskItem(templateId, title, sort_order, priority = 'must') {
  const res = await fetch(`${API}/task-lists/templates/${templateId}/tasks`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ title, sort_order, priority }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to add task');
  return data;
}

export async function updateTaskItem(taskId, body) {
  const res = await fetch(`${API}/task-lists/tasks/${taskId}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update task');
  return data;
}

export async function deleteTaskItem(taskId) {
  const res = await fetch(`${API}/task-lists/tasks/${taskId}`, { method: 'DELETE', headers: headers() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete task');
  }
}

export async function getAnnouncements(from, to) {
  let url = `${API}/announcements`;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (params.toString()) url += '?' + params.toString();
  const res = await fetch(url, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load announcements');
  return data;
}

export async function uploadAnnouncementImage(file) {
  const form = new FormData();
  form.append('image', file);
  const res = await fetch(`${API}/announcements/upload-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Image upload failed');
  }
  return res.json(); // { url }
}

export async function createAnnouncement(title, body, effective_from, effective_until, location_ids, approver_ids, is_policy) {
  const res = await fetch(`${API}/announcements`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, effective_from, effective_until, location_ids, approver_ids, is_policy }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to create announcement');
  return data;
}

export async function updateAnnouncement(id, body) {
  const res = await fetch(`${API}/announcements/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update announcement');
  return data;
}

export async function deleteAnnouncement(id) {
  const res = await fetch(`${API}/announcements/${id}`, { method: 'DELETE', headers: headers() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete announcement');
  }
}

export async function approveAnnouncement(id, status, comment) {
  const res = await fetch(`${API}/announcements/${id}/approve`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, comment }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to submit approval');
  return data;
}

export async function publishAnnouncement(id) {
  const res = await fetch(`${API}/announcements/${id}/publish`, {
    method: 'POST',
    headers: headers(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to publish announcement');
  return data;
}

export async function getPendingMyApproval() {
  const res = await fetch(`${API}/announcements/pending-my-approval`, { headers: headers() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load pending approvals');
  return data;
}

export async function getAnnouncementAcknowledgments(id) {
  const res = await fetch(`${API}/announcements/${id}/acknowledgments`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load');
  return data;
}

export async function signPolicy(id, signedName) {
  const res = await fetch(`${API}/announcements/${id}/sign`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ signed_name: signedName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to sign policy');
  return data;
}

export async function getPolicySignatures(id) {
  const res = await fetch(`${API}/announcements/${id}/signatures`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load signatures');
  return data;
}

export async function getPolicies() {
  const res = await fetch(`${API}/announcements/policies`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load policies');
  return data;
}

export async function getIngredients() {
  const res = await fetch(`${API}/food-waste/ingredients`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load ingredients');
  return data;
}

export async function createIngredient(name) {
  const res = await fetch(`${API}/food-waste/ingredients`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ name: name.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to create ingredient');
  return data;
}

export async function updateIngredient(id, name) {
  const res = await fetch(`${API}/food-waste/ingredients/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ name: name.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update ingredient');
  return data;
}

export async function deleteIngredient(id) {
  const res = await fetch(`${API}/food-waste/ingredients/${id}`, { method: 'DELETE', headers: headers() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete ingredient');
  }
}

export async function getFoodWasteEntries(from, to, location_id) {
  let url = `${API}/food-waste/entries`;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (location_id) params.set('location_id', location_id);
  if (params.toString()) url += '?' + params.toString();
  const res = await fetch(url, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load entries');
  return data;
}

export async function getFoodWasteEntry(entryId) {
  const res = await fetch(`${API}/food-waste/entries/${entryId}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load entry');
  return data;
}

export async function createFoodWasteEntry(title, entry_date, location_id) {
  const body = { title, entry_date };
  if (location_id != null) body.location_id = location_id;
  const res = await fetch(`${API}/food-waste/entries`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to create entry');
  return data;
}

export async function updateFoodWasteEntry(entryId, body) {
  const res = await fetch(`${API}/food-waste/entries/${entryId}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update entry');
  return data;
}

export async function addFoodWasteItem(entryId, ingredient_id, quantity, unit) {
  const res = await fetch(`${API}/food-waste/entries/${entryId}/items`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ingredient_id, quantity, unit: unit || null }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to add item');
  return data;
}

export async function getFoodWasteReport(from, to, location_id) {
  let url = `${API}/food-waste/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (location_id) url += `&location_id=${encodeURIComponent(location_id)}`;
  const res = await fetch(url, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load report');
  return data;
}

export async function getTaskReport(from, to) {
  const res = await fetch(
    `${API}/task-lists/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { headers: headers() }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load report');
  return data;
}

export async function getDebtReport(priorYear, currentYear) {
  const q = new URLSearchParams();
  if (priorYear != null) q.set('prior_year', String(priorYear));
  if (currentYear != null) q.set('current_year', String(currentYear));
  const res = await fetch(`${API}/debt/report?${q}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load debt report');
  return data;
}

export async function postDebtBalancesBulk(balances) {
  const res = await fetch(`${API}/debt/balances/bulk`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ balances }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save balances');
  return data;
}

/** debt_ceiling: number, or null / omit to clear */
export async function putDebtCeiling(debt_ceiling) {
  // Use balances/bulk so ceiling saves use the same POST route as monthly balances (avoids 404 on /debt/ceiling if that path is not deployed or routed).
  const res = await fetch(`${API}/debt/balances/bulk`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ balances: [], debt_ceiling }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save debt ceiling');
  if (!('debt_ceiling' in data)) {
    throw new Error(
      'The server accepted the request but did not save the debt ceiling. Deploy the latest API (debt routes) so optional debt_ceiling on balances/bulk is enabled.'
    );
  }
  return data;
}

export async function getCompanyUsers(companyId) {
  const res = await fetch(`${API}/companies/${companyId}/users`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load users');
  return data;
}

export async function updateUser(companyId, userId, body) {
  const res = await fetch(`${API}/companies/${companyId}/users/${userId}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update user');
  return data;
}

export async function deleteUser(companyId, userId) {
  const res = await fetch(`${API}/companies/${companyId}/users/${userId}`, {
    method: 'DELETE',
    headers: headers(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to delete user');
  return data;
}

export async function sendPasswordResetEmail(userId) {
  const res = await fetch(`${API}/auth/send-reset-email`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ user_id: userId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to send reset email');
  return data;
}

export async function forgotPassword(email, company_slug) {
  const res = await fetch(`${API}/auth/forgot-password`, {
    method: 'POST',
    headers: headers(false),
    body: JSON.stringify({ email, company_slug: company_slug || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export async function resetPassword(token, new_password) {
  const res = await fetch(`${API}/auth/reset-password`, {
    method: 'POST',
    headers: headers(false),
    body: JSON.stringify({ token, new_password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Reset failed');
  return data;
}

export async function squareGetTeamMembers() {
  const res = await fetch(`${API}/integrations/square/team-members`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load team members');
  return data;
}

export async function squareSyncUsers() {
  const res = await fetch(`${API}/integrations/square/sync-users`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sync users failed');
  return data;
}

export async function setSquareUserExcluded(square_team_member_id, excluded) {
  const res = await fetch(`${API}/integrations/square/exclusions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ square_team_member_id, excluded }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update exclusion');
  return data;
}

export async function sendSms(user_ids, message_body) {
  const res = await fetch(`${API}/integrations/twilio/send`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ user_ids, message_body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Send failed');
  return data;
}

export async function getSmsLog() {
  const res = await fetch(`${API}/integrations/sms-log`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load log');
  return data;
}

export async function getIntegrationSettings() {
  const res = await fetch(`${API}/settings/integrations`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load settings');
  return data;
}

export async function putIntegrationSettings(body) {
  const res = await fetch(`${API}/settings/integrations`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save settings');
  return data;
}

export async function testSquareConnection(body = {}) {
  const res = await fetch(`${API}/settings/integrations/test-square`, {
    method: 'POST',
    headers: headers(),
    body: Object.keys(body).length ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.details || 'Square test failed');
  return data;
}

export async function testTwilioConnection(body = {}) {
  const res = await fetch(`${API}/settings/integrations/test-twilio`, {
    method: 'POST',
    headers: headers(),
    body: Object.keys(body).length ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Twilio test failed');
  return data;
}

export async function testMail() {
  const res = await fetch(`${API}/settings/mail/test`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Test email failed');
  return data;
}

export async function getQBOStatus() {
  const res = await fetch(`${API}/integrations/qbo/status`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load QBO status');
  return data;
}

export async function syncQBO() {
  const res = await fetch(`${API}/integrations/qbo/sync`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sync failed');
  return data;
}

export async function getQBOConnectUrl() {
  const res = await fetch(`${API}/integrations/qbo/connect-url`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to get QuickBooks connect URL');
  return data;
}

export async function disconnectQBO() {
  const res = await fetch(`${API}/integrations/qbo/disconnect`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to disconnect QuickBooks');
  return data;
}

// ── Receipts ──────────────────────────────────────────────────────────────────

// ── Harvester ────────────────────────────────────────────────────────────────

export async function getHarvesterSources() {
  const res = await fetch(`${API}/harvester/sources`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load harvester sources');
  return data;
}

export async function updateHarvesterSource(id, body) {
  const res = await fetch(`${API}/harvester/sources/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update harvester source');
  return data;
}

export async function runHarvesterSource(id) {
  const res = await fetch(`${API}/harvester/sources/${id}/run`, {
    method: 'POST',
    headers: headers(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to trigger harvester run');
  return data;
}

export async function uploadReceipts(files) {
  const formData = new FormData();
  for (const file of files) formData.append('pdfs', file);
  const res = await fetch(`${API}/receipts/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` }, // no Content-Type — let browser set boundary
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

export async function getReceipts(status, { source, vendor } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (source) params.set('source', source);
  if (vendor) params.set('vendor', vendor);
  const qs = params.toString() ? `?${params}` : '';
  const res = await fetch(`${API}/receipts${qs}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load receipts');
  return data;
}

export async function deleteReceipt(id) {
  const res = await fetch(`${API}/receipts/${id}`, { method: 'DELETE', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to delete receipt');
  return data;
}

export async function getReceipt(id) {
  const res = await fetch(`${API}/receipts/${id}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load receipt');
  return data;
}

// Fetch the receipt PDF (auth-protected) as a blob and open it in a new tab.
export async function openReceiptPdf(id) {
  const res = await fetch(`${API}/receipts/${id}/pdf`, { headers: headers() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load PDF');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  // Release the object URL after a delay so the new tab has time to load it
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function processReceiptWithAI(receiptId) {
  const res = await fetch(`${API}/receipts/${receiptId}/process`, {
    method: 'POST',
    headers: headers(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to process receipt with AI');
  return data;
}

export async function getQboImportVendors() {
  const res = await fetch(`${API}/receipts/qbo-vendors`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load QBO vendors');
  return data.vendors;
}

export async function previewQboImport({ vendorId, startDate, endDate }) {
  const res = await fetch(`${API}/receipts/qbo-preview`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ vendorId, startDate, endDate }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to preview QBO receipts');
  return data.purchases;
}

export async function importFromQbo(purchaseIds) {
  const res = await fetch(`${API}/receipts/qbo-import`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ purchaseIds }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'QBO import failed');
  return data.results;
}

export async function saveReceiptItems(receiptId, items) {
  const res = await fetch(`${API}/receipts/${receiptId}/items`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ items }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save receipt items');
  return data;
}

export async function acceptAllItems(receiptId) {
  const res = await fetch(`${API}/receipts/${receiptId}/accept-all`, {
    method: 'POST',
    headers: headers(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to accept items');
  return data;
}

// ── QBO Export ───────────────────────────────────────────────────────────────

export async function getPaymentAccounts() {
  const res = await fetch(`${API}/receipts/export/payment-accounts`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load payment accounts');
  return data;
}

export async function savePaymentAccount(account_id) {
  const res = await fetch(`${API}/receipts/export/payment-accounts`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ account_id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save payment account');
  return data;
}

export async function searchQBOPurchases(payment_account_id, center_date) {
  const res = await fetch(`${API}/receipts/export/search`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ payment_account_id, center_date }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to search QBO');
  return data;
}

export async function previewExport(payment_account_id) {
  const res = await fetch(`${API}/receipts/export/preview`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ payment_account_id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to preview export');
  return data;
}

export async function confirmExport(exports) {
  const res = await fetch(`${API}/receipts/export/confirm`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ exports }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to confirm export');
  return data;
}

// ── Categorization Rules ──────────────────────────────────────────────────────

export async function getRules() {
  const res = await fetch(`${API}/receipts/rules`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load rules');
  return data;
}

export async function createRule(rule) {
  const res = await fetch(`${API}/receipts/rules`, { method: 'POST', headers: headers(), body: JSON.stringify(rule) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) {
    const err = new Error(data.message || 'Rule keyword conflict');
    err.conflict = true;
    err.conflicts = data.conflicts || [];
    throw err;
  }
  if (!res.ok) throw new Error(data.error || 'Failed to create rule');
  return data;
}

export async function updateRule(id, rule) {
  const res = await fetch(`${API}/receipts/rules/${id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(rule) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update rule');
  return data;
}

export async function deleteRule(id) {
  const res = await fetch(`${API}/receipts/rules/${id}`, { method: 'DELETE', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to delete rule');
  return data;
}

export async function reapplyRules(receiptId) {
  const res = await fetch(`${API}/receipts/${receiptId}/reapply-rules`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to re-apply rules');
  return data;
}

export async function reapplyAllRules() {
  const res = await fetch(`${API}/receipts/reapply-all-rules`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to re-apply rules');
  return data;
}

export async function categorizeAllReceipts() {
  const res = await fetch(`${API}/receipts/categorize-all`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to run AI categorization');
  return data;
}

export async function suggestRule(corrections) {
  const res = await fetch(`${API}/receipts/suggest-rule`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ corrections }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to suggest rule');
  return data;
}

// ── Amazon Order History ──────────────────────────────────────────────────────

export async function uploadAmazonCSV(file) {
  const formData = new FormData();
  formData.append('csv', file);
  const res = await fetch(`${API}/amazon-orders/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}` },
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

export async function getAmazonPayments() {
  const res = await fetch(`${API}/amazon-orders`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load amazon orders');
  return data;
}

export async function getAmazonStats() {
  const res = await fetch(`${API}/amazon-orders/stats`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load stats');
  return data;
}

export async function runAmazonSync() {
  const res = await fetch(`${API}/amazon-orders/sync`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sync failed');
  return data;
}

// ── Amazon Business settings ──────────────────────────────────────────────────

export async function getAmazonSettings() {
  const res = await fetch(`${API}/settings/amazon`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load Amazon settings');
  return data;
}

export async function putAmazonSettings(body) {
  const res = await fetch(`${API}/settings/amazon`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save Amazon settings');
  return data;
}

export async function testAmazonLogin(body) {
  const res = await fetch(`${API}/settings/amazon/test`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Test failed');
  return data;
}

// ── Sysco Shop settings ───────────────────────────────────────────────────────

export async function getSyscoSettings() {
  const res = await fetch(`${API}/settings/sysco`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load Sysco settings');
  return data;
}

export async function putSyscoSettings(body) {
  const res = await fetch(`${API}/settings/sysco`, {
    method: 'PUT', headers: headers(), body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save Sysco settings');
  return data;
}

export async function testSyscoLogin(body) {
  const res = await fetch(`${API}/settings/sysco/test`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sysco login failed');
  return data;
}

export async function lookupSyscoItem(itemNumber) {
  const res = await fetch(`${API}/settings/sysco/lookup`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ item_number: itemNumber }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sysco lookup failed');
  return data;
}

// ── Card → QBO Account Mappings ───────────────────────────────────────────────

export async function getCardMappings() {
  const res = await fetch(`${API}/card-mappings`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load card mappings');
  return data;
}

export async function saveCardMapping(mapping) {
  const res = await fetch(`${API}/card-mappings`, {
    method: 'POST', headers: headers(), body: JSON.stringify(mapping),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save card mapping');
  return data;
}

export async function deleteCardMapping(id) {
  const res = await fetch(`${API}/card-mappings/${id}`, { method: 'DELETE', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to delete mapping');
  return data;
}

export async function getGeneralSettings() {
  const res = await fetch(`${API}/settings/general`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load general settings');
  return data;
}

export async function patchGeneralSettings(payload) {
  const res = await fetch(`${API}/settings/general`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save general settings');
  return data;
}

export async function getSquareEmployees() {
  const res = await fetch(`${API}/settings/square-employees`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load Square employees');
  return data;
}

// ── Products MDS ──────────────────────────────────────────────────────────────

export async function getProducts(params = {}) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
  ).toString();
  const res = await fetch(`${API}/products${qs ? `?${qs}` : ''}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load products');
  return data;
}

export async function getProductFilters() {
  const res = await fetch(`${API}/products/filters`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load product filters');
  return data;
}

export async function getProduct(id) {
  const res = await fetch(`${API}/products/${id}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load product');
  return data;
}

// ── Wine Inventory ─────────────────────────────────────────────────────────────

export async function getWineInventoryList(locationId) {
  const res = await fetch(`${API}/products/inventory?location_id=${encodeURIComponent(locationId)}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load inventory list');
  return data;
}

export async function saveWineInventoryCount({ product_id, location_id, cases, bottles }) {
  const res = await fetch(`${API}/products/inventory`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id, location_id, cases, bottles }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save count');
  return data;
}

export async function getWineInventoryReport({ asOf, locationId, allItems }) {
  const qs = new URLSearchParams({
    as_of: asOf || '',
    location_id: locationId || 'all',
    all_items: allItems ? 'true' : 'false',
  }).toString();
  const res = await fetch(`${API}/products/inventory/report?${qs}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load inventory report');
  return data;
}

// ── Commerce7 Settings ────────────────────────────────────────────────────────

export async function getC7Settings() {
  const res = await fetch(`${API}/settings/commerce7`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load Commerce7 settings');
  return data;
}

export async function putC7Settings(payload) {
  const res = await fetch(`${API}/settings/commerce7`, {
    method: 'PUT', headers: headers(), body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to save Commerce7 settings');
  return data;
}

export async function testC7Connection(body = {}) {
  const res = await fetch(`${API}/settings/commerce7/test`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Test failed');
  return data;
}

export async function importC7Products() {
  const res = await fetch(`${API}/products/import/c7`, {
    method: 'POST', headers: headers(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Import failed');
  return data;
}

// ── Tax Exempt Items ──────────────────────────────────────────────────────────

export async function getSquareItems() {
  const res = await fetch(`${API}/products/square-items`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load Square items');
  return data; // { items: string[] }
}

export async function getTaxExemptItems() {
  const res = await fetch(`${API}/products/tax-exempt`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load tax-exempt items');
  return data; // { items: [{id, item_name, created_at}] }
}

export async function addTaxExemptItem(itemName) {
  const res = await fetch(`${API}/products/tax-exempt`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ item_name: itemName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to add exempt item');
  return data;
}

export async function removeTaxExemptItem(id) {
  const res = await fetch(`${API}/products/tax-exempt/${id}`, {
    method: 'DELETE', headers: headers(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to remove exempt item');
  }
}

export async function getTaxGap() {
  const res = await fetch(`${API}/products/tax-gap`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to run tax gap check');
  return data; // { items, total }
}

// ── Square sync objects ──────────────────────────────────────────────────────
export async function getSquareSyncObjects() {
  const res = await fetch(`${API}/square/sync/objects`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load sync objects');
  return data; // { objects: [...] }
}

export async function updateSquareSyncObject(id, body) {
  const res = await fetch(`${API}/square/sync/objects/${id}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update');
  return data; // { object }
}

export async function runSquareSyncObject(id) {
  const res = await fetch(`${API}/square/sync/objects/${id}/run`, {
    method: 'POST', headers: headers(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sync failed');
  return data;
}

// ── Commerce7 Sync Objects ────────────────────────────────────────────────────

export async function getC7SyncObjects() {
  const res = await fetch(`${API}/commerce7/sync/objects`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load C7 sync objects');
  return data; // { objects: [...] }
}

export async function updateC7SyncObject(id, body) {
  const res = await fetch(`${API}/commerce7/sync/objects/${id}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update');
  return data; // { object }
}

export async function runC7SyncObject(id) {
  const res = await fetch(`${API}/commerce7/sync/objects/${id}/run`, {
    method: 'POST', headers: headers(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sync failed');
  return data;
}

export async function getCatalogTaxGaps() {
  const res = await fetch(`${API}/products/catalog-tax-gaps`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load catalog tax gaps');
  return data; // { items: [...] }
}

export async function updateProduct(id, data) {
  const res = await fetch(`${API}/products/${id}`, {
    method: 'PUT', headers: headers(), body: JSON.stringify(data),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to update product');
  return d;
}

export async function createProduct(data) {
  const res = await fetch(`${API}/products`, {
    method: 'POST', headers: headers(), body: JSON.stringify(data),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to create product');
  return d;
}

// ── Skynet ────────────────────────────────────────────────────────────────────
export async function getSkynetConfig() {
  const res = await fetch(`${API}/skynet/config`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load Skynet config');
  return d;
}

export async function saveSkynetConfig(data) {
  const res = await fetch(`${API}/skynet/config`, {
    method: 'PUT', headers: headers(), body: JSON.stringify(data),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to save Skynet config');
  return d;
}

export async function getSkynetAgents() {
  const res = await fetch(`${API}/skynet/agents`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load agents');
  return d; // { agents: [...] }
}

export async function getSkynetSchedules() {
  const res = await fetch(`${API}/skynet/schedules`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load schedules');
  return d; // { schedules: [...] }
}

export async function createSkynetSchedule(data) {
  const res = await fetch(`${API}/skynet/schedules`, {
    method: 'POST', headers: headers(), body: JSON.stringify(data),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to create schedule');
  return d;
}

export async function updateSkynetSchedule(id, data) {
  const res = await fetch(`${API}/skynet/schedules/${id}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(data),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to update schedule');
  return d;
}

export async function deleteSkynetSchedule(id) {
  const res = await fetch(`${API}/skynet/schedules/${id}`, {
    method: 'DELETE', headers: headers(),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to delete schedule');
  return d;
}

export async function runSkynetScheduleNow(id) {
  const res = await fetch(`${API}/skynet/schedules/${id}/run`, {
    method: 'POST', headers: headers(),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to trigger schedule');
  return d;
}

export async function testSkynetRun({ agentId, prompt, name }) {
  const res = await fetch(`${API}/skynet/test`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, prompt, name }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Test run failed');
  return d;
}

// ── Ground Control (Rachio) ───────────────────────────────────────────────────
export async function getGCZones() {
  const res = await fetch(`${API}/ground-control/zones`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load zones');
  return d; // { zones: [...] }
}

export async function startGCZone(zoneId, duration_minutes) {
  const res = await fetch(`${API}/ground-control/zones/${zoneId}/start`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ duration_minutes }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to start zone');
  return d;
}

export async function stopAllGCZones() {
  const res = await fetch(`${API}/ground-control/zones/stop-all`, {
    method: 'PUT', headers: headers(),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to stop all zones');
  return d;
}

export async function getGCSchedules() {
  const res = await fetch(`${API}/ground-control/schedules`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load schedules');
  return d; // { schedules: [...] }
}

export async function createGCSchedule(data) {
  const res = await fetch(`${API}/ground-control/schedules`, {
    method: 'POST', headers: headers(), body: JSON.stringify(data),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to create schedule');
  return d;
}

export async function updateGCSchedule(id, data) {
  const res = await fetch(`${API}/ground-control/schedules/${id}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(data),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to update schedule');
  return d;
}

export async function deleteGCSchedule(id) {
  const res = await fetch(`${API}/ground-control/schedules/${id}`, {
    method: 'DELETE', headers: headers(),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to delete schedule');
  return d;
}

// ── Home Assistant ────────────────────────────────────────────────────────────
export async function getHAStates() {
  const res = await fetch(`${API}/ground-control/ha/states`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load HA states');
  return d; // { entities: [...] }
}

export async function callHAService(domain, service, data = {}) {
  const res = await fetch(`${API}/ground-control/ha/service`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ domain, service, data }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to call HA service');
  return d;
}

export async function getAiModelSettings() {
  const res = await fetch(`${API}/settings/ai-models`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load AI model settings');
  return d;
}

export async function saveAiModelSettings(settings) {
  const res = await fetch(`${API}/settings/ai-models`, {
    method: 'PUT', headers: headers(), body: JSON.stringify({ settings }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to save AI model settings');
  return d;
}

// ── Recipes ──────────────────────────────────────────────────────────────────

export async function getRecipesCatalog({ status = 'unignored', search = '', page = 1, limit = 100, grocery = true } = {}) {
  const q = new URLSearchParams({ status, page, limit, grocery: grocery ? '1' : '0' });
  if (search) q.set('search', search);
  const res = await fetch(`${API}/recipes/catalog?${q}`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load catalog');
  return d;
}

export async function patchRecipesCatalogItem(id, body) {
  const res = await fetch(`${API}/recipes/catalog/${id}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to update catalog item');
  return d;
}

export async function inferCatalogUnits() {
  const res = await fetch(`${API}/recipes/catalog/infer-units`, {
    method: 'POST', headers: headers(),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Infer units failed');
  return d;
}

export async function bulkSetCatalogUnit(ids, unit) {
  const res = await fetch(`${API}/recipes/catalog/bulk-unit`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ ids, unit }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Bulk unit update failed');
  return d;
}

export async function backfillRecipesCatalog() {
  const res = await fetch(`${API}/recipes/catalog/backfill`, {
    method: 'POST', headers: headers(),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Backfill failed');
  return d;
}

export async function getCatalogItemPurchases(id) {
  const res = await fetch(`${API}/recipes/catalog/${id}/purchases`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load purchases');
  return d;
}

export async function enrichRecipesCatalog(ids) {
  const res = await fetch(`${API}/recipes/catalog/enrich`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify(ids ? { ids } : {}),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Enrichment failed');
  return d;
}

export async function getRecipesIngredients() {
  const res = await fetch(`${API}/recipes/ingredients`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load ingredients');
  return d;
}

export async function getRecipesIngredient(id) {
  const res = await fetch(`${API}/recipes/ingredients/${id}`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load ingredient');
  return d;
}

export async function createRecipesIngredient(body) {
  const res = await fetch(`${API}/recipes/ingredients`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to create ingredient');
  return d;
}

export async function updateRecipesIngredient(id, body) {
  const res = await fetch(`${API}/recipes/ingredients/${id}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to update ingredient');
  return d;
}

export async function deleteRecipesIngredient(id) {
  const res = await fetch(`${API}/recipes/ingredients/${id}`, { method: 'DELETE', headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to delete ingredient');
  return d;
}

// ── Kitchen inventory (on-hand counts per ingredient × location) ──────────────
export async function getKitchenInventory(locationId) {
  const url = locationId ? `${API}/recipes/inventory?location_id=${locationId}` : `${API}/recipes/inventory`;
  const res = await fetch(url, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load inventory');
  return d;
}

export async function updateKitchenInventoryCount(ingredientId, locationId, body) {
  const res = await fetch(`${API}/recipes/inventory/${ingredientId}/${locationId}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to update count');
  return d;
}

export async function reorderKitchenInventory(locationId, order) {
  const res = await fetch(`${API}/recipes/inventory/reorder`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ location_id: locationId, order }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to save order');
  return d;
}

export async function getKitchenShoppingList(locationId) {
  const url = locationId ? `${API}/recipes/shopping-list?location_id=${locationId}` : `${API}/recipes/shopping-list`;
  const res = await fetch(url, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load shopping list');
  return d;
}

// Set a per-location par level (manager). body: { par_qty, par_unit }
export async function setKitchenPar(ingredientId, locationId, body) {
  const res = await fetch(`${API}/recipes/inventory/${ingredientId}/${locationId}/par`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to set par');
  return d;
}

export async function getKitchenSettings() {
  const res = await fetch(`${API}/recipes/kitchen-settings`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load kitchen settings');
  return d;
}

// Update the single company-wide cost to shop (manager). body: { cost_to_shop }
export async function updateKitchenSettings(body) {
  const res = await fetch(`${API}/recipes/kitchen-settings`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to save kitchen settings');
  return d;
}

export async function getRecipes(params = {}) {
  const q = new URLSearchParams(params);
  const res = await fetch(`${API}/recipes?${q}`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load recipes');
  return d;
}

export async function getRecipe(id) {
  const res = await fetch(`${API}/recipes/${id}`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load recipe');
  return d;
}

export async function createRecipe(body) {
  const res = await fetch(`${API}/recipes`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to create recipe');
  return d;
}

export async function updateRecipe(id, body) {
  const res = await fetch(`${API}/recipes/${id}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to update recipe');
  return d;
}

export async function deleteRecipe(id) {
  const res = await fetch(`${API}/recipes/${id}`, { method: 'DELETE', headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to delete recipe');
  return d;
}

export async function uploadRecipePhoto(id, file) {
  const form = new FormData();
  form.append('photo', file);
  const tok = getToken();
  const res = await fetch(`${API}/recipes/${id}/photo`, {
    method: 'POST',
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    body: form,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to upload photo');
  return d;
}

export async function putRecipeIngredients(id, ingredients) {
  const res = await fetch(`${API}/recipes/${id}/ingredients`, {
    method: 'PUT', headers: headers(), body: JSON.stringify({ ingredients }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to save ingredients');
  return d;
}

export async function getRecipesCategories() {
  const res = await fetch(`${API}/recipes/meta/categories`, { headers: headers() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Failed to load categories');
  return d;
}
