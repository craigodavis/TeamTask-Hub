/**
 * Square Locations Sync → team_square.location
 *
 * Simple GET /v2/locations — returns all locations (ACTIVE + INACTIVE).
 * No pagination needed (Square returns all locations in one call).
 * Full sync every time; only 3 locations so incremental is unnecessary.
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
  const base  = env === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
  return { token, base };
}

export async function runLocationSync(companyId) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  const res = await fetch(`${base}/v2/locations`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Square-Version': '2025-05-21',
    },
  });
  if (!res.ok) throw new Error(`Square locations ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const locations = data.locations || [];
  if (!locations.length) return { locationsUpserted: 0 };

  let locationsUpserted = 0;

  for (const loc of locations) {
    const addr = loc.address    || {};
    const coords = loc.coordinates || {};

    await query(
      `INSERT INTO team_square.location
         (id, name, status, type, merchant_id, business_name, business_email,
          phone_number, website_url, description, timezone,
          country, language_code, currency,
          address_line_1, address_line_2, address_line_3,
          address_locality, address_sublocality,
          address_administrative_district_level_1, address_postal_code, address_country,
          latitude, longitude, mcc, full_format_logo_url,
          capabilities, created_at, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name                                  = EXCLUDED.name,
         status                                = EXCLUDED.status,
         type                                  = EXCLUDED.type,
         merchant_id                           = EXCLUDED.merchant_id,
         business_name                         = EXCLUDED.business_name,
         business_email                        = EXCLUDED.business_email,
         phone_number                          = EXCLUDED.phone_number,
         website_url                           = EXCLUDED.website_url,
         description                           = EXCLUDED.description,
         timezone                              = EXCLUDED.timezone,
         country                               = EXCLUDED.country,
         language_code                         = EXCLUDED.language_code,
         currency                              = EXCLUDED.currency,
         address_line_1                        = EXCLUDED.address_line_1,
         address_line_2                        = EXCLUDED.address_line_2,
         address_line_3                        = EXCLUDED.address_line_3,
         address_locality                      = EXCLUDED.address_locality,
         address_sublocality                   = EXCLUDED.address_sublocality,
         address_administrative_district_level_1 = EXCLUDED.address_administrative_district_level_1,
         address_postal_code                   = EXCLUDED.address_postal_code,
         address_country                       = EXCLUDED.address_country,
         latitude                              = EXCLUDED.latitude,
         longitude                             = EXCLUDED.longitude,
         mcc                                   = EXCLUDED.mcc,
         full_format_logo_url                  = EXCLUDED.full_format_logo_url,
         capabilities                          = EXCLUDED.capabilities,
         synced_at                             = NOW()`,
      [
        loc.id,
        loc.name                       || null,
        loc.status                     || null,
        loc.type                       || null,
        loc.merchant_id                || null,
        loc.business_name              || null,
        loc.business_email             || null,
        loc.phone_number               || null,
        loc.website_url                || null,
        loc.description                || null,
        loc.timezone                   || null,
        loc.country                    || null,
        loc.language_code              || null,
        loc.currency                   || null,
        addr.address_line_1            || null,
        addr.address_line_2            || null,
        addr.address_line_3            || null,
        addr.locality                  || null,
        addr.sublocality               || null,
        addr.administrative_district_level_1 || null,
        addr.postal_code               || null,
        addr.country                   || null,
        coords.latitude                ?? null,
        coords.longitude               ?? null,
        loc.mcc                        || null,
        loc.full_format_logo_url       || null,
        loc.capabilities?.length ? loc.capabilities : null,
        loc.created_at                 || null,
      ]
    );
    locationsUpserted++;
  }

  return { locationsUpserted };
}
