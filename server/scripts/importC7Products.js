/**
 * One-shot Commerce7 product import.
 *
 * Fetches all products from Commerce7 and populates the product schema.
 * Safe to re-run — uses ON CONFLICT DO UPDATE so existing rows are refreshed.
 *
 * Usage (from server/):
 *   node scripts/importC7Products.js
 *   node scripts/importC7Products.js --company-id <uuid>   # single company only
 */

import { query, pool } from '../db.js';
import { c7FetchAll } from '../lib/commerce7Client.js';

const schema = process.env.DB_SCHEMA || 'teamtask_hub';

async function getCompanies(companyId) {
  const sql = companyId
    ? `SELECT id FROM ${schema}.companies WHERE id = $1`
    : `SELECT id FROM ${schema}.companies`;
  const r = await query(sql, companyId ? [companyId] : []);
  return r.rows;
}

async function getC7Integration(companyId) {
  const r = await query(
    `SELECT c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
     FROM ${schema}.company_integrations
     WHERE company_id = $1`,
    [companyId]
  );
  return r.rows[0] || null;
}

function parseWineStyle(type) {
  if (!type) return null;
  const t = String(type).toLowerCase();
  if (t.includes('red'))      return 'Red';
  if (t.includes('white'))    return 'White';
  if (t.includes('ros'))      return 'Rosé';
  if (t.includes('sparkling') || t.includes('bubble')) return 'Sparkling';
  if (t.includes('dessert') || t.includes('sweet'))   return 'Dessert';
  if (t.includes('fortif'))   return 'Fortified';
  return type;
}

function parseVintage(val) {
  if (!val) return null;
  const n = parseInt(val, 10);
  return (n >= 1900 && n <= 2100) ? n : null;
}

