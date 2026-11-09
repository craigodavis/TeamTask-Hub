import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { capabilitiesForRole } from '../lib/capabilities.js';

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

// The four role guards that used to live here -- requireManager, requireGControl,
// requireInventoryAccess, requireScheduleAccess -- are GONE. Every route they
// guarded now checks a capability.
//
// They are deleted rather than left unused on purpose. Private Events was built
// after the conversion and reached for `requireManager` on all 38 of its routes
// simply because the function was still exported and looked like the house
// style. An unused export is an invitation. `scripts/audit-apps.mjs` now fails
// if one comes back.
//
// requireOwner stays: it is a real, separate thing (103 call sites) and is not a
// legacy role check waiting to be converted.

/**
 * Gate a route on a capability.
 *
 * Holding the grant IS the answer. There is nothing else.
 *
 * Until 9 Nov 2026 this had a second branch: failing the grant, the person's old
 * role was consulted and, if it would have allowed the request, it proceeded and
 * the hit was logged. That made the conversion safe -- no route could lock
 * anyone out as it was converted -- but it also meant a manager's 37 of 39
 * capabilities could not be taken away. The screen granted honestly and revoked
 * theatrically.
 *
 * The fallback is gone, and it took nothing with it: migration 825 first wrote
 * every person's EFFECTIVE access into real grants, so for all 22 people what
 * they hold is what they could already reach. Verified per user before the
 * branch was removed, not after.
 *
 * `capability_fallback_hits` is kept as a record of what it caught -- two rows,
 * both Elaine on users.assist, September 2026 -- but nothing writes to it now.
 *
 * See docs/PERMISSIONS.md.
 */
export function requireCapability(capability) {
  return function capabilityGate(req, res, next) {
    if (req.capabilities?.has(capability)) return next();
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
