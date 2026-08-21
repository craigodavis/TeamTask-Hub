/**
 * Wine inventory routes — /api/products/inventory
 * Case+bottle counts per product+location, with full history for as-of-date reporting.
 */

import express from 'express';
import { query } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { toTotalBottles, fromTotalBottles, parseVolumeMl, mlToLitersGallons, CASE_SIZE } from '../lib/wineInventory.js';
import { unfulfilledAsOf } from '../lib/abcFiling.js';

const router = express.Router();
const cid = (req) => req.companyId;

async function getCompanyTimezone(companyId) {
  const r = await query(`SELECT timezone FROM companies WHERE id = $1`, [companyId]);
  return r.rows[0]?.timezone || 'UTC';
}

// ── GET /api/products/inventory?location_id=X ────────────────────────────────
// Entry-list data: every available-for-sale product with its current count at
// this location, whether it was already counted today, and who/when last counted.
router.get('/', requireCapability('wine.inventory'), async (req, res) => {
  try {
    const { location_id } = req.query;
    if (!location_id) return res.status(400).json({ error: 'location_id is required' });

    const tz = await getCompanyTimezone(cid(req));

    const r = await query(
      `SELECT p.id, p.name, p.vintage, p.varietal, p.display_order,
              COALESCE(pi.total_bottles, 0) AS total_bottles,
              COALESCE(pi.library_bottles, 0) AS library_bottles,
              pi.last_counted_at,
              u.display_name AS last_counted_by_name,
              (pi.last_counted_at IS NOT NULL
                AND DATE(pi.last_counted_at AT TIME ZONE $3) = DATE(NOW() AT TIME ZONE $3)
              ) AS counted_today
       FROM product.products p
       LEFT JOIN product.product_inventory pi
         ON pi.product_id = p.id AND pi.location_id = $2
       LEFT JOIN users u ON u.id = pi.last_counted_by
       -- Counted because it physically exists, not because it is for sale. A
       -- club-release wine or one still resting is on the rack and must be
       -- counted; is_available would hide it.
       WHERE p.company_id = $1 AND p.is_active = true AND p.is_archived = false
         -- Exclude products explicitly classified as something other than
         -- Wine (Beer, Food, etc.) via Commerce7's product_type, but don't
         -- hide not-yet-synced wines that still have a null type.
         AND (p.product_type = 'Wine' OR p.product_type IS NULL)
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
      library: fromTotalBottles(row.library_bottles),
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/products/inventory ──────────────────────────────────────────────
// Body: { product_id, location_id, cases, bottles }
router.post('/', requireCapability('wine.inventory'), async (req, res) => {
  try {
    const { product_id, location_id, cases, bottles,
            library_cases, library_bottles } = req.body;
    if (!product_id || !location_id) {
      return res.status(400).json({ error: 'product_id and location_id are required' });
    }
    const companyId = cid(req);
    const totalBottles = toTotalBottles(cases, bottles);
    const libraryBottles = toTotalBottles(library_cases, library_bottles);

    // Library is its own pile, not a slice of the regular count, so there is no
    // ceiling to check — regular can be zero while the library holds eleven
    // cases. Both still have to be non-negative, which the database enforces.

    // Not every location keeps library stock. The count screen hides the field
    // there, but hiding a control is presentation — this is the rule.
    if (libraryBottles > 0) {
      const loc = await query(
        `SELECT name, allows_library FROM locations WHERE id = $1 AND company_id = $2`,
        [location_id, companyId]
      );
      if (loc.rows[0] && loc.rows[0].allows_library === false) {
        return res.status(400).json({
          error: `${loc.rows[0].name} does not hold library stock — record it at the location that does.`,
        });
      }
    }

    await query(
      `INSERT INTO product.product_inventory
         (product_id, location_id, company_id, total_bottles, library_bottles,
          last_counted_at, last_counted_by)
       VALUES ($1, $2, $3, $4, $6, NOW(), $5)
       ON CONFLICT (product_id, location_id) DO UPDATE
         SET total_bottles = $4, library_bottles = $6,
             last_counted_at = NOW(), last_counted_by = $5`,
      [product_id, location_id, companyId, totalBottles, req.userId, libraryBottles]
    );

    await query(
      `INSERT INTO product.product_inventory_log
         (product_id, location_id, company_id, total_bottles, library_bottles, counted_by)
       VALUES ($1, $2, $3, $4, $6, $5)`,
      [product_id, location_id, companyId, totalBottles, req.userId, libraryBottles]
    );

    res.status(201).json({
      ...fromTotalBottles(totalBottles),
      library: fromTotalBottles(libraryBottles),
      counted_today: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/inventory/report?as_of=YYYY-MM-DD&location_id=X&all_items=true|false ──
router.get('/report', requireCapability('wine.reports'), async (req, res) => {
  try {
    const companyId = cid(req);
    const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
    const locationId = req.query.location_id && req.query.location_id !== 'all' ? req.query.location_id : null;
    const allItems = req.query.all_items === 'true';

    // Most recent log entry per product+location at or before as_of. Always
    // pulls every location — the per-location summary at the bottom needs
    // all of them regardless of which one the main table is scoped to.
    const r = await query(
      `SELECT DISTINCT ON (product_id, location_id) product_id, location_id, total_bottles, counted_at
       FROM product.product_inventory_log
       WHERE company_id = $1 AND counted_at <= $2
       ORDER BY product_id, location_id, counted_at DESC`,
      [companyId, `${asOf}T23:59:59.999Z`]
    );

    const productParams = [companyId];
    let availabilityFilter = 'AND p.is_available = true';
    if (allItems) availabilityFilter = '';

    // One row per product with its default (or lowest-ordinal) variant's
    // bottle volume, needed for the liter/gallon total.
    const productsRes = await query(
      `SELECT p.id, p.name, p.vintage, p.varietal, p.is_available,
              (SELECT v.volume_format FROM product.product_variants v
               WHERE v.product_id = p.id
               ORDER BY v.is_default DESC, v.ordinal ASC LIMIT 1) AS volume_format
       FROM product.products p
       WHERE p.company_id = $1 AND p.is_archived = false ${availabilityFilter}
         AND (p.product_type = 'Wine' OR p.product_type IS NULL)
       ORDER BY p.display_order, p.name`,
      productParams
    );
    const validProductIds = new Set(productsRes.rows.map((p) => p.id));

    // Main table: sum across locations per product, scoped to the selected
    // location if one was requested (a no-op when 'all' is selected).
    const byProduct = new Map();
    for (const row of r.rows) {
      if (!validProductIds.has(row.product_id)) continue;
      if (locationId && row.location_id !== locationId) continue;
      const prev = byProduct.get(row.product_id) || { total_bottles: 0, counted_at: null };
      prev.total_bottles += row.total_bottles;
      if (!prev.counted_at || row.counted_at > prev.counted_at) prev.counted_at = row.counted_at;
      byProduct.set(row.product_id, prev);
    }

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

    // Bottom summary: total cases per location + grand total + volume,
    // always across every location regardless of the main table's scope.
    const locationsRes = await query(
      `SELECT id, name FROM locations WHERE company_id = $1 ORDER BY name`,
      [companyId]
    );
    const bottlesByLocation = new Map(locationsRes.rows.map((l) => [l.id, 0]));
    const bottlesByProductAllLocations = new Map();
    let grandTotalBottles = 0;
    for (const row of r.rows) {
      if (!validProductIds.has(row.product_id)) continue;
      bottlesByLocation.set(row.location_id, (bottlesByLocation.get(row.location_id) || 0) + row.total_bottles);
      bottlesByProductAllLocations.set(row.product_id, (bottlesByProductAllLocations.get(row.product_id) || 0) + row.total_bottles);
      grandTotalBottles += row.total_bottles;
    }
    // Volume must reflect every location, not just the selected one.
    let totalMl = 0;
    for (const p of productsRes.rows) {
      const bottleMl = parseVolumeMl(p.volume_format);
      totalMl += (bottlesByProductAllLocations.get(p.id) || 0) * bottleMl;
    }

    const locationSummary = locationsRes.rows.map((l) => ({
      location_id: l.id,
      location_name: l.name,
      total_bottles: bottlesByLocation.get(l.id) || 0,
      cases: Math.round(((bottlesByLocation.get(l.id) || 0) / CASE_SIZE) * 10) / 10,
    }));

    // A count answers "what is on the property", but the number people act on
    // is "what can I still sell" — and roughly 1,200 bottles of that is already
    // somebody's club order awaiting collection. Reporting the total alone
    // overstates what is available.
    const held = await unfulfilledAsOf(companyId, `${asOf}T23:59:59.999Z`);
    const heldBottles = held.bottles || 0;
    const sellableBottles = grandTotalBottles - heldBottles;

    res.json({
      as_of: asOf,
      items,
      summary: {
        all_locations: {
          total_bottles: grandTotalBottles,
          cases: Math.round((grandTotalBottles / CASE_SIZE) * 10) / 10,
        },
        held: {
          bottles: heldBottles,
          cases: Math.round((heldBottles / CASE_SIZE) * 10) / 10,
          pct: grandTotalBottles
            ? Math.round((heldBottles / grandTotalBottles) * 1000) / 10
            : null,
          by_method: held.byMethod,
        },
        sellable: {
          bottles: sellableBottles,
          cases: Math.round((sellableBottles / CASE_SIZE) * 10) / 10,
        },
        by_location: locationSummary,
        volume: mlToLitersGallons(totalMl),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as productInventoryRouter };
