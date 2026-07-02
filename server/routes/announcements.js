import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';
import { sendSmsToUsers } from '../lib/smsHelper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const annUploadsDir = path.join(__dirname, '..', 'uploads', 'announcements');
fs.mkdirSync(annUploadsDir, { recursive: true });

const imgStorage = multer.diskStorage({
  destination: annUploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const imgUpload = multer({
  storage: imgStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

const router = express.Router();
const cId = (req) => req.companyId;

// ─── helpers ─────────────────────────────────────────────────────────────────

async function getApprovals(announcementId) {
  const r = await query(
    `SELECT aa.id, aa.approver_id, aa.status, aa.comment, aa.responded_at, aa.created_at,
            u.display_name, u.email
     FROM announcement_approvals aa
     JOIN users u ON u.id = aa.approver_id
     WHERE aa.announcement_id = $1
     ORDER BY aa.created_at`,
    [announcementId]
  );
  return r.rows;
}

// Returns array of newly inserted approver IDs (excludes already-existing ones).
async function upsertApprovers(announcementId, approverIds, companyId) {
  if (!Array.isArray(approverIds) || approverIds.length === 0) return [];
  const valid = await query(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND company_id = $2`,
    [approverIds, companyId]
  );
  const validIds = valid.rows.map((r) => r.id);
  if (validIds.length === 0) return [];
  const newIds = [];
  for (const id of validIds) {
    const r = await query(
      `INSERT INTO announcement_approvals (announcement_id, approver_id)
       VALUES ($1, $2) ON CONFLICT (announcement_id, approver_id) DO NOTHING
       RETURNING approver_id`,
      [announcementId, id]
    );
    if (r.rows.length > 0) newIds.push(id);
  }
  return newIds;
}

// Send approval-request SMS to newly assigned approvers.
async function sendApprovalSms(companyId, newApproverIds, announcementTitle, sentByUserId) {
  if (!newApproverIds.length) return;
  const appUrl = process.env.APP_BASE_URL || 'https://team.kindredvineyards.com';
  const link = `${appUrl}/manage?tab=announcements`;
  // Get creator display name
  const creatorRes = await query(`SELECT display_name FROM users WHERE id = $1`, [sentByUserId]);
  const creator = creatorRes.rows[0]?.display_name || 'Someone';
  const message = `${creator} is requesting your approval for an announcement: "${announcementTitle}". Review & approve here: ${link}`;
  await sendSmsToUsers(companyId, newApproverIds, message, sentByUserId).catch((err) => {
    console.warn('[announcements] SMS send failed:', err.message);
  });
}

async function removeApprovers(announcementId, keepIds) {
  // Remove pending approvers that are NOT in the new list
  await query(
    `DELETE FROM announcement_approvals
     WHERE announcement_id = $1
       AND status = 'pending'
       AND NOT (approver_id = ANY($2::uuid[]))`,
    [announcementId, keepIds.length > 0 ? keepIds : ['00000000-0000-0000-0000-000000000000']]
  );
}

// ─── routes ──────────────────────────────────────────────────────────────────

// Upload image for announcements (managers only)
router.post('/upload-image', requireManager, imgUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/api/uploads/announcements/${req.file.filename}` });
});

// GET /active — published announcements visible today (members filtered by shift location)
router.get('/active', async (req, res) => {
  try {
    const { date } = req.query;
    const d = date || new Date().toISOString().slice(0, 10);
    const companyId = cId(req);
    const userId = req.userId;

    const userRes = await query(
      `SELECT role, square_team_member_id FROM users WHERE id = $1`,
      [userId]
    );
    const userRole = userRes.rows[0]?.role;
    const squareTmId = userRes.rows[0]?.square_team_member_id;

    let userLocationIds = null;

    if ((userRole === 'member' || userRole === 'gc') && squareTmId) {
      const tzRes = await query(`SELECT timezone FROM companies WHERE id = $1`, [companyId]);
      const tz = tzRes.rows[0]?.timezone || 'UTC';
      const shiftRes = await query(
        `SELECT l.id AS location_id
         FROM team_square.scheduled_shift ss
         JOIN locations l ON l.square_location_id = ss.pub_location_id AND l.company_id = $1
         WHERE ss.pub_team_member_id = $2
           AND ss.pub_is_deleted = false
           AND DATE(ss.pub_start_at AT TIME ZONE $3) = $4::date`,
        [companyId, squareTmId, tz, d]
      );
      const locIds = shiftRes.rows.map((r) => r.location_id).filter(Boolean);
      userLocationIds = locIds.length > 0 ? locIds : null;
    }

    const r = await query(
      `SELECT a.id, a.company_id, a.title, a.body, a.effective_from, a.effective_until,
              a.created_by, a.created_at, a.status, a.is_policy, a.policy_required,
              aa.acknowledged_at AS my_acknowledged_at,
              ps.signed_at AS my_signed_at
       FROM announcements a
       LEFT JOIN announcement_acknowledgments aa ON aa.announcement_id = a.id AND aa.user_id = $2
       LEFT JOIN policy_signatures ps ON ps.announcement_id = a.id AND ps.user_id = $2
       WHERE a.company_id = $1
         AND a.status = 'published'
         AND (
           (a.is_policy = true AND a.policy_required = true)
           OR (
             a.effective_from <= $3::date
             AND a.effective_until >= $3::date
           )
         )
         AND (
           $4::uuid[] IS NULL
           OR NOT EXISTS (SELECT 1 FROM announcement_locations al WHERE al.announcement_id = a.id)
           OR EXISTS (
             SELECT 1 FROM announcement_locations al
             WHERE al.announcement_id = a.id AND al.location_id = ANY($4::uuid[])
           )
         )
       ORDER BY a.created_at DESC`,
      [companyId, userId, d, userLocationIds]
    );
    const announcements = r.rows.map(({ my_acknowledged_at, my_signed_at, ...rest }) => ({
      ...rest,
      my_acknowledged_at: my_acknowledged_at || null,
      my_signed_at: my_signed_at || null,
    }));
    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /policies — all policy announcements for the company, with the current
// user's sign status. Backs the employee-facing Policies page. Visible to
// any authenticated employee, not just managers.
router.get('/policies', async (req, res) => {
  try {
    const companyId = cId(req);
    const totalRes = await query(`SELECT COUNT(*) AS cnt FROM users WHERE company_id = $1`, [companyId]);
    const totalEmployees = parseInt(totalRes.rows[0].cnt, 10);

    const r = await query(
      `SELECT a.id, a.company_id, a.title, a.body, a.effective_from, a.effective_until,
              a.created_by, a.created_at, a.status, a.is_policy, a.policy_required,
              ps.signed_at AS my_signed_at,
              (SELECT COUNT(*) FROM policy_signatures s WHERE s.announcement_id = a.id) AS signed_count
       FROM announcements a
       LEFT JOIN policy_signatures ps ON ps.announcement_id = a.id AND ps.user_id = $2
       WHERE a.company_id = $1 AND a.is_policy = true
       ORDER BY a.created_at DESC`,
      [companyId, req.userId]
    );
    const policies = r.rows.map(({ my_signed_at, signed_count, ...rest }) => ({
      ...rest,
      my_signed_at: my_signed_at || null,
      signed_count: parseInt(signed_count, 10),
      total_employees: totalEmployees,
    }));
    res.json({ policies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /pending-my-approval — announcements awaiting current user's approval
router.get('/pending-my-approval', async (req, res) => {
  try {
    const r = await query(
      `SELECT a.id, a.title, a.effective_from, a.effective_until, a.status,
              a.created_by, a.created_at, u.display_name AS created_by_name,
              aa.id AS approval_id, aa.status AS my_approval_status, aa.comment AS my_comment
       FROM announcement_approvals aa
       JOIN announcements a ON a.id = aa.announcement_id AND a.company_id = $1
       LEFT JOIN users u ON u.id = a.created_by
       WHERE aa.approver_id = $2
         AND aa.status = 'pending'
         AND a.status IN ('draft', 'pending_approval')
       ORDER BY a.created_at DESC`,
      [cId(req), req.userId]
    );
    res.json({ announcements: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET / — list all announcements (manager; includes approvals per item)
router.get('/', async (req, res) => {
  try {
    const { from, to } = req.query;
    let q = `SELECT a.id, a.company_id, a.title, a.body, a.effective_from, a.effective_until,
                    a.status, a.created_by, a.created_at, a.is_policy, a.policy_required,
                    u.display_name as created_by_name,
                    COALESCE(
                      (SELECT array_agg(al.location_id ORDER BY al.location_id)
                       FROM announcement_locations al WHERE al.announcement_id = a.id),
                      ARRAY[]::uuid[]
                    ) AS location_ids,
                    (SELECT COUNT(*) FROM policy_signatures ps WHERE ps.announcement_id = a.id) AS signed_count
             FROM announcements a
             LEFT JOIN users u ON u.id = a.created_by
             WHERE a.company_id = $1`;
    const params = [cId(req)];
    if (from) { q += ` AND a.effective_until >= $${params.length + 1}::date`; params.push(from); }
    if (to)   { q += ` AND a.effective_from  <= $${params.length + 1}::date`; params.push(to); }
    q += ` ORDER BY a.effective_from DESC, a.created_at DESC`;
    const r = await query(q, params);

    const totalRes = await query(`SELECT COUNT(*) AS cnt FROM users WHERE company_id = $1`, [cId(req)]);
    const totalEmployees = parseInt(totalRes.rows[0].cnt, 10);

    // Attach approvals
    const announcements = await Promise.all(
      r.rows.map(async (row) => ({
        ...row,
        location_ids: row.location_ids || [],
        approvals: await getApprovals(row.id),
        total_employees: totalEmployees,
      }))
    );
    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / — create announcement (manager)
router.post('/', requireManager, async (req, res) => {
  try {
    const { title, body, effective_from, effective_until, location_ids, approver_ids, status, is_policy } = req.body;
    if (!title || !effective_from || !effective_until) {
      return res.status(400).json({ error: 'title, effective_from, effective_until required' });
    }
    const locationIdList = Array.isArray(location_ids) ? location_ids.filter(Boolean) : [];
    if (locationIdList.length === 0) {
      return res.status(400).json({ error: 'At least one location is required for an announcement.' });
    }
    const companyId = cId(req);
    const hasApprovers = Array.isArray(approver_ids) && approver_ids.length > 0;
    // If approvers provided and no explicit status, default to 'draft' until published
    const resolvedStatus = status || (hasApprovers ? 'draft' : 'published');

    const r = await query(
      `INSERT INTO announcements (company_id, title, body, effective_from, effective_until, created_by, status, is_policy)
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8)
       RETURNING id, company_id, title, body, effective_from, effective_until, created_by, created_at, status, is_policy, policy_required`,
      [companyId, title, body || null, effective_from, effective_until, req.userId, resolvedStatus, !!is_policy]
    );
    const announcement = r.rows[0];

    // Locations
    const ids = Array.isArray(location_ids) ? location_ids.filter(Boolean) : [];
    if (ids.length > 0) {
      const valid = await query(
        `SELECT id FROM locations WHERE id = ANY($1::uuid[]) AND company_id = $2`,
        [ids, companyId]
      );
      for (const row of valid.rows) {
        await query(
          `INSERT INTO announcement_locations (announcement_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [announcement.id, row.id]
        );
      }
    }

    // Approvers — insert and notify new ones via SMS
    if (hasApprovers) {
      const newApproverIds = await upsertApprovers(announcement.id, approver_ids, companyId);
      sendApprovalSms(companyId, newApproverIds, announcement.title, req.userId);
    }

    const locAgg = await query(
      `SELECT array_agg(location_id ORDER BY location_id) AS location_ids
       FROM announcement_locations WHERE announcement_id = $1`,
      [announcement.id]
    );
    const approvals = await getApprovals(announcement.id);

    res.status(201).json({
      ...announcement,
      location_ids: locAgg.rows[0]?.location_ids || [],
      approvals,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /:id — edit announcement (manager)
router.patch('/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, body, effective_from, effective_until, location_ids, approver_ids, status, is_policy, policy_required } = req.body;
    const companyId = cId(req);

    const updates = [];
    const vals = [id, companyId];
    if (title !== undefined)          { updates.push(`title = $${vals.length + 1}`);          vals.push(title); }
    if (body !== undefined)           { updates.push(`body = $${vals.length + 1}`);            vals.push(body); }
    if (effective_from !== undefined) { updates.push(`effective_from = $${vals.length + 1}::date`); vals.push(effective_from); }
    if (effective_until !== undefined){ updates.push(`effective_until = $${vals.length + 1}::date`); vals.push(effective_until); }
    if (status !== undefined)         { updates.push(`status = $${vals.length + 1}`);          vals.push(status); }
    if (is_policy !== undefined)      { updates.push(`is_policy = $${vals.length + 1}`);       vals.push(!!is_policy); }
    if (policy_required !== undefined){ updates.push(`policy_required = $${vals.length + 1}`); vals.push(!!policy_required); }
    updates.push('updated_at = NOW()');

    if (updates.length > 1) { // more than just updated_at
      const r = await query(
        `UPDATE announcements SET ${updates.join(', ')} WHERE id = $1 AND company_id = $2
         RETURNING id, company_id, title, body, effective_from, effective_until, created_by, updated_at, status, is_policy, policy_required`,
        vals
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' });
    }

    const annRes = await query(
      `SELECT id, company_id, title, body, effective_from, effective_until, created_by, updated_at, status, is_policy, policy_required
       FROM announcements WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );
    if (annRes.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' });
    const announcement = annRes.rows[0];

    if (location_ids !== undefined) {
      await query(`DELETE FROM announcement_locations WHERE announcement_id = $1`, [id]);
      const ids = Array.isArray(location_ids) ? location_ids.filter(Boolean) : [];
      if (ids.length > 0) {
        const valid = await query(
          `SELECT id FROM locations WHERE id = ANY($1::uuid[]) AND company_id = $2`,
          [ids, companyId]
        );
        for (const row of valid.rows) {
          await query(
            `INSERT INTO announcement_locations (announcement_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, row.id]
          );
        }
      }
    }

    if (approver_ids !== undefined) {
      const ids = Array.isArray(approver_ids) ? approver_ids.filter(Boolean) : [];
      await removeApprovers(id, ids);
      if (ids.length > 0) {
        const newApproverIds = await upsertApprovers(id, ids, companyId);
        sendApprovalSms(companyId, newApproverIds, announcement.title, req.userId);
      }
    }

    const locAgg = await query(
      `SELECT array_agg(location_id ORDER BY location_id) AS location_ids
       FROM announcement_locations WHERE announcement_id = $1`,
      [id]
    );
    const approvals = await getApprovals(id);

    res.json({
      ...announcement,
      location_ids: locAgg.rows[0]?.location_ids || [],
      approvals,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/approve — approver submits approval/rejection with optional comment
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, comment } = req.body; // status: 'approved' | 'rejected'
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
    }

    // Check this user is an approver for this announcement (in this company)
    const check = await query(
      `SELECT aa.id FROM announcement_approvals aa
       JOIN announcements a ON a.id = aa.announcement_id AND a.company_id = $1
       WHERE aa.announcement_id = $2 AND aa.approver_id = $3`,
      [cId(req), id, req.userId]
    );
    if (check.rows.length === 0) {
      return res.status(403).json({ error: 'You are not an approver for this announcement' });
    }

    await query(
      `UPDATE announcement_approvals
       SET status = $1, comment = $2, responded_at = NOW()
       WHERE announcement_id = $3 AND approver_id = $4`,
      [status, comment || null, id, req.userId]
    );

    // If all approvers have responded (none pending), auto-advance status to 'pending_approval'
    // Actually keep it in draft — let originator decide when to publish
    // But if it was 'draft' and now has responses, move to 'pending_approval' so originator knows
    const pendingCount = await query(
      `SELECT COUNT(*) AS cnt FROM announcement_approvals
       WHERE announcement_id = $1 AND status = 'pending'`,
      [id]
    );
    if (parseInt(pendingCount.rows[0].cnt) === 0) {
      // All have responded — update announcement status to reflect this
      await query(
        `UPDATE announcements SET status = 'pending_approval', updated_at = NOW()
         WHERE id = $1 AND status = 'draft'`,
        [id]
      );
    }

    const approvals = await getApprovals(id);
    res.json({ success: true, approvals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/publish — originator or manager publishes (even without full approval)
router.post('/:id/publish', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `UPDATE announcements SET status = 'published', updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING id, status`,
      [id, cId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' });
    res.json({ success: true, status: 'published' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id
router.delete('/:id', requireManager, async (req, res) => {
  try {
    const r = await query(
      `DELETE FROM announcements WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, cId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/acknowledge — current user acknowledges
router.post('/:id/acknowledge', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `INSERT INTO announcement_acknowledgments (announcement_id, user_id)
       SELECT $1, $2 FROM announcements WHERE id = $1 AND company_id = $3
       ON CONFLICT (announcement_id, user_id) DO NOTHING
       RETURNING id, announcement_id, user_id, acknowledged_at`,
      [id, req.userId, cId(req)]
    );
    if (r.rows.length === 0) {
      const check = await query(
        `SELECT 1 FROM announcements WHERE id = $1 AND company_id = $2`,
        [id, cId(req)]
      );
      if (check.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' });
      const existing = await query(
        `SELECT id, acknowledged_at FROM announcement_acknowledgments
         WHERE announcement_id = $1 AND user_id = $2`,
        [id, req.userId]
      );
      return res.json(existing.rows[0] || { acknowledged: true });
    }
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/acknowledgments — who read (manager)
router.get('/:id/acknowledgments', requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT aa.id, aa.user_id, aa.acknowledged_at, u.display_name, u.email
       FROM announcement_acknowledgments aa
       JOIN users u ON u.id = aa.user_id
       JOIN announcements a ON a.id = aa.announcement_id AND a.company_id = $1
       WHERE aa.announcement_id = $2
       ORDER BY aa.acknowledged_at DESC`,
      [cId(req), req.params.id]
    );
    res.json({ acknowledgments: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/sign — current user signs a policy
router.post('/:id/sign', async (req, res) => {
  try {
    const { id } = req.params;
    const { signed_name } = req.body;
    if (!signed_name || !signed_name.trim()) {
      return res.status(400).json({ error: 'signed_name is required' });
    }
    const check = await query(
      `SELECT is_policy FROM announcements WHERE id = $1 AND company_id = $2`,
      [id, cId(req)]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' });
    if (!check.rows[0].is_policy) return res.status(400).json({ error: 'This announcement is not a policy' });

    const r = await query(
      `INSERT INTO policy_signatures (announcement_id, user_id, signed_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (announcement_id, user_id) DO UPDATE SET signed_name = EXCLUDED.signed_name, signed_at = NOW()
       RETURNING id, announcement_id, user_id, signed_name, signed_at`,
      [id, req.userId, signed_name.trim()]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/signatures — full company roster with sign status (visible to all employees)
router.get('/:id/signatures', async (req, res) => {
  try {
    const { id } = req.params;
    const check = await query(
      `SELECT 1 FROM announcements WHERE id = $1 AND company_id = $2`,
      [id, cId(req)]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' });

    const r = await query(
      `SELECT u.id AS user_id, u.display_name, u.email, ps.signed_at
       FROM users u
       LEFT JOIN policy_signatures ps ON ps.announcement_id = $1 AND ps.user_id = u.id
       WHERE u.company_id = $2
       ORDER BY (ps.signed_at IS NULL), u.display_name`,
      [id, cId(req)]
    );
    res.json({ signatures: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as announcementsRouter };
