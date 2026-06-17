/**
 * One-off script: delete and re-process a multi-order Amazon receipt.
 * Run from server/ directory:
 *   CLAUDE_CODE_TMPDIR=/tmp node scripts/reprocess-amazon-receipt.js
 */
import { query } from '../db.js';
import { loadReceiptContext, processReceiptPDF } from '../lib/processReceiptPDF.js';

const ORDER_NUMBER = '113-8118068-9412240';
const COMPANY_ID = '8d2df498-b5c0-4f73-94cd-323956036113';

async function main() {
  // Find the receipt
  const rr = await query(
    `SELECT id, order_number, total, status, pdf_filename, pdf_data
     FROM receipts WHERE company_id = $1 AND order_number = $2`,
    [COMPANY_ID, ORDER_NUMBER]
  );

  if (!rr.rows.length) {
    console.log('Receipt not found — may have already been deleted.');
    process.exit(0);
  }

  const receipt = rr.rows[0];
  console.log(`Found receipt: id=${receipt.id} total=${receipt.total} status=${receipt.status}`);

  if (!receipt.pdf_data) {
    console.error('No pdf_data on this receipt — cannot re-process without the PDF.');
    process.exit(1);
  }

  const pdfBuffer = receipt.pdf_data;
  const filename = receipt.pdf_filename || `Amazon_${ORDER_NUMBER}.pdf`;

  // Delete the bad receipt (items cascade via FK)
  await query(`DELETE FROM receipts WHERE id = $1`, [receipt.id]);
  console.log(`Deleted receipt ${receipt.id}`);

  // Re-process with new multi-order aware extraction
  const ctx = await loadReceiptContext(COMPANY_ID);
  const results = await processReceiptPDF(COMPANY_ID, pdfBuffer, filename, ctx);

  for (const r of results) {
    if (r.error) {
      console.error(`ERROR for ${r.order_number || 'unknown'}: ${r.error}`);
    } else if (r.skipped) {
      console.log(`SKIPPED (duplicate): ${r.order_number}`);
    } else {
      console.log(`CREATED: order=${r.order_number} total=${r.total} items=${r.items} receipt_id=${r.receipt_id}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
