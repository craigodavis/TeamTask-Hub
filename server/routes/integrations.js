import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import twilio from 'twilio';

const router = express.Router();
const companyId = (req) => req.companyId;

// Placeholder password hash for Square-synced users (they must use "Forgot password" to set one).
const SQUARE_PLACEHOLDER_PASSWORD_HASH = bcrypt.hashSync('square-sync-no-password', 10);

async function getCompanyIntegrations(cId) {
  const r = await query(
    `SELECT square_application_id, square_access_token, square_env, twilio_account_sid, twilio_auth_token, twilio_phone_number
     FROM company_integrations WHERE company_id = $1`,
    [cId]
  );
  return r.rows[0] || null;
}

// ---------- Square: fetch team members only (manager); no DB insert/update ----------
router.post('/square/sync', async (req, res) => {
  try {
    const cId = companyId(req);
    const integrations = await getCompanyIntegrations(cId);
    const token = (integrations?.square_access_token && integrations.square_access_token.trim())
      ? integrations.square_access_token
      : process.env.SQUARE_ACCESS_TOKEN;
    if (!token) return res.status(503).json({ error: 'Square not configured. Owner can set API keys in Settings.' });
    const squareEnv = integrations?.square_env || process.env.SQUARE_ENV || 'production';
    const squareBase = squareEnv === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
    const teamMembers = [];
    let cursor = null;
    do {
      const body = { query: { filter: { status: 'ACTIVE' } }, limit: 200 };
      if (cursor) body.cursor = cursor;
      const response = await fetch(
        `${squareBase}/v2/team-members/search`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Square-Version': '2024-01-18',
          },
          body: JSON.stringify(body),
        }
      );
      if (!response.ok) {
        const err = await response.text();
        return res.status(response.status).json({ error: 'Square API error', details: err });
      }
      const data = await response.json();
      const batch = data.team_members || [];
      teamMembers.push(...batch);
      cursor = data.cursor || null;
    } while (cursor);

    const result = [];
    for (const tm of teamMembers) {
      const email = tm.email_address || (tm.given_name?.toLowerCase().replace(/\s/g, '.') + '@square.sync');
      const squareId = tm.id;
      const existing = await query(
        `SELECT id, role FROM users WHERE company_id = $1 AND (square_team_member_id = $2 OR email = $3)`,
        [cId, squareId, email]
      );
      const row = existing.rows[0];
      result.push({
        id: tm.id,
        email_address: tm.email_address || null,
        given_name: tm.given_name || null,
        family_name: tm.family_name || null,
        phone_number: tm.phone_number || null,
        already_in_system: !!row,
        role: row?.role || null,
      });
    }
    res.json({ team_members: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Square: add selected team members to users table (manager) ----------
router.post('/square/add-users', async (req, res) => {
  try {
    const { users } = req.body;
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: 'users array required' });
    }
    const cId = companyId(req);
    let added = 0;
    let skipped = 0;
    for (const u of users) {
      const role = (u.role === 'manager' ? 'manager' : 'member');
      const rawEmail = (u.email_address && String(u.email_address).trim()) || '';
      const fallbackEmail = (u.given_name && String(u.given_name).trim())
        ? String(u.given_name).toLowerCase().replace(/\s+/g, '.') + '@square.sync'
        : null;
      const email = rawEmail || fallbackEmail;
      if (!email) {
        skipped++;
        continue;
      }
      const displayName = [u.given_name, u.family_name].filter(Boolean).map(String).join(' ').trim() || email;
      const phone = (u.phone_number && String(u.phone_number).trim()) || null;
      const squareId = u.id && String(u.id).trim() ? u.id : null;
      if (!squareId) {
        skipped++;
        continue;
      }
      const existing = await query(
        `SELECT id FROM users WHERE company_id = $1 AND (square_team_member_id = $2 OR email = $3)`,
        [cId, squareId, email.toLowerCase()]
      );
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }
      try {
        await query(
          `INSERT INTO users (company_id, email, password_hash, display_name, role, square_team_member_id, phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [cId, email.toLowerCase(), SQUARE_PLACEHOLDER_PASSWORD_HASH, displayName, role, squareId, phone]
        );
        added++;
      } catch (insertErr) {
        if (insertErr.code === '23505') {
          skipped++;
          continue;
        }
        throw insertErr;
      }
    }
    res.json({ added, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Square: sync-users — update existing when phone changed (name/phone only), remove users no longer in Square ----------
router.post('/square/sync-users', async (req, res) => {
  try {
    const cId = companyId(req);
    const integrations = await getCompanyIntegrations(cId);
    const token = (integrations?.square_access_token && integrations.square_access_token.trim())
      ? integrations.square_access_token
      : process.env.SQUARE_ACCESS_TOKEN;
    if (!token) return res.status(503).json({ error: 'Square not configured. Owner can set API keys in Settings.' });
    const squareEnv = integrations?.square_env || process.env.SQUARE_ENV || 'production';
    const squareBase = squareEnv === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
    const teamMembers = [];
    let cursor = null;
    do {
      const body = { query: { filter: { status: 'ACTIVE' } }, limit: 200 };
      if (cursor) body.cursor = cursor;
      const response = await fetch(
        `${squareBase}/v2/team-members/search`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Square-Version': '2024-01-18',
          },
          body: JSON.stringify(body),
        }
      );
      if (!response.ok) {
        const err = await response.text();
        return res.status(response.status).json({ error: 'Square API error', details: err });
      }
      const data = await response.json();
      const batch = data.team_members || [];
      teamMembers.push(...batch);
      cursor = data.cursor || null;
    } while (cursor);

    const currentSquareIds = teamMembers.map((tm) => tm.id).filter(Boolean);
    let updated = 0;
    let skipped = 0;

    const norm = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

    for (const tm of teamMembers) {
      const email = tm.email_address || (tm.given_name?.toLowerCase().replace(/\s/g, '.') + '@square.sync');
      const squareId = tm.id;
      const displayName = [tm.given_name, tm.family_name].filter(Boolean).join(' ') || email;
      const squarePhone = norm(tm.phone_number);

      const existing = await query(
        `SELECT id, phone FROM users WHERE company_id = $1 AND (square_team_member_id = $2 OR email = $3)`,
        [cId, squareId, email]
      );
      const row = existing.rows[0];
      if (!row) continue;

      const dbPhone = norm(row.phone);
      if (dbPhone === squarePhone) {
        skipped++;
        continue;
      }
      await query(
        `UPDATE users SET display_name = $2, phone = $3, square_team_member_id = $4, updated_at = NOW() WHERE id = $1`,
        [row.id, displayName, tm.phone_number || null, squareId]
      );
      updated++;
    }

    let removed = 0;
    if (currentSquareIds.length > 0) {
      const del = await query(
        `DELETE FROM users WHERE company_id = $1 AND square_team_member_id IS NOT NULL AND square_team_member_id != ALL($2::text[]) AND id != $3 RETURNING id`,
        [cId, currentSquareIds, req.userId]
      );
      removed = del.rowCount || 0;
    } else {
      const del = await query(
        `DELETE FROM users WHERE company_id = $1 AND square_team_member_id IS NOT NULL AND id != $2 RETURNING id`,
        [cId, req.userId]
      );
      removed = del.rowCount || 0;
    }

    res.json({ updated, skipped, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Twilio: send SMS to selected team members (manager); log to sms_log ----------
router.post('/twilio/send', async (req, res) => {
  try {
    const { user_ids, message_body } = req.body;
    if (!message_body || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: 'user_ids array and message_body required' });
    }
    const cId = companyId(req);
    const integrations = await getCompanyIntegrations(cId);
    const accountSid = (integrations?.twilio_account_sid && integrations.twilio_account_sid.trim())
      ? integrations.twilio_account_sid
      : process.env.TWILIO_ACCOUNT_SID;
    const authToken = (integrations?.twilio_auth_token && integrations.twilio_auth_token.trim())
      ? integrations.twilio_auth_token
      : process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = (integrations?.twilio_phone_number && integrations.twilio_phone_number.trim())
      ? integrations.twilio_phone_number
      : process.env.TWILIO_PHONE_NUMBER;
    if (!accountSid || !authToken || !fromNumber) {
      return res.status(503).json({ error: 'Twilio not configured. Owner can set API keys in Settings.' });
    }
    const client = twilio(accountSid, authToken);
    const usersResult = await query(
      `SELECT id, phone, display_name, email FROM users WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [cId, user_ids]
    );
    const sent = [];
    const failed = [];
    for (const u of usersResult.rows) {
      const to = u.phone || null;
      if (!to) {
        failed.push({ user_id: u.id, reason: 'No phone number' });
        continue;
      }
      try {
        const msg = await client.messages.create({
          body: message_body,
          from: fromNumber,
          to: to,
        });
        await query(
          `INSERT INTO sms_log (company_id, sent_by, recipient_user_id, recipient_phone, message_body, twilio_message_sid, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [cId, req.userId, u.id, to, message_body, msg.sid, msg.status || 'sent']
        );
        sent.push({ user_id: u.id, sid: msg.sid });
      } catch (twilioErr) {
        await query(
          `INSERT INTO sms_log (company_id, sent_by, recipient_user_id, recipient_phone, message_body, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [cId, req.userId, u.id, to, message_body, 'failed']
        );
        failed.push({ user_id: u.id, reason: twilioErr.message });
      }
    }
    res.json({ sent: sent.length, failed: failed.length, sent_ids: sent, failed_details: failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List SMS log (manager)
router.get('/sms-log', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const r = await query(
      `SELECT s.id, s.company_id, s.sent_by, s.recipient_user_id, s.recipient_phone, s.message_body,
              s.twilio_message_sid, s.status, s.created_at,
              u.display_name as recipient_name
       FROM sms_log s
       LEFT JOIN users u ON u.id = s.recipient_user_id
       WHERE s.company_id = $1 ORDER BY s.created_at DESC LIMIT $2`,
      [companyId(req), Math.min(parseInt(limit, 10) || 50, 200)]
    );
    res.json({ log: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as integrationsRouter };
