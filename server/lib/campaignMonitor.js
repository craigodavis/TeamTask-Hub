/**
 * Campaign Monitor API client.
 *
 * The mirror of listmonk.js: one thin module per mailing platform, so when a
 * write goes wrong there is one place it can have gone wrong. This was lifted
 * out of newsletterSubscribe.js unchanged when a second caller appeared (the
 * ClubSteward subscriber gateway) — two fan-outs sharing one client beats two
 * copies of the same auth and list-lookup code drifting apart.
 *
 * Campaign Monitor is the platform Kindred is migrating *away* from. It is kept
 * fed during the migration because that is where the audience still lives.
 * To retire it, blank CAMPAIGN_MONITOR_API_KEY — every caller treats an
 * unconfigured platform as skipped, which is a normal state here, not an error.
 *
 * Env:
 *   CAMPAIGN_MONITOR_API_KEY   — required; without it this module is inert
 *   CAMPAIGN_MONITOR_CLIENT_ID — only needed if the key sees more than one client
 */

const BASE = 'https://api.createsend.com/api/v3.3';

/** Campaign Monitor ids are 32 hex characters; list *names* never look like that. */
const LIST_ID_RE = /^[0-9a-f]{32}$/i;

export const cmConfigured = () => Boolean(process.env.CAMPAIGN_MONITOR_API_KEY);

export async function cm(path, body, method) {
  const key = process.env.CAMPAIGN_MONITOR_API_KEY;
  const res = await fetch(`${BASE}${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:x`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Campaign Monitor ${path} -> ${res.status}: ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Look something up once and keep it, but don't cache a failure — a lookup that
 * failed because the platform was briefly down should be retried on the next
 * call, not remembered as broken until the next deploy.
 */
function once(fn) {
  let pending = null;
  return () => (pending ??= Promise.resolve().then(fn).catch((e) => { pending = null; throw e; }));
}

export const cmClientId = once(async () => {
  const clients = await cm('/clients.json');
  const clientId = process.env.CAMPAIGN_MONITOR_CLIENT_ID || (clients.length === 1 && clients[0].ClientID);
  if (!clientId) {
    // Guessing which winery account to write to is not a call this should make.
    throw new Error(
      `key sees ${clients.length} clients — set CAMPAIGN_MONITOR_CLIENT_ID to one of: ` +
      clients.map((c) => `${c.Name}=${c.ClientID}`).join(', '),
    );
  }

  return clientId;
});

/** One memo per list name. */
const cmIdCache = new Map();

/**
 * Resolve a list to its Campaign Monitor id, creating the list if it is named
 * and missing.
 *
 * @param {string} listNameOrId a list name, or a 32-hex list id to use as-is.
 *   Names rather than ids by default because an id is one more opaque thing to
 *   configure correctly, and the name is what whoever sends the campaign will
 *   go looking for. An id is accepted so an audience can be pinned to an
 *   existing list without renaming anything.
 */
export function cmListId(listNameOrId) {
  if (LIST_ID_RE.test(listNameOrId)) return Promise.resolve(listNameOrId);
  if (!cmIdCache.has(listNameOrId)) {
    cmIdCache.set(listNameOrId, once(async () => {
      const clientId = await cmClientId();
      const lists = await cm(`/clients/${clientId}/lists.json`);
      const found = lists.find((l) => l.Name.trim().toLowerCase() === listNameOrId.toLowerCase());
      if (found) return found.ListID;
      return cm(`/lists/${clientId}.json`, {
        Title: listNameOrId,
        // Single opt-in: the form the guest filled in is the confirmation.
        ConfirmedOptIn: false,
        UnsubscribeSetting: 'AllClientLists',
      });
    }));
  }
  return cmIdCache.get(listNameOrId)();
}

/**
 * Add or update one subscriber on a list.
 *
 * Campaign Monitor's add endpoint is itself an upsert — an address already on
 * the list has its name updated rather than being duplicated — so this is the
 * whole of the write path for both new and changed people.
 *
 * @param {boolean} resubscribe whether this lifts a previous unsubscribe. Only
 *   ever true when a person acted just now. A sync iterating over records is
 *   not consent, and passing true for one is what let booking a table undo an
 *   opt-out; see the note in newsletterSubscribe.js.
 */
export const addCmSubscriber = ({ listId, email, name, resubscribe = false }) =>
  cm(`/subscribers/${encodeURIComponent(listId)}.json`, {
    EmailAddress: email,
    Name: name || '',
    // Required since v3.2. The opt-in that put them here is the consent.
    ConsentToTrack: 'Yes',
    Resubscribe: Boolean(resubscribe),
  });

/**
 * Change an existing subscriber's address, keeping their history and their
 * place on the list. Campaign Monitor keys subscribers by address, so the old
 * one has to be named — without it a changed address can only be added, leaving
 * the previous one on the list.
 */
export const updateCmSubscriber = ({ listId, oldEmail, email, name, resubscribe = false }) =>
  cm(
    `/subscribers/${encodeURIComponent(listId)}.json?email=${encodeURIComponent(oldEmail)}`,
    {
      EmailAddress: email,
      Name: name || '',
      ConsentToTrack: 'Yes',
      Resubscribe: Boolean(resubscribe),
    },
    'PUT',
  );

/** True when Campaign Monitor is refusing the write because the person opted out. */
export const isCmSuppression = (err) => /unsubscrib|suppress|inactive|deleted/i.test(err?.message || '');
