/**
 * Clobber test — re-itemize ONE "itemization lost" QBO transaction and re-read
 * it immediately to confirm the lines land.
 *
 * Safe by construction: only touches a single transaction whose stored QBO id
 * is valid, whose amount matches the receipt, that is currently single-line, and
 * whose teamHub line items are categorized and sum to the transaction total.
 * Prints the ORIGINAL line array first so the change can be reverted by hand.
 *
 * Usage: node scripts/test-reitemize-one.js
 */
import { qboGetPurchase, qboUpdatePurchase } from '../qboClient.js';
import { query } from '../db.js';

const COMPANY_ID = '8d2df498-b5c0-4f73-94cd-323956036113';
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.01;
const expenseLines = (t) => (t.Line || []).filter((l) => (l.DetailType || '').includes('ExpenseLineDetail'));

const GENERIC = /suppl|ask my accountant|uncategor|miscellaneous|amazon/i;

async function run() {
  // Candidate pool: imported receipts with a stored txn id and ≥1 categorized item.
  const cand = await query(
    `SELECT r.id, r.order_number, r.vendor, r.total, r.qbo_transaction_id,
            COUNT(ri.id) FILTER (WHERE ri.qbo_account_id IS NOT NULL) AS cat_items,
            COALESCE(SUM(ri.total) FILTER (WHERE ri.qbo_account_id IS NOT NULL),0) AS items_sum
     FROM receipts r JOIN receipt_items ri ON ri.receipt_id = r.id
     WHERE r.company_id = $1 AND r.status = 'imported' AND r.qbo_transaction_id IS NOT NULL
     GROUP BY r.id
     HAVING COUNT(ri.id) FILTER (WHERE ri.qbo_account_id IS NOT NULL) >= 1
     ORDER BY (COUNT(ri.id) FILTER (WHERE ri.qbo_account_id IS NOT NULL)) DESC, r.order_date DESC`,
    [COMPANY_ID]
  );

  // Find the first candidate that QBO confirms is amount-matching, currently has a
  // generic single line, and whose items sum to the total (clean swap, no total change).
  let chosen = null, purchase = null, items = null;
  const nearMiss = [];
  for (const c of cand.rows) {
    let p;
    try { p = await qboGetPurchase(COMPANY_ID, c.qbo_transaction_id); } catch { continue; }
    if (!p) continue;
    const lines = expenseLines(p);
    const acct = lines[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || '';
    const amountOk = near(p.TotalAmt, c.total);
    const sumOk    = near(c.items_sum, c.total);
    const generic  = lines.length === 1 && GENERIC.test(acct);

    if (amountOk && generic && sumOk) { chosen = c; purchase = p; items = null; break; }
    if (amountOk && generic && nearMiss.length < 12) {
      nearMiss.push(`${c.vendor} ${c.order_number} total $${c.total} items_sum $${Number(c.items_sum).toFixed(2)} (${c.cat_items} items) QBO acct "${acct}"`);
    }
  }

  if (!chosen) {
    console.log('No clean (sum==total) candidate found. Near-misses (amount-matching, generic single line, but items_sum ≠ total — likely tax):');
    nearMiss.forEach((s) => console.log('  ' + s));
    return;
  }
  {
    const itRes = await query(
      `SELECT description, total, qbo_account_id, qbo_class_id
       FROM receipt_items WHERE receipt_id = $1 AND qbo_account_id IS NOT NULL ORDER BY created_at`,
      [chosen.id]
    );
    items = itRes.rows;
  }

  console.log(`Chosen receipt: ${chosen.vendor} ${chosen.order_number} (teamHub ${chosen.id})`);
  console.log(`QBO Purchase ${chosen.qbo_transaction_id}  TotalAmt=$${purchase.TotalAmt}  SyncToken=${purchase.SyncToken}`);

  console.log(`\n── BEFORE (${expenseLines(purchase).length} expense line) ──`);
  for (const l of (purchase.Line || [])) {
    console.log(`   $${l.Amount}  ${l.DetailType}  acct=${l.AccountBasedExpenseLineDetail?.AccountRef?.name || '-'}  "${l.Description || ''}"`);
  }
  console.log('\n── ORIGINAL Line JSON (save for revert) ──');
  console.log(JSON.stringify(purchase.Line, null, 1));

  console.log(`\n── Pushing ${items.length} itemized lines (sum $${Number(chosen.items_sum).toFixed(2)}) ──`);
  items.forEach((it) => console.log(`   $${it.total}  acct=${it.qbo_account_id}  "${it.description}"`));

  await qboUpdatePurchase(COMPANY_ID, purchase, items);
  console.log('\nUpdate posted. Re-reading…');

  const after = await qboGetPurchase(COMPANY_ID, chosen.qbo_transaction_id);
  console.log(`\n── AFTER (${expenseLines(after).length} expense lines)  TotalAmt=$${after.TotalAmt}  SyncToken=${after.SyncToken} ──`);
  for (const l of (after.Line || [])) {
    console.log(`   $${l.Amount}  ${l.DetailType}  acct=${l.AccountBasedExpenseLineDetail?.AccountRef?.name || '-'}  "${l.Description || ''}"`);
  }

  const landed = expenseLines(after).length >= 2;
  console.log(`\nRESULT: ${landed ? '✅ itemized lines LANDED' : '❌ still single-line — write did not take'}`);
  console.log(`Transaction: QBO Purchase ${chosen.qbo_transaction_id} (re-check after next harvester run to test for clobber).`);
}

run().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
