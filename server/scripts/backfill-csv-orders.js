/**
 * One-time backfill: import Amazon receipts that were missed entirely
 * (never ingested via email, because they were placed by an employee
 * whose confirmation email never reached the harvester-monitored inbox).
 *
 * Source data: /tmp/csv_backfill_orders.json, produced by
 * ~/Downloads/prepare_csv_backfill.py from Craig's Amazon Business order
 * export + a folder of downloaded "Printable Order Summary" PDFs.
 *
 * Reuses the exact categorization pipeline normal receipts go through
 * (categorizeLineItems + applyRules) so these backfilled receipts look
 * identical to normally-ingested ones, just tagged source='csv_import'
 * for traceability.
 *
 * Usage: node server/scripts/backfill-csv-orders.js
 */

import fs from 'fs';
import { query } from '../db.js';
import { categorizeLineItems } from '../aiClient.js';
import { applyRules, buildRulesPrompt } from '../rulesEngine.js';
import { getModelForProcess } from '../lib/aiModelSettings.js';

const COMPANY_ID = '8d2df498-b5c0-4f73-94cd-323956036113';
const ORDERS_JSON = '/tmp/csv_backfill_orders.json';

const log = {
  info:  (...a) => console.log('[INFO]', ...a),
  warn:  (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

async function loadContext(companyId) {
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
  const model_categorization = await getModelForProcess(companyId, 'receipt_categorization', 'claude-haiku-4-5');
  return {
    accounts:        accountsRes.rows,
    classes:         classesRes.rows,
    memory:          memoryRes.rows,
    rules:           rulesRes.rows,
    rulesPrompt:      buildRulesPrompt(rulesRes.rows),
    anthropicApiKey: integRes.rows[0]?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null,
    model_categorization,
  };
}

const orders = JSON.parse(fs.readFileSync(ORDERS_JSON, 'utf-8'));
log.info(`Loaded ${orders.length} orders to backfill`);

const ctx = await loadContext(COMPANY_ID);

let created = 0;
let skipped = 0;
let failed = 0;

for (const order of orders) {
  const { order_number, order_date, subtotal, tax, total, payment_instrument, card_last4, pdf_path, items } = order;

  try {
    // Skip if it somehow already exists (unique constraint would catch this
    // anyway, but check first so we don't waste an AI categorization call).
    const dupCheck = await query(
      `SELECT id FROM receipts WHERE company_id = $1 AND order_number = $2`,
      [COMPANY_ID, order_number]
    );
    if (dupCheck.rows.length) {
      log.warn(`${order_number}: already exists — skipping`);
      skipped++;
      continue;
    }

    const pdfBuffer = pdf_path && fs.existsSync(pdf_path) ? fs.readFileSync(pdf_path) : null;

    // Categorize using the same AI pipeline normal receipts go through
    let categorized = items.map((it) => ({ ...it, qbo_account_id: null, qbo_class_id: null, confidence: 0, reasoning: '' }));
    if (items.length && ctx.accounts.length) {
      try {
        const aiResults = await categorizeLineItems(
          items.map((it) => ({ description: it.description, total: it.total })),
          ctx.accounts, ctx.classes, ctx.memory, ctx.rulesPrompt, ctx.anthropicApiKey, ctx.model_categorization, 'Amazon'
        );
        // categorizeLineItems only returns {description, qbo_account_id, qbo_class_id,
        // confidence, reasoning} — merge back quantity/unit_price/total from the
        // original CSV-derived items by index.
        categorized = items.map((it, i) => ({ ...it, ...(aiResults[i] || {}) }));
      } catch (catErr) {
        log.warn(`${order_number}: AI categorization failed — ${catErr.message}`);
      }
    }

    // Apply post-AI category rules, same as the normal ingestion path
    if (ctx.rules.length) {
      categorized = categorized.map((item) => {
        const override = applyRules(item, 'Amazon', ctx.rules, ctx.accounts);
        return { ...item, ...override };
      });
    }

    const receiptRes = await query(
      `INSERT INTO receipts
         (company_id, order_number, order_date, vendor, subtotal, tax, total,
          pdf_filename, card_last4, payment_instrument, pdf_data, source)
       VALUES ($1,$2,$3,'Amazon',$4,$5,$6,$7,$8,$9,$10,'csv_import')
       RETURNING id`,
      [COMPANY_ID, order_number, order_date, subtotal, tax, total,
       pdf_path ? pdf_path.split('/').pop() : null,
       card_last4 || null, payment_instrument || null, pdfBuffer]
    );
    const receiptId = receiptRes.rows[0].id;

    for (const item of categorized) {
      await query(
        `INSERT INTO receipt_items
           (receipt_id, description, quantity, unit_price, total,
            qbo_account_id, qbo_class_id, ai_confidence, vendor_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [receiptId, item.description, item.quantity ?? 1, item.unit_price ?? null,
         item.total ?? null, item.qbo_account_id || null, item.qbo_class_id || null,
         item.confidence ?? null, JSON.stringify({ asin: item.asin, brand: item.brand })]
      );
    }

    log.info(`${order_number}: created — ${items.length} item(s), pdf=${pdfBuffer ? 'yes' : 'no'}, card=${card_last4 || '?'}`);
    created++;
  } catch (err) {
    log.error(`${order_number}: ${err.message}`);
    failed++;
  }
}

log.info(`\nDone — created: ${created}, skipped: ${skipped}, failed: ${failed}`);
process.exit(0);
