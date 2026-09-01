/**
 * Special Event Requests — Marketing → Event Requests.
 *
 * Staff side only. The public form, the guest's return page and the upload live
 * on the website router (no auth, token-scoped) — see routes/website.js.
 *
 * Manager-only: these rows carry a member of the public's name, address, phone
 * and, later, their insurance certificate.
 */
import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';
import {
  KEYS, money, outstanding, allSatisfied,
  alertRecipients, planningMeetingSms, shortDate,
} from '../lib/eventRequests.js';
import { sendSmsToUsers } from '../lib/smsHelper.js';

const router = express.Router();

const centsFrom = (v) => {
  if (v === '' || v == null) return 0;
  const n = Math.round(Number(String(v).replace(/[$,\s]/g, '')) * 100);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/* ------------------------------------------------------------------- tiers */

// GET /api/event-requests/tiers
router.get('/tiers', requireManager, async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM kindred_web.event_tiers ORDER BY min_guests, sort_order`);
    res.json({ tiers: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/event-requests/tiers — create
router.post('/tiers', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    const min = parseInt(b.min_guests, 10);
    if (!Number.isFinite(min) || min < 1) return res.status(400).json({ error: 'Minimum guests must be at least 1.' });
    const max = b.max_guests === '' || b.max_guests == null ? null : parseInt(b.max_guests, 10);
    if (max != null && max < min) return res.status(400).json({ error: 'Maximum guests cannot be below the minimum.' });

    const { rows } = await query(
      `INSERT INTO kindred_web.event_tiers
         (min_guests, max_guests, title, base_price_cents, min_alcohol_cents, rules,
          deposit_required, deposit_cents, deposit_description,
          insurance_required, insurance_description, planning_meeting_days, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [min, max, b.title || null, centsFrom(b.base_price), centsFrom(b.min_alcohol), b.rules || null,
       !!b.deposit_required, centsFrom(b.deposit), b.deposit_description || null,
       !!b.insurance_required, b.insurance_description || null,
       Number.isFinite(parseInt(b.planning_meeting_days, 10)) ? parseInt(b.planning_meeting_days, 10) : null,
       parseInt(b.sort_order, 10) || 0],
    );
    res.json({ tier: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/event-requests/tiers/:id — update
router.put('/tiers/:id', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    const min = parseInt(b.min_guests, 10);
    if (!Number.isFinite(min) || min < 1) return res.status(400).json({ error: 'Minimum guests must be at least 1.' });
    const max = b.max_guests === '' || b.max_guests == null ? null : parseInt(b.max_guests, 10);
    if (max != null && max < min) return res.status(400).json({ error: 'Maximum guests cannot be below the minimum.' });

    const { rows } = await query(
      `UPDATE kindred_web.event_tiers SET
         min_guests=$1, max_guests=$2, title=$3, base_price_cents=$4, min_alcohol_cents=$5, rules=$6,
         deposit_required=$7, deposit_cents=$8, deposit_description=$9,
         insurance_required=$10, insurance_description=$11, planning_meeting_days=$12,
         sort_order=$13, updated_at=NOW()
       WHERE id=$14 RETURNING *`,
      [min, max, b.title || null, centsFrom(b.base_price), centsFrom(b.min_alcohol), b.rules || null,
       !!b.deposit_required, centsFrom(b.deposit), b.deposit_description || null,
       !!b.insurance_required, b.insurance_description || null,
       Number.isFinite(parseInt(b.planning_meeting_days, 10)) ? parseInt(b.planning_meeting_days, 10) : null,
       parseInt(b.sort_order, 10) || 0, req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tier not found' });
    res.json({ tier: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/event-requests/tiers/:id
// Requests keep their quoted figures by value, so removing a tier cannot change
// what an existing guest was promised — the FK is ON DELETE SET NULL.
router.delete('/tiers/:id', requireManager, async (req, res) => {
  try {
    await query(`DELETE FROM kindred_web.event_tiers WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------------------------------------------------------- settings */

// GET /api/event-requests/settings — the editable copy.
router.get('/settings', requireManager, async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT key, value FROM kindred_web.settings WHERE key = ANY($1)`, [Object.values(KEYS)]);
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({ intro: map[KEYS.intro] || '', approvedEmail: map[KEYS.approvedEmail] || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/event-requests/settings
router.put('/settings', requireManager, async (req, res) => {
  try {
    const pairs = [[KEYS.intro, req.body?.intro ?? ''], [KEYS.approvedEmail, req.body?.approvedEmail ?? '']];
    for (const [key, value] of pairs) {
      // kindred_web.settings.value is jsonb — a bare string is not valid JSON, so
      // it has to be cast. Stored as a JSON string; node-postgres parses it back
      // to a plain JS string on read, which is what the editor expects.
      await query(
        `INSERT INTO kindred_web.settings (key, value) VALUES ($1, to_jsonb($2::text))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, String(value)]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------------------------------------------------------- requests */

const shape = (r) => ({
  ...r,
  name: `${r.first_name} ${r.last_name}`.trim(),
  quotedBase: money(r.quoted_base_cents),
  quotedMinAlcohol: money(r.quoted_min_alcohol_cents),
  quotedDeposit: money(r.quoted_deposit_cents),
  steps: outstanding(r),
  ready: allSatisfied(r),
  planningMeetingDue: r.planning_meeting_due ? shortDate(r.planning_meeting_due) : null,
});

// GET /api/event-requests?status=
router.get('/', requireManager, async (req, res) => {
  try {
    const status = req.query.status;
    const { rows } = await query(
      `SELECT * FROM kindred_web.event_requests
        ${status ? 'WHERE status = $1' : ''}
        ORDER BY created_at DESC LIMIT 500`,
      status ? [status] : []);
    res.json({ requests: rows.map(shape) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PATCH /api/event-requests/:id — the staff actions.
 *
 * Approving is the hinge: it fixes the planning-meeting deadline from the tier's
 * lead time and tells us to go and book it. Everything downstream (the deposit
 * invoice, the guest's return link) keys off this flag.
 */
router.patch('/:id', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = (await query(`SELECT * FROM kindred_web.event_requests WHERE id = $1`, [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Request not found' });

    const sets = [];
    const vals = [];
    const set = (frag, v) => { vals.push(v); sets.push(`${frag}=$${vals.length}`); };

    let justApproved = false;
    if (b.status && b.status !== cur.status) {
      if (!['new', 'approved', 'declined', 'complete'].includes(b.status)) {
        return res.status(400).json({ error: 'Unknown status' });
      }
      set('status', b.status);
      if (b.status === 'approved') {
        // Approving only counts once. Re-approving an already-approved request
        // must not move a deadline someone has already worked to.
        justApproved = !cur.approved_at;
        if (justApproved) {
          set('approved_at', new Date());
          set('approved_by', req.userId || null);
          // The lead time is read from the tier NOW rather than at submission,
          // because it is our operational deadline, not part of the guest's
          // quote — if we decide big events need three weeks, that should apply.
          const tier = cur.tier_id
            ? (await query(`SELECT planning_meeting_days FROM kindred_web.event_tiers WHERE id = $1`, [cur.tier_id])).rows[0]
            : null;
          const days = tier?.planning_meeting_days;
          if (Number.isFinite(days) && days > 0) {
            set('planning_meeting_due', new Date(new Date(cur.event_date).getTime() - days * 86400000)
              .toISOString().slice(0, 10));
          }
        }
      }
      if (b.status === 'declined') set('declined_reason', b.declined_reason || null);
    }

    if (b.planning_meeting_booked !== undefined) {
      set('planning_meeting_booked', !!b.planning_meeting_booked);
      set('planning_meeting_at', b.planning_meeting_booked ? new Date() : null);
    }
    if (b.insurance_ok !== undefined) {
      set('insurance_ok', !!b.insurance_ok);
      set('insurance_ok_at', b.insurance_ok ? new Date() : null);
      set('insurance_ok_by', b.insurance_ok ? (req.userId || null) : null);
    }

    if (!sets.length) return res.json({ request: shape(cur) });
    vals.push(req.params.id);
    const { rows } = await query(
      `UPDATE kindred_web.event_requests SET ${sets.join(', ')}, updated_at=NOW()
        WHERE id=$${vals.length} RETURNING *`, vals);
    const updated = rows[0];

    // Tell us to book the planning meeting. After the row is saved, and never
    // allowed to fail the request: the approval is the thing that matters, and a
    // Twilio outage must not leave staff unable to approve an event.
    if (justApproved) {
      try {
        const people = await alertRecipients(req.companyId);
        if (people.length) {
          await sendSmsToUsers(req.companyId, people.map((p) => p.id),
            planningMeetingSms(updated), req.userId || null);
        } else {
          console.warn('[event-requests] approved but nobody has a phone number to alert');
        }
      } catch (e) {
        console.error('[event-requests] approval SMS failed:', e.message);
      }
    }

    res.json({ request: shape(updated) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
