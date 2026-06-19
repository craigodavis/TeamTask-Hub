/**
 * One-time import: Chef Store CSV → receipts via running TeamHub server.
 *
 * Usage (from server/ directory):
 *   node scripts/import-chefstore-csv.js <path-to-csv> <auth-token> [base-url]
 *
 * base-url defaults to http://localhost:3001/api
 * For production: https://team.kindredvineyards.com/api
 *
 * Get the auth token from the browser DevTools (Application → Local Storage → teamtask_token).
 */
import fs from 'fs';

const CSV_PATH   = process.argv[2];
const AUTH_TOKEN = process.argv[3];
const API_BASE   = process.argv[4] || 'http://localhost:3001/api';

if (!CSV_PATH || !AUTH_TOKEN) {
  console.error('Usage: node scripts/import-chefstore-csv.js <csv-path> <auth-token> [base-url]');
  console.error('  base-url defaults to http://localhost:3001/api');
  console.error('  For production: https://team.kindredvineyards.com/api');
  process.exit(1);
}

function parseCSVLine(line) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      fields.push(cur.trim()); cur = '';
    } else { cur += ch; }
  }
  fields.push(cur.trim());
  return fields;
}

function parseDate(str) {
  const [m, d, y] = str.trim().split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

const raw   = fs.readFileSync(CSV_PATH, 'utf8');
const lines = raw.split('\n').filter(l => l.trim());
const header = parseCSVLine(lines[0]).map(h => h.trim());
const col = Object.fromEntries(header.map((h, i) => [h, i]));

// Group rows by receipt number
const receipts = new Map();
for (let i = 1; i < lines.length; i++) {
  const row = parseCSVLine(lines[i]);
  if (row.length < 2) continue;

  const receiptNum  = row[col['Receipt number']];
  const date        = row[col['Date']];
  const grossAmt    = parseFloat(row[col['Gross amount']]) || 0;
  const netAmt      = parseFloat(row[col['Net amount exclusive of tax']]) || 0;
  const price       = parseFloat(row[col['Price']]) || 0;
  const qty         = parseFloat(row[col['Quantity']]) || 0;
  const taxAmt      = parseFloat(row[col['Sales tax amount']]) || 0;
  const productName = (row[col['Product name']] || '').trim();
  const category    = (row[col['Category']] || '').trim();
  const itemNumber  = (row[col['Item number']] || '').trim() || null;
  const barCode     = (row[col['Bar code']] || '').trim() || null;

  if (!receiptNum) continue;

  if (!receipts.has(receiptNum)) {
    receipts.set(receiptNum, {
      order_number: receiptNum,
      order_date:   parseDate(date),
      total:        Math.abs(grossAmt),
      tax:          0,
      items:        [],
    });
  }

  const rec = receipts.get(receiptNum);
  rec.tax += Math.abs(taxAmt);

  const desc = category ? `${productName} (${category})` : productName;
  rec.items.push({
    description:        desc,
    quantity:           Math.abs(qty),
    unit_price:         price,
    total:              Math.abs(netAmt),
    vendor_item_number: itemNumber,
    bar_code:           barCode,
  });
}

// Round totals and compute subtotals
for (const rec of receipts.values()) {
  rec.tax      = parseFloat(rec.tax.toFixed(2));
  rec.subtotal = parseFloat((rec.total - rec.tax).toFixed(2));
}

const receiptList = [...receipts.values()];
console.log(`Parsed ${receiptList.length} receipts, ${receiptList.reduce((s, r) => s + r.items.length, 0)} line items`);
console.log('Sending to server in batches of 10…\n');

// Post in batches of 10
const BATCH = 10;
let inserted = 0, skipped = 0, errors = 0;

for (let i = 0; i < receiptList.length; i += BATCH) {
  const batch = receiptList.slice(i, i + BATCH);
  const res = await fetch(`${API_BASE}/receipts/csv-import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ vendor: 'Chef Store', receipts: batch }),
  });
  const data = await res.json();
  if (!res.ok) { console.error('Batch error:', data.error); errors += batch.length; continue; }

  for (const r of data.results) {
    if (r.error)   { console.log(`  ERROR  ${r.order_number}: ${r.error}`); errors++; }
    else if (r.skipped) { console.log(`  SKIP   ${r.order_number} (duplicate)`); skipped++; }
    else { console.log(`  OK     ${r.order_number}  ${receipts.get(r.order_number)?.order_date}  $${receipts.get(r.order_number)?.total?.toFixed(2)}  (${r.items} items)`); inserted++; }
  }
}

console.log(`\nDone: ${inserted} inserted, ${skipped} skipped, ${errors} errors`);
console.log('Go to Receipts → Pending and click "Run AI Categorization" to categorize all items.');
