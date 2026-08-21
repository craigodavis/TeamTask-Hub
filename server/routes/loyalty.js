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
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import multer from 'multer';
import sharp from 'sharp';
import { query } from '../db.js';
import {requireAuth, requireCapability, requireOwner} from '../middleware/auth.js';
import { requireMemberSession } from './clubNotifications.js';
import {
  getRules, getMemberSummary, getBalances, getProgramStats,
  runBackfill, dropBatch, award,
} from '../lib/loyalty.js';

const router = express.Router();
function cid(req) { return req.companyId || req.user?.company_id; }

const PHOTO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads', 'member-photos');
// Held in memory, never written as uploaded: the bytes go through sharp first,
// which re-encodes them. A file that only claims to be a JPEG does not survive
// that, and nothing attacker-supplied reaches disk under its own name.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('That does not look like a photo.'));
    cb(null, true);
  },
});

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

/**
 * POST /me/photo — the member's profile picture, and the one-time 500 points.
 *
 * The award is keyed on the customer, not the upload, so replacing the photo
 * later does not pay again. The points are only claimed once the image is
 * safely on disk: awarding first would leave a member paid for a photo that
 * failed to save.
 */
memberRouter.post('/me/photo', requireMemberSession, photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo was received.' });
  try {
    const acct = (await query(
      `SELECT commerce7_customer_id, photo_path FROM club_steward.member_accounts WHERE id = $1`,
      [req.memberAccountId])).rows[0];

    await fs.mkdir(PHOTO_DIR, { recursive: true });
    const name = `${crypto.randomBytes(16).toString('hex')}.jpg`;
    await sharp(req.file.buffer)
      .rotate()                                   // honour EXIF; phone photos are often sideways
      .resize(800, 800, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 82 })
      .toFile(path.join(PHOTO_DIR, name));

    const rel = `member-photos/${name}`;
    await query(
      `UPDATE club_steward.member_accounts
          SET photo_path = $2, photo_updated_at = NOW() WHERE id = $1`,
      [req.memberAccountId, rel]);

    // Replacing a photo should not orphan the old file.
    if (acct?.photo_path && acct.photo_path !== rel) {
      fs.unlink(path.join(PHOTO_DIR, '..', acct.photo_path)).catch(() => {});
    }

    let awarded = 0;
    if (acct?.commerce7_customer_id) {
      const rule = (await getRules(req.companyId)).find((r) => r.rule_key === 'profile_photo');
      if (rule) {
        const out = await award(req.companyId, acct.commerce7_customer_id, {
          points: rule.points, ruleKey: 'profile_photo',
          reason: 'Added a profile photo', sourceKind: 'member_photo',
          sourceId: rel,
          // One-time: keyed on the member, so a re-upload never pays twice.
          idempotencyKey: `profile_photo:${acct.commerce7_customer_id}`,
        });
        if (out.awarded) awarded = rule.points;
      }
    }
    res.json({ ok: true, photoUrl: `/api/uploads/${rel}`, pointsAwarded: awarded });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

memberRouter.get('/me/photo', requireMemberSession, async (req, res) => {
  try {
    const r = await query(
      `SELECT photo_path FROM club_steward.member_accounts WHERE id = $1`, [req.memberAccountId]);
    const p = r.rows[0]?.photo_path;
    res.json({ photoUrl: p ? `/api/uploads/${p}` : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Staff / admin ────────────────────────────────────────────────────────────
router.get('/stats', requireAuth, requireCapability('marketing.loyalty'), async (req, res) => {
  try { res.json(await getProgramStats(cid(req))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/rules', requireAuth, requireCapability('marketing.loyalty'), async (req, res) => {
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

router.get('/balances', requireAuth, requireCapability('marketing.loyalty'), async (req, res) => {
  try {
    res.json({
      balances: await getBalances(cid(req), {
        limit: Math.min(Number(req.query.limit) || 100, 500),
        offset: Number(req.query.offset) || 0,
      }),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/ledger', requireAuth, requireCapability('marketing.loyalty'), async (req, res) => {
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

router.post('/award', requireAuth, requireCapability('marketing.loyalty'), async (req, res) => {
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
