/**
 * Read-only: the CORRECT scope of the QBO categorization problem.
 *
 * For each 2026 Amazon/Sysco/Chef QBO transaction, compare the ACCOUNT(s) on its
 * expense lines against the account(s) teamHub categorized the matching receipt
 * to. Line COUNT is irrelevant — a 1-item receipt legitimately has 1 line. What
 * matters is whether QBO's categories match ours.
 *
 *   correct      — QBO account set == teamHub categorized account set (incl. both "Supplies")
 *   mismatch     — teamHub has categories that differ from QBO (the real fix list)
 *   no_receipt   — no teamHub receipt to compare against (the capture gap)
 *
 * Matching: teamHub.qbo_transaction_id first (authoritative), else amount(total|subtotal)+±14d.
 * Makes NO changes. Usage: node scripts/audit-qbo-categorization.js
 */
import { qboGetVendors, qboQueryAll } from '../qboClient.js';
import { query } from '../db.js';

const COMPANY_ID = '8d2df498-b5c0-4f73-94cd-323956036113';
const VENDOR_MATCH = [/sysco/i, /amazon/i, /chef/i, /cash.{0,3}carry/i];
const DAY = 86400000;
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.01;
const expenseLines = (t) => (t.Line || []).filter((l) => (l.DetailType || '').includes('ExpenseLineDetail'));
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

async function run() {
  const vendors = await qboGetVendors(COMPANY_ID);
  const targets = vendors.filter((v) => VENDOR_MATCH.some((re) => re.test(v.name)));
  const targetIds = new Set(targets.map((v) => v.id));
  const idToVendor = Object.fromEntries(targets.map((v) => [v.id, v.name.replace(/\s.*/, '')]));

  const acctRes = await query(`SELECT qbo_id, name FROM qbo_accounts WHERE company_id = $1`, [COMPANY_ID]);
  const acctName = Object.fromEntries(acctRes.rows.map((r) => [String(r.qbo_id), r.name]));
  const suppliesIds = new Set(acctRes.rows.filter((r) => /suppl/i.test(r.name)).map((r) => String(r.qbo_id)));

  const [purch, bills] = await Promise.all([
    qboQueryAll(COMPANY_ID, `SELECT * FROM Purchase WHERE TxnDate >= '2026-01-01' AND TxnDate <= '2026-12-31'`),
    qboQueryAll(COMPANY_ID, `SELECT * FROM Bill WHERE TxnDate >= '2026-01-01' AND TxnDate <= '2026-12-31'`),
  ]);
  const txns = [
    ...purch.filter((p) => targetIds.has(p.EntityRef?.value)).map((p) => ({ t: p, vid: p.EntityRef?.value })),
    ...bills.filter((b) => targetIds.has(b.VendorRef?.value)).map((b) => ({ t: b, vid: b.VendorRef?.value })),
  ];

  // teamHub receipts with their categorized account-id set
  const recRes = await query(
    `SELECT r.id, r.order_number, r.order_date, r.vendor, r.total, r.subtotal, r.qbo_transaction_id,
            (r.pdf_data IS NOT NULL OR r.pdf_filename IS NOT NULL OR r.raw_path IS NOT NULL) AS has_pdf,
            array_remove(array_agg(DISTINCT ri.qbo_account_id), NULL) AS acct_ids,
            COUNT(ri.id) FILTER (WHERE ri.qbo_account_id IS NOT NULL) AS cat_items
     FROM receipts r LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
     WHERE r.company_id = $1
     GROUP BY r.id`, [COMPANY_ID]
  );
  const receipts = recRes.rows.map((r) => ({
    ...r, total: r.total != null ? Number(r.total) : null,
    subtotal: r.subtotal != null ? Number(r.subtotal) : null,
    order_ms: r.order_date ? new Date(r.order_date).getTime() : null,
    acctSet: new Set((r.acct_ids || []).map(String)),
  }));
  const byTxn = new Map();
  for (const r of receipts) if (r.qbo_transaction_id) byTxn.set(String(r.qbo_transaction_id), r);

  const matchByAmount = (q) => {
    const qd = new Date(q.t.TxnDate + 'T00:00:00').getTime();
    const amt = Number(q.t.TotalAmt);
    return receipts.find((r) => r.cat_items > 0 && r.order_ms != null &&
      Math.abs(r.order_ms - qd) <= 14 * DAY && (near(r.total, amt) || near(r.subtotal, amt)));
  };

  const stat = {};
  const mismatches = [];
  for (const q of txns) {
    const vendor = idToVendor[q.vid] || '?';
    stat[vendor] = stat[vendor] || { total: 0, correct: 0, mismatch: 0, no_receipt: 0, lostToSupplies: 0 };
    stat[vendor].total++;

    const qboSet = new Set(expenseLines(q.t).map((l) => String(l.AccountBasedExpenseLineDetail?.AccountRef?.value)).filter((x) => x && x !== 'undefined'));
    const rec = byTxn.get(String(q.t.Id)) || matchByAmount(q);

    if (!rec) { stat[vendor].no_receipt++; continue; }
    if (setEq(qboSet, rec.acctSet)) { stat[vendor].correct++; continue; }

    stat[vendor].mismatch++;
    const qboAllSupplies = qboSet.size > 0 && [...qboSet].every((id) => suppliesIds.has(id));
    const recHasSpecific = [...rec.acctSet].some((id) => !suppliesIds.has(id));
    if (qboAllSupplies && recHasSpecific) stat[vendor].lostToSupplies++;
    if (mismatches.length < 40) {
      mismatches.push(`${vendor} QBO ${q.t.Id} ${q.t.TxnDate} $${q.t.TotalAmt} | QBO:[${[...qboSet].map((id) => acctName[id] || id).join(', ') || 'none'}] vs teamHub:[${[...rec.acctSet].map((id) => acctName[id] || id).join(', ')}]${rec.has_pdf ? '' : ' (no img)'}`);
    }
  }

  console.log('=== CORRECTED scope — account comparison (QBO vs teamHub), 2026 ===\n');
  for (const [v, s] of Object.entries(stat)) {
    console.log(`  ${v}: ${s.total} txns | ✅ correct ${s.correct} | ❌ mismatch ${s.mismatch} (of which lost-to-Supplies ${s.lostToSupplies}) | ◻ no-receipt ${s.no_receipt}`);
  }
  const totMis = Object.values(stat).reduce((n, s) => n + s.mismatch, 0);
  const totNo  = Object.values(stat).reduce((n, s) => n + s.no_receipt, 0);
  console.log(`\n  REAL fix list (categorization mismatch, have a receipt): ${totMis}`);
  console.log(`  Capture gap (no teamHub receipt): ${totNo}`);

  console.log(`\n=== Sample mismatches (the real fixables) ===`);
  mismatches.forEach((m) => console.log('  ' + m));
}

run().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
