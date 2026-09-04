/**
 * Instagram feed sync. Fetches recent media from the Instagram Graph API and
 * caches it in kindred_web.instagram_media, so the website reads a fast, cached
 * copy and the access token never leaves the server.
 *
 * Instagram Basic Display was shut down (Dec 2024). This uses the Graph API:
 *   GET {IG_GRAPH_BASE}/{IG_USER_ID}/media?fields=...&access_token=...
 * Defaults suit an Instagram Login / creator token (graph.instagram.com + me);
 * for a Business account via a Page token, set IG_GRAPH_BASE=https://graph.facebook.com/v21.0
 * and IG_USER_ID to the IG user id.
 *
 * The token is NOT read from the environment at run time — see lib/instagramToken.js.
 * It's held in kindred_web.settings and refreshed before it lapses, because an
 * Instagram Login token dies after 60 days and takes the feed with it, silently.
 * IG_ACCESS_TOKEN seeds that store once and is ignored afterwards.
 *
 * Env: IG_ACCESS_TOKEN (first run only), IG_USER_ID (default "me"), IG_GRAPH_BASE.
 */
import { query } from '../db.js';
import { notifyWebsiteContentChanged } from './websiteDeploy.js';
import { currentToken } from './instagramToken.js';

const IG_BASE = process.env.IG_GRAPH_BASE || 'https://graph.instagram.com';
const IG_USER = process.env.IG_USER_ID || 'me';
const FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';

export async function syncInstagram() {
  const token = await currentToken();
  if (!token) return { ok: false, reason: 'no Instagram token (set IG_ACCESS_TOKEN once to seed it)' };

  const url = `${IG_BASE}/${IG_USER}/media?fields=${FIELDS}&limit=24&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Instagram API HTTP ${res.status}: ${body.slice(0, 180)}`);
  }
  const { data } = await res.json();
  // `count` must mean "something actually changed", not "rows processed".
  //
  // It used to increment once per post fetched, so with 24 posts coming back
  // every hour it was never zero, and the website was told its content had
  // changed on the hour, every hour, forever. Each of those fired two GitHub
  // Actions runs — ~48 a day — whether Instagram had posted anything or not.
  // That, not the scheduled builds, is what exhausted the monthly allowance.
  //
  // So the upsert only writes when a field a visitor would notice differs, and
  // the count comes from what Postgres actually wrote. An unchanged post updates
  // nothing and returns no row. fetched_at stops refreshing for untouched posts
  // as a result, which is fine — it is bookkeeping, not content.
  let count = 0;
  for (const m of data || []) {
    const r = await query(
      `INSERT INTO kindred_web.instagram_media
         (id, media_type, media_url, thumbnail_url, permalink, caption, posted_at, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (id) DO UPDATE SET
         media_type=$2, media_url=$3, thumbnail_url=$4, permalink=$5, caption=$6, posted_at=$7, fetched_at=NOW()
       WHERE kindred_web.instagram_media.media_type    IS DISTINCT FROM EXCLUDED.media_type
          OR kindred_web.instagram_media.media_url     IS DISTINCT FROM EXCLUDED.media_url
          OR kindred_web.instagram_media.thumbnail_url IS DISTINCT FROM EXCLUDED.thumbnail_url
          OR kindred_web.instagram_media.permalink     IS DISTINCT FROM EXCLUDED.permalink
          OR kindred_web.instagram_media.caption       IS DISTINCT FROM EXCLUDED.caption
          OR kindred_web.instagram_media.posted_at     IS DISTINCT FROM EXCLUDED.posted_at
       RETURNING id`,
      [m.id, m.media_type, m.media_url, m.thumbnail_url || null, m.permalink, m.caption || null, m.timestamp]
    );
    count += r.rowCount;
  }
  // Keep only the latest ~48.
  await query(
    `DELETE FROM kindred_web.instagram_media
      WHERE id NOT IN (SELECT id FROM kindred_web.instagram_media ORDER BY posted_at DESC LIMIT 48)`
  );
  // Runs on a timer with no HTTP request behind it, so the route-level watch in
  // index.js can't see it — tell the website directly.
  if (count) notifyWebsiteContentChanged('instagram sync');
  return { ok: true, count };
}

let started = false;
export function startInstagramScheduler() {
  if (started) return;
  started = true;
  // No env check here: once seeded, the token lives in the database, so an empty
  // IG_ACCESS_TOKEN is the normal steady state rather than a reason not to run.
  const run = () =>
    syncInstagram()
      .then((r) => (r.ok ? console.log(`Instagram synced: ${r.count} posts.`) : console.log(`Instagram sync skipped: ${r.reason}`)))
      .catch((e) => console.error('Instagram sync failed:', e.message));
  setTimeout(run, 20 * 1000); // shortly after boot
  setInterval(run, 60 * 60 * 1000); // hourly
  console.log('Instagram scheduler started (hourly).');
}

// CLI: node lib/instagramSync.js
if (process.argv[1]?.endsWith('instagramSync.js')) {
  syncInstagram()
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
