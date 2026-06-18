/**
 * One-time import: QBO unmatched receipt images → TeamHub Pending receipts.
 *
 * Finds all receipt images uploaded to QBO (mobile app / web) that were never
 * linked to a transaction, downloads them, and runs them through AI extraction.
 *
 * Usage (from server/ directory):
 *   node scripts/import-qbo-attachables.js <auth-token> [base-url] [days]
 *
 * auth-token : TeamHub JWT (from browser DevTools → Application → Local Storage → teamtask_token)
 * base-url   : defaults to https://team.kindredvineyards.com/api
 * days       : how far back to look (default 365)
 *
 * Example:
 *   node scripts/import-qbo-attachables.js "eyJ..." https://team.kindredvineyards.com/api 365
 */

const AUTH_TOKEN = process.argv[2];
const API_BASE   = process.argv[3] || 'https://team.kindredvineyards.com/api';
const DAYS       = parseInt(process.argv[4] || '365', 10);

if (!AUTH_TOKEN) {
  console.error('Usage: node scripts/import-qbo-attachables.js <auth-token> [base-url] [days]');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` };

// ── Step 1: list unmatched attachables ────────────────────────────────────────
console.log(`Fetching unmatched QBO receipt images (last ${DAYS} days)…`);
const listRes = await fetch(`${API_BASE}/receipts/qbo-unmatched-attachables?days=${DAYS}`, { headers });
if (!listRes.ok) {
  const err = await listRes.json().catch(() => ({}));
  console.error('Failed to list attachables:', err.error || listRes.status);
  process.exit(1);
}
const { count, items } = await listRes.json();
console.log(`Found ${count} unmatched receipt image(s) in QBO.`);

if (!count) {
  console.log('Nothing to import.');
  process.exit(0);
}

const toImport = items.filter((i) => !i.already_imported);
const skippable = items.filter((i) => i.already_imported);

console.log(`  Already imported: ${skippable.length}`);
console.log(`  To import:        ${toImport.length}`);

if (skippable.length) {
  console.log('\nSkipping (already in TeamHub):');
  for (const i of skippable) {
    console.log(`  SKIP  ${i.filename}  (${i.created_at?.slice(0, 10)})`);
  }
}

if (!toImport.length) {
  console.log('\nAll receipts already imported.');
  process.exit(0);
}

console.log(`\nImporting ${toImport.length} receipt image(s) in batches of 5…`);

// ── Step 2: import in batches of 5 ───────────────────────────────────────────
const BATCH = 5;
let inserted = 0, errors = 0;

for (let i = 0; i < toImport.length; i += BATCH) {
  const batch = toImport.slice(i, i + BATCH);
  const res = await fetch(`${API_BASE}/receipts/qbo-import-attachables`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      attachable_ids: batch.map((a) => ({
        id:           a.id,
        filename:     a.filename,
        content_type: a.content_type,
      })),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`Batch ${Math.floor(i / BATCH) + 1} failed:`, err.error || res.status);
    errors += batch.length;
    continue;
  }

  const data = await res.json();
  for (const r of data.results) {
    if (r.error) {
      console.log(`  ERROR  ${r.filename}: ${r.error}`);
      errors++;
    } else {
      const receiptCount = r.receipts?.length ?? 0;
      const orders = r.receipts?.map((rc) => rc.order_number || rc.receipt_id).join(', ') || '—';
      console.log(`  OK     ${r.filename}  →  ${receiptCount} receipt(s)  [${orders}]`);
      inserted += receiptCount;
    }
  }
}

console.log(`\nDone: ${inserted} receipt(s) imported, ${errors} error(s).`);
if (inserted > 0) {
  console.log('Go to Receipts → Pending to review and categorize.');
}
