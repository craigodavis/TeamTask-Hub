/**
 * Idaho ABC monthly wine report — line computation.
 *
 * Every quantity is US gallons. The full method, the data hazards behind each
 * query, and the residual rule are documented in docs/ABC_FILING.md — read that
 * before changing anything here.
 *
 * The one rule that matters: Production and Waste both come from real data.
 * The residual is a CHECK, not an input. A plug silently absorbs every error in
 * every other line and reports it to the state as spoilage.
 */

import { query } from '../db.js';

const TZ = 'America/Denver';
const ML_PER_GAL = 3785.411784;
const GAL_PER_BOTTLE = 750 / ML_PER_GAL;   // 0.19812903
const BOTTLES_PER_CASE = 12;

/** Residual beyond this share of beginning inventory blocks the filing. */
export const RESIDUAL_TOLERANCE = 0.02;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Sales / tastings / returns over an arbitrary window ──────────────────────
// Shared by the month itself and by the "back out" window between month-end and
// the physical count, so both use identical logic.
async function volumesBetween(companyId, startIso, endIso) {
  // Commerce7: quantity is ALREADY signed — Refund and Exchange rows carry
  // negative quantities. Negating them double-counts; filtering out Exchange
  // drops real returns (1,147 of 1,149 exchange lines are negative).
  const c7 = await query(
    `SELECT
       COALESCE(SUM(oi.quantity * oi.volume_in_ml) FILTER (WHERE oi.quantity > 0), 0) / 3785.411784 AS sales_gal,
       COALESCE(SUM(-oi.quantity * oi.volume_in_ml) FILTER (WHERE oi.quantity < 0), 0) / 3785.411784 AS return_gal
     FROM commerce7.order_items oi
     JOIN commerce7.orders o ON o.id = oi.order_id
    WHERE oi.item_type = 'Wine'
      AND oi.volume_in_ml IS NOT NULL
      AND o.order_paid_date >= $2 AND o.order_paid_date < $3
      AND o.company_id = $1`,
    [companyId, startIso, endIso]
  );

  // Square: bottles + glasses + paid tastings are sales; zero-priced tastings are
  // the only tracked waste. Reporting-category joins go through catalog_item —
  // ITEM_VARIATION objects must be synced or line items orphan (see §3).
  const sq = await query(
    `SELECT
       COALESCE(SUM(li.quantity) FILTER (WHERE cc.name = '750ml Bottle'), 0) * 750 / 3785.411784 AS bottle_gal,
       COALESCE(SUM(li.quantity) FILTER (WHERE cc.name = 'Wine Glass (5oz)'
                                           AND li.name <> 'WINE CLUB TASTING'), 0) * 5 / 128.0 AS glass_gal,
       COALESCE(SUM(li.quantity) FILTER (WHERE (cc.name ILIKE '%Tasting%' OR li.name = 'WINE CLUB TASTING')
                                           AND li.total_amount > 0), 0) * 8 / 128.0 AS paid_tasting_gal,
       COALESCE(SUM(li.quantity) FILTER (WHERE (cc.name ILIKE '%Tasting%' OR li.name = 'WINE CLUB TASTING')
                                           AND li.total_amount = 0), 0) * 8 / 128.0 AS free_tasting_gal
     FROM team_square.order_line_item li
     JOIN team_square."order" o ON o.id = li.order_id
     JOIN team_square.catalog_item_variation civ ON civ.id = li.catalog_object_id
     JOIN team_square.catalog_item ci ON ci.id = civ.item_id
     LEFT JOIN team_square.catalog_category cc ON cc.id = ci.reporting_category_id
    WHERE o.state = 'COMPLETED'
      AND o.created_at >= $1 AND o.created_at < $2`,
    [startIso, endIso]
  );

  const a = c7.rows[0], b = sq.rows[0];
  const salesConsumers = Number(a.sales_gal) + Number(b.bottle_gal)
                       + Number(b.glass_gal) + Number(b.paid_tasting_gal);

  return {
    salesConsumers: round2(salesConsumers),
    freeTastings:   round2(b.free_tasting_gal),
    returns:        round2(a.return_gal),
    breakdown: {
      commerce7Bottles: round2(a.sales_gal),
      squareBottles:    round2(b.bottle_gal),
      wineGlasses:      round2(b.glass_gal),
      paidTastings:     round2(b.paid_tasting_gal),
    },
  };
}

