/**
 * What should be on the shelf now, given the last count and everything sold since.
 *
 * A count is true for a day and then decays. Before this, the only number on the
 * inventory page was "what somebody counted in September", which by October is a
 * historical fact rather than useful information.
 *
 * Why matching is by NAME and not by id: product.square_items maps 10 of 107
 * products, every product SKU is null, and Commerce7 carries no reference back to
 * the master at all. A name is the only key the three systems share. That is also
 * the weak point — "23 Cerceau Riviere" silently failed to match "23 Cerceau
 * Rivière" and a month of its sales vanished — so the normaliser below strips the
 * things that actually differed in practice, and a wine that matches NOTHING is
 * reported as unmatched rather than as having sold nothing. "Still fully stocked"
 * is the most dangerous number this page could print.
 *
 * Three things are deliberately NOT subtracted:
 *
 *  - Tastings. "Wine Tasting" is one generic item and nothing records which wines
 *    were on the flight, so they cannot be attributed to a wine. Returned as a
 *    separate unallocated figure instead of spread around to look precise.
 *  - Unfulfilled Commerce7 orders. Club wine that is sold but not collected is
 *    still physically on the shelf; subtracting it would understate what is there.
 *    Only quantity_fulfilled counts.
 *  - Transfers. They already adjusted product_inventory.total_bottles when they
 *    happened, so the baseline includes them. Subtracting again would double-count.
 */
import { query } from '../db.js';

/** 5oz out of a 750ml bottle: 25.36 oz, so 5.07 pours to the bottle. */
const OZ_PER_BOTTLE = 25.3605;
const GLASS_OZ = 5;

/**
 * Strip everything the three systems disagree about: case, accents, apostrophes
 * (straight and curly), and the word "Glass" that only Square inserts.
 */
