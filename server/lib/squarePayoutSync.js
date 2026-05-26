/**
 * Square Payouts Sync → team_square.payout + team_square.payout_fee
 * Uses GET /v2/payouts with begin_time for incremental sync.
 * Initial sync: 2 years. Incremental: since lastSyncedAt - 1hr.
 *
 * payout_fee rows are replaced (DELETE + INSERT) on every sync so fee
 * adjustments (e.g. retroactive Square Capital charges) stay accurate.
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

export async function runPayoutSync(companyId, lastSyncedAt = null) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  const beginTime = lastSyncedAt
    ? new Date(new Date(lastSyncedAt).getTime() - 60 * 60 * 1000).toISOString()
    : new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();

  const payouts = [];
  let cursor = null;
  do {
    const url = new URL(`${base}/v2/payouts`);
    url.searchParams.set('begin_time', beginTime);
    url.searchParams.set('sort_order', 'ASC');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-05-21' },
    });
    if (!res.ok) throw new Error(`Square payouts ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.payouts) payouts.push(...data.payouts);
    cursor = data.cursor || null;
  } while (cursor);

  if (!payouts.length) return { payoutsUpserted: 0, payoutFeesUpserted: 0 };

  let payoutsUpserted   = 0;
  let payoutFeesUpserted = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const p of payouts) {
      const am  = p.amount_money  || {};
      const dst = p.destination   || {};

      await client.query(
        `INSERT INTO team_square.payout
           (id, status, location_id,
            amount_amount, amount_currency,
            destination_type, destination_id,
            type, arrival_date, end_to_end_id, version,
            created_at, updated_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (id) DO UPDATE SET
           status           = EXCLUDED.status,
           amount_amount    = EXCLUDED.amount_amount,
           amount_currency  = EXCLUDED.amount_currency,
           destination_type = EXCLUDED.destination_type,
           destination_id   = EXCLUDED.destination_id,
           arrival_date     = EXCLUDED.arrival_date,
           version          = EXCLUDED.version,
           updated_at       = EXCLUDED.updated_at,
           synced_at        = NOW()`,
        [
          p.id,
          p.status        || null,
          p.location_id   || null,
          am.amount       ?? null,
          am.currency     || null,
          dst.type        || null,
          dst.id          || null,
          p.type          || null,
          p.arrival_date  || null,
          p.end_to_end_id || null,
          p.version       ?? null,
          p.created_at    || null,
          p.updated_at    || null,
        ]
      );
      payoutsUpserted++;

      // Replace fee rows for this payout
      await client.query(`DELETE FROM team_square.payout_fee WHERE payout_id = $1`, [p.id]);
      for (const f of (p.payout_fee || [])) {
        const fm = f.amount_money || {};
        await client.query(
          `INSERT INTO team_square.payout_fee
             (payout_id, type, effective_at, amount_amount, amount_currency, synced_at)
           VALUES ($1,$2,$3,$4,$5,NOW())`,
          [
            p.id,
            f.type         || null,
            f.effective_at || null,
            fm.amount      ?? null,
            fm.currency    || null,
          ]
        );
        payoutFeesUpserted++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { payoutsUpserted, payoutFeesUpserted };
}
