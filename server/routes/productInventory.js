/**
 * Wine inventory routes — /api/products/inventory
 * Case+bottle counts per product+location, with full history for as-of-date reporting.
 */

import express from 'express';
import { query } from '../db.js';
import { requireInventoryAccess } from '../middleware/auth.js';
import { toTotalBottles, fromTotalBottles } from '../lib/wineInventory.js';

const router = express.Router();
const cid = (req) => req.companyId;

async function getCompanyTimezone(companyId) {
  const r = await query(`SELECT timezone FROM companies WHERE id = $1`, [companyId]);
  return r.rows[0]?.timezone || 'UTC';
}

// ── GET /api/products/inventory?location_id=X ────────────────────────────────
// Entry-list data: every available-for-sale product with its current count at
// this location, whether it was already counted today, and who/when last counted.
router.get('/', requireInventoryAccess, async (req, res) => {
  try {
    const { location_id } = req.query;
    if (!location_id) return res.status(400).json({ error: 'location_id is required' });

    const tz = await getCompanyTimezone(cid(req));

    const r = await query(
      `SELECT p.id, p.name, p.vintage, p.varietal, p.display_order,
              COALESCE(pi.total_bottles, 0) AS total_bottles,
              pi.last_counted_at,
              u.display_name AS last_counted_by_name,
              (pi.last_counted_at IS NOT NULL
                AND DATE(pi.last_counted_at AT TIME ZONE $3) = DATE(NOW() AT TIME ZONE $3)
              ) AS counted_today
       FROM product.products p
       LEFT JOIN product.product_inventory pi
         ON pi.product_id = p.id AND pi.location_id = $2
       LEFT JOIN users u ON u.id = pi.last_counted_by
       WHERE p.company_id = $1 AND p.is_available = true AND p.is_archived = false
       ORDER BY p.display_order, p.name`,
      [cid(req), location_id, tz]
    );

    const items = r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      vintage: row.vintage,
      varietal: row.varietal,
      last_counted_at: row.last_counted_at,
      last_counted_by_name: row.last_counted_by_name,
      counted_today: row.counted_today,
      ...fromTotalBottles(row.total_bottles),
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/products/inventory ──────────────────────────────────────────────
// Body: { product_id, location_id, cases, bottles }
router.post('/', requireInventoryAccess, async (req, res) => {
  try {
    const { product_id, location_id, cases, bottles } = req.body;
    if (!product_id || !location_id) {
      return res.status(400).json({ error: 'product_id and location_id are required' });
    }
    const companyId = cid(req);
    const totalBottles = toTotalBottles(cases, bottles);

    await query(
      `INSERT INTO product.product_inventory
         (product_id, location_id, company_id, total_bottles, last_counted_at, last_counted_by)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (product_id, location_id) DO UPDATE
         SET total_bottles = $4, last_counted_at = NOW(), last_counted_by = $5`,
      [product_id, location_id, companyId, totalBottles, req.userId]
    );

    await query(
      `INSERT INTO product.product_inventory_log
         (product_id, location_id, company_id, total_bottles, counted_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [product_id, location_id, companyId, totalBottles, req.userId]
    );

    res.status(201).json({ ...fromTotalBottles(totalBottles), counted_today: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/inventory/report?as_of=YYYY-MM-DD&location_id=X&all_items=true|false ──
router.get('/report', requireInventoryAccess, async (req, res) => {
  try {
    const companyId = cid(req);
    const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
    const locationId = req.query.location_id && req.query.location_id !== 'all' ? req.query.location_id : null;
    const allItems = req.query.all_items === 'true';

    // Most recent log entry per product+location at or before as_of.
    const params = [companyId, `${asOf}T23:59:59.999Z`];
    let locationFilter = '';
    if (locationId) {
      params.push(locationId);
      locationFilter = `AND location_id = $${params.length}`;
    }

    const r = await query(
      `SELECT DISTINCT ON (product_id, location_id) product_id, location_id, total_bottles, counted_at
       FROM product.product_inventory_log
       WHERE company_id = $1 AND counted_at <= $2 ${locationFilter}
       ORDER BY product_id, location_id, counted_at DESC`,
      params
    );

    // Sum across locations per product (a no-op when a single location is selected).
    const byProduct = new Map();
    for (const row of r.rows) {
      const prev = byProduct.get(row.product_id) || { total_bottles: 0, counted_at: null };
      prev.total_bottles += row.total_bottles;
      if (!prev.counted_at || row.counted_at > prev.counted_at) prev.counted_at = row.counted_at;
      byProduct.set(row.product_id, prev);
    }

    const productParams = [companyId];
    let availabilityFilter = 'AND p.is_available = true';
    if (allItems) availabilityFilter = '';

    const productsRes = await query(
      `SELECT id, name, vintage, varietal, is_available
       FROM product.products p
       WHERE p.company_id = $1 AND p.is_archived = false ${availabilityFilter}
       ORDER BY p.display_order, p.name`,
      productParams
    );

    const items = productsRes.rows.map((p) => {
      const counted = byProduct.get(p.id);
      const { cases, bottles } = fromTotalBottles(counted?.total_bottles || 0);
      return {
        product_id: p.id,
        name: p.name,
        vintage: p.vintage,
        varietal: p.varietal,
        is_available: p.is_available,
        cases,
        bottles,
        last_counted_at: counted?.counted_at || null,
      };
    });

    res.json({ as_of: asOf, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as productInventoryRouter };
