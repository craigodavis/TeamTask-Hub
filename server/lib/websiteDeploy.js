/**
 * Tells the public website to rebuild itself when content changes in Team.
 *
 * The site (kindredvineyards.com / preview.…) is a static Astro build: every page
 * is generated from this app's `/api/website/*` endpoints at BUILD time and then
 * served as a plain file. So a build is a snapshot. Publish an event here and it
 * stays invisible on the website until something rebuilds it — which is exactly
 * what happened to Wine Bingo on 3 Aug 2026.
 *
 * This module closes that gap: any write to content the site reads pings GitHub,
 * which rebuilds and rsyncs. Two deliberate properties:
 *
 *  - **Debounced.** Editing an event is half a dozen PATCHes in a row (title, then
 *    time, then photo). Each one firing a build would queue six deploys to publish
 *    one change. We wait for the edits to stop, then fire once — with a hard cap so
 *    a long editing session still publishes rather than being pushed back forever.
 *
 *  - **Fire-and-forget.** A failure to reach GitHub must never fail the save. The
 *    editor's change is in the database either way; the worst case is the site
 *    lags until the hourly safety-net build in deploy.yml picks it up.
 *
 * Requires GITHUB_DEPLOY_TOKEN in server/.env — a fine-grained PAT scoped to the
 * website repo alone, with Contents: read and write (what repository_dispatch
 * needs) and Metadata: read. Without it this is a no-op and says so once.
 */

const GH_REPO = process.env.WEBSITE_REPO || 'craigodavis/kindred-website';
const EVENT_TYPE = 'content-changed';

// Wait this long after the last change before building…
const QUIET_MS = 15_000;
// …but never hold a change longer than this, however busy the editing gets.
const MAX_WAIT_MS = 90_000;

let timer = null;
let firstQueuedAt = 0;
let reasons = new Set();
let warnedNoToken = false;

/**
 * The one place that talks to GitHub. Never throws — returns what happened so
 * callers can either ignore it (the debounced path) or report it (the manual
 * "publish now" button).
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function publishWebsiteNow(why = []) {
  const token = process.env.GITHUB_DEPLOY_TOKEN;
  if (!token) return { ok: false, error: 'GITHUB_DEPLOY_TOKEN is not set' };

  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'kindred-team',
      },
      // client_payload only shows up in the run log — the workflow reads nothing from it.
      body: JSON.stringify({ event_type: EVENT_TYPE, client_payload: { reasons: why } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 204) return { ok: true };
    const body = await res.text().catch(() => '');
    return { ok: false, error: `GitHub returned ${res.status}. ${body.slice(0, 180)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function fire() {
  timer = null;
  firstQueuedAt = 0;
  const why = [...reasons];
  reasons = new Set();

  if (!process.env.GITHUB_DEPLOY_TOKEN) {
    // Once per process, not once per save — this is the normal state in dev.
    if (!warnedNoToken) {
      warnedNoToken = true;
      console.warn('[websiteDeploy] GITHUB_DEPLOY_TOKEN not set — website will not rebuild on content changes');
    }
    return;
  }

  const r = await publishWebsiteNow(why);
  if (r.ok) console.log(`[websiteDeploy] rebuild requested (${why.join(', ') || 'content change'})`);
  else console.warn('[websiteDeploy] dispatch failed —', r.error);
}

/**
 * Queue a website rebuild. Safe to call on every content write; calls collapse.
 * @param {string} reason short label for the run log, e.g. "PATCH /api/events/:id"
 */
export function notifyWebsiteContentChanged(reason = 'content change') {
  reasons.add(reason);
  const now = Date.now();
  if (!firstQueuedAt) firstQueuedAt = now;

  if (timer) clearTimeout(timer);
  // Never push the fire time past MAX_WAIT_MS from the first change in this burst.
  const delay = Math.max(0, Math.min(QUIET_MS, firstQueuedAt + MAX_WAIT_MS - now));
  timer = setTimeout(fire, delay);
  timer.unref?.();
}

/**
 * Express middleware. Mount on the routers that own website content; it watches
 * for a mutating request that finishes successfully and queues a rebuild.
 *
 * Deliberately at the mount point rather than inside each handler: routes get
 * added and renamed, and a hook that has to be remembered per-handler is a hook
 * that will be missed. The cost of being broad is an occasional rebuild for a
 * change the site didn't care about, which is a wasted CI minute and nothing else.
 */
export function websiteContentWatch(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    notifyWebsiteContentChanged(`${req.method} ${req.baseUrl}${req.path}`);
  });
  next();
}
