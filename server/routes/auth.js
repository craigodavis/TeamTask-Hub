import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { requireAuth, requireManager } from '../middleware/auth.js';

const router = express.Router();

async function sendMailIfConfigured(opts, companyId) {
  try {
    const { sendMail } = await import('../mail.js');
    return await sendMail(opts, companyId);
  } catch (err) {
    return { sent: false, error: err.message };
  }
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:5173';
const RESET_EXPIRY_HOURS = 1;

router.post('/register', async (req, res) => {
  try {
    const { company_id, email, password, display_name, role } = req.body;
    if (!company_id || !email || !password) {
      return res.status(400).json({ error: 'company_id, email, and password required' });
    }
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      `INSERT INTO users (company_id, email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'member'))
       RETURNING id, company_id, email, display_name, role, created_at`,
      [company_id, email.toLowerCase(), hash, display_name || null, role || 'member']
    );
    const user = r.rows[0];
    const token = jwt.sign(
      { userId: user.id, companyId: user.company_id, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.status(201).json({ user: { id: user.id, company_id: user.company_id, email: user.email, display_name: user.display_name, role: user.role }, token });
  } catch (err) {
    console.error('Register error:', err?.message || err);
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists for this company' });
    const msg = (err.message && String(err.message).trim()) || err.code || 'Registration failed';
    const body = { error: msg };
    if (err.code) body.code = err.code; // e.g. 42703 = undefined_column
    res.status(500).json(body);
  }
});

router.post('/login', async (req, res) => {
  console.log('Login attempt:', req.body?.email || '(no email)');
  try {
    const { email, password, company_slug } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }
    let q = `SELECT u.id, u.company_id, u.email, u.display_name, u.role, u.password_hash, c.slug as company_slug
             FROM users u JOIN companies c ON c.id = u.company_id
             WHERE u.email = $1`;
    const params = [email.toLowerCase()];
    if (company_slug) {
      q += ` AND c.slug = $2`;
      params.push(company_slug);
    }
    q += ` LIMIT 1`;
    const r = await query(q, params);
    const row = r.rows[0];
    if (!row) {
      console.log('Login: no user found for email', email.toLowerCase());
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!row.password_hash) {
      console.log('Login: user has no password_hash', row.id);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      console.log('Login: password mismatch for', row.email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign(
      { userId: row.id, companyId: row.company_id, role: row.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      user: { id: row.id, company_id: row.company_id, email: row.email, display_name: row.display_name, role: row.role, company_slug: row.company_slug },
      token,
    });
  } catch (err) {
    console.error('Login error:', err.message || err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const r = await query(
      `SELECT u.id, u.company_id, u.email, u.display_name, u.role, u.phone, c.name as company_name, c.slug as company_slug
       FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1`,
      [payload.userId]
    );
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ user: { id: user.id, company_id: user.company_id, email: user.email, display_name: user.display_name, role: user.role, phone: user.phone, company_name: user.company_name, company_slug: user.company_slug } });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// Forgot password: email + optional company_slug → create token, send reset link
router.post('/forgot-password', async (req, res) => {
  try {
    const { email, company_slug } = req.body;
    if (!email || !String(email).trim()) {
      return res.status(400).json({ error: 'email required' });
    }
    let q = `SELECT u.id, u.email, u.company_id, c.slug FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = $1`;
    const params = [String(email).toLowerCase().trim()];
    if (company_slug) {
      q += ` AND c.slug = $2`;
      params.push(company_slug);
    }
    q += ` LIMIT 1`;
    const r = await query(q, params);
    const row = r.rows[0];
    if (!row) {
      return res.json({ ok: true, message: 'If that email exists, we sent a reset link.' });
    }
    const expiresAt = new Date(Date.now() + RESET_EXPIRY_HOURS * 60 * 60 * 1000);
    const tokenRow = await query(
      `INSERT INTO password_reset_tokens (user_id, expires_at) VALUES ($1, $2) RETURNING token`,
      [row.id, expiresAt]
    );
    const token = tokenRow.rows[0].token;
    const resetUrl = `${APP_BASE_URL}/reset-password?token=${token}`;
    const result = await sendMailIfConfigured({
      to: row.email,
      subject: 'Reset your password',
      text: `Use this link to set a new password (valid for ${RESET_EXPIRY_HOURS} hour): ${resetUrl}`,
      html: `<p>Use this link to set a new password (valid for ${RESET_EXPIRY_HOURS} hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
    }, row.company_id);
    if (!result.sent) {
      return res.status(503).json({ error: 'Email not configured or failed to send', details: result.error });
    }
    res.json({ ok: true, message: 'If that email exists, we sent a reset link.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset password: token + new_password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password || String(new_password).trim().length < 6) {
      return res.status(400).json({ error: 'token and new_password (min 6 chars) required' });
    }
    const t = await query(
      `SELECT prt.user_id FROM password_reset_tokens prt WHERE prt.token = $1 AND prt.expires_at > NOW()`,
      [token]
    );
    if (t.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }
    const userId = t.rows[0].user_id;
    const hash = await bcrypt.hash(String(new_password).trim(), 10);
    await query(`UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, [userId, hash]);
    await query(`DELETE FROM password_reset_tokens WHERE token = $1`, [token]);
    res.json({ ok: true, message: 'Password updated. You can log in now.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager/owner: send password reset email to a user in their company
router.post('/send-reset-email', requireAuth, requireManager, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const target = await query(
      `SELECT u.id, u.email FROM users u WHERE u.id = $1 AND u.company_id = $2`,
      [user_id, req.companyId]
    );
    if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const row = target.rows[0];
    const expiresAt = new Date(Date.now() + RESET_EXPIRY_HOURS * 60 * 60 * 1000);
    const tokenRow = await query(
      `INSERT INTO password_reset_tokens (user_id, expires_at) VALUES ($1, $2) RETURNING token`,
      [row.id, expiresAt]
    );
    const token = tokenRow.rows[0].token;
    const resetUrl = `${APP_BASE_URL}/reset-password?token=${token}`;
    const result = await sendMailIfConfigured({
      to: row.email,
      subject: 'Reset your password',
      text: `Use this link to set a new password (valid for ${RESET_EXPIRY_HOURS} hour): ${resetUrl}`,
      html: `<p>Use this link to set a new password (valid for ${RESET_EXPIRY_HOURS} hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
    }, req.companyId);
    if (!result.sent) {
      return res.status(503).json({ error: 'Email not configured or failed to send', details: result.error });
    }
    res.json({ ok: true, message: 'Reset link sent to user email.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as authRouter };
