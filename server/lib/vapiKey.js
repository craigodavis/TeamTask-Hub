/**
 * The API key Vapi presents when it calls us.
 *
 * One key per company, stored in plain text and shown in full on the Vapi
 * Settings tab. That is a deliberate choice, not an oversight: the key only
 * unlocks things a caller already learns by dialling the number — hours,
 * addresses, whether we are open — and being able to read it back is the whole
 * point of putting it on a page you can copy from. Rotation is a button, so a
 * key that leaks costs one click rather than a deploy.
 *
 * If this key ever guards something a stranger should not be able to do — and
 * the planned "text the on-shift steward" endpoint is exactly that — revisit
 * this. The store below is ready for it: rotate is already cheap, and every
 * request is logged, so a leak is visible after the fact instead of silent.
 */
import crypto from 'crypto';
import { query } from '../db.js';

/** Readable prefix so the key is identifiable on sight in a log or a config box. */
const PREFIX = 'kv_vapi_';

export function generateKey() {
  return PREFIX + crypto.randomBytes(24).toString('base64url');
}

/**
 * The company's current key, minting one on first read so the settings page
 * never has to show an empty box or make the user "create" something first.
 */
export async function getOrCreateKey(companyId, userId = null) {
  const found = await query(
    `SELECT api_key, rotated_at, rotated_by FROM vapi_settings WHERE company_id = $1`,
    [companyId]
  );
  if (found.rows.length) return found.rows[0];

  const key = generateKey();
  // ON CONFLICT rather than a bare INSERT: two admins opening the tab at once
  // must not race into two different keys, one of which silently wins.
  const made = await query(
    `INSERT INTO vapi_settings (company_id, api_key, rotated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id) DO UPDATE SET company_id = EXCLUDED.company_id
     RETURNING api_key, rotated_at, rotated_by`,
    [companyId, key, userId]
  );
  return made.rows[0];
}

export async function rotateKey(companyId, userId = null) {
  const key = generateKey();
  const r = await query(
    `INSERT INTO vapi_settings (company_id, api_key, rotated_at, rotated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (company_id) DO UPDATE
       SET api_key = EXCLUDED.api_key, rotated_at = NOW(), rotated_by = EXCLUDED.rotated_by
     RETURNING api_key, rotated_at, rotated_by`,
    [companyId, key, userId]
  );
  return r.rows[0];
}

/**
 * Constant-time comparison. A plain `===` on a secret leaks its length and, in
 * principle, its contents through response timing; timingSafeEqual costs
 * nothing here and removes the question.
 */
export async function verifyKey(companyId, presented) {
  if (!presented || typeof presented !== 'string') return false;
  const r = await query(`SELECT api_key FROM vapi_settings WHERE company_id = $1`, [companyId]);
  const stored = r.rows[0]?.api_key;
  if (!stored) return false;

  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;     // timingSafeEqual throws on length mismatch
  return crypto.timingSafeEqual(a, b);
}

/** Accepts `Authorization: Bearer <key>` or `x-api-key: <key>`. */
export function presentedKey(req) {
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const x = req.headers?.['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return null;
}

/**
 * Best-effort audit line. Never throws: a logging failure must not turn a
 * working phone call into a 500.
 */
export async function logCall(companyId, endpoint, ok, detail, ip) {
  try {
    await query(
      `INSERT INTO vapi_call_log (company_id, endpoint, ok, detail, ip)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, String(endpoint).slice(0, 200), !!ok,
       detail == null ? null : String(detail).slice(0, 500),
       ip == null ? null : String(ip).slice(0, 60)]
    );
  } catch (e) {
    console.warn('[vapi] call log failed:', e.message);
  }
}
