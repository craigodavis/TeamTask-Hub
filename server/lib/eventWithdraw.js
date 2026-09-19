/**
 * Withdraw an event from everywhere it was published, and verify it's gone.
 *
 * "Set it to draft" only drops it from the site feed — it leaves any Google
 * Business post, Eventbrite listing, or pending member push live, and gives no
 * confirmation the public page actually came down (the site is a static Cloudflare-
 * fronted build that only updates on a rebuild). This pulls the event from every
 * channel it reached, kicks the rebuild, and exposes a verify step that checks the
 * live URL so a person can be *sure*.
 */
import { query } from '../db.js';
import { deleteLocalPost } from './googleBusinessClient.js';
import { cancelEventbriteEvent } from './eventbriteClient.js';
import { notifyWebsiteContentChanged } from './websiteDeploy.js';
import { logEventActivity } from './eventActivity.js';

function siteBase() {
  return (process.env.PUBLIC_SITE_BASE || 'https://www.kindredvineyards.com').replace(/\/$/, '');
}

export async function withdrawEvent(companyId, eventId, userId = null) {
  const ev = (await query(`SELECT id, title, slug FROM events WHERE id = $1 AND company_id = $2`, [eventId, companyId])).rows[0];
  if (!ev) throw Object.assign(new Error('Event not found'), { statusCode: 404 });
  const report = {};

  // 1. Out of the site feed.
  await query(`UPDATE events SET status = 'draft', stage = 'draft', updated_at = NOW() WHERE id = $1 AND company_id = $2`, [eventId, companyId]);
  report.website = 'Unpublished — removed from the site feed';

  // 2. Delete live Google Business posts.
  const gposts = (await query(
    `SELECT local_post_name FROM gbp_event_posts WHERE company_id = $1 AND event_id = $2 AND state = 'live' AND local_post_name IS NOT NULL`,
    [companyId, eventId])).rows;
  let gdel = 0;
  for (const g of gposts) {
    try {
      await deleteLocalPost(companyId, g.local_post_name);
      await query(`UPDATE gbp_event_posts SET state = 'withdrawn', updated_at = NOW() WHERE local_post_name = $1`, [g.local_post_name]);
      gdel++;
    } catch (e) { report.google_error = e.message; }
  }
  report.google = gposts.length ? `${gdel} of ${gposts.length} Google post(s) deleted` : 'No Google post to remove';

  // 3. Cancel the Eventbrite event.
  const eb = (await query(`SELECT eventbrite_event_id FROM eventbrite_event_posts WHERE company_id = $1 AND event_id = $2 AND state = 'live'`, [companyId, eventId])).rows[0];
  if (eb?.eventbrite_event_id) {
    try {
      await cancelEventbriteEvent(companyId, eb.eventbrite_event_id);
      await query(`UPDATE eventbrite_event_posts SET state = 'cancelled', updated_at = NOW() WHERE company_id = $1 AND event_id = $2`, [companyId, eventId]);
      report.eventbrite = 'Eventbrite event cancelled';
    } catch (e) { report.eventbrite = `Eventbrite cancel failed: ${e.message}`; }
  } else report.eventbrite = 'Not on Eventbrite';

  // 4. Cancel any pending member push.
  const push = await query(`UPDATE club_notification_sends SET status = 'cancelled', error = 'Event withdrawn', updated_at = NOW() WHERE event_id = $1 AND status = 'scheduled'`, [eventId]);
  report.app_push = push.rowCount ? `${push.rowCount} scheduled push(es) cancelled` : 'No pending push';

  // 5. Stop scheduled channel posts from firing.
  const chan = await query(`UPDATE event_channel_posts SET status = 'skipped', updated_at = NOW() WHERE event_id = $1 AND status = 'scheduled'`, [eventId]);
  report.scheduled_channels = chan.rowCount ? `${chan.rowCount} scheduled channel post(s) cancelled` : 'None pending';

  // 6. Kick the site rebuild so the live page comes down.
  try { notifyWebsiteContentChanged('event withdrawn'); report.rebuild = 'Site rebuild requested'; }
  catch (e) { report.rebuild = `Rebuild trigger failed: ${e.message}`; }

  logEventActivity(companyId, userId, 'withdrawn', { eventId, eventTitle: ev.title, detail: `${report.google}; ${report.eventbrite}` });
  return { slug: ev.slug, report };
}

/**
 * Verify the withdrawal: fetch the live public page and report whether it's gone.
 * The static site rebuild + Cloudflare cache mean this can lag by minutes — the
 * caller polls until confirmed.
 */
export async function verifyWithdrawn(companyId, eventId) {
  const ev = (await query(`SELECT slug FROM events_all WHERE id = $1 AND company_id = $2`, [eventId, companyId])).rows[0];
  const slug = ev?.slug;
  const url = slug ? `${siteBase()}/events/${slug}/` : null;
  let liveStatus = null;
  if (url) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'Cache-Control': 'no-cache' } });
      liveStatus = r.status;
    } catch { liveStatus = null; }
  }
  // In the feed = still exposed to the site build. A withdrawn event is draft, so
  // this should be false immediately.
  const inFeed = !!(slug && (await query(`SELECT 1 FROM events WHERE company_id = $1 AND slug = $2 AND status = 'published'`, [companyId, slug])).rows[0]);
  return { url, live_status: liveStatus, in_feed: inFeed, confirmed: liveStatus === 404 && !inFeed };
}
