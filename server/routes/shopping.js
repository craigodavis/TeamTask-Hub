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
import Anthropic from '@anthropic-ai/sdk';

const router = express.Router();
const cId = (req) => req.companyId;

/** Empty string / invalid → null for numeric DB columns */
function optionalNumeric(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getLocationIdsForItem(itemId) {
  const r = await query(
    `SELECT location_id::text FROM shopping_item_locations WHERE shopping_item_id = $1 ORDER BY location_id`,
    [itemId]
  );
  return r.rows.map((row) => row.location_id);
}

async function itemWithLocationIds(row) {
  if (!row) return row;
  const location_ids = await getLocationIdsForItem(row.id);
  return { ...row, location_ids, is_routine: location_ids.length > 0 };
}

/** Replace which locations stock this item; sync is_routine and drop counts for removed sites */
async function setItemLocations(itemId, companyId, locationIds) {
  const ids = [...new Set((locationIds || []).filter(Boolean))];
  if (ids.length) {
    const valid = await query(
      `SELECT id FROM locations WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, ids]
    );
    if (valid.rows.length !== ids.length) {
      throw new Error('One or more locations are invalid');
    }
  }

  const prev = await query(
    `SELECT location_id::text FROM shopping_item_locations WHERE shopping_item_id = $1`,
    [itemId]
  );
  const prevIds = new Set(prev.rows.map((r) => r.location_id));
  const nextIds = new Set(ids);
  const removed = [...prevIds].filter((id) => !nextIds.has(id));

  await query(`DELETE FROM shopping_item_locations WHERE shopping_item_id = $1`, [itemId]);
  for (const locationId of ids) {
    await query(
      `INSERT INTO shopping_item_locations (shopping_item_id, location_id, company_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [itemId, locationId, companyId]
    );
  }

  for (const locationId of removed) {
    await query(
      `DELETE FROM shopping_inventory WHERE shopping_item_id = $1 AND location_id = $2`,
      [itemId, locationId]
    );
  }

  await query(
    `UPDATE shopping_items SET is_routine = $2, updated_at = NOW() WHERE id = $1 AND company_id = $3`,
    [itemId, ids.length > 0, companyId]
  );
}

// ── Item catalog ──────────────────────────────────────────────────────────────

router.get('/items', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT si.*,
              (SELECT COUNT(*) FROM shopping_item_purchases sip WHERE sip.shopping_item_id = si.id) AS purchase_count,
              (SELECT MAX(sip.purchase_date) FROM shopping_item_purchases sip WHERE sip.shopping_item_id = si.id) AS last_purchase_date,
              COALESCE(
                (SELECT array_agg(sil.location_id::text ORDER BY sil.location_id)
                 FROM shopping_item_locations sil WHERE sil.shopping_item_id = si.id),
                ARRAY[]::text[]
              ) AS location_ids
       FROM shopping_items si
       WHERE si.company_id = $1
       ORDER BY si.category NULLS LAST, si.name`,
      [cId(req)]
    );
    const items = r.rows.map((row) => ({
      ...row,
      is_routine: (row.location_ids?.length ?? 0) > 0,
    }));
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/items', requireAuth, async (req, res) => {
  try {
    const { name, description, category, par_qty, par_unit, notes, location_ids } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const company = cId(req);
    const locIds = location_ids || [];
    const r = await query(
      `INSERT INTO shopping_items (company_id, name, description, category, par_qty, par_unit, is_routine, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [company, name.trim(), description||null, category||null, optionalNumeric(par_qty),
       par_unit||'box', locIds.length > 0, notes||null, req.userId]
    );
    await setItemLocations(r.rows[0].id, company, locIds);
    res.status(201).json(await itemWithLocationIds(r.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/items/:id', requireAuth, async (req, res) => {
  try {
    const { name, description, category, par_qty, par_unit, is_routine, notes, location_ids } = req.body;
    const parQtyInBody = Object.prototype.hasOwnProperty.call(req.body, 'par_qty');
    const company = cId(req);
    const r = await query(
      `UPDATE shopping_items SET
         name        = COALESCE($2, name),
         description = COALESCE($3, description),
         category    = COALESCE($4, category),
         par_qty     = CASE WHEN $10 THEN $5 ELSE par_qty END,
         par_unit    = COALESCE($6, par_unit),
         is_routine  = COALESCE($7, is_routine),
         notes       = COALESCE($8, notes),
         updated_at  = NOW()
       WHERE id = $1 AND company_id = $9
       RETURNING *`,
      [req.params.id, name||null, description||null, category||null,
       optionalNumeric(par_qty), par_unit||null, is_routine??null, notes||null, company,
       parQtyInBody]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Item not found' });
    if (Object.prototype.hasOwnProperty.call(req.body, 'location_ids')) {
      await setItemLocations(req.params.id, company, location_ids);
    }
    res.json(await itemWithLocationIds(r.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/items/:id', requireAuth, async (req, res) => {
  try {
    await query(`DELETE FROM shopping_items WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]);
    res.status(204).send();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Categories (stored on shopping_items.category) ─────────────────────────────

router.get('/categories', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT min(trim(category)) AS name, COUNT(*)::int AS count
       FROM shopping_items
       WHERE company_id = $1 AND category IS NOT NULL AND trim(category) != ''
       GROUP BY lower(trim(category))
       ORDER BY name`,
      [cId(req)]
    );
    const unc = await query(
      `SELECT COUNT(*)::int AS count FROM shopping_items
       WHERE company_id = $1 AND (category IS NULL OR trim(category) = '')`,
      [cId(req)]
    );
    res.json({
      categories: r.rows,
      uncategorized_count: unc.rows[0]?.count ?? 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Move all items from one category to another (to_category null/empty = uncategorized) */
router.post('/categories/merge', requireAuth, async (req, res) => {
  try {
    const { from_category, to_category } = req.body;
    const from = from_category?.trim();
    if (!from) return res.status(400).json({ error: 'from_category is required' });
    const to = to_category?.trim() || null;
    if (to && to.toLowerCase() === from.toLowerCase()) {
      return res.status(400).json({ error: 'Source and target category are the same' });
    }
    const r = await query(
      `UPDATE shopping_items SET category = $2, updated_at = NOW()
       WHERE company_id = $1 AND lower(trim(category)) = lower($3)
       RETURNING id`,
      [cId(req), to, from]
    );
    res.json({ ok: true, updated: r.rowCount });
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
    const company = cId(req);
    const { matched } = req.query; // matched=true|false|all

    // Link receipt lines that already have a catalog item with the same name (case-insensitive)
    if (matched === 'false' || !matched) {
      await query(
        `UPDATE shopping_item_raw sir
         SET shopping_item_id = si.id, updated_at = NOW()
         FROM shopping_items si
         WHERE sir.company_id = $1
           AND sir.shopping_item_id IS NULL
           AND sir.ignored = false
           AND si.company_id = sir.company_id
           AND lower(trim(si.name)) = lower(trim(sir.description_raw))`,
        [company]
      );
    }

    let where = `sir.company_id = $1 AND sir.ignored = false`;
    if (matched === 'false' || !matched) {
      where += ` AND sir.shopping_item_id IS NULL`;
      where += ` AND NOT EXISTS (
         SELECT 1 FROM shopping_items si
         WHERE si.company_id = sir.company_id
           AND lower(trim(si.name)) = lower(trim(sir.description_raw))
       )`;
    } else if (matched === 'true') {
      where += ` AND sir.shopping_item_id IS NOT NULL`;
    }

    const r = await query(
      `SELECT sir.*, si.name AS matched_item_name
       FROM shopping_item_raw sir
       LEFT JOIN shopping_items si ON si.id = sir.shopping_item_id
       WHERE ${where}
       ORDER BY sir.purchase_count DESC, sir.last_purchase_date DESC NULLS LAST
       LIMIT 500`,
      [company]
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

    // Create new shopping_item if requested (or link if name already exists)
    if (create_new) {
      const newName = (create_new.name || raw.description_raw || '').trim();
      const existing = await query(
        `SELECT id FROM shopping_items
         WHERE company_id = $1 AND lower(trim(name)) = lower(trim($2))
         LIMIT 1`,
        [company, newName]
      );
      if (existing.rows.length) {
        itemId = existing.rows[0].id;
      } else {
        const newItem = await query(
          `INSERT INTO shopping_items (company_id, name, par_unit, created_by)
           VALUES ($1, $2, 'box', $3) RETURNING id`,
          [company, newName, req.userId]
        );
        itemId = newItem.rows[0].id;
      }
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
      `WITH agg AS (
         SELECT
           r.company_id,
           ri.description                    AS description_raw,
           COALESCE(r.vendor, 'Unknown')      AS vendor,
           MAX(r.order_date)                  AS last_purchase_date,
           COUNT(*)::integer                  AS purchase_count,
           (array_agg(ri.total ORDER BY r.order_date DESC NULLS LAST))[1] AS last_price
         FROM receipt_items ri
         JOIN receipts r ON r.id = ri.receipt_id AND r.company_id = $1
         WHERE r.status != 'excluded'
           AND ri.description IS NOT NULL AND ri.description != ''
         GROUP BY r.company_id, ri.description, COALESCE(r.vendor, 'Unknown')
       )
       INSERT INTO shopping_item_raw
         (company_id, description_raw, vendor, last_price, last_purchase_date, purchase_count)
       SELECT company_id, description_raw, vendor, last_price, last_purchase_date, purchase_count
       FROM agg
       ON CONFLICT (company_id, description_raw, vendor) DO UPDATE SET
         last_price         = COALESCE(EXCLUDED.last_price, shopping_item_raw.last_price),
         last_purchase_date = GREATEST(shopping_item_raw.last_purchase_date, EXCLUDED.last_purchase_date),
         purchase_count     = EXCLUDED.purchase_count,
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
    if (!location_id) {
      return res.status(400).json({ error: 'location_id is required' });
    }
    const r = await query(
      `SELECT si.id, si.name, si.category, si.par_qty, si.par_unit, si.notes,
              inv.id AS inv_id, sil.location_id, inv.current_qty, inv.sort_order,
              inv.last_counted_at, inv.last_counted_by,
              u.display_name AS last_counted_by_name,
              l.name AS location_name
       FROM shopping_items si
       INNER JOIN shopping_item_locations sil
         ON sil.shopping_item_id = si.id AND sil.location_id = $2 AND sil.company_id = $1
       LEFT JOIN shopping_inventory inv
         ON inv.shopping_item_id = si.id AND inv.location_id = sil.location_id AND inv.company_id = $1
       LEFT JOIN users u ON u.id = inv.last_counted_by
       LEFT JOIN locations l ON l.id = sil.location_id
       WHERE si.company_id = $1
       ORDER BY COALESCE(inv.sort_order, 9999), si.category NULLS LAST, si.name`,
      [cId(req), location_id]
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
       INNER JOIN shopping_item_locations sil
         ON sil.shopping_item_id = si.id AND sil.company_id = $1
         AND ($2::uuid IS NULL OR sil.location_id = $2::uuid)
       JOIN shopping_inventory inv
         ON inv.shopping_item_id = si.id AND inv.location_id = sil.location_id AND inv.company_id = $1
       LEFT JOIN locations l ON l.id = inv.location_id
       WHERE si.company_id = $1
         AND si.par_qty IS NOT NULL
         AND COALESCE(inv.current_qty, 0) < si.par_qty
       ORDER BY si.category NULLS LAST, si.name`,
      [cId(req), location_id || null]
    );
    res.json({ items: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Merge two catalog items ───────────────────────────────────────────────────
// Keep `keepId`, absorb all data from `mergeId`, delete `mergeId`
router.post('/items/:keepId/merge/:mergeId', requireAuth, async (req, res) => {
  try {
    const { keepId, mergeId } = req.params;
    const company = cId(req);
    if (keepId === mergeId) return res.status(400).json({ error: 'Cannot merge item with itself' });

    // Verify both items belong to this company
    const check = await query(
      `SELECT id FROM shopping_items WHERE id = ANY($1::uuid[]) AND company_id = $2`,
      [[keepId, mergeId], company]
    );
    if (check.rows.length < 2) return res.status(404).json({ error: 'One or both items not found' });

    // Move purchases
    await query(`UPDATE shopping_item_purchases SET shopping_item_id = $1 WHERE shopping_item_id = $2`, [keepId, mergeId]);
    // Move raw links
    await query(`UPDATE shopping_item_raw SET shopping_item_id = $1, fuzzy_match_id = NULL WHERE shopping_item_id = $2 OR fuzzy_match_id = $2`, [keepId, mergeId]);
    // Move inventory (skip if location already has an entry for keepId)
    await query(
      `INSERT INTO shopping_inventory (shopping_item_id, location_id, company_id, current_qty, sort_order, last_counted_at, last_counted_by)
       SELECT $1, location_id, company_id, current_qty, sort_order, last_counted_at, last_counted_by
       FROM shopping_inventory WHERE shopping_item_id = $2
       ON CONFLICT (shopping_item_id, location_id) DO NOTHING`,
      [keepId, mergeId]
    );
    // Move log
    await query(`UPDATE shopping_inventory_log SET shopping_item_id = $1 WHERE shopping_item_id = $2`, [keepId, mergeId]);
    // Delete merged item
    await query(`DELETE FROM shopping_items WHERE id = $1 AND company_id = $2`, [mergeId, company]);

    const kept = await query(`SELECT * FROM shopping_items WHERE id = $1`, [keepId]);
    res.json({ ok: true, item: kept.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AI duplicate detection ────────────────────────────────────────────────────
// Scan catalog for likely duplicates using Claude
router.post('/items/find-duplicates', requireAuth, async (req, res) => {
  try {
    const company = cId(req);

    // Get API key
    const integRes = await query(`SELECT anthropic_api_key FROM company_integrations WHERE company_id = $1`, [company]);
    const apiKey = integRes.rows[0]?.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'Anthropic API key not configured' });

    const itemsRes = await query(`SELECT id, name FROM shopping_items WHERE company_id = $1 ORDER BY name`, [company]);
    const items = itemsRes.rows;
    if (items.length < 2) return res.json({ groups: [] });

    const client = new Anthropic({ apiKey });
    const list = items.map((i, idx) => `${idx + 1}. [${i.id}] ${i.name}`).join('\n');

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are reviewing a product catalog for duplicates. These are items purchased by a winery/tasting room.

Find groups of items that are clearly the same product despite minor description differences (different wording, truncation, punctuation, "Retail" added, etc.).

Return ONLY valid JSON — an array of groups. Each group has the IDs of items that should be merged:
[
  { "ids": ["uuid1", "uuid2"], "reason": "same product, minor wording difference" }
]

Return [] if no duplicates found. Only include high-confidence duplicates.

Items:
${list}`,
      }],
    });

    const raw = msg.content[0].text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    let groups;
    try { groups = JSON.parse(raw); } catch { groups = []; }

    // Enrich with item names
    const itemMap = Object.fromEntries(items.map((i) => [i.id, i.name]));
    const enriched = (groups || []).map((g) => ({
      ...g,
      items: (g.ids || []).map((id) => ({ id, name: itemMap[id] || id })),
    }));

    res.json({ groups: enriched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AI pack-size extraction ───────────────────────────────────────────────────
// Extract quantity + unit from a product description
router.post('/items/:id/extract-unit', requireAuth, async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'description required' });

    const integRes = await query(`SELECT anthropic_api_key FROM company_integrations WHERE company_id = $1`, [cId(req)]);
    const apiKey = integRes.rows[0]?.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ quantity: null, unit: null }); // graceful fallback

    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: `Extract the pack size and unit from this product description. Return ONLY valid JSON with no explanation:
{"quantity": <number or null>, "unit": "<singular unit name or null>"}

Examples:
"Box of 1000 Nitrile Gloves" → {"quantity": 1000, "unit": "glove"}
"50Pcs Kraft Paper Bags" → {"quantity": 50, "unit": "bag"}
"Case of 12 bottles" → {"quantity": 12, "unit": "bottle"}
"Hand soap" → {"quantity": null, "unit": null}

Description: ${description}`,
      }],
    });

    const raw = msg.content[0].text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    try { res.json(JSON.parse(raw)); } catch { res.json({ quantity: null, unit: null }); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fuzzy match queue (items flagged by Layer 2) ──────────────────────────────
router.get('/raw/fuzzy', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT sir.id, sir.description_raw, sir.vendor, sir.last_price,
              sir.last_purchase_date, sir.purchase_count, sir.similarity_score,
              si.id AS match_id, si.name AS match_name
       FROM shopping_item_raw sir
       JOIN shopping_items si ON si.id = sir.fuzzy_match_id
       WHERE sir.company_id = $1
         AND sir.ignored = false
         AND sir.shopping_item_id IS NULL
         AND sir.fuzzy_match_id IS NOT NULL
       ORDER BY sir.similarity_score DESC`,
      [cId(req)]
    );
    res.json({ fuzzy: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export { router as shoppingRouter };
