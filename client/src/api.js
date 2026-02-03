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

export async function getDaySummary(date) {
  const res = await fetch(`${API}/task-lists/day-summary?date=${encodeURIComponent(date)}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load tasks');
  return data;
}

export async function setTaskComplete(assignmentId, taskTemplateId, completed) {
  const res = await fetch(
    `${API}/task-lists/assignments/${assignmentId}/tasks/${taskTemplateId}/complete`,
    { method: 'PUT', headers: headers(), body: JSON.stringify({ completed }) }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update');
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

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export async function createTaskListTemplate(name, type, period_type, options = {}) {
  const body = { name, type, period_type };
  if (period_type === 'weekly' && options.day_of_week != null) body.day_of_week = options.day_of_week;
  if (period_type === 'monthly' && options.day_of_month != null) body.day_of_month = options.day_of_month;
  if (period_type === 'yearly' && options.recur_month != null) body.recur_month = options.recur_month;
  if (period_type === 'yearly' && options.recur_day != null) body.recur_day = options.recur_day;
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

export async function createTaskItem(templateId, title, sort_order) {
  const res = await fetch(`${API}/task-lists/templates/${templateId}/tasks`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ title, sort_order }),
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

export async function createAnnouncement(title, body, effective_from, effective_until) {
  const res = await fetch(`${API}/announcements`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ title, body, effective_from, effective_until }),
  });
  const data = await res.json().catch(() => ({}));
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

export async function getAnnouncementAcknowledgments(id) {
  const res = await fetch(`${API}/announcements/${id}/acknowledgments`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load');
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

export async function getFoodWasteEntries(from, to) {
  let url = `${API}/food-waste/entries`;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
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

export async function createFoodWasteEntry(title, entry_date) {
  const res = await fetch(`${API}/food-waste/entries`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ title, entry_date }),
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

export async function squareSync() {
  const res = await fetch(`${API}/integrations/square/sync`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sync failed');
  return data;
}

export async function squareAddUsers(users) {
  const res = await fetch(`${API}/integrations/square/add-users`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ users }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Add users failed');
  return data;
}

export async function squareSyncUsers() {
  const res = await fetch(`${API}/integrations/square/sync-users`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sync users failed');
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

export async function testMail() {
  const res = await fetch(`${API}/settings/mail/test`, { method: 'POST', headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Test email failed');
  return data;
}
