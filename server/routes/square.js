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
  id, name, description
  NOTE: there is NO is_deleted column — do not use it

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

Order → location:
  JOIN square.location loc ON loc.id = o.location_id

=== LOCATIONS ===

There are two Square locations. Use these exact name strings when filtering by location:
  'Kindred Vineyards, LLC'  — the main winery/tasting room
  'Kindred by the Creek'    — the creek location

Location name synonyms (map user language to the exact loc.name above):
  'Kindred Vineyards, LLC'  → "kindred", "the winery", "the vineyard", "vineyard", "winery"
  'Kindred by the Creek'    → "the creek", "creek", "by the creek"

Example: if the user asks about "creek sales", filter with: WHERE loc.name = 'Kindred by the Creek'

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

=== HOW TO RESPOND ===

You have two tools: run_sql and save_fact.

── WHEN TO USE save_fact ──
Use save_fact when the user tells you something about the business:
  "those are our red wines", "we close at 5pm", "Craig is the owner"
Save each distinct fact as a separate save_fact call.
After saving, confirm conversationally what you stored.

── WHEN TO USE run_sql ──
Use run_sql for data questions (sales, revenue, counts, dates, etc.).

SQL rules:
- No markdown, no semicolons, no backticks
- Always LIMIT 500 unless asked for more
- Money: ROUND(amount / 100.0, 2) AS name_dollars
- order_line_item: use total_amount (NOT total_money_amount)
- quantity is double precision — no cast needed

── USE YOUR OWN WINE KNOWLEDGE ──
You are a wine expert. Draw on your own knowledge of grape varieties and wine types:
- Red wines: Merlot, Cabernet Sauvignon, Cabernet Franc, Syrah, Petit Verdot, Malbec,
  Grenache, Pinot Noir, Zinfandel, Tempranillo, Sangiovese, and blends of these
- White wines: Chardonnay, Viognier, Riesling, Sauvignon Blanc, Pinot Gris, Gewürztraminer,
  Albariño, Pinot Blanc, and blends of these
- Rosé wines: typically labeled Rosé, Rosado, or Blush
- Use this knowledge to classify products by type without needing to be told explicitly.

── VINTAGE PRODUCTS: USE ILIKE ──
Kindred's wines appear as separate catalog items per vintage (e.g. "Mama's Merlot 2019",
"Mama's Merlot 2021"). Always use ILIKE with wildcards to match all vintages:
  oli.name ILIKE '%Merlot%'          -- matches all Merlot vintages
  oli.name ILIKE '%Mama''s Merlot%'  -- matches specifically Mama's Merlot across years
Never use exact equality (=) for wine product names — you'll miss vintages.

── CLASSIFY WINES IN SQL ──
When asked about wine by type, use your grape knowledge + ILIKE patterns. Example:
  "How many red wines sold?" →
  WHERE (oli.name ILIKE '%Merlot%' OR oli.name ILIKE '%Cabernet%'
      OR oli.name ILIKE '%Syrah%' OR oli.name ILIKE '%Petit Verdot%'
      OR oli.name ILIKE '%Malbec%' OR oli.name ILIKE '%Pinot Noir%')

CRITICAL: When filtering by wine type using ILIKE name patterns, do NOT also filter
by category (e.g. do NOT add COALESCE(cc.name, cmap.category_name) = '750ml Bottle').
The ILIKE name patterns are specific enough — adding a category filter causes most wines
to be silently excluded due to catalog data inconsistencies (missing or duplicate category
links). Only join the category tables if the user specifically asks to break down by
format (bottle vs glass pour vs flight).

── BUSINESS KNOWLEDGE: USE FOR KINDRED-SPECIFIC FACTS ──
The BUSINESS KNOWLEDGE section holds facts specific to Kindred that you cannot know from
general training — exact product names, staff names, hours, business rules, etc.
Use these facts to inform your queries and answers.
If a question can be answered entirely from Business Knowledge without querying the DB,
answer conversationally without calling run_sql.

