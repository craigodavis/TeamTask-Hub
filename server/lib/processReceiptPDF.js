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
import { extractReceiptData, extractReceiptDataFromImage, categorizeLineItems } from '../aiClient.js';
import { applyRules, buildRulesPrompt } from '../rulesEngine.js';
import { getModelForProcess } from './aiModelSettings.js';

const require    = createRequire(import.meta.url);
const pdfParse   = require('pdf-parse');
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'receipts');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Extract the delivery/ship-to address from a Sysco invoice.
 * Sysco PDFs list the ship-to address first (before the bill-to), so the first
 * street-number line in the text identifies which location the order went to.
 * Returns a normalized short form like "616 MAIN ST" or "14253 FROST RD", or null.
 */
function extractDeliveryAddress(pdfText) {
  const lines = pdfText.split('\n').map((l) => l.trim()).filter((l) => l);
  for (const line of lines) {
    // Match lines that start with a street number followed by a street name
    // Skip PO Box lines (those are Sysco's own remit-to address)
    if (/^\d{2,5}\s+[A-Z]/.test(line) && !/^P[\s.]?O[\s.]?\s*BOX/i.test(line)) {
      return line.replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

/**
 * Detect Amazon shipping notification emails masquerading as receipts.
 * These have order numbers and grand totals but no itemized prices.
 * Signals: delivery status tracker language + arrival estimates.
 */
function isShippingNotification(text) {
  const lower = text.toLowerCase();
  // Amazon shipping tracker phrases — appear together only in status emails
  const hasTracker = lower.includes('out for delivery') || lower.includes('arriving tomorrow') || lower.includes('arriving today');
  const hasShipStatus = lower.includes('ordered') && lower.includes('shipped') && lower.includes('delivered');
  return hasTracker || hasShipStatus;
}

/**
 * Load the QBO reference data needed for categorization once per batch.
 * Pass the result into processReceiptPDF to avoid repeated DB queries.
 */
export async function loadReceiptContext(companyId) {
  const [accountsRes, classesRes, memoryRes, rulesRes, integRes] = await Promise.all([
    query(`SELECT qbo_id, name, fully_qualified_name, account_type, account_sub_type, classification, active
           FROM qbo_accounts WHERE company_id = $1`, [companyId]),
    query(`SELECT qbo_id, name, fully_qualified_name, active
           FROM qbo_classes WHERE company_id = $1`, [companyId]),
    query(`SELECT product_pattern, qbo_account_id, qbo_class_id
           FROM product_memory WHERE company_id = $1`, [companyId]),
    query(`SELECT * FROM categorization_rules WHERE company_id = $1 AND active = true ORDER BY priority ASC`, [companyId]),
    query(`SELECT anthropic_api_key FROM company_integrations WHERE company_id = $1`, [companyId]),
  ]);

  const [modelExtraction, modelCategorization, modelAiRules] = await Promise.all([
    getModelForProcess(companyId, 'receipt_extraction', 'claude-haiku-4-5'),
    getModelForProcess(companyId, 'receipt_categorization', 'claude-haiku-4-5'),
    getModelForProcess(companyId, 'ai_rules', 'claude-haiku-4-5'),
  ]);

  return {
    accounts:        accountsRes.rows,
    classes:         classesRes.rows,
    memory:          memoryRes.rows,
    rules:           rulesRes.rows,
    rulesPrompt:     buildRulesPrompt(rulesRes.rows),
    anthropicApiKey: integRes.rows[0]?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null,
    model_extraction:    modelExtraction,
    model_categorization: modelCategorization,
    model_ai_rules:      modelAiRules,
  };
}

/**
 * Process a single receipt buffer (PDF or image) through the full ingestion pipeline.
 *
 * @param {string}  companyId
 * @param {Buffer}  buffer       — raw file bytes (PDF or image)
 * @param {string}  filename     — used for display + stored as pdf_filename
 * @param {object}  ctx          — result of loadReceiptContext()
 * @param {object}  [opts]       — optional: { contentType, qboPurchaseId }
 * @returns {Array}              — array of result objects (see module docblock)
 */
export async function processReceiptPDF(companyId, buffer, filename, ctx, opts = {}) {
  const { accounts, classes, memory, rules, rulesPrompt, anthropicApiKey,
          model_extraction, model_categorization } = ctx;
  const { contentType = 'application/pdf', qboPurchaseId = null, source = 'upload' } = opts;
  const isImage = contentType.startsWith('image/');

  try {
    let pdfText = null;
    let deliveryAddress = null;

    if (isImage) {
      // Image mode — skip pdf-parse, use Claude vision for extraction
    } else {
      // 1. Extract text from PDF
      const parsed = await pdfParse(buffer);
      pdfText = parsed.text;
      deliveryAddress = extractDeliveryAddress(pdfText);

      // 1b. Reject shipping notifications
      if (isShippingNotification(pdfText)) {
        return [{ filename, skipped: true, reason: 'shipping_notification',
                  message: 'PDF appears to be a shipping notification, not an order receipt.' }];
      }
    }

    // 2. Claude extracts structured receipt data — always returns an array of orders
    let orders;
    try {
      orders = isImage
        ? await extractReceiptDataFromImage(buffer, contentType, anthropicApiKey, model_extraction)
        : await extractReceiptData(pdfText, anthropicApiKey, model_extraction);
    } catch (aiErr) {
      return [{ filename, error: `AI extraction failed: ${aiErr.message}` }];
    }

    // Apply QBO purchase ID as order_number fallback (prevents re-importing same QBO purchase)
    if (qboPurchaseId) {
      for (const order of orders) {
        if (!order.order_number) order.order_number = `QBO-${qboPurchaseId}`;
      }
    }

    if (!orders.length) {
      return [{ filename, error: 'Could not extract any order data from PDF.' }];
    }

    // 3–9. Process each order in the PDF as a separate receipt record
    const orderResults = [];
    for (const receiptData of orders) {
      const { order_number, order_date, vendor, subtotal, tax, total, items,
              card_last4, payment_instrument } = receiptData;

      if (!order_number) {
        orderResults.push({ filename, error: 'Could not extract order number from PDF.' });
        continue;
      }

      // 3. Duplicate check
      const dupCheck = await query(
        `SELECT id, status FROM receipts WHERE company_id = $1 AND order_number = $2`,
        [companyId, order_number]
      );
      if (dupCheck.rows.length) {
        orderResults.push({
          filename, order_number,
          skipped: true, reason: 'duplicate',
          existing_status: dupCheck.rows[0].status,
        });
        continue;
      }

      // 4. AI categorization
      let categorized = [];
      if (items?.length && accounts.length) {
        try {
          categorized = await categorizeLineItems(items, accounts, classes, memory, rulesPrompt, anthropicApiKey, model_categorization, vendor);
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

      // 6. Save receipt record — PDF bytes stored in the DB (pdf_data)
      const receiptRes = await query(
        `INSERT INTO receipts
           (company_id, order_number, order_date, vendor, subtotal, tax, total,
            pdf_filename, card_last4, payment_instrument, pdf_data, delivery_address, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [companyId, order_number, order_date || null, vendor || 'Amazon',
         subtotal || null, tax || null, total || null,
         filename, card_last4 || null, payment_instrument || null, buffer,
         deliveryAddress || null, source]
      );
      const receiptId = receiptRes.rows[0].id;

      // Link to the originating QBO purchase (separate UPDATE so regular uploads
      // still work even before the qbo_purchase_id column migration has run)
      if (qboPurchaseId) {
        await query(
          `UPDATE receipts SET qbo_purchase_id = $1 WHERE id = $2`,
          [qboPurchaseId, receiptId]
        ).catch(() => {}); // no-op if column doesn't exist yet
      }

      // 7. Also write PDF to disk as a fallback (legacy path / QBO attach)
      try {
        await fs.promises.writeFile(path.join(UPLOAD_DIR, `${receiptId}.pdf`), buffer);
      } catch (fsErr) {
        console.error('[receipt] failed to save PDF to disk:', fsErr.message);
      }

      // 8. Save line items
      for (const item of categorized) {
        await query(
          `INSERT INTO receipt_items
             (receipt_id, description, quantity, quantity_unit, unit_price, total,
              qbo_account_id, qbo_class_id, ai_confidence, pack)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [receiptId, item.description, item.quantity ?? 1, item.quantity_unit || 'each',
           item.unit_price ?? null, item.total ?? null,
           item.qbo_account_id || null, item.qbo_class_id || null,
           item.confidence ?? null, item.pack ?? null]
        );
      }

      // 9. Upsert into shopping_item_raw with three-layer duplicate detection
      const receiptStatusRes = await query(`SELECT status FROM receipts WHERE id = $1`, [receiptId]);
      const receiptStatus = receiptStatusRes.rows[0]?.status;
      if (receiptStatus !== 'excluded') {
        const purchaseDate = order_date || null;
        const vendorName = vendor || 'Amazon';
        for (const item of categorized) {
          if (!item.description?.trim()) continue;
          const desc = item.description.trim();

          const upsertRes = await query(
            `INSERT INTO shopping_item_raw
               (company_id, description_raw, vendor, last_price, last_purchase_date, purchase_count)
             VALUES ($1, $2, $3, $4, $5, 1)
             ON CONFLICT (company_id, description_raw, vendor) DO UPDATE SET
               last_price         = CASE WHEN EXCLUDED.last_purchase_date >= COALESCE(shopping_item_raw.last_purchase_date, '1900-01-01') THEN EXCLUDED.last_price ELSE shopping_item_raw.last_price END,
               last_purchase_date = GREATEST(shopping_item_raw.last_purchase_date, EXCLUDED.last_purchase_date),
               purchase_count     = shopping_item_raw.purchase_count + 1,
               updated_at         = NOW()
             RETURNING id, (xmax = 0) AS is_new`,
            [companyId, desc, vendorName, item.total ?? null, purchaseDate]
          );

          const rawId = upsertRes.rows[0]?.id;
          const isNew = upsertRes.rows[0]?.is_new;

          if (isNew && rawId) {
            const fuzzyRes = await query(
              `SELECT id, name, similarity(name, $2) AS sim
               FROM shopping_items
               WHERE company_id = $1
                 AND similarity(name, $2) > 0.6
               ORDER BY sim DESC
               LIMIT 3`,
              [companyId, desc]
            ).catch(() => ({ rows: [] }));

            if (fuzzyRes.rows.length > 0) {
              const best = fuzzyRes.rows[0];
              if (best.sim >= 0.85) {
                await query(
                  `UPDATE shopping_item_raw
                   SET fuzzy_match_id = $2, similarity_score = $3
                   WHERE id = $1`,
                  [rawId, best.id, best.sim]
                );
              } else {
                await query(
                  `UPDATE shopping_item_raw SET similarity_score = $2 WHERE id = $1`,
                  [rawId, best.sim]
                );
              }
            }
          }
        }
      }

      orderResults.push({
        filename, order_number, order_date,
        vendor: vendor || 'Amazon', total,
        items: categorized.length, receipt_id: receiptId,
      });
    }

    return orderResults;
  } catch (err) {
    console.error('[receipt] error processing', filename, err);
    return [{ filename, error: err.message }];
  }
}
