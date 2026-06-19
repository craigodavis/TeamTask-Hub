/**
 * One-off script: merge case-duplicate rows in shopping_item_raw.
 *
 * For each group of rows that share the same (company_id, lower(description_raw), vendor):
 *   - Keep one canonical lowercase row (winner)
 *   - Sum purchase_counts, take latest price/date, coalesce all enrichment fields
 *   - Re-point receipt_items.raw_item_id from losers → winner
 *   - Delete losers
 *
 * Each group runs in its own transaction so a failure in one group doesn't roll back the rest.
 *
 * Usage: node server/scripts/merge-shopping-duplicates.js
 */

import { query } from '../db.js';

const coalesce = (rows, field) => rows.find((r) => r[field] != null)?.[field] ?? null;

async function mergeDuplicates() {
  const dupRes = await query(`
    SELECT company_id, lower(description_raw) AS canon, vendor, COUNT(*) AS cnt
    FROM shopping_item_raw
    GROUP BY company_id, lower(description_raw), vendor
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC, lower(description_raw)
  `);

  const groups = dupRes.rows;
  console.log(`Found ${groups.length} duplicate groups to merge.\n`);

  let mergedGroups = 0;
  let deletedRows  = 0;
  const failures   = [];

  for (const group of groups) {
    const { company_id, canon, vendor } = group;

    // Fetch all rows in this group, sorted so the best candidate is first:
    //   1. Already lowercase → preferred (will be the winner if it exists)
    //   2. Higher purchase_count → more data accumulated
    //   3. More recently updated
    const rowsRes = await query(`
      SELECT *
      FROM shopping_item_raw
      WHERE company_id = $1
        AND lower(description_raw) = $2
        AND vendor = $3
      ORDER BY
        (description_raw = lower(description_raw)) DESC,
        purchase_count DESC,
        updated_at DESC NULLS LAST
    `, [company_id, canon, vendor]);

    const rows   = rowsRes.rows;
    const winner = rows[0];
    const losers = rows.slice(1);
    const loserIds = losers.map((r) => r.id);

    // Aggregate merged values
    const totalCount = rows.reduce((s, r) => s + (r.purchase_count || 0), 0);

    const maxDate = rows.reduce((best, r) => {
      if (!r.last_purchase_date) return best;
      if (!best)                 return r.last_purchase_date;
      return r.last_purchase_date > best ? r.last_purchase_date : best;
    }, null);

    // Price from the row with the latest purchase date (fallback to winner's price)
    const rowWithMaxDate = rows.find((r) => r.last_purchase_date === maxDate);
    const bestPrice = rowWithMaxDate?.last_price ?? winner.last_price ?? null;

    // Boolean OR: if any row has is_recipe_primary = true, winner inherits it
    const anyRecipePrimary = rows.some((r) => r.is_recipe_primary === true);

    try {
      await query('BEGIN');

      // 1. Update winner: set canonical lowercase description + all merged fields
      await query(`
        UPDATE shopping_item_raw SET
          description_raw    = $2,
          purchase_count     = $3,
          last_purchase_date = $4,
          last_price         = $5,
          is_recipe_primary  = $6,
          ingredient_id      = COALESCE($7,  ingredient_id),
          shopping_item_id   = COALESCE($8,  shopping_item_id),
          fuzzy_match_id     = COALESCE($9,  fuzzy_match_id),
          similarity_score   = COALESCE($10, similarity_score),
          servings_per_container = COALESCE($11, servings_per_container),
          unit               = COALESCE($12, unit),
          vendor_item_number = COALESCE($13, vendor_item_number),
          product_name       = COALESCE($14, product_name),
          uom                = COALESCE($15, uom),
          pack               = COALESCE($16, pack),
          category           = COALESCE($17, category),
          is_food            = COALESCE($18, is_food),
          enrich_source      = COALESCE($19, enrich_source),
          enriched_at        = COALESCE($20, enriched_at),
          updated_at         = NOW()
        WHERE id = $1
      `, [
        winner.id,
        canon,                              // normalized lowercase
        totalCount,
        maxDate,
        bestPrice,
        anyRecipePrimary,
        coalesce(rows, 'ingredient_id'),
        coalesce(rows, 'shopping_item_id'),
        coalesce(rows, 'fuzzy_match_id'),
        coalesce(rows, 'similarity_score'),
        coalesce(rows, 'servings_per_container'),
        coalesce(rows, 'unit'),
        coalesce(rows, 'vendor_item_number'),
        coalesce(rows, 'product_name'),
        coalesce(rows, 'uom'),
        coalesce(rows, 'pack'),
        coalesce(rows, 'category'),
        coalesce(rows, 'is_food'),
        coalesce(rows, 'enrich_source'),
        coalesce(rows, 'enriched_at'),
      ]);

      // 2. Re-point any receipt_items that link to a loser → winner
      if (loserIds.length > 0) {
        await query(`
          UPDATE receipt_items
          SET raw_item_id = $1
          WHERE raw_item_id = ANY($2::uuid[])
        `, [winner.id, loserIds]);
      }

      // 3. Delete losers (FK constraint satisfied since receipt_items is already updated)
      await query(`
        DELETE FROM shopping_item_raw WHERE id = ANY($1::uuid[])
      `, [loserIds]);

      await query('COMMIT');

      mergedGroups++;
      deletedRows += loserIds.length;
      console.log(`  ✓ ${canon.slice(0, 70)} [removed ${loserIds.length}]`);
    } catch (err) {
      await query('ROLLBACK');
      failures.push({ canon, err: err.message });
      console.error(`  ✗ FAILED: ${canon.slice(0, 70)}\n    ${err.message}`);
    }
  }

  console.log(`\n── Summary ──────────────────────────────────────`);
  console.log(`  Groups merged : ${mergedGroups}`);
  console.log(`  Rows deleted  : ${deletedRows}`);
  if (failures.length) {
    console.log(`  Failures      : ${failures.length}`);
    failures.forEach((f) => console.log(`    - ${f.canon.slice(0, 60)}: ${f.err}`));
  } else {
    console.log(`  Failures      : 0`);
  }
}

mergeDuplicates()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
