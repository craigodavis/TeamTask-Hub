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
import {requireCapability} from '../middleware/auth.js';
import { renderMenuPdf } from '../lib/menuPdf.js';

const router = express.Router();
const cid = (req) => req.companyId;

export const MENUS = [
  { key: 'creek',   name: 'Kindred by the Creek' },
  { key: 'winery',  name: 'The Winery' },
  // A single booklet panel listing the flight, printed to drop into the book.
  { key: 'tasting', name: 'Tasting Flight' },
  // Hand-authored food card; carries no wine tables.
  { key: 'burgers', name: 'Hot August Nights' },
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
router.get('/:key', requireCapability('tastingroom.menus'), async (req, res) => {
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
router.put('/:key/order', requireCapability('tastingroom.menus'), async (req, res) => {
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
router.post('/:key/print', requireCapability('tastingroom.menus'), async (req, res) => {
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

    // Food and drink rows for this menu, in printed order. The templates
    // splice them per section; a menu with no rows simply prints none.
    const food = (await query(
      `SELECT section, name, price_cents, description, note, serves, sort_order
         FROM menu_items
        WHERE company_id = $1 AND menu_key = $2 AND active = true
        ORDER BY sort_order`,
      [cid(req), key]
    )).rows;
    // The tighter or looser gap under a section header belongs to the SLOT, not
    // to the dish standing in it -- swap the first item and the spacing must
    // stay with the header. So it is keyed by menu and section here rather than
    // stored on the row, which is also why reordering items cannot break it.
    const FIRST_MARGIN = {
      burgers: { 'Featured Burger': '4pt' },
      creek:   { 'Brunch Drinks': '16pt', Espresso: '10pt', 'From Our Kitchen': '18pt' },
    };
    const margins = FIRST_MARGIN[key] || {};
    for (const it of food) it.firstMargin = margins[it.section];

    const pdf = await renderMenuPdf(key, wines, food);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="${key}-menu-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});


// ── menu items ───────────────────────────────────────────────────────────────
//
// The printed food and drink rows. Price is deliberately NOT editable here:
// the till is what actually charges the guest, so Square is the authority and
// a second editable copy would only ever be a way to print a price nobody is
// charged. Everything a menu says ABOUT a dish lives here, because Square has
// no field for a note, a "serves", a section or a print order -- and its
// description field is unused in practice (19 of 239 items, one of them the
// word "Drink").

const ITEM_FIELDS = ['name', 'section', 'description', 'note', 'serves', 'active', 'featured'];

/**
 * Who made a change, for the audit row. Taken from the verified token, never
 * from the request body -- an actor a caller can name is not an audit trail.
 *
 * The auth middleware sets req.userId and does NOT populate req.user, so
 * reading req.user?.id here would have silently recorded every edit as
 * "unknown" and left the trail worthless at the moment it mattered.
 */
const actorOf = (req) => ({
  actor: req.user?.email || req.user?.display_name
    || (req.userId ? `user:${req.userId}` : 'service'),
  actor_user: req.userId || null,
});

async function recordChange(client, companyId, key, itemId, action, before, after, req) {
  const a = actorOf(req);
  await client(
    `INSERT INTO menu_item_changes (company_id, menu_key, item_id, action,
       before_json, after_json, actor, actor_user, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
    [companyId, key, itemId, action,
     before ? JSON.stringify(before) : null,
     after ? JSON.stringify(after) : null, a.actor, a.actor_user]
  );
}

// GET /api/menus/:key/items — rows plus the live Square price for each
router.get('/:key/items', requireCapability('tastingroom.menus'), async (req, res) => {
  const key = req.params.key;
  if (!isMenu(key)) return res.status(404).json({ error: 'Unknown menu' });
  try {
    // Joined on SKU, never on name: Square's names are deliberately short
    // because the POS tile truncates them, so "Bloody Mary" IS the menu's
    // "Bakon Vodka Bloody Mary".
    const r = await query(
      `SELECT mi.*,
              sq.square_name,
              sq.square_cents,
              sq.variations
         FROM menu_items mi
         LEFT JOIN LATERAL (
           SELECT ci.name AS square_name,
                  MIN(civ.price_money_amount)::int AS square_cents,
                  COUNT(*)::int AS variations
             FROM team_square.catalog_item_variation civ
             JOIN team_square.catalog_item ci ON ci.id = civ.item_id
            WHERE civ.sku = mi.sku AND civ.is_deleted = false AND ci.is_deleted = false
            GROUP BY ci.name) sq ON mi.sku IS NOT NULL
        WHERE mi.company_id = $1 AND mi.menu_key = $2
        ORDER BY mi.sort_order`,
      [cid(req), key]
    );
    res.json({
      menu: MENUS.find((m) => m.key === key),
      // Named so the UI can say WHY the field is locked rather than just
      // greying it out with no explanation.
      priceSource: 'square',
      priceNote: 'Prices come from Square. To change one, edit the item in Square.',
      items: r.rows.map((row) => ({
        ...row,
        // What the booklet will actually print: Square when linked, otherwise
        // the stored figure. Shown side by side so drift is visible.
        effective_cents: row.square_cents != null ? row.square_cents : row.price_cents,
        price_drifted: row.square_cents != null && row.price_cents != null
          && Number(row.square_cents) !== Number(row.price_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/menus/:key/items/:id
router.patch('/:key/items/:id', requireCapability('tastingroom.menus'), async (req, res) => {
  const key = req.params.key;
  if (!isMenu(key)) return res.status(404).json({ error: 'Unknown menu' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad item id' });

  // Refusing loudly beats ignoring silently: a caller that thinks it just set
  // a price should be told the price did not move.
  for (const k of ['price_cents', 'price', 'sku']) {
    if (k in req.body) {
      return res.status(400).json({
        error: k === 'sku'
          ? 'SKU is the link to Square and is not editable here.'
          : 'Price comes from Square. Change it on the item in Square.',
      });
    }
  }
  const patch = {};
  for (const f of ITEM_FIELDS) if (f in req.body) patch[f] = req.body[f];
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });
  if ('name' in patch && !String(patch.name || '').trim()) {
    return res.status(400).json({ error: 'An item needs a name' });
  }

  try {
    const cur = await query(
      `SELECT * FROM menu_items WHERE id=$1 AND company_id=$2 AND menu_key=$3`,
      [id, cid(req), key]
    );
    const before = cur.rows[0];
    if (!before) return res.status(404).json({ error: 'No such item on this menu' });

    // Empty strings mean "no note", not a note that is blank.
    const vals = [];
    const sets = Object.keys(patch).map((f, i) => {
      let v = patch[f];
      if (typeof v === 'string' && f !== 'name') v = v.trim() === '' ? null : v.trim();
      if (typeof v === 'string' && f === 'name') v = v.trim();
      vals.push(v);
      return `${f} = $${i + 1}`;
    });
    vals.push(id, cid(req), key);
    const upd = await query(
      `UPDATE menu_items SET ${sets.join(', ')}, updated_at = now(), updated_by = $${vals.length + 1}
        WHERE id = $${vals.length - 2} AND company_id = $${vals.length - 1} AND menu_key = $${vals.length}
        RETURNING *`,
      [...vals, req.userId || null]
    );
    await recordChange(query, cid(req), key, id, 'update', before, upd.rows[0], req);
    res.json({ item: upd.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/menus/:key/items/order — [{id, sort_order}, ...]
router.put('/:key/items/order', requireCapability('tastingroom.menus'), async (req, res) => {
  const key = req.params.key;
  if (!isMenu(key)) return res.status(404).json({ error: 'Unknown menu' });
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'Expected { order: [{id, sort_order}] }' });
  try {
    await query('BEGIN');
    for (const o of order) {
      await query(
        `UPDATE menu_items SET sort_order=$1, updated_at=now() WHERE id=$2 AND company_id=$3 AND menu_key=$4`,
        [Number(o.sort_order), Number(o.id), cid(req), key]
      );
    }
    await recordChange(query, cid(req), key, null, 'reorder', null, { order }, req);
    await query('COMMIT');
    res.json({ ok: true, reordered: order.length });
  } catch (err) {
    await query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// GET /api/menus/:key/items/history — the audit trail
router.get('/:key/items/history', requireCapability('tastingroom.menus'), async (req, res) => {
  const key = req.params.key;
  if (!isMenu(key)) return res.status(404).json({ error: 'Unknown menu' });
  try {
    const r = await query(
      `SELECT id, item_id, action, before_json, after_json, actor, created_at
         FROM menu_item_changes WHERE company_id=$1 AND menu_key=$2
        ORDER BY created_at DESC LIMIT 200`,
      [cid(req), key]
    );
    res.json({ changes: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as menusRouter };