// ── Production: vintly bottling runs dated inside the month ──────────────────
async function productionFor(companyId, startIso, endIso) {
  const r = await query(
    `SELECT name, vintage, bottling_date::date AS bottling_date, starting_case_qty
       FROM vintly.projects
      WHERE company_id = $1
        AND deleted_at IS NULL
        AND bottling_date >= $2::timestamptz AND bottling_date < $3::timestamptz`,
    [companyId, startIso, endIso]
  );

  // A bottling run with no case count contributes ZERO gallons silently. That is
  // exactly the class of error the residual would absorb — surface it instead.
  const missingCaseQty = r.rows
    .filter((p) => p.starting_case_qty === null || p.starting_case_qty === undefined)
    .map((p) => `${p.name} (${p.bottling_date.toISOString().slice(0, 10)})`);

  const runs = r.rows.map((p) => ({
    name:    p.name,
    vintage: p.vintage,
    date:    p.bottling_date.toISOString().slice(0, 10),
    cases:   p.starting_case_qty === null ? null : Number(p.starting_case_qty),
    gallons: p.starting_case_qty === null
      ? null
      : round2(Number(p.starting_case_qty) * BOTTLES_PER_CASE * GAL_PER_BOTTLE),
  }));

  return {
    gallons: round2(runs.reduce((s, x) => s + (x.gallons || 0), 0)),
    runs,
    missingCaseQty,
  };
}

// ── Physical count ───────────────────────────────────────────────────────────
// product_inventory is a LIVE snapshot, overwritten as the crew counts. It is the
// count for whatever period it was taken in — which is why the filing must be
// prepared before the next count begins, and why we store the result in
// abc_filings rather than recomputing history from this table.
async function physicalCount(companyId) {
  const r = await query(
    `SELECT COALESCE(SUM(total_bottles), 0)::int AS bottles,
            COUNT(*)::int                        AS lines,
            MIN(last_counted_at)                 AS first_counted_at,
            MAX(last_counted_at)                 AS last_counted_at
       FROM product.product_inventory
      WHERE company_id = $1 AND total_bottles IS NOT NULL`,
    [companyId]
  );
  const row = r.rows[0];
  return {
    bottles:        Number(row.bottles),
    lines:          Number(row.lines),
    gallons:        round2(Number(row.bottles) * GAL_PER_BOTTLE),
    firstCountedAt: row.first_counted_at,
    lastCountedAt:  row.last_counted_at,
  };
}

/**
 * Compute the ABC filing for a month.
 * @param {string} companyId
 * @param {string} month  'YYYY-MM' — the period being reported
 */
