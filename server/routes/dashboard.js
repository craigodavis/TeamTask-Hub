/**
 * Manager/owner dashboard — /api/dashboard
 *
 * Every figure is paired with the same window one year earlier, because a
 * number on its own ("$4,200 this week") tells you nothing about whether that
 * is good. Where last year genuinely isn't available the response says so with
 * a null rather than a zero: a zero renders as a 100% collapse and is worse
 * than an honest gap.
 */

import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';
import { unfulfilledAsOf } from '../lib/abcFiling.js';

const router = express.Router();
const cid = (req) => req.companyId;

const CASE_SIZE = 12;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Same calendar window, one year back. */
function lastYear(d) {
  const x = new Date(d);
  x.setUTCFullYear(x.getUTCFullYear() - 1);
  return x;
}

/**
 * Percentage change, or null when last year is missing or zero.
 * Dividing by a zero baseline yields Infinity, which renders as nonsense.
 */
function pctChange(now, then) {
  if (then === null || then === undefined || Number(then) === 0) return null;
  return Math.round(((Number(now) - Number(then)) / Number(then)) * 1000) / 10;
}

async function scalar(sql, params, field = 'v') {
  const r = await query(sql, params);
  const v = r.rows[0]?.[field];
  return v === null || v === undefined ? 0 : Number(v);
}

/**
 * Square net sales over a window of whole local days.
 *
 * Uses v_square_net_sales_daily, the same view that feeds the labor
 * percentage: gross less discounts, excluding tax, gift cards, tickets and
 * deposits. Summing order_line_item.total_amount instead — the obvious thing —
 * includes tax and those excluded categories, and read about $1,000 a week
 * high against the figure Square itself reports. Sharing the view keeps the
 * sales card and the labor denominator the same number, so labor % is visibly
 * labor over the sales shown beside it.
 *
 * Windowed on sales_date, which the view has already converted to
 * America/Denver, rather than on UTC timestamps that would slice days apart.
 */
async function squareNetSales(daysBack, yearsBack = 0) {
  return scalar(
    `SELECT COALESCE(SUM(net_sales), 0) AS v
       FROM team_square.v_square_net_sales_daily
      WHERE sales_date >= (CURRENT_DATE - $1::int) - ($2::int * INTERVAL '1 year')
        AND sales_date <  CURRENT_DATE          - ($2::int * INTERVAL '1 year')`,
    [daysBack, yearsBack]
  );
}

/** Commerce7 is a separate channel and deliberately not folded into the above. */
async function c7Sales(daysBack, yearsBack = 0) {
  return scalar(
    `SELECT COALESCE(SUM(subtotal), 0) AS v
       FROM commerce7.v_sales_daily
      WHERE sales_date >= (CURRENT_DATE - $1::int) - ($2::int * INTERVAL '1 year')
        AND sales_date <  CURRENT_DATE          - ($2::int * INTERVAL '1 year')`,
    [daysBack, yearsBack]
  );
}

