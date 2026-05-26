/**
 * Square Payments Sync → team_square.payment
 * Uses GET /v2/payments with begin_time for incremental sync.
 * Initial sync: 2 years. Incremental: since lastSyncedAt - 1hr.
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

export async function runPaymentSync(companyId, lastSyncedAt = null) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  const beginTime = lastSyncedAt
    ? new Date(new Date(lastSyncedAt).getTime() - 60 * 60 * 1000).toISOString()
    : new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();

  const payments = [];
  let cursor = null;
  do {
    const url = new URL(`${base}/v2/payments`);
    url.searchParams.set('begin_time', beginTime);
    url.searchParams.set('sort_order', 'ASC');
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-05-21' },
    });
    if (!res.ok) throw new Error(`Square payments ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.payments) payments.push(...data.payments);
    cursor = data.cursor || null;
  } while (cursor);

  if (!payments.length) return { paymentsUpserted: 0 };

  let paymentsUpserted = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of payments) {
      const am  = p.amount_money           || {};
      const tm  = p.total_money            || {};
      const tip = p.tip_money              || {};
      const fee = p.app_fee_money          || {};
      const ref = p.refunded_money         || {};
      const cd  = p.card_details?.card     || {};
      const dd  = p.device_details        || {};
      const cash = p.cash_details || {};

      await client.query(
        `INSERT INTO team_square.payment
           (id, status, source_type, location_id, order_id, team_member_id, employee_id,
            amount_money_amount, amount_money_currency,
            total_money_amount, total_money_currency,
            tip_money_amount, app_fee_money_amount, refunded_money_amount,
            note, receipt_number, receipt_url,
            device_id, device_name,
            card_brand, card_last_4, card_exp_month, card_exp_year, card_entry_method,
            buyer_cash_amount, change_back_cash_amount,
            created_at, updated_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NOW())
         ON CONFLICT (id) DO UPDATE SET
           status                  = EXCLUDED.status,
           order_id                = EXCLUDED.order_id,
           team_member_id          = EXCLUDED.team_member_id,
           total_money_amount      = EXCLUDED.total_money_amount,
           tip_money_amount        = EXCLUDED.tip_money_amount,
           refunded_money_amount   = EXCLUDED.refunded_money_amount,
           card_brand              = EXCLUDED.card_brand,
           card_last_4             = EXCLUDED.card_last_4,
           updated_at              = EXCLUDED.updated_at,
           synced_at               = NOW()`,
        [
          p.id,
          p.status         || null,
          p.source_type    || null,
          p.location_id    || null,
          p.order_id       || null,
          p.team_member_id || null,
          p.employee_id    || null,
          am.amount        ?? null,   am.currency  || null,
          tm.amount        ?? null,   tm.currency  || null,
          tip.amount       ?? null,
          fee.amount       ?? null,
          ref.amount       ?? null,
          p.note           || null,
          p.receipt_number || null,
          p.receipt_url    || null,
          dd.device_id     || null,
          dd.device_name   || null,
          cd.card_brand    || null,
          cd.last_4        || null,
          cd.exp_month     ?? null,
          cd.exp_year      ?? null,
          p.card_details?.entry_method || null,
          cash.buyer_supplied_money?.amount  ?? null,
          cash.change_back_money?.amount     ?? null,
          p.created_at     || null,
          p.updated_at     || null,
        ]
      );
      paymentsUpserted++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { paymentsUpserted };
}
