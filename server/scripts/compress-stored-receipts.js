/**
 * Shrink receipt images already stored in the database.
 *
 *   node scripts/compress-stored-receipts.js          # report only
 *   node scripts/compress-stored-receipts.js --apply  # rewrite pdf_data
 *
 * New uploads are compressed on the way in (lib/receiptImage.js). This is the
 * same treatment for everything that landed before that existed.
 *
 * One row at a time and re-runnable: a 4MB blob over the tunnel is slow, and a
 * batch that dies halfway should leave every row it already did in a finished
 * state rather than needing to start over. Only writes when the result is
 * genuinely smaller, so running it twice is harmless.
 */
import dotenv from 'dotenv';
dotenv.config();
import { query, pool } from '../db.js';
import { compressReceiptImage } from '../lib/receiptImage.js';

const APPLY = process.argv.includes('--apply');

const ids = (await query(
  `SELECT id, pdf_filename, length(pdf_data) AS bytes
     FROM receipts
    WHERE pdf_data IS NOT NULL
      AND length(pdf_data) > 400000
    ORDER BY length(pdf_data) DESC`
)).rows;

console.log(`${ids.length} stored image(s) over 400KB`);
console.log(`current total: ${mb(ids.reduce((a, r) => a + Number(r.bytes), 0))}\n`);

let before = 0, after = 0, changed = 0, skipped = 0;

for (const row of ids) {
  const full = (await query(`SELECT pdf_data FROM receipts WHERE id = $1`, [row.id])).rows[0];
  const buf = full.pdf_data;
  // A PDF stored in this column must not be re-encoded as an image.
  const isPdf = buf.length > 4 && buf.slice(0, 4).toString('latin1') === '%PDF';
  if (isPdf) { console.log(`  skip (PDF)  ${row.pdf_filename}`); skipped++; continue; }

  const out = await compressReceiptImage(buf, 'image/jpeg');
  before += buf.length;
  after  += out.buffer.length;

  if (out.buffer.length >= buf.length) { console.log(`  skip        ${row.pdf_filename} — ${out.note}`); skipped++; continue; }

  console.log(`  ${APPLY ? 'rewrite' : 'would  '}     ${row.pdf_filename} — ${out.note}`);
  if (APPLY) {
    await query(`UPDATE receipts SET pdf_data = $1 WHERE id = $2`, [out.buffer, row.id]);
    changed++;
  }
}

console.log(`\n${before ? mb(before) : '0'} -> ${after ? mb(after) : '0'}  (${before ? Math.round((1 - after / before) * 100) : 0}% smaller)`);
console.log(APPLY ? `${changed} rewritten, ${skipped} skipped.` : `DRY RUN — nothing written. Re-run with --apply`);
await pool.end();

function mb(n) { return `${Math.round(n / 1024 / 1024 * 10) / 10}MB`; }
