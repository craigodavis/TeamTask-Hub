import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { pool, query } from '../db.js';

const router = express.Router();

// ── Schema context for AI ────────────────────────────────────────────────────
const SQUARE_SCHEMA_CONTEXT = `
You are a SQL analyst for Kindred Vineyards, a winery and tasting room in Sunnyslope, Idaho.
You query a PostgreSQL database with Square POS data and a custom correction table.

=== KEY TABLES ===

square.order
  id, state ('COMPLETED'|'OPEN'|'CANCELED'), created_at, updated_at, closed_at,
  total_money_amount (CENTS), total_tax_amount (CENTS), total_discount_amount (CENTS),
  total_service_charge_amount (CENTS), location_id, customer_id, order_source_name

square.order_line_item
  uid (PK), order_id, name, variation_name, catalog_object_id,
  quantity (double precision — no cast needed),
  base_price_amount (CENTS), gross_sales_amount (CENTS),
  total_amount (CENTS), total_tax_amount (CENTS), total_discount_amount (CENTS)

square.catalog_item
  id, name, description, is_deleted

square.catalog_item_variation
  id, item_id, name (variation name), sku, price_money_amount (CENTS), pricing_type,
  track_inventory, inventory_alert_threshold

square.catalog_category
  id, name  (e.g. '750ml Bottle', 'Glass Pour', '5 Flight Tasting', 'Pizza', 'Beer')

square.catalog_item_category
  catalog_item_id, id (this column IS the category_id), ordinal
  NOTE: join square.catalog_category ON cc.id = cic.id

square.payment
  id, order_id, customer_id, created_at, status, source_type,
  amount_money_amount (CENTS), total_money_amount (CENTS),
  tip_money_amount (CENTS), refunded_money_amount (CENTS),
  employee_id, buyer_email_address, receipt_number

square.customer
  id, given_name, family_name, email_address, phone_number,
  created_at, note, reference_id

square.location
  id, name, address_address_line_1, address_city, address_state

square.shift  (employee time clock)
  id, employee_id, location_id, start_at, end_at, status,
  regular_hours_worked (NUMERIC), overtime_hours_worked (NUMERIC)

square.employee
  id, first_name, last_name, email, status

teamtask_hub.square_catalog_category_map  ← CUSTOM CORRECTION TABLE
  id, catalog_item_id, item_name, category_name, category_id, notes, created_at
  PURPOSE: Corrects pre-2023 catalog items that were categorized under year-based
  categories ('Main Creek Menu', 'Main Vineyard Menu', vintage years) instead of
  the current format-based categories ('750ml Bottle', 'Glass Pour', etc.)

=== CRITICAL JOINS ===

Order line item → category (ALWAYS use this pattern for category queries):
  JOIN square.catalog_item_variation civ ON civ.id = oli.catalog_object_id
  LEFT JOIN square.catalog_item_category cic ON cic.catalog_item_id = civ.item_id
  LEFT JOIN square.catalog_category cc ON cc.id = cic.id
  LEFT JOIN teamtask_hub.square_catalog_category_map cmap ON cmap.catalog_item_id = civ.item_id
  -- Effective category: COALESCE(cc.name, cmap.category_name)

=== IMPORTANT FACTS ===

- All money amounts are stored in CENTS — divide by 100.0 for dollars
- quantity is stored as TEXT — cast with quantity::numeric when computing
- Pre-2023 orders (before 2023-03-05) used 'Main Creek Menu' / 'Main Vineyard Menu' categories
- 2023+ orders use '750ml Bottle', 'Glass Pour', '5 Flight Tasting', etc.
- The mapping table bridges this gap — always COALESCE(cc.name, cmap.category_name)
- Kindred Vineyards sells wine (750ml bottles and glass pours), wine flights, food (pizza, etc.), beer, and boutique items
- Only query COMPLETED orders unless explicitly asked otherwise: WHERE o.state = 'COMPLETED'
- The database also has fivetran_metadata, metabase, cellarpilot, wine, club_steward schemas — ignore these unless asked
- There are duplicate catalog_category rows for the same name (Fivetran artifact from multiple locations) — use DISTINCT or filter carefully

=== OUTPUT FORMAT ===

Return ONLY raw SQL. Rules:
- No markdown code fences (no backticks, no \`\`\`sql)
- No explanations before or after the SQL
- No semicolons
- Start your response with SELECT or WITH — nothing else
- Limit results to 500 rows unless asked for more
- Always alias money columns as dollars using ROUND(.../ 100.0, 2) (e.g. ROUND(o.total_money_amount / 100.0, 2) AS total_dollars, ROUND(oli.total_amount / 100.0, 2) AS line_total_dollars)
- On order_line_item use total_amount — NOT total_money_amount (that column does not exist on that table)
`;

