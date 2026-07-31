/**
 * Which winery a guest-facing app belongs to, resolved from the origin it is
 * served from.
 *
 * The rule that keeps this safe, and the reason it is written down here rather
 * than left implicit:
 *
 *   The origin decides WHICH WINERY a NEW account belongs to.
 *   It never decides whose account, card or membership — those follow the
 *   session, always.
 *
 * So the worst a forged Origin header can do is create an empty customer under
 * a different winery. It cannot read anything, move an existing account between
 * tenants, or reach a card. `Origin` is set by the browser and page JavaScript
 * cannot alter it; curl can send anything, which is exactly why this value is
 * never allowed to grant access to something that already exists.
 *
 * There is deliberately NO fallback tenant. An unknown origin resolves to null
 * and the caller refuses — a default is precisely what would let an unrecognised
 * or forged origin inherit production.
 */

import { query } from '../db.js';

/** Origins are compared exactly, lowercased, without a trailing slash. */
const normalize = (v) => String(v || '').trim().toLowerCase().replace(/\/+$/, '');

/**
 * The company this request's app belongs to, or null if the origin is unknown
 * or disabled. Reads Origin first and falls back to Referer, since some browsers
 * omit Origin on same-site GETs.
 */
export async function companyForRequest(req) {
  let origin = normalize(req.get('origin'));
  if (!origin && req.get('referer')) {
    try { origin = normalize(new URL(req.get('referer')).origin); } catch { /* ignore */ }
  }
  if (!origin) return null;

  const r = await query(
    `SELECT company_id, label FROM app_origins WHERE origin = $1 AND enabled = true`,
    [origin]);
  if (!r.rows.length) return null;
  return { companyId: r.rows[0].company_id, label: r.rows[0].label, origin };
}

/**
 * The Commerce7 tenant that company signs up through.
 *
 * Read from ClubSteward's integration rather than TeamHub's, because
 * ClubSteward is what actually performs the club signup — one source of truth,
 * so the club list a guest browses can never disagree with the tenant their
 * membership is created in. Same database, so this is a plain query.
 */
export async function tenantForCompany(companyId) {
  const r = await query(
    `SELECT tenant_slug FROM club_steward.commerce7_integrations WHERE company_id = $1`,
    [companyId]);
  return r.rows[0]?.tenant_slug || null;
}
