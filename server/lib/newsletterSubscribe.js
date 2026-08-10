/**
 * Fan a website newsletter signup out to the mailing platforms.
 *
 * Kindred is mid-move from Campaign Monitor to Listmonk, so for now a signup has
 * to land in both — Campaign Monitor because that is where the audience still
 * lives, Listmonk because that is where Team's campaign composer sends from.
 * When Campaign Monitor is retired, unset its two variables and this stops
 * talking to it; nothing else changes.
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
 *   CAMPAIGN_MONITOR_API_KEY, CAMPAIGN_MONITOR_LIST_ID
 *   LISTMONK_URL, LISTMONK_API_USER, LISTMONK_API_TOKEN, LISTMONK_LIST_ID
 */

const timeout = () => AbortSignal.timeout(10_000);

/** Campaign Monitor: POST /subscribers/{listId}.json, basic auth of apiKey:x. */
async function toCampaignMonitor(email, name) {
  const key = process.env.CAMPAIGN_MONITOR_API_KEY;
  const list = process.env.CAMPAIGN_MONITOR_LIST_ID;
  if (!key || !list) return { skipped: true };

  const res = await fetch(`https://api.createsend.com/api/v3.3/subscribers/${encodeURIComponent(list)}.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:x`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      EmailAddress: email,
      Name: name || '',
      // Required since v3.2. The signup form is an explicit opt-in, which is the
      // consent this records.
      ConsentToTrack: 'Yes',
      // Someone who previously unsubscribed and signs up again means it.
      Resubscribe: true,
    }),
    signal: timeout(),
  });
  if (!res.ok) throw new Error(`Campaign Monitor ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return { ok: true };
}

/** Listmonk: POST /api/subscribers, basic auth of user:token. */
async function toListmonk(email, name) {
  const base = (process.env.LISTMONK_URL || '').replace(/\/+$/, '');
  const user = process.env.LISTMONK_API_USER;
  const token = process.env.LISTMONK_API_TOKEN;
  const list = Number(process.env.LISTMONK_LIST_ID);
  if (!base || !user || !token || !Number.isFinite(list)) return { skipped: true };

  const res = await fetch(`${base}/api/subscribers`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      name: name || email.split('@')[0],
      status: 'enabled',
      lists: [list],
      // They ticked the box on our form; a second confirmation email would be
      // asking the same question twice.
      preconfirm_subscriptions: true,
    }),
    signal: timeout(),
  });
  // Already on the list is success, not failure.
  if (res.status === 409) return { ok: true, already: true };
  if (!res.ok) throw new Error(`Listmonk ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return { ok: true };
}

/**
 * Send an address to every configured platform. Never throws.
 * @returns {Promise<{campaignMonitor: string, listmonk: string}>}
 */
export async function subscribeEverywhere(email, name) {
  const run = async (fn, label) => {
    try {
      const r = await fn(email, name);
      return r.skipped ? 'not configured' : (r.already ? 'already subscribed' : 'ok');
    } catch (e) {
      // The row is already saved, so this is recoverable by hand — say who.
      console.error(`[newsletter] ${label} failed for ${email}:`, e.message);
      return `failed: ${e.message.slice(0, 80)}`;
    }
  };
  const [campaignMonitor, listmonk] = await Promise.all([
    run(toCampaignMonitor, 'Campaign Monitor'),
    run(toListmonk, 'Listmonk'),
  ]);
  return { campaignMonitor, listmonk };
}
