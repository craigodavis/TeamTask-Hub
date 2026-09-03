import express from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { pool, query } from '../db.js';
import { getModelForProcess } from '../lib/aiModelSettings.js';
import { randomUUID } from 'crypto';
import { fetchLiveSquareSales } from '../lib/squareLiveSales.js';
import { sendSmsToUsers } from '../lib/smsHelper.js';

const router = express.Router();

// Models the Kindred AI chat may switch between (id → label). A requested model
// must be in this allowlist; otherwise the company default is used.
const KINDRED_AI_MODELS = {
  'claude-fable-5':  'Fable 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-5': 'Sonnet 5',
};

// Model access by role (tier: Fable > Opus > Sonnet). Enforced server-side —
// the client dropdown is only a convenience. Everyone defaults to Sonnet.
const MODEL_TIERS = {
  owner:   ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5'],
  manager: ['claude-opus-4-8', 'claude-sonnet-5'],
};
const DEFAULT_AI_MODEL = 'claude-sonnet-5';
function allowedModels(role) { return MODEL_TIERS[role] || ['claude-sonnet-5']; }

// Approximate per-1M-token pricing (USD) — for the usage cost estimate only.
const MODEL_PRICING = {
  'claude-fable-5':            { in: 15, out: 75 },
  'claude-opus-4-8':           { in: 15, out: 75 },
  'claude-sonnet-5':           { in: 3,  out: 15 },
  'claude-sonnet-4-5':         { in: 3,  out: 15 },
  'claude-haiku-4-5-20251001': { in: 1,  out: 5 },
};
function estimateCost(model, inTok, outTok) {
  const p = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-5'];
  return Math.round(((inTok / 1e6) * p.in + (outTok / 1e6) * p.out) * 10000) / 10000;
}

// Data access for regular employees (not owner/manager): no employee wage/hours
// data at all (hard-blocked), and no sales older than 7 days (heuristic backstop
// on top of the prompt rule). Returns { allowed, reason }.
function aiSqlPolicy(sql, role) {
  if (role === 'owner' || role === 'manager') return { allowed: true };
  const s = (sql || '').toLowerCase();
  const wageHours = [
    'team_square.shift', 'team_member_job_assignment', 'scheduled_shift', 'shift_break',
    'wage_hourly_rate', 'hourly_rate', 'declared_cash_tip', 'wage_title', 'salary', 'payroll',
    'v_labor',  // canonical labor/labor-% views (v_labor_daily, v_labor_pct_daily)
  ];
  if (wageHours.some((w) => s.includes(w))) {
    return { allowed: false, reason: 'You do not have access to employee wage, hours, or timeclock data.' };
  }
  const touchesSales = /(order_line_item|\border\b|\bpayment\b|commerce7\.orders|order_items|v_square_net_sales|v_sales_daily|v_labor_pct)/.test(s);
  if (touchesSales) {
    const oldRange = /interval\s*'\s*\d+\s*(week|month|year|quarter)/.test(s)
      || /interval\s*'\s*(?:[89]|[1-9]\d\d*)\s*day/.test(s)
      || /\b20(1\d|2[0-4])\b/.test(s);
    if (oldRange) return { allowed: false, reason: 'You can only query sales from the last 7 days.' };
  }
  return { allowed: true };
}