You may call BOTH tools in one turn when needed.
If the user is chatting or asking something non-data, respond conversationally with no tool call.
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

// ── Helper: build business knowledge block from facts table ─────────────────
async function buildFactsBlock() {
  try {
    const result = await query(`
      SELECT category, content
      FROM square_ai_facts
      WHERE active = true
      ORDER BY sort_order, created_at
    `);
    if (!result.rows.length) return '';

    // Group by category
    const grouped = {};
    result.rows.forEach((r) => {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r.content);
    });

    const sections = Object.entries(grouped).map(([cat, items]) =>
      `${cat}:\n${items.map((c) => `  - ${c}`).join('\n')}`
    );

    return `\n=== BUSINESS KNOWLEDGE (permanent facts — always apply) ===\n${sections.join('\n')}\n`;
  } catch {
    return '';
  }
}

// ── Helper: build curated lessons block ──────────────────────────────────────
async function buildLessonsBlock() {
  try {
    // Tier 3: curated lessons (promoted from journal)
    const lessons = await query(`
      SELECT content FROM square_ai_lessons
      WHERE active = true
      ORDER BY created_at DESC
      LIMIT 15
    `);

    // Tier 3b: recent failures (auto, not curated) — kept small so they don't crowd facts
    const failures = await query(`
      SELECT error_message
      FROM square_ai_journal
      WHERE success = false AND error_message IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 5
    `);

    const parts = [];
    if (lessons.rows.length) {
      parts.push('Curated corrections:\n' + lessons.rows.map((r) => `  - ${r.content}`).join('\n'));
    }
    if (failures.rows.length) {
      parts.push('Recent failures (avoid these patterns):\n' + failures.rows.map((r) => `  - ${(r.error_message || '').slice(0, 120)}`).join('\n'));
    }
    if (!parts.length) return '';

    return `\n=== LESSONS LEARNED ===\n${parts.join('\n')}\n`;
  } catch {
    return '';
  }
}

