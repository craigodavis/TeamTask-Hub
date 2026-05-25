/**
 * Shared SMS helper.
 * Sends a message to a list of users (by user ID), logs each send to sms_log.
 *
 * Usage:
 *   import { sendSmsToUsers } from '../lib/smsHelper.js';
 *   await sendSmsToUsers(companyId, [userId1, userId2], 'Your message', sentByUserId);
 *
 * Returns { sent: number, failed: number, results: [] }
 * Never throws — errors are logged and returned in results.
 */
import twilio from 'twilio';
import { query } from '../db.js';

/**
 * Fetch Twilio credentials for a company (DB first, env fallback).
 */
async function getTwilioConfig(companyId) {
  const r = await query(
    `SELECT twilio_account_sid, twilio_auth_token, twilio_phone_number
     FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const row = r.rows[0];
  const accountSid   = row?.twilio_account_sid?.trim()   || process.env.TWILIO_ACCOUNT_SID;
  const authToken    = row?.twilio_auth_token?.trim()    || process.env.TWILIO_AUTH_TOKEN;
  const fromNumber   = row?.twilio_phone_number?.trim()  || process.env.TWILIO_PHONE_NUMBER;
  return { accountSid, authToken, fromNumber };
}

/**
 * Send `message` to all users in `userIds`.
 *
 * @param {string}   companyId     - UUID
 * @param {string[]} userIds       - UUID array of TeamHub user IDs
 * @param {string}   message       - SMS body text
 * @param {string}   sentByUserId  - UUID of user who triggered the send (for sms_log)
 * @returns {Promise<{sent:number, failed:number, results:Array}>}
 */
export async function sendSmsToUsers(companyId, userIds, message, sentByUserId) {
  if (!userIds || userIds.length === 0) return { sent: 0, failed: 0, results: [] };

  const { accountSid, authToken, fromNumber } = await getTwilioConfig(companyId);
  if (!accountSid || !authToken || !fromNumber) {
    console.warn(`[smsHelper] Twilio not configured for company ${companyId} — skipping SMS`);
    return { sent: 0, failed: 0, results: [{ skipped: true, reason: 'Twilio not configured' }] };
  }

  const client = twilio(accountSid, authToken);

  const usersResult = await query(
    `SELECT id, phone, display_name FROM users WHERE company_id = $1 AND id = ANY($2::uuid[])`,
    [companyId, userIds]
  );

  const results = [];
  let sent = 0;
  let failed = 0;

  for (const u of usersResult.rows) {
    const to = u.phone?.trim() || null;
    if (!to) {
      failed++;
      results.push({ user_id: u.id, ok: false, reason: 'No phone number' });
      continue;
    }
    try {
      const msg = await client.messages.create({ body: message, from: fromNumber, to });
      await query(
        `INSERT INTO sms_log (company_id, sent_by, recipient_user_id, recipient_phone, message_body, twilio_message_sid, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [companyId, sentByUserId, u.id, to, message, msg.sid, msg.status || 'sent']
      );
      sent++;
      results.push({ user_id: u.id, ok: true, sid: msg.sid });
    } catch (err) {
      await query(
        `INSERT INTO sms_log (company_id, sent_by, recipient_user_id, recipient_phone, message_body, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [companyId, sentByUserId, u.id, to, message, 'failed']
      ).catch(() => {});
      failed++;
      results.push({ user_id: u.id, ok: false, reason: err.message });
    }
  }

  return { sent, failed, results };
}
