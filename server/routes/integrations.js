import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import twilio from 'twilio';
import { executeSqlReadOnly, resolveParamsSnapshot } from './scheduledReportsHelper.js';
import { sendMail } from '../mail.js';

const router = express.Router();
const companyId = (req) => req.companyId;

// Placeholder password hash for Square-synced users (they must use "Forgot password" to set one).
const SQUARE_PLACEHOLDER_PASSWORD_HASH = bcrypt.hashSync('square-sync-no-password', 10);

const SQUARE_VERSION = '2025-05-21';
const DAY_IN_MS = 24 * 60 * 60 * 1000;

async function getCompanyTimezone(cId) {
  const r = await query(`SELECT timezone FROM companies WHERE id = $1`, [cId]);
  return r.rows[0]?.timezone || 'UTC';
}

async function getCompanyIntegrations(cId) {
  const r = await query(
    `SELECT square_application_id, square_access_token, square_env, twilio_account_sid, twilio_auth_token, twilio_phone_number
     FROM company_integrations WHERE company_id = $1`,
    [cId]
  );
  return r.rows[0] || null;
}

function getSquareConfig(integrations) {
  const token = (integrations?.square_access_token && integrations.square_access_token.trim())
    ? integrations.square_access_token
    : process.env.SQUARE_ACCESS_TOKEN;
  const squareEnv = integrations?.square_env || process.env.SQUARE_ENV || 'production';
  const squareBase = squareEnv === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  return { token, squareBase };
}

async function fetchActiveSquareTeamMembers(token, squareBase) {
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
          'Square-Version': SQUARE_VERSION,
        },
        body: JSON.stringify(body),
      }
    );
    if (!response.ok) {
      const err = await response.text();
      const e = new Error(err || 'Square API error');
      e.status = response.status;
      throw e;
    }
    const data = await response.json();
    const batch = data.team_members || [];
    teamMembers.push(...batch);
    cursor = data.cursor || null;
  } while (cursor);
  return teamMembers;
}

function normalizeSquareEmail(tm) {
  return tm.email_address || (tm.given_name?.toLowerCase().replace(/\s/g, '.') + '@square.sync');
}

function toDisplayName(tm, fallbackEmail) {
  return [tm.given_name, tm.family_name].filter(Boolean).join(' ') || fallbackEmail;
}

async function getExcludedSquareIds(cId) {
  const exclusions = await query(
    `SELECT square_team_member_id
     FROM square_user_exclusions
     WHERE company_id = $1`,
    [cId]
  );
  return new Set(exclusions.rows.map((row) => row.square_team_member_id));
}

