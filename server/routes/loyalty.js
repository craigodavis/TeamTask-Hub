/**
 * Loyalty points.
 *
 *   GET   /api/kindred-app/me/loyalty     a member's own balance (member session)
 *   GET   /api/loyalty/stats              programme totals — the cost model
 *   GET   /api/loyalty/rules              earn rates
 *   PUT   /api/loyalty/rules/:key         change a rate
 *   GET   /api/loyalty/balances           balances by member
 *   GET   /api/loyalty/ledger             recent entries
 *   POST  /api/loyalty/backfill           award history that already happened
 *   DELETE /api/loyalty/batch/:batch      drop a backfill batch
 *   POST  /api/loyalty/award              hand-award to one member
 *
 * Members are keyed by Commerce7 customer id; an app account reaches its points
 * through member_accounts.commerce7_customer_id.
 */
import express from 'express';
import { query } from '../db.js';
import { requireAuth, requireManager, requireOwner } from '../middleware/auth.js';
import { requireMemberSession } from './clubNotifications.js';
import {
  getRules, getMemberSummary, getBalances, getProgramStats,
  runBackfill, dropBatch, award,
} from '../lib/loyalty.js';

const router = express.Router();
function cid(req) { return req.companyId || req.user?.company_id; }

// ── Member-facing ────────────────────────────────────────────────────────────
// Mounted under /api/kindred-app so it sits with the app's other member routes.
export const memberRouter = express.Router();

memberRouter.get('/me/loyalty', requireMemberSession, async (req, res) => {
  try {
    const acct = (await query(
      `SELECT commerce7_customer_id FROM club_steward.member_accounts WHERE id = $1`,
      [req.memberAccountId])).rows[0];

    // An account with no Commerce7 customer behind it has no history to show.
    // Return the earn rules anyway so the screen still explains the programme.
    if (!acct?.commerce7_customer_id) {
      return res.json({ balance: 0, rules: await getRules(req.companyId), history: [] });
    }
    res.json(await getMemberSummary(req.companyId, acct.commerce7_customer_id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Staff / admin ────────────────────────────────────────────────────────────
router.get('/stats', requireAuth, requireManager, async (req, res) => {
  try { res.json(await getProgramStats(cid(req))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/rules', requireAuth, requireManager, async (req, res) => {
  try { res.json({ rules: await getRules(cid(req), { includeInactive: true }) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/rules/:key', requireAuth, requireOwner, async (req, res) => {
  const { points, active, label, description } = req.body ?? {};
  try {
    const r = await query(
      `UPDATE loyalty_rules
          SET points      = COALESCE($3, points),
              active      = COALESCE($4, active),
              label       = COALESCE($5, label),
              description = COALESCE($6, description),
              updated_at  = NOW()
        WHERE company_id = $1 AND rule_key = $2
        RETURNING *`,
      [cid(req), req.params.key,
        Number.isInteger(points) ? points : null,
        typeof active === 'boolean' ? active : null,
        label ?? null, description ?? null]);
    if (!r.rows.length) return res.status(404).json({ error: 'No such rule.' });
    // Changing a rate never rewrites history — past entries keep the rate that
    // applied when they were earned.
    res.json({ ok: true, rule: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/balances', requireAuth, requireManager, async (req, res) => {
  try {
    res.json({
      balances: await getBalances(cid(req), {
        limit: Math.min(Number(req.query.limit) || 100, 500),
        offset: Number(req.query.offset) || 0,
      }),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/ledger', requireAuth, requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT l.id, l.customer_id, l.points, l.rule_key, l.reason, l.batch,
              l.occurred_at, m.first_name, m.last_name
         FROM loyalty_ledger l
         LEFT JOIN club_steward.club_members m ON m.id::text = l.customer_id::text
        WHERE l.company_id = $1
        ORDER BY l.occurred_at DESC, l.id DESC
        LIMIT $2`,
      [cid(req), Math.min(Number(req.query.limit) || 100, 500)]);
    res.json({ entries: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Awarding history in bulk is an owner action — it moves the programme's whole
// liability in one call.
router.post('/backfill', requireAuth, requireOwner, async (req, res) => {
  try {
    res.json(await runBackfill(cid(req), {
      months: Number(req.body?.months) || 12,
      batch: req.body?.batch || null,
      dryRun: req.body?.dryRun === true,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/batch/:batch', requireAuth, requireOwner, async (req, res) => {
  try { res.json(await dropBatch(cid(req), req.params.batch)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/award', requireAuth, requireManager, async (req, res) => {
  const { customerId, points, reason } = req.body ?? {};
  if (!customerId || !Number.isInteger(points) || points === 0) {
    return res.status(400).json({ error: 'customerId and a non-zero integer points are required.' });
  }
  try {
    // Hand-awards get a unique key so a double-submit from a form cannot double
    // the points, while still allowing a genuine second award later.
    const key = `manual:${req.userId}:${Date.now()}:${customerId}`;
    const out = await award(cid(req), customerId, {
      points, ruleKey: 'manual', reason: reason || 'Awarded by staff',
      sourceKind: 'manual', idempotencyKey: key, createdBy: req.userId,
    });
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export { router as loyaltyRouter };
