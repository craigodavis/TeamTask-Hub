/**
 * Square Invoices Sync → team_square.invoice + team_square.invoice_payment_request
 * Uses GET /v2/invoices per location (location_id required).
 * Full sync every run — invoice counts are small.
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

async function fetchInvoicesForLocation(token, base, locationId) {
  const invoices = [];
  let cursor = null;
  do {
    const url = new URL(`${base}/v2/invoices`);
    url.searchParams.set('location_id', locationId);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-05-21' },
    });
    if (!res.ok) throw new Error(`Square invoices ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.invoices) invoices.push(...data.invoices);
    cursor = data.cursor || null;
  } while (cursor);
  return invoices;
}

export async function runInvoiceSync(companyId) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  // Fetch active location IDs
  const locRes = await fetch(`${base}/v2/locations`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-05-21' },
  });
  if (!locRes.ok) throw new Error(`Square locations ${locRes.status}: ${await locRes.text()}`);
  const locData = await locRes.json();
  const locationIds = (locData.locations || []).map(l => l.id);

  const allInvoices = [];
  for (const locId of locationIds) {
    const inv = await fetchInvoicesForLocation(token, base, locId);
    allInvoices.push(...inv);
  }

  if (!allInvoices.length) return { invoicesUpserted: 0, paymentRequestsUpserted: 0 };

  let invoicesUpserted = 0;
  let paymentRequestsUpserted = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const inv of allInvoices) {
      const rec = inv.primary_recipient || {};
      await client.query(
        `INSERT INTO team_square.invoice
           (id, version, location_id, order_id, invoice_number, title, description,
            status, delivery_method, timezone, public_url, creator_team_member_id,
            recipient_customer_id, recipient_given_name, recipient_family_name,
            recipient_email_address, recipient_phone_number,
            created_at, updated_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
         ON CONFLICT (id) DO UPDATE SET
           version                  = EXCLUDED.version,
           status                   = EXCLUDED.status,
           invoice_number           = EXCLUDED.invoice_number,
           title                    = EXCLUDED.title,
           description              = EXCLUDED.description,
           recipient_customer_id    = EXCLUDED.recipient_customer_id,
           recipient_given_name     = EXCLUDED.recipient_given_name,
           recipient_family_name    = EXCLUDED.recipient_family_name,
           recipient_email_address  = EXCLUDED.recipient_email_address,
           recipient_phone_number   = EXCLUDED.recipient_phone_number,
           updated_at               = EXCLUDED.updated_at,
           synced_at                = NOW()`,
        [
          inv.id,
          inv.version                    ?? null,
          inv.location_id                || null,
          inv.order_id                   || null,
          inv.invoice_number             || null,
          inv.title                      || null,
          inv.description                || null,
          inv.status                     || null,
          inv.delivery_method            || null,
          inv.timezone                   || null,
          inv.public_url                 || null,
          inv.creator_team_member_id     || null,
          rec.customer_id                || null,
          rec.given_name                 || null,
          rec.family_name                || null,
          rec.email_address              || null,
          rec.phone_number               || null,
          inv.created_at                 || null,
          inv.updated_at                 || null,
        ]
      );
      invoicesUpserted++;

      // Replace payment requests
      await client.query(`DELETE FROM team_square.invoice_payment_request WHERE invoice_id = $1`, [inv.id]);
      for (const pr of (inv.payment_requests || [])) {
        await client.query(
          `INSERT INTO team_square.invoice_payment_request
             (invoice_id, uid, request_type, due_date, tipping_enabled,
              computed_amount, total_completed_amount, automatic_payment_source, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
          [
            inv.id,
            pr.uid                          || null,
            pr.request_type                 || null,
            pr.due_date                     || null,
            pr.tipping_enabled              ?? null,
            pr.computed_amount_money?.amount        ?? null,
            pr.total_completed_amount_money?.amount ?? null,
            pr.automatic_payment_source     || null,
          ]
        );
        paymentRequestsUpserted++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { invoicesUpserted, paymentRequestsUpserted };
}
