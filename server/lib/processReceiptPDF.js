/**
 * processReceiptPDF — shared receipt ingestion logic.
 *
 * Used by both the manual upload endpoint (POST /api/receipts/upload)
 * and the automated Amazon sync (lib/amazonSync.js).
 *
 * Takes a PDF buffer + company context, runs through:
 *   pdf-parse → Claude extraction → AI categorization → rules → DB upsert → disk write
 *
 * Returns the same shape as the per-file result in the upload endpoint:
 *   { filename, order_number, order_date, vendor, total, items, receipt_id }
 * or
 *   { filename, error }          — non-fatal, caller should log and continue
 *   { filename, skipped, ... }   — duplicate
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { extractReceiptData, categorizeLineItems } from '../aiClient.js';
import { applyRules, buildRulesPrompt } from '../rulesEngine.js';

const require    = createRequire(import.meta.url);
const pdfParse   = require('pdf-parse');
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'receipts');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Load the QBO reference data needed for categorization once per batch.
 * Pass the result into processReceiptPDF to avoid repeated DB queries.
 */
export async function loadReceiptContext(companyId) {
  const [accountsRes, classesRes, memoryRes, rulesRes] = await Promise.all([
    query(`SELECT qbo_id, name, fully_qualified_name, account_type, account_sub_type, classification, active
           FROM qbo_accounts WHERE company_id = $1`, [companyId]),
    query(`SELECT qbo_id, name, fully_qualified_name, active
           FROM qbo_classes WHERE company_id = $1`, [companyId]),
    query(`SELECT product_pattern, qbo_account_id, qbo_class_id
           FROM product_memory WHERE company_id = $1`, [companyId]),
    query(`SELECT * FROM categorization_rules WHERE company_id = $1 AND active = true ORDER BY priority ASC`, [companyId]),
  ]);
  return {
    accounts:    accountsRes.rows,
    classes:     classesRes.rows,
    memory:      memoryRes.rows,
    rules:       rulesRes.rows,
    rulesPrompt: buildRulesPrompt(rulesRes.rows),
  };
}

/**
 * Process a single PDF buffer through the full receipt ingestion pipeline.
 *
 * @param {string}  companyId
 * @param {Buffer}  buffer       — raw PDF bytes
 * @param {string}  filename     — used for display + stored as pdf_filename
 * @param {object}  ctx          — result of loadReceiptContext()
 * @returns {object}             — result object (see module docblock)
 */
export async function processReceiptPDF(companyId, buffer, filename, ctx) {
  const { accounts, classes, memory, rules, rulesPrompt } = ctx;

  try {
    // 1. Extract text from PDF
    const parsed  = await pdfParse(buffer);
    const pdfText = parsed.text;

    // 2. Claude extracts structured receipt data
    let receiptData;
    try {
      receiptData = await extractReceiptData(pdfText);
    } catch (aiErr) {
      return { filename, error: `AI extraction failed: ${aiErr.message}` };
    }

    const { order_number, order_date, vendor, subtotal, tax, total, items,
            card_last4, payment_instrument } = receiptData;

    if (!order_number) {
      return { filename, error: 'Could not extract order number from PDF.' };
    }

    // 3. Duplicate check
    const dupCheck = await query(
      `SELECT id, status FROM receipts WHERE company_id = $1 AND order_number = $2`,
      [companyId, order_number]
    );
    if (dupCheck.rows.length) {
      return {
        filename, order_number,
        skipped: true, reason: 'duplicate',
        existing_status: dupCheck.rows[0].status,
      };
    }

    // 4. AI categorization
    let categorized = [];
    if (items?.length && accounts.length) {
      try {
        categorized = await categorizeLineItems(items, accounts, classes, memory, rulesPrompt);
      } catch (catErr) {
        console.error('[receipt] categorization failed:', catErr.message);
        categorized = (items || []).map((it) => ({
          ...it, qbo_account_id: null, qbo_class_id: null, confidence: 0, reasoning: '',
        }));
      }
    } else {
      categorized = (items || []).map((it) => ({
        ...it, qbo_account_id: null, qbo_class_id: null, confidence: 0, reasoning: '',
      }));
    }

    // 5. Apply categorization rules (post-AI override)
    if (rules.length) {
      categorized = categorized.map((item) => {
        const override = applyRules(item, vendor, rules, accounts);
        return { ...item, ...override };
      });
    }

    // 6. Save receipt record
    const receiptRes = await query(
      `INSERT INTO receipts
         (company_id, order_number, order_date, vendor, subtotal, tax, total,
          pdf_filename, card_last4, payment_instrument)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [companyId, order_number, order_date || null, vendor || 'Amazon',
       subtotal || null, tax || null, total || null,
       filename, card_last4 || null, payment_instrument || null]
    );
    const receiptId = receiptRes.rows[0].id;

    // 7. Write PDF to disk (for later QBO attachment)
    try {
      await fs.promises.writeFile(path.join(UPLOAD_DIR, `${receiptId}.pdf`), buffer);
    } catch (fsErr) {
      console.error('[receipt] failed to save PDF to disk:', fsErr.message);
    }

    // 8. Save line items
    for (const item of categorized) {
      await query(
        `INSERT INTO receipt_items
           (receipt_id, description, quantity, unit_price, total,
            qbo_account_id, qbo_class_id, ai_confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [receiptId, item.description, item.quantity ?? 1, item.unit_price ?? null,
         item.total ?? null, item.qbo_account_id || null,
         item.qbo_class_id || null, item.confidence ?? null]
      );
    }

    return {
      filename, order_number, order_date,
      vendor: vendor || 'Amazon', total,
      items: categorized.length, receipt_id: receiptId,
    };
  } catch (err) {
    console.error('[receipt] error processing', filename, err);
    return { filename, error: err.message };
  }
}