// ── Helper: log to journal ───────────────────────────────────────────────────
async function logJournal({ question, generated_sql, success, error_message, row_count }) {
  try {
    await query(
      `INSERT INTO square_ai_journal (question, generated_sql, success, error_message, row_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [question, generated_sql || null, success, error_message || null, row_count ?? null]
    );
  } catch (err) {
    console.error('[square/journal] log error:', err.message);
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const SQUARE_TOOLS = [
  {
    name: 'run_sql',
    description: 'Run a read-only SQL SELECT query against the Square PostgreSQL database. Returns rows and field names.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A valid PostgreSQL SELECT or WITH query. No semicolons.' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'save_fact',
    description: 'Save a permanent business fact to the AI knowledge base. Use this when the user tells you something about the business.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['Products', 'Locations', 'Team', 'Seasons & Hours', 'Business Rules', 'General'],
          description: 'Category for the fact',
        },
        content: { type: 'string', description: 'The fact to remember, written as a clear statement.' },
      },
      required: ['category', 'content'],
    },
  },
];

// ── Helper: execute SQL safely ────────────────────────────────────────────────
async function executeSql(sql) {
  const hasLimit = /\bLIMIT\s+\d+\b/i.test(sql);
  const finalSql = hasLimit ? sql : `${sql} LIMIT 500`;

  const normalised = finalSql.replace(/\s+/g, ' ').trim().toUpperCase();
  if (!normalised.startsWith('SELECT') && !normalised.startsWith('WITH')) {
    return { error: 'Only SELECT queries are allowed.' };
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('SET statement_timeout = 15000');
    const result = await dbClient.query(finalSql);
    return {
      sql: finalSql,
      rows: result.rows,
      fields: result.fields.map((f) => f.name),
      count: result.rows.length,
    };
  } finally {
    dbClient.release();
  }
}

// ── POST /api/square/ask ─────────────────────────────────────────────────────
router.post('/ask', async (req, res) => {
  const { question, history = [] } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const ai = new Anthropic({ apiKey });

  const [facts, lessons] = await Promise.all([buildFactsBlock(), buildLessonsBlock()]);
  const systemPrompt = SQUARE_SCHEMA_CONTEXT + facts + lessons;

  // History from frontend is [{role, content}] with string content — safe for multi-turn
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];

  // Agentic tool-use loop
  const accumulated = { text: '', sql: null, rows: null, fields: null, facts_saved: [] };

  try {
    while (true) {
      const response = await ai.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: systemPrompt,
        tools: SQUARE_TOOLS,
        messages,
      });

      // Collect any text from this turn
      const textBlock = response.content.find((b) => b.type === 'text');
      if (textBlock?.text) accumulated.text = textBlock.text.trim();

      if (response.stop_reason === 'end_turn') break;

      if (response.stop_reason === 'tool_use') {
        // Add assistant's response (with tool_use blocks) to messages
        messages.push({ role: 'assistant', content: response.content });

        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          if (block.name === 'run_sql') {
            let result;
            try {
              result = await executeSql(block.input.sql);
              if (result.error) {
                await logJournal({ question, generated_sql: block.input.sql, success: false, error_message: result.error });
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${result.error}` });
              } else {
                accumulated.sql    = result.sql;
                accumulated.rows   = result.rows;
                accumulated.fields = result.fields;
                await logJournal({ question, generated_sql: result.sql, success: true, row_count: result.count });
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: `${result.count} rows returned. Fields: ${result.fields.join(', ')}. First few rows: ${JSON.stringify(result.rows.slice(0, 5))}`,
                });
              }
            } catch (err) {
              await logJournal({ question, generated_sql: block.input.sql, success: false, error_message: err.message });
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `SQL error: ${err.message}` });
            }

          } else if (block.name === 'save_fact') {
            try {
              await query(
                `INSERT INTO square_ai_facts (category, content, created_by) VALUES ($1, $2, $3)`,
                [block.input.category, block.input.content, req.user?.id || null]
              );
              accumulated.facts_saved.push({ category: block.input.category, content: block.input.content });
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Fact saved successfully.' });
            } catch (err) {
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Failed to save fact: ${err.message}` });
            }
          }
        }

        messages.push({ role: 'user', content: toolResults });
      } else {
        break; // unexpected stop reason
      }
    }
  } catch (err) {
    console.error('[square/ask] AI error:', err.message);
    return res.status(500).json({ error: 'AI request failed', details: err.message });
  }

  res.json({
    text:        accumulated.text,
    sql:         accumulated.sql,
    rows:        accumulated.rows,
    fields:      accumulated.fields,
    count:       accumulated.rows?.length ?? null,
    facts_saved: accumulated.facts_saved,
  });
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

// ── GET /api/square/journal ──────────────────────────────────────────────────
router.get('/journal', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  try {
    const result = await query(
      `SELECT id, question, generated_sql, success, error_message, row_count,
              thumbs_up, notes, created_at
       FROM square_ai_journal
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = await query(`SELECT COUNT(*) AS n FROM square_ai_journal`);
    res.json({ entries: result.rows, total: parseInt(total.rows[0].n), limit, offset });
  } catch (err) {
    console.error('[square] journal error:', err.message);
    res.status(500).json({ error: 'Failed to load journal' });
  }
});

