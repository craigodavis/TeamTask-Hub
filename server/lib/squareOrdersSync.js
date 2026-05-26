/**
 * Square Orders Sync → team_square.order + team_square.order_line_item
 *
 * Incremental: on subsequent runs, only fetches orders updated since
 * the last sync (stored in square_sync_objects.last_synced_at).
 *
 * Initial sync pulls all COMPLETED orders from the past 2 years.
 */

import { query, pool } from '../db.js';

async function getSquareConfig(companyId) {
  const r = await query(
    `SELECT square_access_token, square_env FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const row = r.rows[0];
  const token = row?.square_access_token?.trim() || process.env.SQUARE_ACCESS_TOKEN || '';
  const env   = row?.square_env?.trim()          || process.env.SQUARE_ENV           || 'production';
  const base  = env === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
  return { token, base };
}

async function getLocationIds(token, base) {
  const res = await fetch(`${base}/v2/locations`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-05-21' },
  });
  if (!res.ok) throw new Error(`Square locations ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.locations || []).filter(l => l.status === 'ACTIVE').map(l => l.id);
}

async function searchOrders(token, base, locationIds, updatedAfter) {
  const orders = [];
  let cursor = null;

  const startAt = updatedAfter
    ? new Date(new Date(updatedAfter).getTime() - 60 * 60 * 1000).toISOString() // 1hr buffer
    : new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();       // 2yr initial

  do {
    const body = {
      location_ids: locationIds,
      query: {
        filter: {
          date_time_filter: { updated_at: { start_at: startAt } },
          state_filter:     { states: ['COMPLETED', 'CANCELED'] },
        },
        sort: { sort_field: 'UPDATED_AT', sort_order: 'ASC' },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;

    const res = await fetch(`${base}/v2/orders/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Square-Version': '2025-05-21',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Square orders search ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.orders) orders.push(...data.orders);
    cursor = data.cursor || null;
  } while (cursor);

  return orders;
}

export async function runOrdersSync(companyId, lastSyncedAt = null) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  const locationIds = await getLocationIds(token, base);
  if (!locationIds.length) throw new Error('No active Square locations found');

  const orders = await searchOrders(token, base, locationIds, lastSyncedAt);
  if (!orders.length) return { ordersUpserted: 0, lineItemsUpserted: 0 };

  let ordersUpserted    = 0;
  let lineItemsUpserted = 0;

  // Process in batches of 200 to keep transactions small and avoid OOM on
  // large initial pulls (can be 20k+ orders across 2 years).
  const BATCH = 200;
  for (let i = 0; i < orders.length; i += BATCH) {
    const batch  = orders.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const o of batch) {
        const m   = o.total_money                  || {};
        const mt  = o.total_tax_money              || {};
        const md  = o.total_discount_money         || {};
        const mti = o.total_tip_money              || {};
        const ms  = o.total_service_charge_money   || {};
        const mn  = o.net_amounts?.total_money     || {};

        await client.query(
          `INSERT INTO team_square.order
             (id, location_id, reference_id, customer_id, state, ticket_name,
              order_source_name, total_money_amount, total_money_currency,
              total_tax_amount, total_tax_currency,
              total_discount_amount, total_discount_currency,
              total_tip_amount, total_tip_currency,
              total_service_charge_amount, total_service_charge_currency,
              net_amount_total_money_amount,
              created_at, updated_at, closed_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
           ON CONFLICT (id) DO UPDATE SET
             state                         = EXCLUDED.state,
             customer_id                   = EXCLUDED.customer_id,
             ticket_name                   = EXCLUDED.ticket_name,
             total_money_amount            = EXCLUDED.total_money_amount,
             total_tax_amount              = EXCLUDED.total_tax_amount,
             total_discount_amount         = EXCLUDED.total_discount_amount,
             total_tip_amount              = EXCLUDED.total_tip_amount,
             total_service_charge_amount   = EXCLUDED.total_service_charge_amount,
             net_amount_total_money_amount = EXCLUDED.net_amount_total_money_amount,
             updated_at                    = EXCLUDED.updated_at,
             closed_at                     = EXCLUDED.closed_at,
             synced_at                     = NOW()`,
          [
            o.id, o.location_id || null, o.reference_id || null, o.customer_id || null,
            o.state || null, o.ticket_name || null,
            o.source?.name || null,
            m.amount   ?? null, m.currency   || null,
            mt.amount  ?? null, mt.currency  || null,
            md.amount  ?? null, md.currency  || null,
            mti.amount ?? null, mti.currency || null,
            ms.amount  ?? null, ms.currency  || null,
            mn.amount  ?? null,
            o.created_at || null, o.updated_at || null, o.closed_at || null,
          ]
        );
        ordersUpserted++;

        for (const li of (o.line_items || [])) {
          const bp = li.base_price_money     || {};
          const gs = li.gross_sales_money    || {};
          const tt = li.total_tax_money      || {};
          const td = li.total_discount_money || {};
          const tm = li.total_money          || {};

          await client.query(
            `INSERT INTO team_square.order_line_item
               (order_id, uid, name, quantity, note, catalog_object_id, catalog_version,
                variation_name, item_type, base_price_amount, base_price_currency,
                gross_sales_amount, total_tax_amount, total_discount_amount,
                total_amount, total_currency, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
             ON CONFLICT (order_id, uid) DO UPDATE SET
               name                  = EXCLUDED.name,
               quantity              = EXCLUDED.quantity,
               catalog_object_id     = EXCLUDED.catalog_object_id,
               catalog_version       = EXCLUDED.catalog_version,
               variation_name        = EXCLUDED.variation_name,
               item_type             = EXCLUDED.item_type,
               base_price_amount     = EXCLUDED.base_price_amount,
               gross_sales_amount    = EXCLUDED.gross_sales_amount,
               total_tax_amount      = EXCLUDED.total_tax_amount,
               total_discount_amount = EXCLUDED.total_discount_amount,
               total_amount          = EXCLUDED.total_amount,
               synced_at             = NOW()`,
            [
              o.id, li.uid, li.name || null,
              li.quantity != null ? parseFloat(li.quantity) : null,
              li.note || null, li.catalog_object_id || null,
              li.catalog_version || null, li.variation_name || null,
              li.item_type || null,
              bp.amount ?? null, bp.currency || null,
              gs.amount ?? null,
              tt.amount ?? null,
              td.amount ?? null,
              tm.amount ?? null, tm.currency || null,
            ]
          );
          lineItemsUpserted++;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { ordersUpserted, lineItemsUpserted };
}
