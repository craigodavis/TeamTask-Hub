import express from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { suggestRulesFromCorrections } from '../aiClient.js';
import { applyRules } from '../rulesEngine.js';
import { qboFindVendor, qboFindPurchases, qboGetPurchase, qboUpdatePurchase, qboAttachFile } from '../qboClient.js';
import { loadReceiptContext, processReceiptPDF } from '../lib/processReceiptPDF.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'receipts');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const router = express.Router();

// Load a receipt's PDF bytes — prefer the DB (pdf_data), fall back to disk
// for legacy receipts uploaded before DB storage existed.
async function loadReceiptPdf(cId, id) {
  const r = await query(
    `SELECT pdf_data, pdf_filename FROM receipts WHERE id = $1 AND company_id = $2`,
    [id, cId]
  );
  if (!r.rows.length) return { notFound: true };
  const row = r.rows[0];
  if (row.pdf_data) {
    return { buffer: row.pdf_data, filename: row.pdf_filename };
  }
  const filePath = path.join(UPLOAD_DIR, `${id}.pdf`);
  if (fs.existsSync(filePath)) {
    return { buffer: fs.readFileSync(filePath), filename: row.pdf_filename };
  }
  return { buffer: null, filename: row.pdf_filename };
}

// Store uploaded files in memory (Buffer) — no disk writes needed
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per file
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted.'));
  },
});

// Process an array of async tasks with a max concurrency limit.
async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── POST /api/receipts/upload ─────────────────────────────────────────────────
// Accept up to 100 PDFs, parse and categorize in parallel (5 at a time).
router.post('/upload', requireAuth, requireOwner, upload.array('pdfs', 100), async (req, res) => {
  const cId = req.companyId;
  if (!req.files?.length) {
    return res.status(400).json({ error: 'No PDF files received.' });
  }

  // Load QBO reference data, product memory, and rules once for all files
  const ctx = await loadReceiptContext(cId);

  // Process up to 5 files concurrently to stay within Claude API rate limits
  const results = await withConcurrency(req.files, 5, async (file) => {
    return processReceiptPDF(cId, file.buffer, file.originalname, ctx);
  });

  res.json({ results });
});

