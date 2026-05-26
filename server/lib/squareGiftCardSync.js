/**
 * Square Gift Cards Sync → team_square.gift_card
 * Uses GET /v2/gift-cards — full sync every run (small dataset, no time filter).
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

export async function runGiftCardSync(companyId) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  const giftCards = [];
  let cursor = null;
  do {
    const url = new URL(`${base}/v2/gift-cards`);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-05-21' },
    });
    if (!res.ok) throw new Error(`Square gift-cards ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.gift_cards) giftCards.push(...data.gift_cards);
    cursor = data.cursor || null;
  } while (cursor);

  if (!giftCards.length) return { giftCardsUpserted: 0 };

  let giftCardsUpserted = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const gc of giftCards) {
      const bal = gc.balance_money || {};
      await client.query(
        `INSERT INTO team_square.gift_card
           (id, type, gan_source, state, balance_amount, balance_currency, gan, created_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (id) DO UPDATE SET
           state            = EXCLUDED.state,
           balance_amount   = EXCLUDED.balance_amount,
           balance_currency = EXCLUDED.balance_currency,
           synced_at        = NOW()`,
        [
          gc.id,
          gc.type       || null,
          gc.gan_source || null,
          gc.state      || null,
          bal.amount    ?? null,
          bal.currency  || null,
          gc.gan        || null,
          gc.created_at || null,
        ]
      );
      giftCardsUpserted++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { giftCardsUpserted };
}
