/**
 * Square Catalog Push — TeamHub products → Square
 *
 * The counterpart to squareCatalogSync.js, which only ever reads. This is the
 * only code in TeamHub that writes to the Square catalog.
 *
 * What drives it: `is_web_available`. Web-available means the wine is present
 * and unarchived in Square; web-off means it is archived there. Archiving
 * rather than deleting keeps the sales history and inventory records, and is
 * reversible — an unarchive restores the item with its SKU, price, category
 * and tax intact.
 *
 * Be aware of what archiving means at the counter: Square hides archived items
 * from the POS item grid and from item search, so an archived wine can only be
 * rung up by scanning its barcode. That is the intended consequence of turning
 * a wine off the website, not an accident.
 *
 * Structure follows what Square already contains, since these products predate
 * the push and have to keep matching:
 *
 *   bottle variant -> its own ITEM, category "750ml Bottle",     name "23 Mama's"
 *   glass variant  -> its own ITEM, category "Wine Glass (5oz)", name "23 Glass Mama's"
 *
 * A glass pour is a separate item in Square, not a variation of the bottle,
 * because that is how the tasting room rings it up and how the sales data has
 * always been categorised. Every item carries exactly one variation named
 * "Regular" — Square collapses that name in its UI, where any other name shows
 * a variation picker the staff have to tap through.
 *
 * Identity is the SKU. Square item ids are recorded once matched, but the SKU
 * is what reconciles an existing catalog to TeamHub on the first push.
 */

import { query } from '../db.js';

const SQUARE_VERSION = '2025-05-21';

const CATEGORY_BOTTLE = '750ml Bottle';
const CATEGORY_GLASS  = 'Wine Glass (5oz)';

