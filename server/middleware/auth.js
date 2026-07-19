import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';

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
    req.role = payload.role;
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
