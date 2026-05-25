/**
 * Gateway approval-rule engine.
 *
 * Rules are stored in `gateway_approval_rules`, ordered by priority ASC.
 * The first matching rule wins.  If no rule matches the action defaults to
 * requiring manual approval with no auto-approve timer.
 */

import { query } from '../db.js';

// ── Glob matcher (no external dep) ───────────────────────────────────────────
// Supports * (any segment) and ** (any string including dots/slashes).
function globMatch(pattern, value) {
  if (!pattern || pattern === '*') return true;
  // Escape regex special chars except * which we handle
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // ** → match anything; * → match non-dot/slash segment
  const reStr = escaped
    .replace(/\*\*/g, '\x00')   // placeholder for **
    .replace(/\*/g, '[^./]+')   // * matches one segment
    .replace(/\x00/g, '.*');    // ** matches anything
  return new RegExp(`^${reStr}$`, 'i').test(value);
}

// ── Load rules for a company ─────────────────────────────────────────────────
export async function loadRules(companyId) {
  const { rows } = await query(
    `SELECT * FROM gateway_approval_rules
     WHERE company_id = $1 AND enabled = true
     ORDER BY priority ASC`,
    [companyId]
  );
  return rows;
}

/**
 * Evaluate rules against a proposed action.
 * Returns { requireApproval, autoApproveMinutes }.
 *
 * autoApproveMinutes = null  → never auto-approve (manual only)
 * autoApproveMinutes = 0     → auto-approve immediately (skip queue)
 * autoApproveMinutes > 0     → auto-approve after N minutes
 */
export function evaluateRules(rules, { service, operation }) {
  for (const rule of rules) {
    const serviceMatch    = globMatch(rule.service_pattern,   service);
    const operationMatch  = globMatch(rule.operation_pattern, operation);
    if (serviceMatch && operationMatch) {
      return {
        requireApproval:    rule.require_approval,
        autoApproveMinutes: rule.auto_approve_minutes ?? null,
      };
    }
  }
  // Default: require manual approval, no auto-approve
  return { requireApproval: true, autoApproveMinutes: null };
}

// ── Auto-approve scheduler ────────────────────────────────────────────────────
import { executeGatewayAction } from './gatewayExecutor.js';

async function runAutoApprove() {
  try {
    // Grab all actions whose timer has elapsed — mark executing atomically
    const { rows } = await query(
      `UPDATE gateway_actions
       SET    status = 'executing', updated_at = NOW()
       WHERE  status = 'pending_approval'
         AND  auto_approve_at IS NOT NULL
         AND  auto_approve_at <= NOW()
       RETURNING id, company_id, service, operation, payload`
    );

    for (const action of rows) {
      // Fire-and-forget; executor updates status on completion/failure
      executeGatewayAction(action).catch((err) =>
        console.error('[gateway-auto-approve] executor error for', action.id, err.message)
      );
    }

    if (rows.length) {
      console.log(`[gateway-auto-approve] dispatched ${rows.length} action(s)`);
    }
  } catch (err) {
    console.error('[gateway-auto-approve] scheduler error:', err.message);
  }
}

export function startGatewayAutoApproveScheduler() {
  // First tick after 30 s so server startup isn't blocked
  setTimeout(() => {
    runAutoApprove();
    setInterval(runAutoApprove, 60_000);
  }, 30_000);
  console.log('[gateway-auto-approve] scheduler started');
}
