/**
 * Kindred app push notifications — group management, sends, and the member-facing
 * preference surface the PWA talks to.
 *
 * Admin (TeamHub staff)                     Member (Kindred PWA)
 *   GET    /groups                            GET  /me/groups
 *   POST   /groups                            PUT  /me/prefs
 *   PATCH  /groups/:id                        POST /me/subscribe
 *   DELETE /groups/:id                        POST /me/unsubscribe
 *   GET    /groups/:id/audience
 *   GET    /sends
 *   POST   /sends
 *   PATCH  /sends/:id
 *   POST   /sends/:id/cancel
 *   POST   /sends/:id/test
 *
 * Member routes authenticate against club_steward.member_sessions — the same
 * opaque token ClubSteward issues after passkey login. TeamHub shares that
 * database, so there is one session store, not two.
 */

import express from 'express';
import { query } from '../db.js';
import { requireAuth, requireManager } from '../middleware/auth.js';
import {
  deliverSend, resolveAudience, ensureVapid, getVapid,
  RECOMMENDED_TITLE, RECOMMENDED_BODY,
} from '../lib/clubPush.js';

const router = express.Router();

// Staff-only routes guard themselves rather than the whole router, because the
// /me/* routes below authenticate as a club member instead of a TeamHub user.
const admin = [requireAuth, requireManager];

function cid(req) { return req.companyId || req.user?.company_id; }

/** Craig's cap: warn when going over four active lanes. Soft — more are allowed. */
const RECOMMENDED_MAX_GROUPS = 4;

async function activeGroupCount(companyId) {
  const r = await query(
    `SELECT count(*)::int n FROM club_notification_groups WHERE company_id = $1 AND active = true`,
    [companyId]);
  return r.rows[0].n;
}

async function groupWarning(companyId) {
  const n = await activeGroupCount(companyId);
  return n > RECOMMENDED_MAX_GROUPS
    ? `${n} active groups — we recommend no more than ${RECOMMENDED_MAX_GROUPS}. `
      + `Every extra lane is another choice on the member's screen, and the more lanes there are the more likely they turn all of them off.`
    : null;
}

/** Title/body are capped by the OS, not by us — warn rather than block. */
function lengthWarnings(title, body) {
  const w = [];
  if (title && title.length > RECOMMENDED_TITLE) {
    w.push(`Title is ${title.length} characters — phones truncate around ${RECOMMENDED_TITLE}.`);
  }
  if (body && body.length > RECOMMENDED_BODY) {
    w.push(`Body is ${body.length} characters — most phones collapse to about ${RECOMMENDED_BODY} until expanded.`);
  }
  return w;
}

// ═══ Admin: groups ═══════════════════════════════════════════════════════════

