/**
 * Live Square sales — queried directly from Square's Orders API (source of
 * truth), used to cross-check the synced team_square DB and catch sync drift.
 * Dates are 'YYYY-MM-DD'; the range is treated as UTC day bounds (approximate —
 * fine for the >2% drift threshold used by the reconciliation).
 */
import { query } from '../db.js';

async function getSquareConfig(companyId) {
  const r = await query(
    `SELECT square_access_token, square_env FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const row = r.rows[0];
  const token = row?.square_access_token?.trim() || process.env.SQUARE_ACCESS_TOKEN || '';
  const env   = row?.square_env?.trim()          || process.env.SQUARE_ENV           || 'production';
  const base  = env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  return { token, base };
}

const round2 = (cents) => Math.round(cents) / 100;

// Returns { total, order_count, byDay: { 'YYYY-MM-DD': { total, count } }, locations: [names] }
export async function fetchLiveSquareSales(companyId, startDate, endDate, locationName = null) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  const locRes = await fetch(`${base}/v2/locations`, {
    headers: { Authorization: `Bearer ${token}`, 'Square-Version': '2025-05-21' },
  });
  if (!locRes.ok) throw new Error(`Square locations ${locRes.status}: ${await locRes.text()}`);
  const locData = await locRes.json();
  let locations = (locData.locations || []).filter((l) => l.status === 'ACTIVE');
  if (locationName) {
    const match = locations.filter((l) => (l.name || '').toLowerCase().includes(locationName.toLowerCase()));
    if (match.length) locations = match;
  }
  const locationIds = locations.map((l) => l.id);
  if (!locationIds.length) return { total: 0, order_count: 0, byDay: {}, locations: [] };

  const startAt = `${startDate}T00:00:00.000Z`;
  const endAt   = `${endDate}T23:59:59.999Z`;
  let cursor = null, totalCents = 0, count = 0;
  const byDayCents = {};

  do {
    const body = {
      location_ids: locationIds,
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
          state_filter: { states: ['COMPLETED'] },
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;
    const res = await fetch(`${base}/v2/orders/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Square-Version': '2025-05-21', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Square orders search ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const o of (data.orders || [])) {
      const amt = o.total_money?.amount || 0;
      const day = (o.created_at || '').slice(0, 10);
      totalCents += amt; count++;
      if (day) {
        if (!byDayCents[day]) byDayCents[day] = { total: 0, count: 0 };
        byDayCents[day].total += amt; byDayCents[day].count++;
      }
    }
    cursor = data.cursor || null;
  } while (cursor);

  const byDay = {};
  for (const [d, v] of Object.entries(byDayCents)) byDay[d] = { total: round2(v.total), count: v.count };
  return { total: round2(totalCents), order_count: count, byDay, locations: locations.map((l) => l.name) };
}
