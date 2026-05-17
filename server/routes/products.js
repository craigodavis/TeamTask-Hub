/**
 * Product MDS routes — /api/products
 *
 * Phase 1: read-only list + detail (C7 data).
 * Phase 2+: create, update, sync to C7/Square.
 */

import express from 'express';
import { pool, query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const appSchema = process.env.DB_SCHEMA || 'teamtask_hub';

// Every handler uses pool.connect() so we can set search_path across both schemas.
async function withConn(fn) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO product, ${appSchema}`);
    return await fn(client);
  } finally {
    client.release();
  }
}

function cid(req) { return req.companyId; }

// ── GET /api/products ─────────────────────────────────────────────────────────
// Query params: vintage, varietal, wine_style, available (true/false),
//               archived (true/false, default false), search, limit, offset
router.get('/', requireAuth, async (req, res) => {
  try {
    const {
      vintage, varietal, wine_style, available,
      archived = 'false', search,
      limit = 50, offset = 0,
    } = req.query;

    const conditions = ['p.company_id = $1'];
    const params = [cid(req)];
    const add = (sql, val) => { params.push(val); conditions.push(`${sql} $${params.length}`); };

    if (archived !== 'true') conditions.push('p.is_archived = false');
    if (vintage)    add('p.vintage =',      parseInt(vintage, 10));
    if (varietal)   add('p.varietal ILIKE', `%${varietal}%`);
    if (wine_style) add('p.wine_style =',   wine_style);
    if (available !== undefined) add('p.is_available =', available === 'true');
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(p.name ILIKE $${params.length} OR p.varietal ILIKE $${params.length})`);
    }

    const where = conditions.join(' AND ');
    params.push(parseInt(limit, 10), parseInt(offset, 10));
    const limitPh  = `$${params.length - 1}`;
    const offsetPh = `$${params.length}`;

    const result = await withConn((client) => client.query(
      `SELECT
         p.id, p.name, p.vintage, p.varietal, p.wine_style, p.appellation,
         p.region, p.alcohol_pct, p.is_available, p.is_archived,
         p.display_order, p.images, p.created_at, p.updated_at,
         c7.c7_product_id, c7.c7_handle, c7.teaser,
         -- variant summary
         (SELECT COUNT(*) FROM product.product_variants v WHERE v.product_id = p.id) AS variant_count,
         (SELECT MIN(v.price_cents) FROM product.product_variants v WHERE v.product_id = p.id AND v.is_available = true) AS min_price_cents,
         -- sync status
         (SELECT s.needs_push FROM product.sync_status s WHERE s.product_id = p.id AND s.system = 'commerce7') AS c7_needs_push,
         (SELECT s.sync_error FROM product.sync_status s WHERE s.product_id = p.id AND s.system = 'commerce7') AS c7_sync_error,
         (SELECT s.last_synced_at FROM product.sync_status s WHERE s.product_id = p.id AND s.system = 'commerce7') AS c7_last_synced_at,
         (SELECT s.needs_push FROM product.sync_status s WHERE s.product_id = p.id AND s.system = 'square') AS sq_needs_push,
         (SELECT s.sync_error FROM product.sync_status s WHERE s.product_id = p.id AND s.system = 'square') AS sq_sync_error
       FROM product.products p
       LEFT JOIN product.c7_products c7 ON c7.product_id = p.id
       WHERE ${where}
       ORDER BY p.display_order ASC, p.vintage DESC, p.name ASC
       LIMIT ${limitPh} OFFSET ${offsetPh}`,
      params
    ));

    // Total count (without limit/offset)
    const countParams = params.slice(0, -2);
    const countRes = await withConn((client) => client.query(
      `SELECT COUNT(*) FROM product.products p WHERE ${where}`,
      countParams
    ));

    res.json({
      products: result.rows,
      total: parseInt(countRes.rows[0].count, 10),
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });
  } catch (err) {
    console.error('[products] GET / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/filters ─────────────────────────────────────────────────
// Returns distinct vintages, varietals, wine_styles for filter dropdowns
router.get('/filters', requireAuth, async (req, res) => {
  try {
    const result = await withConn((client) => client.query(
      `SELECT
         array_agg(DISTINCT p.vintage ORDER BY p.vintage DESC) FILTER (WHERE p.vintage IS NOT NULL) AS vintages,
         array_agg(DISTINCT p.varietal ORDER BY p.varietal)    FILTER (WHERE p.varietal IS NOT NULL) AS varietals,
         array_agg(DISTINCT p.wine_style ORDER BY p.wine_style) FILTER (WHERE p.wine_style IS NOT NULL) AS wine_styles
       FROM product.products p
       WHERE p.company_id = $1 AND p.is_archived = false`,
      [cid(req)]
    ));
    res.json(result.rows[0] || { vintages: [], varietals: [], wine_styles: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/:id ─────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await withConn(async (client) => {
      const [prod, c7, variants, syncRows] = await Promise.all([
        client.query(
          `SELECT * FROM product.products WHERE id = $1 AND company_id = $2`,
          [req.params.id, cid(req)]
        ),
        client.query(
          `SELECT * FROM product.c7_products WHERE product_id = $1`,
          [req.params.id]
        ),
        client.query(
          `SELECT v.*, cd.c7_variant_id, cd.member_price_cents, cd.inventory_on_hand
           FROM product.product_variants v
           LEFT JOIN product.c7_variant_data cd ON cd.variant_id = v.id
           WHERE v.product_id = $1
           ORDER BY v.ordinal ASC`,
          [req.params.id]
        ),
        client.query(
          `SELECT system, needs_push, last_synced_at, sync_error, retry_count
           FROM product.sync_status WHERE product_id = $1`,
          [req.params.id]
        ),
      ]);
      return { prod, c7, variants, syncRows };
    });

    if (!result.prod.rows.length) return res.status(404).json({ error: 'Product not found' });

    const syncStatus = {};
    for (const s of result.syncRows.rows) syncStatus[s.system] = s;

    res.json({
      ...result.prod.rows[0],
      c7: result.c7.rows[0] || null,
      variants: result.variants.rows,
      sync: syncStatus,
    });
  } catch (err) {
    console.error('[products] GET /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/products/import/c7 ─────────────────────────────────────────────
// Trigger a C7 product import for this company from the UI.
// Runs inline (synchronous) — suitable for < a few hundred products.
router.post('/import/c7', requireAuth, async (req, res) => {
  try {
    const companyId = cid(req);
    // Load credentials
    const credsRes = await query(
      `SELECT c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
       FROM ${appSchema}.company_integrations WHERE company_id = $1`,
      [companyId]
    );
    const integration = credsRes.rows[0];
    if (!integration?.c7_api_key) {
      return res.status(400).json({ error: 'Commerce7 not configured. Set credentials in Settings → Commerce7.' });
    }

    const { c7FetchAll } = await import('../lib/commerce7Client.js');
    console.log(`[products/import-c7] Starting import for company ${companyId}`);
    const c7Products = await c7FetchAll(integration, '/product', 'products', 100);
    console.log(`[products/import-c7] Fetched ${c7Products.length} products`);

    const client = await pool.connect();
    let imported = 0, updated = 0, variantsImported = 0;

    try {
      await client.query(`SET search_path TO product, ${appSchema}`);

      for (const p of c7Products) {
        const images = (p.images || []).map((img, i) => ({
          url: img.url || img, alt: img.alt || p.title || '', position: img.position ?? i,
        }));

        const vintage = (() => {
          const n = parseInt(p.vintage, 10);
          return (n >= 1900 && n <= 2100) ? n : null;
        })();

        const wineStyle = (() => {
          const t = String(p.type || '').toLowerCase();
          if (t.includes('red')) return 'Red';
          if (t.includes('white')) return 'White';
          if (t.includes('ros')) return 'Rosé';
          if (t.includes('sparkling') || t.includes('bubble')) return 'Sparkling';
          if (t.includes('dessert') || t.includes('sweet')) return 'Dessert';
          if (t.includes('fortif')) return 'Fortified';
          return p.type || null;
        })();

        // Check if already imported (by c7_product_id)
        const existing = await client.query(
          `SELECT p.id FROM product.products p
           JOIN product.c7_products c ON c.product_id = p.id
           WHERE c.c7_product_id = $1 AND p.company_id = $2`,
          [String(p.id), companyId]
        );

        let productId;
        if (existing.rows.length > 0) {
          productId = existing.rows[0].id;
          // Update master fields
          await client.query(
            `UPDATE product.products SET
               name = $1, description = $2, vintage = $3, varietal = $4,
               wine_style = $5, appellation = $6, region = $7, country = $8,
               alcohol_pct = $9, is_available = $10, images = $11, updated_at = NOW()
             WHERE id = $12`,
            [
              p.title || 'Unnamed Product',
              p.content || p.description || null,
              vintage, p.varietal || null, wineStyle,
              p.appellation || null, p.region || null, p.country || 'USA',
              p.alcoholPercent ? parseFloat(p.alcoholPercent) : null,
              p.isAvailable !== false,
              JSON.stringify(images),
              productId,
            ]
          );
          updated++;
        } else {
          const ins = await client.query(
            `INSERT INTO product.products
               (company_id, name, description, vintage, varietal, wine_style,
                appellation, region, country, alcohol_pct, is_available, display_order, images)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING id`,
            [
              companyId, p.title || 'Unnamed Product',
              p.content || p.description || null,
              vintage, p.varietal || null, wineStyle,
              p.appellation || null, p.region || null, p.country || 'USA',
              p.alcoholPercent ? parseFloat(p.alcoholPercent) : null,
              p.isAvailable !== false, p.position ?? 0,
              JSON.stringify(images),
            ]
          );
          productId = ins.rows[0].id;
          imported++;
        }

        // C7 overlay upsert
        await client.query(
          `INSERT INTO product.c7_products
             (product_id, company_id, c7_product_id, c7_handle, teaser, winemaker_notes,
              residual_sugar, food_pairings, awards, club_eligible, available_channels,
              seo_title, seo_description, tags, sort_position, c7_created_at, c7_updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (product_id) DO UPDATE SET
             c7_product_id = EXCLUDED.c7_product_id, c7_handle = EXCLUDED.c7_handle,
             teaser = EXCLUDED.teaser, winemaker_notes = EXCLUDED.winemaker_notes,
             food_pairings = EXCLUDED.food_pairings, awards = EXCLUDED.awards,
             club_eligible = EXCLUDED.club_eligible, available_channels = EXCLUDED.available_channels,
             tags = EXCLUDED.tags, c7_updated_at = EXCLUDED.c7_updated_at`,
          [
            productId, companyId, String(p.id), p.handle || null, p.teaser || null,
            p.winemakerNotes || null, p.residualSugar || null,
            p.foodPairings || [], JSON.stringify(p.awards || []),
            p.clubEligible || false, p.availableChannels || [],
            p.metaData?.title || null, p.metaData?.description || null,
            p.tags || [], p.position ?? 0, p.createdAt || null, p.updatedAt || null,
          ]
        );

        // Sync status
        await client.query(
          `INSERT INTO product.sync_status (company_id, product_id, system, needs_push, last_synced_at)
           VALUES ($1,$2,'commerce7',false,NOW())
           ON CONFLICT (product_id, system) DO UPDATE SET last_synced_at = NOW(), needs_push = false`,
          [companyId, productId]
        );

        // Variants
        const variants = p.variants || p.skus || [];
        for (let ord = 0; ord < variants.length; ord++) {
          const v = variants[ord];
          if (!v?.id) continue;
          const varRes = await client.query(
            `INSERT INTO product.product_variants
               (product_id, company_id, volume_format, sku, price_cents,
                is_default, is_available, taxable, weight_oz, ordinal)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (product_id, volume_format) DO UPDATE SET
               sku = EXCLUDED.sku, price_cents = EXCLUDED.price_cents,
               is_available = EXCLUDED.is_available, updated_at = NOW()
             RETURNING id`,
            [
              productId, companyId, v.volume || v.size || '750ml', v.sku || null,
              v.price != null ? Math.round(parseFloat(v.price) * 100) : null,
              ord === 0, v.isAvailable !== false, v.taxable !== false,
              v.weight ? parseFloat(v.weight) : null, ord,
            ]
          );
          const variantId = varRes.rows[0]?.id;
          if (!variantId) continue;
          await client.query(
            `INSERT INTO product.c7_variant_data
               (variant_id, company_id, c7_variant_id, member_price_cents, inventory_on_hand)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (variant_id) DO UPDATE SET
               c7_variant_id = EXCLUDED.c7_variant_id,
               member_price_cents = EXCLUDED.member_price_cents,
               inventory_on_hand = EXCLUDED.inventory_on_hand`,
            [
              variantId, companyId, String(v.id),
              v.memberPrice != null ? Math.round(parseFloat(v.memberPrice) * 100) : null,
              v.inventoryQuantity ?? v.inventoryOnHand ?? null,
            ]
          );
          variantsImported++;
        }
      }
    } finally {
      client.release();
    }

    console.log(`[products/import-c7] Done: ${imported} new, ${updated} updated, ${variantsImported} variants`);
    res.json({ ok: true, imported, updated, variants: variantsImported, total: c7Products.length });
  } catch (err) {
    console.error('[products/import-c7]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export { router as productsRouter };
