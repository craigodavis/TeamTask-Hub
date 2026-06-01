/**
 * Shopping routes — item catalog, purchase history, inventory counts
 *
 * GET    /api/shopping/items                  list catalog items
 * POST   /api/shopping/items                  create item
 * PATCH  /api/shopping/items/:id              update item
 * DELETE /api/shopping/items/:id              delete item
 *
 * GET    /api/shopping/items/:id/purchases    purchase history for an item
 * POST   /api/shopping/items/:id/match        match a receipt_item to this shopping item
 *
 * GET    /api/shopping/unmatched              receipt_items not yet matched
 *
 * GET    /api/shopping/inventory              inventory counts (routine items, all locations)
 * PATCH  /api/shopping/inventory/:itemId/:locationId   update count + sort_order
 * POST   /api/shopping/inventory/reorder      save drag-drop sort order
 */

import express from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const cId = (req) => req.companyId;

// ── Item catalog ──────────────────────────────────────────────────────────────

router.get('/items', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT si.*,
              (SELECT COUNT(*) FROM shopping_item_purchases sip WHERE sip.shopping_item_id = si.id) AS purchase_count,
              (SELECT MAX(sip.purchase_date) FROM shopping_item_purchases sip WHERE sip.shopping_item_id = si.id) AS last_purchase_date
       FROM shopping_items si
       WHERE si.company_id = $1
       ORDER BY si.category NULLS LAST, si.name`,
      [cId(req)]
    );
    res.json({ items: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/items', requireAuth, async (req, res) => {
  try {
    const { name, description, category, par_qty, par_unit, is_routine, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const r = await query(
      `INSERT INTO shopping_items (company_id, name, description, category, par_qty, par_unit, is_routine, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [cId(req), name.trim(), description||null, category||null, par_qty||null,
       par_unit||'box', is_routine||false, notes||null, req.userId]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/items/:id', requireAuth, async (req, res) => {
  try {
    const { name, description, category, par_qty, par_unit, is_routine, notes } = req.body;
    const r = await query(
      `UPDATE shopping_items SET
         name        = COALESCE($2, name),
         description = COALESCE($3, description),
         category    = COALESCE($4, category),
         par_qty     = COALESCE($5, par_qty),
         par_unit    = COALESCE($6, par_unit),
         is_routine  = COALESCE($7, is_routine),
         notes       = COALESCE($8, notes),
         updated_at  = NOW()
       WHERE id = $1 AND company_id = $9
       RETURNING *`,
      [req.params.id, name||null, description||null, category||null,
       par_qty??null, par_unit||null, is_routine??null, notes||null, cId(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/items/:id', requireAuth, async (req, res) => {
  try {
    await query(`DELETE FROM shopping_items WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]);
    res.status(204).send();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Purchase history ──────────────────────────────────────────────────────────

router.get('/items/:id/purchases', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT sip.*, ri.description AS receipt_description
       FROM shopping_item_purchases sip
       LEFT JOIN receipt_items ri ON ri.id = sip.receipt_item_id
       WHERE sip.shopping_item_id = $1 AND sip.company_id = $2
       ORDER BY sip.purchase_date DESC NULLS LAST`,
      [req.params.id, cId(req)]
    );
    res.json({ purchases: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Match a receipt_item to a shopping item
router.post('/items/:id/match', requireAuth, async (req, res) => {
  try {
    const { receipt_item_id, vendor, price, quantity, purchase_date, matched_by } = req.body;
    const r = await query(
      `INSERT INTO shopping_item_purchases
         (shopping_item_id, receipt_item_id, company_id, vendor, price, quantity, purchase_date, matched_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [req.params.id, receipt_item_id||null, cId(req), vendor||null,
       price||null, quantity||null, purchase_date||null, matched_by||'manual']
    );
    res.status(201).json(r.rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Raw items queue ───────────────────────────────────────────────────────────

// List unmatched raw items (the matching queue)
router.get('/raw', requireAuth, async (req, res) => {
  try {
    const { matched } = req.query; // matched=true|false|all
    let where = `sir.company_id = $1 AND sir.ignored = false`;
    if (matched === 'false' || !matched) where += ` AND sir.shopping_item_id IS NULL`;
    else if (matched === 'true') where += ` AND sir.shopping_item_id IS NOT NULL`;

    const r = await query(
      `SELECT sir.*, si.name AS matched_item_name
       FROM shopping_item_raw sir
       LEFT JOIN shopping_items si ON si.id = sir.shopping_item_id
       WHERE ${where}
       ORDER BY sir.purchase_count DESC, sir.last_purchase_date DESC NULLS LAST
       LIMIT 500`,
      [cId(req)]
    );
    res.json({ raw: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Match raw item to existing shopping_item OR create a new one
router.post('/raw/:id/match', requireAuth, async (req, res) => {
  try {
    const { shopping_item_id, create_new } = req.body;
    const company = cId(req);
    let itemId = shopping_item_id;

    // Get the raw item
    const rawRes = await query(
      `SELECT * FROM shopping_item_raw WHERE id = $1 AND company_id = $2`,
      [req.params.id, company]
    );
    if (!rawRes.rows.length) return res.status(404).json({ error: 'Raw item not found' });
    const raw = rawRes.rows[0];

    // Create new shopping_item if requested
    if (create_new) {
      const newItem = await query(
        `INSERT INTO shopping_items (company_id, name, par_unit, created_by)
         VALUES ($1, $2, 'box', $3) RETURNING id`,
        [company, create_new.name || raw.description_raw, req.userId]
      );
      itemId = newItem.rows[0].id;
    }

    if (!itemId) return res.status(400).json({ error: 'shopping_item_id or create_new required' });

    // Link raw item to shopping item
    await query(
      `UPDATE shopping_item_raw SET shopping_item_id = $2, updated_at = NOW() WHERE id = $1`,
      [req.params.id, itemId]
    );

    // Also create a purchase record
    await query(
      `INSERT INTO shopping_item_purchases
         (shopping_item_id, company_id, vendor, price, purchase_date, matched_by)
       VALUES ($1,$2,$3,$4,$5,'manual')
       ON CONFLICT DO NOTHING`,
      [itemId, company, raw.vendor, raw.last_price, raw.last_purchase_date]
    ).catch(() => {}); // ignore conflict

    const item = await query(`SELECT * FROM shopping_items WHERE id = $1`, [itemId]);
    res.json({ ok: true, shopping_item: item.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ignore a raw item (personal item, not relevant)
router.post('/raw/:id/ignore', requireAuth, async (req, res) => {
  try {
    await query(
      `UPDATE shopping_item_raw SET ignored = true, updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [req.params.id, cId(req)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sync historical receipt_items into shopping_item_raw
router.post('/raw/sync', requireAuth, async (req, res) => {
  try {
    const company = cId(req);
    const r = await query(
      `INSERT INTO shopping_item_raw
         (company_id, description_raw, vendor, last_price, last_purchase_date, purchase_count)
       SELECT
         r.company_id,
         ri.description,
         COALESCE(r.vendor, 'Unknown'),
         ri.total,
         r.order_date,
         1
       FROM receipt_items ri
       JOIN receipts r ON r.id = ri.receipt_id AND r.company_id = $1
       WHERE r.status != 'excluded'
         AND ri.description IS NOT NULL AND ri.description != ''
       ON CONFLICT (company_id, description_raw, vendor) DO UPDATE SET
         last_price         = CASE WHEN EXCLUDED.last_purchase_date >= COALESCE(shopping_item_raw.last_purchase_date, '1900-01-01') THEN EXCLUDED.last_price ELSE shopping_item_raw.last_price END,
         last_purchase_date = GREATEST(shopping_item_raw.last_purchase_date, EXCLUDED.last_purchase_date),
         purchase_count     = shopping_item_raw.purchase_count + 1,
         updated_at         = NOW()`,
      [company]
    );
    res.json({ ok: true, synced: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Unmatched receipt items (legacy) ─────────────────────────────────────────

router.get('/unmatched', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT ri.id, ri.description, ri.total, ri.quantity,
              r.vendor, r.order_date, r.order_number
       FROM receipt_items ri
       JOIN receipts r ON r.id = ri.receipt_id AND r.company_id = $1
       WHERE NOT EXISTS (
         SELECT 1 FROM shopping_item_purchases sip WHERE sip.receipt_item_id = ri.id
       )
       AND r.status NOT IN ('excluded')
       ORDER BY r.order_date DESC NULLS LAST, ri.description
       LIMIT 200`,
      [cId(req)]
    );
    res.json({ items: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Inventory ─────────────────────────────────────────────────────────────────

router.get('/inventory', requireAuth, async (req, res) => {
  try {
    const { location_id } = req.query;
    const r = await query(
      `SELECT si.id, si.name, si.category, si.par_qty, si.par_unit, si.notes,
              inv.id AS inv_id, inv.location_id, inv.current_qty, inv.sort_order,
              inv.last_counted_at, inv.last_counted_by,
              u.display_name AS last_counted_by_name,
              l.name AS location_name
       FROM shopping_items si
       LEFT JOIN shopping_inventory inv
         ON inv.shopping_item_id = si.id
         AND inv.company_id = $1
         AND ($2::uuid IS NULL OR inv.location_id = $2::uuid)
       LEFT JOIN users u ON u.id = inv.last_counted_by
       LEFT JOIN locations l ON l.id = inv.location_id
       WHERE si.company_id = $1 AND si.is_routine = true
       ORDER BY COALESCE(inv.sort_order, 9999), si.category NULLS LAST, si.name`,
      [cId(req), location_id || null]
    );
    res.json({ inventory: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/inventory/:itemId/:locationId', requireAuth, async (req, res) => {
  try {
    const { current_qty, sort_order } = req.body;
    const { itemId, locationId } = req.params;
    const company = cId(req);

    const r = await query(
      `INSERT INTO shopping_inventory
         (shopping_item_id, location_id, company_id, current_qty, sort_order,
          last_counted_at, last_counted_by)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6)
       ON CONFLICT (shopping_item_id, location_id) DO UPDATE SET
         current_qty     = COALESCE(EXCLUDED.current_qty, shopping_inventory.current_qty),
         sort_order      = COALESCE(EXCLUDED.sort_order,  shopping_inventory.sort_order),
         last_counted_at = CASE WHEN EXCLUDED.current_qty IS NOT NULL THEN NOW() ELSE shopping_inventory.last_counted_at END,
         last_counted_by = CASE WHEN EXCLUDED.current_qty IS NOT NULL THEN EXCLUDED.last_counted_by ELSE shopping_inventory.last_counted_by END
       RETURNING *`,
      [itemId, locationId, company, current_qty??null, sort_order??null, req.userId]
    );

    // Log the count if qty was updated
    if (current_qty != null) {
      await query(
        `INSERT INTO shopping_inventory_log (shopping_item_id, location_id, company_id, qty, counted_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [itemId, locationId, company, current_qty, req.userId]
      );
    }

    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save drag-drop sort order for a location
router.post('/inventory/reorder', requireAuth, async (req, res) => {
  try {
    const { location_id, order } = req.body; // order: [{ item_id, sort_order }]
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    const company = cId(req);
    for (const { item_id, sort_order } of order) {
      await query(
        `INSERT INTO shopping_inventory (shopping_item_id, location_id, company_id, sort_order)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (shopping_item_id, location_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
        [item_id, location_id, company, sort_order]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Shopping list (items below par) ──────────────────────────────────────────

router.get('/shopping-list', requireAuth, async (req, res) => {
  try {
    const { location_id } = req.query;
    const r = await query(
      `SELECT si.id, si.name, si.category, si.par_qty, si.par_unit, si.notes,
              inv.current_qty, inv.location_id, l.name AS location_name,
              GREATEST(0, si.par_qty - COALESCE(inv.current_qty, 0)) AS needed_qty,
              (SELECT vendor FROM shopping_item_purchases sip
               WHERE sip.shopping_item_id = si.id AND sip.company_id = $1
               ORDER BY sip.purchase_date DESC NULLS LAST LIMIT 1) AS last_vendor,
              (SELECT price FROM shopping_item_purchases sip
               WHERE sip.shopping_item_id = si.id AND sip.company_id = $1
               ORDER BY sip.purchase_date DESC NULLS LAST LIMIT 1) AS last_price
       FROM shopping_items si
       JOIN shopping_inventory inv ON inv.shopping_item_id = si.id AND inv.company_id = $1
       LEFT JOIN locations l ON l.id = inv.location_id
       WHERE si.company_id = $1
         AND si.is_routine = true
         AND si.par_qty IS NOT NULL
         AND COALESCE(inv.current_qty, 0) < si.par_qty
         AND ($2::uuid IS NULL OR inv.location_id = $2::uuid)
       ORDER BY si.category NULLS LAST, si.name`,
      [cId(req), location_id || null]
    );
    res.json({ items: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export { router as shoppingRouter };