// ── GET /api/square/tables ───────────────────────────────────────────────────
router.get('/tables', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT
          t.table_name,
          GREATEST(c.reltuples::bigint, 0) AS row_count
        FROM information_schema.tables t
        JOIN pg_namespace n ON n.nspname = 'square'
        JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
        WHERE t.table_schema = 'square'
          AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name
      `);
      res.json({ tables: result.rows });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[square] tables error:', err.message);
    res.status(500).json({ error: 'Failed to load Square tables' });
  }
});

// ── POST /api/square/ask ─────────────────────────────────────────────────────
router.post('/ask', async (req, res) => {
  const { question, history = [] } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const client = new Anthropic({ apiKey });

  // Build message history for multi-turn context
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];

  let sql;
  let aiMessage;
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: SQUARE_SCHEMA_CONTEXT,
      messages,
    });
    aiMessage = response.content[0]?.text?.trim() || '';

    // Extract SQL: find the first SELECT or WITH keyword anywhere in the response
    // This handles markdown fences, preamble text, explanations, etc.
    const sqlMatch = aiMessage.match(/((?:WITH|SELECT)\s[\s\S]+)/i);
    sql = sqlMatch ? sqlMatch[1].trim() : aiMessage.trim();

    // Strip trailing markdown fences and semicolons
    sql = sql.replace(/\s*```[\s\S]*$/, '').replace(/;\s*$/, '').trim();
  } catch (err) {
    console.error('[square/ask] AI error:', err.message);
    return res.status(500).json({ error: 'AI request failed', details: err.message });
  }

  // Safety: only allow SELECT / WITH (CTEs)
  const normalised = sql.replace(/\s+/g, ' ').trim().toUpperCase();
  if (!normalised.startsWith('SELECT') && !normalised.startsWith('WITH')) {
    return res.status(400).json({
      error: 'AI generated a non-SELECT query — refusing to execute.',
      sql,
      raw: aiMessage,
    });
  }

  // Don't double-add LIMIT if the query already has one
  const hasLimit = /\bLIMIT\s+\d+\b/i.test(sql);
  const finalSql = hasLimit ? sql : `${sql} LIMIT 500`;

  // Execute with timeout
  let rows, fields;
  try {
    const dbClient = await pool.connect();
    try {
      await dbClient.query('SET statement_timeout = 15000'); // 15s max
      const result = await dbClient.query(finalSql);
      rows = result.rows;
      fields = result.fields.map((f) => f.name);
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('[square/ask] query error:', err.message);
    return res.status(400).json({ error: 'Query failed', details: err.message, sql: finalSql });
  }

  res.json({ sql, rows, fields, count: rows.length });
});