// ── GET /api/dashboard ───────────────────────────────────────────────────────
router.get('/', requireManager, async (req, res) => {
  try {
    const companyId = cid(req);
    const now = new Date();
    const d7 = new Date(now); d7.setUTCDate(d7.getUTCDate() - 7);
    const d14 = new Date(now); d14.setUTCDate(d14.getUTCDate() - 14);
    const d30 = new Date(now); d30.setUTCDate(d30.getUTCDate() - 30);

    const [
      sales7, sales7Ly, c7_7, c7_7Ly,
      events7, events7Ly,
      labor14, labor14Ly,
      inv, unfulfilled,
    ] = await Promise.all([
      squareNetSales(7), squareNetSales(7, 1),
      c7Sales(7), c7Sales(7, 1),

      scalar(`SELECT COUNT(*)::int AS v FROM events
               WHERE company_id = $1 AND start_at >= $2 AND start_at < $3`,
        [companyId, d7, now]),
      scalar(`SELECT COUNT(*)::int AS v FROM events
               WHERE company_id = $1 AND start_at >= $2 AND start_at < $3`,
        [companyId, lastYear(d7), lastYear(now)]),

      // Weighted across the window, not an average of daily percentages: a
      // near-closed day with tiny sales would otherwise swing the fortnight.
      query(`SELECT COALESCE(SUM(labor_cost), 0) AS labor, COALESCE(SUM(net_sales), 0) AS sales
               FROM team_square.v_labor_pct_daily
              WHERE the_date >= CURRENT_DATE - 14 AND the_date < CURRENT_DATE`),
      query(`SELECT COALESCE(SUM(labor_cost), 0) AS labor, COALESCE(SUM(net_sales), 0) AS sales
               FROM team_square.v_labor_pct_daily
              WHERE the_date >= (CURRENT_DATE - 14) - INTERVAL '1 year'
                AND the_date <  CURRENT_DATE        - INTERVAL '1 year'`),

      query(`SELECT COALESCE(SUM(total_bottles), 0)::int AS total,
                    COALESCE(SUM(library_bottles), 0)::int AS library
               FROM product.product_inventory WHERE company_id = $1`, [companyId]),
      unfulfilledAsOf(companyId, now.toISOString()),
    ]);

    const laborPct = (r) => {
      const s = Number(r.rows[0]?.sales || 0);
      if (!s) return null;
      return Math.round((Number(r.rows[0]?.labor || 0) / s) * 1000) / 10;
    };

    const totalBottles = Number(inv.rows[0]?.total || 0);
    const heldBottles = unfulfilled.bottles || 0;
    // What is actually still sellable: on the floor, minus what is already
    // somebody else's. This is the number the inventory screens imply but
    // have never shown.
    const sellableBottles = totalBottles - heldBottles;

    // Inventory a year ago — the log only began 2026-07-03, so for now this is
    // honestly null rather than a misleading zero.
    const invLy = await query(
      `SELECT COALESCE(SUM(total_bottles), 0)::int AS v FROM (
         SELECT DISTINCT ON (product_id, location_id) total_bottles
           FROM product.product_inventory_log
          WHERE company_id = $1 AND counted_at <= $2
          ORDER BY product_id, location_id, counted_at DESC) t`,
      [companyId, lastYear(now)]
    );
    const invLyBottles = Number(invLy.rows[0]?.v || 0) || null;

    res.json({
      generatedAt: now.toISOString(),
      sales7: {
        value: round2(sales7), lastYear: sales7Ly ? round2(sales7Ly) : null,
        change: pctChange(sales7, sales7Ly),
        commerce7: round2(c7_7), commerce7LastYear: c7_7Ly ? round2(c7_7Ly) : null,
      },
      events7: { value: events7, lastYear: events7Ly, change: pctChange(events7, events7Ly) },
      labor14: {
        value: laborPct(labor14),
        lastYear: laborPct(labor14Ly),
        change: pctChange(laborPct(labor14), laborPct(labor14Ly)),
      },
      inventory: {
        totalBottles,
        totalCases: round2(totalBottles / CASE_SIZE),
        libraryBottles: Number(inv.rows[0]?.library || 0),
        heldBottles,
        heldCases: round2(heldBottles / CASE_SIZE),
        heldPct: totalBottles ? Math.round((heldBottles / totalBottles) * 1000) / 10 : null,
        sellableBottles,
        sellableCases: round2(sellableBottles / CASE_SIZE),
        heldByMethod: unfulfilled.byMethod,
        lastYearBottles: invLyBottles,
        change: pctChange(totalBottles, invLyBottles),
      },
      // Grocery spend is not wired up yet; declared so the card can render as
      // "coming" instead of the page pretending the metric does not exist.
      grocery30: { value: null, lastYear: null, change: null, available: false },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as dashboardRouter };
