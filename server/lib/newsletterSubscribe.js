/**
 * Fan a website newsletter signup out to the mailing platforms.
 *
 * Kindred is mid-move from Campaign Monitor to Listmonk, so for now a signup has
 * to land in both — Campaign Monitor because that is where the audience still
 * lives, Listmonk because that is where Team's campaign composer sends from.
 * When Campaign Monitor is retired, unset its API key and this stops talking to
 * it; nothing else changes.
 *
 * Both sides land in a list named "Website Signups", which is looked up by name
 * and created if it doesn't exist. Names rather than IDs because a list id is
 * one more opaque thing to configure correctly, and because the name is what
 * whoever sends the campaign will actually go looking for.
 *
 * Rules this follows, in order of importance:
 *
 *  - The database row is written first, by the caller, and is the record of
 *    truth. Everything here is best-effort on top of it. A signup is never lost
 *    because a third party was slow or down.
 *  - Destinations are independent. Campaign Monitor failing must not stop
 *    Listmonk receiving the address, and vice versa.
 *  - An unconfigured destination is skipped silently rather than logging on every
 *    signup — during the migration exactly one of them may be set, and that is a
 *    normal state, not an error.
 *  - Failures are logged with the address, because the row is already saved and
 *    somebody can add it by hand.
 *
 * Env:
 *   CAMPAIGN_MONITOR_API_KEY   — required for the Campaign Monitor half
 *   CAMPAIGN_MONITOR_CLIENT_ID — only needed if the key sees more than one client
 *   LISTMONK_URL, LISTMONK_API_USER, LISTMONK_API_TOKEN
 */

import {
  listmonkConfigured, getLists, createList, addSubscriber, findSubscriber,
} from './listmonk.js';

const DEFAULT_LIST = 'Website Signups';

/**
 * Suppression beats a fresh signup, on both platforms.
 *
 * There is a real argument the other way: someone who deliberately types their
 * address into a form years after unsubscribing has arguably re-consented, and
 * that is why this once sent Campaign Monitor `Resubscribe: true`. But the two
 * halves then disagreed — Campaign Monitor resubscribed while listmonk left the
 * address blocklisted — so the same submission produced different outcomes on
 * each platform, and the one that survives the migration is listmonk's.
 *
 * Of the 2,212 suppressed addresses imported from Campaign Monitor, 61 are spam
 * complaints. Silently re-adding someone who reported us as spam because a form
 * was filled in is the single most expensive mistake available here. So a
 * suppressed address is reported back rather than resurrected, and restoring one
 * stays a deliberate act.
 */

/**
 * Look something up once and keep it, but don't cache a failure — a lookup that
 * failed because the platform was briefly down should be retried on the next
 * signup, not remembered as broken until the next deploy.
 */
function once(fn) {
  let pending = null;
  return () => (pending ??= Promise.resolve().then(fn).catch((e) => { pending = null; throw e; }));
}

/* ------------------------------------------------------------------ listmonk */

/** One memo per list name — several lists are now fed through here. */
const listmonkIdCache = new Map();
const listmonkListId = (listName) => {
  if (!listmonkIdCache.has(listName)) {
    listmonkIdCache.set(listName, once(async () => {
      const lists = (await getLists())?.results || [];
      const found = lists.find((l) => l.name.trim().toLowerCase() === listName.toLowerCase());
      if (found) return found.id;
      return (await createList(listName)).id;
    }));
  }
  return listmonkIdCache.get(listName)();
};

async function toListmonk(email, name, listName) {
  if (!listmonkConfigured()) return { skipped: true };
  try {
    await addSubscriber({
      email,
      name: name || email.split('@')[0],
      status: 'enabled',
      lists: [await listmonkListId(listName)],
      // They opted in on our form; a confirmation email would ask twice.
      preconfirm_subscriptions: true,
    });
    return { ok: true };
  } catch (e) {
    // listmonk 409s an address it already holds, which is either the desired end
    // state or a suppression. Ask which before calling it success.
    if (/\b409\b/.test(e.message)) {
      const existing = await findSubscriber(email).catch(() => null);
      if (existing?.status === 'blocklisted') return { suppressed: true };
      return { ok: true, already: true };
    }
    throw e;
  }
}