router.get('/groups', ...admin, async (req, res) => {
  try {
    const r = await query(
      `SELECT g.*,
              (SELECT count(*)::int FROM club_notification_prefs p
                WHERE p.group_id = g.id AND p.enabled = true) AS opted_in
         FROM club_notification_groups g
        WHERE g.company_id = $1
        ORDER BY g.sort_order, g.name`, [cid(req)]);
    res.json({ groups: r.rows, recommendedMax: RECOMMENDED_MAX_GROUPS, warning: await groupWarning(cid(req)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/groups', ...admin, async (req, res) => {
  const { key, name, description, icon, defaultEnabled, memberToggleable, sortOrder } = req.body;
  if (!key?.trim())  return res.status(400).json({ error: 'key is required' });
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!/^[a-z0-9_]+$/.test(key.trim())) {
    return res.status(400).json({ error: 'key must be lowercase letters, numbers and underscores — it is what senders reference' });
  }
  try {
    const r = await query(
      `INSERT INTO club_notification_groups
         (company_id, key, name, description, icon, default_enabled, member_toggleable, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cid(req), key.trim(), name.trim(), description || null, icon || null,
       defaultEnabled === true, memberToggleable !== false, Number(sortOrder) || 0]);
    res.status(201).json({ group: r.rows[0], warning: await groupWarning(cid(req)) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A group with key "${key}" already exists.` });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/groups/:id', ...admin, async (req, res) => {
  const { name, description, icon, defaultEnabled, memberToggleable, sortOrder, active } = req.body;
  const fields = [], vals = [];
  let i = 1;
  const set = (col, val) => { fields.push(`${col} = $${i++}`); vals.push(val); };

  if (name             !== undefined) set('name', name.trim());
  if (description      !== undefined) set('description', description || null);
  if (icon             !== undefined) set('icon', icon || null);
  if (defaultEnabled   !== undefined) set('default_enabled', !!defaultEnabled);
  if (memberToggleable !== undefined) set('member_toggleable', !!memberToggleable);
  if (sortOrder        !== undefined) set('sort_order', Number(sortOrder) || 0);
  if (active           !== undefined) set('active', !!active);
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  fields.push('updated_at = NOW()');

  try {
    // A system group may be reconfigured but never deactivated — the events
    // scheduler and the Commerce7 release webhook both post into one.
    const current = await query(
      `SELECT is_system FROM club_notification_groups WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]);
    if (!current.rows.length) return res.status(404).json({ error: 'Not found' });
    if (current.rows[0].is_system && active === false) {
      return res.status(409).json({ error: 'This group is part of the system and cannot be deactivated.' });
    }

    const r = await query(
      `UPDATE club_notification_groups SET ${fields.join(', ')}
        WHERE id = $${i++} AND company_id = $${i++} RETURNING *`,
      [...vals, req.params.id, cid(req)]);
    res.json({ group: r.rows[0], warning: await groupWarning(cid(req)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/groups/:id', ...admin, async (req, res) => {
  try {
    const g = await query(
      `SELECT is_system, name FROM club_notification_groups WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]);
    if (!g.rows.length) return res.status(404).json({ error: 'Not found' });
    if (g.rows[0].is_system) {
      return res.status(409).json({
        error: `"${g.rows[0].name}" is a built-in group and cannot be deleted. Deactivate it instead if you need it off the member screen.`,
      });
    }
    const used = await query(`SELECT count(*)::int n FROM club_notification_sends WHERE group_id = $1`, [req.params.id]);
    if (used.rows[0].n > 0) {
      return res.status(409).json({
        error: `This group has ${used.rows[0].n} notification(s) in its history. Deactivate it instead so the record survives.`,
      });
    }
    await query(`DELETE FROM club_notification_groups WHERE id = $1 AND company_id = $2`, [req.params.id, cid(req)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Recipient count preview — shown before scheduling so nobody sends blind. */
router.get('/groups/:id/audience', ...admin, async (req, res) => {
  try {
    const subs = await resolveAudience(cid(req), req.params.id);
    const accounts = new Set(subs.map((s) => s.id));
    res.json({ subscriptions: subs.length, devices: accounts.size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ Admin: sends ════════════════════════════════════════════════════════════

router.get('/sends', ...admin, async (req, res) => {
  try {
    const r = await query(
      `SELECT s.*, g.name AS group_name, g.key AS group_key, e.title AS event_title
         FROM club_notification_sends s
         JOIN club_notification_groups g ON g.id = s.group_id
         LEFT JOIN events e ON e.id = s.event_id
        WHERE s.company_id = $1
        ORDER BY COALESCE(s.sent_at, s.scheduled_for, s.created_at) DESC
        LIMIT 100`, [cid(req)]);
    res.json({ sends: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sends', ...admin, async (req, res) => {
  const { groupId, groupKey, eventId, title, body, url, scheduledFor, sendNow } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
  if (!body?.trim())  return res.status(400).json({ error: 'body is required' });
  if (title.length > 80)  return res.status(400).json({ error: 'title must be 80 characters or fewer' });
  if (body.length  > 200) return res.status(400).json({ error: 'body must be 200 characters or fewer' });

  try {
    const g = await query(
      `SELECT id, active FROM club_notification_groups
        WHERE company_id = $1 AND (id = $2::uuid OR key = $3)`,
      [cid(req), /^[0-9a-f-]{36}$/i.test(groupId || '') ? groupId : null, groupKey || null]);
    if (!g.rows.length)   return res.status(400).json({ error: 'Unknown notification group' });
    if (!g.rows[0].active) return res.status(400).json({ error: 'That group is inactive — nothing would be delivered' });
    const resolvedGroupId = g.rows[0].id;

    let when = scheduledFor ? new Date(scheduledFor) : null;
    let linkUrl = url || null;

    // Event sends: must land on or before the event, and the deep link builds
    // itself from the slug so nobody pastes the wrong URL.
    if (eventId) {
      const ev = await query(
        `SELECT e.title, e.slug, e.start_at, e.status, l.web_slug AS venue
           FROM events e
           LEFT JOIN locations l ON l.id = e.location_id
          WHERE e.id = $1 AND e.company_id = $2`,
        [eventId, cid(req)]);
      if (!ev.rows.length) return res.status(400).json({ error: 'Unknown event' });
      const event = ev.rows[0];
      if (String(event.status || '').toLowerCase() === 'cancelled') {
        return res.status(400).json({ error: 'That event is cancelled — refusing to schedule a notification for it.' });
      }
      if (when && event.start_at && when > new Date(event.start_at)) {
        return res.status(400).json({
          error: 'The notification must go out on the day of the event at the latest. Pick a time at or before the event starts.',
        });
      }
      // The PWA understands /reserve?event=…&venue=…&date=…&time=… and opens the
      // reservation screen with everything pre-filled — that is the whole point of
      // the tap-through. A bare /events/<slug> link matches its /events route and
      // dumps the member on the full list instead, losing the reservation context.
      //
      // Times are stored as wall-clock labeled UTC (same convention the PWA's
      // Events screen formats against), so read the parts in UTC, not local.
      if (!linkUrl && event.slug) {
        const p = new URLSearchParams({ event: event.slug });
        if (event.title) p.set('eventLabel', event.title);
        if (event.venue) p.set('venue', event.venue);
        if (event.start_at) {
          const d = new Date(event.start_at);
          p.set('date', d.toISOString().slice(0, 10));
          p.set('time', d.toISOString().slice(11, 16));
        }
        linkUrl = `https://friend.kindredvineyards.com/reserve?${p.toString()}`;
      }

      const dupe = await query(
        `SELECT count(*)::int n FROM club_notification_sends
          WHERE event_id = $1 AND status IN ('scheduled','sending','sent')`, [eventId]);
      if (dupe.rows[0].n > 0 && !req.body.allowAdditional) {
        return res.status(409).json({
          error: 'This event already has a notification scheduled or sent. Pass allowAdditional to send another (e.g. a day-of reminder after an earlier one).',
        });
      }
    }

    if (sendNow) when = new Date();
    if (!when) return res.status(400).json({ error: 'scheduledFor is required unless sendNow is set' });

    const r = await query(
      `INSERT INTO club_notification_sends
         (company_id, group_id, event_id, title, body, url, scheduled_for, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cid(req), resolvedGroupId, eventId || null, title.trim(), body.trim(), linkUrl, when, req.userId || null]);

    const out = { send: r.rows[0], warnings: lengthWarnings(title, body) };
    if (sendNow) out.result = await deliverSend(r.rows[0].id);
    res.status(201).json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/sends/:id', ...admin, async (req, res) => {
  const { title, body, url, scheduledFor } = req.body;
  const fields = [], vals = [];
  let i = 1;
  if (title        !== undefined) { fields.push(`title = $${i++}`);         vals.push(title.trim()); }
  if (body         !== undefined) { fields.push(`body = $${i++}`);          vals.push(body.trim()); }
  if (url          !== undefined) { fields.push(`url = $${i++}`);           vals.push(url || null); }
  if (scheduledFor !== undefined) { fields.push(`scheduled_for = $${i++}`); vals.push(new Date(scheduledFor)); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  fields.push('updated_at = NOW()');

  try {
    // Only an unsent notification can be edited — a sent one is a record.
    const r = await query(
      `UPDATE club_notification_sends SET ${fields.join(', ')}
        WHERE id = $${i++} AND company_id = $${i++} AND status = 'scheduled' RETURNING *`,
      [...vals, req.params.id, cid(req)]);
    if (!r.rows.length) return res.status(409).json({ error: 'Not found, or it has already been sent or cancelled.' });
    res.json({ send: r.rows[0], warnings: lengthWarnings(title, body) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sends/:id/cancel', ...admin, async (req, res) => {
  try {
    const r = await query(
      `UPDATE club_notification_sends
          SET status = 'cancelled', error = 'Cancelled before sending', updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND status = 'scheduled' RETURNING id`,
      [req.params.id, cid(req)]);
    if (!r.rows.length) return res.status(409).json({ error: 'Not found, or it has already gone out.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Test send — delivers only to one member account's own devices. */
router.post('/sends/:id/test', ...admin, async (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ error: 'accountId is required — a test goes to one member only' });
  try {
    const s = await query(
      `SELECT * FROM club_notification_sends WHERE id = $1 AND company_id = $2`, [req.params.id, cid(req)]);
    if (!s.rows.length) return res.status(404).json({ error: 'Not found' });
    const send = s.rows[0];

    const vapid = await getVapid(cid(req));
    if (!vapid) return res.status(400).json({ error: 'No VAPID keys configured yet' });

    const subs = await query(
      `SELECT id, endpoint, p256dh, auth FROM club_push_subscriptions
        WHERE account_id = $1 AND company_id = $2 AND disabled_at IS NULL`, [accountId, cid(req)]);
    if (!subs.rows.length) return res.status(404).json({ error: 'That member has no active push subscriptions' });

    const webpush = (await import('web-push')).default;
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    const payload = JSON.stringify({
      title: send.title, body: send.body, url: send.url || '/', tag: `test-${send.id}`,
      icon: '/icon-192.png', badge: '/icon-192.png',
    });
    let ok = 0;
    for (const sub of subs.rows) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        ok++;
      } catch { /* reported in the tally below */ }
    }
    res.json({ ok: true, devices: subs.rows.length, delivered: ok });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ Member (Kindred PWA) ════════════════════════════════════════════════════

/**
 * Validates the ClubSteward member session. Accepts the cross-subdomain cookie
 * or a Bearer token — the PWA holds the same opaque token either way, and the
 * header form avoids depending on cookie domain scoping.
 */
export async function requireMemberSession(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const token = bearer || req.cookies?.member_session;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    // DO NOT use member_accounts.company_id here. Kindred exists under two
    // different company ids in this database: teamtask_hub/commerce7/vintly use
    // 8d2df498..., while club_steward (and therefore member_accounts) uses
    // a444cbca.... Taking ClubSteward's id would file push subscriptions under a
    // company that resolveAudience never looks at — every send would report
    // success and reach nobody.
    //
    // The Commerce7 customer id is the shared key, so derive TeamHub's company
    // from it; fall back to the configured app company for a guest with no
    // Commerce7 record yet.
    const r = await query(
      `SELECT ms.account_id,
              COALESCE(c.company_id, (SELECT company_id FROM kindred_app_settings LIMIT 1)) AS company_id
         FROM club_steward.member_sessions ms
         JOIN club_steward.member_accounts ma ON ma.id = ms.account_id
         LEFT JOIN commerce7.customers c ON c.id::text = ma.commerce7_customer_id
        WHERE ms.token = $1 AND ms.expires_at > NOW()`, [token]);
    if (!r.rows.length) return res.status(401).json({ error: 'Session expired' });
    if (!r.rows[0].company_id) return res.status(500).json({ error: 'No company configured for the app' });
    req.memberAccountId = r.rows[0].account_id;
    req.companyId = r.rows[0].company_id;
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

/** The "What should we tell you about?" screen. */
router.get('/me/groups', requireMemberSession, async (req, res) => {
  try {
    const r = await query(
      `SELECT g.id, g.key, g.name, g.description, g.icon, g.member_toggleable,
              COALESCE(p.enabled, g.default_enabled) AS enabled
         FROM club_notification_groups g
         LEFT JOIN club_notification_prefs p ON p.group_id = g.id AND p.account_id = $2
        WHERE g.company_id = $1 AND g.active = true
        ORDER BY g.sort_order, g.name`,
      [req.companyId, req.memberAccountId]);
    // A non-toggleable lane always reads as on, whatever the pref row says.
    const groups = r.rows.map((g) => ({ ...g, enabled: g.member_toggleable ? g.enabled : true }));
    const vapid = await getVapid(req.companyId);
    res.json({ groups, vapidPublicKey: vapid?.publicKey || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/me/prefs', requireMemberSession, async (req, res) => {
  const prefs = req.body?.prefs;
  if (!Array.isArray(prefs)) return res.status(400).json({ error: 'prefs must be an array of { groupId, enabled }' });
  try {
    const rejected = [];
    for (const p of prefs) {
      const g = await query(
        `SELECT id, name, member_toggleable FROM club_notification_groups
          WHERE id = $1 AND company_id = $2 AND active = true`, [p.groupId, req.companyId]);
      if (!g.rows.length) continue;
      // Mandatory lanes are enforced here, not just disabled in the UI.
      if (!g.rows[0].member_toggleable && p.enabled === false) {
        rejected.push(g.rows[0].name);
        continue;
      }
      await query(
        `INSERT INTO club_notification_prefs (account_id, group_id, enabled)
         VALUES ($1,$2,$3)
         ON CONFLICT (account_id, group_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
        [req.memberAccountId, p.groupId, p.enabled === true]);
    }
    res.json({ ok: true, ...(rejected.length ? { rejected, note: 'These lanes cannot be turned off.' } : {}) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/me/subscribe', requireMemberSession, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'endpoint and keys.p256dh / keys.auth are required' });
  }
  try {
    // Re-subscribing the same device reuses its endpoint — reclaim it (and clear
    // any prior disable) rather than creating a duplicate row.
    const r = await query(
      `INSERT INTO club_push_subscriptions (company_id, account_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (endpoint) DO UPDATE SET
         account_id = EXCLUDED.account_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent, disabled_at = NULL, failure_count = 0
       RETURNING id`,
      [req.companyId, req.memberAccountId, endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] || null]);
    res.status(201).json({ ok: true, subscriptionId: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/me/unsubscribe', requireMemberSession, async (req, res) => {
  try {
    await query(
      `UPDATE club_push_subscriptions SET disabled_at = NOW()
        WHERE account_id = $1 AND ($2::text IS NULL OR endpoint = $2)`,
      [req.memberAccountId, req.body?.endpoint || null]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ Setup ═══════════════════════════════════════════════════════════════════
/** Generates the VAPID keypair on first use. Never replaces an existing one —
 *  rotating the key invalidates every subscription in the field. */
router.post('/setup/vapid', ...admin, async (req, res) => {
  try {
    const v = await ensureVapid(cid(req), req.body?.subject);
    res.json({ ok: true, publicKey: v.publicKey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export { router as clubNotificationsRouter };
