/**
 * Tasting-room menus — /api/menus
 *
 * Two menus, Creek and the Winery, each printing its own booklet. A wine is a
 * candidate when it is available for sale; the menu therefore cannot drift out
 * of step with the product list. What is stored here is only the print order
 * and an explicit opt-out, because the two rooms pour different things and
 * running order is a layout decision rather than a property of the wine.
 */

import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';
import { renderMenuPdf } from '../lib/menuPdf.js';

const router = express.Router();
const cid = (req) => req.companyId;

export const MENUS = [
  { key: 'creek',   name: 'Kindred by the Creek' },
  { key: 'winery',  name: 'The Winery' },
  // A single booklet panel listing the flight, printed to drop into the book.
  { key: 'tasting', name: 'Tasting Flight' },
];

/**
 * How many rows each table holds before it crowds the footnotes. From the
 * menu kit: the White & Rosé table fits about 7, Red about 9. Past that the
 * page needs rethinking rather than another row, so this warns instead of
 * silently printing something that overflows.
 */
export const CAPACITY = { white: 7, red: 9 };

/** The flight page is one panel with two short tables, so it holds far less. */
const CAPACITY_BY_MENU = { tasting: { white: 3, red: 3 } };
const capacityFor = (key) => CAPACITY_BY_MENU[key] || CAPACITY;

const isMenu = (k) => MENUS.some((m) => m.key === k);

/** Rosé prints with the whites, so section is derived rather than asked for. */
function sectionFor(row) {
  const s = `${row.wine_style || ''} ${row.varietal || ''}`.toLowerCase();
  if (/ros[ée]|blanc|white|chardonnay|viognier|albari|riesling|pinot gris|sauvignon blanc/.test(s)) {
    return 'white';
  }
  return 'red';
}

// ── GET /api/menus/:key ──────────────────────────────────────────────────────
router.get('/:key', requireManager, async (req, res) => {
  const key = req.params.key;
  if (!isMenu(key)) return res.status(404).json({ error: 'Unknown menu' });

  try {
    const r = await query(
      `SELECT p.id, p.name, p.vintage, p.varietal, p.wine_style, p.is_available,
              b.price_cents  AS bottle_cents,
              g.price_cents  AS glass_cents,
              COALESCE(g.is_available, false) AS glass_available,
              mw.section     AS saved_section,
              mw.sort_order,
              COALESCE(mw.excluded, false) AS excluded
         FROM product.products p
         LEFT JOIN LATERAL (
           SELECT price_cents FROM product.product_variants
            WHERE product_id = p.id AND NOT is_glass
            ORDER BY is_default DESC, ordinal ASC LIMIT 1) b ON true
         LEFT JOIN LATERAL (
           SELECT price_cents, is_available FROM product.product_variants
            WHERE product_id = p.id AND is_glass LIMIT 1) g ON true
         LEFT JOIN menu_wines mw
           ON mw.product_id = p.id AND mw.menu_key = $2 AND mw.company_id = $1
        WHERE p.company_id = $1
          AND p.is_archived = false
          AND p.is_available = true
          AND (p.product_type = 'Wine' OR p.product_type IS NULL)
        ORDER BY COALESCE(mw.sort_order, 9999), p.name`,
      [cid(req), key]
    );

    const wines = r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      vintage: row.vintage,
      varietal: row.varietal,
      section: row.saved_section || sectionFor(row),
      bottle: row.bottle_cents === null ? null : Number(row.bottle_cents) / 100,
      glass: row.glass_available && row.glass_cents !== null
        ? Number(row.glass_cents) / 100
        : null,
      glassAvailable: row.glass_available,
      sortOrder: row.sort_order,
      excluded: row.excluded,
    }));

    const printing = wines.filter((w) => !w.excluded);
    const counts = {
      white: printing.filter((w) => w.section === 'white').length,
      red: printing.filter((w) => w.section === 'red').length,
    };

    const warnings = [];
    for (const s of ['white', 'red']) {
      if (counts[s] > capacityFor(key)[s]) {
        warnings.push({
          section: s,
          count: counts[s],
          capacity: capacityFor(key)[s],
          message: `${counts[s]} ${s === 'white' ? 'whites and rosés' : 'reds'} on the menu — `
                 + `the table holds about ${capacityFor(key)[s]} before it crowds the footnotes. `
                 + `Drop one, or the page needs re-laying out.`,
        });
      }
    }

    res.json({
      menu: MENUS.find((m) => m.key === key),
      menus: MENUS,
      wines,
      counts,
      capacity: capacityFor(key),
      warnings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/menus/:key/order ────────────────────────────────────────────────
// Body: { items: [{ product_id, section, sort_order, excluded }] }
router.put('/:key/order', requireManager, async (req, res) => {
  const key = req.params.key;
  if (!isMenu(key)) return res.status(404).json({ error: 'Unknown menu' });
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items array is required' });

  try {
    for (const it of items) {
      if (!it.product_id) continue;
      await query(
        `INSERT INTO menu_wines (company_id, menu_key, product_id, section, sort_order, excluded)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (company_id, menu_key, product_id) DO UPDATE
           SET section = EXCLUDED.section,
               sort_order = EXCLUDED.sort_order,
               excluded = EXCLUDED.excluded,
               updated_at = NOW()`,
        [cid(req), key, it.product_id,
         it.section === 'white' ? 'white' : 'red',
         Number(it.sort_order) || 0,
         Boolean(it.excluded)]
      );
    }
    res.json({ ok: true, saved: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/menus/:key/print ───────────────────────────────────────────────
router.post('/:key/print', requireManager, async (req, res) => {
  const key = req.params.key;
  if (!isMenu(key)) return res.status(404).json({ error: 'Unknown menu' });
  try {
    const r = await query(
      `SELECT p.id, p.name, p.vintage, p.varietal, p.wine_style,
              b.price_cents AS bottle_cents,
              g.price_cents AS glass_cents,
              COALESCE(g.is_available, false) AS glass_available,
              mw.section AS saved_section, mw.sort_order,
              COALESCE(mw.excluded, false) AS excluded
         FROM product.products p
         LEFT JOIN LATERAL (
           SELECT price_cents FROM product.product_variants
            WHERE product_id = p.id AND NOT is_glass
            ORDER BY is_default DESC, ordinal ASC LIMIT 1) b ON true
         LEFT JOIN LATERAL (
           SELECT price_cents, is_available FROM product.product_variants
            WHERE product_id = p.id AND is_glass LIMIT 1) g ON true
         LEFT JOIN menu_wines mw
           ON mw.product_id = p.id AND mw.menu_key = $2 AND mw.company_id = $1
        WHERE p.company_id = $1 AND p.is_archived = false AND p.is_available = true
          AND (p.product_type = 'Wine' OR p.product_type IS NULL)
          AND COALESCE(mw.excluded, false) = false
        ORDER BY COALESCE(mw.sort_order, 9999), p.name`,
      [cid(req), key]
    );

    const wines = { white: [], red: [] };
    for (const row of r.rows) {
      const sec = row.saved_section || sectionFor(row);
      wines[sec].push({
        vintage: row.vintage,
        name: row.name,
        varietal: row.varietal,
        bottle: row.bottle_cents === null ? null : Number(row.bottle_cents) / 100,
        // Bottle-only unless the glass is both priced and marked available.
        glass: row.glass_available && row.glass_cents !== null
          ? Number(row.glass_cents) / 100 : null,
      });
    }

    const pdf = await renderMenuPdf(key, wines);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="${key}-menu-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export { router as menusRouter };