async function runSquareAutoSyncForCompany(cId, actorUserId = null) {
  const integrations = await getCompanyIntegrations(cId);
  const { token, squareBase } = getSquareConfig(integrations);
  if (!token) return { company_id: cId, added: 0, updated: 0, skipped: 0, removed: 0, excluded: 0, disabled: true };

  const teamMembers = await fetchActiveSquareTeamMembers(token, squareBase);
  const excludedIds = await getExcludedSquareIds(cId);
  const allowedTeamMembers = teamMembers.filter((tm) => tm.id && !excludedIds.has(tm.id));
  const currentSquareIds = allowedTeamMembers.map((tm) => tm.id);

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const norm = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

  for (const tm of allowedTeamMembers) {
    const email = normalizeSquareEmail(tm);
    const squareId = tm.id;
    if (!email || !squareId) {
      skipped++;
      continue;
    }
    const displayName = toDisplayName(tm, email);
    const squarePhone = norm(tm.phone_number);
    const existing = await query(
      `SELECT id, phone, display_name, square_team_member_id
       FROM users
       WHERE company_id = $1 AND (square_team_member_id = $2 OR email = $3)`,
      [cId, squareId, email.toLowerCase()]
    );
    const row = existing.rows[0];
    if (!row) {
      try {
        await query(
          `INSERT INTO users (company_id, email, password_hash, display_name, role, square_team_member_id, phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [cId, email.toLowerCase(), SQUARE_PLACEHOLDER_PASSWORD_HASH, displayName, 'member', squareId, tm.phone_number || null]
        );
        added++;
      } catch (insertErr) {
        if (insertErr.code === '23505') {
          skipped++;
          continue;
        }
        throw insertErr;
      }
      continue;
    }

    const dbPhone = norm(row.phone);
    const dbName = norm(row.display_name);
    const nextName = norm(displayName);
    const needsUpdate = dbPhone !== squarePhone || dbName !== nextName || row.square_team_member_id !== squareId;
    if (!needsUpdate) {
      skipped++;
      continue;
    }
    await query(
      `UPDATE users
       SET display_name = $2, phone = $3, square_team_member_id = $4, updated_at = NOW()
       WHERE id = $1`,
      [row.id, displayName, tm.phone_number || null, squareId]
    );
    updated++;
  }

  let removed = 0;
  if (currentSquareIds.length > 0) {
    const params = [cId, currentSquareIds];
    let sql = `DELETE FROM users
               WHERE company_id = $1
                 AND square_team_member_id IS NOT NULL
                 AND square_team_member_id != ALL($2::text[])`;
    if (actorUserId) {
      params.push(actorUserId);
      sql += ` AND id != $3`;
    }
    sql += ` RETURNING id`;
    const del = await query(sql, params);
    removed = del.rowCount || 0;
  } else {
    const params = [cId];
    let sql = `DELETE FROM users
               WHERE company_id = $1
                 AND square_team_member_id IS NOT NULL`;
    if (actorUserId) {
      params.push(actorUserId);
      sql += ` AND id != $2`;
    }
    sql += ` RETURNING id`;
    const del = await query(sql, params);
    removed = del.rowCount || 0;
  }

  return { company_id: cId, added, updated, skipped, removed, excluded: excludedIds.size, disabled: false };
}

export function startDailySquareAutoSync() {
  const run = async () => {
    try {
      const companies = await query(`SELECT id FROM companies`);
      for (const company of companies.rows) {
        try {
          await runSquareAutoSyncForCompany(company.id, null);
        } catch (err) {
          console.error(`Square auto-sync failed for company ${company.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Square auto-sync loop failed:', err.message);
    }
  };

  setTimeout(run, 30 * 1000);
  setInterval(run, DAY_IN_MS);
}

// ── Scheduled Report Runner ───────────────────────────────────────────────────

function isReportDue(report, now, timezone = 'UTC') {
  // Evaluate all date/time parts in the company's timezone
  const fmt = (opts) => Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...opts })
      .formatToParts(now).map((p) => [p.type, p.value])
  );

  const dateParts = fmt({ year: 'numeric', month: '2-digit', day: '2-digit',
                          hour: '2-digit', minute: '2-digit', hour12: false });
  // Intl hour12:false can return '24' for midnight — normalise to '00'
  const hh = dateParts.hour === '24' ? '00' : dateParts.hour;
  const todayStr    = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const currentTime = `${hh}:${dateParts.minute}`;
  const sendTime    = String(report.send_time).slice(0, 5); // HH:MM

  // Already ran today (in company timezone)?
  if (report.last_ran_at) {
    const lrParts = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
    // Re-format last_ran_at using the same timezone
    const lrFmt = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(report.last_ran_at)).map((p) => [p.type, p.value])
    );
    const lastStr = `${lrFmt.year}-${lrFmt.month}-${lrFmt.day}`;
    if (lastStr === todayStr) return false;
  }

  // Date range
  if (report.start_date && todayStr < new Date(report.start_date).toISOString().slice(0, 10)) return false;
  if (report.end_date   && todayStr > new Date(report.end_date).toISOString().slice(0, 10))   return false;

  // Not yet time today (in company timezone)?
  if (currentTime < sendTime) return false;

  const dowParts = fmt({ weekday: 'short' }); // 'Sun','Mon',...
  const DOW_MAP  = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow   = DOW_MAP[dateParts.weekday] ?? DOW_MAP[dowParts.weekday] ?? new Date(now).getDay();
  const dom   = parseInt(dateParts.day,   10);
  const month = parseInt(dateParts.month, 10);
  const year  = parseInt(dateParts.year,  10);

  switch (report.frequency) {
    case 'daily':
      return true;
    case 'weekly':
      return dow === report.day_of_week;
    case 'monthly': {
      const daysInMonth = new Date(year, month, 0).getDate();
      return dom === Math.min(report.day_of_month || 1, daysInMonth);
    }
    case 'yearly': {
      const m = report.send_month || 1;
      const daysInYearMonth = new Date(year, m, 0).getDate();
      return month === m && dom === Math.min(report.day_of_month || 1, daysInYearMonth);
    }
    default:
      return false;
  }
}

