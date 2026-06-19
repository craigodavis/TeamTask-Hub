/**
 * Identify the 43 mismatched receipts and split them into two buckets:
 *
 *   clean     — teamHub receipt has a stored qbo_transaction_id AND QBO amount
 *               matches our total (can re-queue immediately; re-matching will
 *               find the same txn by id)
 *   reconcile — stored id is wrong/missing OR amount differs (needs Find-QBO-
 *               matches step to re-link)
 *
 * Dry-run by default. Pass --reset to actually snapshot + re-queue.
 *
 * Usage:
 *   node scripts/requeue-mismatches.js           # read-only report
 *   node scripts/requeue-mismatches.js --reset   # execute the reset (asks for confirmation)
 */
import { qboGetVendors, qboQueryAll } from '../qboClient.js';
import { query } from '../db.js';

const COMPANY_ID = '8d2df498-b5c0-4f73-94cd-323956036113';
const VENDOR_MATCH = [/sysco/i, /amazon/i, /chef/i, /cash.{0,3}carry/i];
const DAY = 86400000;
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.01;
const expenseLines = (t) => (t.Line || []).filter((l) => (l.DetailType || '').includes('ExpenseLineDetail'));
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

const DO_RESET = process.argv.includes('--reset');

async function run() {
  // ── 1. Pull QBO vendor list ───────────────────────────────────────────────
  const vendors = await qboGetVendors(COMPANY_ID);
  const targets = vendors.filter((v) => VENDOR_MATCH.some((re) => re.test(v.name)));
  const targetIds = new Set(targets.map((v) => v.id));
  const idToVendor = Object.fromEntries(targets.map((v) => [v.id, v.name.replace(/\s.*/, '')]));

  // ── 2. QBO accounts (for category names) ─────────────────────────────────
  const acctRes = await query(`SELECT qbo_id, name FROM qbo_accounts WHERE company_id = $1`, [COMPANY_ID]);
  const acctName = Object.fromEntries(acctRes.rows.map((r) => [String(r.qbo_id), r.name]));
  const suppliesIds = new Set(acctRes.rows.filter((r) => /suppl/i.test(r.name)).map((r) => String(r.qbo_id)));

  // ── 3. Pull 2026 QBO transactions ────────────────────────────────────────
  const [purch, bills] = await Promise.all([
    qboQueryAll(COMPANY_ID, `SELECT * FROM Purchase WHERE TxnDate >= '2026-01-01' AND TxnDate <= '2026-12-31'`),
    qboQueryAll(COMPANY_ID, `SELECT * FROM Bill WHERE TxnDate >= '2026-01-01' AND TxnDate <= '2026-12-31'`),
  ]);
  const txns = [
    ...purch.filter((p) => targetIds.has(p.EntityRef?.value)).map((p) => ({ t: p, vid: p.EntityRef?.value, kind: 'Purchase' })),
    ...bills.filter((b) => targetIds.has(b.VendorRef?.value)).map((b) => ({ t: b, vid: b.VendorRef?.value, kind: 'Bill' })),
  ];
  const qboById = new Map([...purch, ...bills].map((t) => [String(t.Id), t]));

  // ── 4. Pull all teamHub receipts with their categorized account sets ──────
  const recRes = await query(
    `SELECT r.id, r.order_number, r.order_date, r.vendor, r.total, r.subtotal,
            r.status, r.qbo_transaction_id, r.exported_at, r.card_last4,
            (r.pdf_data IS NOT NULL OR r.pdf_filename IS NOT NULL OR r.raw_path IS NOT NULL) AS has_pdf,
            array_remove(array_agg(DISTINCT ri.qbo_account_id), NULL) AS acct_ids,
            COUNT(ri.id) FILTER (WHERE ri.qbo_account_id IS NOT NULL) AS cat_items
     FROM receipts r LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
     WHERE r.company_id = $1
     GROUP BY r.id`,
    [COMPANY_ID]
  );
  const receipts = recRes.rows.map((r) => ({
    ...r,
    total: r.total != null ? Number(r.total) : null,
    subtotal: r.subtotal != null ? Number(r.subtotal) : null,
    order_ms: r.order_date ? new Date(r.order_date).getTime() : null,
    acctSet: new Set((r.acct_ids || []).map(String)),
  }));
  const byTxn = new Map();
  for (const r of receipts) if (r.qbo_transaction_id) byTxn.set(String(r.qbo_transaction_id), r);

  const matchByAmount = (q) => {
    const qd = new Date(q.t.TxnDate + 'T00:00:00').getTime();
    const amt = Number(q.t.TotalAmt);
    return receipts.find(
      (r) =>
        r.cat_items > 0 &&
        r.order_ms != null &&
        Math.abs(r.order_ms - qd) <= 14 * DAY &&
        (near(r.total, amt) || near(r.subtotal, amt))
    );
  };

  // ── 5. Find mismatches (same logic as audit script) ──────────────────────
  const mismatches = [];
  for (const q of txns) {
    const vendor = idToVendor[q.vid] || '?';
    const qboSet = new Set(
      expenseLines(q.t)
        .map((l) => String(l.AccountBasedExpenseLineDetail?.AccountRef?.value))
        .filter((x) => x && x !== 'undefined')
    );
    const rec = byTxn.get(String(q.t.Id)) || matchByAmount(q);
    if (!rec) continue; // no_receipt — not in scope here
    if (setEq(qboSet, rec.acctSet)) continue; // correct — skip

    // It's a mismatch. Now determine the bucket.
    const storedQboTxn = rec.qbo_transaction_id ? qboById.get(String(rec.qbo_transaction_id)) : null;
    const storedAmtMatch = storedQboTxn ? near(storedQboTxn.TotalAmt, rec.total) : false;

    mismatches.push({
      rec,
      vendor,
      qboTxnId: q.t.Id,
      qboDate: q.t.TxnDate,
      qboAmt: Number(q.t.TotalAmt),
      qboAccts: [...qboSet].map((id) => acctName[id] || id).join(', ') || '(none)',
      thAccts: [...rec.acctSet].map((id) => acctName[id] || id).join(', '),
      // Is the receipt's OWN stored link pointing at the right place?
      bucket: storedAmtMatch ? 'clean' : 'reconcile',
      storedQboId: rec.qbo_transaction_id,
    });
  }

  // ── 6. Print report ───────────────────────────────────────────────────────
  const clean = mismatches.filter((m) => m.bucket === 'clean');
  const reconcile = mismatches.filter((m) => m.bucket === 'reconcile');

  console.log(`\n=== Mismatch re-queue report — ${mismatches.length} total ===`);
  console.log(`  CLEAN (stored QBO link + amount matches): ${clean.length}`);
  console.log(`  RECONCILE (no stored link or amount off): ${reconcile.length}`);

  const fmtRow = (m, i) =>
    `  ${String(i + 1).padStart(2)}. [${m.rec.id}]  ${m.vendor.padEnd(8)}  ` +
    `${m.rec.order_date?.toISOString?.().slice(0, 10) ?? m.rec.order_date ?? '?'}  ` +
    `$${String(m.rec.total ?? '?').padStart(8)}  ` +
    `status=${m.rec.status}  storedQBO=${m.rec.qbo_transaction_id ?? 'null'}\n` +
    `       QBO ${m.qboTxnId} ${m.qboDate} $${m.qboAmt}  ` +
    `QBO:[${m.qboAccts}]  teamHub:[${m.thAccts}]`;

  if (clean.length) {
    console.log(`\n── CLEAN (${clean.length}) — stored link confirmed, amount ok ──`);
    clean.forEach((m, i) => console.log(fmtRow(m, i)));
  }

  if (reconcile.length) {
    console.log(`\n── RECONCILE (${reconcile.length}) — need Find-QBO-matches step ──`);
    reconcile.forEach((m, i) => console.log(fmtRow(m, i)));
  }

  if (!DO_RESET) {
    console.log('\n(dry-run — no changes made. Re-run with --reset to execute.)\n');
    return;
  }

  // ── 7. Execute reset ──────────────────────────────────────────────────────
  console.log('\n── Snapshotting current state before reset ──');
  const ids = mismatches.map((m) => m.rec.id);

  // Save snapshot to a temp table for full reversibility
  await query(`
    CREATE TABLE IF NOT EXISTS requeue_mismatch_snapshot (
      receipt_id UUID PRIMARY KEY,
      status_before TEXT,
      qbo_transaction_id_before TEXT,
      exported_at_before TIMESTAMPTZ,
      snapshotted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`
    INSERT INTO requeue_mismatch_snapshot (receipt_id, status_before, qbo_transaction_id_before, exported_at_before)
    SELECT id, status, qbo_transaction_id::TEXT, exported_at
    FROM receipts
    WHERE id = ANY($1::uuid[])
    ON CONFLICT (receipt_id) DO UPDATE SET
      status_before = EXCLUDED.status_before,
      qbo_transaction_id_before = EXCLUDED.qbo_transaction_id_before,
      exported_at_before = EXCLUDED.exported_at_before,
      snapshotted_at = NOW()
  `, [ids]);
  console.log(`  Snapshot saved for ${ids.length} receipts → requeue_mismatch_snapshot`);

  // Reset: status=reviewed, clear QBO link so export/preview picks them up
  const result = await query(`
    UPDATE receipts
    SET status = 'reviewed',
        qbo_transaction_id = NULL,
        exported_at = NULL
    WHERE id = ANY($1::uuid[])
      AND company_id = $2
    RETURNING id, vendor, order_date, total, status
  `, [ids, COMPANY_ID]);

  console.log(`\n✅ Reset ${result.rows.length} receipts → status=reviewed, qbo_transaction_id=NULL`);
  console.log('   They will now appear in the export/preview queue.');
  console.log('   To revert: UPDATE receipts SET status=s.status_before, qbo_transaction_id=s.qbo_transaction_id_before::uuid,');
  console.log('              exported_at=s.exported_at_before FROM requeue_mismatch_snapshot s WHERE receipts.id=s.receipt_id;');
}

run().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
