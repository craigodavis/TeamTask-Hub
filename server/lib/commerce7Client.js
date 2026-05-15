/**
 * Commerce7 API client
 *
 * Auth: Basic auth using appId:apiKey (base64), plus 'tenant' header with tenant_slug.
 * App ID 'club-pickup-enforcer' is shared with ClubSteward.
 *
 * Usage:
 *   const client = makeC7Client(integration); // integration row from company_integrations
 *   const data = await client.get('/product?page=1&limit=100');
 */

import fetch from 'node-fetch';

const C7_APP_ID = 'club-pickup-enforcer';
const C7_DEFAULT_BASE_URL = 'https://api.commerce7.com/v1';

function getBaseUrl(integration) {
  let base = integration.c7_api_base_url || C7_DEFAULT_BASE_URL;
  if (!base.includes('/v1')) {
    base = base.endsWith('/') ? `${base}v1` : `${base}/v1`;
  }
  return base.replace(/\/$/, '');
}

function buildHeaders(integration) {
  const apiKey = integration.c7_api_key;
  if (!apiKey) throw new Error('Commerce7 API key not configured');
  const authHeader = `Basic ${Buffer.from(`${C7_APP_ID}:${apiKey}`).toString('base64')}`;
  const h = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (integration.c7_tenant_slug) h.tenant = integration.c7_tenant_slug;
  return h;
}

async function c7Request(integration, method, path, body) {
  const url = `${getBaseUrl(integration)}${path}`;
  const opts = { method, headers: buildHeaders(integration) };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    const err = new Error(`Commerce7 ${method} ${path} → ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Fetch all pages of a paginated C7 endpoint.
 * C7 uses ?page=N&limit=N; response has a 'total' count.
 * @param {object} integration - row from company_integrations
 * @param {string} path - endpoint path, e.g. '/product'
 * @param {string} dataKey - key in response that holds the array, e.g. 'products'
 * @param {number} pageSize - items per page (max 100 for most C7 endpoints)
 */
export async function c7FetchAll(integration, path, dataKey, pageSize = 100) {
  const results = [];
  let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await c7Request(integration, 'GET', `${path}${sep}page=${page}&limit=${pageSize}`);
    const items = data[dataKey] || [];
    results.push(...items);
    const total = data.total ?? 0;
    if (results.length >= total || items.length === 0) break;
    page++;
  }
  return results;
}

export function makeC7Client(integration) {
  return {
    get:    (path)        => c7Request(integration, 'GET',    path),
    post:   (path, body)  => c7Request(integration, 'POST',   path, body),
    put:    (path, body)  => c7Request(integration, 'PUT',    path, body),
    patch:  (path, body)  => c7Request(integration, 'PATCH',  path, body),
    delete: (path)        => c7Request(integration, 'DELETE', path),
    fetchAll: (path, dataKey, pageSize) => c7FetchAll(integration, path, dataKey, pageSize),
  };
}
