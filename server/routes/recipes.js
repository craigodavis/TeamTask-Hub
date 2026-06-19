import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';

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

// GET /api/recipes/catalog
// List raw receipt items for the catalog UI.
// Query params: status=pending|linked|ignored|all (default: all except ignored)
router.get('/catalog', requireManager, async (req, res) => {
  const { status = 'unignored', search = '', page = '1', limit = '100' } = req.query;
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  let whereExtra = '';
  if (status === 'pending')   whereExtra = `AND sir.ingredient_id IS NULL AND sir.ignored = false`;
  if (status === 'linked')    whereExtra = `AND sir.ingredient_id IS NOT NULL AND sir.ignored = false`;
  if (status === 'ignored')   whereExtra = `AND sir.ignored = true`;
  if (status === 'unignored') whereExtra = `AND sir.ignored = false`;

  const searchClause = search
    ? `AND lower(sir.description_raw) LIKE '%' || lower($4) || '%'`
    : '';

  const params = [cId(req), parseInt(limit, 10), offset];
  if (search) params.push(search);

  const r = await query(
    `SELECT sir.id, sir.description_raw, sir.vendor, sir.last_price,
            sir.last_purchase_date, sir.purchase_count, sir.ignored,
            sir.is_recipe_primary, sir.unit,
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
     WHERE company_id = $1 ${whereExtra} ${search ? `AND lower(description_raw) LIKE '%' || lower($2) || '%'` : ''}`,
    countParams
  ).catch(() => ({ rows: [{ n: 0 }] }));

  res.json({ items: r.rows, total: total.rows[0]?.n ?? r.rows.length });
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
    `SELECT i.id, i.name, i.description, i.base_unit, i.is_active,
            i.created_at, i.updated_at,
            -- count of linked raw items
            (SELECT COUNT(*)::int FROM shopping_item_raw sir
             WHERE sir.ingredient_id = i.id AND sir.company_id = i.company_id) AS source_count,
            -- primary source info for COGS preview
            sir_p.description_raw AS primary_source_desc,
            sir_p.vendor          AS primary_source_vendor,
            sir_p.last_price      AS primary_last_price,
            sir_p.last_purchase_date AS primary_last_purchased,
            sir_p.servings_per_container AS primary_servings
     FROM ingredients i
     LEFT JOIN shopping_item_raw sir_p
            ON sir_p.ingredient_id = i.id
           AND sir_p.is_recipe_primary = true
           AND sir_p.company_id = i.company_id
     WHERE i.company_id = $1
     ORDER BY i.name`,
    [cId(req)]
  );
  res.json({ ingredients: r.rows });
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
  const { name, description, base_unit, is_active } = req.body;
  const setClauses = [];
  const params = [];
  let p = 1;
  if (name !== undefined)        { setClauses.push(`name = $${p++}`);        params.push(name.trim()); }
  if (description !== undefined) { setClauses.push(`description = $${p++}`); params.push(description); }
  if (base_unit !== undefined)   { setClauses.push(`base_unit = $${p++}`);   params.push(base_unit); }
  if (is_active !== undefined)   { setClauses.push(`is_active = $${p++}`);   params.push(!!is_active); }
  if (!setClauses.length) return res.status(400).json({ error: 'Nothing to update' });
  setClauses.push(`updated_at = NOW()`);
  params.push(req.params.id, cId(req));
  const r = await query(
    `UPDATE ingredients SET ${setClauses.join(', ')}
     WHERE id = $${p} AND company_id = $${p + 1} RETURNING *`,
    params
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ingredient: r.rows[0] });
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
