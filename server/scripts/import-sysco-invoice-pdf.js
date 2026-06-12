/**
 * Import Sysco invoice PDFs into receipts + receipt_items
 *
 * Reads every .pdf in the given folder. Expects standard Sysco invoice
 * format (one or more pages; totals appear on LAST PAGE).
 *
 * Filename convention (used as fallback): INVOICENUMBER_YYYYMMDD_*.pdf
 *   e.g.  240857757_20251120_145120883.pdf
 *
 * Usage:
 *   node scripts/import-sysco-invoice-pdf.js /path/to/invoices/
 *   node scripts/import-sysco-invoice-pdf.js /path/to/invoices/ --debug   # dump raw text for first file
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// Import directly from lib to avoid pdf-parse's auto-test-run on module load
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('../node_modules/pdf-parse/lib/pdf-parse.js');
import pg from 'pg';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { Pool } = pg;
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_DATABASE,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
});

const COMPANY_ID = '8d2df498-b5c0-4f73-94cd-323956036113';

// ── Parser ────────────────────────────────────────────────────────────────────

function parseSyscoInvoice(text, filenameBase) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Pull invoice number + date from filename (reliable fallback)
  let filenameInvoiceNumber = null;
  let filenameDate = null;
  const fnMatch = filenameBase.match(/^(\d{9})_(\d{8})/);
  if (fnMatch) {
    filenameInvoiceNumber = fnMatch[1];
    const d = fnMatch[2]; // YYYYMMDD
    filenameDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }

  const result = {
    invoice_number:  filenameInvoiceNumber,
    delivery_date:   filenameDate,
    due_date:        null,
    customer_number: null,
    manifest_number: null,
    subtotal:        null,
    tax_total:       null,
    total:           null,
    items:           [],
  };

  let currentCategory = null;
  let foundDeliveryDate = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Invoice number (9 digits near top) ──
    if (!result.invoice_number) {
      const m = line.match(/\b(\d{9})\b/);
      if (m) result.invoice_number = m[1];
    }

    // ── Delivery date: standalone MM/DD/YY line near header ──
    if (!foundDeliveryDate) {
      const m = line.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
      if (m) {
        result.delivery_date = `20${m[3]}-${m[1]}-${m[2]}`;
        foundDeliveryDate = true;
      }
    }

    // ── Due date: appears on the LAST PAGE line or near PAYABLE ON OR BEFORE ──
    if (/LAST PAGE/i.test(line)) {
      const m = line.match(/(\d{2})\/(\d{2})\/(\d{2})/);
      if (m) result.due_date = `20${m[3]}-${m[1]}-${m[2]}`;
    }
    if (!result.due_date && /PAYABLE ON OR BEFORE/i.test(line)) {
      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        const m = lines[j].match(/(\d{2})\/(\d{2})\/(\d{2})/);
        if (m) { result.due_date = `20${m[3]}-${m[1]}-${m[2]}`; break; }
      }
    }

    // ── Manifest number ──
    const mfMatch = line.match(/MANIFEST#\s+(\d+)/i);
    if (mfMatch) result.manifest_number = mfMatch[1];

    // ── Customer number (6-digit, may appear in TRUCK STOP line or standalone) ──
    if (!result.customer_number) {
      const m = line.match(/(?:TRUCK STOP|CUSTOMER)\s+(\d{6})\b/i) || line.match(/^\s*(\d{6})\s*$/);
      if (m) result.customer_number = m[1];
    }

    // ── Totals: appear after LAST PAGE ──
    if (/LAST PAGE/i.test(line)) {
      const remaining = lines
        .slice(i + 1)
        .filter(l => /^[\d,]+\.\d{2}$/.test(l))
        .map(l => parseFloat(l.replace(',', '')));
      if (remaining.length >= 3) {
        result.subtotal   = remaining[0];
        result.tax_total  = remaining[1];
        result.total      = remaining[2];
      } else if (remaining.length === 1) {
        result.total = remaining[0];
      }
    }

    // ── Category headers ──
    // All-caps lines like "DAIRY PRODUCTS", "MEATS", "CANNED & DRY"
    if (
      /^[A-Z][A-Z &]+$/.test(line) &&
      line.length >= 4 &&
      line.length <= 40 &&
      !/(SYSCO|KINDRED|CUSTOMER|INVOICE|SIGNED|PAYABLE|PACA|ROUTE|TERMS|DRIVER|MANIFEST|TRUCK|EQUAL|OPPORT|AFFIRM)/i.test(line) &&
      !/^\d/.test(line)
    ) {
      currentCategory = line;
    }

    // ── MISC CHARGES (fuel surcharge, etc.) ──
    if (/^MISC CHARGES/i.test(line)) {
      // "MISC CHARGES CHGS FOR FUEL SURCHARGE .05 6.50 *"
      // or "MISC CHARGES CHGS FOR FUEL SURCHARGE 6.50"
      const tokens = line.replace(/^MISC CHARGES\s*/i, '').trim().split(/\s+/);
      const taxed = tokens[tokens.length - 1] === '*';
      if (taxed) tokens.pop();
      // Last token = amount, second-to-last might be a per-unit rate
      const extended = parseFloat(tokens[tokens.length - 1]);
      if (!isNaN(extended)) {
        // Description is everything before the last 1-2 numeric tokens
        let descEnd = tokens.length - 1;
        if (descEnd > 0 && /^[\d.]+$/.test(tokens[descEnd - 1])) descEnd--;
        const description = tokens.slice(0, descEnd).join(' ');
        result.items.push({
          split_code:        null,
          quantity:          1,
          unit:              null,
          pack_size:         null,
          description:       description || 'Miscellaneous Charge',
          sysco_item_number: null,
          unit_price:        extended,
          tax_amount:        0,
          extended_price:    extended,
          taxable:           taxed,
          category:          'MISC CHARGES',
        });
      }
      continue;
    }

    // ── Regular line items ──
    // Format: [SPLIT] [QTY] [UNIT] [PACK+DESC...] [ITEM_CODE_7DIGIT] [PRICE...] [*?]
    const itemStart = line.match(/^([A-Z])\s+(\d+)\s+([A-Z]+)\s+(.+)$/);
    if (!itemStart) continue;

    const [, split_code, qtyStr, unit, rest] = itemStart;
    const tokens = rest.trim().split(/\s+/);

    const taxed = tokens[tokens.length - 1] === '*';
    if (taxed) tokens.pop();

    // Find the last 7-digit item code, then prices follow it
    let itemCodeIdx = -1;
    for (let j = tokens.length - 1; j >= 0; j--) {
      if (/^\d{7}$/.test(tokens[j])) {
        // Verify that what follows looks like prices (decimals or small integers)
        const after = tokens.slice(j + 1);
        if (after.length >= 1 && after.every(t => /^[\d,]+\.?\d*$/.test(t))) {
          itemCodeIdx = j;
          break;
        }
      }
    }

    if (itemCodeIdx < 0) continue; // can't parse this line

    const priceTokens = tokens.slice(itemCodeIdx + 1);
    const descTokens  = tokens.slice(0, itemCodeIdx);

    const sysco_item_number = tokens[itemCodeIdx];
    const extended_price    = parseFloat(priceTokens[priceTokens.length - 1]);
    const unit_price        = parseFloat(priceTokens[0]);
    const tax_amount        = priceTokens.length === 3 ? parseFloat(priceTokens[1]) : 0;

    // Pack size is the first token of descTokens (often numeric/alphanumeric like "110#AVG" or "2050CT")
    // We store it raw — pdf-parse collapses the "/" in pack fractions
    const pack_size   = descTokens.length > 0 ? descTokens[0] : null;
    const description = descTokens.join(' ');

    result.items.push({
      split_code,
      quantity:          parseInt(qtyStr),
      unit,
      pack_size,
      description,
      sysco_item_number,
      unit_price,
      tax_amount,
      extended_price,
      taxable:           taxed,
      category:          currentCategory,
    });
  }

  return result;
}

