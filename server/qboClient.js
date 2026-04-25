/**
 * QBO API client with automatic token refresh.
 * Reads/writes tokens from the company_integrations table per company.
 */
import { query } from './db.js';

const QBO_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_BASE_PRODUCTION = 'https://quickbooks.api.intuit.com';
const QBO_BASE_SANDBOX = 'https://sandbox-quickbooks.api.intuit.com';
const MINOR_VERSION = '75';

async function loadTokens(companyId) {
  const r = await query(
    `SELECT qbo_access_token, qbo_refresh_token, qbo_token_expires_at,
            qbo_realm_id, qbo_environment
     FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  return r.rows[0] || null;
}

async function saveTokens(companyId, tokens) {
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);
  await query(
    `UPDATE company_integrations
     SET qbo_access_token     = $2,
         qbo_refresh_token    = $3,
         qbo_token_expires_at = $4,
         updated_at           = NOW()
     WHERE company_id = $1`,
    [companyId, tokens.access_token, tokens.refresh_token, expiresAt]
  );
}

async function refreshAccessToken(companyId, refreshToken) {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(QBO_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`QBO token refresh failed: ${err}`);
  }

  const tokens = await res.json();
  await saveTokens(companyId, tokens);
  return tokens.access_token;
}

async function getAccessToken(companyId) {
  const row = await loadTokens(companyId);
  if (!row?.qbo_access_token) {
    throw new Error('QuickBooks is not connected. Go to Settings → Integrations to connect.');
  }

  const expiresAt = row.qbo_token_expires_at ? new Date(row.qbo_token_expires_at) : null;
  const isExpired = !expiresAt || Date.now() >= expiresAt.getTime() - 60_000; // 1 min buffer

  if (isExpired) {
    if (!row.qbo_refresh_token) throw new Error('QBO refresh token missing. Please reconnect.');
    return refreshAccessToken(companyId, row.qbo_refresh_token);
  }

  return row.qbo_access_token;
}

/**
 * Make an authenticated request to the QBO REST API.
 * Automatically refreshes the access token if expired.
 */
export async function qboRequest(companyId, method, path, { params = {}, body } = {}) {
  const row = await loadTokens(companyId);
  if (!row?.qbo_realm_id) throw new Error('QBO realm ID not found. Please reconnect.');

  const token = await getAccessToken(companyId);
  const base = row.qbo_environment === 'sandbox' ? QBO_BASE_SANDBOX : QBO_BASE_PRODUCTION;
  const url = new URL(`${base}/v3/company/${row.qbo_realm_id}/${path}`);

  url.searchParams.set('minorversion', MINOR_VERSION);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`QBO API error ${res.status}: ${err}`);
  }

  return res.json();
}

/**
 * Paginate through all results of a QBO query.
 */
export async function qboQueryAll(companyId, selectStatement) {
  const results = [];
  let startPosition = 1;
  const pageSize = 1000;

  while (true) {
    const paginatedQuery = `${selectStatement} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`;
    const data = await qboRequest(companyId, 'GET', 'query', { params: { query: paginatedQuery } });
    const response = data.QueryResponse || {};
    const entities = Object.values(response).find(Array.isArray) || [];

    results.push(...entities);

    if (entities.length < pageSize) break;
    startPosition += pageSize;
  }

  return results;
}
