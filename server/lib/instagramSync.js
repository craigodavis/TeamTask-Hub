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
 * Env: IG_ACCESS_TOKEN (required), IG_USER_ID (default "me"), IG_GRAPH_BASE.
 */
import { query } from '../db.js';
import { notifyWebsiteContentChanged } from './websiteDeploy.js';

const IG_BASE = process.env.IG_GRAPH_BASE || 'https://graph.instagram.com';
const IG_USER = process.env.IG_USER_ID || 'me';
const FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';

export async function syncInstagram() {
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) return { ok: false, reason: 'IG_ACCESS_TOKEN not set' };

  const url = `${IG_BASE}/${IG_USER}/media?fields=${FIELDS}&limit=24&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Instagram API HTTP ${res.status}: ${body.slice(0, 180)}`);
  }
  const { data } = await res.json();
  let count = 0;
  for (const m of data || []) {
    await query(
      `INSERT INTO kindred_web.instagram_media
         (id, media_type, media_url, thumbnail_url, permalink, caption, posted_at, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (id) DO UPDATE SET
         media_type=$2, media_url=$3, thumbnail_url=$4, permalink=$5, caption=$6, posted_at=$7, fetched_at=NOW()`,
      [m.id, m.media_type, m.media_url, m.thumbnail_url || null, m.permalink, m.caption || null, m.timestamp]
    );
    count++;
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
  if (!process.env.IG_ACCESS_TOKEN) {
    console.log('Instagram scheduler idle (IG_ACCESS_TOKEN not set).');
    return;
  }
  const run = () =>
    syncInstagram()
      .then((r) => r.ok && console.log(`Instagram synced: ${r.count} posts.`))
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
