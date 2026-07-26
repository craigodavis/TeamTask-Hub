/**
 * Monthly wine-volume report — emails a gallons breakdown for the previous
 * calendar month: Commerce7 bottle sales + Square 750ml bottles, wine glasses,
 * paid tastings, and free tastings. Sent 7am Mountain on the 1st of the month.
 *
 * Conversions: wine glass = 5oz, tastings (paid + free) = 8oz, 1 gal = 128oz.
 * Commerce7 volume comes from order_items.volume_in_ml directly (any bottle
 * size), net of refunds (Regular - Refund; Exchange excluded, nets ~0 anyway).
 * Square splits paid vs. free tastings by price ($0 = free) rather than by
 * catalog item/category, because Square doesn't use separate items for comped
 * tastings — the same "Wine Tasting" item is rung at $0 for comps. "WINE CLUB
 * TASTING" is explicitly reclassified from Square's "Wine Glass (5oz)"
 * reporting category to Tasting — it's a $0 comped 8oz pour that's filed under
 * the wrong Square category (confirmed 2026-07-26, ~280 pours/quarter).
 *
 * Manual run: DB_HOST=localhost node lib/wineGallonsReport.js <companyId> [year] [month]
 */
import { query } from '../db.js';
import { sendMail } from '../mail.js';

const TZ = 'America/Denver';
const RECIPIENTS = ['craig@kindredvineyards.com', 'elisha@kindredvineyards.com'];
const OZ_PER_GALLON = 128;
const ML_PER_GALLON = 3785.411784;
const WINE_GLASS_OZ = 5;
const TASTING_OZ = 8;
const SQUARE_BOTTLE_ML = 750;

// month is 1-12. Returns gallons + raw unit counts for the given calendar month.
export async function computeReport(companyId, year, month) {
  const c7MonthBound = `date_trunc('month', make_date($2::int, $3::int, 1)) AT TIME ZONE '${TZ}'`;
  // team_square has no company_id column anywhere (Square data is inherently
  // single-tenant per merchant account, same as v_square_net_sales_daily) — so
  // this query's params are [year, month] only, not [companyId, year, month].
  const sqMonthBound = `date_trunc('month', make_date($1::int, $2::int, 1)) AT TIME ZONE '${TZ}'`;

  const c7 = await query(
    `SELECT COALESCE(SUM(
       CASE oi.purchase_type
         WHEN 'Regular' THEN oi.quantity * oi.volume_in_ml
         WHEN 'Refund'  THEN -oi.quantity * oi.volume_in_ml
         ELSE 0
       END
     ), 0) AS net_ml
     FROM commerce7.order_items oi
     JOIN commerce7.orders o ON o.id = oi.order_id
     WHERE oi.item_type = 'Wine'
       AND oi.purchase_type IN ('Regular', 'Refund')
       AND oi.volume_in_ml IS NOT NULL
       AND o.company_id = $1
       AND o.order_paid_date >= ${c7MonthBound}
       AND o.order_paid_date <  ${c7MonthBound} + interval '1 month'`,
    [companyId, year, month]
  );

  // Bucket: 750ml Bottle | Wine Glass (5oz, excl. the reclassified item) |
  // Tasting (any "*Tasting*" reporting category, or the WINE CLUB TASTING
  // override), split paid/free by total_amount.
  const sq = await query(
    `SELECT
       COALESCE(SUM(oli.quantity) FILTER (WHERE cc.name = '750ml Bottle'), 0) AS bottle_qty,
       COALESCE(SUM(oli.quantity) FILTER (
         WHERE cc.name = 'Wine Glass (5oz)' AND oli.name <> 'WINE CLUB TASTING'
       ), 0) AS glass_qty,
       COALESCE(SUM(oli.quantity) FILTER (
         WHERE (cc.name ILIKE '%Tasting%' OR oli.name = 'WINE CLUB TASTING') AND oli.total_amount > 0
       ), 0) AS tasting_paid_qty,
       COALESCE(SUM(oli.quantity) FILTER (
         WHERE (cc.name ILIKE '%Tasting%' OR oli.name = 'WINE CLUB TASTING') AND oli.total_amount = 0
       ), 0) AS tasting_free_qty
     FROM team_square.order_line_item oli
     JOIN team_square."order" o ON o.id = oli.order_id
     JOIN team_square.catalog_item_variation civ ON civ.id = oli.catalog_object_id
     JOIN team_square.catalog_item ci ON ci.id = civ.item_id
     LEFT JOIN team_square.catalog_category cc ON cc.id = ci.reporting_category_id
     WHERE o.state = 'COMPLETED'
       AND o.created_at >= ${sqMonthBound}
       AND o.created_at <  ${sqMonthBound} + interval '1 month'`,
    [year, month]
  );

  const c7Gallons = (parseFloat(c7.rows[0].net_ml) || 0) / ML_PER_GALLON;
  const row = sq.rows[0];
  const bottleQty = parseFloat(row.bottle_qty) || 0;
  const glassQty = parseFloat(row.glass_qty) || 0;
  const tastingPaidQty = parseFloat(row.tasting_paid_qty) || 0;
  const tastingFreeQty = parseFloat(row.tasting_free_qty) || 0;

  const bottleGallons = (bottleQty * SQUARE_BOTTLE_ML) / ML_PER_GALLON;
  const glassGallons = (glassQty * WINE_GLASS_OZ) / OZ_PER_GALLON;
  const tastingPaidGallons = (tastingPaidQty * TASTING_OZ) / OZ_PER_GALLON;
  const tastingFreeGallons = (tastingFreeQty * TASTING_OZ) / OZ_PER_GALLON;

  return {
    year, month,
    total_gallons: c7Gallons + bottleGallons + glassGallons + tastingPaidGallons + tastingFreeGallons,
    c7_gallons: c7Gallons,
    square_bottle_gallons: bottleGallons,
    square_glass_gallons: glassGallons,
    square_tasting_paid_gallons: tastingPaidGallons,
    square_tasting_free_gallons: tastingFreeGallons,
    square_bottle_qty: bottleQty,
    square_glass_qty: glassQty,
    square_tasting_paid_qty: tastingPaidQty,
    square_tasting_free_qty: tastingFreeQty,
  };
}

