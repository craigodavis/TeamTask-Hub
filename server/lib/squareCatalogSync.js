/**
 * Square Catalog Sync → team_square schema
 *
 * Pulls ITEM, ITEM_VARIATION, CATEGORY, TAX from the Square Catalog API
 * and upserts into team_square.* tables. Fivetran's square.* tables are
 * left untouched.
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

// Uses Search API (not List) so include_deleted_objects works —
// List API ignores that param, Search API respects it.
async function fetchCatalogObjects(token, base, objectTypes) {
  const objects = [];
  let cursor = null;
  do {
    const body = {
      object_types:            objectTypes,
      include_deleted_objects: true,
      include_related_objects: false,
    };
    if (cursor) body.cursor = cursor;

    const res = await fetch(`${base}/v2/catalog/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Square-Version': '2025-05-21',
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Square Catalog Search ${res.status}: ${err}`);
    }
    const data = await res.json();
    if (data.objects) objects.push(...data.objects);
    cursor = data.cursor || null;
  } while (cursor);
  return objects;
}

export async function runCatalogSync(companyId) {
  const { token, base } = await getSquareConfig(companyId);
  if (!token) throw new Error('Square access token not configured');

  // Record sync job start
  const jobRes = await query(
    `INSERT INTO square_catalog_sync_jobs (company_id) VALUES ($1) RETURNING id`,
    [companyId]
  );
  const jobId = jobRes.rows[0].id;

  let counts = { items: 0, variations: 0, categories: 0, taxes: 0 };

  try {
    // Fetch all types in parallel
    const [rawItems, rawCats, rawTaxes, rawVariations] = await Promise.all([
      fetchCatalogObjects(token, base, ['ITEM']),
      fetchCatalogObjects(token, base, ['CATEGORY']),
      fetchCatalogObjects(token, base, ['TAX']),
      fetchCatalogObjects(token, base, ['ITEM_VARIATION']),
    ]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ── Categories ────────────────────────────────────────────────────────
      for (const obj of rawCats) {
        const d = obj.category_data || {};
        await client.query(
          `INSERT INTO team_square.catalog_category
             (id, name, category_type, is_top_level, parent_category_id,
              image_ids, version, is_deleted, updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (id) DO UPDATE SET
             name               = EXCLUDED.name,
             category_type      = EXCLUDED.category_type,
             is_top_level       = EXCLUDED.is_top_level,
             parent_category_id = EXCLUDED.parent_category_id,
             image_ids          = EXCLUDED.image_ids,
             version            = EXCLUDED.version,
             is_deleted         = EXCLUDED.is_deleted,
             updated_at         = EXCLUDED.updated_at,
             synced_at          = NOW()`,
          [
            obj.id,
            d.name                          || null,
            d.category_type                 || null,
            d.is_top_level                  ?? null,
            d.parent_category?.id           || null,
            d.image_ids?.length ? d.image_ids : null,
            obj.version                     || null,
            obj.is_deleted                  || false,
            obj.updated_at                  || null,
          ]
        );
        counts.categories++;
      }

      // ── Taxes ─────────────────────────────────────────────────────────────
      for (const obj of rawTaxes) {
        const d = obj.tax_data || {};
        await client.query(
          `INSERT INTO team_square.catalog_tax
             (id, name, calculation_phase, inclusion_type, percentage,
              applies_to_custom_amounts, enabled, tax_type_id,
              version, is_deleted, updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
           ON CONFLICT (id) DO UPDATE SET
             name                      = EXCLUDED.name,
             calculation_phase         = EXCLUDED.calculation_phase,
             inclusion_type            = EXCLUDED.inclusion_type,
             percentage                = EXCLUDED.percentage,
             applies_to_custom_amounts = EXCLUDED.applies_to_custom_amounts,
             enabled                   = EXCLUDED.enabled,
             tax_type_id               = EXCLUDED.tax_type_id,
             version                   = EXCLUDED.version,
             is_deleted                = EXCLUDED.is_deleted,
             updated_at                = EXCLUDED.updated_at,
             synced_at                 = NOW()`,
          [
            obj.id,
            d.name                     || null,
            d.calculation_phase        || null,
            d.inclusion_type           || null,
            d.percentage != null ? parseFloat(d.percentage) : null,
            d.applies_to_custom_amounts ?? null,
            d.enabled                  ?? null,
            d.tax_type_id              || null,
            obj.version                || null,
            obj.is_deleted             || false,
            obj.updated_at             || null,
          ]
        );
        counts.taxes++;
      }

      // ── Items + their nested Variations ───────────────────────────────────
      for (const obj of rawItems) {
        const d = obj.item_data || {};

        await client.query(
          `INSERT INTO team_square.catalog_item
             (id, name, description, description_html, description_plaintext,
              abbreviation, label_color, available_online, available_for_pickup,
              available_electronically, category_id, image_url, image_ids,
              product_type, skip_modifier_screen, tax_ids,
              reporting_category_id, reporting_category_ordinal,
              present_at_all_locations, ecom_available, ecom_visibility,
              version, is_deleted, is_archived, updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW())
           ON CONFLICT (id) DO UPDATE SET
             name                        = EXCLUDED.name,
             description                 = EXCLUDED.description,
             description_html            = EXCLUDED.description_html,
             description_plaintext       = EXCLUDED.description_plaintext,
             abbreviation                = EXCLUDED.abbreviation,
             label_color                 = EXCLUDED.label_color,
             available_online            = EXCLUDED.available_online,
             available_for_pickup        = EXCLUDED.available_for_pickup,
             available_electronically    = EXCLUDED.available_electronically,
             category_id                 = EXCLUDED.category_id,
             image_url                   = EXCLUDED.image_url,
             image_ids                   = EXCLUDED.image_ids,
             product_type                = EXCLUDED.product_type,
             skip_modifier_screen        = EXCLUDED.skip_modifier_screen,
             tax_ids                     = EXCLUDED.tax_ids,
             reporting_category_id       = EXCLUDED.reporting_category_id,
             reporting_category_ordinal  = EXCLUDED.reporting_category_ordinal,
             present_at_all_locations    = EXCLUDED.present_at_all_locations,
             ecom_available              = EXCLUDED.ecom_available,
             ecom_visibility             = EXCLUDED.ecom_visibility,
             version                     = EXCLUDED.version,
             is_deleted                  = EXCLUDED.is_deleted,
             is_archived                 = EXCLUDED.is_archived,
             updated_at                  = EXCLUDED.updated_at,
             synced_at                   = NOW()`,
          [
            obj.id,
            d.name                         || null,
            d.description                  || null,
            d.description_html             || null,
            d.description_plaintext        || null,
            d.abbreviation                 || null,
            d.label_color                  || null,
            d.available_online             ?? null,
            d.available_for_pickup         ?? null,
            d.available_electronically     ?? null,
            d.category_id                  || null,
            d.image_url                    || null,
            d.image_ids?.length ? d.image_ids : null,
            d.product_type                 || null,
            d.skip_modifier_screen         ?? null,
            d.tax_ids?.length ? d.tax_ids : null,
            d.reporting_category?.id       || null,
            d.reporting_category?.ordinal  ?? null,
            obj.present_at_all_locations   ?? null,
            d.ecom_available               ?? null,
            d.ecom_visibility              || null,
            obj.version                    || null,
            obj.is_deleted                 || false,
            // Archived lives on item_data, not on the object like is_deleted —
            // which is how it came to be missed.
            d.is_archived                  || false,
            obj.updated_at                 || null,
          ]
        );
        counts.items++;

      }

      // ── Variations ────────────────────────────────────────────────────────
      // Nested variations (from ITEM) + top-level ITEM_VARIATION objects.
      // Square OMITS the nested variations array for ARCHIVED items, so without
      // the top-level pass every sold-out SKU's historical orders fail to resolve
      // to their item/category — 2,055 line items (4.4% of 2025-26 sales) were
      // orphaned that way, making correctly-categorized wine look "uncategorized".
      const allVariations = [
        ...rawItems.flatMap((it) => (it.item_data?.variations || []).map((v) => ({ v, itemId: it.id }))),
        ...rawVariations.map((v) => ({ v, itemId: v.item_variation_data?.item_id || null })),
      ];
      for (const { v, itemId } of allVariations) {
        const vd = v.item_variation_data || {};
        await client.query(
          `INSERT INTO team_square.catalog_item_variation
             (id, item_id, name, sku, upc, ordinal, pricing_type,
              price_money_amount, price_money_currency, track_inventory,
              inventory_alert_type, inventory_alert_threshold, user_data,
              service_duration, available_for_booking, sellable, stockable,
              measurement_unit_id, version, is_deleted, updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
           ON CONFLICT (id) DO UPDATE SET
             item_id                   = EXCLUDED.item_id,
             name                      = EXCLUDED.name,
             sku                       = EXCLUDED.sku,
             upc                       = EXCLUDED.upc,
             ordinal                   = EXCLUDED.ordinal,
             pricing_type              = EXCLUDED.pricing_type,
             price_money_amount        = EXCLUDED.price_money_amount,
             price_money_currency      = EXCLUDED.price_money_currency,
             track_inventory           = EXCLUDED.track_inventory,
             inventory_alert_type      = EXCLUDED.inventory_alert_type,
             inventory_alert_threshold = EXCLUDED.inventory_alert_threshold,
             user_data                 = EXCLUDED.user_data,
             service_duration          = EXCLUDED.service_duration,
             available_for_booking     = EXCLUDED.available_for_booking,
             sellable                  = EXCLUDED.sellable,
             stockable                 = EXCLUDED.stockable,
             measurement_unit_id       = EXCLUDED.measurement_unit_id,
             version                   = EXCLUDED.version,
             is_deleted                = EXCLUDED.is_deleted,
             updated_at                = EXCLUDED.updated_at,
             synced_at                 = NOW()`,
          [
            v.id,
            itemId,
            vd.name                      || null,
            vd.sku                       || null,
            vd.upc                       || null,
            vd.ordinal                   ?? null,
            vd.pricing_type              || null,
            vd.price_money?.amount       ?? null,
            vd.price_money?.currency     || null,
            vd.track_inventory           ?? null,
            vd.inventory_alert_type      || null,
            vd.inventory_alert_threshold ?? null,
            vd.user_data                 || null,
            vd.service_duration          ?? null,
            vd.available_for_booking     ?? null,
            vd.sellable                  ?? null,
            vd.stockable                 ?? null,
            vd.measurement_unit_id       || null,
            v.version                    || null,
            v.is_deleted                 || false,
            v.updated_at                 || null,
          ]
        );
        counts.variations++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const total = counts.items + counts.variations + counts.categories + counts.taxes;
    await query(
      `UPDATE square_catalog_sync_jobs
       SET status = 'completed', completed_at = NOW(),
           items_upserted = $1, cats_upserted = $2
       WHERE id = $3`,
      [counts.items + counts.variations, counts.categories + counts.taxes, jobId]
    );

    return { jobId, ...counts, total };
  } catch (err) {
    await query(
      `UPDATE square_catalog_sync_jobs
       SET status = 'error', completed_at = NOW(), error = $1 WHERE id = $2`,
      [err.message, jobId]
    );
    throw err;
  }
}

export async function getLastSyncJob(companyId) {
  const r = await query(
    `SELECT * FROM square_catalog_sync_jobs WHERE company_id = $1 ORDER BY started_at DESC LIMIT 1`,
    [companyId]
  );
  return r.rows[0] || null;
}
