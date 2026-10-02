/**
 * Wine inventory routes — /api/products/inventory
 * Case+bottle counts per product+location, with full history for as-of-date reporting.
 */

import express from 'express';
import { query, pool } from '../db.js';
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
    let { location_id } = req.query;
    if (!location_id) {
      // Most of the wine is in one building; making the page open there saves a
      // click every single time and removes the chance of counting into the wrong
      // location by leaving the picker where it was.
      const def = await query(
        `SELECT id FROM locations
          WHERE company_id = $1 AND is_default_inventory AND deleted_at IS NULL LIMIT 1`,
        [cid(req)]
      );
      location_id = def.rows[0]?.id;
    }
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

// ── POST /api/products/inventory/transfer ────────────────────────────────────
//
// Wine moving between buildings is ONE event, not two counts. Recorded as two
// counts it is indistinguishable from a miscount afterwards: the source drops and
// the destination rises, and nothing says they were the same bottles. That
// ambiguity is exactly what made "23 Legacy +34" and "Cerceau +29" unexplainable.
//
// Both sides are written in a single transaction, and both sides also land in
// product_inventory_log so an as-of-date snapshot stays correct — the log is what
// the ABC filing reconstructs from.
router.post('/transfer', requireCapability('wine.inventory'), async (req, res) => {
  const { product_id, from_location_id, to_location_id, bottles, is_library, note } = req.body || {};
  const companyId = cid(req);
  const qty = parseInt(bottles, 10);
  try {
    if (!product_id || !from_location_id || !to_location_id) {
      return res.status(400).json({ error: 'product_id, from_location_id and to_location_id are required' });
    }
    if (from_location_id === to_location_id) {
      return res.status(400).json({ error: 'Pick two different locations.' });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'bottles must be a positive whole number.' });
    }
    const col = is_library ? 'library_bottles' : 'total_bottles';

    // Refuse to move more than the source is recorded as holding. A transfer that
    // drives a location negative is a count error being laundered into a movement.
    const src = await query(
      `SELECT ${col} AS have FROM product.product_inventory
        WHERE product_id = $1 AND location_id = $2`,
      [product_id, from_location_id]
    );
    const have = Number(src.rows[0]?.have ?? 0);
    if (have < qty) {
      return res.status(409).json({
        error: `Only ${have} bottle(s) recorded at the source — count it before moving ${qty}.`,
        available: have,
      });
    }

    // One held connection for the whole thing. db.js's query() checks a client out
    // and releases it per call, so BEGIN and COMMIT issued through it would land on
    // different connections and the transaction would be a no-op — with a stray
    // BEGIN left on a pooled connection. Same pattern as squareInventorySync.
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${process.env.DB_SCHEMA || 'teamtask_hub'}`);
      await client.query('BEGIN');
      await client.query(
        `UPDATE product.product_inventory SET ${col} = ${col} - $3
          WHERE product_id = $1 AND location_id = $2`,
        [product_id, from_location_id, qty]
      );
      // The destination may never have held this wine before, hence the upsert.
      // last_counted_at is deliberately NOT touched on either side: nobody counted
      // anything, and claiming otherwise would make a stale line look freshly counted.
      await client.query(
        `INSERT INTO product.product_inventory
           (product_id, location_id, company_id, total_bottles, library_bottles)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_id, location_id) DO UPDATE
           SET ${col} = product.product_inventory.${col} + $6`,
        [product_id, to_location_id, companyId,
         is_library ? 0 : qty, is_library ? qty : 0, qty]
      );
      await client.query(
        `INSERT INTO product.inventory_transfers
           (company_id, product_id, from_location_id, to_location_id, bottles, is_library, moved_by, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [companyId, product_id, from_location_id, to_location_id, qty, !!is_library,
         req.userId || null, (note || '').trim().slice(0, 500) || null]
      );
      // Log both sides at their post-move levels, so an as-of-date snapshot for any
      // later date reflects where the wine actually was. counted_by is null: this is
      // a movement, not a count, and the log should not imply a person counted it.
      for (const loc of [from_location_id, to_location_id]) {
        const now = await client.query(
          `SELECT total_bottles, library_bottles FROM product.product_inventory
            WHERE product_id = $1 AND location_id = $2`,
          [product_id, loc]
        );
        const row = now.rows[0];
        await client.query(
          `INSERT INTO product.product_inventory_log
             (product_id, location_id, company_id, total_bottles, library_bottles, counted_by)
           VALUES ($1,$2,$3,$4,$5,NULL)`,
          [product_id, loc, companyId, row?.total_bottles ?? 0, row?.library_bottles ?? 0]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    const after = await query(
      `SELECT l.name, pi.total_bottles, pi.library_bottles
         FROM product.product_inventory pi JOIN locations l ON l.id = pi.location_id
        WHERE pi.product_id = $1 AND pi.location_id = ANY($2::uuid[])`,
      [product_id, [from_location_id, to_location_id]]
    );
    res.status(201).json({ ok: true, moved: qty, is_library: !!is_library, locations: after.rows });
  } catch (err) {
    console.error('[inventory/transfer]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/inventory/transfers?product_id=&limit= ─────────────────
router.get('/transfers', requireCapability('wine.inventory'), async (req, res) => {
  try {
    const r = await query(
      `SELECT t.id, p.name AS wine, f.name AS from_location, d.name AS to_location,
              t.bottles, t.is_library, t.moved_at, t.note, u.display_name AS moved_by_name
         FROM product.inventory_transfers t
         JOIN product.products p ON p.id = t.product_id
         JOIN locations f ON f.id = t.from_location_id
         JOIN locations d ON d.id = t.to_location_id
         LEFT JOIN users u ON u.id = t.moved_by
        WHERE t.company_id = $1
          AND ($2::uuid IS NULL OR t.product_id = $2::uuid)
        ORDER BY t.moved_at DESC
        LIMIT LEAST(COALESCE($3::int, 50), 200)`,
      [cid(req), req.query.product_id || null, req.query.limit || null]
    );
    res.json({ transfers: r.rows });
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
