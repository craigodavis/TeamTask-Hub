/**
 * TeamHub Gateway — universal proxy for QBO, Square, and Commerce7.
 *
 * POST   /api/gateway/submit        — submit an action (creates pending or executes immediately)
 * GET    /api/gateway/queue         — list pending_approval actions
 * GET    /api/gateway/log           — list completed/failed/rejected actions
 * POST   /api/gateway/:id/approve   — approve a pending action
 * POST   /api/gateway/:id/reject    — reject a pending action
 * GET    /api/gateway/rules         — list approval rules
 * POST   /api/gateway/rules         — create a rule
 * PATCH  /api/gateway/rules/:id     — update a rule
 * DELETE /api/gateway/rules/:id     — delete a rule
 */

import { Router } from 'express';
import { query } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { loadRules, evaluateRules } from '../lib/gatewayRules.js';
import { executeGatewayAction } from '../lib/gatewayExecutor.js';

export const gatewayRouter = Router();

const cid = (req) => req.companyId;

// Helper: build a human-readable label for the requester
function buildLabel(req) {
  if (req.isServiceToken) {
    // Service token name stored in req.serviceTokenName if set by auth middleware
    return req.serviceTokenName ? `token:${req.serviceTokenName}` : `token:${req.serviceTokenId}`;
  }
  return req.user?.display_name || req.user?.email || `user:${req.userId}`;
}

// ── Submit ────────────────────────────────────────────────────────────────────

