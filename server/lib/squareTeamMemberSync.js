/**
 * Square Team Members Sync → team_square.team_member + team_square.team_member_job_assignment
 *
 * Uses POST /v2/team-members/search — returns all fields including embedded
 * wage_setting and assigned_locations in a single call (no separate fetch needed).
 *
 * Two tables:
 *   team_member              — one row per person, all scalar fields
 *   team_member_job_assignment — one row per job role per person (array in API)
 *
 * Incremental: filters by updated_at >= lastSyncedAt - 1hr.
 * Initial: pulls all members regardless of status (ACTIVE + INACTIVE).
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

async function searchTeamMembers(token, base) {
  const members = [];
  let cursor = null;

  do {
    const body = { limit: 100 };
    if (cursor) body.cursor = cursor;

    const res = await fetch(`${base}/v2/team-members/search`, {
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
      throw new Error(`Square team-members search ${res.status}: ${err}`);
    }

    const data = await res.json();
    if (data.team_members) members.push(...data.team_members);
    cursor = data.cursor || null;
  } while (cursor);

  return members;
}

export async function runTeamMemberSync(companyId, lastSyncedAt = null) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  let members = await searchTeamMembers(token, base);

  // Filter client-side: team-members/search has no updated_at query param,
  // so we fetch all and skip members that haven't changed since last sync.
  if (lastSyncedAt && members.length) {
    const cutoff = new Date(new Date(lastSyncedAt).getTime() - 60 * 60 * 1000);
    members = members.filter((m) => !m.updated_at || new Date(m.updated_at) >= cutoff);
  }
  if (!members.length) return { teamMembersUpserted: 0, jobAssignmentsUpserted: 0 };

  let teamMembersUpserted = 0;
  let jobAssignmentsUpserted = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const m of members) {
      const ws = m.wage_setting || {};
      const al = m.assigned_locations || {};

      await client.query(
        `INSERT INTO team_square.team_member
           (id, reference_id, is_owner, status,
            given_name, family_name, email_address, phone_number,
            merchant_id,
            assigned_location_type, assigned_location_ids,
            wage_is_overtime_exempt, wage_version,
            wage_created_at, wage_updated_at,
            created_at, updated_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
         ON CONFLICT (id) DO UPDATE SET
           reference_id              = EXCLUDED.reference_id,
           is_owner                  = EXCLUDED.is_owner,
           status                    = EXCLUDED.status,
           given_name                = EXCLUDED.given_name,
           family_name               = EXCLUDED.family_name,
           email_address             = EXCLUDED.email_address,
           phone_number              = EXCLUDED.phone_number,
           merchant_id               = EXCLUDED.merchant_id,
           assigned_location_type    = EXCLUDED.assigned_location_type,
           assigned_location_ids     = EXCLUDED.assigned_location_ids,
           wage_is_overtime_exempt   = EXCLUDED.wage_is_overtime_exempt,
           wage_version              = EXCLUDED.wage_version,
           wage_created_at           = EXCLUDED.wage_created_at,
           wage_updated_at           = EXCLUDED.wage_updated_at,
           updated_at                = EXCLUDED.updated_at,
           synced_at                 = NOW()`,
        [
          m.id,
          m.reference_id                    || null,
          m.is_owner                        ?? false,
          m.status                          || null,
          m.given_name                      || null,
          m.family_name                     || null,
          m.email_address                   || null,
          m.phone_number                    || null,
          m.merchant_id                     || null,
          al.assignment_type                || null,
          al.location_ids?.length ? al.location_ids : null,
          ws.is_overtime_exempt             ?? null,
          ws.version                        ?? null,
          ws.created_at                     || null,
          ws.updated_at                     || null,
          m.created_at                      || null,
          m.updated_at                      || null,
        ]
      );
      teamMembersUpserted++;

      // Replace job assignments for this member atomically
      await client.query(
        `DELETE FROM team_square.team_member_job_assignment WHERE team_member_id = $1`,
        [m.id]
      );

      for (const ja of (ws.job_assignments || [])) {
        const hr = ja.hourly_rate || {};
        await client.query(
          `INSERT INTO team_square.team_member_job_assignment
             (team_member_id, job_id, job_title, pay_type,
              hourly_rate_amount, hourly_rate_currency, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
          [
            m.id,
            ja.job_id        || null,
            ja.job_title     || null,
            ja.pay_type      || null,
            hr.amount        ?? null,
            hr.currency      || null,
          ]
        );
        jobAssignmentsUpserted++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { teamMembersUpserted, jobAssignmentsUpserted };
}