// ── Schema context for AI ────────────────────────────────────────────────────
const SQUARE_SCHEMA_CONTEXT = `
You are a SQL analyst for Kindred Vineyards, a winery and tasting room in Sunnyslope, Idaho.
You query a PostgreSQL database with two primary data sources:
  • team_square  — in-person Square POS data (tasting room sales, catalog, timeclock)
  • commerce7    — online store, wine club, and DTC order data + full product catalog

╔══════════════════════════════════════════════════════════════════════════╗
║ USE THE CANONICAL VIEWS FOR SALES, REVENUE, LABOR, AND LABOR % — NOT RAW  ║
║ TABLES. These views are ALREADY IN DOLLARS (÷100 baked in) and encode the ║
║ exact definitions the emailed reports use. You physically cannot make the ║
║ cents/tax/Commerce7 mistakes if you query these instead of raw tables.    ║
╚══════════════════════════════════════════════════════════════════════════╝

  team_square.v_square_net_sales_daily (sales_date, location_id, net_sales, order_count)
     → Square "Net Sales" in DOLLARS (gross line-item sales − discounts, EXCLUDES
       tax/tips/service charges). Tasting-room/POS only. Matches Square's Reporting
       API and the emailed labor reports. THIS is "Square sales / revenue".

  team_square.v_labor_daily (work_date, location_id, wage_title, team_member_id, shift_id, hours, labor_cost)
     → Labor cost in DOLLARS + hours, per closed shift. Group by wage_title for
       "labor by role", by location_id for "labor by location".

  team_square.v_labor_pct_daily (the_date, net_sales, labor_cost, labor_pct)
     → Labor % = labor_cost ÷ Square Net Sales (Square-only, the correct denominator).
       For a DATE RANGE: SUM(labor_cost)/SUM(net_sales)*100 — NEVER average labor_pct.

  commerce7.v_sales_daily (sales_date, total_sales, subtotal, order_count)
     → Commerce7 online/club/DTC sales in DOLLARS. This is whole-company revenue,
       SEPARATE from the labor % denominator — do NOT add it to labor % sales.

  LABOR % — THE #1 THING PEOPLE GET WRONG:
    • Denominator is SQUARE NET SALES ONLY. NEVER include Commerce7 in labor %.
    • Net sales EXCLUDES tax. NEVER use team_square."order".total_money_amount for
      labor % (it includes tax and inflates the denominator).
    • Correct labor % is typically ~25–30% for this business. If you compute
      labor % below ~20%, you almost certainly used the wrong denominator (tax
      included, or Commerce7 added) — recompute from v_labor_pct_daily.
    • Example — labor % year-to-date 2026:
        SELECT ROUND(SUM(labor_cost)/NULLIF(SUM(net_sales),0)*100, 1) AS labor_pct
        FROM team_square.v_labor_pct_daily
        WHERE the_date BETWEEN '2026-01-01' AND '2026-07-19';
    • Example — labor % by role, last 7 days:
        SELECT wage_title,
               ROUND(SUM(labor_cost),2) AS labor,
               ROUND(SUM(hours),1) AS hours
        FROM team_square.v_labor_daily
        WHERE work_date >= CURRENT_DATE - 7
        GROUP BY wage_title ORDER BY labor DESC;

  Use raw team_square/commerce7 tables ONLY for questions the views don't cover
  (individual orders, catalog/products, customers, clubs, breaks, etc.). For any
  sales/revenue/labor/labor-% total, START from the views above.

CRITICAL money difference — YOU MUST GET THIS RIGHT. Decimal errors here are
extremely costly. Re-verify EVERY money figure before you return it.
  team_square  → money stored in CENTS.  ALWAYS divide by 100.0.  (4500 → $45.00)
  commerce7    → money stored in CENTS TOO.  ALWAYS divide by 100.0.  (4500 → $45.00)
                 This includes commerce7.orders.total, sub_total, tax_total,
                 ship_total, tip_total, total_after_tip AND commerce7.order_items.price
                 / commerce7.product.price — ALL are cents. A commerce7 sales figure
                 that looks ~100× too large means you FORGOT to divide by 100 — divide it.
  teamtask_hub receipts/receipt_items → money stored in DOLLARS ALREADY. Use directly.

  RULE OF THUMB: team_square and commerce7 are BOTH cents (÷100). Only
  teamtask_hub receipts are already dollars.

  MANDATORY SELF-CHECK before running any SQL that touches money: for each money
  column, identify its source. team_square → ÷100. commerce7 or receipts → NO
  division. If a query mixes team_square and commerce7, divide ONLY the
  team_square columns. A commerce7 figure that looks 100× too small means you
  wrongly divided — remove the /100.

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
  NOTE: wage_title IS the role/job title — for "labor by role" or "hours by role"
  questions, group by wage_title directly on this table. No join needed.

team_square.shift_break  (rare — most shifts have no recorded break; almost never
  needed for labor/role/overtime reporting, do not join to this unless the user
  explicitly asks about breaks specifically)
  id, shift_id, break_type_id, name, start_at, end_at, expected_duration, is_paid

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

commerce7.orders  ← money is CENTS (divide by 100)
  id, company_id, order_number,
  order_submitted_date (TIMESTAMPTZ), order_paid_date (TIMESTAMPTZ), order_fulfilled_date (TIMESTAMPTZ),
  order_source  ('Tasting Room'|'Website'|'Wine Club'|'Phone'|'Import'|'Admin'),
  customer_type ('Member'|'Guest'|'Trade'),
  purchase_type ('Club'|'Bottle'|'Allocation'|'Gift Card'|etc.),
  channel       ('pos'|'web'|'api'),
  payment_status ('Paid'|'Unpaid'|'Partial'|'Refunded'),
  fulfillment_status ('Fulfilled'|'Unfulfilled'|'Partial'),
  shipping_status ('Shipped'|'Unshipped'|'Partial'|null),
  sub_total, ship_total, tax_total, duty_total, tip_total, total, total_after_tip (all CENTS — ÷100),
  customer_id (FK → commerce7.customers),
  bill_to_first_name, bill_to_last_name, bill_to_city, bill_to_state_code, bill_to_zip_code,
  sales_attribute_code, club (JSONB — club shipment detail if purchase_type='Club'),
  tenders (JSONB), promotions (JSONB), coupons (JSONB), tags (TEXT[])

commerce7.order_items  ← money is CENTS (divide by 100)
  id, company_id, order_id,
  product_title, product_slug, item_type,
  product_id (FK → commerce7.product), product_variant_id (FK → commerce7.product_variant),
  product_variant_title, sku,
  price, original_price, compare_price, cost_of_good (all CENTS — ÷100; cost_of_good for margin),
  quantity (INTEGER), quantity_fulfilled,
  tax, tax_type, bottle_deposit,
  volume_in_ml, alcohol_percentage,
  department_code, department_id, allocation_id,
  is_price_override, notes

commerce7.product
  id, company_id,
  title, slug, type ('Wine'|'Beer'|'Merchandise'|'Food'|'Bundle'|etc.),
  admin_status ('Active'|'Inactive'), web_status ('Active'|'Inactive'|'Unlisted'),
  price, compare_price (CENTS — ÷100),
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
  price, compare_price (CENTS — ÷100),
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
  id, company_id, title, slug, is_published (BOOLEAN), description  (product groupings / categories)

=== KITCHEN: RECIPES (teamtask_hub schema — no cents, these are counts/text) ===

recipes
  id, company_id, name, category ('Pizza'|'Other'|etc.), description, instructions
  (free-text ingredient breakdown), menu_price, status, prep_time_minutes
recipe_ingredients  (structured ingredient list for a recipe)
  recipe_id → recipes, ingredient_id → ingredients, quantity, unit, position, note
ingredients
  id, company_id, name, base_unit, description
recipe_components  (a recipe that consumes another recipe / sub-recipe)
  parent_recipe_id → recipes, child_recipe_id → recipes, quantity, unit, note

Recipe questions ("what's in the Pequeño Diablo pizza?", "recipe for X"):
  SELECT r.name, r.instructions FROM recipes r
  WHERE r.company_id = $company AND r.name ILIKE '%pequeño diablo%'
For the structured ingredient list, join recipe_ingredients + ingredients:
  SELECT i.name, ri.quantity, ri.unit, ri.note
  FROM recipes r JOIN recipe_ingredients ri ON ri.recipe_id = r.id
  JOIN ingredients i ON i.id = ri.ingredient_id
  WHERE r.name ILIKE '%pequeño diablo%' ORDER BY ri.position
Note: a recipe's full detail may be in the free-text instructions column even if
it has no structured recipe_ingredients rows yet — check both.

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
    SELECT ROUND(SUM(total) / 100.0, 2) AS c7_total
    FROM commerce7.orders WHERE payment_status = 'Paid'
  ) c7

=== LABOR / ROLE / OVERTIME REPORTING ===

Use team_square.shift directly for all labor questions — wage_title (role) and
wage_hourly_rate_amount already live on this table, no join needed. Only reach for
team_square.shift_break if the user explicitly asks about breaks.

Hours worked per shift: EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0
Labor cost per shift:   hours * (wage_hourly_rate_amount / 100.0)

NOTE: ROUND() requires numeric, not double precision — EXTRACT(EPOCH FROM ...)
returns double precision, so always cast with ::numeric before rounding, e.g.
ROUND((SUM(...))::numeric, 1), or ROUND() will error.

Example — hours and labor cost by role, last 7 days:
  SELECT
    wage_title AS role,
    ROUND((SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0))::numeric, 1) AS hours,
    ROUND((SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0 * wage_hourly_rate_amount / 100.0))::numeric, 2) AS labor_cost
  FROM team_square.shift
  WHERE status = 'CLOSED' AND start_at >= NOW() - INTERVAL '7 days'
  GROUP BY wage_title
  ORDER BY hours DESC

Overtime risk (weekly hours per team member, company-defined threshold is 40/week):
  SELECT
    team_member_id,
    date_trunc('week', start_at) AS week,
    ROUND((SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0))::numeric, 1) AS hours
  FROM team_square.shift
  WHERE status = 'CLOSED'
  GROUP BY team_member_id, date_trunc('week', start_at)
  HAVING SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0) > 40
  ORDER BY week DESC, hours DESC

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
- commerce7 money: CENTS — divide by 100.0 (same as team_square)
- team_square.order_line_item quantity is NUMERIC — no cast needed
- Pre-2023 Square orders (before 2023-03-05) used 'Main Creek Menu' / 'Main Vineyard Menu' categories
- 2023+ Square orders use '750ml Bottle', 'Glass Pour', '5 Flight Tasting', etc.
- The mapping table bridges this gap — always COALESCE(cc.name, cmap.category_name) for Square queries
- Kindred Vineyards sells wine (750ml bottles and glass pours), wine flights, food (pizza, etc.), beer, and boutique items
- Only query COMPLETED Square orders unless asked: WHERE o.state = 'COMPLETED'
- Only query Paid Commerce7 orders unless asked: WHERE o.payment_status = 'Paid'
- The database also has a "vintly" schema (Kindred's winemaking/cellar system) — USE it for any question about wine lots, barrels/tanks, fermentations, harvest, vineyards, lab numbers, or the winemaking journal (see VINTLY WINEMAKING SCHEMA below)
- The database also has fivetran_metadata, metabase, cellarpilot, wine, club_steward schemas — ignore these unless asked
- No duplicate category rows — each catalog_item has exactly one category_id

=== VINTLY WINEMAKING SCHEMA (schema: vintly) ===
Kindred's cellar/winemaking system. CRITICAL: every vintly.* table has a company_id, and Vintly uses a
DIFFERENT company id than Square/Commerce7 — ALWAYS scope vintly queries with
company_id = '4a461f89-67e9-43c3-b9e1-a66f19a4960c' (Kindred Vineyards in Vintly). Also filter deleted_at IS NULL
for active records. Units are literal: liters, grams (adds), tons, brix, pH, TA (g/L), SO2 (ppm/mg/L).
Key tables:
- vintly.projects — a WINE LOT: id, name, vintage, wine_type_id→wine_types, vineyard_id→vineyards, status, is_active, is_blend, bottling_date, starting_case_qty. ("the 2024 Sangiovese" = a project row.)
- vintly.wine_types — wine specs/targets: id, name, category, target_harvest_brix(_min/_max), target_harvest_ph, target_post_mlf_ph, target_pre_ml_ta, target_post_ml_ta, target_molecular_so2, target_potassium
- vintly.vessels — BARRELS/TANKS: id, barrel_no, project_id→projects, vessel_type_id→vessel_types, status, storage_area, active, volume_override_liters, barrel_date, projected_bottling_year, ml_started
- vintly.vessel_types — id, name, class, material, age, toast, liter_volume
- vintly.ferment_bins — fermentation bins: id, bin_number, project_id, stage, ferment_type, gross_liters_off_press, must_ph
- vintly.harvests — id, harvest_date, project_id, location_id, harvest_type, gross_tons, metric_tons, brix, ph, ta, potassium, price_per_ton, picking_fee
- vintly.vineyards — id, name, initials, contact_name/phone/email
- vintly.journal_entries — winemaking WORK LOG (per barrel/bin): entry_date, subject_type ('vessel' or 'ferment_bin'), subject_id (→vessels.id when subject_type='vessel', →ferment_bins.id when 'ferment_bin'), work_types (text[]: 'Top Wine','SO2 Test/Add','PH Test','Brix Test/Add','TA','ML Started','Yeast Add','Blended','Bentonite Add','Chitosan','Kieselsol','Acetic Acid Test','Other'), ph, ta, fso2, brix, potassium, topped (bool), so2_add_g, tartaric_add_g, sugar_add_g, other_add, other_add_qty, notes (free text), created_by→users
- vintly.lab_analyses — lab samples: vessel_id/ferment_bin_id, sample_date, ph, ta, va, malic, fso2, tso2, alcohol, brix (may be empty)
- vintly.blend_allocations — blend moves: source_vessel_id, dest_project_id, liters, moved_at
- vintly.users — id, display_name, role (Zoe, Craig, Jack, Tristan)
JOINS: a wine's barrels = vintly.vessels WHERE project_id = <project>. Link a journal entry to its subject with
  LEFT JOIN vintly.vessels v ON je.subject_type='vessel' AND v.id = je.subject_id
  LEFT JOIN vintly.ferment_bins fb ON je.subject_type='ferment_bin' AND fb.id = je.subject_id
Vintage lives on vintly.projects.vintage. "Barrel 47" → vintly.vessels WHERE barrel_no = '47'.

=== HOW TO RESPOND ===

You have tools for the database (run_sql), memory (save_fact), live Square
sales, discrepancy alerts, and the open web (web_search and web_fetch).

── WHEN YOU DON'T KNOW A TABLE: describe_tables ──
The prompt documents the tables people happened to write down; the index at the
end lists every table that actually exists. If a question touches something not
documented above, do NOT guess column names and do NOT tell the user you have no
access to it. Call describe_tables on the likely tables, read the real columns,
then write the query.

── INVENTORY AND PROJECTIONS ──
Bottle inventory lives in the 'product' schema, not in Square or Commerce7:
  product.product_inventory      current count per product per location
                                 (total_bottles, library_bottles, last_counted_at)
  product.product_inventory_log  every past count -- this is the monthly count
                                 history, one row per product per count
  product.products / product_variants   the wines themselves; variants carry the
                                 SKU and is_glass
Locations are teamtask_hub.locations (Winery, Creek); its square_location_id
joins to Square.

Counts are physical, taken roughly monthly, and each row carries its own
last_counted_at -- different wines were counted on different days, so always
report the count date alongside the number rather than implying it is live.

To project how long stock will last, subtract Square sell-through since the
count from the counted quantity. Match Square sales to wines through the SKU
(product_variants.sku = team_square.catalog_item_variation.sku, then
order_line_item.catalog_object_id = that variation's id).

A glass pour is not a bottle: a 5oz pour is a fifth of a 750ml bottle, so divide
glass quantities by 5 before subtracting them from bottle counts. Variants where
is_glass is true are pours; the rest are bottles.

Worked shape -- days of stock remaining per wine per location:
  WITH on_hand AS (
    SELECT p.id AS product_id, p.name, l.name AS location,
           pi.total_bottles, pi.last_counted_at::date AS counted_on
      FROM product.product_inventory pi
      JOIN product.products p ON p.id = pi.product_id
      JOIN teamtask_hub.locations l ON l.id = pi.location_id
     WHERE pi.company_id = <company>
  ), velocity AS (
    SELECT v.product_id,
           SUM(CASE WHEN v.is_glass THEN li.quantity::numeric / 5.0
                    ELSE li.quantity::numeric END) AS bottles_sold
      FROM product.product_variants v
      JOIN team_square.catalog_item_variation civ
        ON LOWER(civ.sku) = LOWER(v.sku) AND civ.is_deleted = false
      JOIN team_square.order_line_item li ON li.catalog_object_id = civ.id
      JOIN team_square."order" o ON o.id = li.order_id
     WHERE o.closed_at >= NOW() - INTERVAL '60 days'
     GROUP BY v.product_id
  )
  SELECT oh.name, oh.location, oh.total_bottles, oh.counted_on,
         ROUND(vel.bottles_sold / 60.0, 2) AS bottles_per_day,
         ROUND(oh.total_bottles / NULLIF(vel.bottles_sold / 60.0, 0)) AS days_of_stock
    FROM on_hand oh LEFT JOIN velocity vel ON vel.product_id = oh.product_id;

Answer these questions with judgement, not just a table: say which wines run out
first, roughly when, whether the rate is rising or falling, and flag anything
that will not survive to the next release. A wine with no Square sales is not
necessarily dead -- it may sell through the club in Commerce7, so check there
before calling it stagnant.

── WHEN TO USE web_search ──
The database is the authority on anything about this business -- sales,
inventory, labor, customers, winemaking. Never search the web for those; query
them. Search the web when the answer genuinely lives outside our own records:
current market or grape pricing, competitors' listed prices, regulations and
filing deadlines, industry benchmarks, weather, suppliers, wine-scoring or
press coverage. Say where a figure came from, and don't blend a searched number
into our own reporting without labelling it as external.

── WHEN TO USE save_fact (long-term memory, shared by ALL users) ──
save_fact is your persistent, company-wide memory: everything saved is recalled
in every future chat, for every user. Use it to remember durable facts about the
business or the user's preferences — whether they tell you directly OR you learn
it during the conversation:
  "those are our red wines", "we close at 5pm", "Craig is the owner"
Save each distinct fact as a separate save_fact call. Don't save one-off values
you can re-query (e.g. last month's sales) — only durable knowledge.
After saving, confirm conversationally what you stored.

── WHEN TO USE run_sql ──
Use run_sql for data questions (sales, revenue, counts, dates, etc.).

── CROSS-CHECK SALES TOTALS AGAINST LIVE SQUARE ──
When the user asks for a SALES TOTAL or revenue figure for a date range, also
call get_live_square_sales for the same range, then present BOTH the database
figure and the live Square figure side by side (e.g. "Database: $X · Live Square:
$Y"). If they differ by more than ~2%, call flag_sales_discrepancy with both
totals and the range so the owner is alerted. (This only applies to sales totals,
not to arbitrary breakdowns the live API can't answer.)

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
Use commerce7.product ONLY for catalog info (price, status, inventory). NEVER count sales from it.

── SALES OF A SPECIFIC WINE — ALWAYS QUERY BOTH SOURCES ──
When asked how many bottles of a specific wine were sold, ALWAYS combine Square + Commerce7.
Square = tasting room in-person; Commerce7 = online/club/DTC. Never report just one source.

Template — bottles sold of a specific wine (e.g. "11 Sails"):
  WITH sq AS (
    SELECT COALESCE(SUM(oli.quantity), 0) AS qty,
           ROUND(COALESCE(SUM(oli.total_amount), 0) / 100.0, 2) AS revenue
    FROM team_square.order o
    JOIN team_square.order_line_item oli ON oli.order_id = o.id
    WHERE o.state = 'COMPLETED'
      AND oli.name ILIKE '%11 Sails%'
      AND o.created_at >= '2025-01-01'
  ),
  c7_sold AS (
    SELECT COALESCE(SUM(oi.quantity), 0) AS qty,
           ROUND(COALESCE(SUM(oi.price * oi.quantity), 0), 2) AS revenue
    FROM commerce7.orders o
    JOIN commerce7.order_items oi ON oi.order_id = o.id
    WHERE o.payment_status = 'Paid'
      AND oi.product_title ILIKE '%11 Sails%'
      AND o.company_id = (SELECT id FROM companies LIMIT 1)
      AND o.order_submitted_date >= '2025-01-01'
  ),
  c7_returned AS (
    SELECT COALESCE(SUM(oi.quantity), 0) AS qty
    FROM commerce7.orders o
    JOIN commerce7.order_items oi ON oi.order_id = o.id
    WHERE o.payment_status = 'Refunded'
      AND oi.product_title ILIKE '%11 Sails%'
      AND o.company_id = (SELECT id FROM companies LIMIT 1)
      AND o.order_submitted_date >= '2025-01-01'
  )
  SELECT
    'Square (Tasting Room)'    AS source, sq.qty  AS bottles, sq.revenue  AS revenue FROM sq
  UNION ALL
  SELECT 'Commerce7 Sold',     c7_sold.qty,      c7_sold.revenue          FROM c7_sold
  UNION ALL
  SELECT 'Commerce7 Returned', c7_returned.qty,  NULL                     FROM c7_returned
  UNION ALL
  SELECT 'Total Net',
    sq.qty + c7_sold.qty - c7_returned.qty,
    sq.revenue + c7_sold.revenue
  FROM sq, c7_sold, c7_returned

IMPORTANT date fields:
  Square:    use o.created_at (NOT o.closed_at — closed_at is often NULL)
  Commerce7: use o.order_submitted_date

IMPORTANT company filter for Commerce7:
  Always add: AND o.company_id = (SELECT id FROM companies LIMIT 1)
  commerce7.orders contains data for all companies — without this filter counts will be wrong.

NEVER report a count from commerce7.product — that table has 1 row per product, not per sale.
commerce7.product is the CATALOG. commerce7.order_items is where SALES live.

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

=== PURCHASING / RECEIPTS (teamtask_hub) ===

Use these tables for expense and purchasing questions — what Kindred BOUGHT, not what it SOLD.

teamtask_hub.receipts  — one row per vendor invoice or receipt
  id, company_id, order_number, order_date (DATE — may be null for some Amazon receipts),
  vendor (e.g. 'Amazon', 'Sysco', 'Amazon.com / Kindred Vineyards'),
  subtotal, tax, total (DOLLARS — numeric, use directly),
  status ('pending'|'reviewed'|'imported'|'excluded'),
  card_last4, payment_instrument, source ('amazon'|'sysco'|'upload'|null),
  delivery_address (TEXT — street address the order shipped to; populated for Sysco invoices),
  created_at

LOCATION MAPPING — use delivery_address to identify which Kindred property received the order:
  '616 MAIN ST'  (or contains '616 MAIN')  → "Kindred by the Creek" (tasting room, downtown Caldwell)
  '14253 FROST RD' (or contains 'FROST')   → "Kindred Vineyards" (the winery)
  When delivery_address is NULL             → unknown / Amazon or other vendor

To break out spending by location, filter or GROUP BY delivery_address with a CASE expression:
  CASE
    WHEN r.delivery_address ILIKE '%616%MAIN%' THEN 'Kindred by the Creek'
    WHEN r.delivery_address ILIKE '%FROST%'    THEN 'Kindred Vineyards'
    ELSE 'Unknown / Other'
  END AS location

teamtask_hub.receipt_items  — line items on each receipt
  id, receipt_id, description (product name from invoice),
  quantity, unit_price, total (DOLLARS),
  pack (TEXT — Sysco pack size, e.g. '475 CT', '5012X12', '125 LB', '110#AVG';
        null for Amazon/other vendors),
  qbo_account_id (FK → teamtask_hub.qbo_accounts.qbo_id),
  qbo_class_id   (FK → teamtask_hub.qbo_classes.qbo_id),
  item_status ('pending'|'accepted'), created_at

  Pack size notes:
    - "475 CT" means 475 individual pieces per case → price per unit = total / 475
    - "5012X12" means 50 count, 12"×12" sheets → price per unit = total / 50
    - "125 LB" means 125-pound bag (not a count; report $/lb = total / 125)
    - "110#AVG" means ~110-lb average weight item (report $/lb = total / 110)
    - "6#10" means 6 cans of #10 size → price per can = total / 6
    When answering "price per item/unit", parse the numeric prefix from pack to divide total.

teamtask_hub.qbo_accounts  — QuickBooks chart of accounts (expense categories)
  qbo_id, name, fully_qualified_name, account_type, account_sub_type, classification

teamtask_hub.qbo_classes  — QuickBooks classes (cost centers / departments)
  qbo_id, name, fully_qualified_name
  Key classes include: 'Wine', 'Food', 'Events', 'Tasting Room', 'Admin'

teamtask_hub.product_memory  — learned categorization hints (not a purchasing record)
  product_pattern (description, lowercase), qbo_account_id, qbo_class_id, usage_count, last_used_at

Purchasing query rules:
  - receipt amounts are DOLLARS — no division needed
  - Always filter: WHERE r.company_id = (SELECT id FROM companies LIMIT 1)
  - For date filtering prefer r.order_date; fall back to r.created_at when order_date is null
  - Exclude status = 'excluded' (personal-use purchases) unless the user asks for them
  - status = 'imported' means already pushed to QuickBooks
  - CRITICAL — searching descriptions: Sysco product descriptions contain SKU codes and words
    in non-obvious order (e.g. "5012X12 SYS CLS BOX PIZZA 12 W/K B-FLT"). NEVER use a
    multi-word phrase in a single LIKE — the words may be in any order or separated by codes.
    Instead split the search into one LIKE per keyword joined with AND:
      GOOD: LOWER(ri.description) LIKE '%pizza%' AND LOWER(ri.description) LIKE '%box%'
      BAD:  LOWER(ri.description) LIKE '%pizza box%'  ← will miss "BOX PIZZA" descriptions
    When the user asks for a product by a common name, also try synonyms or abbreviations.

Example purchasing queries:
  "How much did we spend on napkins last month?"
    SELECT SUM(ri.total) FROM teamtask_hub.receipt_items ri
    JOIN teamtask_hub.receipts r ON r.id = ri.receipt_id
    WHERE r.company_id = (SELECT id FROM companies LIMIT 1)
      AND LOWER(ri.description) LIKE '%napkin%'
      AND r.order_date >= date_trunc('month', NOW() - interval '1 month')
      AND r.order_date <  date_trunc('month', NOW())
      AND r.status != 'excluded'

  "What did we buy from Sysco this month?"
    SELECT ri.description, ri.total FROM teamtask_hub.receipt_items ri
    JOIN teamtask_hub.receipts r ON r.id = ri.receipt_id
    WHERE r.company_id = (SELECT id FROM companies LIMIT 1)
      AND r.vendor ILIKE '%sysco%'
      AND r.order_date >= date_trunc('month', NOW())
    ORDER BY ri.total DESC

  "What's the price per napkin?"
    SELECT ri.description, ri.pack, ri.total,
           ri.total / NULLIF(CAST(REGEXP_REPLACE(ri.pack, '[^0-9].*', '') AS NUMERIC), 0) AS price_per_unit
    FROM teamtask_hub.receipt_items ri
    JOIN teamtask_hub.receipts r ON r.id = ri.receipt_id
    WHERE r.company_id = (SELECT id FROM companies LIMIT 1)
      AND LOWER(ri.description) LIKE '%napkin%'
      AND ri.pack IS NOT NULL
    ORDER BY r.order_date DESC LIMIT 5

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

── FORMATTING RULES — ALWAYS FOLLOW ──
Currency: always use a $ sign and comma thousands separators.
  Correct:   $1,234.56    $45.00    $123,456.78
  Wrong:     1234.56      45        123456.78

Large counts: always use comma separators.
  Correct:   12,345 bottles    1,234 orders
  Wrong:     12345 bottles     1234 orders

Percentages: one decimal place → 12.3%

In SQL: always ROUND money to 2 decimal places — ROUND(amount / 100.0, 2) for Square cents,
ROUND(amount, 2) for dollar-based sources.

Present results as natural sentences or a short readable list — not raw JSON or bare numbers.
Example: "You sold 1,234 bottles for $45,678.90 in revenue last month."

You may use Markdown to make answers readable — it is rendered in the chat:
  **bold**, ## / ### headings, "- " bullet lists, "1." numbered lists, and tables.
When rewriting or formatting something (e.g. a recipe), USE this: a bold/heading
title, then a bulleted or numbered list of steps/ingredients, so it's easy to read.

── HOW TO ANSWER — THIS MATTERS AS MUCH AS THE SQL ──
ALWAYS finish by WRITING a complete, self-contained answer in prose. The raw
result table is NOT the answer, and a bare number ("4", "27%") is NEVER an
acceptable answer. If you run a query, you MUST then explain what it means.

PLAN before you query. If the question has multiple parts, or asks for a
comparison, trend, benchmark, or recommendation, work out EVERY number you need
and run as many queries as it takes to get them, THEN write the answer:
  - year-over-year / "compared to last year" needs BOTH years queried;
  - a "change" or "how much" needs both endpoints and the difference ($ and %);
  - a multi-part question must have EVERY part answered, each clearly labeled.

For analytical / advisory / "is this good, bad, optimal, dangerous" questions,
write a structured report a manager could paste into an email:
  - a short **bold headline** with the key number and the takeaway;
  - a Markdown table for comparisons (this year vs last year: $ and %);
  - benchmarks and judgement from your OWN knowledge when asked what's "optimal",
    "normal", "healthy", or "dangerous" — these are NOT in the database, so reason
    about them; do NOT run a query and give up;
  - a concrete recommendation or the specific number requested at the end.

Judgement context for labor questions:
  - Labor % is on Square NET SALES (excl tax & tips), HOURLY staff only — it
    EXCLUDES salaried staff and payroll taxes/benefits, so the true loaded cost is
    higher. State this caveat whenever you report a labor %.
  - Healthy hourly service labor ≈ 24–28% of net sales; 29–32% = watch;
    >33% sustained = dangerous. The TREND (labor growth vs sales growth) matters
    more than the level — always compare the two growth rates when asked about labor.

If a query returns nothing useful, or you are unsure, say what you found and what
you'd need next — never answer with just a count or an empty reply.
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


// ── Live schema discovery ────────────────────────────────────────────────────
// Airon used to know only the tables someone had hand-written into the prompt,
// so anything added since -- the whole `product` schema, inventory among it --
// was invisible to it and every new area meant editing this file. These two
// helpers replace that: the index tells it what exists, the tool tells it what
// the columns are. New tables show up on their own.
//
// The split is deliberate. The full DDL for the live schemas is ~23k tokens,
// which is a lot to carry on every question when any one question touches a
// handful of tables; the index alone is ~1.4k. So the index is always in the
// prompt and column detail is fetched on demand.
//
// deleteme_* and staging are excluded on purpose -- deleteme_square is a stale
// copy of the Square catalog, and a model that found it would answer questions
// about deleted data without knowing it.
const LIVE_SCHEMAS = [
  'teamtask_hub', 'team_square', 'commerce7', 'product',
  'vintly', 'wine', 'kindred_web', 'club_steward', 'cellarpilot', 'public',
];

let _schemaIndexCache = null;
async function schemaIndex() {
  if (_schemaIndexCache) return _schemaIndexCache;
  const r = await query(
    `SELECT table_schema, string_agg(table_name, ', ' ORDER BY table_name) AS tbls
       FROM information_schema.tables
      WHERE table_schema = ANY($1::text[]) AND table_type = 'BASE TABLE'
      GROUP BY table_schema ORDER BY table_schema`,
    [LIVE_SCHEMAS]
  );
  const views = await query(
    `SELECT table_schema, string_agg(table_name, ', ' ORDER BY table_name) AS tbls
       FROM information_schema.views WHERE table_schema = ANY($1::text[])
      GROUP BY table_schema ORDER BY table_schema`,
    [LIVE_SCHEMAS]
  );
  const viewsBySchema = Object.fromEntries(views.rows.map((v) => [v.table_schema, v.tbls]));
  const lines = r.rows.map((x) => {
    const v = viewsBySchema[x.table_schema];
    return `${x.table_schema}: ${x.tbls}${v ? `\n${x.table_schema} VIEWS: ${v}` : ''}`;
  });
  _schemaIndexCache = '\n=== EVERY TABLE IN THE DATABASE (live schemas) ===\n'
    + 'This list is generated from the database itself, so it is never stale.\n'
    + 'You do NOT know these tables\' columns -- call describe_tables before\n'
    + 'writing SQL against anything not already documented above.\n\n'
    + lines.join('\n') + '\n';
  return _schemaIndexCache;
}

/** Columns, keys and comments for specific tables, for the describe_tables tool. */
async function describeTables(names) {
  const wanted = names
    .map((n) => String(n).trim())
    .filter(Boolean)
    .map((n) => (n.includes('.') ? n : `teamtask_hub.${n}`));
  if (!wanted.length) return 'No tables requested.';
  if (wanted.length > 12) return 'Ask for at most 12 tables at a time.';

  const out = [];
  for (const full of wanted) {
    const [sch, tab] = full.split('.');
    if (!LIVE_SCHEMAS.includes(sch)) { out.push(`${full}: schema not available.`); continue; }
    const cols = await query(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              pgd.description
         FROM information_schema.columns c
         LEFT JOIN pg_catalog.pg_statio_all_tables st
                ON st.schemaname = c.table_schema AND st.relname = c.table_name
         LEFT JOIN pg_catalog.pg_description pgd
                ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position`,
      [sch, tab]
    );
    if (!cols.rows.length) { out.push(`${full}: no such table.`); continue; }
    const keys = await query(
      `SELECT con.contype, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND con.contype IN ('p','f','u')`,
      [sch, tab]
    );
    const rowCount = await query(`SELECT COUNT(*)::int AS n FROM ${sch}.${tab}`).catch(() => null);
    out.push(
      `${full}${rowCount ? ` (${rowCount.rows[0].n} rows)` : ''}\n`
      + cols.rows.map((c) =>
          `  ${c.column_name} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`
          + `${c.description ? ` -- ${c.description}` : ''}`).join('\n')
      + (keys.rows.length ? '\n  ' + keys.rows.map((k) => k.def).join('\n  ') : '')
    );
  }
  return out.join('\n\n');
}