export function normalizeWineName(raw) {
  return String(raw || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // riviere === rivière
    .replace(/[’'`´]/g, '')                              // papas === papa's
    .replace(/\bglass\b/gi, ' ')                         // the glass pour is the same wine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Square items that could be this wine.
 *
 * Exact first. Then prefix, because the master often holds one record where Square
 * sells variants of it — "25 A Souvenir" against "25 A Souvenir French Oaked" and
 * "25 A Souvenir Unoaked", whose stock really is pooled under the one master row.
 * Prefix must land on a word boundary so "23 Papa" cannot claim "23 Papaya".
 */
function itemsForProduct(productNorm, catalog) {
  if (!productNorm) return [];
  const exact = catalog.filter((c) => c.norm === productNorm);
  if (exact.length) return exact;
  return catalog.filter((c) => c.norm.startsWith(`${productNorm} `));
}

/**
 * @param {string} companyId
 * @param {string} locationId        the location being viewed
 * @param {boolean} isDefaultLocation  Commerce7 has no tasting-room location, so its
 *                                     sales are attributed to the default only
 * @param {Array<{id,name,last_counted_at,total_bottles}>} products
 */
export async function estimateForProducts(companyId, locationId, isDefaultLocation, products) {
  const counted = products.filter((p) => p.last_counted_at);
  if (!counted.length) return { estimates: new Map(), tastings: null };

  // Scan only as far back as the OLDEST count on this page. Per-product cutoffs are
  // applied below, so the query stays one bounded pass rather than one per wine.
  const floor = new Date(Math.min(...counted.map((p) => new Date(p.last_counted_at).getTime())));

  const [catRows, sqRows, c7Rows, tastRows] = await Promise.all([
    query(
      `SELECT ci.id, ci.name, cc.name AS kind
         FROM team_square.catalog_item ci
         JOIN team_square.catalog_category cc ON cc.id = ci.reporting_category_id
        WHERE cc.name IN ('750ml Bottle', 'Wine Glass (5oz)')`
    ),
    query(
      `SELECT civ.item_id, o.location_id, cc.name AS kind,
              date_trunc('day', o.created_at) AS day, SUM(li.quantity)::numeric AS qty
         FROM team_square.order_line_item li
         JOIN team_square."order" o ON o.id = li.order_id
         JOIN team_square.catalog_item_variation civ ON civ.id = li.catalog_object_id
         JOIN team_square.catalog_item ci ON ci.id = civ.item_id
         JOIN team_square.catalog_category cc ON cc.id = ci.reporting_category_id
        WHERE o.state = 'COMPLETED' AND o.created_at > $1
          AND cc.name IN ('750ml Bottle', 'Wine Glass (5oz)')
        GROUP BY 1, 2, 3, 4`,
      [floor]
    ),
    // quantity_fulfilled, not quantity: sold-but-uncollected club wine is still here.
    query(
      `SELECT oi.product_title AS title, date_trunc('day', o.order_fulfilled_date) AS day,
              SUM(oi.quantity_fulfilled)::numeric AS qty
         FROM commerce7.order_items oi
         JOIN commerce7.orders o ON o.id = oi.order_id
        WHERE oi.item_type = 'Wine' AND o.order_fulfilled_date > $1
          AND COALESCE(oi.quantity_fulfilled, 0) > 0
        GROUP BY 1, 2`,
      [floor]
    ),
    query(
      `SELECT SUM(li.quantity)::numeric AS qty
         FROM team_square.order_line_item li
         JOIN team_square."order" o ON o.id = li.order_id
         JOIN team_square.catalog_item_variation civ ON civ.id = li.catalog_object_id
         JOIN team_square.catalog_item ci ON ci.id = civ.item_id
         LEFT JOIN team_square.catalog_category cc ON cc.id = ci.reporting_category_id
        WHERE o.state = 'COMPLETED' AND o.created_at > $1 AND o.location_id = $2
          AND (cc.name ILIKE '%Tasting%' OR li.name = 'WINE CLUB TASTING')`,
      [floor, locationId]
    ),
  ]);

  const catalog = catRows.rows.map((c) => ({ ...c, norm: normalizeWineName(c.name) }));

  // item -> [{location, kind, day, qty}]
  const byItem = new Map();
  for (const r of sqRows.rows) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
    byItem.get(r.item_id).push(r);
  }
  const byTitle = new Map();
  for (const r of c7Rows.rows) {
    const k = normalizeWineName(r.title);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(r);
  }

  const estimates = new Map();
  for (const p of products) {
    if (!p.last_counted_at) continue;
    const since = new Date(p.last_counted_at);
    const norm = normalizeWineName(p.name);
    const items = itemsForProduct(norm, catalog);

    let bottles = 0, glasses = 0;
    for (const it of items) {
      for (const row of byItem.get(it.id) || []) {
        if (String(row.location_id) !== String(locationId)) continue;
        if (new Date(row.day) < since) continue;      // day-grained: see caveat below
        if (row.kind === '750ml Bottle') bottles += Number(row.qty);
        else glasses += Number(row.qty);
      }
    }

    let c7 = 0;
    if (isDefaultLocation) {
      for (const [k, rows] of byTitle) {
        if (k !== norm && !k.startsWith(`${norm} `)) continue;
        for (const row of rows) {
          if (new Date(row.day) < since) continue;
          c7 += Number(row.qty);
        }
      }
    }

    const glassBottles = Math.round((glasses * GLASS_OZ / OZ_PER_BOTTLE) * 100) / 100;
    const sold = bottles + glassBottles + c7;
    estimates.set(p.id, {
      matched: items.length > 0,
      matched_items: items.length,
      sold_bottles: bottles,
      sold_glasses: glasses,
      glass_bottles: glassBottles,
      sold_c7: c7,
      // Never negative: a negative estimate means the count was wrong or something
      // moved unrecorded, and showing "-14 bottles" invites nobody to investigate.
      estimated: items.length ? Math.max(0, Math.round((Number(p.total_bottles || 0) - sold) * 10) / 10) : null,
      over_sold: items.length ? sold > Number(p.total_bottles || 0) : false,
    });
  }

  return {
    estimates,
    tastings: {
      units: Number(tastRows.rows[0]?.qty || 0),
      // 8oz per tasting, matching what the ABC filing assumes.
      bottles: Math.round((Number(tastRows.rows[0]?.qty || 0) * 8 / OZ_PER_BOTTLE) * 10) / 10,
      since: floor,
    },
  };
}
