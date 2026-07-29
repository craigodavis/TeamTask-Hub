/**
 * Club 77 Web Push sender.
 *
 * Web Push has no server-side topic fan-out (unlike FCM topics) — every push is
 * addressed to one browser endpoint. A "group send" is therefore N individual
 * requests to Apple's and Google's push services, which is why this module does
 * bounded concurrency and prunes dead endpoints. Without the pruning the
 * subscription table rots and every send gets slower and noisier.
 *
 * Message length: the OS decides, not us. Titles truncate around 40 chars, bodies
 * collapse to roughly one line until expanded. RECOMMENDED_* below are what the
 * admin UI counts against; nothing is truncated here.
 */

import webpush from 'web-push';
import { query } from '../db.js';

export const RECOMMENDED_TITLE = 40;
export const RECOMMENDED_BODY  = 120;

/** How many pushes in flight at once. Push services are fine with this; it keeps
 *  a 2,000-member send from opening 2,000 sockets. */
const CONCURRENCY = 20;

/** Endpoint is permanently gone — the member uninstalled or cleared site data. */
const GONE = new Set([404, 410]);

// ── VAPID ────────────────────────────────────────────────────────────────────
export async function getVapid(companyId) {
  const r = await query(
    `SELECT vapid_public_key, vapid_private_key, vapid_subject
       FROM company_integrations WHERE company_id = $1`, [companyId]);
  const row = r.rows[0];
  if (row?.vapid_public_key && row?.vapid_private_key) {
    return {
      publicKey:  row.vapid_public_key,
      privateKey: row.vapid_private_key,
      subject:    row.vapid_subject || 'mailto:craig@kindredvineyards.com',
    };
  }
  return null;
}

/** Generate and persist a keypair. Rotating it invalidates every existing
 *  subscription, so this only ever fills in a missing key — never replaces one. */
export async function ensureVapid(companyId, subject = 'mailto:craig@kindredvineyards.com') {
  const existing = await getVapid(companyId);
  if (existing) return existing;

  const keys = webpush.generateVAPIDKeys();
  await query(
    `INSERT INTO company_integrations (company_id, vapid_public_key, vapid_private_key, vapid_subject)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (company_id) DO UPDATE SET
       vapid_public_key  = COALESCE(company_integrations.vapid_public_key,  EXCLUDED.vapid_public_key),
       vapid_private_key = COALESCE(company_integrations.vapid_private_key, EXCLUDED.vapid_private_key),
       vapid_subject     = COALESCE(company_integrations.vapid_subject,     EXCLUDED.vapid_subject),
       updated_at = NOW()`,
    [companyId, keys.publicKey, keys.privateKey, subject]
  );
  return { ...keys, subject };
}

// ── Audience ─────────────────────────────────────────────────────────────────
/**
 * Live subscriptions that should receive a send for this group.
 *
 * A member with no pref row falls back to the group's default_enabled — that is
 * what makes "default on/off for a group added later" work without backfilling a
 * row for every existing member.
 *
 * A group with member_toggleable = false reaches everyone regardless of prefs.
 * Note that is "no per-lane opt-out", NOT guaranteed delivery: a member who never
 * installed the PWA or denied OS notification permission has no subscription row
 * and is unreachable by any lane.
 */