// ── Tool definitions ──────────────────────────────────────────────────────────
/**
 * Anthropic-hosted tools. These are not implemented here and never appear in
 * the tool_use branch below -- Anthropic runs the search and the fetch on its
 * own infrastructure and returns the results inline, so there is nothing for
 * this server to execute and no key or crawler of our own to maintain.
 *
 * web_fetch only retrieves URLs that are already in the conversation, so it is
 * a follow-up to a search rather than a way to reach arbitrary addresses.
 *
 * The _20260209 variants filter results before they reach the context window.
 * Every model Kindred AI offers accepts them -- checked against the live API
 * rather than assumed, because the published support table doesn't enumerate
 * Fable 5. Deliberately no code_execution tool alongside them: these versions
 * run their own, and declaring a second one confuses the model about which
 * environment it is in.
 */
const WEB_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20260209',  name: 'web_fetch',  max_uses: 5 },
];

const SQUARE_TOOLS = [
  {
    name: 'describe_tables',
    description:
      'Look up the real columns, types and keys of any table in the database. '
      + 'Use this BEFORE writing SQL against a table whose columns you have not been '
      + 'shown, instead of guessing column names. Accepts up to 12 tables per call, '
      + 'named as schema.table (e.g. product.product_inventory).',
    input_schema: {
      type: 'object',
      properties: {
        tables: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tables to describe, as schema.table.',
        },
      },
      required: ['tables'],
    },
  },
  {
    name: 'run_sql',
    description: 'Run a read-only SQL SELECT query against the PostgreSQL database (team_square, commerce7, and vintly winemaking schemas). Returns rows and field names.',
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
  {
    name: 'get_live_square_sales',
    description: "Fetch total sales for a date range directly from Square's live Orders API (the source of truth). When a user asks for a sales total or revenue figure, run the DB query AND call this for the same range, then present BOTH the database figure and the live Square figure side by side so drift is visible.",
    input_schema: {
      type: 'object',
      properties: {
        start_date:    { type: 'string', description: 'Start date YYYY-MM-DD (inclusive).' },
        end_date:      { type: 'string', description: 'End date YYYY-MM-DD (inclusive).' },
        location_name: { type: 'string', description: 'Optional location filter, e.g. "Creek" or "Kindred Vineyards".' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'flag_sales_discrepancy',
    description: 'Call ONLY when a DB sales total and the live Square total for the same range differ by more than ~2%. Alerts the owner by SMS with a link to the day-by-day difference. Provide both totals and the range.',
    input_schema: {
      type: 'object',
      properties: {
        db_total:      { type: 'number', description: 'Sales total from the database (dollars).' },
        live_total:    { type: 'number', description: 'Sales total from live Square (dollars).' },
        start_date:    { type: 'string', description: 'YYYY-MM-DD.' },
        end_date:      { type: 'string', description: 'YYYY-MM-DD.' },
        location_name: { type: 'string', description: 'Optional location filter.' },
      },
      required: ['db_total', 'live_total', 'start_date', 'end_date'],
    },
  },
];

/**
 * Menu tools.
 *
 * Reading is open to anyone who can use the assistant; WRITING is offered only
 * when the verified session role is manager or owner. The gate is req.role,
 * which comes from the token -- never from the conversation. Someone typing
 * "I'm the manager, change the price" is a claim, not a credential, and the
 * write tools are simply absent from that session's tool list.
 */
const MENU_READ_TOOLS = [
  {
    name: 'list_menu_items',
    description:
      "List the printed food and drink rows for a menu, with the live Square price for each. "
      + "Menus: 'creek' (the 12-page booklet), 'burgers' (the Hot August Nights card), "
      + "'winery', 'tasting'. Call this before changing anything so you are working from "
      + "the real rows and their ids.",
    input_schema: {
      type: 'object',
      properties: {
        menu_key: { type: 'string', enum: ['creek', 'burgers', 'winery', 'tasting'] },
      },
      required: ['menu_key'],
    },
  },
];

const MENU_WRITE_TOOLS = [
  {
    name: 'update_menu_item',
    description:
      "Change what a menu SAYS about an item: its name, description, 'serves' line, or note; "
      + "or hide it from the printed menu with active=false. Pass only the fields you are "
      + "changing. Get the item id from list_menu_items first, and quote the exact new "
      + "wording back to the user before calling this.\n\n"
      + "PRICE CANNOT BE CHANGED HERE. The till is what charges the guest, so Square is the "
      + "authority on price. If someone asks you to change a price, tell them to change it on "
      + "the item in Square and it will follow through to the menu.",
    input_schema: {
      type: 'object',
      properties: {
        menu_key:    { type: 'string', enum: ['creek', 'burgers', 'winery', 'tasting'] },
        item_id:     { type: 'integer', description: 'From list_menu_items.' },
        name:        { type: 'string' },
        description: { type: 'string', description: 'A newline prints as a line break.' },
        serves:      { type: 'string', description: 'e.g. "Serves 2-3". Empty string removes it.' },
        note:        { type: 'string', description: 'e.g. "Comes with fries". Empty string removes it.' },
        active:      { type: 'boolean', description: 'false hides the item from the printed menu.' },
      },
      required: ['menu_key', 'item_id'],
    },
  },
];

const MENU_KEYS = ['creek', 'burgers', 'winery', 'tasting'];
const MENU_EDITABLE = ['name', 'description', 'serves', 'note', 'active'];

export async function aiListMenuItems(companyId, menuKey) {
  if (!MENU_KEYS.includes(menuKey)) return `Unknown menu "${menuKey}".`;
  const r = await query(
    `SELECT mi.id, mi.section, mi.name, mi.description, mi.serves, mi.note,
            mi.active, mi.sort_order, mi.sku, mi.price_cents,
            sq.square_cents, sq.square_name
       FROM menu_items mi
       LEFT JOIN LATERAL (
         SELECT ci.name AS square_name, MIN(civ.price_money_amount)::int AS square_cents
           FROM team_square.catalog_item_variation civ
           JOIN team_square.catalog_item ci ON ci.id = civ.item_id
          WHERE civ.sku = mi.sku AND civ.is_deleted = false AND ci.is_deleted = false
          GROUP BY ci.name) sq ON mi.sku IS NOT NULL
      WHERE mi.company_id = $1 AND mi.menu_key = $2
      ORDER BY mi.sort_order`,
    [companyId, menuKey]
  );
  if (!r.rows.length) return `The "${menuKey}" menu has no data rows -- its card is hand-authored.`;
  const money = (c) => (c == null ? 'no price' : '$' + (Number(c) / 100).toFixed(2).replace(/\.00$/, ''));
  return r.rows.map((x) =>
    `id=${x.id} [${x.section}] "${x.name}" ${money(x.square_cents ?? x.price_cents)}`
    + `${x.sku ? ` sku=${x.sku}` : ' (not linked to Square)'}`
    + `${x.active ? '' : ' HIDDEN'}`
    + `${x.description ? `\n    desc: ${x.description.replace(/\n/g, ' / ')}` : ''}`
    + `${x.serves ? `\n    serves: ${x.serves}` : ''}`
    + `${x.note ? `\n    note: ${x.note}` : ''}`
  ).join('\n');
}

/**
 * Apply one menu edit on behalf of a person, and record who asked.
 * Re-checks the role rather than trusting that the tool was only offered:
 * the gate that matters is the one at the point of the write.
 */
export async function aiUpdateMenuItem(req, input) {
  if (req.role !== 'owner' && req.role !== 'manager') {
    return 'Refused: changing a menu is limited to managers and owners.';
  }
  const { menu_key: menuKey, item_id: itemId } = input;
  if (!MENU_KEYS.includes(menuKey)) return `Unknown menu "${menuKey}".`;
  for (const k of ['price', 'price_cents', 'sku']) {
    if (k in input) {
      return k === 'sku'
        ? 'Refused: the SKU is the link to Square and cannot be changed from here.'
        : 'Refused: price comes from Square. Change it on the item in Square and the menu follows.';
    }
  }
  const patch = {};
  for (const f of MENU_EDITABLE) {
    if (!(f in input)) continue;
    let v = input[f];
    if (typeof v === 'string') v = v.trim() === '' ? null : v.trim();
    if (f === 'name' && !v) return 'Refused: an item needs a name.';
    patch[f] = v;
  }
  if (!Object.keys(patch).length) return 'Nothing to change -- no editable field was supplied.';

  const cur = (await query(
    `SELECT * FROM menu_items WHERE id = $1 AND company_id = $2 AND menu_key = $3`,
    [itemId, req.companyId, menuKey]
  )).rows[0];
  if (!cur) return `No item ${itemId} on the "${menuKey}" menu.`;

  const vals = [];
  const sets = Object.keys(patch).map((f, i) => { vals.push(patch[f]); return `${f} = $${i + 1}`; });
  vals.push(itemId, req.companyId, menuKey);
  const upd = await query(
    `UPDATE menu_items SET ${sets.join(', ')}, updated_at = now(), updated_by = $${vals.length + 1}
      WHERE id = $${vals.length - 2} AND company_id = $${vals.length - 1} AND menu_key = $${vals.length}
      RETURNING *`,
    [...vals, req.userId || null]
  );
  await query(
    `INSERT INTO menu_item_changes (company_id, menu_key, item_id, action,
       before_json, after_json, actor, actor_user, created_at)
     VALUES ($1,$2,$3,'ai-update',$4,$5,$6,$7, now())`,
    [req.companyId, menuKey, itemId, JSON.stringify(cur), JSON.stringify(upd.rows[0]),
     `kindred-ai:${req.userId ? 'user:' + req.userId : 'unknown'}`, req.userId || null]
  );
  const changed = Object.keys(patch)
    .map((f) => `${f}: ${JSON.stringify(cur[f])} -> ${JSON.stringify(upd.rows[0][f])}`)
    .join('; ');
  return `Updated "${upd.rows[0].name}" on the ${menuKey} menu. ${changed}. `
    + 'The change is recorded in the menu audit trail and will appear the next time the menu is printed.';
}

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
// ── Attachments ──────────────────────────────────────────────────────────────
//
// No per-route capability guard here: index.js mounts this whole router behind
// requireAuth + requireCapability('ai.use'), so every path below is already
// gated. Repeating it would only invite it to drift.
//
// What Claude can actually read, and how each has to be framed in the request.
// Anything not on this list is refused at upload rather than accepted and then
// quietly ignored -- a file that uploads but is never looked at is the worst
// outcome, because the person believes it was considered.
const ATTACH_KIND = {
  'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image', 'image/webp': 'image',
  'application/pdf': 'document',
  'text/plain': 'text', 'text/csv': 'text', 'text/markdown': 'text', 'application/json': 'text',
};
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;   // per file
const MAX_SESSION_ATTACH = 5;                // per conversation
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;    // the API caps a request at 32MB

const attachUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACH_BYTES, files: 1 },
});