async function runScheduledReport(report, { updateLastRanAt = true } = {}) {
  console.log(`[scheduler] Running report "${report.name}" (${report.id})`);
  let runId, smsSent = 0, emailSent = 0, sqlError = null;

  try {
    const timezone = await getCompanyTimezone(report.company_id);
    const result = await executeSqlReadOnly(report.sql_query, report.params || [], timezone);
    const { rows, fields } = result;

    const paramsSnapshot = await resolveParamsSnapshot(report.params || [], timezone);

    const runResult = await query(
      `INSERT INTO scheduled_report_runs
         (report_id, status, rows_returned, result_data, result_fields, params_snapshot)
       VALUES ($1, 'success', $2, $3, $4, $5) RETURNING id, view_token`,
      [report.id, rows.length, JSON.stringify(rows), JSON.stringify(fields), JSON.stringify(paramsSnapshot)]
    );
    runId = runResult.rows[0].id;
    const viewToken = runResult.rows[0].view_token;

    // Get recipients. Fetch phone AND email, then filter per channel — a report
    // delivered by email shouldn't be skipped just because someone has no phone.
    const allRecipients = await query(
      `SELECT u.phone, u.email, u.display_name FROM scheduled_report_recipients srr
       JOIN users u ON u.id = srr.user_id
       WHERE srr.report_id = $1`,
      [report.id]
    );
    const delivery = report.delivery_method || 'sms';
    const wantsSms   = delivery === 'sms'   || delivery === 'both';
    const wantsEmail = delivery === 'email' || delivery === 'both';

    const recipients = { rows: wantsSms
      ? allRecipients.rows.filter((r) => r.phone && r.phone !== '')
      : [] };

    if (wantsSms && !recipients.rows.length) {
      console.warn(`[scheduler] "${report.name}" — no recipients with phone numbers`);
    } else if (wantsSms) {
      const integrations = await getCompanyIntegrations(report.company_id);
      const accountSid = integrations?.twilio_account_sid?.trim() || process.env.TWILIO_ACCOUNT_SID;
      const authToken  = integrations?.twilio_auth_token?.trim()  || process.env.TWILIO_AUTH_TOKEN;
      const fromNumber = integrations?.twilio_phone_number?.trim() || process.env.TWILIO_PHONE_NUMBER;
      const appUrl     = process.env.APP_URL || 'https://team.kindredvineyards.com';

      if (accountSid && authToken && fromNumber) {
        const tc = twilio(accountSid, authToken);
        for (const r of recipients.rows) {
          try {
            await tc.messages.create({
              from: fromNumber,
              to: r.phone,
              body: `📊 ${report.name} is ready — ${rows.length} result${rows.length !== 1 ? 's' : ''}.\nView: ${appUrl}/r/${viewToken}`,
            });
            smsSent++;
            console.log(`[scheduler] SMS sent to ${r.display_name} (${r.phone})`);
          } catch (e) {
            console.error(`[scheduler] SMS failed to ${r.phone}:`, e.message);
          }
        }
      } else {
        const missing = [!accountSid && 'account_sid', !authToken && 'auth_token', !fromNumber && 'phone_number'].filter(Boolean);
        console.warn(`[scheduler] "${report.name}" — Twilio not configured, missing: ${missing.join(', ')}`);
      }
    }

    // ── Email delivery ────────────────────────────────────────────────────────
    // Renders the same rows the view link shows, as an HTML table, so the report
    // lands in the inbox rather than requiring a click-through.
    if (wantsEmail) {
      const emailTo = allRecipients.rows.filter((r) => r.email && r.email.trim());
      if (!emailTo.length) {
        console.warn(`[scheduler] "${report.name}" — no recipients with email addresses`);
      } else {
        const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const cols = fields.map((f) => f.name || f);
        const th = cols.map((c) => `<th style="border:1px solid #ddd;padding:6px 10px;text-align:left;background:#f5f5f5">${esc(c)}</th>`).join('');
        const tr = rows.map((row) =>
          `<tr>${cols.map((c) => `<td style="border:1px solid #ddd;padding:6px 10px">${esc(row[c])}</td>`).join('')}</tr>`
        ).join('');
        const appUrl = process.env.APP_URL || 'https://team.kindredvineyards.com';
        const html = `<div style="font-family:Arial,sans-serif">
            <h2 style="margin-bottom:2px">${esc(report.name)}</h2>
            ${report.description ? `<p style="color:#555;margin-top:0">${esc(report.description)}</p>` : ''}
            <table style="border-collapse:collapse;margin-top:10px"><tr>${th}</tr>${tr}</table>
            <p style="color:#888;font-size:12px;margin-top:14px">
              ${rows.length} result${rows.length !== 1 ? 's' : ''} ·
              <a href="${appUrl}/r/${viewToken}">view online</a>
            </p></div>`;
        for (const r of emailTo) {
          const res = await sendMail(
            { to: r.email, subject: report.name, html }, report.company_id
          );
          if (res.sent) { emailSent++; console.log(`[scheduler] email sent to ${r.display_name} (${r.email})`); }
          else console.error(`[scheduler] email failed to ${r.email}: ${res.error}`);
        }
      }
    }

    await query(
      `UPDATE scheduled_report_runs SET sms_sent_count = $1, email_sent_count = $2 WHERE id = $3`,
      [smsSent, emailSent, runId]
    );

  } catch (err) {
    sqlError = err.message;
    console.error(`[scheduler] "${report.name}" failed:`, err.message);
    await query(
      `INSERT INTO scheduled_report_runs (report_id, status, error_message) VALUES ($1,'failed',$2)`,
      [report.id, err.message]
    ).catch(() => {});
  }

  // Update last_ran_at for scheduled runs so the scheduler doesn't retry the same window.
  // Skip for manual "Run Now" so the scheduled run still fires at its configured time.
  if (updateLastRanAt) {
    await query(`UPDATE scheduled_reports SET last_ran_at = NOW() WHERE id = $1`, [report.id]).catch(() => {});
  }

  // Return result so callers (run-now endpoint) can surface errors to the UI
  if (sqlError) throw new Error(sqlError);
  return { smsSent, emailSent };
}

