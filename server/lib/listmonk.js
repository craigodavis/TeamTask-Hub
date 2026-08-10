/**
 * listmonk API client.
 *
 * listmonk owns the list, the sending and the unsubscribe machinery; TeamHub
 * owns the composing. This module is the seam between them, and it is
 * deliberately thin — every function here maps to one listmonk endpoint, so
 * when something goes wrong there is one place it can have gone wrong.
 *
 * Auth is a listmonk "API user": Admin -> Users -> New -> type API, which
 * issues a token. Header format is `token <username>:<token>` (not Bearer).
 */

const BASE = (process.env.LISTMONK_URL || '').replace(/\/+$/, '');
const USER = process.env.LISTMONK_API_USER || '';
const TOKEN = process.env.LISTMONK_API_TOKEN || '';

export function listmonkConfigured() {
  return Boolean(BASE && USER && TOKEN);
}

async function call(method, path, body) {
  if (!listmonkConfigured()) {
    throw new Error(
      'listmonk is not configured. Set LISTMONK_URL, LISTMONK_API_USER and ' +
      'LISTMONK_API_TOKEN in the server environment.',
    );
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `token ${USER}:${TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // listmonk returns {data:...} on success and {message:...} on error. Read the
  // body before deciding: its 4xx messages are specific ("template not found",
  // "list does not exist") and far more useful than the status code alone.
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text }; }

  if (!res.ok) {
    throw new Error(`listmonk ${method} ${path} -> ${res.status}: ${json.message || text}`);
  }
  return json.data;
}

export const getLists     = () => call('GET', '/api/lists?per_page=100');
export const getTemplates = () => call('GET', '/api/templates');

/** Create a list. `single` opt-in: we already have consent, so don't re-ask. */
export const createList = (name) =>
  call('POST', '/api/lists', { name, type: 'public', optin: 'single' });

/**
 * Add a subscriber. Throws on 409 (already on the list) like any other error —
 * callers that treat that as success should match on the status in the message.
 */
export const addSubscriber = (payload) => call('POST', '/api/subscribers', payload);

/**
 * Look up one subscriber by address. Returns null when absent.
 *
 * Needed because a 409 from addSubscriber means "we already hold this address"
 * without saying why — and the two reasons could not be more different. Already
 * subscribed is the desired end state; blocklisted means the person asked us to
 * stop, and quietly reporting success for them is how a suppression gets
 * treated as a signup.
 */
export async function findSubscriber(email) {
  const sql = `subscribers.email = '${String(email).replace(/'/g, "''")}'`;
  const d = await call('GET', `/api/subscribers?per_page=1&query=${encodeURIComponent(sql)}`);
  return d?.results?.[0] || null;
}

/**
 * Lift a blocklist and put the person on a list, for someone who has come back
 * and asked. PUT replaces the record, so the existing name and attribs are sent
 * back with it — attribs carry why they were suppressed, and losing that would
 * destroy the only evidence of what happened.
 */
export const updateSubscriber = (id, payload) =>
  call('PUT', `/api/subscribers/${id}`, payload);

/**
 * Find the Kindred template's id. Pushing a campaign without naming a template
 * silently lands it on listmonk's default, which is the stock listmonk shell —
 * an off-brand email that looks like a mistake to five thousand people.
 */
export async function kindredTemplateId() {
  const templates = await getTemplates();
  const t = (templates || []).find((x) => x.name === 'Kindred Vineyards');
  if (!t) throw new Error('The "Kindred Vineyards" template is missing from listmonk.');
  return t.id;
}

/**
 * Create or update the listmonk campaign backing a TeamHub campaign.
 *
 * Always lands as a draft. Sending is a separate, deliberate act — a composer
 * that can also send is one misclick away from mailing the whole list a
 * half-written email, and there is no recall.
 */
export async function upsertCampaign({
  listmonkId, name, subject, body, listIds, templateId, fromEmail,
}) {
  const payload = {
    name,
    subject,
    lists: listIds,
    template_id: templateId,
    content_type: 'html',
    body,
    type: 'regular',
    ...(fromEmail ? { from_email: fromEmail } : {}),
  };

  if (listmonkId) {
    try {
      return await call('PUT', `/api/campaigns/${listmonkId}`, payload);
    } catch (err) {
      // A campaign deleted in listmonk shouldn't strand the TeamHub record —
      // fall through and make a new one rather than failing every push forever.
      if (!/404|not found/i.test(err.message)) throw err;
    }
  }
  return call('POST', '/api/campaigns', payload);
}

/**
 * Send a test to named addresses. listmonk requires the campaign to exist
 * first, and only sends to addresses already present as subscribers.
 */
export const sendTest = (id, emails) =>
  call('POST', `/api/campaigns/${id}/test`, { subscribers: emails });

export default {
  listmonkConfigured, getLists, getTemplates, kindredTemplateId,
  upsertCampaign, sendTest,
};