/** Human-readable size, for error messages people have to act on. */
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)}MB`;

// POST /api/square/attachments — one file, tied to a session when there is one
router.post('/attachments', attachUpload.single('file'), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file received' });
    const kind = ATTACH_KIND[f.mimetype];
    if (!kind) {
      return res.status(415).json({
        error: `Kindred AI can't read ${f.mimetype || 'that file type'}. `
             + 'It handles images (PNG, JPEG, GIF, WebP), PDFs, and text files (TXT, CSV, Markdown, JSON).',
      });
    }
    const sessionId = req.body.session_id || null;
    if (sessionId) {
      const own = await sessionAccess(sessionId, req);
      if (!own) return res.status(404).json({ error: 'Session not found' });
      const existing = await query(
        `SELECT COUNT(*)::int n, COALESCE(SUM(size_bytes),0)::int total
           FROM ai_attachments WHERE company_id=$1 AND session_id=$2`,
        [req.companyId, sessionId]
      );
      const { n, total } = existing.rows[0];
      if (n >= MAX_SESSION_ATTACH) {
        return res.status(409).json({ error: `A conversation can hold ${MAX_SESSION_ATTACH} files. Start a new chat for more.` });
      }
      if (total + f.size > MAX_TOTAL_BYTES) {
        return res.status(409).json({ error: `That would put this conversation over ${mb(MAX_TOTAL_BYTES)} of attachments.` });
      }
    }
    const r = await query(
      `INSERT INTO ai_attachments (company_id, session_id, user_id, filename, media_type, kind, size_bytes, bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, filename, media_type, kind, size_bytes, created_at`,
      [req.companyId, sessionId, req.userId || null,
       f.originalname || 'file', f.mimetype, kind, f.size, f.buffer]
    );
    res.json({ attachment: r.rows[0] });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Files are limited to ${mb(MAX_ATTACH_BYTES)}.` });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/square/attachments/:id — serve the bytes back for preview
router.get('/attachments/:id', async (req, res) => {
  try {
    const r = await query(
      `SELECT filename, media_type, bytes FROM ai_attachments WHERE id=$1 AND company_id=$2`,
      [req.params.id, req.companyId]
    );
    const a = r.rows[0];
    if (!a) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', a.media_type);
    res.setHeader('Content-Disposition', `inline; filename="${a.filename.replace(/"/g, '')}"`);
    res.send(a.bytes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/square/attachments/:id
router.delete('/attachments/:id', async (req, res) => {
  try {
    await query(`DELETE FROM ai_attachments WHERE id=$1 AND company_id=$2`, [req.params.id, req.companyId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Turn stored attachments into content blocks for the user turn.
 *
 * Text files are inlined as text rather than sent as documents: they are small,
 * and a labelled block reads better in the transcript than an opaque document.
 * The last block carries cache_control so a follow-up question about the same
 * invoice does not pay full price to re-send it.
 */
export function attachmentBlocks(rows) {
  const blocks = [];
  for (const a of rows) {
    const b64 = a.bytes.toString('base64');
    if (a.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: b64 } });
    } else if (a.kind === 'document') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: a.media_type, data: b64 },
                    title: a.filename, citations: { enabled: true } });
    } else {
      blocks.push({ type: 'text', text: `--- Attached file: ${a.filename} ---\n${a.bytes.toString('utf8')}` });
    }
  }
  if (blocks.length) blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  return blocks;
}

