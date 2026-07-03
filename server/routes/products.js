/**
 * Product MDS routes — /api/products
 *
 * Phase 1: read-only list + detail (C7 data).
 * Phase 2+: create, update, sync to C7/Square.
 */

import express from 'express';
import { pool, query } from '../db.js';
import { requireAuth, requireManager } from '../middleware/auth.js';
import { runCatalogSync, getLastSyncJob } from '../lib/squareCatalogSync.js';

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
      vintage, varietal, wine_style, available, product_type,
      archived = 'false', search,
      limit = 50, offset = 0,
    } = req.query;

    const conditions = ['p.company_id = $1'];
    const params = [cid(req)];
    const add = (sql, val) => { params.push(val); conditions.push(`${sql} $${params.length}`); };

    if (archived !== 'true') conditions.push('p.is_archived = false');
    if (vintage)      add('p.vintage =',       parseInt(vintage, 10));
    if (varietal)     add('p.varietal ILIKE',  `%${varietal}%`);
    if (wine_style)   add('p.wine_style =',    wine_style);
    if (product_type) add('p.product_type =',  product_type);
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
         p.region, p.alcohol_pct, p.is_available, p.is_archived, p.product_type,
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
         array_agg(DISTINCT p.wine_style ORDER BY p.wine_style) FILTER (WHERE p.wine_style IS NOT NULL) AS wine_styles,
         array_agg(DISTINCT p.product_type ORDER BY p.product_type) FILTER (WHERE p.product_type IS NOT NULL) AS product_types
       FROM product.products p
       WHERE p.company_id = $1 AND p.is_archived = false`,
      [cid(req)]
    ));
    res.json(result.rows[0] || { vintages: [], varietals: [], wine_styles: [], product_types: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/square-items ───────────────────────────────────────────
// Must be before /:id to avoid Express treating "square-items" as an id param.
router.get('/square-items', requireAuth, requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT
         ci.name,
         cc.name AS category_name
       FROM team_square.catalog_item ci
       LEFT JOIN team_square.catalog_category cc ON cc.id = ci.category_id
       JOIN team_square.catalog_item_variation v
            ON v.item_id = ci.id AND v.is_deleted = false AND v.price_money_amount > 0
       WHERE ci.is_deleted = false
         AND (ci.tax_ids IS NULL OR array_length(ci.tax_ids, 1) IS NULL)
       GROUP BY ci.name, cc.name
       ORDER BY cc.name NULLS LAST, ci.name`
    );
    res.json({ items: r.rows }); // [{ name, category_name }]
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/tax-exempt ─────────────────────────────────────────────
router.get('/tax-exempt', requireAuth, requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, item_name, created_at FROM tax_exempt_square_items
       WHERE company_id = $1 ORDER BY item_name`,
      [cid(req)]
    );
    res.json({ items: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/tax-gap ─────────────────────────────────────────────────
// Catalog-based check: items with NO tax configured in Square that are not on
// the company's tax-exempt list. These items will never charge tax at the POS
// regardless of how they're sold. Betty calls this endpoint.
router.get('/tax-gap', requireAuth, requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT
         ci.id,
         ci.name,
         cc.name                    AS category_name,
         NOT ci.is_deleted          AS is_active,
         MIN(v.price_money_amount)  AS min_price,
         MAX(v.price_money_amount)  AS max_price
       FROM team_square.catalog_item ci
       LEFT JOIN team_square.catalog_category cc ON cc.id = ci.category_id
       JOIN team_square.catalog_item_variation v
            ON v.item_id = ci.id AND v.price_money_amount > 0
       LEFT JOIN ${appSchema}.tax_exempt_square_items te
            ON te.item_name = ci.name AND te.company_id = $1
       WHERE (ci.tax_ids IS NULL OR array_length(ci.tax_ids, 1) IS NULL)
         AND te.id IS NULL
       GROUP BY ci.id, ci.name, cc.name, ci.is_deleted
       ORDER BY ci.is_deleted ASC, cc.name NULLS LAST, ci.name`,
      [cid(req)]
    );
    res.json({ items: r.rows, total: r.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/catalog-tax-gaps ───────────────────────────────────────
// Items in the Square catalog that have NO taxes configured (tax_ids is null/empty).
// These were likely entered incorrectly and will never charge tax at sale time.
router.get('/catalog-tax-gaps', requireAuth, requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT
         ci.id,
         ci.name,
         ci.product_type,
         cc.name                    AS category_name,
         NOT ci.is_deleted          AS is_active,
         MIN(v.price_money_amount)  AS min_price,
         MAX(v.price_money_amount)  AS max_price
       FROM team_square.catalog_item ci
       LEFT JOIN team_square.catalog_category cc ON cc.id = ci.category_id
       JOIN team_square.catalog_item_variation v
            ON v.item_id = ci.id AND v.price_money_amount > 0
       LEFT JOIN ${appSchema}.tax_exempt_square_items te
            ON te.item_name = ci.name AND te.company_id = $1
       WHERE (ci.tax_ids IS NULL OR array_length(ci.tax_ids, 1) IS NULL)
         AND te.id IS NULL
       GROUP BY ci.id, ci.name, ci.product_type, cc.name, ci.is_deleted
       ORDER BY ci.is_deleted ASC, cc.name NULLS LAST, ci.name`,
      [cid(req)]
    );
    res.json({ items: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/products/catalog-sync ──────────────────────────────────────────
// Trigger an immediate Square catalog sync for this company.
router.post('/catalog-sync', requireAuth, requireManager, async (req, res) => {
  try {
    const result = await runCatalogSync(cid(req));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/catalog-sync/status ────────────────────────────────────
router.get('/catalog-sync/status', requireAuth, requireManager, async (req, res) => {
  try {
    const job = await getLastSyncJob(cid(req));
    res.json({ job: job || null });
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
    const c7Products = await c7FetchAll(integration, '/product', 'products', 50);
    console.log(`[products/import-c7] Fetched ${c7Products.length} products`);

    const client = await pool.connect();
    let imported = 0, updated = 0, variantsImported = 0;

    try {
      await client.query(`SET search_path TO product, ${appSchema}`);

      for (const p of c7Products) {
        // C7 nests wine attributes under p.wine
        const wine = p.wine || {};

        // Images: C7 uses { src, formats, sortOrder } — map to { url, alt, position }
        const images = (p.images || []).map((img, i) => ({
          url: img.src || img.formats?.medium?.src || img.formats?.large?.src || '',
          alt: p.title || '',
          position: img.sortOrder ?? i,
        }));

        const vintage = (() => {
          const n = parseInt(wine.vintage ?? p.vintage, 10);
          return (n >= 1900 && n <= 2100) ? n : null;
        })();

        // wine.type is the wine style (Red/White/Rosé/etc). p.type is a different,
        // top-level Commerce7 field (Wine vs Non-Wine) — captured separately below
        // as product_type. These used to be incorrectly conflated here.
        const wineStyle = (() => {
          const t = String(wine.type || '').toLowerCase();
          if (t.includes('red')) return 'Red';
          if (t.includes('white')) return 'White';
          if (t.includes('ros')) return 'Rosé';
          if (t.includes('sparkling') || t.includes('bubble')) return 'Sparkling';
          if (t.includes('dessert') || t.includes('sweet')) return 'Dessert';
          if (t.includes('fortif')) return 'Fortified';
          return wine.type || null;
        })();
        const productType = p.type || null;

        // C7 uses webStatus / adminStatus, not isAvailable
        const isAvailable = p.webStatus === 'Available' || p.adminStatus === 'Available';

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
               alcohol_pct = $9, is_available = $10, images = $11, product_type = $12, updated_at = NOW()
             WHERE id = $13`,
            [
              p.title || 'Unnamed Product',
              p.content || null,
              vintage,
              wine.varietal || p.subTitle || null,
              wineStyle,
              wine.appellation || null,
              wine.region || null,
              wine.countryCode || 'USA',
              null, // alcohol is per-variant in C7
              isAvailable,
              JSON.stringify(images),
              productType,
              productId,
            ]
          );
          updated++;
        } else {
          const ins = await client.query(
            `INSERT INTO product.products
               (company_id, name, description, vintage, varietal, wine_style,
                appellation, region, country, alcohol_pct, is_available, display_order, images, product_type)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             RETURNING id`,
            [
              companyId,
              p.title || 'Unnamed Product',
              p.content || null,
              vintage,
              wine.varietal || p.subTitle || null,
              wineStyle,
              wine.appellation || null,
              wine.region || null,
              wine.countryCode || 'USA',
              null, // alcohol is per-variant in C7
              isAvailable,
              p.sortOrder ?? 0,
              JSON.stringify(images),
              productType,
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
            productId, companyId, String(p.id),
            p.slug || null,          // C7 uses slug not handle
            p.teaser || null,
            p.wine?.winemakerNotes || null,
            p.wine?.residualSugar || null,
            p.wine?.foodPairings || [],
            JSON.stringify(p.metaData?.awards || []),
            false,                   // clubEligible not in list API
            [],                      // availableChannels not in list API
            p.seo?.title || null,
            p.seo?.description || null,
            p.metaData?.tags || [],
            p.sortOrder ?? 0,
            p.createdAt || null,
            p.updatedAt || null,
          ]
        );

        // Sync status
        await client.query(
          `INSERT INTO product.sync_status (company_id, product_id, system, needs_push, last_synced_at)
           VALUES ($1,$2,'commerce7',false,NOW())
           ON CONFLICT (product_id, system) DO UPDATE SET last_synced_at = NOW(), needs_push = false`,
          [companyId, productId]
        );

        // Variants — C7 prices are already in cents; volumeInML → human label
        const variants = p.variants || [];
        for (let ord = 0; ord < variants.length; ord++) {
          const v = variants[ord];
          if (!v?.id) continue;

          // Convert mL to a human-readable format label
          const volumeLabel = (() => {
            const ml = parseInt(v.volumeInML, 10);
            if (!ml) return '750ml';
            if (ml === 187) return '187ml';
            if (ml === 375) return '375ml';
            if (ml === 500) return '500ml';
            if (ml === 750) return '750ml';
            if (ml === 1000) return '1L';
            if (ml === 1500) return '1.5L';
            if (ml === 3000) return '3L';
            if (ml === 6000) return '6L';
            return `${ml}ml`;
          })();

          // C7 price is in cents already (7000 = $70.00)
          const priceCents = v.price != null ? Math.round(parseFloat(v.price)) : null;

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
              productId, companyId, volumeLabel, v.sku || null,
              priceCents,
              ord === 0,
              true,   // C7 doesn't surface isAvailable per-variant in list API
              true,   // assume taxable
              v.weight ? Math.round(parseFloat(v.weight) * 16) : null, // lbs → oz
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
               c7_variant_id = EXCLUDED.c7_variant_id,
               member_price_cents = EXCLUDED.member_price_cents,
               inventory_on_hand = EXCLUDED.inventory_on_hand`,
            [
              variantId, companyId, String(v.id),
              null,   // member price not in list API
              v.inventory?.quantity ?? null,
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

// ── Helper: build C7 API payload from our internal field names ────────────────
function buildC7Payload(body) {
  const p = {};
  if (body.name !== undefined)        p.title = body.name;
  if (body.description !== undefined) p.content = body.description ?? null;
  if (body.teaser !== undefined)      p.teaser = body.teaser ?? null;
  if (body.slug !== undefined)        p.slug = body.slug || undefined;

  if (body.is_available !== undefined) {
    const status = body.is_available ? 'Available' : 'Not Available';
    p.webStatus = status;
    p.adminStatus = status;
  }

  const wine = {};
  if (body.wine_style !== undefined)  wine.type = body.wine_style ?? null;
  if (body.vintage !== undefined)     wine.vintage = body.vintage || null;
  if (body.varietal !== undefined)    wine.varietal = body.varietal ?? null;
  if (body.appellation !== undefined) wine.appellation = body.appellation ?? null;
  if (body.region !== undefined)      wine.region = body.region ?? null;
  if (body.country !== undefined)     wine.countryCode = body.country || 'US';
  if (Object.keys(wine).length)       p.wine = wine;

  const seo = {};
  if (body.seo_title !== undefined)       seo.title = body.seo_title ?? null;
  if (body.seo_description !== undefined) seo.description = body.seo_description ?? null;
  if (Object.keys(seo).length)            p.seo = seo;

  const meta = {};
  if (body.tasting_notes !== undefined)   meta['tasting-notes'] = body.tasting_notes ?? null;
  if (body.winemaker_notes !== undefined) meta['wine-maker-s-notes'] = body.winemaker_notes ?? null;
  if (body.pairing_notes !== undefined)   meta['pairing-notes'] = body.pairing_notes ?? null;
  if (body.release_date !== undefined)    meta['release-date'] = body.release_date ?? null;
  if (body.cases_produced !== undefined)  meta['cases-produced'] = body.cases_produced ?? null;
  if (body.origin_vineyard !== undefined) meta['origin-vineyard'] = body.origin_vineyard ?? null;
  if (body.label_story !== undefined)     meta['label-story'] = body.label_story ?? null;
  if (body.awards !== undefined)          meta.awards = body.awards ?? null;
  if (body.tags !== undefined)            meta.tags = body.tags ?? [];
  if (Object.keys(meta).length)           p.metaData = meta;

  return p;
}

// Helper: load full product by id (same shape as GET /:id)
async function loadFullProduct(client, productId, companyId) {
  const [prod, c7, variants, syncRows] = await Promise.all([
    client.query(
      `SELECT * FROM product.products WHERE id = $1 AND company_id = $2`,
      [productId, companyId]
    ),
    client.query(
      `SELECT * FROM product.c7_products WHERE product_id = $1`,
      [productId]
    ),
    client.query(
      `SELECT v.*, cd.c7_variant_id, cd.member_price_cents, cd.inventory_on_hand
       FROM product.product_variants v
       LEFT JOIN product.c7_variant_data cd ON cd.variant_id = v.id
       WHERE v.product_id = $1
       ORDER BY v.ordinal ASC`,
      [productId]
    ),
    client.query(
      `SELECT system, needs_push, last_synced_at, sync_error, retry_count
       FROM product.sync_status WHERE product_id = $1`,
      [productId]
    ),
  ]);

  const syncStatus = {};
  for (const s of syncRows.rows) syncStatus[s.system] = s;

  return {
    ...prod.rows[0],
    c7: c7.rows[0] || null,
    variants: variants.rows,
    sync: syncStatus,
  };
}

// ── PUT /api/products/:id ─────────────────────────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  const companyId = cid(req);
  const productId = req.params.id;

  try {
    const client = await pool.connect();
    let c7Error = null;

    try {
      await client.query(`SET search_path TO product, ${appSchema}`);

      // Verify ownership
      const check = await client.query(
        `SELECT id FROM product.products WHERE id = $1 AND company_id = $2`,
        [productId, companyId]
      );
      if (!check.rows.length) {
        return res.status(404).json({ error: 'Product not found' });
      }

      const b = req.body;

      // Update products table
      const prodFields = [];
      const prodVals = [];
      const addProd = (col, val) => { prodVals.push(val); prodFields.push(`${col} = $${prodVals.length}`); };

      if (b.name !== undefined)         addProd('name', b.name);
      if (b.description !== undefined)  addProd('description', b.description ?? null);
      if (b.vintage !== undefined)      addProd('vintage', b.vintage ? parseInt(b.vintage, 10) : null);
      if (b.varietal !== undefined)     addProd('varietal', b.varietal ?? null);
      if (b.wine_style !== undefined)   addProd('wine_style', b.wine_style ?? null);
      if (b.product_type !== undefined) addProd('product_type', b.product_type ?? null);
      if (b.appellation !== undefined)  addProd('appellation', b.appellation ?? null);
      if (b.region !== undefined)       addProd('region', b.region ?? null);
      if (b.country !== undefined)      addProd('country', b.country ?? null);
      if (b.is_available !== undefined) addProd('is_available', Boolean(b.is_available));
      if (b.is_archived !== undefined)  addProd('is_archived', Boolean(b.is_archived));

      if (prodFields.length) {
        prodVals.push(productId);
        await client.query(
          `UPDATE product.products SET ${prodFields.join(', ')}, updated_at = NOW() WHERE id = $${prodVals.length}`,
          prodVals
        );
      }

      // Upsert c7_products overlay
      const c7Fields = ['product_id', 'company_id'];
      const c7Vals = [productId, companyId];
      const c7Updates = [];
      const addC7 = (col, val) => {
        c7Vals.push(val);
        c7Fields.push(col);
        c7Updates.push(`${col} = EXCLUDED.${col}`);
      };

      if (b.slug !== undefined)            addC7('c7_handle', b.slug ?? null);
      if (b.teaser !== undefined)          addC7('teaser', b.teaser ?? null);
      if (b.winemaker_notes !== undefined) addC7('winemaker_notes', b.winemaker_notes ?? null);
      if (b.seo_title !== undefined)       addC7('seo_title', b.seo_title ?? null);
      if (b.seo_description !== undefined) addC7('seo_description', b.seo_description ?? null);
      if (b.tags !== undefined)            addC7('tags', JSON.stringify(b.tags ?? []));

      if (c7Fields.length > 2) {
        const placeholders = c7Vals.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO product.c7_products (${c7Fields.join(', ')})
           VALUES (${placeholders})
           ON CONFLICT (product_id) DO UPDATE SET ${c7Updates.join(', ')}`,
          c7Vals
        );
      }

      // Push to C7 if credentials + c7_product_id exist
      const credsRes = await query(
        `SELECT c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
         FROM ${appSchema}.company_integrations WHERE company_id = $1`,
        [companyId]
      );
      const integration = credsRes.rows[0];

      const c7Row = await client.query(
        `SELECT c7_product_id FROM product.c7_products WHERE product_id = $1`,
        [productId]
      );
      const c7ProductId = c7Row.rows[0]?.c7_product_id;

      if (integration?.c7_api_key && c7ProductId) {
        try {
          const { makeC7Client } = await import('../lib/commerce7Client.js');
          const c7 = makeC7Client(integration);
          const payload = buildC7Payload(b);
          await c7.put(`/product/${c7ProductId}`, payload);

          // Update variants in C7 if provided
          if (Array.isArray(b.variants)) {
            for (const v of b.variants) {
              if (!v.id) continue;
              // Get c7_variant_id
              const cvRow = await client.query(
                `SELECT cd.c7_variant_id FROM product.product_variants pv
                 JOIN product.c7_variant_data cd ON cd.variant_id = pv.id
                 WHERE pv.id = $1 AND pv.product_id = $2`,
                [v.id, productId]
              );
              const c7VariantId = cvRow.rows[0]?.c7_variant_id;

              // Update local variant
              const vFields = [];
              const vVals = [];
              const addV = (col, val) => { vVals.push(val); vFields.push(`${col} = $${vVals.length}`); };
              if (v.sku !== undefined)           addV('sku', v.sku ?? null);
              if (v.price_cents !== undefined)   addV('price_cents', v.price_cents != null ? parseInt(v.price_cents, 10) : null);
              if (v.volume_format !== undefined)  addV('volume_format', v.volume_format ?? null);
              if (v.is_available !== undefined)  addV('is_available', Boolean(v.is_available));
              if (vFields.length) {
                vVals.push(v.id, productId);
                await client.query(
                  `UPDATE product.product_variants SET ${vFields.join(', ')}, updated_at = NOW()
                   WHERE id = $${vVals.length - 1} AND product_id = $${vVals.length}`,
                  vVals
                );
              }

              // Push variant to C7
              if (c7VariantId) {
                const volumeML = (() => {
                  const fmt = v.volume_format || '';
                  const map = { '187ml': 187, '375ml': 375, '500ml': 500, '750ml': 750, '1L': 1000, '1.5L': 1500, '3L': 3000, '6L': 6000 };
                  if (map[fmt]) return map[fmt];
                  const m = fmt.match(/^(\d+)ml$/i);
                  return m ? parseInt(m[1], 10) : undefined;
                })();
                const varPayload = {};
                if (v.sku !== undefined) varPayload.sku = v.sku;
                if (v.price_cents !== undefined) varPayload.price = v.price_cents != null ? parseInt(v.price_cents, 10) : null;
                if (volumeML !== undefined) varPayload.volumeInML = volumeML;
                if (v.alcohol_pct !== undefined) varPayload.alcoholPercentage = v.alcohol_pct;
                await c7.put(`/product-variant/${c7VariantId}`, varPayload);
              }
            }
          }

          // Mark synced
          await client.query(
            `INSERT INTO product.sync_status (company_id, product_id, system, needs_push, last_synced_at, sync_error)
             VALUES ($1, $2, 'commerce7', false, NOW(), NULL)
             ON CONFLICT (product_id, system) DO UPDATE SET needs_push = false, last_synced_at = NOW(), sync_error = NULL`,
            [companyId, productId]
          );
        } catch (err) {
          console.error('[products] PUT C7 push failed:', err.message);
          c7Error = err.message;
          await client.query(
            `INSERT INTO product.sync_status (company_id, product_id, system, needs_push, sync_error)
             VALUES ($1, $2, 'commerce7', true, $3)
             ON CONFLICT (product_id, system) DO UPDATE SET needs_push = true, sync_error = $3`,
            [companyId, productId, err.message]
          );
        }
      } else if (c7ProductId) {
        // Has C7 product but no credentials — mark pending
        await client.query(
          `INSERT INTO product.sync_status (company_id, product_id, system, needs_push)
           VALUES ($1, $2, 'commerce7', true)
           ON CONFLICT (product_id, system) DO UPDATE SET needs_push = true`,
          [companyId, productId]
        );
      }

      const full = await loadFullProduct(client, productId, companyId);
      const response = { ok: true, product: full };
      if (c7Error) response.c7Error = c7Error;
      res.json(response);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[products] PUT /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/products ────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const companyId = cid(req);
  const b = req.body;

  if (!b.name) return res.status(400).json({ error: 'name is required' });

  try {
    const client = await pool.connect();
    let c7Error = null;

    try {
      await client.query(`SET search_path TO product, ${appSchema}`);

      // Load C7 credentials
      const credsRes = await query(
        `SELECT c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
         FROM ${appSchema}.company_integrations WHERE company_id = $1`,
        [companyId]
      );
      const integration = credsRes.rows[0];

      let c7ProductId = null;

      // Create in C7 first if credentials exist
      if (integration?.c7_api_key) {
        try {
          const { makeC7Client } = await import('../lib/commerce7Client.js');
          const c7 = makeC7Client(integration);
          const c7Payload = buildC7Payload(b);
          c7Payload.type = 'Wine'; // required for C7 create

          const c7NewProduct = await c7.post('/product', c7Payload);
          c7ProductId = c7NewProduct?.id ? String(c7NewProduct.id) : null;
        } catch (err) {
          console.error('[products] POST C7 create failed:', err.message);
          c7Error = err.message;
        }
      }

      // Insert into products
      const vintage = b.vintage ? parseInt(b.vintage, 10) : null;
      const prodRes = await client.query(
        `INSERT INTO product.products
           (company_id, name, description, vintage, varietal, wine_style,
            appellation, region, country, is_available, is_archived, display_order, images, product_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          companyId,
          b.name,
          b.description ?? null,
          vintage,
          b.varietal ?? null,
          b.wine_style ?? null,
          b.appellation ?? null,
          b.region ?? null,
          b.country ?? 'USA',
          b.is_available !== undefined ? Boolean(b.is_available) : true,
          false,
          0,
          JSON.stringify([]),
          b.product_type ?? 'Wine',
        ]
      );
      const productId = prodRes.rows[0].id;

      // Insert c7_products row if we have any c7 data
      if (c7ProductId || b.slug || b.teaser || b.seo_title || b.seo_description || b.tags || b.winemaker_notes) {
        await client.query(
          `INSERT INTO product.c7_products
             (product_id, company_id, c7_product_id, c7_handle, teaser, winemaker_notes,
              seo_title, seo_description, tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (product_id) DO NOTHING`,
          [
            productId,
            companyId,
            c7ProductId,
            b.slug ?? null,
            b.teaser ?? null,
            b.winemaker_notes ?? null,
            b.seo_title ?? null,
            b.seo_description ?? null,
            JSON.stringify(b.tags ?? []),
          ]
        );
      }

      // Sync status
      const needsPush = !c7ProductId && !!integration?.c7_api_key;
      await client.query(
        `INSERT INTO product.sync_status (company_id, product_id, system, needs_push, last_synced_at, sync_error)
         VALUES ($1,$2,'commerce7',$3,$4,$5)
         ON CONFLICT (product_id, system) DO NOTHING`,
        [
          companyId,
          productId,
          needsPush,
          c7ProductId ? new Date() : null,
          c7Error,
        ]
      );

      const full = await loadFullProduct(client, productId, companyId);
      const response = { ok: true, product: full };
      if (c7Error) response.c7Error = c7Error;
      res.status(201).json(response);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[products] POST / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/products/tax-exempt ────────────────────────────────────────────
router.post('/tax-exempt', requireAuth, requireManager, async (req, res) => {
  const { item_name } = req.body;
  if (!item_name?.trim()) return res.status(400).json({ error: 'item_name required' });
  try {
    const r = await query(
      `INSERT INTO tax_exempt_square_items (company_id, item_name, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, item_name) DO NOTHING
       RETURNING id, item_name, created_at`,
      [cid(req), item_name.trim(), req.userId]
    );
    res.json({ item: r.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/products/tax-exempt/:id ──────────────────────────────────────
router.delete('/tax-exempt/:id', requireAuth, requireManager, async (req, res) => {
  try {
    await query(
      `DELETE FROM tax_exempt_square_items WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


export { router as productsRouter };