gatewayRouter.post('/submit', async (req, res) => {
  const { service, operation, payload = {} } = req.body;

  if (!service || !operation) {
    return res.status(400).json({ error: 'service and operation are required' });
  }
  if (!['qbo', 'square', 'commerce7'].includes(service)) {
    return res.status(400).json({ error: `Unknown service "${service}"` });
  }

  try {
    const rules  = await loadRules(cid(req));
    const { requireApproval, autoApproveMinutes } = evaluateRules(rules, { service, operation });

    // Compute auto_approve_at timestamp
    let autoApproveAt = null;
    if (requireApproval && autoApproveMinutes != null) {
      autoApproveAt = autoApproveMinutes === 0
        ? new Date()   // immediate — will be picked up right after insert
        : new Date(Date.now() + autoApproveMinutes * 60_000);
    }

    const label = buildLabel(req);

    const { rows } = await query(
      `INSERT INTO gateway_actions
         (company_id, submitted_by_user, submitted_by_token, requested_by_label,
          service, operation, payload, status, auto_approve_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               CASE WHEN $8 THEN 'pending_approval' ELSE 'executing' END,
               $9)
       RETURNING *`,
      [
        cid(req),
        req.isServiceToken ? null   : (req.userId   || null),
        req.isServiceToken ? (req.serviceTokenId || null) : null,
        label,
        service,
        operation,
        JSON.stringify(payload),
        requireApproval,
        autoApproveAt,
      ]
    );
    const action = rows[0];

    // If no approval required (status = 'executing'), dispatch immediately
    if (!requireApproval) {
      try {
        await executeGatewayAction(action);
        // Reload to return the completed record
        const { rows: done } = await query('SELECT * FROM gateway_actions WHERE id = $1', [action.id]);
        return res.json({ action: done[0] });
      } catch (err) {
        const { rows: failed } = await query('SELECT * FROM gateway_actions WHERE id = $1', [action.id]);
        return res.status(502).json({ error: err.message, action: failed[0] });
      }
    }

    // If auto_approve_at = now (0 min), dispatch immediately in background
    if (autoApproveAt && autoApproveAt <= new Date()) {
      // Lock first
      const { rowCount } = await query(
        `UPDATE gateway_actions SET status = 'executing', updated_at = NOW()
         WHERE id = $1 AND status = 'pending_approval'`,
        [action.id]
      );
      if (rowCount > 0) {
        executeGatewayAction({ ...action, status: 'executing' }).catch((err) =>
          console.error('[gateway] immediate auto-approve error:', err.message)
        );
      }
    }

    res.status(202).json({ action });
  } catch (err) {
    console.error('[gateway] submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Queue (pending_approval) ─────────────────────────────────────────────────

gatewayRouter.get('/queue', requireCapability('gateway.use'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT ga.*,
              u.display_name  AS submitter_name,
              st.name         AS token_name
       FROM   gateway_actions ga
       LEFT JOIN users         u  ON u.id  = ga.submitted_by_user
       LEFT JOIN service_tokens st ON st.id = ga.submitted_by_token
       WHERE  ga.company_id = $1 AND ga.status = 'pending_approval'
       ORDER  BY ga.created_at DESC`,
      [cid(req)]
    );
    res.json({ queue: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Log (completed / failed / rejected) ──────────────────────────────────────

gatewayRouter.get('/log', requireCapability('gateway.use'), async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 500);
  const offset = parseInt(req.query.offset || '0', 10);
  const { service, status } = req.query;

  try {
    const conditions = ['ga.company_id = $1'];
    const params = [cid(req)];
    let p = 2;

    if (service) { conditions.push(`ga.service = $${p++}`); params.push(service); }
    if (status)  { conditions.push(`ga.status  = $${p++}`); params.push(status);  }

    const where = conditions.join(' AND ');
    const { rows } = await query(
      `SELECT ga.*,
              u.display_name   AS submitter_name,
              st.name          AS token_name,
              au.display_name  AS approver_name,
              ru.display_name  AS rejector_name
       FROM   gateway_actions ga
       LEFT JOIN users         u  ON u.id  = ga.submitted_by_user
       LEFT JOIN service_tokens st ON st.id = ga.submitted_by_token
       LEFT JOIN users         au ON au.id = ga.approved_by
       LEFT JOIN users         ru ON ru.id = ga.rejected_by
       WHERE  ${where}
       ORDER  BY ga.created_at DESC
       LIMIT  $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );
    res.json({ log: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Approve ───────────────────────────────────────────────────────────────────

gatewayRouter.post('/:id/approve', requireCapability('gateway.use'), async (req, res) => {
  try {
    // Optimistic lock: only transition from pending_approval
    const { rows, rowCount } = await query(
      `UPDATE gateway_actions
       SET    status = 'executing', approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE  id = $1 AND company_id = $3 AND status = 'pending_approval'
       RETURNING *`,
      [req.params.id, req.userId, cid(req)]
    );
    if (rowCount === 0) {
      return res.status(409).json({ error: 'Action not found or no longer pending' });
    }

    const action = rows[0];

    // Execute asynchronously and respond immediately so UI isn't blocked
    res.json({ message: 'Approved — executing', action });

    executeGatewayAction(action).catch((err) =>
      console.error('[gateway] approved execution error:', err.message)
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reject ────────────────────────────────────────────────────────────────────

gatewayRouter.post('/:id/reject', requireCapability('gateway.use'), async (req, res) => {
  const { note } = req.body;
  try {
    const { rows, rowCount } = await query(
      `UPDATE gateway_actions
       SET    status = 'rejected', rejected_by = $2, rejected_at = NOW(),
              rejection_note = $3, updated_at = NOW()
       WHERE  id = $1 AND company_id = $4 AND status = 'pending_approval'
       RETURNING *`,
      [req.params.id, req.userId, note || null, cid(req)]
    );
    if (rowCount === 0) {
      return res.status(409).json({ error: 'Action not found or no longer pending' });
    }
    res.json({ action: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rules CRUD ────────────────────────────────────────────────────────────────

gatewayRouter.get('/rules', requireCapability('gateway.use'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM gateway_approval_rules WHERE company_id = $1 ORDER BY priority ASC`,
      [cid(req)]
    );
    res.json({ rules: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

gatewayRouter.post('/rules', requireCapability('gateway.use'), async (req, res) => {
  const { name, service_pattern, operation_pattern, require_approval,
          auto_approve_minutes, priority, enabled } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const { rows } = await query(
      `INSERT INTO gateway_approval_rules
         (company_id, name, service_pattern, operation_pattern,
          require_approval, auto_approve_minutes, priority, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        cid(req), name,
        service_pattern   || null,
        operation_pattern || null,
        require_approval  ?? true,
        auto_approve_minutes ?? null,
        priority ?? 100,
        enabled  ?? true,
      ]
    );
    res.status(201).json({ rule: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

gatewayRouter.patch('/rules/:id', requireCapability('gateway.use'), async (req, res) => {
  const allowed = ['name','service_pattern','operation_pattern','require_approval',
                   'auto_approve_minutes','priority','enabled'];
  const sets = [];
  const params = [req.params.id, cid(req)];
  let p = 3;

  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      sets.push(`${k} = $${p++}`);
      params.push(req.body[k]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push(`updated_at = NOW()`);

  try {
    const { rows, rowCount } = await query(
      `UPDATE gateway_approval_rules SET ${sets.join(', ')}
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ rule: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

gatewayRouter.delete('/rules/:id', requireCapability('gateway.use'), async (req, res) => {
  try {
    const { rowCount } = await query(
      `DELETE FROM gateway_approval_rules WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
