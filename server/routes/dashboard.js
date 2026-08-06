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

// ── Sales: Square + Commerce7 over a window ──────────────────────────────────
async function salesBetween(companyId, from, to) {
  const sq = await scalar(
    `SELECT COALESCE(SUM(li.total_amount), 0) / 100.0 AS v
       FROM team_square.order_line_item li
       JOIN team_square."order" o ON o.id = li.order_id
      WHERE o.state = 'COMPLETED' AND o.created_at >= $1 AND o.created_at < $2`,
    [from, to]
  );
  const c7 = await scalar(
    `SELECT COALESCE(SUM(subtotal), 0) AS v
       FROM commerce7.v_sales_daily
      WHERE sales_date >= $1 AND sales_date < $2`,
    [from, to]
  );
  return round2(sq + c7);
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
      sales7, sales7Ly,
      events7, events7Ly,
      labor14, labor14Ly,
      inv, unfulfilled,
    ] = await Promise.all([
      salesBetween(companyId, d7, now),
      salesBetween(companyId, lastYear(d7), lastYear(now)),

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
              WHERE the_date >= $1 AND the_date < $2`, [d14, now]),
      query(`SELECT COALESCE(SUM(labor_cost), 0) AS labor, COALESCE(SUM(net_sales), 0) AS sales
               FROM team_square.v_labor_pct_daily
              WHERE the_date >= $1 AND the_date < $2`, [lastYear(d14), lastYear(now)]),

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
      sales7: { value: sales7, lastYear: sales7Ly || null, change: pctChange(sales7, sales7Ly) },
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
