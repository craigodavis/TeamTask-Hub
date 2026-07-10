/**
 * Square Timecards Sync → team_square.shift + team_square.shift_break
 *
 * Uses POST /v2/labor/timecards/search (Square API v2025-05-21+).
 * The older /v2/labor/shifts/search endpoint is still backward-compatible
 * but "timecards" is the canonical name going forward. The response key
 * changed from "shifts" to "timecards"; the record shape is identical
 * except employee_id is no longer returned (team_member_id only).
 *
 * Incremental: Square's timecard search filter only supports filtering by
 * start_at, not by when a record was last modified — there is no "updated
 * since" filter available. A cursor that only advances forward would
 * permanently miss a shift that closes (goes OPEN → CLOSED) after the
 * cursor has moved past its start_at. So instead of advancing a cursor,
 * every incremental run re-scans a fixed rolling window (30 days) so any
 * shift that started recently gets its current status re-checked on every
 * run. Upserts are idempotent, so re-fetching unchanged shifts is cheap.
 *
 * Initial sync (no prior run) pulls all timecards from the past 2 years.
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

async function searchTimecards(token, base, locationIds, updatedAfter) {
  const timecards = [];
  let cursor = null;

  // Rolling 30-day window on incremental (re-checks status on every run,
  // see file header); full 2-year window on initial sync.
  const startAt = updatedAfter
    ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    : new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();

  do {
    const body = {
      query: {
        filter: {
          location_ids: locationIds,
          start: { start_at: startAt },
        },
      },
      limit: 200,
    };
    if (cursor) body.cursor = cursor;

    const res = await fetch(`${base}/v2/labor/timecards/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Square-Version': '2025-05-21',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Square timecards search ${res.status}: ${err}`);
    }
    const data = await res.json();
    // New API returns "timecards"; fall back to "shifts" for sandbox/older responses
    if (data.timecards) timecards.push(...data.timecards);
    else if (data.shifts) timecards.push(...data.shifts);
    cursor = data.cursor || null;
  } while (cursor);

  return timecards;
}

export async function runShiftSync(companyId, lastSyncedAt = null) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  const locationIds = await getLocationIds(token, base);
  if (!locationIds.length) throw new Error('No active Square locations found');

  const timecards = await searchTimecards(token, base, locationIds, lastSyncedAt);
  if (!timecards.length) return { shiftsUpserted: 0, breaksUpserted: 0 };

  let shiftsUpserted = 0;
  let breaksUpserted = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const s of timecards) {
      const w  = s.wage || {};
      const hr = w.hourly_rate || {};
      const ct = s.declared_cash_tip_money || {};

      await client.query(
        `INSERT INTO team_square.shift
           (id, employee_id, team_member_id, location_id, timezone,
            start_at, end_at, status,
            wage_title, wage_hourly_rate_amount, wage_hourly_rate_currency,
            wage_job_id, wage_tip_eligible,
            declared_cash_tip_amount, declared_cash_tip_currency,
            version, created_at, updated_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
         ON CONFLICT (id) DO UPDATE SET
           -- employee_id intentionally not overwritten: new API omits it but
           -- historical rows may have it populated from the old shifts endpoint
           team_member_id               = EXCLUDED.team_member_id,
           location_id                  = EXCLUDED.location_id,
           timezone                     = EXCLUDED.timezone,
           start_at                     = EXCLUDED.start_at,
           end_at                       = EXCLUDED.end_at,
           status                       = EXCLUDED.status,
           wage_title                   = EXCLUDED.wage_title,
           wage_hourly_rate_amount      = EXCLUDED.wage_hourly_rate_amount,
           wage_hourly_rate_currency    = EXCLUDED.wage_hourly_rate_currency,
           wage_job_id                  = EXCLUDED.wage_job_id,
           wage_tip_eligible            = EXCLUDED.wage_tip_eligible,
           declared_cash_tip_amount     = EXCLUDED.declared_cash_tip_amount,
           declared_cash_tip_currency   = EXCLUDED.declared_cash_tip_currency,
           version                      = EXCLUDED.version,
           updated_at                   = EXCLUDED.updated_at,
           synced_at                    = NOW()`,
        [
          s.id,
          s.employee_id    || null,   // null for new timecards API responses
          s.team_member_id || null,
          s.location_id    || null,
          s.timezone       || null,
          s.start_at       || null,
          s.end_at         || null,
          s.status         || null,
          w.title          || null,
          hr.amount        ?? null,
          hr.currency      || null,
          w.job_id         || null,
          w.tip_eligible   ?? null,
          ct.amount        ?? null,
          ct.currency      || null,
          s.version        ?? null,
          s.created_at     || null,
          s.updated_at     || null,
        ]
      );
      shiftsUpserted++;

      // Upsert nested breaks
      for (const b of (s.breaks || [])) {
        await client.query(
          `INSERT INTO team_square.shift_break
             (id, shift_id, break_type_id, name, start_at, end_at,
              expected_duration, is_paid, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (id) DO UPDATE SET
             break_type_id     = EXCLUDED.break_type_id,
             name              = EXCLUDED.name,
             start_at          = EXCLUDED.start_at,
             end_at            = EXCLUDED.end_at,
             expected_duration = EXCLUDED.expected_duration,
             is_paid           = EXCLUDED.is_paid,
             synced_at         = NOW()`,
          [
            b.id,
            s.id,
            b.break_type_id     || null,
            b.name              || null,
            b.start_at          || null,
            b.end_at            || null,
            b.expected_duration || null,
            b.is_paid           ?? null,
          ]
        );
        breaksUpserted++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { shiftsUpserted, breaksUpserted };
}