router.post('/ask', async (req, res) => {
  const { question, history = [], session_id = null, model: requestedModel = null,
          attachment_ids = [] } = req.body;
  // A file on its own is a question -- "what is this?" -- so an empty prompt is
  // only an error when nothing was attached either.
  if (!question?.trim() && !attachment_ids.length) {
    return res.status(400).json({ error: 'Question is required' });
  }

  // If a session was supplied, verify access and use its stored history.
  let session = null;
  if (session_id) {
    session = await sessionAccess(session_id, req);
    if (!session) return res.status(404).json({ error: 'Session not found' });
  }

  // Read API key from DB (company_integrations), fall back to env var
  let apiKey = process.env.ANTHROPIC_API_KEY;
  try {
    const r = await query(
      `SELECT anthropic_api_key FROM company_integrations WHERE company_id = $1`,
      [req.companyId]
    );
    apiKey = r.rows[0]?.anthropic_api_key?.trim() || apiKey;
  } catch { /* ignore — table may not have column yet */ }
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured — add it in Settings → Integrations' });

  // Role-gated model selection: use the requested model only if the role allows
  // it; otherwise fall back to Sonnet (the default for every session).
  const allowed = allowedModels(req.role);
  const kindredAiModel = allowed.includes(requestedModel) ? requestedModel : DEFAULT_AI_MODEL;
  const ai = new Anthropic({ apiKey });

  // Let the client cancel a running query: abort the Anthropic call on disconnect.
  const abort = new AbortController();
  let clientClosed = false;
  req.on('close', () => { clientClosed = true; abort.abort(); });

  const [facts, lessons] = await Promise.all([buildFactsBlock(), buildLessonsBlock()]);

  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Boise' });
  const dateBlock = `\nToday's date: ${todayStr}. Use this as the basis for all relative date references ("this month", "last month", "this year", "last week", etc.).\n`;

  // ── Prompt caching ─────────────────────────────────────────────────────────
  // The static schema context (~3k tokens) is marked as cacheable.
  // Anthropic caches it for 5 min — subsequent calls within the window pay 1/10th
  // the input token cost for that block.  Facts/lessons are dynamic so they are
  // appended as a second uncached block (including today's date — changes daily).
  // The hand-written context carries the business semantics -- which source is
  // authoritative for what, the canonical views, the gotchas. The generated
  // index carries the facts, so a table added tomorrow is visible without
  // anyone editing this file. Both are static within a session, so they share
  // the cache breakpoint.
  const systemBlocks = [
    {
      type: 'text',
      text: SQUARE_SCHEMA_CONTEXT + (await schemaIndex()),
      cache_control: { type: 'ephemeral' },
    },
  ];
  systemBlocks.push({ type: 'text', text: dateBlock + (facts || '') + (lessons || '') });

  // Regular employees: restrict employee data + old sales at the prompt level
  // (a hard SQL guard backs this up).
  if (req.role !== 'owner' && req.role !== 'manager') {
    systemBlocks.push({ type: 'text', text:
      '\n=== ACCESS RESTRICTIONS FOR THIS USER ===\n' +
      'This user is a regular employee. You MUST NOT return any employee wage, salary, ' +
      'hours, tips, or timeclock data for anyone (do not query team_square.shift, ' +
      'scheduled_shift, shift_break, team_member_job_assignment, or any wage/pay column). ' +
      'You may only report sales from the LAST 7 DAYS — politely refuse older sales ranges. ' +
      'If asked for restricted data, decline and explain the access limit.\n' });
  }

  // Prefer stored session history (persistent memory); fall back to client history.
  let priorHistory = history;
  if (session) {
    const past = await query(
      `SELECT role, content FROM ai_messages
       WHERE session_id = $1 AND content IS NOT NULL AND content <> ''
       ORDER BY created_at DESC LIMIT 12`,
      [session_id]
    );
    priorHistory = past.rows.reverse();
  }
  // Files for this turn. Everything already attached to the session comes along,
  // not just what was picked this minute: a follow-up question about the same
  // invoice has to see the invoice, and the person should not have to re-upload
  // it to ask a second question.
  let attachments = [];
  if (session_id || attachment_ids.length) {
    const r = await query(
      `SELECT id, filename, media_type, kind, size_bytes, bytes
         FROM ai_attachments
        WHERE company_id = $1
          AND (($2::uuid IS NOT NULL AND session_id = $2) OR id = ANY($3::uuid[]))
        ORDER BY created_at
        LIMIT $4`,
      [req.companyId, session_id, attachment_ids, MAX_SESSION_ATTACH]
    );
    attachments = r.rows;
  }

  const userContent = attachments.length
    ? [...attachmentBlocks(attachments),
       { type: 'text', text: question?.trim() || 'Have a look at the attached file(s).' }]
    : question;

  const messages = [
    ...priorHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  // Agentic tool-use loop
  const accumulated = { text: '', sql: null, rows: null, fields: null, facts_saved: [] };
  let usageIn = 0, usageOut = 0;
  let synthNudged = false; // ensures a data question never ends without a written answer

  try {
    while (true) {
      const response = await ai.messages.create({
        model: kindredAiModel,
        max_tokens: 4096,
        system: systemBlocks,
        // Write tools exist for this session only if the VERIFIED role allows
        // it. Gating inside the handler alone would still show an employee a
        // tool they cannot use, and invite the model to promise an edit it
        // cannot make.
        tools: [...SQUARE_TOOLS, ...WEB_TOOLS, ...MENU_READ_TOOLS,
                ...(req.role === 'owner' || req.role === 'manager' ? MENU_WRITE_TOOLS : [])],
        messages,
      }, { signal: abort.signal });
      usageIn  += response.usage?.input_tokens  || 0;
      usageOut += response.usage?.output_tokens || 0;

      // Collect any text from this turn.
      //
      // Join every text block rather than taking the first. A turn that used
      // web search comes back as a dozen or more text blocks -- the model
      // narrates ("I'll search for..."), searches, then writes the answer
      // across several blocks because citations split it. Taking find() gave
      // the narration and threw the answer away.
      const turnText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (turnText) accumulated.text = turnText;

      if (response.stop_reason === 'end_turn') {
        // Never let a data question end with just a result table / no prose.
        // Nudge the model once to synthesize a proper written answer.
        if (!accumulated.text && accumulated.rows && !synthNudged) {
          synthNudged = true;
          messages.push({ role: 'assistant', content: [{ type: 'text', text: turnText || 'Results gathered.' }] });
          messages.push({ role: 'user', content:
            'Now write the complete, well-formatted answer for the user based on the query results above. ' +
            'Answer every part of the original question, include the comparison/benchmark/recommendation that was asked for, ' +
            'and never reply with just a number or a bare table.' });
          continue;
        }
        break;
      }

      if (response.stop_reason === 'tool_use') {
        // Add assistant's response (with tool_use blocks) to messages
        messages.push({ role: 'assistant', content: response.content });

        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          if (block.name === 'run_sql') {
            const policy = aiSqlPolicy(block.input.sql, req.role);
            if (!policy.allowed) {
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Access denied: ${policy.reason}` });
              continue;
            }
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

          } else if (block.name === 'describe_tables') {
            try {
              const ddl = await describeTables(block.input.tables || []);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: ddl });
            } catch (err) {
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Schema lookup failed: ${err.message}` });
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

          } else if (block.name === 'get_live_square_sales') {
            try {
              const live = await fetchLiveSquareSales(req.companyId, block.input.start_date, block.input.end_date, block.input.location_name || null);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content:
                `Live Square sales ${block.input.start_date}..${block.input.end_date}${block.input.location_name ? ' (' + block.input.location_name + ')' : ''}: $${live.total.toFixed(2)} across ${live.order_count} orders (locations: ${live.locations.join(', ') || 'all'}).` });
            } catch (err) {
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Live Square lookup failed: ${err.message}` });
            }

          } else if (block.name === 'list_menu_items') {
            try {
              const out = await aiListMenuItems(req.companyId, block.input.menu_key);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
            } catch (err) {
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Menu lookup failed: ${err.message}` });
            }

          } else if (block.name === 'update_menu_item') {
            try {
              const out = await aiUpdateMenuItem(req, block.input);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
            } catch (err) {
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Menu update failed: ${err.message}` });
            }

          } else if (block.name === 'flag_sales_discrepancy') {
            try {
              const { db_total, live_total, start_date, end_date, location_name } = block.input;
              const higher = Math.max(Math.abs(db_total), Math.abs(live_total)) || 1;
              const pct = Math.abs(db_total - live_total) / higher * 100;
              if (pct < 2) {
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Difference is only ${pct.toFixed(1)}% — under the 2% threshold, no alert sent.` });
              } else {
                const owners = await query(`SELECT id FROM users WHERE company_id = $1 AND role = 'owner'`, [req.companyId]);
                const appUrl = process.env.APP_URL || 'https://team.kindredvineyards.com';
                const params = new URLSearchParams({ start: start_date, end: end_date });
                if (location_name) params.set('loc', location_name);
                const link = `${appUrl}/square/reconcile?${params.toString()}`;
                const msg = `⚠️ Square sales mismatch ${start_date}..${end_date}${location_name ? ' (' + location_name + ')' : ''}: DB $${Number(db_total).toFixed(2)} vs live Square $${Number(live_total).toFixed(2)} (${pct.toFixed(1)}% off). See what's off: ${link}`;
                await sendSmsToUsers(req.companyId, owners.rows.map((o) => o.id), msg, req.userId);
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Discrepancy is ${pct.toFixed(1)}% — owner alerted by SMS with a reconciliation link.` });
              }
            } catch (err) {
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Failed to flag discrepancy: ${err.message}` });
            }
          }
        }

        messages.push({ role: 'user', content: toolResults });
      } else if (response.stop_reason === 'pause_turn') {
        // A server-side tool (web search / fetch) hit its per-turn iteration
        // cap. Echo the assistant turn back and the server resumes where it
        // left off -- adding a "continue" user message would corrupt it.
        // Without this branch the catch-all below ended the answer mid-search,
        // with no error and a half-written reply.
        messages.push({ role: 'assistant', content: response.content });
        continue;

      } else {
        break; // unexpected stop reason
      }
    }
  } catch (err) {
    if (clientClosed || err?.name === 'AbortError') return; // client cancelled
    console.error('[square/ask] AI error:', err.message);
    return res.status(500).json({ error: 'AI request failed', details: err.message });
  }

  // Persist the exchange to the session (auto-title from the first question).
  if (session && !clientClosed) {
    try {
      // The transcript records WHICH files were in play, so a conversation read
      // back later still makes sense. The bytes are not re-stored here -- they
      // live once in ai_attachments and are re-attached from there each turn.
      const askedWith = attachments.length
        ? `${question?.trim() || 'Have a look at the attached file(s).'}\n\n[attached: `
          + attachments.map((a) => a.filename).join(', ') + ']'
        : question;
      await query(`INSERT INTO ai_messages (session_id, role, content) VALUES ($1,'user',$2)`, [session_id, askedWith]);
      await query(
        `INSERT INTO ai_messages (session_id, role, content, sql, rows, fields) VALUES ($1,'assistant',$2,$3,$4,$5)`,
        [session_id, accumulated.text || null, accumulated.sql || null,
         accumulated.rows ? JSON.stringify(accumulated.rows) : null,
         accumulated.fields ? JSON.stringify(accumulated.fields) : null]
      );
      await query(
        `UPDATE ai_sessions SET title = COALESCE(title, $1), updated_at = NOW() WHERE id = $2`,
        [question.trim().slice(0, 60), session_id]
      );
    } catch (e) { console.error('[square/ask] persist error:', e.message); }
  }

  // Usage + estimated cost logging (every answered question, session or not).
  if (!clientClosed) {
    try {
      await query(
        `INSERT INTO ai_usage_log (company_id, user_id, model, question, input_tokens, output_tokens, cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.companyId, req.userId, kindredAiModel, question, usageIn, usageOut, estimateCost(kindredAiModel, usageIn, usageOut)]
      );
    } catch (e) { console.error('[square/ask] usage log error:', e.message); }
  }

  if (clientClosed) return;
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

// GET /api/square/reconcile?start=&end=&loc= — day-by-day DB vs live Square sales
router.get('/reconcile', async (req, res) => {
  const { start, end, loc } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end (YYYY-MM-DD) are required' });
  try {
    const live = await fetchLiveSquareSales(req.companyId, start, end, loc || null);
    const dbRes = await query(
      `SELECT to_char(DATE(o.created_at AT TIME ZONE 'America/Boise'), 'YYYY-MM-DD') AS day,
              ROUND(SUM(o.total_money_amount)/100.0, 2) AS total, COUNT(*) AS count
       FROM team_square."order" o
       LEFT JOIN team_square."location" l ON l.id = o.location_id
       WHERE o.state = 'COMPLETED'
         AND o.created_at >= ($1 || 'T00:00:00')::timestamptz
         AND o.created_at <  (($2)::date + 1)::timestamptz
         AND ($3::text IS NULL OR l.name ILIKE '%' || $3 || '%')
       GROUP BY 1 ORDER BY 1`,
      [start, end, loc || null]
    );
    const dbByDay = {};
    for (const r of dbRes.rows) dbByDay[r.day] = { total: Number(r.total), count: Number(r.count) };
    const days = Array.from(new Set([...Object.keys(dbByDay), ...Object.keys(live.byDay)])).sort();
    const rows = days.map((d) => {
      const db_total = dbByDay[d]?.total || 0;
      const live_total = live.byDay[d]?.total || 0;
      return { date: d, db_total, live_total, diff: Math.round((db_total - live_total) * 100) / 100 };
    });
    const dbTotal = rows.reduce((s, r) => s + r.db_total, 0);
    const liveTotal = rows.reduce((s, r) => s + r.live_total, 0);
    res.json({
      start, end, location: loc || null, rows,
      db_total: Math.round(dbTotal * 100) / 100,
      live_total: Math.round(liveTotal * 100) / 100,
      diff: Math.round((dbTotal - liveTotal) * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/square/usage-report?days=30 — per-user Kindred AI usage + estimated cost
router.get('/usage-report', async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  try {
    const byUser = await query(
      `SELECT COALESCE(u.display_name, 'Unknown') AS user_name,
              COUNT(*)::int AS questions,
              COALESCE(SUM(l.input_tokens), 0)::bigint  AS input_tokens,
              COALESCE(SUM(l.output_tokens), 0)::bigint AS output_tokens,
              ROUND(COALESCE(SUM(l.cost_usd), 0), 2) AS cost
       FROM ai_usage_log l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.company_id = $1 AND l.created_at >= NOW() - ($2 || ' days')::interval
       GROUP BY 1 ORDER BY cost DESC NULLS LAST`,
      [req.companyId, days]
    );
    const totals = await query(
      `SELECT COUNT(*)::int AS questions, ROUND(COALESCE(SUM(cost_usd), 0), 2) AS cost
       FROM ai_usage_log WHERE company_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
      [req.companyId, days]
    );
    res.json({
      days,
      by_user: byUser.rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cost: Number(r.cost) })),
      total_questions: totals.rows[0].questions,
      total_cost: Number(totals.rows[0].cost),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── KINDRED AI SESSIONS (private by default, shareable via invite link) ───────

// Returns the session row if the requester owns it or it's shared with them.
async function sessionAccess(sessionId, req) {
  const r = await query(
    `SELECT s.*, (s.user_id = $2) AS is_owner
     FROM ai_sessions s
     WHERE s.id = $1 AND s.company_id = $3
       AND (s.user_id = $2 OR EXISTS (
         SELECT 1 FROM ai_session_shares sh WHERE sh.session_id = s.id AND sh.user_id = $2))`,
    [sessionId, req.userId, req.companyId]
  );
  return r.rows[0] || null;
}

// GET /api/square/sessions — my sessions + ones shared with me
// Paged, newest first. The list only ever grows -- it was returning every
// session a person had ever opened, which made the sidebar taller than the
// screen and meant the payload grew forever.
router.get('/sessions', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  // Same WHERE for the page and the count, so the pager can't disagree with
  // the list about how many there are.
  const where = `
     FROM ai_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.company_id = $2
       AND (s.user_id = $1 OR EXISTS (
         SELECT 1 FROM ai_session_shares sh WHERE sh.session_id = s.id AND sh.user_id = $1))`;

  const [r, countRes] = await Promise.all([
    query(
      `SELECT s.id, s.title, s.updated_at, (s.user_id = $1) AS is_owner, u.display_name AS owner_name
       ${where}
       ORDER BY s.updated_at DESC
       LIMIT $3 OFFSET $4`,
      [req.userId, req.companyId, limit, offset]
    ),
    query(`SELECT COUNT(*)::int AS total ${where}`, [req.userId, req.companyId]),
  ]);

  res.json({ sessions: r.rows, total: countRes.rows[0].total, limit, offset });
});