export function startReportScheduler() {
  const FIVE_MIN = 5 * 60 * 1000;

  const check = async () => {
    try {
      const now = new Date();
      const reports = await query(
        `SELECT sr.*, c.timezone
         FROM scheduled_reports sr
         JOIN companies c ON c.id = sr.company_id
         WHERE sr.active = true
           AND (sr.start_date IS NULL OR sr.start_date <= CURRENT_DATE)
           AND (sr.end_date   IS NULL OR sr.end_date   >= CURRENT_DATE)`
      );
      for (const report of reports.rows) {
        const tz = report.timezone || 'UTC';
        if (isReportDue(report, now, tz)) {
          console.log(`[scheduler] Report due: "${report.name}" (tz=${tz})`);
          runScheduledReport(report).catch((e) =>
            console.error(`[scheduler] Unhandled error for report ${report.id}:`, e.message)
          );
        }
      }
    } catch (err) {
      console.error('[scheduler] Check loop error:', err.message);
    }
  };

  setTimeout(check, 60 * 1000); // first check 60s after startup
  setInterval(check, FIVE_MIN);
  console.log('Report scheduler started (checking every 5 minutes)');
}

// ---------- Square: list team members from local team_square.team_member (no API call) ----------
router.get('/square/team-members', async (req, res) => {
  try {
    const cId = companyId(req);
    const r = await query(
      `SELECT
         tm.id,
         tm.given_name,
         tm.family_name,
         tm.email_address,
         tm.phone_number,
         tm.status,
         CASE WHEN u.id IS NOT NULL THEN true ELSE false END AS already_in_system,
         u.role,
         CASE WHEN ex.square_team_member_id IS NOT NULL THEN true ELSE false END AS excluded
       FROM team_square.team_member tm
       LEFT JOIN users u
         ON u.company_id = $1 AND u.square_team_member_id = tm.id
       LEFT JOIN square_user_exclusions ex
         ON ex.company_id = $1 AND ex.square_team_member_id = tm.id
       WHERE tm.status = 'ACTIVE'
       ORDER BY tm.given_name, tm.family_name`,
      [cId]
    );
    res.json({ team_members: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Square: fetch team members only (manager); no DB insert/update ----------
router.post('/square/sync', async (req, res) => {
  try {
    const cId = companyId(req);
    const integrations = await getCompanyIntegrations(cId);
    const { token, squareBase } = getSquareConfig(integrations);
    if (!token) return res.status(503).json({ error: 'Square not configured. Owner can set API keys in Settings.' });
    const teamMembers = await fetchActiveSquareTeamMembers(token, squareBase);
    const excludedIds = await getExcludedSquareIds(cId);

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
        excluded: excludedIds.has(tm.id),
      });
    }
    res.json({ team_members: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: 'Square API error', details: err.message });
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
      const excluded = await query(
        `SELECT 1 FROM square_user_exclusions WHERE company_id = $1 AND square_team_member_id = $2`,
        [cId, squareId]
      );
      if (excluded.rows.length > 0) {
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
    const result = await runSquareAutoSyncForCompany(cId, req.userId);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: 'Square API error', details: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/square/exclusions', async (req, res) => {
  try {
    const cId = companyId(req);
    const { square_team_member_id, excluded } = req.body || {};
    const memberId = square_team_member_id && String(square_team_member_id).trim();
    if (!memberId) return res.status(400).json({ error: 'square_team_member_id required' });

    if (excluded) {
      await query(
        `INSERT INTO square_user_exclusions (company_id, square_team_member_id, created_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id, square_team_member_id) DO NOTHING`,
        [cId, memberId, req.userId]
      );
      // If excluded later, remove any currently synced account (except caller) so they stay out.
      await query(
        `DELETE FROM users
         WHERE company_id = $1
           AND square_team_member_id = $2
           AND id != $3`,
        [cId, memberId, req.userId]
      );
    } else {
      await query(
        `DELETE FROM square_user_exclusions
         WHERE company_id = $1 AND square_team_member_id = $2`,
        [cId, memberId]
      );
    }
    res.json({ ok: true, square_team_member_id: memberId, excluded: !!excluded });
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

// List company users (used by scheduled reports recipient picker)
router.get('/users', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, display_name, phone, email, role
       FROM users
       WHERE company_id = $1
       ORDER BY display_name`,
      [companyId(req)]
    );
    res.json({ users: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List SMS log (manager)
// POST /integrations/run-report/:id — immediately run a scheduled report (manager+)
router.post('/run-report/:id', async (req, res) => {
  try {
    const r = await query(
      // Count recipients reachable on the channel this report actually uses —
      // an email report shouldn't be blocked for lacking phone numbers.
      `SELECT sr.*, c.timezone,
         (SELECT COUNT(*) FROM scheduled_report_recipients srr
          JOIN users u ON u.id = srr.user_id
          WHERE srr.report_id = sr.id
            AND ( (sr.delivery_method IN ('sms','both')   AND u.phone IS NOT NULL AND u.phone <> '')
               OR (sr.delivery_method IN ('email','both') AND u.email IS NOT NULL AND u.email <> '') )
         ) AS recipient_count
       FROM scheduled_reports sr
       JOIN companies c ON c.id = sr.company_id
       WHERE sr.id = $1 AND sr.company_id = $2`,
      [req.params.id, companyId(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Report not found' });

    const report = r.rows[0];

    // Pre-flight checks so we return a clear error before touching the DB
    if (!report.sql_query?.trim()) {
      return res.status(400).json({ error: 'Report has no SQL query.' });
    }
    if (parseInt(report.recipient_count) === 0) {
      const chan = (report.delivery_method || 'sms') === 'email' ? 'email addresses' : 'phone numbers';
      return res.status(400).json({ error: `No recipients with ${chan}. Edit the report and add at least one recipient.` });
    }

    const { smsSent, emailSent } = await runScheduledReport(report, { updateLastRanAt: false });
    res.json({ ok: true, smsSent, emailSent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /integrations/sms-log
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
