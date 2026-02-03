import nodemailer from 'nodemailer';
import { query } from './db.js';

function buildTransporterFromEnv() {
  if (!process.env.MAIL_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: parseInt(process.env.MAIL_PORT || '587', 10),
    secure: process.env.MAIL_SECURE === 'true',
    auth: process.env.MAIL_USER
      ? { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS || '' }
      : undefined,
  });
}

function buildTransporterFromRow(row) {
  if (!row?.mail_host || String(row.mail_host).trim() === '') return null;
  return nodemailer.createTransport({
    host: row.mail_host,
    port: row.mail_port != null ? parseInt(row.mail_port, 10) : 587,
    secure: row.mail_secure === true,
    auth: row.mail_user
      ? { user: row.mail_user, pass: row.mail_pass || '' }
      : undefined,
  });
}

function getFromAddress(rowOrEnv) {
  if (rowOrEnv?.mail_from && String(rowOrEnv.mail_from).trim()) return rowOrEnv.mail_from;
  if (rowOrEnv?.mail_user && String(rowOrEnv.mail_user).trim()) return rowOrEnv.mail_user;
  return process.env.MAIL_FROM || process.env.MAIL_USER || 'noreply@teamtask.local';
}

const envTransporter = buildTransporterFromEnv();
const envFrom = getFromAddress(process.env);

/**
 * Send an email. Returns { sent: true } on success, { sent: false, error? } on failure.
 * When companyId is provided, loads mail config from company_integrations for that company;
 * if mail_host is set, uses DB config; otherwise falls back to env. When companyId is omitted, uses env only.
 */
export async function sendMail({ to, subject, text, html }, companyId = null) {
  let transporter = envTransporter;
  let from = envFrom;

  if (companyId) {
    try {
      const r = await query(
        `SELECT mail_host, mail_port, mail_user, mail_pass, mail_from, mail_secure
         FROM company_integrations WHERE company_id = $1`,
        [companyId]
      );
      const row = r.rows[0];
      if (row?.mail_host && String(row.mail_host).trim()) {
        transporter = buildTransporterFromRow(row);
        from = getFromAddress(row);
      }
    } catch (err) {
      return { sent: false, error: err.message };
    }
  }

  if (!transporter) {
    return { sent: false, error: 'Email not configured (MAIL_HOST or Settings > Mail)' };
  }
  try {
    await transporter.sendMail({
      from,
      to,
      subject,
      text: text || (html ? html.replace(/<[^>]+>/g, '') : ''),
      html: html || undefined,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}
