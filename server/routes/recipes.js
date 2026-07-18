import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { requireManager, requireInventoryAccess } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTO_DIR = path.join(__dirname, '..', 'uploads', 'recipes');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const photoStorage = multer.diskStorage({
  destination: PHOTO_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

const router = express.Router();
const cId = (req) => req.companyId;

// Classify a vendor product category as grocery (food) or not. Returns
// true (food), false (non-grocery: paper/janitorial/packaging), or null (unknown).
const NON_FOOD_RE = /janitor|jantrl|chemical|cleaner|disinf|sanit|bleach|detergent|\bpaper\b|napkin|\btowel|tissue|\bwipe|\bcup\b|\blid\b|straw|cutlery|utensil|\bplate|\bbowl\b|\bbox\b|carton|\bbag\b|\bfilm\b|\bfoil\b|\bwrap\b|container|packag|\btray|glove|apron|hairnet|uniform|apparel|equipment|smallware|\boffice\b|\bliner|trash|disposable/i;
function classifyFood(category) {
  if (!category) return null;
  return !NON_FOOD_RE.test(category);
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function getRecipeLocations(recipeId) {
  const r = await query(
    `SELECT location_id::text FROM recipe_locations WHERE recipe_id = $1`,
    [recipeId]
  );
  return r.rows.map((row) => row.location_id);
}

async function setRecipeLocations(recipeId, locationIds) {
  await query(`DELETE FROM recipe_locations WHERE recipe_id = $1`, [recipeId]);
  for (const lid of (locationIds || [])) {
    await query(
      `INSERT INTO recipe_locations (recipe_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [recipeId, lid]
    );
  }
}

/** Empty string / invalid → null for numeric DB columns */
function optionalNumeric(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Replace which locations stock an ingredient. Validates the ids belong to the
 * company, then drops on-hand counts for any location no longer stocked.
 */
async function setIngredientLocations(ingredientId, companyId, locationIds) {
  const ids = [...new Set((locationIds || []).filter(Boolean))];
  if (ids.length) {
    const valid = await query(
      `SELECT id FROM locations WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, ids]
    );
    if (valid.rows.length !== ids.length) throw new Error('One or more locations are invalid');
  }

  const prev = await query(
    `SELECT location_id::text FROM ingredient_locations WHERE ingredient_id = $1`,
    [ingredientId]
  );
  const nextIds = new Set(ids);
  const removed = prev.rows.map((r) => r.location_id).filter((id) => !nextIds.has(id));

  await query(`DELETE FROM ingredient_locations WHERE ingredient_id = $1`, [ingredientId]);
  for (const lid of ids) {
    await query(
      `INSERT INTO ingredient_locations (ingredient_id, location_id, company_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [ingredientId, lid, companyId]
    );
  }
  for (const lid of removed) {
    await query(
      `DELETE FROM ingredient_inventory WHERE ingredient_id = $1 AND location_id = $2`,
      [ingredientId, lid]
    );
  }
}

async function getRecipeIngredients(recipeId) {
  const r = await query(
    `SELECT ri.id, ri.ingredient_id, ri.quantity, ri.unit, ri.position, ri.note,
            i.name AS ingredient_name, i.description AS ingredient_description,
            i.base_unit, i.is_active,
            sir.last_price AS source_last_price,
            sir.last_purchase_date AS source_last_purchase_date,
            sir.description_raw AS source_description,
            sir.vendor AS source_vendor,
            cg.grams AS container_grams,
            -- ingredient quantity converted to grams
            CASE ri.unit
              WHEN 'g'  THEN ri.quantity
              WHEN 'kg' THEN ri.quantity * 1000
              WHEN 'lb' THEN ri.quantity * 453.592
              WHEN 'oz' THEN ri.quantity * 28.3495
              ELSE ri.quantity
            END AS ingredient_grams,
            -- servings per container = container_grams / ingredient_grams
            CASE
              WHEN cg.grams > 0
               AND CASE ri.unit WHEN 'g' THEN ri.quantity WHEN 'kg' THEN ri.quantity * 1000
                                WHEN 'lb' THEN ri.quantity * 453.592 WHEN 'oz' THEN ri.quantity * 28.3495
                                ELSE ri.quantity END > 0
              THEN ROUND(cg.grams /
                CASE ri.unit WHEN 'g' THEN ri.quantity WHEN 'kg' THEN ri.quantity * 1000
                             WHEN 'lb' THEN ri.quantity * 453.592 WHEN 'oz' THEN ri.quantity * 28.3495
                             ELSE ri.quantity END
              , 2)
            END AS servings_per_container,
            -- COGS = (ingredient_grams / container_grams) * container_price
            CASE
              WHEN cg.grams > 0
               AND CASE ri.unit WHEN 'g' THEN ri.quantity WHEN 'kg' THEN ri.quantity * 1000
                                WHEN 'lb' THEN ri.quantity * 453.592 WHEN 'oz' THEN ri.quantity * 28.3495
                                ELSE ri.quantity END > 0
               AND sir.last_price IS NOT NULL
              THEN ROUND(
                CASE ri.unit WHEN 'g' THEN ri.quantity WHEN 'kg' THEN ri.quantity * 1000
                             WHEN 'lb' THEN ri.quantity * 453.592 WHEN 'oz' THEN ri.quantity * 28.3495
                             ELSE ri.quantity END
                / cg.grams * sir.last_price
              , 4)
            END AS cogs_contribution
     FROM recipe_ingredients ri
     JOIN ingredients i ON i.id = ri.ingredient_id
     LEFT JOIN shopping_item_raw sir
            ON sir.ingredient_id = ri.ingredient_id
           AND sir.is_recipe_primary = true
           AND sir.company_id = (SELECT company_id FROM recipes WHERE id = $1)
     LEFT JOIN LATERAL (
       SELECT COALESCE(
         ri2.quantity_grams,
         -- fallback: recompute from catalog unit override when receipt has no grams
         CASE sir.unit
           WHEN 'g'  THEN ri2.quantity
           WHEN 'kg' THEN ri2.quantity * 1000
           WHEN 'lb' THEN ri2.quantity * 453.592
           WHEN 'oz' THEN ri2.quantity * 28.3495
           ELSE NULL
         END
       ) AS grams
       FROM receipt_items ri2
       JOIN receipts rec ON rec.id = ri2.receipt_id
       WHERE rec.company_id = (SELECT company_id FROM recipes WHERE id = $1)
         AND lower(trim(ri2.description)) = sir.description_raw
         AND rec.vendor IS NOT DISTINCT FROM sir.vendor
       ORDER BY rec.order_date DESC NULLS LAST
       LIMIT 1
     ) cg ON true
     WHERE ri.recipe_id = $1
     ORDER BY ri.position, ri.id`,
    [recipeId]
  );
  return r.rows;
}

// ── CATALOG (shopping_item_raw) ───────────────────────────────────────────────

// POST /api/recipes/catalog/backfill
// One-time backfill: seed shopping_item_raw from all historical receipt_items.
// Safe to run multiple times — ON CONFLICT updates are idempotent.
router.post('/catalog/backfill', requireManager, async (req, res) => {
  try {
    const r = await query(
      `WITH grouped AS (
         SELECT
           r.company_id,
           lower(trim(ri.description)) AS description_raw,
           r.vendor,
           MAX(r.order_date)           AS last_purchase_date,
           COUNT(*)                    AS purchase_count
         FROM receipt_items ri
         JOIN receipts r ON r.id = ri.receipt_id
         WHERE ri.description IS NOT NULL
           AND trim(ri.description) != ''
           AND r.company_id = $1
         GROUP BY r.company_id, lower(trim(ri.description)), r.vendor
       )
       INSERT INTO shopping_item_raw
         (company_id, description_raw, vendor, last_price, last_purchase_date, purchase_count)
       SELECT
         g.company_id,
         g.description_raw,
         g.vendor,
         (SELECT ri2.unit_price
          FROM receipt_items ri2
          JOIN receipts r2 ON r2.id = ri2.receipt_id
          WHERE r2.company_id = g.company_id
            AND lower(trim(ri2.description)) = g.description_raw
            AND r2.vendor IS NOT DISTINCT FROM g.vendor
          ORDER BY r2.order_date DESC NULLS LAST
          LIMIT 1) AS last_price,
         g.last_purchase_date,
         g.purchase_count
       FROM grouped g
       ON CONFLICT (company_id, description_raw, vendor) DO UPDATE SET
         purchase_count     = GREATEST(shopping_item_raw.purchase_count, EXCLUDED.purchase_count),
         last_price         = COALESCE(EXCLUDED.last_price, shopping_item_raw.last_price),
         last_purchase_date = GREATEST(shopping_item_raw.last_purchase_date, EXCLUDED.last_purchase_date),
         updated_at         = NOW()
       WHERE shopping_item_raw.ignored = false`,
      [cId(req)]
    );
    res.json({ inserted: r.rowCount ?? 0 });
  } catch (err) {
    console.error('Catalog backfill error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recipes/catalog/enrich
// Pull clean product data (name, pack, UOM) from vendor catalogs and store it on
// shopping_item_raw. Chef Store → Algolia (public); Sysco → authenticated GraphQL.
// Body: { ids?: [catalog row ids] }  — omit to enrich all un-enriched linked items.
router.post('/catalog/enrich', requireManager, async (req, res) => {
  const companyId = cId(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  try {
    // Select catalog rows that have a vendor item number to look up
    const rows = (await query(
      `SELECT id, vendor, vendor_item_number
       FROM shopping_item_raw
       WHERE company_id = $1
         AND vendor_item_number IS NOT NULL
         AND ignored = false
         ${ids ? 'AND id = ANY($2)' : 'AND enriched_at IS NULL'}`,
      ids ? [companyId, ids] : [companyId]
    )).rows;

    if (!rows.length) return res.json({ enriched: 0, failed: 0, results: [] });

    // Group by vendor family
    const sysco = rows.filter((r) => /sysco/i.test(r.vendor || ''));
    const chef  = rows.filter((r) => /chef/i.test(r.vendor || ''));

    const byItem = new Map(); // `${vendor}|${item}` -> parsed
    const failures = [];

    if (chef.length) {
      const { enrichChefstoreItems } = await import('../lib/chefstoreEnrich.js');
      const out = await enrichChefstoreItems(chef.map((r) => r.vendor_item_number));
      for (const r of out.results) {
        if (r.parsed) byItem.set(`chef|${r.itemNumber}`, r.parsed);
        else failures.push({ vendor: 'Chef Store', item: r.itemNumber, error: r.error || 'no match' });
      }
    }

    if (sysco.length) {
      const { enrichSyscoItems } = await import('../lib/syscoSync.js');
      const out = await enrichSyscoItems(companyId, sysco.map((r) => r.vendor_item_number));
      for (const r of out.results) {
        if (r.parsed) byItem.set(`sysco|${r.itemNumber}`, r.parsed);
        else failures.push({ vendor: 'Sysco', item: r.itemNumber, error: r.error || 'no match' });
      }
    }

    // Write results back
    let enriched = 0;
    for (const row of rows) {
      const fam = /sysco/i.test(row.vendor || '') ? 'sysco' : (/chef/i.test(row.vendor || '') ? 'chef' : null);
      if (!fam) continue;
      const parsed = byItem.get(`${fam}|${row.vendor_item_number}`);
      if (!parsed) continue;
      await query(
        `UPDATE shopping_item_raw
         SET product_name = $2, uom = $3, pack = $4,
             category = $5, is_food = $6,
             enrich_source = $7, enriched_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [row.id, parsed.name || null, parsed.uom || null, parsed.pack || null,
         parsed.category || null, classifyFood(parsed.category),
         fam === 'sysco' ? 'sysco' : 'chefstore']
      );
      enriched++;
    }

    res.json({ enriched, failed: failures.length, failures: failures.slice(0, 20) });
  } catch (err) {
    console.error('Catalog enrich error:', err);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/recipes/catalog
// List raw receipt items for the catalog UI.
// Query params: status=pending|linked|ignored|all (default: all except ignored)
router.get('/catalog', requireManager, async (req, res) => {
  const { status = 'unignored', search = '', page = '1', limit = '100', grocery = '1' } = req.query;
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  let whereExtra = '';
  if (status === 'pending')   whereExtra = `AND sir.ingredient_id IS NULL AND sir.ignored = false`;
  if (status === 'linked')    whereExtra = `AND sir.ingredient_id IS NOT NULL AND sir.ignored = false`;
  if (status === 'ignored')   whereExtra = `AND sir.ignored = true`;
  if (status === 'unignored') whereExtra = `AND sir.ignored = false`;

  // Hide known non-grocery items by default (is_food = false). Items not yet
  // classified (is_food NULL) stay visible. grocery=0/all shows everything.
  if (grocery !== '0' && grocery !== 'all') whereExtra += ` AND sir.is_food IS DISTINCT FROM false`;

  const searchClause = search
    ? `AND (
         lower(sir.description_raw)                    LIKE '%' || lower($4) || '%'
         OR lower(COALESCE(sir.product_name,       '')) LIKE '%' || lower($4) || '%'
         OR lower(COALESCE(sir.vendor_item_number, '')) LIKE '%' || lower($4) || '%'
         OR lower(COALESCE(sir.vendor,             '')) LIKE '%' || lower($4) || '%'
         OR lower(COALESCE(sir.category,           '')) LIKE '%' || lower($4) || '%'
       )`
    : '';

  const params = [cId(req), parseInt(limit, 10), offset];
  if (search) params.push(search);

  const r = await query(
    `SELECT sir.id, sir.description_raw, sir.vendor, sir.last_price,
            sir.last_purchase_date, sir.purchase_count, sir.ignored,
            sir.is_recipe_primary, sir.unit, sir.vendor_item_number,
            sir.product_name, sir.uom, sir.pack, sir.enriched_at, sir.enrich_source,
            sir.category, sir.is_food,
            sir.ingredient_id, i.name AS ingredient_name, i.base_unit,
            (SELECT ri.quantity
             FROM receipt_items ri
             JOIN receipts rec ON rec.id = ri.receipt_id
             WHERE rec.company_id = sir.company_id
               AND lower(trim(ri.description)) = sir.description_raw
               AND rec.vendor IS NOT DISTINCT FROM sir.vendor
             ORDER BY rec.order_date DESC NULLS LAST
             LIMIT 1) AS last_quantity,
            (SELECT ri.quantity_unit
             FROM receipt_items ri
             JOIN receipts rec ON rec.id = ri.receipt_id
             WHERE rec.company_id = sir.company_id
               AND lower(trim(ri.description)) = sir.description_raw
               AND rec.vendor IS NOT DISTINCT FROM sir.vendor
             ORDER BY rec.order_date DESC NULLS LAST
             LIMIT 1) AS last_quantity_unit,
            (SELECT ri.quantity_grams
             FROM receipt_items ri
             JOIN receipts rec ON rec.id = ri.receipt_id
             WHERE rec.company_id = sir.company_id
               AND lower(trim(ri.description)) = sir.description_raw
               AND rec.vendor IS NOT DISTINCT FROM sir.vendor
               AND ri.quantity_grams IS NOT NULL
             ORDER BY rec.order_date DESC NULLS LAST
             LIMIT 1) AS last_quantity_grams
     FROM shopping_item_raw sir
     LEFT JOIN ingredients i ON i.id = sir.ingredient_id
     WHERE sir.company_id = $1
       ${whereExtra} ${searchClause}
     ORDER BY sir.purchase_count DESC, sir.last_purchase_date DESC NULLS LAST
     LIMIT $2 OFFSET $3`,
    params
  ).catch((err) => { throw err; });

  const countParams = [cId(req)];
  if (search) countParams.push(search);
  const total = await query(
    `SELECT COUNT(*)::int AS n FROM shopping_item_raw
     WHERE company_id = $1 ${whereExtra} ${search ? `AND (
       lower(description_raw)                    LIKE '%' || lower($2) || '%'
       OR lower(COALESCE(product_name,       '')) LIKE '%' || lower($2) || '%'
       OR lower(COALESCE(vendor_item_number, '')) LIKE '%' || lower($2) || '%'
       OR lower(COALESCE(vendor,             '')) LIKE '%' || lower($2) || '%'
       OR lower(COALESCE(category,           '')) LIKE '%' || lower($2) || '%'
     )` : ''}`,
    countParams
  ).catch(() => ({ rows: [{ n: 0 }] }));

  res.json({ items: r.rows, total: total.rows[0]?.n ?? r.rows.length });
});

// GET /api/recipes/catalog/:id/purchases
// All receipt line items linked to a shopping_item_raw row, ordered newest first.
router.get('/catalog/:id/purchases', requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT
         r.order_date,
         r.order_number,
         r.vendor,
         ri.quantity,
         ri.quantity_unit,
         ri.unit_price,
         ri.total,
         ri.description,
         ri.pack
       FROM receipt_items ri
       JOIN receipts r ON r.id = ri.receipt_id
       WHERE ri.raw_item_id = $1
         AND r.company_id   = $2
       ORDER BY r.order_date DESC NULLS LAST, r.created_at DESC`,
      [req.params.id, cId(req)]
    );
    res.json({ purchases: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/recipes/catalog/:id
router.patch('/catalog/:id', requireManager, async (req, res) => {
  const { ingredient_id, is_recipe_primary, ignored, unit } = req.body;

  if (is_recipe_primary === true && ingredient_id) {
    await query(
      `UPDATE shopping_item_raw SET is_recipe_primary = false
       WHERE ingredient_id = $1 AND company_id = $2`,
      [ingredient_id, cId(req)]
    );
  }

  const setClauses = [];
  const params = [];
  let p = 1;

  if (ingredient_id !== undefined)     { setClauses.push(`ingredient_id = $${p++}`);     params.push(ingredient_id || null); }
  if (is_recipe_primary !== undefined) { setClauses.push(`is_recipe_primary = $${p++}`); params.push(!!is_recipe_primary); }
  if (ignored !== undefined)           { setClauses.push(`ignored = $${p++}`);            params.push(!!ignored); }
  if (unit !== undefined)              { setClauses.push(`unit = $${p++}`);               params.push(unit || null); }
  setClauses.push(`updated_at = NOW()`);

  if (setClauses.length === 1) return res.status(400).json({ error: 'Nothing to update' });

  params.push(req.params.id, cId(req));
  const r = await query(
    `UPDATE shopping_item_raw SET ${setClauses.join(', ')}
     WHERE id = $${p} AND company_id = $${p + 1} RETURNING *`,
    params
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ item: r.rows[0] });
});

// POST /api/recipes/catalog/bulk-unit
// Set unit on multiple catalog items at once.
// Body: { ids: string[], unit: string }
router.post('/catalog/bulk-unit', requireManager, async (req, res) => {
  const { ids, unit } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  try {
    await query(
      `UPDATE shopping_item_raw SET unit = $1, updated_at = NOW()
       WHERE id = ANY($2::uuid[]) AND company_id = $3`,
      [unit || null, ids, cId(req)]
    );
    res.json({ ok: true, updated: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recipes/catalog/infer-units
// Three-tier unit inference for catalog items where unit IS NULL.
//   Tier 1: Sysco pack string rules (regex, no AI)
//   Tier 2: Most recent non-'each' quantity_unit from receipt_items
//   Tier 3: AI batch classification for anything still unresolved
router.post('/catalog/infer-units', requireManager, async (req, res) => {
  const companyId = cId(req);

  // ── Pack-string heuristic ─────────────────────────────────────────────────
  function inferFromPack(pack) {
    if (!pack) return null;
    const p = pack.trim().toUpperCase();
    if (/#AVG/.test(p)) return 'lb';                    // e.g. 110#AVG — average catch-weight
    if (/\d+(\.\d+)?\s*LB/.test(p)) return 'lb';       // e.g. 125 LB, 5LB
    if (/\d+#\d+/.test(p)) return 'case';               // e.g. 6#10 — 6 cans of #10 size
    if (/\d+#\s*$/.test(p)) return 'lb';                // e.g. "5#" — bare lb weight
    if (/\bCT\b/.test(p) || /\bEA\b/.test(p)) return 'each';
    if (/\bCS\b/.test(p) || /\d+X\d+/.test(p)) return 'case';
    if (/\bOZ\b/.test(p)) return 'oz';
    return null;
  }

  try {
    // Fetch all null-unit items with their best pack string and last non-'each' receipt unit
    const { rows: items } = await query(
      `SELECT sir.id, sir.description_raw, sir.vendor,
              (SELECT ri.pack
               FROM receipt_items ri
               JOIN receipts rec ON rec.id = ri.receipt_id
               WHERE rec.company_id = sir.company_id
                 AND lower(trim(ri.description)) = sir.description_raw
                 AND rec.vendor IS NOT DISTINCT FROM sir.vendor
                 AND ri.pack IS NOT NULL
               ORDER BY rec.order_date DESC NULLS LAST
               LIMIT 1) AS last_pack,
              (SELECT ri.quantity_unit
               FROM receipt_items ri
               JOIN receipts rec ON rec.id = ri.receipt_id
               WHERE rec.company_id = sir.company_id
                 AND lower(trim(ri.description)) = sir.description_raw
                 AND rec.vendor IS NOT DISTINCT FROM sir.vendor
                 AND ri.quantity_unit IS NOT NULL
                 AND ri.quantity_unit != 'each'
               ORDER BY rec.order_date DESC NULLS LAST
               LIMIT 1) AS last_non_each_unit
       FROM shopping_item_raw sir
       WHERE sir.company_id = $1 AND sir.unit IS NULL AND sir.ignored = false
       ORDER BY sir.description_raw`,
      [companyId]
    );

    if (items.length === 0) {
      return res.json({ ok: true, tier1: 0, tier2: 0, tier3: 0, total: 0 });
    }

    const t1Updates = new Map(), t2Updates = new Map(), t3Updates = new Map();
    const needsAI = [];

    for (const item of items) {
      const packUnit = inferFromPack(item.last_pack);
      if (packUnit) {
        t1Updates.set(item.id, packUnit);
      } else if (item.last_non_each_unit) {
        t2Updates.set(item.id, item.last_non_each_unit);
      } else {
        needsAI.push(item);
      }
    }

    // ── Tier 3: AI batch inference ────────────────────────────────────────────
    if (needsAI.length > 0) {
      const integRes = await query(
        `SELECT anthropic_api_key FROM company_integrations WHERE company_id = $1`, [companyId]
      );
      const apiKey = integRes.rows[0]?.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
      const client = apiKey ? new Anthropic({ apiKey }) : null;

      if (client) {
        const BATCH = 60;
        for (let i = 0; i < needsAI.length; i += BATCH) {
          const chunk = needsAI.slice(i, i + BATCH);
          const payload = chunk.map((it) => ({
            id: it.id,
            description: it.description_raw,
            vendor: it.vendor || null,
            pack: it.last_pack || null,
          }));
          try {
            const msg = await client.messages.create({
              model: 'claude-haiku-4-5',
              max_tokens: 2048,
              messages: [{
                role: 'user',
                content: `Classify each item's unit of measure. Return ONLY a JSON array — no markdown.

Valid units: "lb" (weight, pounds), "oz" (weight, ounces), "g" (grams), "kg" (kilograms), "each" (individual unit), "case" (pack/case of multiple).

Guidelines:
- Fresh/bulk food sold by weight (cheese, meat, produce, fish) → "lb"
- Small weight items (spices, extracts) → "oz" or "g"
- Packaged goods sold individually (bottles, cans, bags) → "each"
- Multi-unit packs ordered as a case → "case"
- Amazon items are almost always "each"
- If Sysco vendor and description sounds like fresh/bulk food → "lb"

Input: ${JSON.stringify(payload)}

Return: [{"id":"...","unit":"..."},...]`,
              }],
            });
            const raw = msg.content[0].text.trim()
              .replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
            const results = JSON.parse(raw);
            for (const r of results) {
              if (r.id && r.unit) t3Updates.set(r.id, r.unit);
            }
          } catch (aiErr) {
            console.warn('[infer-units] AI batch failed:', aiErr.message);
          }
        }
      }
    }

    // ── Apply all updates in one query per tier ───────────────────────────────
    const applyUpdates = async (updateMap) => {
      for (const [unit, ids] of Object.entries(
        [...updateMap.entries()].reduce((acc, [id, u]) => {
          (acc[u] = acc[u] || []).push(id); return acc;
        }, {})
      )) {
        await query(
          `UPDATE shopping_item_raw SET unit = $1, updated_at = NOW()
           WHERE id = ANY($2::uuid[]) AND company_id = $3`,
          [unit, ids, companyId]
        );
      }
    };

    await applyUpdates(t1Updates);
    await applyUpdates(t2Updates);
    await applyUpdates(t3Updates);

    res.json({
      ok: true,
      tier1: t1Updates.size,
      tier2: t2Updates.size,
      tier3: t3Updates.size,
      total: t1Updates.size + t2Updates.size + t3Updates.size,
      unresolved: needsAI.length - t3Updates.size,
    });
  } catch (err) {
    console.error('[infer-units]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── INGREDIENTS ───────────────────────────────────────────────────────────────

// GET /api/recipes/ingredients
router.get('/ingredients', requireManager, async (req, res) => {
  const r = await query(
    `SELECT
       i.id, i.name, i.description, i.base_unit, i.is_active,
       i.par_qty, i.par_unit, i.buy_frequency,
       i.buy_day_of_week, i.buy_day_of_month, i.buy_week_of_month,
       i.created_at, i.updated_at,
       COALESCE(
         (SELECT json_agg(il.location_id::text) FROM ingredient_locations il WHERE il.ingredient_id = i.id),
         '[]'
       ) AS location_ids,
       COALESCE(
         json_agg(
           json_build_object(
             'id',                 sir.id,
             'description_raw',    sir.description_raw,
             'product_name',       sir.product_name,
             'vendor',             sir.vendor,
             'vendor_item_number', sir.vendor_item_number,
             'pack',               sir.pack,
             'uom',                sir.uom,
             'last_price',         sir.last_price,
             'last_purchase_date', sir.last_purchase_date,
             'purchase_count',     sir.purchase_count,
             'is_recipe_primary',  sir.is_recipe_primary
           ) ORDER BY sir.is_recipe_primary DESC, sir.last_purchase_date DESC NULLS LAST
         ) FILTER (WHERE sir.id IS NOT NULL),
         '[]'
       ) AS sources
     FROM ingredients i
     LEFT JOIN shopping_item_raw sir
            ON sir.ingredient_id = i.id AND sir.company_id = i.company_id
     WHERE i.company_id = $1
     GROUP BY i.id
     ORDER BY i.name`,
    [cId(req)]
  );
  const ingredients = r.rows.map((row) => ({
    ...row,
    is_routine: (row.location_ids?.length ?? 0) > 0,
  }));
  res.json({ ingredients });
});

// GET /api/recipes/ingredients/:id  (with linked sources)
router.get('/ingredients/:id', requireManager, async (req, res) => {
  const ing = await query(
    `SELECT id, name, description, base_unit, is_active, created_at, updated_at
     FROM ingredients WHERE id = $1 AND company_id = $2`,
    [req.params.id, cId(req)]
  );
  if (!ing.rows.length) return res.status(404).json({ error: 'Not found' });

  const sources = await query(
    `SELECT id, description_raw, vendor, last_price, last_purchase_date,
            purchase_count, servings_per_container, is_recipe_primary, ignored
     FROM shopping_item_raw
     WHERE ingredient_id = $1 AND company_id = $2
     ORDER BY is_recipe_primary DESC, last_purchase_date DESC NULLS LAST`,
    [req.params.id, cId(req)]
  );

  res.json({ ingredient: ing.rows[0], sources: sources.rows });
});

// POST /api/recipes/ingredients
router.post('/ingredients', requireManager, async (req, res) => {
  const { name, description, base_unit } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const r = await query(
    `INSERT INTO ingredients (company_id, name, description, base_unit)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [cId(req), name.trim(), description || null, base_unit || null]
  );
  res.status(201).json({ ingredient: r.rows[0] });
});

// PATCH /api/recipes/ingredients/:id
router.patch('/ingredients/:id', requireManager, async (req, res) => {
  const {
    name, description, base_unit, is_active,
    par_qty, par_unit, buy_frequency,
    buy_day_of_week, buy_day_of_month, buy_week_of_month,
    location_ids,
  } = req.body;
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

  const setClauses = [];
  const params = [];
  let p = 1;
  if (name !== undefined)        { setClauses.push(`name = $${p++}`);        params.push(name.trim()); }
  if (description !== undefined) { setClauses.push(`description = $${p++}`); params.push(description); }
  if (base_unit !== undefined)   { setClauses.push(`base_unit = $${p++}`);   params.push(base_unit); }
  if (is_active !== undefined)   { setClauses.push(`is_active = $${p++}`);   params.push(!!is_active); }
  if (has('par_qty'))            { setClauses.push(`par_qty = $${p++}`);            params.push(optionalNumeric(par_qty)); }
  if (par_unit !== undefined)    { setClauses.push(`par_unit = $${p++}`);           params.push(par_unit || null); }
  if (has('buy_frequency'))      { setClauses.push(`buy_frequency = $${p++}`);      params.push(buy_frequency || null); }
  if (has('buy_day_of_week'))    { setClauses.push(`buy_day_of_week = $${p++}`);    params.push(optionalNumeric(buy_day_of_week)); }
  if (has('buy_day_of_month'))   { setClauses.push(`buy_day_of_month = $${p++}`);   params.push(optionalNumeric(buy_day_of_month)); }
  if (has('buy_week_of_month'))  { setClauses.push(`buy_week_of_month = $${p++}`);  params.push(optionalNumeric(buy_week_of_month)); }

  if (setClauses.length) {
    setClauses.push(`updated_at = NOW()`);
    params.push(req.params.id, cId(req));
    const r = await query(
      `UPDATE ingredients SET ${setClauses.join(', ')}
       WHERE id = $${p} AND company_id = $${p + 1} RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  }

  if (has('location_ids')) {
    await setIngredientLocations(req.params.id, cId(req), location_ids);
  }

  const out = await query(
    `SELECT i.*,
            COALESCE((SELECT json_agg(il.location_id::text) FROM ingredient_locations il WHERE il.ingredient_id = i.id), '[]') AS location_ids
     FROM ingredients i WHERE i.id = $1 AND i.company_id = $2`,
    [req.params.id, cId(req)]
  );
  if (!out.rows.length) return res.status(404).json({ error: 'Not found' });
  const ingredient = { ...out.rows[0], is_routine: (out.rows[0].location_ids?.length ?? 0) > 0 };
  res.json({ ingredient });
});

// DELETE /api/recipes/ingredients/:id
router.delete('/ingredients/:id', requireManager, async (req, res) => {
  const inUse = await query(
    `SELECT 1 FROM recipe_ingredients ri
     JOIN recipes r ON r.id = ri.recipe_id
     WHERE ri.ingredient_id = $1 AND r.company_id = $2 LIMIT 1`,
    [req.params.id, cId(req)]
  );
  if (inUse.rows.length) return res.status(409).json({ error: 'Ingredient is used in one or more recipes' });

  await query(
    `UPDATE shopping_item_raw SET ingredient_id = NULL, is_recipe_primary = false
     WHERE ingredient_id = $1 AND company_id = $2`,
    [req.params.id, cId(req)]
  );
  await query(
    `DELETE FROM ingredients WHERE id = $1 AND company_id = $2`,
    [req.params.id, cId(req)]
  );
  res.json({ ok: true });
});

// ── INVENTORY (on-hand counts per ingredient per location) ────────────────────

// GET /api/recipes/inventory?location_id=…  — ingredients stocked at a location
router.get('/inventory', requireInventoryAccess, async (req, res) => {
  const { location_id } = req.query;
  if (!location_id) return res.status(400).json({ error: 'location_id is required' });
  const r = await query(
    `SELECT i.id, i.name, i.base_unit,
            COALESCE(il.par_qty, i.par_qty)   AS par_qty,
            COALESCE(il.par_unit, i.par_unit) AS par_unit,
            inv.location_id, inv.current_qty, inv.sort_order,
            inv.last_counted_at, inv.last_counted_by,
            u.display_name AS last_counted_by_name,
            l.name AS location_name
     FROM ingredients i
     INNER JOIN ingredient_locations il
       ON il.ingredient_id = i.id AND il.location_id = $2 AND il.company_id = $1
     LEFT JOIN ingredient_inventory inv
       ON inv.ingredient_id = i.id AND inv.location_id = il.location_id AND inv.company_id = $1
     LEFT JOIN users u ON u.id = inv.last_counted_by
     LEFT JOIN locations l ON l.id = il.location_id
     WHERE i.company_id = $1
     ORDER BY COALESCE(inv.sort_order, 9999), i.name`,
    [cId(req), location_id]
  );
  res.json({ inventory: r.rows });
});

// PATCH /api/recipes/inventory/:ingredientId/:locationId  — set count / sort
router.patch('/inventory/:ingredientId/:locationId', requireInventoryAccess, async (req, res) => {
  const { current_qty, sort_order } = req.body;
  const { ingredientId, locationId } = req.params;
  const company = cId(req);
  const r = await query(
    `INSERT INTO ingredient_inventory
       (ingredient_id, location_id, company_id, current_qty, sort_order, last_counted_at, last_counted_by)
     VALUES ($1,$2,$3,$4,$5,NOW(),$6)
     ON CONFLICT (ingredient_id, location_id) DO UPDATE SET
       current_qty     = COALESCE(EXCLUDED.current_qty, ingredient_inventory.current_qty),
       sort_order      = COALESCE(EXCLUDED.sort_order,  ingredient_inventory.sort_order),
       last_counted_at = CASE WHEN EXCLUDED.current_qty IS NOT NULL THEN NOW() ELSE ingredient_inventory.last_counted_at END,
       last_counted_by = CASE WHEN EXCLUDED.current_qty IS NOT NULL THEN EXCLUDED.last_counted_by ELSE ingredient_inventory.last_counted_by END
     RETURNING *`,
    [ingredientId, locationId, company, optionalNumeric(current_qty), optionalNumeric(sort_order), req.userId]
  );
  if (current_qty != null && current_qty !== '') {
    await query(
      `INSERT INTO ingredient_inventory_log (ingredient_id, location_id, company_id, qty, counted_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [ingredientId, locationId, company, optionalNumeric(current_qty), req.userId]
    );
  }
  res.json(r.rows[0]);
});

// POST /api/recipes/inventory/reorder  — persist drag-drop order for a location
router.post('/inventory/reorder', requireInventoryAccess, async (req, res) => {
  const { location_id, order } = req.body; // order: [{ ingredient_id, sort_order }]
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  const company = cId(req);
  for (const { ingredient_id, sort_order } of order) {
    await query(
      `INSERT INTO ingredient_inventory (ingredient_id, location_id, company_id, sort_order)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (ingredient_id, location_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
      [ingredient_id, location_id, company, sort_order]
    );
  }
  res.json({ ok: true });
});

// PATCH /api/recipes/inventory/:ingredientId/:locationId/par — set per-location par (manager)
router.patch('/inventory/:ingredientId/:locationId/par', requireManager, async (req, res) => {
  const { par_qty, par_unit } = req.body;
  const { ingredientId, locationId } = req.params;
  const r = await query(
    `INSERT INTO ingredient_locations (ingredient_id, location_id, company_id, par_qty, par_unit)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (ingredient_id, location_id) DO UPDATE SET
       par_qty  = EXCLUDED.par_qty,
       par_unit = EXCLUDED.par_unit
     RETURNING *`,
    [ingredientId, locationId, cId(req), optionalNumeric(par_qty), par_unit || null]
  );
  res.json(r.rows[0]);
});

// ── KITCHEN SETTINGS (single company-wide cost-to-shop) ───────────────────────

// GET /api/recipes/kitchen-settings — per-store trip costs + a default, plus the
// list of known vendors (stores) so the UI can offer a cost row for each.
router.get('/kitchen-settings', requireInventoryAccess, async (req, res) => {
  const company = cId(req);
  const def = await query(`SELECT cost_to_shop FROM kitchen_settings WHERE company_id = $1`, [company]);
  const stores = await query(
    `SELECT vendor, cost_to_shop FROM kitchen_store_costs WHERE company_id = $1 ORDER BY vendor`,
    [company]
  );
  const vendors = await query(
    `SELECT DISTINCT vendor FROM shopping_item_raw
     WHERE company_id = $1 AND vendor IS NOT NULL AND vendor <> '' ORDER BY vendor`,
    [company]
  );
  res.json({
    default_cost_to_shop: def.rows[0] ? Number(def.rows[0].cost_to_shop) : 0,
    stores: stores.rows.map((r) => ({ vendor: r.vendor, cost_to_shop: Number(r.cost_to_shop) })),
    all_vendors: vendors.rows.map((r) => r.vendor),
  });
});

// PATCH /api/recipes/kitchen-settings  (manager)
// Body: { default_cost_to_shop?, stores?: [{ vendor, cost_to_shop }] }
router.patch('/kitchen-settings', requireManager, async (req, res) => {
  const company = cId(req);
  const { default_cost_to_shop, stores } = req.body || {};
  if (default_cost_to_shop != null) {
    await query(
      `INSERT INTO kitchen_settings (company_id, cost_to_shop, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (company_id) DO UPDATE SET cost_to_shop = EXCLUDED.cost_to_shop, updated_at = NOW()`,
      [company, optionalNumeric(default_cost_to_shop) ?? 0]
    );
  }
  if (Array.isArray(stores)) {
    for (const s of stores) {
      if (!s || !s.vendor) continue;
      await query(
        `INSERT INTO kitchen_store_costs (company_id, vendor, cost_to_shop, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (company_id, vendor) DO UPDATE SET cost_to_shop = EXCLUDED.cost_to_shop, updated_at = NOW()`,
        [company, s.vendor, optionalNumeric(s.cost_to_shop) ?? 0]
      );
    }
  }
  res.json({ ok: true });
});

// GET /api/recipes/shopping-list?location_id=…  — stocked items below (per-location) par.
// Returns shortage qty, all fulfilling vendor sources (default first), and each
// item's share of the single company cost-to-shop, distributed by dollar value.
router.get('/shopping-list', requireInventoryAccess, async (req, res) => {
  const { location_id } = req.query;
  const company = cId(req);
  const r = await query(
    `SELECT i.id, i.name, i.buy_frequency,
            COALESCE(il.par_qty, i.par_qty)   AS par_qty,
            COALESCE(il.par_unit, i.par_unit) AS par_unit,
            inv.current_qty, il.location_id, l.name AS location_name,
            GREATEST(0, COALESCE(il.par_qty, i.par_qty) - COALESCE(inv.current_qty, 0)) AS needed_qty,
            def.vendor AS default_vendor, def.last_price AS default_price, def.unit AS default_unit,
            (SELECT json_agg(json_build_object(
               'id', s.id, 'vendor', s.vendor, 'product_name', s.product_name,
               'description', s.description_raw, 'last_price', s.last_price, 'unit', s.unit,
               'is_primary', s.is_recipe_primary
             ) ORDER BY s.is_recipe_primary DESC, s.last_price ASC NULLS LAST)
             FROM shopping_item_raw s
             WHERE s.ingredient_id = i.id AND s.company_id = $1
            ) AS sources
     FROM ingredients i
     INNER JOIN ingredient_locations il
       ON il.ingredient_id = i.id AND il.company_id = $1
       AND ($2::uuid IS NULL OR il.location_id = $2::uuid)
     LEFT JOIN ingredient_inventory inv
       ON inv.ingredient_id = i.id AND inv.location_id = il.location_id AND inv.company_id = $1
     LEFT JOIN locations l ON l.id = il.location_id
     LEFT JOIN LATERAL (
       SELECT vendor, last_price, unit FROM shopping_item_raw s
       WHERE s.ingredient_id = i.id AND s.company_id = $1
       ORDER BY s.is_recipe_primary DESC, s.last_price ASC NULLS LAST
       LIMIT 1
     ) def ON true
     WHERE i.company_id = $1
       AND COALESCE(il.par_qty, i.par_qty) IS NOT NULL
       AND COALESCE(inv.current_qty, 0) < COALESCE(il.par_qty, i.par_qty)
     ORDER BY l.name, i.name`,
    [company, location_id || null]
  );

  const defRow = await query(`SELECT cost_to_shop FROM kitchen_settings WHERE company_id = $1`, [company]);
  const defaultCost = defRow.rows[0] ? Number(defRow.rows[0].cost_to_shop) : 0;
  const storeRows = await query(`SELECT vendor, cost_to_shop FROM kitchen_store_costs WHERE company_id = $1`, [company]);
  const storeCostMap = new Map(storeRows.rows.map((r) => [r.vendor, Number(r.cost_to_shop)]));
  // Cost to shop is PER STORE: an item with no known store gets no trip cost;
  // a known store uses its own cost, falling back to the default.
  const costForStore = (vendor) => {
    if (!vendor) return 0;
    return storeCostMap.has(vendor) ? storeCostMap.get(vendor) : defaultCost;
  };

  const items = r.rows.map((row) => {
    const price = row.default_price != null ? Number(row.default_price) : 0;
    const needed = row.needed_qty != null ? Number(row.needed_qty) : 0;
    return {
      ...row,
      store: row.default_vendor || 'Unassigned',
      line_cost: Math.round(price * needed * 100) / 100,
    };
  });

  // Group by store; distribute each store's trip cost across only its items,
  // weighted by dollar value. Two stores on the list = two trip costs.
  const byStore = new Map();
  for (const it of items) {
    if (!byStore.has(it.store)) byStore.set(it.store, []);
    byStore.get(it.store).push(it);
  }
  let totalTripCost = 0;
  const storeSummaries = [];
  for (const [store, group] of byStore) {
    const groupLineTotal = group.reduce((s, it) => s + it.line_cost, 0);
    const tripCost = costForStore(group[0].default_vendor);
    totalTripCost += tripCost;
    for (const it of group) {
      const share = groupLineTotal > 0
        ? tripCost * (it.line_cost / groupLineTotal)
        : (group.length ? tripCost / group.length : 0);
      it.shop_cost_share = Math.round(share * 100) / 100;
      it.price_before = it.line_cost;
      it.price_after = Math.round((it.line_cost + share) * 100) / 100;
    }
    storeSummaries.push({
      store,
      trip_cost: tripCost,
      items_before: Math.round(groupLineTotal * 100) / 100,
      items_after: Math.round((groupLineTotal + tripCost) * 100) / 100,
      count: group.length,
    });
  }
  storeSummaries.sort((a, b) => a.store.localeCompare(b.store));

  const totalBefore = items.reduce((s, it) => s + it.line_cost, 0);
  res.json({
    items,
    stores: storeSummaries,
    total_before: Math.round(totalBefore * 100) / 100,
    total_trip_cost: Math.round(totalTripCost * 100) / 100,
    total_after: Math.round((totalBefore + totalTripCost) * 100) / 100,
  });
});

// ── RECIPES ───────────────────────────────────────────────────────────────────

// GET /api/recipes/meta/categories  — must be before /:id
router.get('/meta/categories', requireManager, async (req, res) => {
  const r = await query(
    `SELECT DISTINCT category FROM recipes WHERE company_id = $1 AND category IS NOT NULL ORDER BY category`,
    [cId(req)]
  );
  const canonical = ['Pizza', 'Sandwich', 'Salad', 'Drink', 'Appetizer', 'Dessert', 'Side', 'Other'];
  const inUse = r.rows.map((row) => row.category);
  const merged = [...new Set([...canonical, ...inUse])].sort();
  res.json({ categories: merged });
});

// GET /api/recipes
router.get('/', requireManager, async (req, res) => {
  const { category, status, location_id } = req.query;
  const params = [cId(req)];
  let p = 2;
  const clauses = [];
  if (category)    { clauses.push(`r.category = $${p++}`);                      params.push(category); }
  if (status)      { clauses.push(`r.status = $${p++}`);                        params.push(status); }
  if (location_id) { clauses.push(`EXISTS (SELECT 1 FROM recipe_locations rl WHERE rl.recipe_id = r.id AND rl.location_id = $${p++})`); params.push(location_id); }

  const where = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

  const r = await query(
    `SELECT r.id, r.name, r.category, r.description, r.photo_path,
            r.prep_time_minutes, r.status, r.menu_price, r.created_at, r.updated_at,
            (SELECT COUNT(*)::int FROM recipe_ingredients ri WHERE ri.recipe_id = r.id) AS ingredient_count,
            COALESCE(
              (SELECT json_agg(l.name ORDER BY l.name)
               FROM recipe_locations rl JOIN locations l ON l.id = rl.location_id
               WHERE rl.recipe_id = r.id),
              '[]'::json
            ) AS location_names,
            COALESCE(
              (SELECT json_agg(rl.location_id::text)
               FROM recipe_locations rl WHERE rl.recipe_id = r.id),
              '[]'::json
            ) AS location_ids
     FROM recipes r
     WHERE r.company_id = $1 ${where}
     ORDER BY r.category NULLS LAST, r.name`,
    params
  );
  res.json({ recipes: r.rows });
});

// POST /api/recipes
router.post('/', requireManager, async (req, res) => {
  const { name, category, description, instructions, prep_time_minutes, status, menu_price, location_ids } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const r = await query(
    `INSERT INTO recipes (company_id, name, category, description, instructions, prep_time_minutes, status, menu_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [cId(req), name.trim(), category || null, description || null, instructions || null,
     prep_time_minutes ?? null, status || 'active', menu_price ?? null]
  );
  const recipe = r.rows[0];
  if (location_ids?.length) await setRecipeLocations(recipe.id, location_ids);
  res.status(201).json({ recipe });
});

// GET /api/recipes/:id
router.get('/:id', requireManager, async (req, res) => {
  const r = await query(
    `SELECT * FROM recipes WHERE id = $1 AND company_id = $2`,
    [req.params.id, cId(req)]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const recipe = r.rows[0];
  const [ingredients, locationIds] = await Promise.all([
    getRecipeIngredients(recipe.id),
    getRecipeLocations(recipe.id),
  ]);
  const totalCogs = ingredients.reduce((sum, i) => sum + (parseFloat(i.cogs_contribution) || 0), 0);
  res.json({ recipe: { ...recipe, ingredients, location_ids: locationIds, total_cogs: totalCogs || null } });
});

// PATCH /api/recipes/:id
router.patch('/:id', requireManager, async (req, res) => {
  const { name, category, description, instructions, prep_time_minutes, status, menu_price, location_ids } = req.body;
  const setClauses = [];
  const params = [];
  let p = 1;
  if (name !== undefined)              { setClauses.push(`name = $${p++}`);              params.push(name?.trim()); }
  if (category !== undefined)          { setClauses.push(`category = $${p++}`);          params.push(category); }
  if (description !== undefined)       { setClauses.push(`description = $${p++}`);       params.push(description); }
  if (instructions !== undefined)      { setClauses.push(`instructions = $${p++}`);      params.push(instructions); }
  if (prep_time_minutes !== undefined) { setClauses.push(`prep_time_minutes = $${p++}`); params.push(prep_time_minutes ?? null); }
  if (status !== undefined)            { setClauses.push(`status = $${p++}`);            params.push(status); }
  if (menu_price !== undefined)        { setClauses.push(`menu_price = $${p++}`);        params.push(menu_price ?? null); }
  if (!setClauses.length && location_ids === undefined) return res.status(400).json({ error: 'Nothing to update' });

  if (setClauses.length) {
    setClauses.push(`updated_at = NOW()`);
    params.push(req.params.id, cId(req));
    const r = await query(
      `UPDATE recipes SET ${setClauses.join(', ')}
       WHERE id = $${p} AND company_id = $${p + 1} RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  }

  if (location_ids !== undefined) await setRecipeLocations(req.params.id, location_ids);
  res.json({ ok: true });
});

// DELETE /api/recipes/:id
router.delete('/:id', requireManager, async (req, res) => {
  const r = await query(
    `DELETE FROM recipes WHERE id = $1 AND company_id = $2 RETURNING id`,
    [req.params.id, cId(req)]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// POST /api/recipes/:id/photo
router.post('/:id/photo', requireManager, photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/api/uploads/recipes/${req.file.filename}`;

  // Delete old photo if present
  const old = await query(`SELECT photo_path FROM recipes WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]);
  if (old.rows[0]?.photo_path) {
    const oldFile = path.join(PHOTO_DIR, path.basename(old.rows[0].photo_path));
    fs.unlink(oldFile, () => {});
  }

  await query(
    `UPDATE recipes SET photo_path = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
    [url, req.params.id, cId(req)]
  );
  res.json({ url });
});

// PUT /api/recipes/:id/ingredients
// Replaces the full ingredient list for a recipe.
router.put('/:id/ingredients', requireManager, async (req, res) => {
  const { ingredients } = req.body;
  if (!Array.isArray(ingredients)) return res.status(400).json({ error: 'ingredients array required' });

  // Verify recipe belongs to company
  const check = await query(`SELECT id FROM recipes WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]);
  if (!check.rows.length) return res.status(404).json({ error: 'Not found' });

  await query(`DELETE FROM recipe_ingredients WHERE recipe_id = $1`, [req.params.id]);
  for (let i = 0; i < ingredients.length; i++) {
    const { ingredient_id, quantity, unit, note } = ingredients[i];
    if (!ingredient_id || quantity == null) continue;
    await query(
      `INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit, position, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, ingredient_id, quantity, unit || null, i, note || null]
    );
  }
  res.json({ ok: true });
});

// PUT /api/recipes/:id/locations
router.put('/:id/locations', requireManager, async (req, res) => {
  const { location_ids } = req.body;
  const check = await query(`SELECT id FROM recipes WHERE id = $1 AND company_id = $2`, [req.params.id, cId(req)]);
  if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
  await setRecipeLocations(req.params.id, location_ids || []);
  res.json({ ok: true });
});

export { router as recipesRouter };
