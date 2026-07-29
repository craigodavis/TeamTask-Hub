/**
 * Kindred app perks — earning and redeeming.
 *
 *   GET  /api/kindred-app/me/perks              what this member is owed (member session)
 *   POST /api/kindred-app/me/perks/:id/redeem   staff marks it used, with their PIN
 *   GET  /api/kindred-app/perks                 staff list: owed, redeemed, by whom
 *
 * Why redemption lives here rather than in Square: tastings ring up in Square,
 * but Square carried a customer on only 65 of the last 3,065 orders. It cannot
 * tell staff who is owed a tasting, and cannot record that one was used. Staff
 * comp the tasting in Square exactly as they already do (481 times in the last
 * 90 days) — this only tracks the entitlement.
 *
 * The loop is deliberately not closed: nothing forces the Square comp to happen,
 * and nothing forces a comp to be marked here. A redemption with no matching $0
 * line shows up as a discrepancy in the staff list rather than being prevented.
 */

import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { requireAuth, requireManager } from '../middleware/auth.js';
import { requireMemberSession } from './clubNotifications.js';

const router = express.Router();
function cid(req) { return req.companyId || req.user?.company_id; }

const LABELS = {
  free_tasting: { name: 'First tasting on us', detail: 'One tasting, on the house, next time you’re in.' },
};

// ── GET /me/perks ────────────────────────────────────────────────────────────
router.get('/me/perks', requireMemberSession, async (req, res) => {
  try {
    const r = await query(
      `SELECT p.id, p.perk, p.earned_at, p.redeemed_at, p.redeemed_location,
              u.display_name AS redeemed_by_name, l.name AS location_name
         FROM kindred_app_perks p
         LEFT JOIN users u ON u.id = p.redeemed_by
         LEFT JOIN locations l ON l.id = p.redeemed_location
        WHERE p.account_id = $1
        ORDER BY p.earned_at DESC`, [req.memberAccountId]);
    res.json({
      perks: r.rows.map((p) => ({ ...p, ...(LABELS[p.perk] || { name: p.perk, detail: '' }) })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /me/perks/:id/redeem ────────────────────────────────────────────────
// Runs on the GUEST's phone but is a STAFF action: the guest hands the phone
// over and staff enter their PIN. Without that, the perk gets tapped at home and
// the guest arrives with nothing.
router.post('/me/perks/:id/redeem', requireMemberSession, async (req, res) => {
  const pin = String(req.body?.pin || '').trim();
  if (!pin) return res.status(400).json({ error: 'Staff PIN required.' });

  try {
    const perk = (await query(
      `SELECT id, perk, redeemed_at FROM kindred_app_perks
        WHERE id = $1 AND account_id = $2`, [req.params.id, req.memberAccountId])).rows[0];
    if (!perk) return res.status(404).json({ error: 'Not found.' });
    if (perk.redeemed_at) return res.status(409).json({ error: 'This has already been used.' });

    // Any staff member with a PIN can redeem — this happens at a busy counter,
    // not a desk. Who did it is recorded.
    const staff = await query(
      `SELECT id, display_name, pin_hash FROM users
        WHERE company_id = $1 AND pin_hash IS NOT NULL`,
      [req.companyId]);
    let matched = null;
    for (const u of staff.rows) {
      if (await bcrypt.compare(pin, u.pin_hash)) { matched = u; break; }
    }
    if (!matched) return res.status(403).json({ error: 'That PIN was not recognised.' });

    const r = await query(
      `UPDATE kindred_app_perks
          SET redeemed_at = NOW(), redeemed_by = $2, redeemed_location = $3
        WHERE id = $1 AND redeemed_at IS NULL
        RETURNING id, redeemed_at`,
      [perk.id, matched.id, req.body?.locationId || null]);
    // Lost the race against a second tap — report it rather than double-count.
    if (!r.rows.length) return res.status(409).json({ error: 'This has already been used.' });

    await query(
      `INSERT INTO app_activity (company_id, account_id, event_type, metadata)
       VALUES ($1, $2, 'perk_redeemed', $3)`,
      [req.companyId, req.memberAccountId,
       JSON.stringify({ perk: perk.perk, by: matched.display_name })]).catch(() => {});

    res.json({ ok: true, redeemedAt: r.rows[0].redeemed_at, by: matched.display_name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /perks (staff) ───────────────────────────────────────────────────────
router.get('/perks', requireAuth, requireManager, async (req, res) => {
  const status = req.query.status === 'redeemed' ? 'redeemed' : 'outstanding';
  try {
    const r = await query(
      `SELECT p.id, p.perk, p.earned_at, p.redeemed_at,
              ma.email, ma.commerce7_customer_id,
              c.first_name, c.last_name,
              u.display_name AS redeemed_by_name,
              l.name AS location_name
         FROM kindred_app_perks p
         JOIN club_steward.member_accounts ma ON ma.id = p.account_id
         LEFT JOIN commerce7.customers c ON c.id::text = ma.commerce7_customer_id
         LEFT JOIN users u ON u.id = p.redeemed_by
         LEFT JOIN locations l ON l.id = p.redeemed_location
        WHERE p.company_id = $1
          AND (${status === 'redeemed' ? 'p.redeemed_at IS NOT NULL' : 'p.redeemed_at IS NULL'})
        ORDER BY ${status === 'redeemed' ? 'p.redeemed_at DESC' : 'p.earned_at DESC'}
        LIMIT 300`, [cid(req)]);

    const counts = await query(
      `SELECT count(*) FILTER (WHERE redeemed_at IS NULL)::int outstanding,
              count(*) FILTER (WHERE redeemed_at IS NOT NULL)::int redeemed
         FROM kindred_app_perks WHERE company_id = $1`, [cid(req)]);

    res.json({ perks: r.rows, counts: counts.rows[0], status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export { router as kindredPerksRouter };
