import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { capabilitiesForRole, LEGACY_ROLE_GRANTS } from '../lib/capabilities.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Service token path: prefixed with thk_
  if (token.startsWith('thk_')) {
    try {
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      const r = await query(
        `SELECT id, company_id, role, name FROM service_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hash]
      );
      if (!r.rows.length) {
        return res.status(401).json({ error: 'Invalid or revoked service token' });
      }
      const st = r.rows[0];
      req.companyId = st.company_id;
      req.role = st.role;
      // Service tokens have no user row and so no grants. Deriving from the
      // token's role keeps them behaving exactly as before and keeps them out
      // of the fallback table, which is meant to record humans on real routes.
      req.capabilities = new Set(capabilitiesForRole(st.role));
      req.isServiceToken = true;
      req.serviceTokenId = st.id;
      req.serviceTokenName = st.name;
      // Update last_used_at without blocking the request
      query(`UPDATE service_tokens SET last_used_at = NOW() WHERE id = $1`, [st.id]).catch(() => {});
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'Auth error' });
    }
  }

  // JWT path: human user login
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.companyId = payload.companyId;

    // Read the role from the database, not from the token.
    //
    // Tokens last 90 days and carry the role they were minted with, so a role
    // change did not take effect until the user happened to log out — while
    // /api/auth/me reads the database, so the UI showed the new role and every
    // API call was still judged against the old one. Granting worked in the menu
    // and failed on the request; revoking left privileges live for up to 90 days.
    //
    // One indexed lookup per request. At this scale that is nothing next to
    // permissions being wrong.
    const r = await query(`SELECT role FROM users WHERE id = $1`, [payload.userId]);
    if (!r.rows.length) return res.status(401).json({ error: 'User not found' });
    req.role = r.rows[0].role;

    // Grants come from the same request, for the same reason the role does:
    // judged live, so revoking a capability takes effect now rather than
    // whenever the token happens to expire.
    const caps = await query(
      `SELECT capability FROM user_capabilities WHERE user_id = $1`,
      [payload.userId]
    );
    req.capabilities = new Set(caps.rows.map((x) => x.capability));

    // A "View as" token answers as its target in every respect -- same id, same
    // role, same grants -- so the app it renders is genuinely theirs. What it
    // does not get is the ability to change anything: see requireNotViewingAs.
    if (payload.viewAs?.by) {
      req.viewAsBy = payload.viewAs.by;
      // Enforced here rather than as its own middleware: every route reaches
      // this function, and mounting a separate guard on /api ran it BEFORE the
      // per-route requireAuth, so viewAsBy was not set yet and it waved
      // everything through. A read-only rule that silently passes is worse
      // than none.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return res.status(403).json({
          error: 'Viewing as another user is read-only. Exit the session to make changes.',
          viewing_as: true,
        });
      }
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Owner can do anything (all manager actions + owner-only). Manager can do manager actions only.
export function requireManager(req, res, next) {
  if (req.role === 'owner' || req.role === 'manager') return next();
  return res.status(403).json({ error: 'Manager access required' });
}

// Ground Control: accessible to gc (User + GControl), manager, and owner.
export function requireGControl(req, res, next) {
  if (req.role === 'gc' || req.role === 'manager' || req.role === 'owner') return next();
  return res.status(403).json({ error: 'Ground Control access required' });
}

// Wine Inventory: accessible to inventory (User + Inventory), manager, and owner.
export function requireInventoryAccess(req, res, next) {
  if (req.role === 'inventory' || req.role === 'manager' || req.role === 'owner') return next();
  return res.status(403).json({ error: 'Inventory access required' });
}

// Scheduling: accessible to schedule (Manager + Schedule), manager, and owner.
export function requireScheduleAccess(req, res, next) {
  if (req.role === 'schedule' || req.role === 'manager' || req.role === 'owner') return next();
  return res.status(403).json({ error: 'Scheduling access required' });
}

/**
 * Record that a request got through only because the old role allowed it.
 *
 * Deliberately loud. The danger with a fail-safe fallback is that it is silent,
 * nobody can prove it is dead, and it lives forever -- so every hit is written
 * down with the route that caused it. Aggregated, and never allowed to fail the
 * request it is describing.
 */
function recordFallbackHit(req, capability) {
  if (!req.userId) return; // service tokens derive their grants; nothing to learn
  const route = (req.baseUrl || '') + (req.route?.path || req.path || '');
  query(
    `INSERT INTO capability_fallback_hits (route, method, capability, role, user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (route, method, capability, user_id)
     DO UPDATE SET hits = capability_fallback_hits.hits + 1, last_seen = NOW()`,
    [route.slice(0, 200), req.method, capability, req.role, req.userId]
  ).catch(() => {});
}

/**
 * Gate a route on a capability.
 *
 * Holding the grant is the answer. Failing that, the person's old role is
 * consulted and, if it would have allowed this, the request proceeds and the
 * fallback is recorded -- so converting a route can never lock anyone out, and
 * anything still leaning on the old model is visible rather than assumed gone.
 *
 * See docs/PERMISSIONS.md for how the fallback gets retired.
 */
export function requireCapability(capability) {
  return function capabilityGate(req, res, next) {
    if (req.capabilities?.has(capability)) return next();

    if ((LEGACY_ROLE_GRANTS[req.role] || []).includes(capability)) {
      recordFallbackHit(req, capability);
      return next();
    }

    return res.status(403).json({ error: 'Not permitted' });
  };
}

export function requireOwner(req, res, next) {
  if (req.role === 'owner') return next();
  return res.status(403).json({ error: 'Owner access required' });
}

export async function getCurrentUser(userId) {
  const r = await query(
    `SELECT id, company_id, email, display_name, role, phone, square_team_member_id, created_at
     FROM users WHERE id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}
