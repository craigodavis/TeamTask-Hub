/**
 * Read-only diagnostic for the QBO itemization gap.
 *
 *  PART 1 — Refined reconciliation of NON-itemized 2026 Amazon/Sysco/Chef QBO
 *           transactions against teamHub receipts (tax-inclusive match: total OR
 *           subtotal, ±14 days). Compares to the strict (total-only, ±7d) count.
 *  PART 2 — Verify every teamHub receipt that carries a stored qbo_transaction_id:
 *           does that QBO txn still EXIST, does its AMOUNT match, and is it
 *           ITEMIZED (≥2 lines)? Buckets the broken ones.
 *
 * Makes NO changes. Usage: node scripts/diagnose-qbo-reconciliation.js
 */
import { qboGetVendors, qboQueryAll } from '../qboClient.js';
import { query } from '../db.js';

const COMPANY_ID = '8d2df498-b5c0-4f73-94cd-323956036113';
const VENDOR_MATCH = [/sysco/i, /amazon/i, /chef/i, /cash.{0,3}carry/i];
const DAY = 86400000;

const expenseLines = (t) => (t.Line || []).filter((l) => (l.DetailType || '').includes('ExpenseLineDetail'));
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.01;

async function run() {
  console.log('Loading QBO + teamHub data…');
  const vendors = await qboGetVendors(COMPANY_ID);
  const targets = vendors.filter((v) => VENDOR_MATCH.some((re) => re.test(v.name)));
  const targetIds = new Set(targets.map((v) => v.id));
  const idToVendor = Object.fromEntries(targets.map((v) => [v.id, v.name.replace(/\s.*/, '')]));

  // Wide pull so stored IDs from 2024-2025 resolve too.
  const [purch, bills] = await Promise.all([
    qboQueryAll(COMPANY_ID, `SELECT * FROM Purchase WHERE TxnDate >= '2024-01-01' AND TxnDate <= '2026-12-31'`),
    qboQueryAll(COMPANY_ID, `SELECT * FROM Bill WHERE TxnDate >= '2024-01-01' AND TxnDate <= '2026-12-31'`),
  ]);
  const byId = new Map();
  for (const p of purch) byId.set(`Purchase:${p.Id}`, { kind: 'Purchase', t: p });
  for (const b of bills) byId.set(`Bill:${b.Id}`, { kind: 'Bill', t: b });
  // Also index purchases by bare id (teamHub stores just the numeric id)
  const purchById = new Map(purch.map((p) => [String(p.Id), p]));

  const attach = await qboQueryAll(COMPANY_ID, `SELECT * FROM Attachable WHERE MetaData.CreateTime > '2026-01-01'`);
  const attached = new Set();
  for (const a of attach) for (const r of (a.AttachableRef || [])) if (r.EntityRef?.value) attached.add(`${r.EntityRef.type}:${r.EntityRef.value}`);

  const recRes = await query(
    `SELECT r.id, r.order_number, r.order_date, r.vendor, r.total, r.subtotal, r.tax,
            r.status, r.qbo_transaction_id,
            (r.pdf_data IS NOT NULL OR r.pdf_filename IS NOT NULL OR r.raw_path IS NOT NULL) AS has_pdf,
            COUNT(ri.id) AS item_count
     FROM receipts r LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
     WHERE r.company_id = $1
     GROUP BY r.id`, [COMPANY_ID]
  );
  const receipts = recRes.rows.map((r) => ({
    ...r, total: r.total != null ? Number(r.total) : null,
    subtotal: r.subtotal != null ? Number(r.subtotal) : null,
    item_count: Number(r.item_count),
    order_ms: r.order_date ? new Date(r.order_date).getTime() : null,
  }));

  // ── PART 1: refined reconciliation of non-itemized 2026 vendor txns ──
  const txns2026 = [
    ...purch.filter((p) => p.TxnDate >= '2026-01-01' && targetIds.has(p.EntityRef?.value)).map((p) => ({ kind: 'Purchase', t: p, vid: p.EntityRef?.value })),
    ...bills.filter((b) => b.TxnDate >= '2026-01-01' && targetIds.has(b.VendorRef?.value)).map((b) => ({ kind: 'Bill', t: b, vid: b.VendorRef?.value })),
  ];
  const nonItem = txns2026.filter(({ t }) => expenseLines(t).length < 2);

  const matchRec = (q, windowDays, taxInclusive) => {
    const qd = new Date(q.t.TxnDate + 'T00:00:00').getTime();
    const amt = Number(q.t.TotalAmt);
    return receipts.find((r) =>
      r.item_count > 0 && r.order_ms != null &&
      Math.abs(r.order_ms - qd) <= windowDays * DAY &&
      (near(r.total, amt) || (taxInclusive && near(r.subtotal, amt)))
    );
  };

  const tally = (windowDays, taxInclusive) => {
    const b = { fixable: 0, itemsNoImg: 0, noMatch: 0 };
    for (const q of nonItem) {
      const m = matchRec(q, windowDays, taxInclusive);
      if (!m) b.noMatch++;
      else if (m.has_pdf) b.fixable++;
      else b.itemsNoImg++;
    }
    return b;
  };

  const strict = tally(7, false);
  const refined = tally(14, true);
  console.log(`\n=== PART 1: ${nonItem.length} non-itemized 2026 Amazon/Sysco/Chef QBO txns ===`);
  console.log(`  STRICT  (total only, ±7d):     fixable ${strict.fixable} | items-no-image ${strict.itemsNoImg} | no-match ${strict.noMatch}`);
  console.log(`  REFINED (total|subtotal, ±14d): fixable ${refined.fixable} | items-no-image ${refined.itemsNoImg} | no-match ${refined.noMatch}`);

  const stillNoMatch = nonItem.filter((q) => !matchRec(q, 14, true));
  const byVendorNoMatch = {};
  for (const q of stillNoMatch) { const v = idToVendor[q.vid] || '?'; byVendorNoMatch[v] = (byVendorNoMatch[v] || 0) + 1; }
  console.log(`  Refined no-match by vendor:`, JSON.stringify(byVendorNoMatch));
  const months = {};
  for (const q of stillNoMatch) { const m = q.t.TxnDate.slice(0, 7); months[m] = (months[m] || 0) + 1; }
  console.log(`  Refined no-match by month: `, JSON.stringify(months));

  // ── PART 2: verify stored qbo_transaction_id (exists / amount / itemized) ──
  const linked = receipts.filter((r) => r.qbo_transaction_id);
  const b2 = { healthy: 0, lostItemization: 0, amountMismatch: 0, missing: 0 };
  const samples = { amountMismatch: [], lostItemization: [], missing: [] };
  for (const r of linked) {
    const p = purchById.get(String(r.qbo_transaction_id));
    if (!p) { b2.missing++; if (samples.missing.length < 15) samples.missing.push(`${r.vendor} rcpt ${r.order_number||r.id} $${r.total} → QBO ${r.qbo_transaction_id} (gone)`); continue; }
    if (!near(p.TotalAmt, r.total)) { b2.amountMismatch++; if (samples.amountMismatch.length < 15) samples.amountMismatch.push(`${r.vendor} rcpt ${r.order_number||r.id} $${r.total} ≠ QBO ${r.qbo_transaction_id} $${p.TotalAmt}`); continue; }
    if (expenseLines(p).length < 2) { b2.lostItemization++; if (samples.lostItemization.length < 15) samples.lostItemization.push(`${r.vendor} rcpt ${r.order_number||r.id} $${r.total} → QBO ${r.qbo_transaction_id} (single-line)`); continue; }
    b2.healthy++;
  }
  console.log(`\n=== PART 2: ${linked.length} teamHub receipts with a stored qbo_transaction_id ===`);
  console.log(`  ✅ healthy (exists, amount matches, itemized): ${b2.healthy}`);
  console.log(`  ⚠️  itemization lost (exists, amount ok, single-line): ${b2.lostItemization}`);
  console.log(`  ❗ amount mismatch (link points at wrong txn): ${b2.amountMismatch}`);
  console.log(`  ❌ missing (stored txn id no longer in QBO): ${b2.missing}`);
  for (const k of ['amountMismatch', 'lostItemization', 'missing']) {
    if (samples[k].length) { console.log(`\n  -- ${k} samples --`); samples[k].forEach((s) => console.log('     ' + s)); }
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
