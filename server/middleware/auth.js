import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
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