// POST /api/square/sessions — new (empty) session
router.post('/sessions', async (req, res) => {
  const r = await query(
    `INSERT INTO ai_sessions (company_id, user_id, title) VALUES ($1,$2,$3)
     RETURNING id, title, updated_at`,
    [req.companyId, req.userId, req.body.title || null]
  );
  res.status(201).json({ session: { ...r.rows[0], is_owner: true } });
});

// GET /api/square/sessions/:id — session + its messages
router.get('/sessions/:id', async (req, res) => {
  const s = await sessionAccess(req.params.id, req);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const msgs = await query(
    `SELECT role, content, sql, rows, fields FROM ai_messages WHERE session_id = $1 ORDER BY created_at`,
    [req.params.id]
  );
  res.json({
    session: { id: s.id, title: s.title, is_owner: s.is_owner, share_token: s.is_owner ? s.share_token : null },
    messages: msgs.rows,
  });
});

// PATCH /api/square/sessions/:id — rename (owner only)
router.patch('/sessions/:id', async (req, res) => {
  const r = await query(
    `UPDATE ai_sessions SET title = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3 AND company_id = $4 RETURNING id`,
    [req.body.title || null, req.params.id, req.userId, req.companyId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// DELETE /api/square/sessions/:id — owner only
router.delete('/sessions/:id', async (req, res) => {
  const r = await query(
    `DELETE FROM ai_sessions WHERE id = $1 AND user_id = $2 AND company_id = $3 RETURNING id`,
    [req.params.id, req.userId, req.companyId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// POST /api/square/sessions/:id/share — generate/return the invite token (owner only)
router.post('/sessions/:id/share', async (req, res) => {
  const own = await query(
    `SELECT share_token FROM ai_sessions WHERE id = $1 AND user_id = $2 AND company_id = $3`,
    [req.params.id, req.userId, req.companyId]
  );
  if (!own.rows.length) return res.status(404).json({ error: 'Not found' });
  let shareToken = own.rows[0].share_token;
  if (!shareToken) {
    shareToken = randomUUID().replace(/-/g, '');
    await query(`UPDATE ai_sessions SET share_token = $1 WHERE id = $2`, [shareToken, req.params.id]);
  }
  res.json({ share_token: shareToken });
});

// POST /api/square/sessions/join/:token — accept an invite link (adds me to shares)
router.post('/sessions/join/:token', async (req, res) => {
  const s = await query(
    `SELECT id, user_id FROM ai_sessions WHERE share_token = $1 AND company_id = $2`,
    [req.params.token, req.companyId]
  );
  if (!s.rows.length) return res.status(404).json({ error: 'Invalid or expired invite link' });
  const sess = s.rows[0];
  if (sess.user_id !== req.userId) {
    await query(
      `INSERT INTO ai_session_shares (session_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [sess.id, req.userId]
    );
  }
  res.json({ session_id: sess.id });
});

export { router as squareRouter };
