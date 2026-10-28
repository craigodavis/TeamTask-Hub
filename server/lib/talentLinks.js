/**
 * Short-lived update links for performers.
 *
 * A performer is an outside party with no account, so the link is the whole
 * security model and it is kept deliberately small: one musician, one live
 * token, 24 hours, and a field whitelist on the way back in.
 *
 * The raw token is returned exactly once — at send — and only its SHA-256 is
 * stored, the same rule as service_tokens. A leaked database gives an attacker
 * nothing to replay.
 *
 * See docs/TALENT_SELF_SERVICE.md.
 */
import crypto from 'crypto';
import { query } from '../db.js';

export const LINK_TTL_HOURS = 24;

/** What a performer is allowed to send us. Anything else is ignored outright. */
export const EDITABLE = [
  'legal_first_name', 'legal_last_name', 'business_name', 'tax_entity',
  'stage_name', 'phone', 'email', 'address', 'genre', 'act_type',
  'website_url', 'instagram_url', 'youtube_url', 'facebook_url',
  'photo_url', 'bio', 'performer_notes',
];

/**
 * What a performer may SEE. Built as its own list rather than by subtracting
 * from the admin row: a column added later should default to invisible, not
 * leak because nobody remembered to exclude it. `name` is shown but not
 * editable — renaming the act would detach its booking history.
 */
export const VISIBLE = ['id', 'name', ...EDITABLE];

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** 32 bytes, url-safe. Long enough that guessing is not a threat model. */
export const newToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Issue a link. Revokes any previous live one — a performer should never have
 * two valid links, or revoking the one they were phished with achieves nothing.
 */
export async function issueLink(companyId, musicianId, { channel, sentTo, userId } = {}) {
  const token = newToken();
  await query(
    `UPDATE talent_update_links SET revoked_at = NOW()
      WHERE musician_id = $1 AND revoked_at IS NULL AND submitted_at IS NULL`,
    [musicianId]);
  const r = await query(
    `INSERT INTO talent_update_links
       (company_id, musician_id, token_hash, channel, sent_to, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' hours')::interval, $7)
     RETURNING id, expires_at`,
    [companyId, musicianId, sha(token), channel, sentTo || null, String(LINK_TTL_HOURS), userId || null]);
  return { token, id: r.rows[0].id, expires_at: r.rows[0].expires_at };
}

/**
 * Resolve a token to its link row. Returns a reason rather than throwing, so
 * the public page can say "this link has expired" and offer a fresh one instead
 * of showing an error. Never says whether a token merely never existed — that
 * and "revoked" are the same answer to anyone probing.
 */
export async function resolveToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'invalid' };
  const r = await query(
    `SELECT l.*, m.name AS musician_name, m.company_id AS m_company
       FROM talent_update_links l JOIN musicians m ON m.id = l.musician_id
      WHERE l.token_hash = $1`, [sha(token)]);
  const link = r.rows[0];
  if (!link) return { ok: false, reason: 'invalid' };
  if (link.revoked_at) return { ok: false, reason: 'invalid' };
  if (link.submitted_at) return { ok: false, reason: 'used' };
  if (new Date(link.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  return { ok: true, link };
}

export async function markOpened(linkId) {
  await query(`UPDATE talent_update_links SET opened_at = COALESCE(opened_at, NOW()) WHERE id = $1`, [linkId]);
}

/** Keep only whitelisted keys, trimmed, with blanks normalised to null. */
export function sanitize(body) {
  const out = {};
  for (const k of EDITABLE) {
    if (!(k in (body || {}))) continue;
    let v = body[k];
    if (typeof v === 'string') v = v.trim();
    out[k] = v === '' || v === undefined ? null : v;
  }
  return out;
}

/** Obvious nonsense, caught before it reaches a reviewer. */
export function validate(p) {
  const errs = [];
  if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) errs.push('That email address does not look right.');
  if (p.phone && p.phone.replace(/\D/g, '').length < 10) errs.push('That phone number looks too short.');
  for (const [f, host] of [['instagram_url', 'instagram'], ['youtube_url', 'youtu'], ['facebook_url', 'facebook']]) {
    if (p[f] && !String(p[f]).toLowerCase().includes(host)) {
      errs.push(`The ${f.replace('_url', '')} link does not look like a ${f.replace('_url', '')} address.`);
    }
  }
  for (const f of ['website_url', 'instagram_url', 'youtube_url', 'facebook_url', 'photo_url']) {
    if (p[f] && !/^https?:\/\//i.test(p[f])) errs.push(`${f.replace('_url', '')} needs to start with http:// or https://`);
  }
  if (p.tax_entity && !['individual', 'business'].includes(p.tax_entity)) errs.push('Tax entity must be individual or business.');
  // There is no column for this, and there should not be — but a performer may
  // paste one into a free-text box anyway, and we would rather refuse it.
  const free = [p.performer_notes, p.bio, p.address].filter(Boolean).join(' ');
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(free)) {
    errs.push('Please do not include a Social Security number — we will take that by phone.');
  }
  return errs;
}

/** The performer-facing view of their own record. */
export async function publicProfile(musicianId) {
  const r = await query(
    `SELECT ${VISIBLE.map((c) => `m.${c}`).join(', ')} FROM musicians m WHERE m.id = $1`, [musicianId]);
  return r.rows[0] || null;
}

/** The terms in force, or null if none have been written yet. */
export async function currentTerms(companyId) {
  const r = await query(
    `SELECT version, body_md FROM terms_versions
      WHERE company_id = $1 AND effective_from <= NOW()
      ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [companyId]);
  return r.rows[0] || null;
}