export async function computeFiling(companyId, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month must be YYYY-MM, got "${month}"`);

  const monthStart = `${month}-01`;
  // Cast to ::timestamp before AT TIME ZONE — the timestamptz overload silently
  // shifts the window to 18:00 the prior day. That bug cost us a wrong filing once.
  const bounds = await query(
    `SELECT ($1::date)::timestamp AT TIME ZONE $2                        AS m_start,
            (($1::date) + interval '1 month')::timestamp AT TIME ZONE $2 AS m_end,
            (($1::date) - interval '1 month')::date                      AS prev_month`,
    [monthStart, TZ]
  );
  const { m_start, m_end, prev_month } = bounds.rows[0];

  // Beginning inventory comes from what was FILED last month — never recomputed.
  // The state's copy is the authority; a recomputed beginning silently drifts.
  const prior = await query(
    `SELECT ending_inventory, status FROM abc_filings
      WHERE company_id = $1 AND period_month = $2`,
    [companyId, prev_month]
  );
  const beginning = prior.rows.length ? Number(prior.rows[0].ending_inventory) : null;

  const [inMonth, production, count] = await Promise.all([
    volumesBetween(companyId, m_start, m_end),
    productionFor(companyId, m_start, m_end),
    physicalCount(companyId),
  ]);

  // The crew counts a few days into the following month, so the raw count is not
  // the month-end position. Back out everything that moved between month-end and
  // the moment of the count. (June 2026: count of 1,984.86 on Jul 3-4 + 24.94
  // sales + 1.38 tastings - 6.54 returns = 2,004.63 month-end. Ties exactly.)
  let postMonth = { salesConsumers: 0, freeTastings: 0, returns: 0, breakdown: {} };
  if (count.lastCountedAt && new Date(count.lastCountedAt) > new Date(m_end)) {
    postMonth = await volumesBetween(companyId, m_end, count.lastCountedAt.toISOString());
  }
  const countedAtMonthEnd = round2(
    count.gallons + postMonth.salesConsumers + postMonth.freeTastings - postMonth.returns
  );

  // Expected position from the books alone.
  const expectedEnding = beginning === null ? null : round2(
    beginning + production.gallons - inMonth.salesConsumers - inMonth.freeTastings + inMonth.returns
  );

  // Positive residual = wine that left without being recorded (breakage, spillage,
  // over-pours, miscount). This is a CHECK. See docs/ABC_FILING.md §4.
  const residual = expectedEnding === null ? null : round2(expectedEnding - countedAtMonthEnd);

  // ABC combines spoilage, samples and tastings on one line.
  const spoilageSamples = residual === null ? null : round2(inMonth.freeTastings + residual);

  const tolerance = beginning === null ? null : round2(Math.abs(beginning) * RESIDUAL_TOLERANCE);

  // ── Preflight ──────────────────────────────────────────────────────────────
  const checks = [];
  checks.push({
    id: 'prior_filing',
    ok: beginning !== null,
    label: 'Prior month filed',
    detail: beginning === null
      ? `No filing on record for ${prev_month.toISOString().slice(0, 7)} — Beginning Inventory cannot be established.`
      : `Beginning Inventory ${beginning.toFixed(2)} gal, carried from ${prev_month.toISOString().slice(0, 7)}.`,
  });
  checks.push({
    id: 'physical_count',
    ok: count.bottles > 0 && !!count.lastCountedAt,
    label: 'Physical count exists',
    detail: count.lastCountedAt
      ? `${count.bottles.toLocaleString()} bottles across ${count.lines} lines, counted ${count.lastCountedAt.toISOString().slice(0, 10)}.`
      : 'No physical inventory count on record. Do not file.',
  });
  checks.push({
    id: 'count_is_current',
    ok: !!count.lastCountedAt && new Date(count.lastCountedAt) >= new Date(m_end),
    label: 'Count covers this period',
    detail: count.lastCountedAt && new Date(count.lastCountedAt) >= new Date(m_end)
      ? `Counted after ${month} closed.`
      : `Count predates the end of ${month} — it is a stale count from an earlier period.`,
  });
  checks.push({
    id: 'production_complete',
    ok: production.missingCaseQty.length === 0,
    label: 'Bottling runs have case counts',
    detail: production.missingCaseQty.length
      ? `Missing case quantity, would report as zero production: ${production.missingCaseQty.join('; ')}`
      : `${production.runs.length} bottling run(s), ${production.gallons.toFixed(2)} gal.`,
  });
  checks.push({
    id: 'residual_within_tolerance',
    ok: residual !== null && tolerance !== null && Math.abs(residual) <= tolerance,
    label: 'Residual within tolerance',
    detail: residual === null
      ? 'Cannot evaluate without a beginning inventory.'
      : `Unexplained ${residual >= 0 ? 'loss' : 'overage'} of ${Math.abs(residual).toFixed(2)} gal `
        + `(tolerance ±${tolerance.toFixed(2)}, ${(RESIDUAL_TOLERANCE * 100).toFixed(0)}% of beginning).`,
  });

  const blocking = checks.filter((c) => !c.ok);

  return {
    month,
    companyId,
    readyToFile: blocking.length === 0,
    blocking: blocking.map((c) => c.label),
    checks,

    // The ABC form, line for line.
    lines: {
      beginningInventory: beginning,
      purchases:          0,
      production:         production.gallons,
      spoilageSamples,
      salesWholesale:     0,
      salesRetail:        0,
      salesOther:         0,
      salesConsumers:     inMonth.salesConsumers,
      returnedProduct:    inMonth.returns,
      endingInventory:    countedAtMonthEnd,
    },

    // Everything behind the numbers, for the review page.
    detail: {
      freeTastings:     inMonth.freeTastings,
      residual,
      residualTolerance: tolerance,
      expectedEnding,
      countedGallons:   count.gallons,
      countedBottles:   count.bottles,
      countedLines:     count.lines,
      countedFrom:      count.firstCountedAt,
      countedAt:        count.lastCountedAt,
      postCountBackout: postMonth,
      salesBreakdown:   inMonth.breakdown,
      productionRuns:   production.runs,
    },
  };
}

/** Persist a computed filing as a draft awaiting Craig's review. */
export async function saveDraft(companyId, filing) {
  const l = filing.lines, d = filing.detail;
  const r = await query(
    `INSERT INTO abc_filings
       (company_id, period_month, beginning_inventory, purchases, production,
        spoilage_samples, free_tastings, residual, sales_consumers, returned_product,
        ending_inventory, counted_bottles, counted_at, status, prepared_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft',NOW())
     ON CONFLICT (company_id, period_month) DO UPDATE SET
       beginning_inventory = EXCLUDED.beginning_inventory,
       production          = EXCLUDED.production,
       spoilage_samples    = EXCLUDED.spoilage_samples,
       free_tastings       = EXCLUDED.free_tastings,
       residual            = EXCLUDED.residual,
       sales_consumers     = EXCLUDED.sales_consumers,
       returned_product    = EXCLUDED.returned_product,
       ending_inventory    = EXCLUDED.ending_inventory,
       counted_bottles     = EXCLUDED.counted_bottles,
       counted_at          = EXCLUDED.counted_at,
       prepared_at         = NOW(),
       updated_at          = NOW()
     WHERE abc_filings.status <> 'filed'
     RETURNING *`,
    [companyId, `${filing.month}-01`, l.beginningInventory, l.purchases, l.production,
     l.spoilageSamples, d.freeTastings, d.residual, l.salesConsumers, l.returnedProduct,
     l.endingInventory, d.countedBottles, d.countedAt]
  );
  // No row back means the month is already filed — never silently overwrite it.
  return r.rows[0] || null;
}
