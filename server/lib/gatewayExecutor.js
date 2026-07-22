/**
 * Gateway executor — dispatches approved gateway_actions to the appropriate
 * external service (QBO, Square, Commerce7).
 *
 * Operation format:  "<Entity>.<verb>"
 *   QBO examples:    "Invoice.create"  "Bill.update"  "Payment.delete"
 *                    "Purchase.get"    "Account.query"
 *   Square examples: "catalog.list"    "order.create"  "payment.refund"
 *   C7 examples:     "order.get"       "customer.update"
 *
 * Payload shape (all fields optional depending on verb):
 *   { id, body, query, params }
 */

import { query } from '../db.js';
import { qboRequest, qboQueryAll } from '../qboClient.js';
import { assertSafeQboLineWrite } from './qboPurchaseLines.js';
import { makeC7Client } from './commerce7Client.js';

// ── QBO adapter ──────────────────────────────────────────────────────────────

async function execQbo(companyId, operation, payload) {
  const [entity, verb] = operation.split('.');
  if (!entity || !verb) throw new Error(`Invalid QBO operation: "${operation}"`);

  const entityLower = entity.toLowerCase();

  switch (verb) {
    case 'create':
    case 'update':
      // Safety net: never let an agent write a $0/non-numeric-line transaction.
      assertSafeQboLineWrite(entityLower, payload.body);
      return qboRequest(companyId, 'POST', entityLower, { body: payload.body });

    case 'delete': {
      // QBO delete requires the current SyncToken — caller must include it in body
      const deleteBody = payload.body || {};
      if (!deleteBody.Id)        throw new Error('delete requires payload.body.Id');
      if (!deleteBody.SyncToken) throw new Error('delete requires payload.body.SyncToken');
      return qboRequest(companyId, 'POST', `${entityLower}?operation=delete`, { body: deleteBody });
    }

    case 'get': {
      const id = payload.id;
      if (!id) throw new Error('get requires payload.id');
      return qboRequest(companyId, 'GET', `${entityLower}/${id}`);
    }

    case 'query': {
      const sql = payload.query;
      if (!sql) throw new Error('query requires payload.query');
      return qboQueryAll(companyId, sql);
    }

    case 'void': {
      const voidBody = payload.body || {};
      if (!voidBody.Id)        throw new Error('void requires payload.body.Id');
      if (!voidBody.SyncToken) throw new Error('void requires payload.body.SyncToken');
      return qboRequest(companyId, 'POST', `${entityLower}?operation=void`, { body: voidBody });
    }

    default:
      throw new Error(`Unknown QBO verb "${verb}" for entity "${entity}"`);
  }
}

// ── Square adapter ───────────────────────────────────────────────────────────

async function getSquareClient(companyId) {
  const { rows } = await query(
    `SELECT square_access_token, square_env
     FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const row = rows[0];
  if (!row?.square_access_token) throw new Error('Square not connected for this company');

  const base = row.square_env === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';

  return async function squareFetch(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${row.square_access_token}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-06-04',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.errors?.[0]?.detail || data?.message || JSON.stringify(data);
      throw new Error(`Square ${res.status}: ${msg}`);
    }
    return data;
  };
}

async function execSquare(companyId, operation, payload) {
  const sf = await getSquareClient(companyId);
  const [resource, verb] = operation.split('.');
  if (!resource || !verb) throw new Error(`Invalid Square operation: "${operation}"`);

  const path   = payload.path || buildSquarePath(resource, verb, payload.id);
  const method = squareVerb(verb);

  return sf(method, path, payload.body);
}

function squareVerb(verb) {
  switch (verb) {
    case 'create': case 'upsert': return 'POST';
    case 'update': case 'patch':  return 'PUT';
    case 'delete':                return 'DELETE';
    default:                      return 'GET';
  }
}

function buildSquarePath(resource, verb, id) {
  const base = `/v2/${resource}s`;  // e.g. /v2/orders
  if (verb === 'list' || verb === 'create') return base;
  if (id) return `${base}/${id}`;
  return base;
}

// ── Commerce7 adapter ────────────────────────────────────────────────────────

async function getC7Integration(companyId) {
  const { rows } = await query(
    `SELECT c7_api_key, c7_tenant_slug, c7_api_base_url
     FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  if (!rows[0]?.c7_api_key) throw new Error('Commerce7 not connected for this company');
  return rows[0];
}

async function execC7(companyId, operation, payload) {
  const integration = await getC7Integration(companyId);
  const c7 = makeC7Client(integration);
  const [resource, verb] = operation.split('.');
  if (!resource || !verb) throw new Error(`Invalid Commerce7 operation: "${operation}"`);

  const path = payload.path || `/${resource}${payload.id ? `/${payload.id}` : ''}`;

  switch (verb) {
    case 'list': case 'get':  return c7.get(path);
    case 'create':            return c7.post(path, payload.body);
    case 'update':            return c7.put(path, payload.body);
    case 'patch':             return c7.patch(path, payload.body);
    case 'delete':            return c7.delete(path);
    default:
      throw new Error(`Unknown Commerce7 verb "${verb}" for resource "${resource}"`);
  }
}

// ── Main dispatch ─────────────────────────────────────────────────────────────

/**
 * Execute a gateway action row and update its status in DB.
 * Expects action.status to already be 'executing' (set by caller).
 */
export async function executeGatewayAction(action) {
  const { id, company_id, service, operation, payload } = action;
  let result, errorMessage;

  try {
    switch (service) {
      case 'qbo':        result = await execQbo(company_id, operation, payload);       break;
      case 'square':     result = await execSquare(company_id, operation, payload);    break;
      case 'commerce7':  result = await execC7(company_id, operation, payload);        break;
      default:           throw new Error(`Unknown service: "${service}"`);
    }

    await query(
      `UPDATE gateway_actions
       SET status = 'completed', result = $2, executed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, JSON.stringify(result)]
    );
  } catch (err) {
    errorMessage = err.message;
    await query(
      `UPDATE gateway_actions
       SET status = 'failed', error_message = $2, executed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, errorMessage]
    );
    throw err;  // re-throw so auto-approve scheduler can log it
  }

  return result;
}
