/**
 * Product line routes — /api/product-lines
 *
 * A product line is the wine itself ("Papa's Malbec"); a product is one vintage
 * of it ("23 Papa's"). Everything true of the wine rather than the vintage lives
 * here, so it is entered once instead of being retyped on every new vintage.
 */

import express from 'express';
import { pool } from '../db.js';
import { requireAuth, requireManager } from '../middleware/auth.js';

const router = express.Router();
const appSchema = process.env.DB_SCHEMA || 'teamtask_hub';

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

// Fields a line owns. Products inherit these read-only, so this list is also
// what the product screen greys out — keep the two in step.
const LINE_FIELDS = [
  'name', 'sku_base', 'upc', 'ttb_label_id', 'product_type', 'varietal',
  'origin_project', 'wine_style', 'appellation', 'region', 'country',
  'description', 'teaser', 'winemaker_notes', 'seo_title', 'seo_description',
  'label_story', 'tasting_notes', 'awards',
  'club_eligible', 'is_archived', 'display_order',
];
const ARRAY_FIELDS = ['food_pairings', 'tags'];

// SKU base is the product SKU minus the vintage prefix, so it follows the same
// rule as every other SKU: lowercase, hyphens, no apostrophes or accents.
function canonSkuBase(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── GET /api/product-lines ────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { archived = 'false', search, product_type } = req.query;
    const conds = ['l.company_id = $1'];
    const params = [cid(req)];
    if (archived !== 'true') conds.push('l.is_archived = false');
    if (product_type) { params.push(product_type); conds.push(`l.product_type = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      conds.push(`(l.name ILIKE $${params.length} OR l.sku_base ILIKE $${params.length} OR l.varietal ILIKE $${params.length})`);
    }

    const rows = await withConn((client) => client.query(
      `SELECT l.*,
              COUNT(p.id)::int                                   AS product_count,
              COUNT(p.id) FILTER (WHERE p.is_available)::int     AS available_count,
              MIN(p.vintage)                                     AS first_vintage,
              MAX(p.vintage)                                     AS last_vintage
         FROM product.product_lines l
         LEFT JOIN product.products p ON p.product_line_id = l.id
        WHERE ${conds.join(' AND ')}
        GROUP BY l.id
        ORDER BY l.display_order, l.name`,
      params
    ));
    res.json(rows.rows);
  } catch (err) {
    console.error('[product-lines] GET / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/product-lines/:id ────────────────────────────────────────────────
// Returns the line plus its vintages, newest first — the one-to-many view.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const out = await withConn(async (client) => {
      const [line, products] = await Promise.all([
        client.query(
          `SELECT * FROM product.product_lines WHERE id = $1 AND company_id = $2`,
          [req.params.id, cid(req)]
        ),
        client.query(
          `SELECT p.id, p.name, p.vintage, p.alcohol_pct, p.is_available, p.is_archived,
                  COUNT(v.id)::int AS variant_count,
                  MIN(v.price_cents) AS min_price_cents,
                  COALESCE((SELECT SUM(total_bottles)::int FROM product.product_inventory pi
                             WHERE pi.product_id = p.id), 0) AS bottles
             FROM product.products p
             LEFT JOIN product.product_variants v ON v.product_id = p.id
            WHERE p.product_line_id = $1
            GROUP BY p.id
            ORDER BY p.vintage DESC NULLS LAST, p.name`,
          [req.params.id]
        ),
      ]);
      return { line, products };
    });

    if (!out.line.rows.length) return res.status(404).json({ error: 'Product line not found' });
    res.json({ ...out.line.rows[0], products: out.products.rows });
  } catch (err) {
    console.error('[product-lines] GET /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/product-lines ───────────────────────────────────────────────────
router.post('/', requireAuth, requireManager, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name)     return res.status(400).json({ error: 'name is required' });
    if (!body.sku_base) return res.status(400).json({ error: 'sku_base is required' });

    const skuBase = canonSkuBase(body.sku_base);
    const type = body.product_type || 'Wine';
    // UPC and TTB label are required for wine — the DB enforces this too, but a
    // 400 here is a better error than a constraint violation.
    if (type === 'Wine' && (!body.upc || !body.ttb_label_id)) {
      return res.status(400).json({ error: 'upc and ttb_label_id are required for wine' });
    }

    const cols = ['company_id', 'sku_base', 'product_type'];
    const vals = [cid(req), skuBase, type];
    for (const f of LINE_FIELDS) {
      if (f === 'sku_base' || f === 'product_type') continue;
      if (body[f] !== undefined) { cols.push(f); vals.push(body[f]); }
    }
    for (const f of ARRAY_FIELDS) {
      if (body[f] !== undefined) { cols.push(f); vals.push(Array.isArray(body[f]) ? body[f] : []); }
    }
    if (req.userId) { cols.push('created_by', 'updated_by'); vals.push(req.userId, req.userId); }

    const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
    const row = await withConn((client) => client.query(
      `INSERT INTO product.product_lines (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, vals
    ));
    res.status(201).json(row.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A product line with that SKU base already exists' });
    console.error('[product-lines] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/product-lines/:id ────────────────────────────────────────────────
router.put('/:id', requireAuth, requireManager, async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const vals = [];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    for (const f of LINE_FIELDS) {
      if (body[f] === undefined) continue;
      push(f, f === 'sku_base' ? canonSkuBase(body[f]) : body[f]);
    }
    for (const f of ARRAY_FIELDS) {
      if (body[f] !== undefined) push(f, Array.isArray(body[f]) ? body[f] : []);
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    push('updated_at', new Date());
    if (req.userId) push('updated_by', req.userId);

    vals.push(req.params.id, cid(req));
    const row = await withConn((client) => client.query(
      `UPDATE product.product_lines SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND company_id = $${vals.length}
        RETURNING *`, vals
    ));
    if (!row.rows.length) return res.status(404).json({ error: 'Product line not found' });
    res.json(row.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A product line with that SKU base already exists' });
    if (err.code === '23514') return res.status(400).json({ error: 'Wine lines require both a UPC and a TTB label ID' });
    console.error('[product-lines] PUT error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/product-lines/:id/attach ────────────────────────────────────────
// Attach or detach vintages. Detach is by omission, so send the full set.
router.post('/:id/attach', requireAuth, requireManager, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.product_ids) ? req.body.product_ids : null;
    if (!ids) return res.status(400).json({ error: 'product_ids array is required' });

    const out = await withConn(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE product.products SET product_line_id = NULL
            WHERE product_line_id = $1 AND company_id = $2`,
          [req.params.id, cid(req)]
        );
        if (ids.length) {
          await client.query(
            `UPDATE product.products SET product_line_id = $1
              WHERE id = ANY($2::uuid[]) AND company_id = $3`,
            [req.params.id, ids, cid(req)]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      return client.query(
        `SELECT id, name, vintage FROM product.products
          WHERE product_line_id = $1 ORDER BY vintage DESC NULLS LAST`,
        [req.params.id]
      );
    });
    res.json({ products: out.rows });
  } catch (err) {
    console.error('[product-lines] attach error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/product-lines/:id/unassigned ─────────────────────────────────────
// Vintages not yet attached to any line — the pool to pick from.
router.get('/:id/unassigned', requireAuth, async (req, res) => {
  try {
    const rows = await withConn((client) => client.query(
      `SELECT id, name, vintage, is_available
         FROM product.products
        WHERE company_id = $1 AND product_line_id IS NULL AND is_archived = false
        ORDER BY name`,
      [cid(req)]
    ));
    res.json(rows.rows);
  } catch (err) {
    console.error('[product-lines] unassigned error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/product-lines/lookup/options ─────────────────────────────────────
// Flat list for the product-line dropdown on a Vintly project. Deliberately
// minimal — Vintly needs an id and a label, not the whole record.
router.get('/lookup/options', requireAuth, async (req, res) => {
  try {
    const rows = await withConn((client) => client.query(
      `SELECT id, name, sku_base, varietal, wine_style
         FROM product.product_lines
        WHERE company_id = $1 AND is_archived = false
        ORDER BY name`,
      [cid(req)]
    ));
    res.json(rows.rows);
  } catch (err) {
    console.error('[product-lines] lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/product-lines/bottle ────────────────────────────────────────────
// Called when a Vintly project records its bottling. Creates the vintage under
// the chosen line and links the two together.
//
// The product line is REQUIRED here even though it is optional on the project:
// a lot can be blended away and never bottled under its own label, but the
// moment it IS bottled it has one, and that is the point at which winemaking
// becomes sellable stock.
//
// Idempotent on vintly_project_id — bottling can be edited and re-saved, so a
// second call updates the product it already created rather than making another.
router.post('/bottle', requireAuth, requireManager, async (req, res) => {
  const {
    product_line_id, vintage, starting_case_count,
    vintly_project_id, name, bottling_date,
  } = req.body || {};

  if (!product_line_id)   return res.status(400).json({ error: 'product_line_id is required to bottle' });
  if (!vintage)           return res.status(400).json({ error: 'vintage is required' });
  if (!vintly_project_id) return res.status(400).json({ error: 'vintly_project_id is required' });

  try {
    const out = await withConn(async (client) => {
      const line = await client.query(
        `SELECT * FROM product.product_lines WHERE id = $1 AND company_id = $2`,
        [product_line_id, cid(req)]
      );
      if (!line.rows.length) return { error: 'Product line not found', status: 404 };
      const L = line.rows[0];

      // "23 Papa's Malbec" from vintage 2023 + line "Papa's Malbec"
      const label = name || `${String(vintage).slice(-2)} ${L.name}`;
      const cases = Number.isFinite(parseInt(starting_case_count, 10))
        ? parseInt(starting_case_count, 10) : null;
      // SKU = 2-digit vintage + "-" + the line's (already canonical) sku_base, lowercase:
      // "23-papas-malbec". Recomputed on every save so it tracks the vintage.
      const sku = L.sku_base ? `${String(vintage).slice(-2)}-${String(L.sku_base).trim().toLowerCase()}` : null;

      const existing = await client.query(
        `SELECT id FROM product.products WHERE vintly_project_id = $1 AND company_id = $2`,
        [vintly_project_id, cid(req)]
      );

      if (existing.rows.length) {
        const upd = await client.query(
          `UPDATE product.products
              SET product_line_id = $1, vintage = $2, starting_case_count = $3,
                  name = $4, sku = $5, updated_at = NOW()
            WHERE id = $6 RETURNING *`,
          [product_line_id, vintage, cases, label, sku, existing.rows[0].id]
        );
        await client.query(
          `INSERT INTO product.c7_products (product_id, company_id, cases_produced)
           VALUES ($1, $2, $3)
           ON CONFLICT (product_id) DO UPDATE SET cases_produced = EXCLUDED.cases_produced`,
          [upd.rows[0].id, cid(req), cases]
        );
        return { product: upd.rows[0], created: false };
      }

      // Vintage-level facts come from the line; the vintage itself supplies the
      // rest. Nothing here is retyped that the line already knows.
      const ins = await client.query(
        `INSERT INTO product.products
           (company_id, name, sku, vintage, product_line_id, starting_case_count,
            vintly_project_id, product_type, varietal, wine_style, appellation,
            region, country, is_active, is_available, is_archived, display_order, created_by)
         -- Active so a freshly bottled wine lands on the count sheet straight
         -- away; not for sale until someone decides it is.
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,false,false,0,$14)
         RETURNING *`,
        [cid(req), label, sku, vintage, product_line_id, cases, vintly_project_id,
         L.product_type || 'Wine', L.varietal, L.wine_style, L.appellation,
         L.region, L.country, req.userId || null]
      );

      // Mirror the case count into the Commerce7 "Cases Produced" field (local; C7 sync never
      // overwrites it), creating the overlay row for a freshly-bottled product.
      await client.query(
        `INSERT INTO product.c7_products (product_id, company_id, cases_produced)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id) DO UPDATE SET cases_produced = EXCLUDED.cases_produced`,
        [ins.rows[0].id, cid(req), cases]
      );

      // Link the project back, so the trace works in both directions.
      await client.query(
        `UPDATE vintly.projects
            SET product_line_id = $1, bottling_date = COALESCE(bottling_date, $2)
          WHERE id = $3`,
        [product_line_id, bottling_date || null, vintly_project_id]
      );

      return { product: ins.rows[0], created: true };
    });

    if (out.error) return res.status(out.status).json({ error: out.error });
    // Created unavailable on purpose — a wine that has just been bottled is not
    // automatically for sale, and publishing is a separate decision per channel.
    res.status(out.created ? 201 : 200).json(out);
  } catch (err) {
    console.error('[product-lines] bottle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export { router as productLinesRouter };