export async function resolveAudience(companyId, groupId) {
  const r = await query(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth
       FROM club_push_subscriptions s
       JOIN club_notification_groups g ON g.id = $2
       LEFT JOIN club_notification_prefs p
              ON p.account_id = s.account_id AND p.group_id = g.id
      WHERE s.company_id = $1
        AND s.disabled_at IS NULL
        AND g.active = true
        AND (
          g.member_toggleable = false
          OR COALESCE(p.enabled, g.default_enabled) = true
        )`,
    [companyId, groupId]
  );
  return r.rows;
}

// ── Send ─────────────────────────────────────────────────────────────────────
async function pushOne(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload
    );
    await query(
      `UPDATE club_push_subscriptions SET last_success_at = NOW(), failure_count = 0 WHERE id = $1`,
      [sub.id]);
    return 'delivered';
  } catch (err) {
    const code = err?.statusCode;
    if (GONE.has(code)) {
      await query(`UPDATE club_push_subscriptions SET disabled_at = NOW() WHERE id = $1`, [sub.id]);
      return 'pruned';
    }
    // Transient (429/5xx) or malformed. Count it; a subscription that keeps
    // failing gets retired so it stops costing time on every future send.
    await query(
      `UPDATE club_push_subscriptions
          SET failure_count = failure_count + 1,
              disabled_at = CASE WHEN failure_count + 1 >= 10 THEN NOW() ELSE disabled_at END
        WHERE id = $1`, [sub.id]);
    return 'failed';
  }
}

/** Run tasks with a bounded pool, preserving nothing — we only need the tally. */
async function pool(items, limit, fn) {
  const tally = { delivered: 0, failed: 0, pruned: 0 };
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      tally[await fn(item)]++;
    }
  });
  await Promise.all(workers);
  return tally;
}

/**
 * Deliver one club_notification_sends row.
 * Claims the row first so two schedulers can't send it twice.
 */
export async function deliverSend(sendId) {
  const claim = await query(
    `UPDATE club_notification_sends
        SET status = 'sending', updated_at = NOW()
      WHERE id = $1 AND status = 'scheduled'
      RETURNING *`, [sendId]);
  if (!claim.rows.length) return { skipped: 'not claimable — already sent, sending or cancelled' };
  const send = claim.rows[0];

  try {
    const vapid = await getVapid(send.company_id);
    if (!vapid) throw new Error('No VAPID keys configured for this company');
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

    const subs = await resolveAudience(send.company_id, send.group_id);
    const payload = JSON.stringify({
      title: send.title,
      body:  send.body,
      url:   send.url || '/',
      tag:   send.event_id ? `event-${send.event_id}` : `send-${send.id}`,
      icon:  '/icon-192.png',
      badge: '/icon-192.png',
    });

    const tally = await pool(subs, CONCURRENCY, (s) => pushOne(s, payload));

    await query(
      `UPDATE club_notification_sends
          SET status = 'sent', sent_at = NOW(), recipients = $2,
              delivered = $3, failed = $4, pruned = $5, updated_at = NOW()
        WHERE id = $1`,
      [send.id, subs.length, tally.delivered, tally.failed, tally.pruned]);

    return { sendId: send.id, recipients: subs.length, ...tally };
  } catch (err) {
    // Put it back to 'failed' rather than leaving it stuck in 'sending'.
    await query(
      `UPDATE club_notification_sends SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
      [send.id, err.message]);
    throw err;
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────
/**
 * Fire everything due. Event-linked sends are dropped rather than delivered if
 * the event was cancelled or moved past the send time — a push for a cancelled
 * event is worse than no push at all.
 */
export async function runDueSends() {
  const due = await query(
    `SELECT s.id, s.event_id, e.status AS event_status, e.start_at
       FROM club_notification_sends s
       LEFT JOIN events e ON e.id = s.event_id
      WHERE s.status = 'scheduled' AND s.scheduled_for <= NOW()
      ORDER BY s.scheduled_for
      LIMIT 50`);

  const results = [];
  for (const row of due.rows) {
    if (row.event_id) {
      const cancelled = row.event_status && String(row.event_status).toLowerCase() === 'cancelled';
      const alreadyOver = row.start_at && new Date(row.start_at) < new Date();
      if (cancelled || alreadyOver) {
        await query(
          `UPDATE club_notification_sends
              SET status = 'cancelled', error = $2, updated_at = NOW() WHERE id = $1`,
          [row.id, cancelled ? 'Event was cancelled' : 'Event already started']);
        results.push({ sendId: row.id, cancelled: cancelled ? 'event cancelled' : 'event already started' });
        continue;
      }
    }
    try { results.push(await deliverSend(row.id)); }
    catch (e) { results.push({ sendId: row.id, error: e.message }); }
  }
  return results;
}

let started = false;
export function startClubPushScheduler() {
  if (started) return;
  started = true;
  const run = () => runDueSends().catch((e) => console.error('[clubPush] scheduler:', e.message));
  setTimeout(run, 60 * 1000);
  setInterval(run, 5 * 60 * 1000);
  console.log('Club push scheduler started (every 5 min).');
}
