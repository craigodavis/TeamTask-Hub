/**
 * Kindred app — admin surface for the Members report and app settings.
 * Notification groups and sends live in routes/clubNotifications.js.
 *
 *   GET  /api/kindred-app/members            the report (funnel + rows)
 *   GET  /api/kindred-app/members/:id/activity
 *   GET  /api/kindred-app/settings
 *   PUT  /api/kindred-app/settings
 *   POST /api/kindred-app/activity           recorded BY the app, not staff
 */

import express from 'express';
import { query } from '../db.js';
import { requireAuth, requireManager } from '../middleware/auth.js';

const router = express.Router();
const admin = [requireAuth, requireManager];
function cid(req) { return req.companyId || req.user?.company_id; }

/**
 * The population is Commerce7 CUSTOMERS, left-joined to app accounts — not app
 * users. A report built the other way round only shows the people we already
 * reached, which is the small half and the half that needs nothing from us.
 * Built this way the default view answers "who haven't we reached yet", which is
 * an email list, a tasting-room script, a card in the next shipment.
 */
const BASE_CTE = `
  WITH acct AS (
    SELECT ma.id, ma.commerce7_customer_id, ma.email, ma.created_at, ma.last_seen_at
      FROM club_steward.member_accounts ma
     WHERE ma.company_id = $1
  ),
  membership AS (
    -- customer_id is varchar here but uuid on commerce7.customers; the join casts.
    -- ever_joined / last_cancel carry the LAPSED signal: 370 customers held a
    -- membership and hold none now, which is the warmest audience that isn't
    -- currently paying. Aggregated per customer so someone who joined, left and
    -- rejoined reads as active rather than lapsed.
    SELECT cm.customer_id,
           (array_agg(cm.status ORDER BY (cm.status = 'Active') DESC, cm.signup_date DESC))[1] AS status,
           (array_agg(cm.club_id ORDER BY (cm.status = 'Active') DESC, cm.signup_date DESC))[1] AS club_id,
           min(cm.signup_date)                                          AS signup_date,
           bool_or(cm.status = 'Active')                                AS still_in,
           max(cm.cancel_date) FILTER (WHERE cm.status <> 'Active')     AS last_cancel
      FROM commerce7.club_membership cm
     WHERE cm.company_id = $1
     GROUP BY cm.customer_id
  ),
  act AS (
    SELECT a.account_id,
           MAX(a.occurred_at)                                                   AS last_seen,
           COUNT(*) FILTER (WHERE a.event_type = 'standalone_open')  > 0        AS installed,
           COUNT(*) FILTER (WHERE a.event_type = 'notification_click')::int     AS taps,
           COUNT(*) FILTER (WHERE a.event_type = 'reservation_completed')::int  AS reservations
      FROM app_activity a
     WHERE a.company_id = $1
     GROUP BY a.account_id
  ),
  subs AS (
    SELECT account_id, count(*)::int devices
      FROM club_push_subscriptions
     WHERE company_id = $1 AND disabled_at IS NULL
     GROUP BY account_id
  ),
  base AS (
    SELECT c.id, c.first_name, c.last_name, c.emails, c.last_activity_date,
           a.id            AS account_id,
           a.created_at    AS joined_app_at,
           m.status        AS club_status,
           m.signup_date   AS club_signup_date,
           COALESCE(m.still_in, false)                       AS club_active,
           (m.customer_id IS NOT NULL AND m.still_in = false) AS club_lapsed,
           m.last_cancel   AS club_left_at,
           COALESCE(act.installed, false)   AS installed,
           act.last_seen,
           COALESCE(act.taps, 0)            AS taps,
           COALESCE(act.reservations, 0)    AS reservations,
           COALESCE(subs.devices, 0)        AS devices
      FROM commerce7.customers c
      LEFT JOIN acct       a    ON a.commerce7_customer_id = c.id::text
      LEFT JOIN membership m    ON m.customer_id = c.id::text
      LEFT JOIN act             ON act.account_id = a.id
      LEFT JOIN subs            ON subs.account_id = a.id
     WHERE c.company_id = $1
  )`;

