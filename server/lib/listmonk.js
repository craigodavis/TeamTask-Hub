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
 * Look something up once and keep it, but don't cache a failure — a lookup that
 * failed because listmonk was briefly down should be retried on the next call,
 * not remembered as broken until the next deploy.
 */
function once(fn) {
  let pending = null;
  return () => (pending ??= Promise.resolve().then(fn).catch((e) => { pending = null; throw e; }));
}

/** One memo per list name — several callers now feed lists through here. */
const listIdCache = new Map();

/**
 * Resolve a list to its id, creating it if it doesn't exist.
 *
 * Names rather than ids because an id is one more opaque thing to configure
 * correctly, and the name is what whoever sends the campaign will actually go
 * looking for. A numeric id is accepted and used as-is, so an audience can be
 * pinned to an existing list without depending on its name.
 */
export function listmonkListId(listNameOrId) {
  if (/^\d+$/.test(String(listNameOrId))) return Promise.resolve(Number(listNameOrId));
  if (!listIdCache.has(listNameOrId)) {
    listIdCache.set(listNameOrId, once(async () => {
      const lists = (await getLists())?.results || [];
      const found = lists.find((l) => l.name.trim().toLowerCase() === String(listNameOrId).toLowerCase());
      if (found) return found.id;
      return (await createList(listNameOrId)).id;
    }));
  }
  return listIdCache.get(listNameOrId)();
}

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
/** Single-quote a value for listmonk's SQL query expressions. */
const sqlLiteral = (v) => `'${String(v).replace(/'/g, "''")}'`;

export async function findSubscriber(email) {
  return findSubscriberBy(`subscribers.email = ${sqlLiteral(email)}`);
}

/**
 * Look a subscriber up by an arbitrary listmonk SQL expression.
 *
 * listmonk's subscriber search takes a fragment of SQL against the subscribers
 * table, which is how an attribute lookup is possible at all — and an attribute
 * lookup is what lets a changed email address be recognised as the same person
 * instead of becoming a second record.
 */
export async function findSubscriberBy(sqlExpr) {
  const d = await call('GET', `/api/subscribers?per_page=1&query=${encodeURIComponent(sqlExpr)}`);
  return d?.results?.[0] || null;
}

/** Find whoever carries this Commerce7 customer id, whatever address they now use. */
export const findSubscriberByAttrib = (key, value) =>
  findSubscriberBy(`subscribers.attribs->>${sqlLiteral(key)} = ${sqlLiteral(value)}`);

/**
 * Lift a blocklist and put the person on a list, for someone who has come back
 * and asked. PUT replaces the record, so the existing name and attribs are sent
 * back with it — attribs carry why they were suppressed, and losing that would
 * destroy the only evidence of what happened.
 */
export const updateSubscriber = (id, payload) =>
  call('PUT', `/api/subscribers/${id}`, payload);

/**
 * Put existing subscribers on a list, leaving everything else about them alone.
 *
 * Needed because POST /api/subscribers 409s for an address listmonk already
 * holds, and stopping there means someone who opts in at a new venue never
 * joins that venue's list. Most opt-ins are people we already have, so without
 * this the venue lists stay almost empty while every counter reports success.
 */
export const addToLists = (ids, listIds) =>
  call('PUT', '/api/subscribers/lists', {
    ids, action: 'add', target_list_ids: listIds, status: 'confirmed',
  });

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
