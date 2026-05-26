/**
 * Square Customers Sync → team_square.customer
 * Uses POST /v2/customers/search with updated_at filter for incremental syncs.
 * Initial sync: all customers (no time filter).
 * Incremental: only customers updated since lastSyncedAt - 1hr buffer.
 */
import { query, pool } from '../db.js';

async function getSquareConfig(companyId) {
  const r = await query(`SELECT square_access_token, square_env FROM company_integrations WHERE company_id = $1`, [companyId]);
  const row = r.rows[0];
  const token = row?.square_access_token?.trim() || process.env.SQUARE_ACCESS_TOKEN || '';
  const env   = row?.square_env?.trim()          || process.env.SQUARE_ENV           || 'production';
  const base  = env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  return { token, base };
}

export async function runCustomerSync(companyId, lastSyncedAt = null) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  const updatedAfter = lastSyncedAt
    ? new Date(new Date(lastSyncedAt).getTime() - 60 * 60 * 1000).toISOString()
    : null;

  const customers = [];
  let cursor = null;
  do {
    const body = { limit: 100 };
    if (cursor) body.cursor = cursor;
    if (updatedAfter) {
      body.query = { filter: { updated_at: { start_at: updatedAfter } } };
    }
    const res = await fetch(`${base}/v2/customers/search`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-05-21', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Square customers search ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.customers) customers.push(...data.customers);
    cursor = data.cursor || null;
  } while (cursor);

  if (!customers.length) return { customersUpserted: 0 };

  let customersUpserted = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of customers) {
      await client.query(
        `INSERT INTO team_square.customer
           (id, given_name, family_name, email_address, phone_number,
            company_name, nickname, birthday, note, reference_id,
            creation_source, email_unsubscribed, segment_ids, version,
            created_at, updated_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
         ON CONFLICT (id) DO UPDATE SET
           given_name         = EXCLUDED.given_name,
           family_name        = EXCLUDED.family_name,
           email_address      = EXCLUDED.email_address,
           phone_number       = EXCLUDED.phone_number,
           company_name       = EXCLUDED.company_name,
           nickname           = EXCLUDED.nickname,
           birthday           = EXCLUDED.birthday,
           note               = EXCLUDED.note,
           reference_id       = EXCLUDED.reference_id,
           creation_source    = EXCLUDED.creation_source,
           email_unsubscribed = EXCLUDED.email_unsubscribed,
           segment_ids        = EXCLUDED.segment_ids,
           version            = EXCLUDED.version,
           updated_at         = EXCLUDED.updated_at,
           synced_at          = NOW()`,
        [
          c.id,
          c.given_name         || null,
          c.family_name        || null,
          c.email_address      || null,
          c.phone_number       || null,
          c.company_name       || null,
          c.nickname           || null,
          c.birthday           || null,
          c.note               || null,
          c.reference_id       || null,
          c.creation_source    || null,
          c.preferences?.email_unsubscribed ?? null,
          c.segment_ids?.length ? c.segment_ids : null,
          c.version            ?? null,
          c.created_at         || null,
          c.updated_at         || null,
        ]
      );
      customersUpserted++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { customersUpserted };
}