async function importCompany(companyId) {
  const integration = await getC7Integration(companyId);
  if (!integration?.c7_api_key) {
    console.log(`  [${companyId}] No C7 credentials — skipping`);
    return { skipped: true };
  }

  console.log(`  [${companyId}] Fetching products from Commerce7…`);
  let c7Products;
  try {
    c7Products = await c7FetchAll(integration, '/product', 'products', 100);
  } catch (err) {
    console.error(`  [${companyId}] C7 fetch failed: ${err.message}`);
    return { error: err.message };
  }
  console.log(`  [${companyId}] Fetched ${c7Products.length} products`);

  const client = await pool.connect();
  let imported = 0, variantsImported = 0;

  try {
    await client.query(`SET search_path TO product, ${schema}`);

    for (const p of c7Products) {
      // ── 1. Master product record ──────────────────────────────────────────
      const firstImage = p.images?.[0]?.url || p.image || null;
      const images = (p.images || []).map((img, i) => ({
        url: img.url || img,
        alt: img.alt || p.title || '',
        position: img.position ?? i,
      }));

      const prodRes = await client.query(
        `INSERT INTO product.products
           (company_id, name, description, vintage, varietal, wine_style,
            appellation, region, country, alcohol_pct, is_available,
            display_order, images)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          companyId,
          p.title || 'Unnamed Product',
          p.content || p.description || null,
          parseVintage(p.vintage),
          p.varietal || null,
          parseWineStyle(p.type),
          p.appellation || null,
          p.region || null,
          p.country || 'USA',
          p.alcoholPercent ? parseFloat(p.alcoholPercent) : null,
          p.isAvailable !== false,
          p.position ?? 0,
          JSON.stringify(images),
        ]
      );

      let productId;
      if (prodRes.rows.length > 0) {
        productId = prodRes.rows[0].id;
      } else {
        // Already exists — look it up via c7_product_id
        const lookup = await client.query(
          `SELECT p.id FROM product.products p
           JOIN product.c7_products c ON c.product_id = p.id
           WHERE c.c7_product_id = $1 AND p.company_id = $2`,
          [String(p.id), companyId]
        );
        if (!lookup.rows.length) {
          console.warn(`  [${companyId}] Could not resolve product for C7 id ${p.id} — skipping`);
          continue;
        }
        productId = lookup.rows[0].id;
      }

      // ── 2. C7 overlay ─────────────────────────────────────────────────────
      await client.query(
        `INSERT INTO product.c7_products
           (product_id, company_id, c7_product_id, c7_handle, teaser,
            winemaker_notes, residual_sugar, food_pairings, awards,
            club_eligible, available_channels, seo_title, seo_description,
            tags, sort_position, c7_created_at, c7_updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (product_id) DO UPDATE SET
           c7_product_id      = EXCLUDED.c7_product_id,
           c7_handle          = EXCLUDED.c7_handle,
           teaser             = EXCLUDED.teaser,
           winemaker_notes    = EXCLUDED.winemaker_notes,
           residual_sugar     = EXCLUDED.residual_sugar,
           food_pairings      = EXCLUDED.food_pairings,
           awards             = EXCLUDED.awards,
           club_eligible      = EXCLUDED.club_eligible,
           available_channels = EXCLUDED.available_channels,
           seo_title          = EXCLUDED.seo_title,
           seo_description    = EXCLUDED.seo_description,
           tags               = EXCLUDED.tags,
           sort_position      = EXCLUDED.sort_position,
           c7_updated_at      = EXCLUDED.c7_updated_at`,
        [
          productId, companyId, String(p.id),
          p.handle || null,
          p.teaser || null,
          p.winemakerNotes || null,
          p.residualSugar || null,
          p.foodPairings || [],
          JSON.stringify(p.awards || []),
          p.clubEligible || false,
          p.availableChannels || [],
          p.metaData?.title || null,
          p.metaData?.description || null,
          p.tags || [],
          p.position ?? 0,
          p.createdAt || null,
          p.updatedAt || null,
        ]
      );

      // ── 3. Sync status (starts as synced — data came from C7) ─────────────
      await client.query(
        `INSERT INTO product.sync_status (company_id, product_id, system, needs_push, last_synced_at)
         VALUES ($1,$2,'commerce7',false,NOW())
         ON CONFLICT (product_id, system) DO NOTHING`,
        [companyId, productId]
      );

      // ── 4. Variants ───────────────────────────────────────────────────────
      const variants = p.variants || p.skus || [];
      for (let ord = 0; ord < variants.length; ord++) {
        const v = variants[ord];
        if (!v || !v.id) continue;

        const varRes = await client.query(
          `INSERT INTO product.product_variants
             (product_id, company_id, volume_format, sku, price_cents,
              is_default, is_available, taxable, weight_oz, ordinal)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (product_id, volume_format) DO UPDATE SET
             sku          = EXCLUDED.sku,
             price_cents  = EXCLUDED.price_cents,
             is_available = EXCLUDED.is_available,
             taxable      = EXCLUDED.taxable,
             weight_oz    = EXCLUDED.weight_oz,
             updated_at   = NOW()
           RETURNING id`,
          [
            productId, companyId,
            v.volume || v.size || '750ml',
            v.sku || null,
            v.price != null ? Math.round(parseFloat(v.price) * 100) : null,
            ord === 0,
            v.isAvailable !== false,
            v.taxable !== false,
            v.weight ? parseFloat(v.weight) : null,
            ord,
          ]
        );

        const variantId = varRes.rows[0]?.id;
        if (!variantId) continue;

        await client.query(
          `INSERT INTO product.c7_variant_data
             (variant_id, company_id, c7_variant_id, member_price_cents, inventory_on_hand)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (variant_id) DO UPDATE SET
             c7_variant_id      = EXCLUDED.c7_variant_id,
             member_price_cents = EXCLUDED.member_price_cents,
             inventory_on_hand  = EXCLUDED.inventory_on_hand`,
          [
            variantId, companyId, String(v.id),
            v.memberPrice != null ? Math.round(parseFloat(v.memberPrice) * 100) : null,
            v.inventoryQuantity ?? v.inventoryOnHand ?? null,
          ]
        );
        variantsImported++;
      }

      imported++;
    }
  } finally {
    client.release();
  }

  return { imported, variantsImported };
}

async function run() {
  const args = process.argv.slice(2);
  const cidIdx = args.indexOf('--company-id');
  const targetCompanyId = cidIdx >= 0 ? args[cidIdx + 1] : null;

  console.log('Commerce7 product import starting…');
  const companies = await getCompanies(targetCompanyId);
  if (companies.length === 0) {
    console.log('No companies found.');
    process.exit(0);
  }

  let total = 0, totalVariants = 0, skipped = 0, errors = 0;
  for (const { id } of companies) {
    console.log(`Company ${id}:`);
    const result = await importCompany(id);
    if (result.skipped) { skipped++; continue; }
    if (result.error)   { errors++; continue; }
    total += result.imported;
    totalVariants += result.variantsImported;
    console.log(`  → ${result.imported} products, ${result.variantsImported} variants imported`);
  }

  console.log(`\nDone. ${total} products, ${totalVariants} variants imported. ${skipped} companies skipped (no C7 creds). ${errors} errors.`);
  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