/* ---------------------------------------------------------- campaign monitor */

const CM = 'https://api.createsend.com/api/v3.3';

async function cm(path, body) {
  const key = process.env.CAMPAIGN_MONITOR_API_KEY;
  const res = await fetch(`${CM}${path}`, {
    method: body ? 'POST' : 'GET',
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

const cmClientId = once(async () => {
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

/** One memo per list name, same as listmonk. */
const cmIdCache = new Map();
const cmListId = (listName) => {
  if (!cmIdCache.has(listName)) {
    cmIdCache.set(listName, once(async () => {
      // The env override only ever named one list, so it applies to the default.
      if (listName === DEFAULT_LIST && process.env.CAMPAIGN_MONITOR_LIST_ID) {
        return process.env.CAMPAIGN_MONITOR_LIST_ID;
      }
      const clientId = await cmClientId();
      const lists = await cm(`/clients/${clientId}/lists.json`);
      const found = lists.find((l) => l.Name.trim().toLowerCase() === listName.toLowerCase());
      if (found) return found.ListID;
      return cm(`/lists/${clientId}.json`, {
        Title: listName,
        // Single opt-in: the form the guest filled in is the confirmation.
        ConfirmedOptIn: false,
        UnsubscribeSetting: 'AllClientLists',
      });
    }));
  }
  return cmIdCache.get(listName)();
};

async function toCampaignMonitor(email, name, listName) {
  if (!process.env.CAMPAIGN_MONITOR_API_KEY) return { skipped: true };
  try {
    await cm(`/subscribers/${encodeURIComponent(await cmListId(listName))}.json`, {
      EmailAddress: email,
      Name: name || '',
      // Required since v3.2. The form is an explicit opt-in — that's the consent.
      ConsentToTrack: 'Yes',
      // Deliberately false: see the note at the top of this file. Campaign
      // Monitor would otherwise reactivate an unsubscribed address, disagreeing
      // with listmonk about the same person on the same submission.
      Resubscribe: false,
    });
    return { ok: true };
  } catch (e) {
    // With Resubscribe off, Campaign Monitor rejects a previously unsubscribed
    // address rather than reviving it. That is the intended outcome, not a fault.
    if (/unsubscrib|suppress|inactive/i.test(e.message)) return { suppressed: true };
    throw e;
  }
}

/* ------------------------------------------------------------------ fan-out */

/**
 * Send an address to every configured platform. Never throws.
 *
 * @param {string} email
 * @param {string} [name]
 * @param {string} [listName] destination list on both platforms. Website
 *   signups keep the default; ResOS opt-ins pass "Resos Winery" or
 *   "Resos Creek" so the list records where consent was actually given.
 * @returns {Promise<{campaignMonitor: string, listmonk: string}>}
 */
export async function subscribeEverywhere(email, name, listName = DEFAULT_LIST) {
  const run = async (fn, label) => {
    try {
      const r = await fn(email, name, listName);
      if (r.skipped) return 'not configured';
      if (r.suppressed) {
        // Logged rather than silent: someone deliberately asked to join a list
        // they had previously left, and that deserves a human decision instead
        // of vanishing.
        console.warn(`[newsletter] ${label}: ${email} is suppressed — not added to "${listName}"`);
        return 'suppressed — not added';
      }
      return r.already ? 'already subscribed' : 'ok';
    } catch (e) {
      // The row is already saved, so this is recoverable by hand — say who.
      console.error(`[newsletter] ${label} failed for ${email}:`, e.message);
      return `failed: ${e.message.slice(0, 120)}`;
    }
  };
  const [campaignMonitor, listmonk] = await Promise.all([
    run(toCampaignMonitor, 'Campaign Monitor'),
    run(toListmonk, 'Listmonk'),
  ]);
  return { campaignMonitor, listmonk };
}
