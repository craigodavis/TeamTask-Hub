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
import { evaluate, CONDITIONS, SCALAR_OUTCOMES, LIST_OUTCOMES } from '../lib/eventTerms.js';
import { board, closedBoard } from '../lib/eventBoard.js';
import { sendMail } from '../mail.js';
import { clientIpOf } from './mcpDb.js';
import { renderContract, isoDate } from '../lib/contractRender.js';
import { EVENT_REQUEST_URL, EVENT_CONTRACT_URL } from '../lib/publicLinks.js';
import {
  KEYS, money, outstanding, allSatisfied, newToken,
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

// ── Board ────────────────────────────────────────────────────────────────────
// The default screen: every live booking, what it still owes, and whose move it is.
// Sorted by how soon the event is, because that is how this work goes wrong.

router.get('/board', requireManager, async (req, res) => {
  try {
    const [live, closed] = await Promise.all([board(req.companyId), closedBoard()]);
    res.json({ ...live, closed, form_url: EVENT_REQUEST_URL });
  } catch (e) { console.error('board', e); res.status(500).json({ error: e.message }); }
});

// ── Terms ────────────────────────────────────────────────────────────────────
// Guests x venue x business-hours -> the whole package. See docs/PRIVATE_EVENTS.md.
// No threshold lives in code; every number here is a database row Craig can edit.

router.get('/terms', requireManager, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, l.name AS location_name
         FROM kindred_web.event_terms t
         LEFT JOIN locations l ON l.id = t.location_id
        WHERE t.company_id = $1
        ORDER BY t.min_guests NULLS FIRST, t.max_guests NULLS LAST, t.created_at`,
      [req.companyId]);
    res.json({ terms: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const TERM_FIELDS = [
  'name', 'active',
  ...CONDITIONS,
  ...SCALAR_OUTCOMES, ...LIST_OUTCOMES,
];

const TERM_INTS = ['min_guests', 'max_guests', 'min_wine_purchase_cents',
  'hourly_rate_cents', 'base_price_cents', 'security_deposit_cents', 'booking_deposit_cents',
  'balance_due_days_before', 'planning_meeting_days', 'parking_attendant_over'];

// '' from an unset input is not a value — it means "no opinion" and must reach the
// database as NULL. A blank numeric coerced to 0 would read as a real decision:
// security_deposit_cents = 0 says "no deposit here", which is not the same as "this
// row does not say".
function cleanTerm(b) {
  const out = {};
  for (const f of TERM_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (v === '' || v === undefined) v = null;
    if (TERM_INTS.includes(f) && v !== null) {
      v = parseInt(v, 10);
      if (Number.isNaN(v)) v = null;
    }
    if (f === 'booking_deposit_pct' && v !== null) {
      v = Number(v);
      if (!Number.isFinite(v)) v = null;
    }
    if (f === 'active' && v !== null) v = !!v;
    for (const bool of ['during_business_hours', 'insurance_required', 'contract_required']) {
      if (f === bool && v !== null && v !== true && v !== false) v = null;
    }
    if (LIST_OUTCOMES.includes(f)) {
      v = Array.isArray(v) ? v.filter(Boolean).map(String) : null;
    }
    out[f] = v;
  }
  return out;
}

function validateTerm(b) {
  if (b.min_guests != null && b.max_guests != null && b.max_guests < b.min_guests) {
    return 'The guest range runs backwards — max is below min.';
  }
  if (b.booking_deposit_pct != null && (b.booking_deposit_pct < 0 || b.booking_deposit_pct > 100)) {
    return 'The booking deposit is a percentage, so it has to be between 0 and 100.';
  }
  if (b.availability != null && !['available', 'on_request', 'unavailable'].includes(b.availability)) {
    return 'Availability must be available, on_request or unavailable.';
  }
  return null;
}

router.post('/terms', requireManager, async (req, res) => {
  try {
    const b = cleanTerm(req.body || {});
    if (!b.name) {
      return res.status(400).json({ error: 'Give it a name — the name is what explains the charge to a customer.' });
    }
    const bad = validateTerm(b);
    if (bad) return res.status(400).json({ error: bad });

    const cols = ['company_id'], vals = [req.companyId], ph = ['$1'];
    for (const [k, v] of Object.entries(b)) { cols.push(k); vals.push(v); ph.push('$' + vals.length); }
    const { rows } = await query(
      `INSERT INTO kindred_web.event_terms (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING *`, vals);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/terms/:id', requireManager, async (req, res) => {
  try {
    const b = cleanTerm(req.body || {});
    const bad = validateTerm(b);
    if (bad) return res.status(400).json({ error: bad });

    const sets = [], vals = [];
    for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id, req.companyId);
    const { rows } = await query(
      `UPDATE kindred_web.event_terms SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'No such terms row' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deactivate rather than delete. A proposal already quoted carries a frozen copy of
// its terms, but `sources` points at these ids to explain the quote, and deleting the
// row turns that explanation into a dangling id.
router.delete('/terms/:id', requireManager, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE kindred_web.event_terms SET active = false, updated_at = now()
        WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.companyId]);
    if (!rows.length) return res.status(404).json({ error: 'No such terms row' });
    res.json({ ok: true, deactivated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Try a hypothetical booking without saving anything — this is how you check a
// threshold does what you meant before a customer runs into it.
router.post('/terms/preview', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await evaluate(req.companyId, {
      guests: b.guests != null && b.guests !== '' ? parseInt(b.guests, 10) : null,
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

// The business constants the contract tokens resolve against.
router.get('/contract-values', requireManager, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM kindred_web.event_contract_values
        WHERE company_id = $1 ORDER BY sort_order, key`, [req.companyId]);
    res.json({ values: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/contract-values/:id', requireManager, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE kindred_web.event_contract_values SET value = $1, updated_at = now()
        WHERE id = $2 AND company_id = $3 RETURNING *`,
      [String(req.body?.value ?? ''), req.params.id, req.companyId]);
    if (!rows.length) return res.status(404).json({ error: 'No such value' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/event-requests/:id/contract — the contract as this booking would see it.
// Read-only preview: nothing is stored until it is sent, and nothing can change once
// signed, because signing freezes a snapshot and its hash.
router.get('/:id/contract', requireManager, async (req, res) => {
  try {
    const r = (await query(
      `SELECT r.*, l.name AS location_name
         FROM kindred_web.event_requests r
         LEFT JOIN locations l ON l.id = r.location_id
        WHERE r.id = $1`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'No such request' });
    const extra = Array.isArray(req.query.sections)
      ? req.query.sections
      : (req.query.sections ? String(req.query.sections).split(',') : []);
    res.json(await renderContract(req.companyId, r, extra));
  } catch (e) { console.error('contract render', e); res.status(500).json({ error: e.message }); }
});

// ── Setup tasks ──────────────────────────────────────────────────────────────
// What staff physically do before an event. Same library pattern as the contract
// sections: the task says what to do, the terms band says when it applies.

router.get('/setup-tasks', requireManager, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM kindred_web.event_setup_tasks
        WHERE company_id = $1 ORDER BY sort_order, title`, [req.companyId]);
    res.json({ tasks: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/setup-tasks', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    const title = (b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Give the step a title.' });
    const key = slugKey(b.key || title);
    if (!key) return res.status(400).json({ error: 'Could not make a key from that title — add one.' });
    const { rows } = await query(
      `INSERT INTO kindred_web.event_setup_tasks
         (company_id, key, title, instructions, area, lead_minutes, sort_order, always_include, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.companyId, key, title, b.instructions || '', (b.area || '').trim() || null,
       b.lead_minutes === '' || b.lead_minutes == null ? null : parseInt(b.lead_minutes, 10),
       parseInt(b.sort_order, 10) || 0, !!b.always_include, b.active !== false]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A step with that key already exists.' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/setup-tasks/:id', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.title !== undefined) put('title', String(b.title).trim());
    if (b.key !== undefined) put('key', slugKey(b.key));
    if (b.instructions !== undefined) put('instructions', b.instructions || '');
    if (b.area !== undefined) put('area', (b.area || '').trim() || null);
    if (b.lead_minutes !== undefined) {
      put('lead_minutes', b.lead_minutes === '' || b.lead_minutes == null ? null : parseInt(b.lead_minutes, 10));
    }
    if (b.sort_order !== undefined) put('sort_order', parseInt(b.sort_order, 10) || 0);
    if (b.always_include !== undefined) put('always_include', !!b.always_include);
    if (b.active !== undefined) put('active', !!b.active);
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id, req.companyId);
    const { rows } = await query(
      `UPDATE kindred_web.event_setup_tasks SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'No such step' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That key is already in use.' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/setup-tasks/:id', requireManager, async (req, res) => {
  try {
    await query(`DELETE FROM kindred_web.event_setup_tasks WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.companyId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── The staff run sheet ──────────────────────────────────────────────────────
/**
 * Everything about one booking, in one printable payload: who, when, where, the
 * terms, and the setup steps that apply.
 *
 * Returned as data rather than rendered HTML so the page can print it with the
 * house styles. Until the terms band exists, the steps are the "always include"
 * ones — correct rather than empty, and it fills out as bands are defined.
 */
router.get('/:id/run-sheet', requireManager, async (req, res) => {
  try {
    const r = (await query(
      `SELECT r.*, l.name AS location_name
         FROM kindred_web.event_requests r
         LEFT JOIN locations l ON l.id = r.location_id
        WHERE r.id = $1`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'No such request' });

    const steps = (await query(
      `SELECT * FROM kindred_web.event_setup_tasks
        WHERE company_id = $1 AND active AND always_include
        ORDER BY COALESCE(area,''), sort_order, title`, [req.companyId])).rows;

    // Anything else on that date, so whoever reads the sheet knows what they are
    // sharing the day with.
    const alsoOn = (await query(
      `SELECT e.title, e.start_at, l.name AS location_name
         FROM events e LEFT JOIN locations l ON l.id = e.location_id
        WHERE e.start_at::date = $1::date ORDER BY e.start_at`,
      [isoDate(r.event_date)])).rows;

    res.json({ request: shape(r), steps, alsoOn });
  } catch (e) { console.error('run-sheet', e); res.status(500).json({ error: e.message }); }
});

// ── Send the contract ────────────────────────────────────────────────────────
// The board used to mark a contract "sent" with a bare timestamp and no email, so a
// booking moved to "with them" while the customer had been told nothing. A state
// that records something we did not do is worse than no state at all: nobody chases
// it, because the board says it is their move.
//
// So the timestamp is stamped ONLY if the mail actually went. A failed send leaves
// the booking exactly where it was, needing us.

const esc = (t) => String(t ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

router.post('/:id/send-contract', requireManager, async (req, res) => {
  try {
    const cur = (await query(
      `SELECT r.*, l.name AS location_name
         FROM kindred_web.event_requests r
         LEFT JOIN locations l ON l.id = r.location_id
        WHERE r.id = $1`, [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Request not found' });
    if (!cur.email) {
      return res.status(400).json({ error: 'No email address on this enquiry, so there is nowhere to send it.' });
    }

    // Which clauses this booking carries was decided when its terms were frozen.
    // Reading the terms table now could send a contract that differs from the one
    // the quote was based on.
    const extraKeys = cur.requirements?.contract_section_keys || [];
    const { sections } = await renderContract(req.companyId, cur, extraKeys);
    if (!sections.length) {
      return res.status(400).json({ error: 'No contract sections are active, so there is nothing to send.' });
    }

    // The link is the credential, so it must exist and must still be alive. Resending
    // extends it rather than minting a new one: a customer who kept the first email
    // should not find that link dead because someone pressed Resend.
    let token = cur.token;
    if (!token) {
      token = newToken();
      await query(`UPDATE kindred_web.event_requests SET token = $2 WHERE id = $1`, [cur.id, token]);
    }
    await query(
      `UPDATE kindred_web.event_requests SET token_expires_at = NOW() + INTERVAL '180 days'
        WHERE id = $1`, [cur.id]);

    const url = `${EVENT_CONTRACT_URL}?t=${encodeURIComponent(token)}`;
    const name = `${cur.first_name || ''} ${cur.last_name || ''}`.trim();
    const when = [isoDate(cur.event_date),
      cur.start_time ? `${String(cur.start_time).slice(0, 5)}–${String(cur.end_time || '').slice(0, 5)}` : null,
      cur.location_name].filter(Boolean).join(' · ');

    // A link, not the contract itself. Signing happens on the page, and a contract
    // pasted into an email is one nobody can sign and everybody can edit.
    const html = `<div style="font-family:Georgia,serif;max-width:620px;line-height:1.55">`
      + `<p>${esc(name) || 'Hello'},</p>`
      + `<p>Your agreement for ${esc(when) || 'your event'} is ready to read and sign.</p>`
      + `<p><a href="${esc(url)}" style="display:inline-block;padding:11px 20px;`
      + `background:#0F5361;color:#fff;text-decoration:none;border-radius:6px">`
      + `Read and sign the agreement</a></p>`
      + `<p style="font-size:13px;color:#666">`
      + `Or paste this into your browser:<br>${esc(url)}</p>`
      + `<p style="font-size:13px;color:#666">`
      + `The link is personal to your booking — please do not forward it. `
      + `Any questions, just reply to this email.</p></div>`;

    const text = `${name},\n\nYour agreement for ${when || 'your event'} is ready to read and sign:\n\n`
      + `${url}\n\nThe link is personal to your booking — please do not forward it. `
      + `Any questions, just reply to this email.`;

    const sent = await sendMail({
      to: cur.email,
      subject: 'Your agreement for Kindred Vineyards',
      text, html,
    }, req.companyId);

    // sendMail reports failure by return value, not by throwing, so this has to be
    // checked. Treating it as fire-and-forget is how the board came to lie.
    if (sent && sent.sent === false) {
      return res.status(502).json({ error: `The email did not send: ${sent.error || 'unknown error'}` });
    }

    const { rows } = await query(
      `UPDATE kindred_web.event_requests
          SET contract_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`, [cur.id]);
    res.json({ ok: true, sentTo: cur.email, sections: sections.length, request: shape(rows[0]) });
  } catch (e) {
    console.error('send-contract', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Our counter-signature ────────────────────────────────────────────────────
// Executed means BOTH parties signed. Setting contract_executed_at on its own would
// record an agreement with only one signature behind it, so this writes our row
// against the same frozen text the renter agreed to — not a fresh render, which
// could by then say something else.
router.post('/:id/countersign', requireManager, async (req, res) => {
  try {
    const cur = (await query(
      `SELECT * FROM kindred_web.event_requests WHERE id = $1`, [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Request not found' });

    const renter = (await query(
      `SELECT contract_snapshot, contract_sha256 FROM kindred_web.event_contract_signatures
        WHERE request_id = $1 AND party = 'renter'`, [cur.id])).rows[0];
    if (!renter) {
      return res.status(400).json({ error: 'The customer has not signed it yet, so there is nothing to counter-sign.' });
    }

    const who = req.userId
      ? (await query(`SELECT name, email FROM users WHERE id = $1`, [req.userId])).rows[0]
      : null;
    const signedName = who?.name || who?.email || 'Kindred Vineyards';

    try {
      await query(
        `INSERT INTO kindred_web.event_contract_signatures
           (company_id, request_id, party, signed_name, ip, user_agent,
            contract_snapshot, contract_sha256)
         VALUES ($1,$2,'kindred',$3,$4,$5,$6::jsonb,$7)`,
        [req.companyId, cur.id, signedName, clientIpOf(req),
         String(req.headers['user-agent'] || '').slice(0, 500),
         JSON.stringify(renter.contract_snapshot), renter.contract_sha256]);
    } catch (e) {
      if (e.code !== '23505') throw e;   // already counter-signed; fall through
    }

    const { rows } = await query(
      `UPDATE kindred_web.event_requests
          SET contract_executed_at = COALESCE(contract_executed_at, NOW()), updated_at = NOW()
        WHERE id = $1 RETURNING *`, [cur.id]);
    res.json({ ok: true, signedName, request: shape(rows[0]) });
  } catch (e) { console.error('countersign', e); res.status(500).json({ error: e.message }); }
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
      eventDate: isoDate(cur.event_date),
      startTime: cur.start_time, endTime: cur.end_time,
    });

    await query(
      `UPDATE kindred_web.event_requests
          SET requirements = $2, rules_evaluated_at = now(),
              deposit_required = $3, insurance_required = $4, updated_at = now()
        WHERE id = $1`,
      [cur.id, JSON.stringify(out),
        (out.booking_deposit_cents ?? 0) > 0 || (out.security_deposit_cents ?? 0) > 0,
        !!out.insurance_required]);

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
        // pg hands back a Date; String(aDate).slice(0,10) is "Tue Sep 01", which
        // never matches an ISO key — so no conflict was ever found.
        const d = isoDate(r.event_date);
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

    // Three separate marks because three different people are waiting at each
    // point: us to send, them to sign, us to counter-sign. A single "signed" flag
    // would lose whose move it is, which is the one thing the board exists to say.
    // Sent as booleans and stamped here, so the clock is the server's.
    for (const [flag, col] of [
      ['contract_sent', 'contract_sent_at'],
      ['contract_customer_signed', 'contract_customer_signed_at'],
      ['contract_executed', 'contract_executed_at'],
      ['deposit_paid', 'deposit_paid_at'],
    ]) {
      if (b[flag] !== undefined) set(col, b[flag] ? new Date() : null);
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