// ── GET /api/square/mappings ─────────────────────────────────────────────────
router.get('/mappings', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, catalog_item_id, item_name, category_name, category_id, notes, created_at
       FROM square_catalog_category_map
       ORDER BY category_name, item_name`
    );
    res.json({ mappings: result.rows });
  } catch (err) {
    console.error('[square] mappings error:', err.message);
    res.status(500).json({ error: 'Failed to load mappings' });
  }
});

// ── POST /api/square/mappings/seed ───────────────────────────────────────────
// Auto-populate confident 750ml Bottle matches from pre-2023 catalog items
router.post('/mappings/seed', async (req, res) => {
  try {
    const dbClient = await pool.connect();
    let inserted = 0;
    try {
      // Find catalog items that:
      // 1. Appear in orders before March 2023 (before new category was introduced)
      // 2. Are currently NOT in the 750ml Bottle category
      // 3. Have names matching wine bottle patterns
      const candidates = await dbClient.query(`
        SELECT DISTINCT ci.id AS catalog_item_id, ci.name AS item_name
        FROM square.order o
        JOIN square.order_line_item oli ON oli.order_id = o.id
        JOIN square.catalog_item_variation civ ON civ.id = oli.catalog_object_id
        JOIN square.catalog_item ci ON ci.id = civ.item_id
        WHERE o.created_at < '2023-03-05'
          AND (
            LOWER(ci.name) LIKE '%bottle%'
            OR (
              ci.name ~ '^[0-9]{2}\\s'
              AND LOWER(ci.name) NOT LIKE '%glass%'
              AND LOWER(ci.name) NOT LIKE '%flight%'
              AND LOWER(ci.name) NOT LIKE '%tasting%'
              AND LOWER(ci.name) NOT LIKE '%pizza%'
              AND LOWER(ci.name) NOT LIKE '%beer%'
              AND LOWER(ci.name) NOT LIKE '%soda%'
              AND LOWER(ci.name) NOT LIKE '%cider%'
              AND LOWER(ci.name) NOT LIKE '%coffee%'
              AND LOWER(ci.name) NOT LIKE '%water%'
              AND LOWER(ci.name) NOT LIKE '%event%'
              AND LOWER(ci.name) NOT LIKE '%ticket%'
              AND LOWER(ci.name) NOT LIKE '%club%'
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM square.catalog_item_category cic2
            JOIN square.catalog_category cc2 ON cc2.id = cic2.id
            WHERE cic2.catalog_item_id = ci.id AND cc2.name = '750ml Bottle'
          )
        ORDER BY ci.name
      `);

      for (const row of candidates.rows) {
        await query(
          `INSERT INTO square_catalog_category_map (catalog_item_id, item_name, category_name, category_id, notes)
           VALUES ($1, $2, '750ml Bottle', 'Q5QLZSCBNSDE55ME7UK4PTW6', 'Auto-seeded: pre-2023 wine bottle item')
           ON CONFLICT (catalog_item_id) DO NOTHING`,
          [row.catalog_item_id, row.item_name]
        );
        inserted++;
      }
    } finally {
      dbClient.release();
    }
    res.json({ inserted, message: `Seeded ${inserted} catalog item mappings` });
  } catch (err) {
    console.error('[square] seed error:', err.message);
    res.status(500).json({ error: 'Seed failed', details: err.message });
  }
});

// ── POST /api/square/mappings ────────────────────────────────────────────────
router.post('/mappings', async (req, res) => {
  const { catalog_item_id, item_name, category_name, category_id, notes } = req.body;
  if (!catalog_item_id || !category_name) {
    return res.status(400).json({ error: 'catalog_item_id and category_name are required' });
  }
  try {
    const result = await query(
      `INSERT INTO square_catalog_category_map (catalog_item_id, item_name, category_name, category_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (catalog_item_id) DO UPDATE
         SET category_name = EXCLUDED.category_name,
             category_id   = EXCLUDED.category_id,
             item_name     = EXCLUDED.item_name,
             notes         = EXCLUDED.notes
       RETURNING *`,
      [catalog_item_id, item_name || null, category_name, category_id || null, notes || null, req.user?.id || null]
    );
    res.json({ mapping: result.rows[0] });
  } catch (err) {
    console.error('[square] mapping insert error:', err.message);
    res.status(500).json({ error: 'Failed to save mapping' });
  }
});

// ── DELETE /api/square/mappings/:id ─────────────────────────────────────────
router.delete('/mappings/:id', async (req, res) => {
  try {
    await query(`DELETE FROM square_catalog_category_map WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[square] mapping delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete mapping' });
  }
});

export { router as squareRouter };
