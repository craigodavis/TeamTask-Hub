/**
 * One-off audit: for THIS year, pull every Sysco + Amazon transaction directly
 * from QuickBooks Online (Purchases and Bills) and report, per transaction,
 * whether its line items are categorized (have an account) and whether a
 * receipt image/PDF is attached. Read-only — makes no changes.
 *
 * Usage: node scripts/verify-qbo-receipts.js
 */
import { qboGetVendors, qboQueryAll } from '../qboClient.js';
import { query } from '../db.js';

const COMPANY_ID = '8d2df498-b5c0-4f73-94cd-323956036113';
const YEAR_START = '2026-01-01';
const YEAR_END   = '2026-12-31';
const VENDOR_MATCH = [/sysco/i, /amazon/i, /chef/i];

// Generic/default accounts that signal a NON-itemized (bank-feed default) line.
const GENERIC_ACCT = /suppl|ask my accountant|uncategor|miscellaneous|amazon/i;

function expenseLines(t) {
  return (t.Line || []).filter((l) => (l.DetailType || '').includes('ExpenseLineDetail'));
}
function lineAccountName(line) {
  return line.AccountBasedExpenseLineDetail?.AccountRef?.name
      || line.ItemBasedExpenseLineDetail?.ItemRef?.name
      || null;
}

async function run() {
  const vendors = await qboGetVendors(COMPANY_ID);
  const targets = vendors.filter((v) => VENDOR_MATCH.some((re) => re.test(v.name)));
  console.log('Matched vendors:', targets.map((v) => `${v.name} (${v.id})`).join(', ') || '(none)');
  const idToName = Object.fromEntries(targets.map((v) => [v.id, v.name]));
  const targetIds = new Set(targets.map((v) => v.id));

  // Pull all Purchases and Bills for the year, filter to our vendors client-side.
  const [purchases, bills] = await Promise.all([
    qboQueryAll(COMPANY_ID, `SELECT * FROM Purchase WHERE TxnDate >= '${YEAR_START}' AND TxnDate <= '${YEAR_END}'`),
    qboQueryAll(COMPANY_ID, `SELECT * FROM Bill WHERE TxnDate >= '${YEAR_START}' AND TxnDate <= '${YEAR_END}'`),
  ]);

  const txns = [
    ...purchases.filter((p) => targetIds.has(p.EntityRef?.value)).map((p) => ({ type: 'Purchase', t: p, vendorId: p.EntityRef?.value })),
    ...bills.filter((b) => targetIds.has(b.VendorRef?.value)).map((b) => ({ type: 'Bill', t: b, vendorId: b.VendorRef?.value })),
  ];
  console.log(`\nFound ${txns.length} Sysco/Amazon transactions in ${YEAR_START}..${YEAR_END} (${purchases.length} purchases, ${bills.length} bills scanned).\n`);

  // All attachables for the year (one query), index by linked entity id.
  const attachables = await qboQueryAll(COMPANY_ID, `SELECT * FROM Attachable WHERE MetaData.CreateTime > '${YEAR_START}'`);
  const attachedTo = new Set();
  for (const a of attachables) {
    for (const ref of (a.AttachableRef || [])) {
      if (ref.EntityRef?.value) attachedTo.add(`${ref.EntityRef.type}:${ref.EntityRef.value}`);
    }
  }

  const summary = {};
  const notItemizedTxns = [];

  for (const { type, t, vendorId } of txns) {
    const name = idToName[vendorId] || 'Unknown';
    const lines = expenseLines(t);
    const accts = [...new Set(lines.map(lineAccountName).filter(Boolean))];
    const singleGeneric = lines.length === 1 && GENERIC_ACCT.test(accts[0] || '');
    const itemized = lines.length >= 2;
    const hasImage = attachedTo.has(`${type}:${t.Id}`);

    const key = name.replace(/\s.*/, '');
    summary[key] = summary[key] || { total: 0, itemized: 0, singleLine: 0, singleGeneric: 0, withImage: 0 };
    summary[key].total++;
    if (itemized) summary[key].itemized++;
    if (lines.length === 1) summary[key].singleLine++;
    if (singleGeneric) summary[key].singleGeneric++;
    if (hasImage) summary[key].withImage++;

    if (!itemized) notItemizedTxns.push({ vendor: key, type, id: t.Id, date: t.TxnDate, total: Number(t.TotalAmt), hasImage });
  }

  console.log('=== Summary (live from QBO) ===');
  for (const [k, s] of Object.entries(summary)) {
    console.log(`  ${k}: ${s.total} txns | itemized(≥2 lines) ${s.itemized} | single-line ${s.singleLine} (generic/"Supplies" ${s.singleGeneric}) | with image ${s.withImage}`);
  }

  // ── Reconcile non-itemized QBO txns against teamHub receipts ──────────────
  // Can we repair them? A teamHub receipt with the same total within a ±7-day
  // window, that has line items (and ideally a stored image), is a repair source.
  const thRes = await query(
    `SELECT r.id, r.order_date, r.total, r.vendor, r.status, r.qbo_transaction_id,
            (r.pdf_data IS NOT NULL OR r.pdf_filename IS NOT NULL OR r.raw_path IS NOT NULL) AS has_pdf,
            COUNT(ri.id) AS item_count
     FROM receipts r LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
     WHERE r.company_id = $1 AND r.total IS NOT NULL
     GROUP BY r.id`, [COMPANY_ID]
  );
  const thReceipts = thRes.rows.map((r) => ({ ...r, total: Number(r.total), item_count: Number(r.item_count) }));

  const DAY = 86400000;
  const buckets = { fixable_items_and_image: 0, items_no_image: 0, no_match: 0 };
  const noMatchSamples = [];
  for (const q of notItemizedTxns) {
    const qd = new Date(q.date + 'T00:00:00').getTime();
    const match = thReceipts.find((r) =>
      Math.abs(r.total - q.total) < 0.01 &&
      r.item_count > 0 &&
      r.order_date && Math.abs(new Date(r.order_date).getTime() - qd) <= 7 * DAY
    );
    if (!match) { buckets.no_match++; if (noMatchSamples.length < 25) noMatchSamples.push(`${q.vendor} ${q.id} ${q.date} $${q.total}`); }
    else if (match.has_pdf) buckets.fixable_items_and_image++;
    else buckets.items_no_image++;
  }

  console.log(`\n=== Repairability of the ${notItemizedTxns.length} non-itemized QBO txns (matched to teamHub receipts by total + ±7 days) ===`);
  console.log(`  ✅ teamHub has itemized receipt + image  → push lines + attach: ${buckets.fixable_items_and_image}`);
  console.log(`  ◑ teamHub has itemized receipt, no image → push lines only:    ${buckets.items_no_image}`);
  console.log(`  ❌ no teamHub receipt match → needs re-capture/manual:          ${buckets.no_match}`);
  console.log(`\n  Sample of NO-MATCH (need manual): `);
  noMatchSamples.forEach((l) => console.log('    ' + l));
}

run().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