// ── GET /members ─────────────────────────────────────────────────────────────
router.get('/members', ...admin, async (req, res) => {
  const { filter = 'all', search = '', limit = 100, offset = 0 } = req.query;

  // Every filter is a predicate over the same base — no separate queries to drift.
  const FILTERS = {
    all:            'true',
    no_app:         'account_id IS NULL',
    has_app:        'account_id IS NOT NULL',
    installed:      'installed = true',
    not_installed:  'account_id IS NOT NULL AND installed = false',
    notifications:  'devices > 0',
    club:           'club_active',
    club_no_app:    'club_active AND account_id IS NULL',
    non_club:       'NOT club_active',
    // Held a membership, holds none now — 370 people who liked the wine enough
    // to join once. Warmer than any cold list.
    lapsed:         'club_lapsed',
    lapsed_no_app:  'club_lapsed AND account_id IS NULL',
    never_club:     'club_signup_date IS NULL',
    // Joined the club after installing the app — the conversion we care about.
    app_converted:  "account_id IS NOT NULL AND club_signup_date IS NOT NULL AND club_signup_date > joined_app_at",
  };
  const where = FILTERS[filter] || FILTERS.all;

  try {
    const params = [cid(req)];
    let searchSql = '';
    if (String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      searchSql = ` AND (first_name ILIKE $${params.length} OR last_name ILIKE $${params.length}
                         OR emails::text ILIKE $${params.length})`;
    }

    const funnel = await query(`${BASE_CTE}
      SELECT count(*)::int                                                              AS customers,
             count(*) FILTER (WHERE club_active)::int                                   AS club_members,
             count(*) FILTER (WHERE club_lapsed)::int                                   AS lapsed_members,
             count(*) FILTER (WHERE account_id IS NOT NULL)::int                        AS app_accounts,
             count(*) FILTER (WHERE installed)::int                                     AS installed,
             count(*) FILTER (WHERE devices > 0)::int                                   AS notifications_on,
             count(*) FILTER (WHERE taps > 0)::int                                      AS tapped,
             count(*) FILTER (WHERE reservations > 0)::int                              AS reserved,
             count(*) FILTER (WHERE account_id IS NOT NULL AND club_signup_date IS NOT NULL
                                AND club_signup_date > joined_app_at)::int              AS joined_after_app
        FROM base`, [cid(req)]);

    params.push(Math.min(Number(limit) || 100, 500), Number(offset) || 0);
    const rows = await query(`${BASE_CTE}
      SELECT * FROM base WHERE ${where}${searchSql}
       ORDER BY last_seen DESC NULLS LAST, last_activity_date DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    const total = await query(`${BASE_CTE}
      SELECT count(*)::int n FROM base WHERE ${where}${searchSql}`,
      params.slice(0, params.length - 2));

    res.json({
      funnel: funnel.rows[0],
      members: rows.rows,
      total: total.rows[0].n,
      filter,
      // Stated on the response so the UI can't quietly imply more than we know:
      // iOS has no install event, so "installed" means "has opened it standalone".
      caveat: 'installed = has opened the app in standalone mode; iOS provides no install event.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /members/:accountId/activity ─────────────────────────────────────────
router.get('/members/:accountId/activity', ...admin, async (req, res) => {
  try {
    const r = await query(
      `SELECT a.event_type, a.occurred_at, a.metadata, s.title AS send_title
         FROM app_activity a
         LEFT JOIN club_notification_sends s ON s.id = a.send_id
        WHERE a.company_id = $1 AND a.account_id = $2
        ORDER BY a.occurred_at DESC LIMIT 200`,
      [cid(req), req.params.accountId]);
    res.json({ activity: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Settings ─────────────────────────────────────────────────────────────────
router.get('/settings', ...admin, async (req, res) => {
  try {
    await query(`INSERT INTO kindred_app_settings (company_id) VALUES ($1)
                 ON CONFLICT (company_id) DO NOTHING`, [cid(req)]);
    const r = await query(`SELECT * FROM kindred_app_settings WHERE company_id = $1`, [cid(req)]);
    res.json({ settings: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', ...admin, async (req, res) => {
  const allowed = ['send_window_start_hour', 'send_window_end_hour', 'send_timezone',
                   'frequency_cap_count', 'frequency_cap_days', 'event_lead_days',
                   'event_notify_default', 'imported_notify_default',
                   'release_2wk_title', 'release_2wk_body', 'release_2day_title', 'release_2day_body'];
  const fields = [], vals = [];
  let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) { fields.push(`${k} = $${i++}`); vals.push(req.body[k]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

  const s = Number(req.body.send_window_start_hour), e = Number(req.body.send_window_end_hour);
  if (req.body.send_window_start_hour !== undefined && req.body.send_window_end_hour !== undefined && s >= e) {
    return res.status(400).json({ error: 'The send window must start before it ends.' });
  }

  try {
    fields.push('updated_at = NOW()');
    vals.push(cid(req));
    const r = await query(
      `UPDATE kindred_app_settings SET ${fields.join(', ')} WHERE company_id = $${i} RETURNING *`, vals);
    res.json({ settings: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /activity ───────────────────────────────────────────────────────────
// Written BY the app. Accepts an anonymous beacon (no session) so the top of the
// funnel — someone who scanned the counter board and hasn't signed up — is still
// visible. With a session, the row is attributed to that account.
const KNOWN = new Set(['app_open', 'standalone_open', 'notification_click',
                       'notification_dismissed', 'reservation_started',
                       'reservation_completed', 'club_portal_open', 'prefs_changed']);

router.post('/activity', async (req, res) => {
  const { eventType, sendId, metadata } = req.body || {};
  if (!KNOWN.has(eventType)) {
    return res.status(400).json({ error: `Unknown eventType. One of: ${[...KNOWN].join(', ')}` });
  }
  try {
    // Attribute it if a valid member session came along; otherwise record it
    // anonymously rather than dropping it.
    let accountId = null, companyId = req.body.companyId || null;
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (token) {
      const s = await query(
        `SELECT ms.account_id, ma.company_id FROM club_steward.member_sessions ms
           JOIN club_steward.member_accounts ma ON ma.id = ms.account_id
          WHERE ms.token = $1 AND ms.expires_at > NOW()`, [token]);
      if (s.rows.length) { accountId = s.rows[0].account_id; companyId = s.rows[0].company_id; }
    }
    if (!companyId) return res.status(400).json({ error: 'companyId required for anonymous activity' });

    await query(
      `INSERT INTO app_activity (company_id, account_id, event_type, send_id, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [companyId, accountId, eventType, sendId || null, metadata ? JSON.stringify(metadata) : null]);
    res.status(201).json({ ok: true, attributed: !!accountId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export { router as kindredAppRouter };