// ── PATCH /api/square/journal/:id ───────────────────────────────────────────
router.patch('/journal/:id', async (req, res) => {
  const { thumbs_up, notes } = req.body;
  const fields = [];
  const vals = [];
  if (thumbs_up !== undefined) { fields.push(`thumbs_up = $${vals.length + 1}`); vals.push(thumbs_up); }
  if (notes !== undefined)     { fields.push(`notes = $${vals.length + 1}`);     vals.push(notes); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  try {
    const result = await query(
      `UPDATE square_ai_journal SET ${fields.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json({ entry: result.rows[0] });
  } catch (err) {
    console.error('[square] journal patch error:', err.message);
    res.status(500).json({ error: 'Failed to update journal entry' });
  }
});

// ── GET /api/square/facts ────────────────────────────────────────────────────
router.get('/facts', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, category, content, active, sort_order, created_at
       FROM square_ai_facts
       ORDER BY sort_order, category, created_at`
    );
    res.json({ facts: result.rows });
  } catch (err) {
    console.error('[square] facts error:', err.message);
    res.status(500).json({ error: 'Failed to load facts' });
  }
});

// ── POST /api/square/facts ───────────────────────────────────────────────────
router.post('/facts', async (req, res) => {
  const { category = 'General', content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
  try {
    const result = await query(
      `INSERT INTO square_ai_facts (category, content, created_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [category.trim(), content.trim(), req.user?.id || null]
    );
    res.json({ fact: result.rows[0] });
  } catch (err) {
    console.error('[square] facts insert error:', err.message);
    res.status(500).json({ error: 'Failed to save fact' });
  }
});

// ── PATCH /api/square/facts/:id ──────────────────────────────────────────────
router.patch('/facts/:id', async (req, res) => {
  const { category, content, active } = req.body;
  const fields = [];
  const vals = [];
  if (category !== undefined) { fields.push(`category = $${vals.length + 1}`); vals.push(category); }
  if (content  !== undefined) { fields.push(`content = $${vals.length + 1}`);  vals.push(content); }
  if (active   !== undefined) { fields.push(`active = $${vals.length + 1}`);   vals.push(active); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  try {
    const result = await query(
      `UPDATE square_ai_facts SET ${fields.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Fact not found' });
    res.json({ fact: result.rows[0] });
  } catch (err) {
    console.error('[square] facts patch error:', err.message);
    res.status(500).json({ error: 'Failed to update fact' });
  }
});

// ── DELETE /api/square/facts/:id ─────────────────────────────────────────────
router.delete('/facts/:id', async (req, res) => {
  try {
    await query(`DELETE FROM square_ai_facts WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[square] facts delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete fact' });
  }
});

// ── GET /api/square/lessons ──────────────────────────────────────────────────
router.get('/lessons', async (req, res) => {
  try {
    const result = await query(
      `SELECT l.id, l.content, l.active, l.created_at, j.question AS source_question
       FROM square_ai_lessons l
       LEFT JOIN square_ai_journal j ON j.id = l.journal_id
       ORDER BY l.created_at DESC`
    );
    res.json({ lessons: result.rows });
  } catch (err) {
    console.error('[square] lessons error:', err.message);
    res.status(500).json({ error: 'Failed to load lessons' });
  }
});

// ── POST /api/square/lessons ─────────────────────────────────────────────────
// Promote a journal note to a curated lesson (or add a standalone lesson)
router.post('/lessons', async (req, res) => {
  const { content, journal_id } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
  try {
    const result = await query(
      `INSERT INTO square_ai_lessons (content, journal_id, created_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [content.trim(), journal_id || null, req.user?.id || null]
    );
    res.json({ lesson: result.rows[0] });
  } catch (err) {
    console.error('[square] lessons insert error:', err.message);
    res.status(500).json({ error: 'Failed to save lesson' });
  }
});

// ── PATCH /api/square/lessons/:id ────────────────────────────────────────────
router.patch('/lessons/:id', async (req, res) => {
  const { content, active } = req.body;
  const fields = [];
  const vals = [];
  if (content !== undefined) { fields.push(`content = $${vals.length + 1}`); vals.push(content); }
  if (active  !== undefined) { fields.push(`active = $${vals.length + 1}`);  vals.push(active); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  try {
    const result = await query(
      `UPDATE square_ai_lessons SET ${fields.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Lesson not found' });
    res.json({ lesson: result.rows[0] });
  } catch (err) {
    console.error('[square] lessons patch error:', err.message);
    res.status(500).json({ error: 'Failed to update lesson' });
  }
});

// ── DELETE /api/square/lessons/:id ───────────────────────────────────────────
router.delete('/lessons/:id', async (req, res) => {
  try {
    await query(`DELETE FROM square_ai_lessons WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[square] lessons delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete lesson' });
  }
});

export { router as squareRouter };
