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

export { router as productsRouter };
