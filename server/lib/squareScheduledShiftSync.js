/**
 * Square Scheduled Shifts Sync → team_square.scheduled_shift
 *
 * Uses POST /v2/labor/scheduled-shifts/search (requires Square-Version 2025-05-21+
 * and Team Management feature enabled on the Square account).
 *
 * Each record has:
 *   draft_shift_details   — always present (pending/unpublished edits)
 *   published_shift_details — present only once the shift has been published
 *
 * Incremental: filters by updated_at >= lastSyncedAt - 1hr buffer.
 * Initial: pulls all records (no date filter; Square returns everything).
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

async function searchScheduledShifts(token, base, updatedAfter) {
  const shifts = [];
  let cursor = null;

  do {
    // Build query filter — only add updated_at filter on incremental runs
    const body = { limit: 50 };

    if (updatedAfter) {
      const startAt = new Date(
        new Date(updatedAfter).getTime() - 60 * 60 * 1000
      ).toISOString();
      body.query = {
        filter: {
          updated_at: { start_at: startAt },
        },
      };
    }

    if (cursor) body.cursor = cursor;

    const res = await fetch(`${base}/v2/labor/scheduled-shifts/search`, {
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
      throw new Error(`Square scheduled-shifts search ${res.status}: ${err}`);
    }

    const data = await res.json();
    if (data.scheduled_shifts) shifts.push(...data.scheduled_shifts);
    cursor = data.cursor || null;
  } while (cursor);

  return shifts;
}

export async function runScheduledShiftSync(companyId, lastSyncedAt = null) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  const shifts = await searchScheduledShifts(token, base, lastSyncedAt);
  if (!shifts.length) return { scheduledShiftsUpserted: 0 };

  let scheduledShiftsUpserted = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const s of shifts) {
      const d = s.draft_shift_details     || {};
      const p = s.published_shift_details || null;

      await client.query(
        `INSERT INTO team_square.scheduled_shift
           (id,
            draft_team_member_id, draft_location_id, draft_job_id,
            draft_start_at, draft_end_at, draft_timezone, draft_is_deleted,
            pub_team_member_id, pub_location_id, pub_job_id,
            pub_start_at, pub_end_at, pub_timezone, pub_is_deleted,
            version, created_at, updated_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
         ON CONFLICT (id) DO UPDATE SET
           draft_team_member_id = EXCLUDED.draft_team_member_id,
           draft_location_id    = EXCLUDED.draft_location_id,
           draft_job_id         = EXCLUDED.draft_job_id,
           draft_start_at       = EXCLUDED.draft_start_at,
           draft_end_at         = EXCLUDED.draft_end_at,
           draft_timezone       = EXCLUDED.draft_timezone,
           draft_is_deleted     = EXCLUDED.draft_is_deleted,
           pub_team_member_id   = EXCLUDED.pub_team_member_id,
           pub_location_id      = EXCLUDED.pub_location_id,
           pub_job_id           = EXCLUDED.pub_job_id,
           pub_start_at         = EXCLUDED.pub_start_at,
           pub_end_at           = EXCLUDED.pub_end_at,
           pub_timezone         = EXCLUDED.pub_timezone,
           pub_is_deleted       = EXCLUDED.pub_is_deleted,
           version              = EXCLUDED.version,
           updated_at           = EXCLUDED.updated_at,
           synced_at            = NOW()`,
        [
          s.id,
          d.team_member_id || null,
          d.location_id    || null,
          d.job_id         || null,
          d.start_at       || null,
          d.end_at         || null,
          d.timezone       || null,
          d.is_deleted     ?? false,
          p?.team_member_id || null,
          p?.location_id    || null,
          p?.job_id         || null,
          p?.start_at       || null,
          p?.end_at         || null,
          p?.timezone       || null,
          p?.is_deleted     ?? null,
          s.version         ?? null,
          s.created_at      || null,
          s.updated_at      || null,
        ]
      );
      scheduledShiftsUpserted++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { scheduledShiftsUpserted };
}
