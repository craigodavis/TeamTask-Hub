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
import { KEYS, money, outstanding, allSatisfied } from '../lib/eventRequests.js';

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
          insurance_required, insurance_description, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [min, max, b.title || null, centsFrom(b.base_price), centsFrom(b.min_alcohol), b.rules || null,
       !!b.deposit_required, centsFrom(b.deposit), b.deposit_description || null,
       !!b.insurance_required, b.insurance_description || null, parseInt(b.sort_order, 10) || 0],
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
         insurance_required=$10, insurance_description=$11, sort_order=$12, updated_at=NOW()
       WHERE id=$13 RETURNING *`,
      [min, max, b.title || null, centsFrom(b.base_price), centsFrom(b.min_alcohol), b.rules || null,
       !!b.deposit_required, centsFrom(b.deposit), b.deposit_description || null,
       !!b.insurance_required, b.insurance_description || null, parseInt(b.sort_order, 10) || 0,
       req.params.id],
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

export default router;
