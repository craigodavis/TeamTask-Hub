/**
 * Square Inventory Counts Sync → team_square.inventory_count
 * Uses POST /v2/inventory/counts/batch-retrieve per location.
 * Always full sync — represents current state, not history.
 * PK is (catalog_object_id, location_id, state) so upsert is safe.
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

export async function runInventorySync(companyId) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  // Get all location IDs
  const locRes = await fetch(`${base}/v2/locations`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-05-21' },
  });
  if (!locRes.ok) throw new Error(`Square locations ${locRes.status}: ${await locRes.text()}`);
  const locData = await locRes.json();
  const locationIds = (locData.locations || []).map(l => l.id);

  const allCounts = [];
  let cursor = null;
  do {
    const body = { location_ids: locationIds, limit: 1000 };
    if (cursor) body.cursor = cursor;

    const res = await fetch(`${base}/v2/inventory/counts/batch-retrieve`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-05-21', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Square inventory counts ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.counts) allCounts.push(...data.counts);
    cursor = data.cursor || null;
  } while (cursor);

  if (!allCounts.length) return { inventoryCountsUpserted: 0 };

  let inventoryCountsUpserted = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of allCounts) {
      await client.query(
        `INSERT INTO team_square.inventory_count
           (catalog_object_id, location_id, state, catalog_object_type, quantity, calculated_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (catalog_object_id, location_id, state) DO UPDATE SET
           catalog_object_type = EXCLUDED.catalog_object_type,
           quantity            = EXCLUDED.quantity,
           calculated_at       = EXCLUDED.calculated_at,
           synced_at           = NOW()`,
        [
          c.catalog_object_id   || null,
          c.location_id         || null,
          c.state               || null,
          c.catalog_object_type || null,
          c.quantity != null ? parseFloat(c.quantity) : null,
          c.calculated_at       || null,
        ]
      );
      inventoryCountsUpserted++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { inventoryCountsUpserted };
}