// ── DB insert ─────────────────────────────────────────────────────────────────

async function insertInvoice(invoice, pdfBuffer, filename) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Duplicate check
    const dup = await client.query(
      `SELECT id FROM teamtask_hub.receipts WHERE company_id = $1 AND order_number = $2`,
      [COMPANY_ID, invoice.invoice_number]
    );
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return { skipped: true, invoice_number: invoice.invoice_number };
    }

    const receiptRes = await client.query(
      `INSERT INTO teamtask_hub.receipts
         (company_id, order_number, order_date, vendor, total, status, pdf_filename, pdf_data)
       VALUES ($1, $2, $3, 'Sysco', $4, 'pending', $5, $6)
       RETURNING id`,
      [
        COMPANY_ID,
        invoice.invoice_number,
        invoice.delivery_date,
        invoice.total,
        filename,
        pdfBuffer,
      ]
    );
    const receiptId = receiptRes.rows[0].id;

    for (const item of invoice.items) {
      const vendorData = {
        split_code:      item.split_code,
        unit:            item.unit,
        category:        item.category,
        taxable:         item.taxable,
        tax_amount:      item.tax_amount,
        due_date:        invoice.due_date,
        manifest_number: invoice.manifest_number,
        customer_number: invoice.customer_number,
      };

      await client.query(
        `INSERT INTO teamtask_hub.receipt_items
           (receipt_id, description,
            quantity, unit_price, total,
            vendor_item_number, pack_size,
            quantity_cases, unit_size,
            price_per_unit, price_unit_type,
            delivery_date,
            vendor_data, item_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'case',$11,$12,'pending')`,
        [
          receiptId,
          item.description,
          item.quantity,
          item.unit_price,
          item.extended_price,
          item.sysco_item_number,
          item.pack_size,
          item.quantity,
          item.pack_size,
          item.unit_price,
          invoice.delivery_date,
          JSON.stringify(vendorData),
        ]
      );
    }

    await client.query('COMMIT');
    return {
      ok:             true,
      invoice_number: invoice.invoice_number,
      delivery_date:  invoice.delivery_date,
      items:          invoice.items.length,
      total:          invoice.total,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const folder   = process.argv[2];
const debugMode = process.argv.includes('--debug');

if (!folder || !fs.existsSync(folder)) {
  console.error('Usage: node scripts/import-sysco-invoice-pdf.js /path/to/invoices/ [--debug]');
  process.exit(1);
}

const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.pdf'));
console.log(`Found ${files.length} PDF file(s) in ${folder}\n`);

let imported = 0, skipped = 0, failed = 0;

for (const file of files) {
  const filePath  = path.join(folder, file);
  const pdfBuffer = fs.readFileSync(filePath);

  let parsedPdf;
  try {
    parsedPdf = await pdfParse(pdfBuffer);
  } catch (err) {
    console.error(`  PARSE ERROR ${file}: ${err.message}`);
    failed++;
    continue;
  }

  if (debugMode) {
    console.log('=== RAW TEXT ===');
    console.log(parsedPdf.text);
    console.log('=== END ===\n');
  }

  const invoice = parseSyscoInvoice(parsedPdf.text, path.basename(file, '.pdf'));

  console.log(`  ${file}`);
  console.log(`    Invoice #${invoice.invoice_number} | delivery ${invoice.delivery_date} | due ${invoice.due_date} | ${invoice.items.length} items | subtotal $${invoice.subtotal} | tax $${invoice.tax_total} | total $${invoice.total}`);

  if (!invoice.invoice_number) {
    console.error(`    ✗ Could not determine invoice number — skipping`);
    failed++;
    continue;
  }

  if (!invoice.total && invoice.subtotal) {
    invoice.total = (invoice.subtotal || 0) + (invoice.tax_total || 0);
    console.log(`    ⚠ total not parsed, computed from subtotal+tax: $${invoice.total}`);
  }

  try {
    const result = await insertInvoice(invoice, pdfBuffer, file);
    if (result.skipped) {
      console.log(`    ↩ Already imported (invoice #${result.invoice_number})`);
      skipped++;
    } else {
      console.log(`    ✓ Imported — ${result.items} line items, $${result.total}`);
      imported++;
    }
  } catch (err) {
    console.error(`    ✗ DB error: ${err.message}`);
    failed++;
  }
}

await pool.end();
console.log(`\nDone — ${imported} imported, ${skipped} skipped, ${failed} failed`);
