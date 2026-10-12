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
import { evaluate, EFFECT_TYPES } from '../lib/eventRules.js';
import { EVENT_REQUEST_URL } from '../lib/publicLinks.js';
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
      `SELECT r.*, l.name AS location_name
         FROM kindred_web.event_requests r
         LEFT JOIN locations l ON l.id = r.location_id
        ${status ? 'WHERE r.status = $1' : ''}
        ORDER BY r.created_at DESC LIMIT 500`,
      status ? [status] : []);
    // Sent with the list so staff can copy the exact link customers receive
    // instead of retyping a URL from memory.
    res.json({ requests: rows.map(shape), form_url: EVENT_REQUEST_URL });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Rules ────────────────────────────────────────────────────────────────────
// The thresholds live here, not in code. See docs/PRIVATE_EVENTS.md.

router.get('/rules', requireManager, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT r.*, l.name AS location_name
         FROM kindred_web.event_rules r
         LEFT JOIN locations l ON l.id = r.location_id
        WHERE r.company_id = $1
        ORDER BY r.effect_type, r.priority, r.created_at`, [req.companyId]);
    res.json({ rules: rows, effectTypes: EFFECT_TYPES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const RULE_FIELDS = ['name', 'active', 'priority', 'min_guests', 'max_guests',
  'location_id', 'during_business_hours', 'day_of_week_mask', 'lead_days_min',
  'lead_days_max', 'effect_type', 'amount_cents', 'amount_pct', 'due_offset_days',
  'customer_text'];

// '' from an unset <select> is not a value — it means "don't care" and must reach
// the database as NULL, or the CHECK constraints reject it and a blank numeric
// silently becomes 0, which is a real threshold.
function cleanRule(b) {
  const out = {};
  for (const f of RULE_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (v === '' || v === undefined) v = null;
    if (['priority','min_guests','max_guests','day_of_week_mask','lead_days_min',
         'lead_days_max','amount_cents','due_offset_days'].includes(f) && v !== null) {
      v = parseInt(v, 10);
      if (Number.isNaN(v)) v = null;
    }
    if (f === 'active' && v !== null) v = !!v;
    if (f === 'during_business_hours' && v !== null && v !== true && v !== false) v = null;
    out[f] = v;
  }
  return out;
}

router.post('/rules', requireManager, async (req, res) => {
  try {
    const b = cleanRule(req.body || {});
    if (!b.name) return res.status(400).json({ error: 'Give the rule a name — it is what explains the charge.' });
    if (!EFFECT_TYPES.includes(b.effect_type)) {
      return res.status(400).json({ error: `effect_type must be one of: ${EFFECT_TYPES.join(', ')}` });
    }
    const cols = ['company_id'], vals = [req.companyId], ph = ['$1'];
    for (const [k, v] of Object.entries(b)) { cols.push(k); vals.push(v); ph.push('$' + vals.length); }
    const { rows } = await query(
      `INSERT INTO kindred_web.event_rules (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING *`, vals);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/rules/:id', requireManager, async (req, res) => {
  try {
    const b = cleanRule(req.body || {});
    if (b.effect_type && !EFFECT_TYPES.includes(b.effect_type)) {
      return res.status(400).json({ error: 'Unknown effect type' });
    }
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id, req.companyId);
    const { rows } = await query(
      `UPDATE kindred_web.event_rules SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'No such rule' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/rules/:id', requireManager, async (req, res) => {
  try {
    await query(`DELETE FROM kindred_web.event_rules WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Try a hypothetical booking against the rules without saving anything. This is how
// you check a threshold does what you meant before a customer meets it.
router.post('/rules/preview', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await evaluate(req.companyId, {
      guests: b.guests != null ? parseInt(b.guests, 10) : null,
      locationId: b.location_id || null,
      eventDate: b.event_date || null,
      startTime: b.start_time || null,
      endTime: b.end_time || null,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Contract sections ────────────────────────────────────────────────────────
// The clause library. Which sections a given contract carries is decided by the
// terms; this is what they choose FROM. Editing a section here never alters a
// contract already signed — that is rendered to a snapshot with a hash of exactly
// what was shown.

router.get('/contract-sections', requireManager, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM kindred_web.event_contract_sections
        WHERE company_id = $1 ORDER BY sort_order, title`, [req.companyId]);
    res.json({ sections: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// A key is a handle, not prose: lower case, no spaces, so a rule can reference it
// and a later rename of the title cannot break that reference.
const slugKey = (v) => String(v || '').trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

router.post('/contract-sections', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    const title = (b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Give the section a title.' });
    const key = slugKey(b.key || title);
    if (!key) return res.status(400).json({ error: 'Could not make a key from that title — add one.' });
    const { rows } = await query(
      `INSERT INTO kindred_web.event_contract_sections
         (company_id, key, title, body, sort_order, always_include, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.companyId, key, title, b.body || '', parseInt(b.sort_order, 10) || 0,
       !!b.always_include, b.active !== false]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A section with that key already exists.' });
    }
    res.status(500).json({ error: e.message });
  }
});

router.put('/contract-sections/:id', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.title !== undefined) put('title', String(b.title).trim());
    if (b.key !== undefined) put('key', slugKey(b.key));
    if (b.body !== undefined) put('body', b.body || '');
    if (b.sort_order !== undefined) put('sort_order', parseInt(b.sort_order, 10) || 0);
    if (b.always_include !== undefined) put('always_include', !!b.always_include);
    if (b.active !== undefined) put('active', !!b.active);
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id, req.companyId);
    const { rows } = await query(
      `UPDATE kindred_web.event_contract_sections SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'No such section' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That key is already in use.' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/contract-sections/:id', requireManager, async (req, res) => {
  try {
    await query(`DELETE FROM kindred_web.event_contract_sections
                  WHERE id = $1 AND company_id = $2`, [req.params.id, req.companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Evaluate a real request and freeze the outcome ───────────────────────────
// Stored by value. Editing a threshold afterwards must never rewrite what this
// booking was told — the same rule the tier quote already follows.
router.post('/:id/evaluate', requireManager, async (req, res) => {
  try {
    const cur = (await query(
      `SELECT * FROM kindred_web.event_requests WHERE id = $1`, [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'No such request' });

    const out = await evaluate(req.companyId, {
      guests: cur.guests,
      locationId: cur.location_id,
      eventDate: cur.event_date ? String(cur.event_date).slice(0, 10) : null,
      startTime: cur.start_time, endTime: cur.end_time,
    });

    await query(
      `UPDATE kindred_web.event_requests
          SET requirements = $2, rules_evaluated_at = now(),
              deposit_required = $3, insurance_required = $4, updated_at = now()
        WHERE id = $1`,
      [cur.id, JSON.stringify(out), !!out.deposit.required, !!out.insurance.required]);

    res.json(out);
  } catch (e) { console.error('evaluate', e); res.status(500).json({ error: e.message }); }
});

// ── Calendar ─────────────────────────────────────────────────────────────────
/**
 * Private-event requests in a date range, each with whatever ELSE is already on
 * that date. Nothing currently stops a private booking being approved at the Creek
 * on a night a musician is booked there, and the public calendar has proven not to
 * be a complete picture - five Thursdays at the Creek were missing from it entirely.
 */
router.get('/calendar', requireManager, async (req, res) => {
  try {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });

    const reqs = (await query(
      `SELECT r.*, l.name AS location_name
         FROM kindred_web.event_requests r
         LEFT JOIN locations l ON l.id = r.location_id
        WHERE r.event_date BETWEEN $1::date AND $2::date
        ORDER BY r.event_date, r.start_time NULLS LAST`, [from, to])).rows;

    // Public events on the same dates, for conflict detection.
    const events = (await query(
      `SELECT e.id, e.title, e.start_at, e.end_at, e.location_id,
              l.name AS location_name, COALESCE(e.stage, e.status) AS stage
         FROM events e
         LEFT JOIN locations l ON l.id = e.location_id
        WHERE e.start_at::date BETWEEN $1::date AND $2::date
        ORDER BY e.start_at`, [from, to])).rows;

    const byDate = {};
    for (const e of events) {
      const d = e.start_at.toISOString().slice(0, 10);
      (byDate[d] ??= []).push(e);
    }

    res.json({
      requests: reqs.map((r) => {
        const d = String(r.event_date).slice(0, 10);
        const sameDay = byDate[d] || [];
        return {
          ...shape(r),
          event_date: d,
          // Same venue is a hard clash; same day elsewhere is worth knowing about.
          conflicts: sameDay.filter((e) => r.location_id && e.location_id === r.location_id),
          sameDayEvents: sameDay,
        };
      }),
      events,
    });
  } catch (e) { console.error('pe calendar', e); res.status(500).json({ error: e.message }); }
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
