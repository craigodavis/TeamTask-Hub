/**
 * Keeps the Instagram access token alive.
 *
 * Instagram Login tokens last 60 days and then stop working. Nothing about that
 * failure is loud: the API starts returning 401, the sync stops writing rows, and
 * the feed on the website simply collapses to nothing — which looks identical to
 * "we haven't posted lately". The WordPress site never had this problem because
 * Smash Balloon refreshes its own copy on a schedule. Team has to do the same, or
 * the feed dies roughly two months after it's set up and stays dead.
 *
 * So the token lives in kindred_web.settings rather than in .env: a value that
 * has to rewrite itself can't live in a file the app only ever reads. .env seeds
 * it once, on first run, and is ignored from then on — otherwise a stale value
 * left behind in the file would overwrite the fresh one on every restart.
 *
 * Refreshing is just re-presenting the token before it lapses; each refresh buys
 * another 60 days, so an hourly sync keeps it alive indefinitely. Instagram
 * rejects a refresh for a token less than 24h old, hence the floor between
 * attempts.
 */
import { query } from '../db.js';

const KEY = 'ig_token';
const DAY = 24 * 60 * 60 * 1000;
// Refresh with plenty of runway. If something is wrong we get ~2 weeks of daily
// retries and loud logs before the token actually dies.
const REFRESH_WHEN_WITHIN = 14 * DAY;
const MIN_BETWEEN_ATTEMPTS = DAY;

const graphBase = () => process.env.IG_GRAPH_BASE || 'https://graph.instagram.com';

async function read() {
  try {
    const r = await query(`SELECT value FROM kindred_web.settings WHERE key = $1`, [KEY]);
    const v = r.rows[0]?.value;
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

async function write(state) {
  await query(
    `INSERT INTO kindred_web.settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [KEY, JSON.stringify(state)]
  );
}

/**
 * Ask Instagram for a fresh 60 days.
 * @returns {Promise<{token: string, expiresAt: number}|null>} null on any failure
 */
async function refresh(token) {
  // Only Instagram Login / Basic Display tokens refresh this way. A Business
  // account reached through a Facebook Page token doesn't use this endpoint at
  // all, so don't pretend it does.
  if (!graphBase().includes('graph.instagram.com')) return null;

  const url = `${graphBase()}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      console.error(`[instagram] token refresh REFUSED — ${msg}. The feed will stop when the current token expires.`);
      return null;
    }
    const expiresAt = Date.now() + (Number(body.expires_in) || 60 * 24 * 3600) * 1000;
    console.log(`[instagram] token refreshed, now valid until ${new Date(expiresAt).toISOString().slice(0, 10)}`);
    return { token: body.access_token, expiresAt };
  } catch (e) {
    console.error('[instagram] token refresh failed —', e.message);
    return null;
  }
}

/**
 * The token to use right now, refreshed if it's getting old.
 * @returns {Promise<string|null>}
 */
export async function currentToken() {
  let state = await read();

  // First run: adopt whatever .env was given, then never look at it again.
  if (!state?.token) {
    const seed = process.env.IG_ACCESS_TOKEN;
    if (!seed) return null;
    // Expiry unknown for a hand-pasted token — assume it's close, so the first
    // refresh happens promptly and tells us the real date.
    state = { token: seed, expiresAt: Date.now(), lastAttempt: 0, source: 'env seed' };
    await write(state);
    console.log('[instagram] seeded token from IG_ACCESS_TOKEN; it is now managed in the database');
  }

  const now = Date.now();
  const dueSoon = !state.expiresAt || state.expiresAt - now < REFRESH_WHEN_WITHIN;
  const waitedLongEnough = now - (state.lastAttempt || 0) > MIN_BETWEEN_ATTEMPTS;

  if (dueSoon && waitedLongEnough) {
    const next = await refresh(state.token);
    // Record the attempt either way, so a failing refresh retries daily rather
    // than on every hourly sync.
    state = next
      ? { token: next.token, expiresAt: next.expiresAt, lastAttempt: now, source: 'refreshed' }
      : { ...state, lastAttempt: now, lastError: new Date(now).toISOString() };
    await write(state);
  }

  if (state.expiresAt && state.expiresAt < now) {
    console.error('[instagram] token has EXPIRED — reconnect the account and reseed IG_ACCESS_TOKEN.');
  }
  return state.token || null;
}

/** For diagnostics: how long the feed has left. */
export async function tokenStatus() {
  const s = await read();
  if (!s?.token) return { present: false };
  return {
    present: true,
    expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
    daysLeft: s.expiresAt ? Math.round((s.expiresAt - Date.now()) / DAY) : null,
    source: s.source || null,
    lastError: s.lastError || null,
  };
}