const fmt = (n) => n.toFixed(2);

function buildHtml(r) {
  const monthName = new Date(r.year, r.month - 1, 1).toLocaleString('en-US', { month: 'long' });
  const col = 'border:1px solid #ddd; padding:8px 12px; text-align:right;';
  return `
    <div style="font-family: Arial, sans-serif; max-width: 700px;">
      <h2 style="margin-bottom:4px;">Monthly Wine Volume Report</h2>
      <p style="color:#555; margin-top:0;">${monthName} ${r.year}</p>
      <table style="border-collapse:collapse;">
        <tr style="background:#f5f5f5;">
          <th style="${col}">Total<br/>Gallons</th>
          <th style="${col}">Commerce7<br/>Bottles</th>
          <th style="${col}">Square<br/>Bottles (750ml)</th>
          <th style="${col}">Square<br/>Wine Glasses</th>
          <th style="${col}">Square<br/>Paid Tastings</th>
          <th style="${col}">Square<br/>Free Tastings</th>
        </tr>
        <tr>
          <td style="${col} font-weight:bold;">${fmt(r.total_gallons)}</td>
          <td style="${col}">${fmt(r.c7_gallons)}</td>
          <td style="${col}">${fmt(r.square_bottle_gallons)}</td>
          <td style="${col}">${fmt(r.square_glass_gallons)}</td>
          <td style="${col}">${fmt(r.square_tasting_paid_gallons)}</td>
          <td style="${col}">${fmt(r.square_tasting_free_gallons)}</td>
        </tr>
      </table>
      <p style="color:#888; font-size:12px; margin-top:16px;">
        Square unit counts: ${r.square_bottle_qty} bottles (750ml),
        ${r.square_glass_qty} glasses (5oz each),
        ${r.square_tasting_paid_qty} paid tastings + ${r.square_tasting_free_qty} free tastings (8oz each).
        Commerce7 gallons are net of refunds, using each order's actual bottle size.
      </p>
    </div>`;
}

export async function sendReportForPreviousMonth(companyId) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric' }).formatToParts(new Date());
  const y = parseInt(parts.find((p) => p.type === 'year').value, 10);
  const m = parseInt(parts.find((p) => p.type === 'month').value, 10);
  const prevYear = m === 1 ? y - 1 : y;
  const prevMonth = m === 1 ? 12 : m - 1;

  const report = await computeReport(companyId, prevYear, prevMonth);
  const monthName = new Date(prevYear, prevMonth - 1, 1).toLocaleString('en-US', { month: 'long' });
  const result = await sendMail(
    { to: RECIPIENTS.join(','), subject: `Wine Volume Report — ${monthName} ${prevYear}`, html: buildHtml(report) },
    companyId
  );
  if (!result.sent) console.error('[wineGallonsReport] send failed:', result.error);
  else console.log(`[wineGallonsReport] sent ${monthName} ${prevYear} report to ${RECIPIENTS.join(', ')}`);
  return { ...result, report };
}

async function sendReportForAllCompanies() {
  const cs = (await query(`SELECT company_id FROM company_integrations WHERE c7_api_key IS NOT NULL AND c7_api_key <> ''`)).rows;
  for (const c of cs) {
    await sendReportForPreviousMonth(c.company_id).catch((e) => console.error('[wineGallonsReport]', c.company_id, e.message));
  }
}

let started = false;
export function startWineGallonsReportScheduler() {
  if (started) return;
  started = true;

  const scheduleNext = () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const offsetMs = now.getTime() - new Date(now.toLocaleString('en-US', { timeZone: TZ })).getTime();

    const thisMonth1st7am = new Date(new Date(`${get('year')}-${get('month')}-01T00:00:00`).getTime() + 7 * 3600000 + offsetMs);
    let next = thisMonth1st7am;
    if (next <= now) {
      const y = parseInt(get('year'), 10), m = parseInt(get('month'), 10);
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      next = new Date(new Date(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00`).getTime() + 7 * 3600000 + offsetMs);
    }
    const delay = next - now;
    console.log(`[wineGallonsReport] next run in ~${Math.round(delay / 3600000)}h (1st of month, 7am Mountain)`);
    setTimeout(() => {
      sendReportForAllCompanies();
      scheduleNext();
    }, delay);
  };

  scheduleNext();
  console.log('Wine gallons report scheduler started (monthly, 1st @ 7am Mountain).');
}

if (process.argv[1]?.endsWith('wineGallonsReport.js')) {
  const companyId = process.argv[2];
  const year = process.argv[3] ? parseInt(process.argv[3], 10) : null;
  const month = process.argv[4] ? parseInt(process.argv[4], 10) : null;
  (async () => {
    if (year && month) {
      const report = await computeReport(companyId, year, month);
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(JSON.stringify(await sendReportForPreviousMonth(companyId), null, 2));
    }
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
