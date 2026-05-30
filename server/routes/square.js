import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { pool, query } from '../db.js';

const router = express.Router();

// ── Schema context for AI ────────────────────────────────────────────────────
const SQUARE_SCHEMA_CONTEXT = `
You are a SQL analyst for Kindred Vineyards, a winery and tasting room in Sunnyslope, Idaho.
You query a PostgreSQL database with two primary data sources:
  • team_square  — in-person Square POS data (tasting room sales, catalog, timeclock)
  • commerce7    — online store, wine club, and DTC order data + full product catalog

CRITICAL money difference:
  team_square  → money stored in CENTS  (divide by 100.0 for dollars)
  commerce7    → money stored in DOLLARS (use directly — no division needed)

=== KEY TABLES ===

team_square.order
  id, state ('COMPLETED'|'OPEN'|'CANCELED'), created_at, updated_at, closed_at,
  total_money_amount (CENTS), total_tax_amount (CENTS), total_discount_amount (CENTS),
  total_service_charge_amount (CENTS), net_amount_total_money_amount (CENTS),
  location_id, customer_id, order_source_name

team_square.order_line_item
  uid (PK), order_id, name, variation_name, catalog_object_id,
  quantity (NUMERIC — no cast needed),
  base_price_amount (CENTS), gross_sales_amount (CENTS),
  total_amount (CENTS), total_tax_amount (CENTS), total_discount_amount (CENTS)

team_square.catalog_item
  id, name, description, category_id,
  is_deleted (BOOLEAN — use to exclude archived items),
  tax_ids (TEXT array)

team_square.catalog_item_variation
  id, item_id, name (variation name), sku,
  price_money_amount (CENTS), pricing_type,
  track_inventory, inventory_alert_threshold

team_square.catalog_category
  id, name  (e.g. '750ml Bottle', 'Glass Pour', '5 Flight Tasting', 'Pizza', 'Beer')

team_square.location
  id, name, status, timezone, phone_number,
  address_line_1, address_locality, address_administrative_district_level_1

team_square.shift  (employee time clock — sourced from Square Timecards API)
  id, team_member_id, location_id, start_at, end_at, status ('OPEN'|'CLOSED'),
  wage_title, wage_hourly_rate_amount (CENTS), wage_job_id
  NOTE: employee_id is populated on pre-2025 rows only; always use team_member_id

team_square.team_member
  id, given_name, family_name, email_address, phone_number, status ('ACTIVE'|'INACTIVE')

team_square.team_member_job_assignment
  team_member_id, job_id, job_title, pay_type, hourly_rate_amount (CENTS)

teamtask_hub.square_catalog_category_map  ← CUSTOM CORRECTION TABLE
  id, catalog_item_id, item_name, category_name, category_id, notes, created_at
  PURPOSE: Corrects pre-2023 catalog items that were categorized under year-based
  categories ('Main Creek Menu', 'Main Vineyard Menu', vintage years) instead of
  the current format-based categories ('750ml Bottle', 'Glass Pour', etc.)

=== COMMERCE7 SCHEMA (online store, wine club, DTC) ===

commerce7.orders  ← DOLLARS, not cents
  id, company_id, order_number,
  order_submitted_date (TIMESTAMPTZ), order_paid_date (TIMESTAMPTZ), order_fulfilled_date (TIMESTAMPTZ),
  order_source  ('Tasting Room'|'Website'|'Wine Club'|'Phone'|'Import'|'Admin'),
  customer_type ('Member'|'Guest'|'Trade'),
  purchase_type ('Club'|'Bottle'|'Allocation'|'Gift Card'|etc.),
  channel       ('pos'|'web'|'api'),
  payment_status ('Paid'|'Unpaid'|'Partial'|'Refunded'),
  fulfillment_status ('Fulfilled'|'Unfulfilled'|'Partial'),
  shipping_status ('Shipped'|'Unshipped'|'Partial'|null),
  sub_total, ship_total, tax_total, duty_total, tip_total, total, total_after_tip (all DOLLARS),
  customer_id (FK → commerce7.customers),
  bill_to_first_name, bill_to_last_name, bill_to_city, bill_to_state_code, bill_to_zip_code,
  sales_attribute_code, club (JSONB — club shipment detail if purchase_type='Club'),
  tenders (JSONB), promotions (JSONB), coupons (JSONB), tags (TEXT[])

commerce7.order_items  ← DOLLARS, not cents
  id, company_id, order_id,
  product_title, product_slug, item_type,
  product_id (FK → commerce7.product), product_variant_id (FK → commerce7.product_variant),
  product_variant_title, sku,
  price, original_price, compare_price (DOLLARS),
  quantity (INTEGER), quantity_fulfilled,
  tax, tax_type, bottle_deposit,
  volume_in_ml, alcohol_percentage,
  department_code, department_id, allocation_id,
  is_price_override, notes

commerce7.product
  id, company_id,
  title, slug, type ('Wine'|'Beer'|'Merchandise'|'Food'|'Bundle'|etc.),
  admin_status ('Active'|'Inactive'), web_status ('Active'|'Inactive'|'Unlisted'),
  price, compare_price (DOLLARS),
  short_description, description,
  vintage (INTEGER — the wine vintage year, e.g. 2021),
  alcohol_percentage, volume_in_ml, weight,
  wine_varietal_ids (JSONB array of VARCHAR ids — e.g. ["abc123","def456"]),
  wine_appellation_id (VARCHAR),
  collection_ids (JSONB array of VARCHAR ids), vendor_id,
  country_code, region,
  tags (JSONB), image, images (JSONB)

commerce7.product_variant
  id, company_id, product_id,
  title, sku,
  price, compare_price (DOLLARS),
  on_hand_count, reserve_count, allocated_count, available_count (inventory),
  is_default, attributes (JSONB)

commerce7.customers
  id, company_id,
  first_name, last_name, honorific, birth_date,
  city, state_code, zip_code, country_code,
  email_marketing_status ('Subscribed'|'Unsubscribed'|'Never'),
  has_account (BOOLEAN),
  last_activity_date,
  emails (JSONB array — look for isPrimary:true for main email),
  phones (JSONB), clubs (JSONB — current club memberships summary),
  order_information (JSONB — lifetime stats: orderCount, totalSpent, lastOrderDate),
  tags (TEXT[])

commerce7.club
  id, company_id, title, slug, status ('Active'|'Inactive'), description

commerce7.club_membership
  id, company_id, customer_id, club_id,
  status ('Active'|'Cancelled'|'Paused'|'Pending'),
  signup_date, cancel_date, next_process_date,
  frequency ('Monthly'|'Quarterly'|'Biannual'|'Annual'),
  shipment_count (how many club shipments sent to this member)

commerce7.wine_varietal
  id, company_id, title  (e.g. 'Merlot', 'Cabernet Sauvignon', 'Viognier')

commerce7.wine_appellation
  id, company_id, title  (e.g. 'Snake River Valley', 'Idaho')

commerce7.collection
  id, company_id, title, slug, status  (product groupings / categories)

=== WHEN TO USE WHICH SOURCE ===

Use team_square for:
  - In-person tasting room sales (POS transactions)
  - Employee timeclock / shift data
  - Real-time sales during open hours
  - Square-specific category breakdown (glass pour vs bottle vs flight)

Use commerce7 for:
  - Online store orders (order_source = 'Website')
  - Wine club shipments (purchase_type = 'Club' or order_source = 'Wine Club')
  - Full product catalog with vintage, varietal, appellation detail
  - Customer lifetime value / order history
  - Club membership counts and status
  - Inventory / on-hand counts

Use BOTH for total combined revenue across all channels.

Example combined revenue:
  SELECT
    COALESCE(sq.sq_total, 0) + COALESCE(c7.c7_total, 0) AS total_revenue
  FROM (
    SELECT ROUND(SUM(total_money_amount) / 100.0, 2) AS sq_total
    FROM team_square.order WHERE state = 'COMPLETED'
  ) sq, (
    SELECT ROUND(SUM(total), 2) AS c7_total
    FROM commerce7.orders WHERE payment_status = 'Paid'
  ) c7

=== CRITICAL JOINS ===

Order line item → category (ALWAYS use this pattern for category queries):
  JOIN team_square.catalog_item_variation civ ON civ.id = oli.catalog_object_id
  LEFT JOIN team_square.catalog_item ci ON ci.id = civ.item_id
  LEFT JOIN team_square.catalog_category cc ON cc.id = ci.category_id
  LEFT JOIN teamtask_hub.square_catalog_category_map cmap ON cmap.catalog_item_id = civ.item_id
  -- Effective category: COALESCE(cc.name, cmap.category_name)

Order → location:
  JOIN team_square.location loc ON loc.id = o.location_id

=== LOCATIONS ===

There are two active Square locations. Use these exact name strings when filtering by location:
  'Kindred Vineyards, LLC.'  — the main winery/tasting room (note trailing period)
  'Kindred by the Creek'     — the creek location

Location name synonyms (map user language to the exact loc.name above):
  'Kindred Vineyards, LLC.'  → "kindred", "the winery", "the vineyard", "vineyard", "winery"
  'Kindred by the Creek'     → "the creek", "creek", "by the creek"

Example: if the user asks about "creek sales", filter with: WHERE loc.name = 'Kindred by the Creek'

=== IMPORTANT FACTS ===

- team_square money: CENTS — divide by 100.0 for dollars
- commerce7 money: DOLLARS — use directly, no division needed
- team_square.order_line_item quantity is NUMERIC — no cast needed
- Pre-2023 Square orders (before 2023-03-05) used 'Main Creek Menu' / 'Main Vineyard Menu' categories
- 2023+ Square orders use '750ml Bottle', 'Glass Pour', '5 Flight Tasting', etc.
- The mapping table bridges this gap — always COALESCE(cc.name, cmap.category_name) for Square queries
- Kindred Vineyards sells wine (750ml bottles and glass pours), wine flights, food (pizza, etc.), beer, and boutique items
- Only query COMPLETED Square orders unless asked: WHERE o.state = 'COMPLETED'
- Only query Paid Commerce7 orders unless asked: WHERE o.payment_status = 'Paid'
- The database also has fivetran_metadata, metabase, cellarpilot, wine, club_steward schemas — ignore these unless asked
- No duplicate category rows — each catalog_item has exactly one category_id

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
  oli.name ILIKE '%Merlot%'          -- in Square order_line_item (sales history)
  p.title  ILIKE '%Merlot%'          -- in commerce7.product (product catalog)
Never use exact equality (=) for wine product names — you'll miss vintages.

── COMMERCE7 PRODUCT CATALOG SEARCHES ──
When asked about a specific wine, product details, inventory, pricing, or varietal info,
search the PRODUCT CATALOG — not sales history. Use commerce7.product, not order_line_item.

Search by product title:
  SELECT p.id, p.title, p.vintage, p.price, p.admin_status, p.web_status
  FROM commerce7.product p
  WHERE p.title ILIKE '%11 Sails%'
  LIMIT 50

Search by varietal name (wine_varietal_ids is JSONB — use jsonb_array_elements_text):
  SELECT p.title, p.vintage, wv.title AS varietal
  FROM commerce7.product p
  JOIN commerce7.wine_varietal wv
    ON wv.id IN (SELECT jsonb_array_elements_text(p.wine_varietal_ids))
  WHERE wv.title ILIKE '%Tempranillo%'
  ORDER BY p.vintage DESC

Search by both title and varietal (broadest match — use when title alone may not include
the varietal name):
  SELECT DISTINCT p.title, p.vintage, p.price, p.admin_status
  FROM commerce7.product p
  LEFT JOIN commerce7.wine_varietal wv
    ON wv.id IN (SELECT jsonb_array_elements_text(p.wine_varietal_ids))
  WHERE p.title ILIKE '%11 Sails%'
     OR wv.title ILIKE '%Tempranillo%'
  ORDER BY p.vintage DESC

CRITICAL: wine_varietal_ids is JSONB, NOT a PostgreSQL array.
NEVER use = ANY(p.wine_varietal_ids) — it will error.
ALWAYS use: wv.id IN (SELECT jsonb_array_elements_text(p.wine_varietal_ids))

IMPORTANT: A wine's name in Kindred's catalog often does NOT include the varietal.
For example "11 Sails" is a Tempranillo — its title is "11 Sails", not "11 Sails Tempranillo".
Always search by title AND optionally by varietal join when looking for a specific wine.
Always check commerce7.product first when the user asks about a wine by name.

── CLASSIFY WINES IN SQL (SALES HISTORY) ──
For sales questions ("how many bottles sold", "revenue by type"), use ILIKE on the name
field of the relevant sales table:
  Square:    oli.name ILIKE '%Merlot%'          (team_square.order_line_item)
  Commerce7: oi.product_title ILIKE '%Merlot%'  (commerce7.order_items)

"How many red wines sold?" →
  WHERE (oli.name ILIKE '%Merlot%' OR oli.name ILIKE '%Cabernet%'
      OR oli.name ILIKE '%Syrah%' OR oli.name ILIKE '%Petit Verdot%'
      OR oli.name ILIKE '%Malbec%' OR oli.name ILIKE '%Pinot Noir%'
      OR oli.name ILIKE '%Tempranillo%' OR oli.name ILIKE '%Grenache%')

CRITICAL: When filtering by wine type using ILIKE name patterns, do NOT also filter
by category (e.g. do NOT add COALESCE(cc.name, cmap.category_name) = '750ml Bottle').
Only join the category tables if the user specifically asks to break down by format.

── CROSS-SOURCE QUERIES: USE ONE CTE QUERY ──
When a question spans BOTH sources (total sales, total bottles, combined revenue, etc.),
write a SINGLE SQL query using CTEs that returns all breakdowns in one result set.
Never make two separate run_sql calls when one combined query will do.

Template for combined totals:
  WITH sq AS (
    SELECT ... FROM team_square.order o
    JOIN team_square.order_line_item oli ON oli.order_id = o.id
    WHERE o.state = 'COMPLETED' AND <date filter>
  ),
  c7 AS (
    SELECT ... FROM commerce7.orders o
    JOIN commerce7.order_items oi ON oi.order_id = o.id
    WHERE o.payment_status = 'Paid' AND <date filter>
  )
  SELECT
    'Square (POS)'   AS source, sq.total_qty, sq.total_revenue FROM sq
  UNION ALL
  SELECT
    'Commerce7 (Online/Club)', c7.total_qty, c7.total_revenue FROM c7
  UNION ALL
  SELECT
    'Combined', sq.total_qty + c7.total_qty, sq.total_revenue + c7.total_revenue
  FROM sq, c7

For "bottles sold": Square = category '750ml Bottle'; Commerce7 = volume_in_ml = 750
  or product type 'Wine' with a bottle purchase_type

── CUSTOMER DATA: IMPORTANT LIMITATIONS ──
Commerce7 is the SOURCE OF TRUTH for customer data.
Square (team_square) tasting room orders are MOSTLY ANONYMOUS — customer_id is NULL
on the majority of Square orders. Do NOT try to join customers across the two systems
unless the user explicitly asks for a cross-platform match.

For customer questions:
  - "who are our top customers" → use commerce7.customers + commerce7.orders
  - "customer lifetime value" → use commerce7.customers.order_information JSONB
    (contains: orderCount, totalSpent, lastOrderDate)
  - "club members" → commerce7.club_membership + commerce7.club
  - "cross-platform customer" → match by email only (lossy — most Square orders have no email)

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
    description: 'Run a read-only SQL SELECT query against the PostgreSQL database (team_square and commerce7 schemas). Returns rows and field names.',
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

  // ── Prompt caching ─────────────────────────────────────────────────────────
  // The static schema context (~3k tokens) is marked as cacheable.
  // Anthropic caches it for 5 min — subsequent calls within the window pay 1/10th
  // the input token cost for that block.  Facts/lessons are dynamic so they are
  // appended as a second uncached block.
  const systemBlocks = [
    {
      type: 'text',
      text: SQUARE_SCHEMA_CONTEXT,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (facts || lessons) {
    systemBlocks.push({ type: 'text', text: facts + lessons });
  }

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
        system: systemBlocks,
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
        FROM team_square.order o
        JOIN team_square.order_line_item oli ON oli.order_id = o.id
        JOIN team_square.catalog_item_variation civ ON civ.id = oli.catalog_object_id
        JOIN team_square.catalog_item ci ON ci.id = civ.item_id
        LEFT JOIN team_square.catalog_category cc ON cc.id = ci.category_id
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
          AND (cc.name IS NULL OR cc.name <> '750ml Bottle')
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
