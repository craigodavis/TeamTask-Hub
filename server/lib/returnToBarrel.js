/**
 * Return a bottled lot to bulk — the inverse of bottling.
 *
 * Shared by POST /api/product-lines/return-to-barrel and
 * scripts/return-to-barrel.js, so the UI path and the command line cannot drift
 * apart on the guards. The guards are the point: this zeroes real inventory and
 * takes a bottling run out of an ABC filing.
 *
 * Caller owns the client and the search_path; this owns the transaction.
 */
export async function returnToBarrel(client, {
  companyId, projectId, unbottledOn, bottles, reason, userId = null,
}) {
  if (!projectId) return { error: 'projectId is required', status: 400 };
  if (!unbottledOn || !/^\d{4}-\d{2}-\d{2}$/.test(String(unbottledOn))) {
    return { error: 'unbottledOn is required as YYYY-MM-DD', status: 400 };
  }
  const vintly_project_id = projectId;
  const unbottled_on = unbottledOn;
await client.query('BEGIN');
  try {
    const pr = (await client.query(
      `SELECT id, name, vintage, product_line_id, bottling_date, starting_case_qty, status
         FROM vintly.projects
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
      [vintly_project_id, companyId]
    )).rows[0];
    if (!pr) { await client.query('ROLLBACK'); return { error: 'Lot not found', status: 404 }; }
    if (!pr.bottling_date) {
      await client.query('ROLLBACK');
      return { error: `${pr.name} has no bottling date — there is nothing to return to barrel.`, status: 400 };
    }
    if (new Date(unbottled_on) < new Date(pr.bottling_date)) {
      await client.query('ROLLBACK');
      return { error: `Returned ${unbottled_on} is before it was bottled `
        + `(${pr.bottling_date.toISOString().slice(0, 10)}).`, status: 400 };
    }

    // Resolve the finished-goods product. NOT by name — the lot is "24 Pinot
    // Vineyard Blend KV & CS" and the product is "24 Into the Mystic". Direct FK
    // first, else product_line_id + vintage, and REFUSE on ambiguity rather than
    // pick one: 25 Viognier WS + A Souvenir + 2025 matches two product records,
    // and guessing would zero the wrong wine's bottles.
    let prod = (await client.query(
      `SELECT id, name FROM product.products
        WHERE vintly_project_id = $1 AND company_id = $2`,
      [pr.id, companyId]
    )).rows;
    let via = 'vintly_project_id';
    if (!prod.length && pr.product_line_id) {
      prod = (await client.query(
        `SELECT id, name FROM product.products
          WHERE product_line_id = $1 AND vintage = $2 AND company_id = $3`,
        [pr.product_line_id, pr.vintage, companyId]
      )).rows;
      via = 'product_line_id + vintage';
    }
    if (prod.length !== 1) {
      await client.query('ROLLBACK');
      return {
        status: 409,
        error: prod.length === 0
          ? `${pr.name} has no finished-goods product (looked by ${via}). `
            + `Set products.vintly_project_id or the line + vintage first, or its `
            + `bottles would stay in the ABC count while its production left it.`
          : `${pr.name} matches ${prod.length} products by ${via} `
            + `(${prod.map((x) => x.name).join(', ')}). Resolve the duplicate first — `
            + `guessing would zero the wrong wine.`,
      };
    }
    const product = prod[0];

    // What was actually on the shelf, which is the honest quantity returned —
    // not the bottling figure. 864 were bottled; 854 were counted on 5 Aug, the
    // 10-bottle difference being fills or breakage that never reached a barrel.
    const onHand = (await client.query(
      `SELECT COALESCE(SUM(total_bottles + COALESCE(library_bottles, 0)), 0)::int AS b
         FROM product.product_inventory WHERE product_id = $1 AND company_id = $2`,
      [product.id, companyId]
    )).rows[0].b;
    const returned = Number.isFinite(parseInt(bottles, 10)) ? parseInt(bottles, 10) : onHand;

    await client.query(
      `UPDATE vintly.projects
          SET unbottled_on = $2, unbottled_bottles = $3,
              status = 'In Barrel',
              exclude_from_abc = true,
              abc_exclusion_reason = $4,
              updated_at = NOW(), updated_by = $5
        WHERE id = $1`,
      [pr.id, unbottled_on, returned,
       (reason || '').trim()
         || `Bottled ${pr.bottling_date.toISOString().slice(0, 10)}, returned to barrel `
            + `${unbottled_on}. No ABC line exists for a reversal, so the run is excluded.`,
       userId]
    );

    // Zero the bottles everywhere, logged as a movement rather than a count:
    // counted_by NULL, because nobody counted this — the wine left in a hose.
    // Without the log row the next physical count reads as a loss.
    const locs = (await client.query(
      `SELECT location_id, total_bottles, library_bottles FROM product.product_inventory
        WHERE product_id = $1 AND company_id = $2
          AND (total_bottles > 0 OR COALESCE(library_bottles, 0) > 0)`,
      [product.id, companyId]
    )).rows;
    for (const L of locs) {
      await client.query(
        `UPDATE product.product_inventory
            SET total_bottles = 0, library_bottles = 0, last_counted_at = $3
          WHERE product_id = $1 AND location_id = $2`,
        [product.id, L.location_id, unbottled_on]
      );
      await client.query(
        `INSERT INTO product.product_inventory_log
           (product_id, location_id, company_id, total_bottles, library_bottles,
            counted_by, counted_at)
         VALUES ($1, $2, $3, 0, 0, NULL, $4)`,
        [product.id, L.location_id, companyId, unbottled_on]
      );
    }

    await client.query('COMMIT');
    return {
      ok: true, lot: pr.name, product: product.name, resolved_via: via,
      unbottled_on, bottles_returned: returned, on_hand_before: onHand,
      locations_zeroed: locs.length,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