async function squareConfig(companyId) {
  const r = await query(
    `SELECT square_access_token, square_env FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const row = r.rows[0];
  const token = row?.square_access_token?.trim() || process.env.SQUARE_ACCESS_TOKEN || '';
  const env   = row?.square_env?.trim()          || process.env.SQUARE_ENV           || 'production';
  const base  = env === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
  return { token, base };
}

function makeSquare({ token, base }) {
  const headers = {
    'Authorization':  `Bearer ${token}`,
    'Square-Version': SQUARE_VERSION,
    'Content-Type':   'application/json',
  };
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      // Square reports field-level detail; surface it rather than just the code.
      const detail = (json.errors || []).map((e) => `${e.field || e.category}: ${e.detail}`).join('; ');
      throw new Error(`Square ${method} ${path} → ${res.status}${detail ? ` (${detail})` : ''}`);
    }
    return json;
  };
  return {
    get:  (id)          => call('GET', `/v2/catalog/object/${id}`).then((r) => r.object),
    upsert: (object)    => call('POST', '/v2/catalog/object',
                                { idempotency_key: crypto.randomUUID(), object }),
    search: (types)     => call('POST', '/v2/catalog/search',
                                { object_types: types, include_deleted_objects: false }),
    searchAll: async (types) => {
      const objects = [];
      let cursor = null;
      do {
        const body = { object_types: types, include_deleted_objects: false };
        if (cursor) body.cursor = cursor;
        const d = await call('POST', '/v2/catalog/search', body);
        if (d.objects) objects.push(...d.objects);
        cursor = d.cursor || null;
      } while (cursor);
      return objects;
    },
  };
}

/**
 * "23 Mama's" -> "23 Glass Mama's", matching the names already in the catalog.
 * A name with no leading year just gets the word in front.
 */
export function glassItemName(productName) {
  const m = String(productName || '').match(/^((?:19|20)?\d{2})\s+(.*)$/);
  return m ? `${m[1]} Glass ${m[2]}` : `Glass ${productName || ''}`;
}

/**
 * Resolve the two categories and the tax once per push.
 *
 * Tax is not a choice: the account carries exactly one, Idaho Sales Tax at 6%,
 * and every sellable item uses it. Picking it up live rather than hard-coding
 * an id means a rebuilt tax still resolves.
 */
async function resolveRefs(sq) {
  const [cats, taxes] = await Promise.all([
    sq.searchAll(['CATEGORY']),
    sq.searchAll(['TAX']),
  ]);
  const byName = (n) => cats.find((c) => !c.is_deleted && c.category_data?.name === n);
  const bottle = byName(CATEGORY_BOTTLE);
  const glass  = byName(CATEGORY_GLASS);
  const tax    = taxes.find((t) => !t.is_deleted && t.tax_data?.enabled);
  if (!bottle) throw new Error(`Square has no "${CATEGORY_BOTTLE}" category`);
  if (!glass)  throw new Error(`Square has no "${CATEGORY_GLASS}" category`);
  if (!tax)    throw new Error('Square has no enabled tax');
  return { bottleCat: bottle.id, glassCat: glass.id, taxId: tax.id };
}

/** Index every live variation by SKU, so an existing catalog reconciles by SKU. */
async function indexBySku(sq) {
  const items = await sq.searchAll(['ITEM']);
  const index = new Map();
  for (const item of items) {
    if (item.is_deleted) continue;
    for (const v of item.item_data?.variations || []) {
      const sku = v.item_variation_data?.sku;
      if (sku) index.set(sku.toLowerCase(), { item, variation: v });
    }
  }
  return index;
}

/**
 * Push one product to Square.
 *
 * @returns {Promise<{actions: string[], itemIds: string[]}>}
 */
export async function pushProductToSquare(companyId, productId) {
  const cfg = await squareConfig(companyId);
  if (!cfg.token) throw new Error('Square access token not configured');
  const sq = makeSquare(cfg);

  const prodRes = await query(
    `SELECT id, name, is_available, is_web_available, is_archived
       FROM product.products WHERE id = $1 AND company_id = $2`,
    [productId, companyId]
  );
  const product = prodRes.rows[0];
  if (!product) throw new Error('Product not found');

  const varRes = await query(
    `SELECT id, sku, price_cents, is_glass, is_available
       FROM product.product_variants WHERE product_id = $1 ORDER BY ordinal`,
    [productId]
  );
  const variants = varRes.rows.filter((v) => v.sku);

  // Web-off (or archived, or not for sale) means archived in Square. Everything
  // else means present and unarchived.
  const shouldBeLive = Boolean(product.is_available)
    && Boolean(product.is_web_available)
    && !product.is_archived;

  const [refs, bySku] = await Promise.all([resolveRefs(sq), indexBySku(sq)]);
  const actions = [];
  const itemIds = [];

  for (const v of variants) {
    const existing = bySku.get(v.sku.toLowerCase());
    const isGlass  = Boolean(v.is_glass);
    const itemName = isGlass ? glassItemName(product.name) : product.name;
    const category = isGlass ? refs.glassCat : refs.bottleCat;
    const price    = v.price_cents == null ? null : parseInt(v.price_cents, 10);

    if (!existing) {
      // Nothing to archive if it was never there.
      if (!shouldBeLive) { actions.push(`${v.sku}: skipped (not in Square, not web-available)`); continue; }
      const created = await sq.upsert({
        type: 'ITEM',
        id: '#item',
        present_at_all_locations: true,
        item_data: {
          name: itemName,
          reporting_category: { id: category },
          tax_ids: [refs.taxId],
          variations: [{
            type: 'ITEM_VARIATION',
            id: '#variation',
            present_at_all_locations: true,
            item_variation_data: {
              name: 'Regular',
              sku: v.sku,
              pricing_type: 'FIXED_PRICING',
              ...(price != null ? { price_money: { amount: price, currency: 'USD' } } : {}),
            },
          }],
        },
      });
      const obj = created.catalog_object;
      itemIds.push(obj.id);
      await recordIds(companyId, productId, v.id, obj.id, obj.item_data.variations[0].id, category, isGlass);
      actions.push(`${v.sku}: created "${itemName}" in ${isGlass ? CATEGORY_GLASS : CATEGORY_BOTTLE}`);
      continue;
    }

    // Re-read for a current version; Square rejects a stale one.
    const item = await sq.get(existing.item.id);
    const before = {
      archived: Boolean(item.item_data.is_archived),
      price: existing.variation.item_variation_data?.price_money?.amount,
    };

    item.item_data.is_archived = !shouldBeLive;
    item.item_data.reporting_category = { id: category };
    item.item_data.tax_ids = [refs.taxId];
    for (const iv of item.item_data.variations || []) {
      if (iv.item_variation_data?.sku?.toLowerCase() !== v.sku.toLowerCase()) continue;
      if (price != null) iv.item_variation_data.price_money = { amount: price, currency: 'USD' };
    }
    await sq.upsert(item);
    itemIds.push(item.id);
    await recordIds(companyId, productId, v.id, item.id, existing.variation.id, category, isGlass);

    const bits = [];
    if (before.price !== price && price != null) bits.push(`price $${before.price / 100} → $${price / 100}`);
    if (before.archived !== !shouldBeLive) bits.push(!shouldBeLive ? 'archived' : 'unarchived');
    actions.push(`${v.sku}: ${bits.length ? bits.join(', ') : 'no change'}`);
  }

  return { actions, itemIds };
}

/**
 * Remember the Square ids so later pushes do not depend on SKU matching.
 *
 * Both ids live on square_variation_data because a wine occupies two items in
 * Square, one per variant. square_items is keyed by product_id and can hold
 * only one, so it records the bottle -- writing the glass there would
 * overwrite it.
 */
async function recordIds(companyId, productId, variantId, itemId, variationId, categoryId, isGlass) {
  if (!isGlass) {
    await query(
      `INSERT INTO product.square_items (product_id, company_id, square_item_id, square_category_id, sq_updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (product_id) DO UPDATE
         SET square_item_id = EXCLUDED.square_item_id,
             square_category_id = EXCLUDED.square_category_id,
             sq_updated_at = NOW()`,
      [productId, companyId, itemId, categoryId]
    );
  }
  await query(
    `INSERT INTO product.square_variation_data
       (variant_id, company_id, square_variation_id, square_item_id, sq_updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (variant_id) DO UPDATE
       SET square_variation_id = EXCLUDED.square_variation_id,
           square_item_id      = EXCLUDED.square_item_id,
           sq_updated_at = NOW()`,
    [variantId, companyId, variationId, itemId]
  );
}
