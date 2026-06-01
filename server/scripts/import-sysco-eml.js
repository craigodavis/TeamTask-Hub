/**
 * One-off Sysco .eml import script
 *
 * Reads .eml files from a folder, filters for:
 *   - FROM: shop-noreply@sysco.com
 *   - SUBJECT contains: 'order confirmation'
 *
 * For each match:
 *   1. Parses structured Sysco order data (order #, dates, line items with all fields)
 *   2. Renders HTML → PDF via Playwright and stores bytes in pdf_data
 *   3. Inserts into receipts + receipt_items with all extended columns
 *
 * Usage:
 *   node scripts/import-sysco-eml.js /path/to/eml/folder
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import { chromium } from 'playwright';
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
const SYSCO_FROM = 'shop-noreply@sysco.com';
const SYSCO_SUBJ = 'order confirmation';

// ── HTML → PDF ────────────────────────────────────────────────────────────────

async function htmlToPdf(html) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 30000 });
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
    });
  } finally {
    await browser.close();
  }
}

// ── Sysco text parser ─────────────────────────────────────────────────────────

function parseSyscoText(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const result = {
    order_number:  null,
    order_date:    null,
    delivery_date: null,
    submitted_by:  null,
    total:         null,
    surcharge:     null,
    items:         [],
  };

  // Submitted by
  const subLine = lines.find((l) => /^Submitted by /i.test(l));
  if (subLine) result.submitted_by = subLine.replace(/^Submitted by /i, '').trim();

  // Order number + order date — "Order May 12 2026 12:56 PM | #01418833"
  const orderLine = lines.find((l) => /Order.*#\d+/i.test(l));
  if (orderLine) {
    const numMatch = orderLine.match(/#(\d+)/);
    if (numMatch) result.order_number = numMatch[1];
    const dateMatch = orderLine.match(/(\w+ \d{1,2} \d{4})/);
    if (dateMatch) {
      const d = new Date(dateMatch[1]);
      if (!isNaN(d)) result.order_date = d.toISOString().slice(0, 10);
    }
  }

  // Submitted date (fallback for order date) — "Submitted05/12/2026"
  if (!result.order_date) {
    for (const l of lines) {
      const m = l.match(/Submitted(\d{2})\/(\d{2})\/(\d{4})/i);
      if (m) { result.order_date = `${m[3]}-${m[1]}-${m[2]}`; break; }
    }
  }

  // Delivery date — "Delivery Date05/14/2026" or label + next line
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/Delivery Date(\d{2})\/(\d{2})\/(\d{4})/i);
    if (inline) {
      result.delivery_date = `${inline[3]}-${inline[1]}-${inline[2]}`;
      break;
    }
    if (/^Delivery Date$/i.test(lines[i]) && lines[i + 1]) {
      const d = new Date(lines[i + 1]);
      if (!isNaN(d)) { result.delivery_date = d.toISOString().slice(0, 10); break; }
    }
  }

  // Order total — "Total$691.55"
  for (const l of lines) {
    const m = l.match(/^Total\$([\d,]+\.?\d*)/);
    if (m) { result.total = parseFloat(m[1].replace(',', '')); break; }
  }

  // Credit card surcharge
  for (let i = 0; i < lines.length; i++) {
    if (/surcharge/i.test(lines[i])) {
      const combined = lines[i] + ' ' + (lines[i + 1] || '');
      const m = combined.match(/\$([\d,]+\.?\d*)/);
      if (m) { result.surcharge = parseFloat(m[1].replace(',', '')); break; }
    }
  }

  // Line items
  // Pattern:
  //   Product Name
  //   ITEM_NUMBER | PACK_SIZE | BRAND
  //   QTY CS ($PRICE) or QTY CS ($PRICE/LB)
  //   $LINE_TOTAL

  for (let i = 0; i < lines.length; i++) {
    const itemNumLine = lines[i].match(/^(\d{7})\s*\|\s*(.+?)\s*\|\s*(.+)$/);
    if (!itemNumLine || i === 0) continue;

    const syscoItemNumber = itemNumLine[1];
    const packRaw         = itemNumLine[2].trim(); // e.g. "8/1 LB" or "1/10#AVG"
    const brand           = itemNumLine[3].trim();
    const productName     = lines[i - 1];

    // Parse pack: "8/1 LB" → packCount=8, unitSize="1 LB"
    //             "1/10#AVG" → packCount=1, unitSize="10#AVG"
    let packCount = null, unitSize = null;
    const packMatch = packRaw.match(/^(\d+)\s*\/\s*(.+)$/);
    if (packMatch) {
      packCount = parseInt(packMatch[1]);
      unitSize  = packMatch[2].trim();
    }

    // Quantity + price line: "3 CS ($39.85)" or "1 CS ($2.051LB)"
    let quantityCases = null, priceValue = null, priceUnitType = 'case';
    if (lines[i + 1]) {
      const qtyLine = lines[i + 1].match(/^(\d+)\s*CS\s*\(\$([0-9.]+)(LB|\/LB|LBS?)?\)/i);
      if (qtyLine) {
        quantityCases = parseInt(qtyLine[1]);
        priceValue    = parseFloat(qtyLine[2]);
        priceUnitType = qtyLine[3] ? 'lb' : 'case';
      }
    }

    // Line total
    let lineTotal = null;
    if (lines[i + 2]) {
      const totMatch = lines[i + 2].match(/^\$([\d,]+\.?\d*)$/);
      if (totMatch) lineTotal = parseFloat(totMatch[1].replace(',', ''));
    }

    result.items.push({
      product_name:      productName,
      sysco_item_number: syscoItemNumber,
      pack_size:         packRaw,
      pack_count:        packCount,
      unit_size:         unitSize,
      brand,
      quantity_cases:    quantityCases,
      price_value:       priceValue,
      price_unit_type:   priceUnitType,
      line_total:        lineTotal,
    });

    i += 2;
  }

  return result;
}

// ── DB insert ─────────────────────────────────────────────────────────────────

async function insertOrder(order, pdfBuffer, filename) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Duplicate check
    if (order.order_number) {
      const dup = await client.query(
        `SELECT id FROM teamtask_hub.receipts WHERE company_id = $1 AND order_number = $2`,
        [COMPANY_ID, order.order_number]
      );
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        return { skipped: true, order_number: order.order_number };
      }
    }

    const receiptRes = await client.query(
      `INSERT INTO teamtask_hub.receipts
         (company_id, order_number, order_date, vendor, total, status, pdf_filename, pdf_data)
       VALUES ($1,$2,$3,'Sysco',$4,'pending',$5,$6)
       RETURNING id`,
      [COMPANY_ID, order.order_number, order.order_date,
       order.total, filename, pdfBuffer]
    );
    const receiptId = receiptRes.rows[0].id;

    // Line items with all extended columns
    for (const item of order.items) {
      const description = [item.product_name, item.brand].filter(Boolean).join(' — ');

      const vendorData = {
        sysco_item_number: item.sysco_item_number,
        pack_size:         item.pack_size,
        pack_count:        item.pack_count,
        unit_size:         item.unit_size,
        brand:             item.brand,
        quantity_cases:    item.quantity_cases,
        price_unit_type:   item.price_unit_type,
        delivery_date:     order.delivery_date,
        submitted_by:      order.submitted_by,
      };

      await client.query(
        `INSERT INTO teamtask_hub.receipt_items
           (receipt_id, description,
            quantity, unit_price, total,
            vendor_item_number, pack_size, brand,
            quantity_cases, unit_size,
            price_per_unit, price_unit_type,
            delivery_date, submitted_by,
            vendor_data, item_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending')`,
        [
          receiptId,
          description,
          item.quantity_cases,            // quantity = cases ordered
          item.price_value,               // unit_price = price per case or per lb
          item.line_total,
          item.sysco_item_number,
          item.pack_size,
          item.brand,
          item.quantity_cases,
          item.unit_size,
          item.price_value,
          item.price_unit_type,
          order.delivery_date,
          order.submitted_by,
          JSON.stringify(vendorData),
        ]
      );
    }

    // Credit card surcharge
    if (order.surcharge) {
      await client.query(
        `INSERT INTO teamtask_hub.receipt_items
           (receipt_id, description, quantity, unit_price, total, item_status)
         VALUES ($1,'Credit Card Surcharge',1,$2,$2,'pending')`,
        [receiptId, order.surcharge]
      );
    }

    await client.query('COMMIT');
    return { ok: true, order_number: order.order_number, items: order.items.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const folder = process.argv[2];
if (!folder || !fs.existsSync(folder)) {
  console.error('Usage: node scripts/import-sysco-eml.js /path/to/eml/folder');
  process.exit(1);
}

const files = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.eml'));
console.log(`Found ${files.length} .eml file(s) in ${folder}\n`);

let imported = 0, skipped = 0, failed = 0;

for (const file of files) {
  const raw = fs.readFileSync(path.join(folder, file));

  let parsed;
  try { parsed = await simpleParser(raw); }
  catch (err) { console.error(`  PARSE ERROR ${file}: ${err.message}`); failed++; continue; }

  const from    = (parsed.from?.text || '').toLowerCase();
  const subject = (parsed.subject   || '').toLowerCase();

  if (!from.includes(SYSCO_FROM) || !subject.includes(SYSCO_SUBJ)) {
    console.log(`  SKIP — "${parsed.subject}" from "${parsed.from?.text}"`);
    skipped++;
    continue;
  }

  console.log(`  PROCESSING: "${parsed.subject}"`);

  // Get text for parsing
  let text = parsed.text || '';
  if (!text && parsed.html) {
    text = convert(parsed.html, {
      wordwrap: false,
      selectors: [{ selector: 'a', options: { ignoreHref: true } }],
    });
  }

  const order = parseSyscoText(text);
  console.log(`    Order #${order.order_number} | ${order.items.length} items | $${order.total} | delivery ${order.delivery_date}`);

  // Generate PDF from HTML (or text if no HTML)
  let pdfBuffer;
  try {
    const htmlContent = parsed.html || `<pre>${text}</pre>`;
    pdfBuffer = await htmlToPdf(htmlContent);
    console.log(`    PDF generated (${Math.round(pdfBuffer.length / 1024)}KB)`);
  } catch (err) {
    console.warn(`    PDF generation failed: ${err.message} — continuing without PDF`);
    pdfBuffer = null;
  }

  const filename = `Sysco_${order.order_number || path.basename(file, '.eml')}.pdf`;

  try {
    const result = await insertOrder(order, pdfBuffer, filename);
    if (result.skipped) {
      console.log(`    ↩ Already imported (order #${result.order_number})`);
      skipped++;
    } else {
      console.log(`    ✓ Imported — order #${result.order_number}, ${result.items} line items`);
      imported++;
    }
  } catch (err) {
    console.error(`    ✗ DB error: ${err.message}`);
    failed++;
  }
}

await pool.end();
console.log(`\nDone — ${imported} imported, ${skipped} skipped, ${failed} failed`);