// ── GET /api/receipts ─────────────────────────────────────────────────────────
// List receipts. status=excluded returns receipts where card maps to a personal_use card.
// All other statuses automatically exclude personal-use-card receipts.
router.get('/', requireAuth, requireOwner, async (req, res) => {
  try {
    const { status } = req.query;
    const cId = req.companyId;

    // Subquery that returns card_last4 values flagged as personal use for this company
    const personalSubquery = `
      SELECT card_last4 FROM card_account_mappings
      WHERE company_id = $1 AND personal_use = true`;

    let sql, params;

    if (status === 'excluded') {
      // Only receipts whose card is a personal-use card
      sql = `
        SELECT r.id, r.order_number, r.order_date, r.vendor, r.total, r.status,
               r.card_last4, r.payment_instrument, r.pdf_filename, r.created_at,
               COUNT(ri.id) AS item_count,
               COUNT(ri.id) FILTER (WHERE ri.qbo_account_id IS NULL) AS uncategorized_count,
               STRING_AGG(DISTINCT qa.name, ', ') AS accounts_used,
               STRING_AGG(DISTINCT qc.name, ', ') AS classes_used,
               STRING_AGG(ri.description, ' · ' ORDER BY ri.created_at) AS descriptions
        FROM receipts r
        LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
        LEFT JOIN qbo_accounts qa ON qa.company_id = r.company_id AND qa.qbo_id = ri.qbo_account_id
        LEFT JOIN qbo_classes  qc ON qc.company_id = r.company_id AND qc.qbo_id = ri.qbo_class_id
        WHERE r.company_id = $1
          AND r.card_last4 IN (${personalSubquery})
        GROUP BY r.id
        ORDER BY r.created_at DESC
        LIMIT 200`;
      params = [cId];
    } else {
      // Normal tabs — exclude personal-use-card receipts
      const where = status ? `AND r.status = $2` : '';
      params = [cId];
      if (status) params.push(status);

      sql = `
        SELECT r.id, r.order_number, r.order_date, r.vendor, r.total, r.status,
               r.card_last4, r.payment_instrument, r.pdf_filename, r.created_at,
               COUNT(ri.id) AS item_count,
               COUNT(ri.id) FILTER (WHERE ri.qbo_account_id IS NULL) AS uncategorized_count,
               STRING_AGG(DISTINCT qa.name, ', ') AS accounts_used,
               STRING_AGG(DISTINCT qc.name, ', ') AS classes_used,
               STRING_AGG(ri.description, ' · ' ORDER BY ri.created_at) AS descriptions
        FROM receipts r
        LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
        LEFT JOIN qbo_accounts qa ON qa.company_id = r.company_id AND qa.qbo_id = ri.qbo_account_id
        LEFT JOIN qbo_classes  qc ON qc.company_id = r.company_id AND qc.qbo_id = ri.qbo_class_id
        WHERE r.company_id = $1 ${where}
          AND (r.card_last4 IS NULL OR r.card_last4 NOT IN (${personalSubquery}))
        GROUP BY r.id
        ORDER BY r.created_at DESC
        LIMIT 200`;
    }

    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/receipts/rules ───────────────────────────────────────────────────
// IMPORTANT: must be before /:id routes or Express will treat "rules" as an id.
router.get('/rules', requireAuth, requireOwner, async (req, res) => {
  try {
    const r = await query(
      `SELECT cr.*,
              qa.name AS then_account_name, qa.fully_qualified_name AS then_account_full_name,
              qc.name AS then_class_name
       FROM categorization_rules cr
       LEFT JOIN qbo_accounts qa ON qa.company_id = cr.company_id AND qa.qbo_id = cr.then_account_id
       LEFT JOIN qbo_classes  qc ON qc.company_id = cr.company_id AND qc.qbo_id = cr.then_class_id
       WHERE cr.company_id = $1
       ORDER BY cr.priority ASC, cr.created_at ASC`,
      [req.companyId]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extract individual keywords from a boolean rule expression (splits on OR/AND/parens)
function extractRuleKeywords(expr) {
  if (!expr?.trim()) return [];
  return expr
    .split(/\b(?:OR|AND)\b|\(|\)/i)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 1);
}

// ── POST /api/receipts/rules ──────────────────────────────────────────────────
router.post('/rules', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const {
    name, priority = 100,
    if_description_contains, if_vendor, if_account_type_contains,
    then_account_id, then_class_id, then_clear = false,
    notes, active = true,
    force = false, // set true to bypass conflict warning
  } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Rule name is required.' });

  try {
    // Check for keyword overlap with existing rules (skip if force=true)
    if (!force && if_description_contains) {
      const newKeywords = extractRuleKeywords(if_description_contains);
      if (newKeywords.length) {
        const existing = await query(
          `SELECT id, name, if_description_contains, then_account_id, priority
           FROM categorization_rules WHERE company_id = $1 AND active = true`,
          [cId]
        );
        const conflicts = existing.rows
          .filter(rule => rule.if_description_contains)
          .map(rule => {
            const existingKeywords = extractRuleKeywords(rule.if_description_contains);
            const shared = newKeywords.filter(k => existingKeywords.includes(k));
            return shared.length ? { id: rule.id, name: rule.name, shared_keywords: shared, then_account_id: rule.then_account_id, priority: rule.priority } : null;
          })
          .filter(Boolean);

        if (conflicts.length) {
          return res.status(409).json({
            error: 'keyword_conflict',
            message: `${conflicts.length} existing rule${conflicts.length > 1 ? 's' : ''} already match${conflicts.length === 1 ? 'es' : ''} some of these keywords.`,
            conflicts,
          });
        }
      }
    }

    const r = await query(
      `INSERT INTO categorization_rules
         (company_id, name, priority, if_description_contains, if_vendor, if_account_type_contains,
          then_account_id, then_class_id, then_clear, notes, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [cId, name.trim(), priority,
       if_description_contains || null, if_vendor || null, if_account_type_contains || null,
       then_account_id || null, then_class_id || null, then_clear, notes || null, active]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/receipts/rules/:id ────────────────────────────────────────────
router.patch('/rules/:id', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { id } = req.params;
  const {
    name, priority,
    if_description_contains, if_vendor, if_account_type_contains,
    then_account_id, then_class_id, then_clear,
    notes, active,
  } = req.body;

  try {
    const r = await query(
      `UPDATE categorization_rules SET
         name                    = COALESCE($3, name),
         priority                = COALESCE($4, priority),
         if_description_contains = $5,
         if_vendor               = $6,
         if_account_type_contains = $7,
         then_account_id         = $8,
         then_class_id           = $9,
         then_clear              = COALESCE($10, then_clear),
         notes                   = $11,
         active                  = COALESCE($12, active),
         updated_at              = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, cId,
       name || null, priority || null,
       if_description_contains || null, if_vendor || null, if_account_type_contains || null,
       then_account_id || null, then_class_id || null,
       then_clear ?? null, notes || null, active ?? null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Rule not found.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/receipts/rules/:id ───────────────────────────────────────────
router.delete('/rules/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    await query(`DELETE FROM categorization_rules WHERE id = $1 AND company_id = $2`, [req.params.id, req.companyId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/receipts/reapply-all-rules ─────────────────────────────────────
// Re-run active rules against ALL pending items across ALL pending receipts.
router.post('/reapply-all-rules', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  try {
    const [receiptsRes, accountsRes, rulesRes] = await Promise.all([
      query(`SELECT id, vendor FROM receipts WHERE company_id = $1 AND status IN ('pending','reviewed','imported')`, [cId]),
      query(`SELECT qbo_id, name, account_type FROM qbo_accounts WHERE company_id = $1`, [cId]),
      query(`SELECT * FROM categorization_rules WHERE company_id = $1 AND active = true ORDER BY priority ASC`, [cId]),
    ]);
    const accounts = accountsRes.rows;
    const rules = rulesRes.rows;
    let itemsUpdated = 0;
    let receiptsAffected = 0;

    for (const receipt of receiptsRes.rows) {
      const itemsRes = await query(
        `SELECT * FROM receipt_items WHERE receipt_id = $1`,
        [receipt.id]
      );
      let changed = 0;
      for (const item of itemsRes.rows) {
        const override = applyRules(item, receipt.vendor, rules, accounts);
        if (override.rule_applied || override.qbo_account_id !== item.qbo_account_id || override.qbo_class_id !== item.qbo_class_id) {
          await query(
            `UPDATE receipt_items SET qbo_account_id = $2, qbo_class_id = $3, rule_applied = $4 WHERE id = $1`,
            [item.id, override.qbo_account_id, override.qbo_class_id, override.rule_applied || null]
          );
          changed++;
        }
      }
      if (changed > 0) { itemsUpdated += changed; receiptsAffected++; }
    }

    res.json({ ok: true, items_updated: itemsUpdated, receipts_affected: receiptsAffected, receipts_checked: receiptsRes.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/receipts/categorize-all ────────────────────────────────────────
// Run full AI categorization (+ AI condition rules) on ALL pending receipts
// that have uncategorized line items. Expensive — runs once to bootstrap.
router.post('/categorize-all', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  try {
    const [receiptsRes, accountsRes, classesRes, memoryRes, rulesRes, integRes] = await Promise.all([
      query(`SELECT r.id, r.vendor FROM receipts r WHERE r.company_id = $1 AND r.status = 'pending'
             AND EXISTS (SELECT 1 FROM receipt_items ri WHERE ri.receipt_id = r.id AND ri.qbo_account_id IS NULL)`, [cId]),
      query(`SELECT qbo_id, name, fully_qualified_name, account_type, account_sub_type, classification, active FROM qbo_accounts WHERE company_id = $1`, [cId]),
      query(`SELECT qbo_id, name, fully_qualified_name, active FROM qbo_classes WHERE company_id = $1`, [cId]),
      query(`SELECT product_pattern, qbo_account_id, qbo_class_id FROM product_memory WHERE company_id = $1`, [cId]),
      query(`SELECT * FROM categorization_rules WHERE company_id = $1 AND active = true ORDER BY priority ASC`, [cId]),
      query(`SELECT anthropic_api_key FROM company_integrations WHERE company_id = $1`, [cId]),
    ]);

    const apiKey = integRes.rows[0]?.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'Anthropic API key not configured in Settings → Integrations' });

    const { categorizeLineItems } = await import('../aiClient.js');
    const { applyRulesAsync, buildRulesPrompt } = await import('../rulesEngine.js');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const getClient = () => new Anthropic({ apiKey });

    const accounts   = accountsRes.rows;
    const classes    = classesRes.rows;
    const memory     = memoryRes.rows;
    const rules      = rulesRes.rows;
    const rulesPrompt = buildRulesPrompt(rules);

    let itemsUpdated = 0, receiptsProcessed = 0;

    for (const receipt of receiptsRes.rows) {
      const itemsRes = await query(
        `SELECT * FROM receipt_items WHERE receipt_id = $1 AND qbo_account_id IS NULL`,
        [receipt.id]
      );
      if (!itemsRes.rows.length) continue;

      // First apply AI condition rules, then run general AI categorization
      let categorized;
      try {
        categorized = await categorizeLineItems(itemsRes.rows, accounts, classes, memory, rulesPrompt, apiKey);
      } catch {
        categorized = itemsRes.rows.map((it) => ({ ...it, qbo_account_id: null, qbo_class_id: null, confidence: 0, reasoning: '' }));
      }

      for (let i = 0; i < itemsRes.rows.length; i++) {
        const item = { ...itemsRes.rows[i], ...categorized[i] };
        // Apply rules (including AI condition rules) on top of AI suggestion
        const override = await applyRulesAsync(item, receipt.vendor, rules, accounts, getClient);
        await query(
          `UPDATE receipt_items SET qbo_account_id = $2, qbo_class_id = $3, rule_applied = $4,
           ai_confidence = $5 WHERE id = $1`,
          [itemsRes.rows[i].id,
           override.qbo_account_id ?? categorized[i]?.qbo_account_id ?? null,
           override.qbo_class_id   ?? categorized[i]?.qbo_class_id   ?? null,
           override.rule_applied   ?? null,
           categorized[i]?.confidence ?? null]
        );
        itemsUpdated++;
      }
      receiptsProcessed++;
    }

    res.json({ ok: true, receipts_processed: receiptsProcessed, items_updated: itemsUpdated });
  } catch (err) {
    console.error('[categorize-all]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/receipts/suggest-rule ──────────────────────────────────────────
// AI suggests categorization rules based on user corrections.
// Body: { corrections: [{ description, total, old_account_id, new_account_id, new_class_id }] }
router.post('/suggest-rule', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { corrections } = req.body;
  if (!Array.isArray(corrections) || !corrections.length) return res.json({ suggestions: [] });
  try {
    const [accountsRes, integRes] = await Promise.all([
      query(`SELECT qbo_id, name, fully_qualified_name, account_type, classification FROM qbo_accounts WHERE company_id = $1`, [cId]),
      query(`SELECT anthropic_api_key FROM company_integrations WHERE company_id = $1`, [cId]),
    ]);
    const anthropicApiKey = integRes.rows[0]?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null;
    const suggestions = await suggestRulesFromCorrections(corrections, accountsRes.rows, anthropicApiKey);
    res.json({ suggestions });
  } catch (err) {
    console.error('[suggest-rule]', err.message);
    res.json({ suggestions: [] }); // non-fatal
  }
});

// ── GET /api/receipts/:id ─────────────────────────────────────────────────────
// Single receipt with all line items + account/class names.
router.get('/:id', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { id } = req.params;
  try {
    const rr = await query(
      `SELECT * FROM receipts WHERE id = $1 AND company_id = $2`,
      [id, cId]
    );
    if (!rr.rows.length) return res.status(404).json({ error: 'Receipt not found.' });

    const items = await query(
      `SELECT ri.*,
              qa.name AS account_name, qa.fully_qualified_name AS account_full_name,
              qc.name AS class_name
       FROM receipt_items ri
       LEFT JOIN qbo_accounts qa ON qa.company_id = $2 AND qa.qbo_id = ri.qbo_account_id
       LEFT JOIN qbo_classes  qc ON qc.company_id = $2 AND qc.qbo_id = ri.qbo_class_id
       WHERE ri.receipt_id = $1
       ORDER BY ri.created_at`,
      [id, cId]
    );

    res.json({ ...rr.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/receipts/:id/pdf ─────────────────────────────────────────────────
// Serve the stored receipt PDF inline so it can be viewed in the browser.
router.get('/:id/pdf', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { id } = req.params;
  try {
    const { notFound, buffer, filename } = await loadReceiptPdf(cId, id);
    if (notFound) return res.status(404).json({ error: 'Receipt not found.' });
    if (!buffer) return res.status(404).json({ error: 'PDF not available for this receipt.' });

    const downloadName = (filename || `receipt-${id}.pdf`).replace(/[^\w.\-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/receipts/:id/process ────────────────────────────────────────────
// Run AI extraction on a receipt that was imported by Harvester (has raw_path but no items).
router.post('/:id/process', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { id } = req.params;
  try {
    const rr = await query(`SELECT * FROM receipts WHERE id = $1 AND company_id = $2`, [id, cId]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Receipt not found.' });
    const receipt = rr.rows[0];

    if (!receipt.raw_path) {
      return res.status(400).json({ error: 'No raw PDF path on this receipt.' });
    }

    if (!fs.existsSync(receipt.raw_path)) {
      return res.status(400).json({ error: `PDF file not found at: ${receipt.raw_path}` });
    }

    const pdfBuffer = fs.readFileSync(receipt.raw_path);
    const filename = receipt.pdf_filename || path.basename(receipt.raw_path);

    // Delete the stub receipt (no items) so processReceiptPDF can create a fresh one with AI extraction
    await query(`DELETE FROM receipts WHERE id = $1`, [id]);

    const ctx = await loadReceiptContext(cId);
    const result = await processReceiptPDF(cId, pdfBuffer, filename, ctx);

    if (result.skipped) {
      return res.status(409).json({ error: 'Receipt already exists with items.' });
    }
    if (result.error) {
      return res.status(500).json({ error: result.error });
    }

    // Return the newly created receipt with items
    const newReceipt = await query(`SELECT * FROM receipts WHERE company_id = $1 AND order_number = $2`, [cId, result.order_number]);
    if (!newReceipt.rows.length) return res.status(500).json({ error: 'Receipt created but could not be retrieved.' });

    const newId = newReceipt.rows[0].id;
    const items = await query(`SELECT ri.*, qa.name AS account_name, qa.fully_qualified_name AS account_full_name, qc.name AS class_name
      FROM receipt_items ri
      LEFT JOIN qbo_accounts qa ON qa.company_id = $2 AND qa.qbo_id = ri.qbo_account_id
      LEFT JOIN qbo_classes  qc ON qc.company_id = $2 AND qc.qbo_id = ri.qbo_class_id
      WHERE ri.receipt_id = $1 ORDER BY ri.created_at`, [newId, cId]);

    res.json({ ...newReceipt.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/receipts/:id/accept-all ────────────────────────────────────────
// Accept all pending items on this receipt and mark it reviewed.
// Rules are applied immediately before accepting so the latest rules take effect.
router.post('/:id/accept-all', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { id } = req.params;
  try {
    const rr = await query(`SELECT id, vendor FROM receipts WHERE id = $1 AND company_id = $2`, [id, cId]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Receipt not found.' });
    const vendor = rr.rows[0].vendor;

    // Load pending items (categories already set — don't re-apply rules here,
    // that would clobber any manual changes the user made before accepting)
    const pendingRes = await query(
      `SELECT * FROM receipt_items WHERE receipt_id = $1 AND item_status = 'pending'`, [id]
    );

    // Accept all pending items
    const updated = await query(
      `UPDATE receipt_items SET item_status = 'accepted'
       WHERE receipt_id = $1 AND item_status = 'pending'
       RETURNING id, description, qbo_account_id, qbo_class_id`,
      [id]
    );

    // Update product memory for each accepted item
    for (const item of updated.rows) {
      if (item.description) {
        const pattern = item.description.toLowerCase().trim().slice(0, 200);
        await query(
          `INSERT INTO product_memory (company_id, product_pattern, qbo_account_id, qbo_class_id, usage_count, last_used_at)
           VALUES ($1, $2, $3, $4, 1, NOW())
           ON CONFLICT (company_id, product_pattern) DO UPDATE
             SET qbo_account_id = $3,
                 qbo_class_id   = $4,
                 usage_count    = product_memory.usage_count + 1,
                 last_used_at   = NOW()`,
          [cId, pattern, item.qbo_account_id || null, item.qbo_class_id || null]
        );
      }
    }

    await query(`UPDATE receipts SET status = 'reviewed' WHERE id = $1`, [id]);
    res.json({ ok: true, accepted: updated.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/receipts/:id/reapply-rules ─────────────────────────────────────
// Re-run rules against all pending items on this receipt (does not re-run AI).
router.post('/:id/reapply-rules', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { id } = req.params;

  try {
    const rr = await query(`SELECT vendor FROM receipts WHERE id = $1 AND company_id = $2`, [id, cId]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Receipt not found.' });
    const vendor = rr.rows[0].vendor;

    const [itemsRes, accountsRes, rulesRes] = await Promise.all([
      query(`SELECT * FROM receipt_items WHERE receipt_id = $1`, [id]),
      query(`SELECT qbo_id, name, account_type FROM qbo_accounts WHERE company_id = $1`, [cId]),
      query(`SELECT * FROM categorization_rules WHERE company_id = $1 AND active = true ORDER BY priority ASC`, [cId]),
    ]);

    const accounts = accountsRes.rows;
    const rules = rulesRes.rows;
    let updated = 0;

    for (const item of itemsRes.rows) {
      const override = applyRules(item, vendor, rules, accounts);
      if (override.rule_applied || override.qbo_account_id !== item.qbo_account_id || override.qbo_class_id !== item.qbo_class_id) {
        await query(
          `UPDATE receipt_items SET qbo_account_id = $2, qbo_class_id = $3, rule_applied = $4 WHERE id = $1`,
          [item.id, override.qbo_account_id, override.qbo_class_id, override.rule_applied || null]
        );
        updated++;
      }
    }

    res.json({ ok: true, updated, total: itemsRes.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/receipts/:id/items ─────────────────────────────────────────────
// Save user's accept/reject/edit decisions for line items.
// Body: { items: [{ id, item_status, qbo_account_id, qbo_class_id }] }
router.patch('/:id/items', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { id } = req.params;
  const { items } = req.body;

  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array.' });

  try {
    // Verify receipt belongs to this company
    const rr = await query(`SELECT id FROM receipts WHERE id = $1 AND company_id = $2`, [id, cId]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Receipt not found.' });

    for (const item of items) {
      await query(
        `UPDATE receipt_items
         SET item_status = COALESCE($2, item_status),
             qbo_account_id = $3,
             qbo_class_id = $4
         WHERE id = $1 AND receipt_id = $5`,
        [item.id, item.item_status || null, item.qbo_account_id || null, item.qbo_class_id || null, id]
      );

      // Update product memory for accepted items
      if (item.item_status === 'accepted' && item.description) {
        const pattern = item.description.toLowerCase().trim().slice(0, 200);
        await query(
          `INSERT INTO product_memory (company_id, product_pattern, qbo_account_id, qbo_class_id, usage_count, last_used_at)
           VALUES ($1, $2, $3, $4, 1, NOW())
           ON CONFLICT (company_id, product_pattern) DO UPDATE
             SET qbo_account_id = $3,
                 qbo_class_id   = $4,
                 usage_count    = product_memory.usage_count + 1,
                 last_used_at   = NOW()`,
          [cId, pattern, item.qbo_account_id || null, item.qbo_class_id || null]
        );
      }
    }

    // Mark receipt as reviewed if all items have a decision
    const pending = await query(
      `SELECT COUNT(*) FROM receipt_items WHERE receipt_id = $1 AND item_status = 'pending'`,
      [id]
    );
    if (parseInt(pending.rows[0].count, 10) === 0) {
      await query(`UPDATE receipts SET status = 'reviewed' WHERE id = $1`, [id]);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/receipts/:id ──────────────────────────────────────────────────
// Remove a receipt and its items. Also deletes the saved PDF if present.
router.delete('/:id', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { id } = req.params;
  try {
    const rr = await query(`SELECT id FROM receipts WHERE id = $1 AND company_id = $2`, [id, cId]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Receipt not found.' });

    await query(`DELETE FROM receipts WHERE id = $1 AND company_id = $2`, [id, cId]);

    // Clean up PDF from disk if present
    const pdfPath = path.join(UPLOAD_DIR, `${id}.pdf`);
    await fs.promises.unlink(pdfPath).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/receipts/export/payment-accounts ─────────────────────────────────
// Return Credit Card + Bank type accounts and the saved default.
router.get('/export/payment-accounts', requireAuth, requireOwner, async (req, res) => {
  try {
    const [accts, integ] = await Promise.all([
      query(
        `SELECT qbo_id, name, fully_qualified_name, account_type
         FROM qbo_accounts
         WHERE company_id = $1
           AND account_type IN ('Credit Card', 'Bank')
           AND active = true
         ORDER BY account_type, fully_qualified_name`,
        [req.companyId]
      ),
      query(
        `SELECT qbo_payment_account_id FROM company_integrations WHERE company_id = $1`,
        [req.companyId]
      ),
    ]);
    res.json({
      accounts: accts.rows,
      default_account_id: integ.rows[0]?.qbo_payment_account_id || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/receipts/export/payment-accounts ────────────────────────────────
// Save default payment account.
router.post('/export/payment-accounts', requireAuth, requireOwner, async (req, res) => {
  const { account_id } = req.body;
  try {
    await query(
      `UPDATE company_integrations SET qbo_payment_account_id = $2 WHERE company_id = $1`,
      [req.companyId, account_id || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Match a CSV item title against a list of receipt line items by keyword overlap.
 * Returns the receipt item with the most words in common with the CSV title.
 * Falls back to the first item if no words match.
 */
function matchItemToReceiptCategory(csvTitle, receiptItems) {
  if (!receiptItems.length) return null;
  if (receiptItems.length === 1) return receiptItems[0];

  const titleWords = csvTitle.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  let bestScore = -1;
  let bestItem = receiptItems[0];

  for (const ri of receiptItems) {
    const descWords = ri.description.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const score = descWords.filter((w) =>
      titleWords.some((tw) => tw.includes(w) || w.includes(tw))
    ).length;
    if (score > bestScore) { bestScore = score; bestItem = ri; }
  }
  return bestItem;
}

// ── POST /api/receipts/export/preview ────────────────────────────────────────
// For each reviewed (un-exported) receipt, produce one preview row per shipment
// when Amazon order history data is available (Option C), or one row per receipt
// when it isn't.
// Body: { payment_account_id }
router.post('/export/preview', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { payment_account_id } = req.body;

  if (!payment_account_id) {
    return res.status(400).json({ error: 'payment_account_id is required.' });
  }

  try {
    // All reviewed receipts not yet exported, excluding personal-use cards
    const receiptsRes = await query(
      `SELECT id, order_number, order_date, vendor, total, card_last4, payment_instrument
       FROM receipts
       WHERE company_id = $1 AND status = 'reviewed' AND qbo_transaction_id IS NULL
         AND (card_last4 IS NULL OR card_last4 NOT IN (
           SELECT card_last4 FROM card_account_mappings
           WHERE company_id = $1 AND personal_use = true
         ))
       ORDER BY order_date DESC`,
      [cId]
    );

    // Load card → QBO account mappings for this company
    const mappingsRes = await query(
      `SELECT card_last4, qbo_account_id FROM card_account_mappings WHERE company_id = $1`,
      [cId]
    );
    const cardAccountMap = new Map(mappingsRes.rows.map((r) => [r.card_last4, r.qbo_account_id]));

    // Load accepted line items for all these receipts at once
    const receiptIds = receiptsRes.rows.map((r) => r.id);
    let allReceiptItems = [];
    if (receiptIds.length > 0) {
      const placeholders = receiptIds.map((_, i) => `$${i + 2}`).join(',');
      const riRes = await query(
        `SELECT ri.receipt_id, ri.description, ri.total, ri.qbo_account_id, ri.qbo_class_id,
                qa.name AS account_name
         FROM receipt_items ri
         LEFT JOIN qbo_accounts qa ON qa.company_id = $1 AND qa.qbo_id = ri.qbo_account_id
         WHERE ri.receipt_id IN (${placeholders})
           AND ri.item_status = 'accepted'
           AND ri.qbo_account_id IS NOT NULL
         ORDER BY ri.receipt_id, ri.created_at`,
        [cId, ...receiptIds]
      );
      allReceiptItems = riRes.rows;
    }
    // Map receipt_id → accepted items[]
    const receiptItemsMap = new Map();
    for (const item of allReceiptItems) {
      if (!receiptItemsMap.has(item.receipt_id)) receiptItemsMap.set(item.receipt_id, []);
      receiptItemsMap.get(item.receipt_id).push(item);
    }

    // Load Amazon payment + item data for all order numbers at once
    const orderNumbers = receiptsRes.rows.map((r) => r.order_number).filter(Boolean);
    // amazonPaymentsMap: order_number → [{ payment_id, payment_reference_id, payment_date, payment_amount, items[] }]
    const amazonPaymentsMap = new Map();
    if (orderNumbers.length > 0) {
      const apRes = await query(
        `SELECT ap.id AS payment_id, ap.payment_reference_id,
                ap.payment_date, ap.payment_amount,
                UNNEST(ap.order_ids) AS order_id
         FROM amazon_payments ap
         WHERE ap.company_id = $1 AND ap.order_ids && $2::text[]
         ORDER BY ap.payment_date`,
        [cId, orderNumbers]
      );
      // Collect unique payment IDs to fetch items
      const paymentIds = [...new Set(apRes.rows.map((r) => r.payment_id))];
      let allAmazonItems = [];
      if (paymentIds.length > 0) {
        const ph = paymentIds.map((_, i) => `$${i + 1}`).join(',');
        const aiRes = await query(
          `SELECT payment_id, order_id, asin, title, item_subtotal, item_tax, item_total
           FROM amazon_payment_items WHERE payment_id IN (${ph})
           ORDER BY payment_id, id`,
          paymentIds
        );
        allAmazonItems = aiRes.rows;
      }
      const itemsByPayment = new Map();
      for (const item of allAmazonItems) {
        if (!itemsByPayment.has(item.payment_id)) itemsByPayment.set(item.payment_id, []);
        itemsByPayment.get(item.payment_id).push(item);
      }

      for (const row of apRes.rows) {
        if (!amazonPaymentsMap.has(row.order_id)) amazonPaymentsMap.set(row.order_id, []);
        // Avoid duplicate payment entries (UNNEST produces one row per order_id per payment)
        const existing = amazonPaymentsMap.get(row.order_id);
        if (!existing.find((e) => e.payment_id === row.payment_id)) {
          existing.push({
            payment_id: row.payment_id,
            payment_reference_id: row.payment_reference_id,
            payment_date: row.payment_date,
            payment_amount: parseFloat(row.payment_amount),
            // Items belonging to THIS order_id within this payment
            items: (itemsByPayment.get(row.payment_id) || []).filter(
              (i) => i.order_id === row.order_id
            ),
          });
        }
      }
    }

    // Seed used QBO IDs from already-exported receipts
    const usedRes = await query(
      `SELECT qbo_transaction_id FROM receipts
       WHERE company_id = $1 AND qbo_transaction_id IS NOT NULL`,
      [cId]
    );
    const usedQboIds = new Set(usedRes.rows.map((r) => r.qbo_transaction_id));

    const previews = [];

    for (const receipt of receiptsRes.rows) {
      const receiptItems = receiptItemsMap.get(receipt.id) || [];
      const amazonShipments = amazonPaymentsMap.get(receipt.order_number);
      const hasAmazonData = amazonShipments && amazonShipments.length > 0;

      if (hasAmazonData) {
        // ── Option C: one preview row per shipment ──────────────────────────
        const totalShipments = amazonShipments.length;

        for (let si = 0; si < amazonShipments.length; si++) {
          const shipment = amazonShipments[si];
          const shipmentKey = `${receipt.id}:${shipment.payment_reference_id}`;

          // Build line items for this shipment: match each CSV item to a receipt category
          const shipmentLineItems = shipment.items.map((csvItem) => {
            const matched = matchItemToReceiptCategory(csvItem.title, receiptItems);
            return {
              title: csvItem.title,
              item_total: parseFloat(csvItem.item_total) || 0,
              description: matched?.description || csvItem.title.slice(0, 100),
              qbo_account_id: matched?.qbo_account_id || null,
              qbo_class_id: matched?.qbo_class_id || null,
              account_name: matched?.account_name || null,
            };
          });

          // If no item-level data, fall back to receipt items scaled to shipment amount
          const lineItems = shipmentLineItems.length > 0
            ? shipmentLineItems
            : receiptItems.map((ri) => ({
                title: ri.description,
                item_total: parseFloat(ri.total) || 0,
                description: ri.description,
                qbo_account_id: ri.qbo_account_id,
                qbo_class_id: ri.qbo_class_id,
                account_name: ri.account_name,
              }));

          // Resolve which QBO account to search: per-card mapping > global fallback
          const accountId = (receipt.card_last4 && cardAccountMap.get(receipt.card_last4))
            || payment_account_id;

          // Search QBO for a Purchase matching this shipment's date + amount
          let match = null;
          let confidence = 'none';
          let daysDiff = null;
          let reason = null;

          try {
            if (!shipment.payment_date) {
              reason = 'Shipment has no payment date';
            } else {
              // Search by exact amount, payment date → +7 days (forward only).
              // QBO transaction date is always AFTER Amazon's charge date
              // (bank posts 1-4 days later), so we never look backwards.
              const matches = await qboFindPurchases(
                cId, accountId, shipment.payment_amount,
                shipment.payment_date, 10, true
              );
              const available = matches.filter((m) => !usedQboIds.has(m.Id));
              if (available.length) {
                const best = available[0];
                usedQboIds.add(best.Id);
                daysDiff = Math.abs(
                  (new Date(best.TxnDate) - new Date(shipment.payment_date)) / 86400000
                );
                const currentLines = (best.Line || []).filter(
                  (l) => l.DetailType === 'AccountBasedExpenseLineDetail'
                );
                const currentCategories = [...new Set(
                  currentLines.map((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.name).filter(Boolean)
                )].join(', ');
                match = {
                  qbo_id:        best.Id,
                  txn_date:      best.TxnDate,
                  total:         best.TotalAmt,
                  vendor:        best.EntityRef?.name || '',
                  memo:          best.PrivateNote || '',
                  current_categories: currentCategories || 'Uncategorized',
                  qbo_account_id:   best.AccountRef?.value || null,
                  qbo_account_name: best.AccountRef?.name || null,
                  account_match: !accountId || best.AccountRef?.value === accountId,
                };
                confidence = daysDiff === 0 ? 'high' : daysDiff <= 2 ? 'medium' : 'low';
              } else {
                reason = `No QBO transaction for $${shipment.payment_amount.toFixed(2)} within 10 days of ${shipment.payment_date} — try manual search`;
              }
            }
          } catch (err) {
            reason = err.message;
          }

          previews.push({
            shipment_key: shipmentKey,
            receipt,
            shipment: {
              payment_reference_id: shipment.payment_reference_id,
              payment_date: shipment.payment_date,
              payment_amount: shipment.payment_amount,
              line_items: lineItems,
            },
            card_last4: receipt.card_last4,
            payment_instrument: receipt.payment_instrument,
            account_id_used: accountId,
            match,
            confidence,
            days_diff: daysDiff,
            reason,
            is_first_shipment: si === 0,
            total_shipments: totalShipments,
            amazon_data: true,
          });
        }
      } else {
        // ── Fallback: one row per receipt (no Amazon data) ──────────────────
        const shipmentKey = `${receipt.id}:`;

        if (!receipt.total || !receipt.order_date) {
          previews.push({
            shipment_key: shipmentKey,
            receipt, shipment: null, match: null, confidence: 'none',
            reason: 'Missing total or date', amazon_data: false,
            is_first_shipment: true, total_shipments: 1,
          });
          continue;
        }

        try {
          const accountId = (receipt.card_last4 && cardAccountMap.get(receipt.card_last4))
            || payment_account_id;
          const matches = await qboFindPurchases(
            cId, accountId, receipt.total, receipt.order_date, 30
          );
          const available = matches.filter((m) => !usedQboIds.has(m.Id));
          if (!available.length) {
            previews.push({
              shipment_key: shipmentKey,
              receipt, shipment: null, match: null, confidence: 'none',
              reason: 'No unused QBO transaction found', amazon_data: false,
              is_first_shipment: true, total_shipments: 1,
            });
            continue;
          }
          const best = available[0];
          usedQboIds.add(best.Id);
          const daysDiff = Math.abs(
            (new Date(best.TxnDate) - new Date(receipt.order_date)) / 86400000
          );
          const currentLines = (best.Line || []).filter(
            (l) => l.DetailType === 'AccountBasedExpenseLineDetail'
          );
          const currentCategories = [...new Set(
            currentLines.map((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.name).filter(Boolean)
          )].join(', ');
          previews.push({
            shipment_key: shipmentKey,
            receipt,
            shipment: null,
            match: {
              qbo_id:        best.Id,
              txn_date:      best.TxnDate,
              total:         best.TotalAmt,
              vendor:        best.EntityRef?.name || '',
              memo:          best.PrivateNote || '',
              current_categories: currentCategories || 'Uncategorized',
              qbo_account_id:   best.AccountRef?.value || null,
              qbo_account_name: best.AccountRef?.name || null,
              account_match: !accountId || best.AccountRef?.value === accountId,
            },
            confidence: daysDiff === 0 ? 'high' : daysDiff <= 2 ? 'medium' : 'low',
            days_diff: daysDiff,
            amazon_data: false,
            is_first_shipment: true,
            total_shipments: 1,
          });
        } catch (err) {
          previews.push({
            shipment_key: shipmentKey,
            receipt, shipment: null, match: null, confidence: 'none',
            reason: err.message, amazon_data: false,
            is_first_shipment: true, total_shipments: 1,
          });
        }
      }
    }

    res.json({ previews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/receipts/export/search ─────────────────────────────────────────
// Search QBO for purchases near a date to allow manual linking.
// Body: { payment_account_id, center_date, day_window? }
router.post('/export/search', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { payment_account_id, center_date, day_window = 7 } = req.body;
  if (!center_date) return res.status(400).json({ error: 'center_date is required.' });

  try {
    const purchases = await qboFindPurchases(cId, payment_account_id, null, center_date, day_window);
    // Return summary of each purchase for the picker UI
    const results = purchases.map((p) => {
      const currentLines = (p.Line || []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail');
      const currentCategories = [...new Set(
        currentLines.map((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.name).filter(Boolean)
      )].join(', ');
      return {
        qbo_id:             p.Id,
        txn_date:           p.TxnDate,
        total:              p.TotalAmt,
        vendor:             p.EntityRef?.name || '',
        current_categories: currentCategories || 'Uncategorized',
      };
    }).sort((a, b) => new Date(b.txn_date) - new Date(a.txn_date));

    res.json({ purchases: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/receipts/export/confirm ────────────────────────────────────────
// Update selected QBO transactions with split line items.
// Each export entry = one QBO transaction update (one shipment or one receipt).
// Body: { exports: [{ receipt_id, qbo_transaction_id, line_items?, is_first_shipment? }] }
//   line_items (optional): pre-computed from preview when Amazon data available.
//     Each: { description, item_total, qbo_account_id, qbo_class_id }
//   is_first_shipment: PDF attached only for first shipment of each receipt.
//     Omit or true for non-Amazon receipts.
router.post('/export/confirm', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { exports } = req.body;

  if (!Array.isArray(exports) || !exports.length) {
    return res.status(400).json({ error: 'exports must be a non-empty array.' });
  }

  const results = [];
  // Track the first QBO transaction ID per receipt (for marking status)
  const receiptPrimaryQboId = {};

  for (const exp of exports) {
    const { receipt_id, qbo_transaction_id, line_items, is_first_shipment } = exp;
    const attachPdf = is_first_shipment !== false; // default true for non-shipment exports

    try {
      let items;

      if (Array.isArray(line_items) && line_items.length > 0) {
        // Use pre-computed shipment line items from the preview
        items = line_items
          .filter((li) => li.qbo_account_id)
          .map((li) => ({
            description: li.description,
            total: li.item_total,
            qbo_account_id: li.qbo_account_id,
            qbo_class_id: li.qbo_class_id || null,
          }));
      } else {
        // Fallback: load accepted items from receipt_items table
        const itemsRes = await query(
          `SELECT ri.description, ri.total, ri.qbo_account_id, ri.qbo_class_id
           FROM receipt_items ri
           WHERE ri.receipt_id = $1
             AND ri.item_status = 'accepted'
             AND ri.qbo_account_id IS NOT NULL
           ORDER BY ri.created_at`,
          [receipt_id]
        );
        items = itemsRes.rows;
      }

      if (!items.length) {
        results.push({ receipt_id, qbo_transaction_id, ok: false, error: 'No categorized items to export.' });
        continue;
      }

      // GET existing purchase (needs SyncToken for update)
      const existing = await qboGetPurchase(cId, qbo_transaction_id);

      // Update QBO transaction with the line items
      await qboUpdatePurchase(cId, existing, items);

      // Attach PDF only for the first shipment (or non-shipment receipts)
      if (attachPdf) {
        try {
          const { buffer: pdfBuffer } = await loadReceiptPdf(cId, receipt_id);
          if (pdfBuffer) {
            const fnRes = await query(
              `SELECT pdf_filename, order_number FROM receipts WHERE id = $1`, [receipt_id]
            );
            const { pdf_filename, order_number } = fnRes.rows[0] || {};
            const attachName = pdf_filename || `${order_number || receipt_id}.pdf`;
            await qboAttachFile(cId, 'Purchase', qbo_transaction_id, attachName, pdfBuffer);
          }
          // Note: PDF bytes are retained in the DB (pdf_data) so the receipt
          // remains viewable after export. We no longer delete it.
        } catch (attachErr) {
          console.error('[export] PDF attach failed for receipt', receipt_id, attachErr.message);
          // Non-fatal — don't fail the whole export
        }
      }

      // Mark receipt as imported using the FIRST shipment's QBO transaction ID
      if (!receiptPrimaryQboId[receipt_id]) {
        receiptPrimaryQboId[receipt_id] = qbo_transaction_id;
        await query(
          `UPDATE receipts
           SET status = 'imported', qbo_transaction_id = $2, exported_at = NOW()
           WHERE id = $1 AND company_id = $3`,
          [receipt_id, qbo_transaction_id, cId]
        );
      }

      results.push({ receipt_id, qbo_transaction_id, ok: true });
    } catch (err) {
      console.error('[export] failed for QBO txn', qbo_transaction_id, err.message);
      results.push({ receipt_id, qbo_transaction_id, ok: false, error: err.message });
    }
  }

  res.json({ results });
});

export { router as receiptsRouter };
