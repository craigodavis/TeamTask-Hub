import express from 'express';
import multer from 'multer';
import { createRequire } from 'module';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractReceiptData, categorizeLineItems } from '../aiClient.js';
import { applyRules, buildRulesPrompt } from '../rulesEngine.js';
import { qboFindVendor, qboFindPurchases, qboGetPurchase, qboUpdatePurchase, qboAttachFile } from '../qboClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'receipts');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// pdf-parse v1 is CommonJS — use createRequire for ESM compatibility
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const router = express.Router();

// Store uploaded files in memory (Buffer) — no disk writes needed
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted.'));
  },
});

// ── POST /api/receipts/upload ─────────────────────────────────────────────────
// Accept one or more PDFs, parse, categorize, store as pending.
router.post('/upload', requireAuth, requireOwner, upload.array('pdfs', 20), async (req, res) => {
  const cId = req.companyId;
  if (!req.files?.length) {
    return res.status(400).json({ error: 'No PDF files received.' });
  }

  // Load QBO reference data, product memory, and rules once for all files
  const [accountsRes, classesRes, memoryRes, rulesRes] = await Promise.all([
    query(`SELECT qbo_id, name, fully_qualified_name, account_type, active FROM qbo_accounts WHERE company_id = $1`, [cId]),
    query(`SELECT qbo_id, name, fully_qualified_name, active FROM qbo_classes WHERE company_id = $1`, [cId]),
    query(`SELECT product_pattern, qbo_account_id, qbo_class_id FROM product_memory WHERE company_id = $1`, [cId]),
    query(`SELECT * FROM categorization_rules WHERE company_id = $1 AND active = true ORDER BY priority ASC`, [cId]),
  ]);
  const accounts = accountsRes.rows;
  const classes = classesRes.rows;
  const memory = memoryRes.rows;
  const rules = rulesRes.rows;
  const rulesPrompt = buildRulesPrompt(rules);

  const results = [];

  for (const file of req.files) {
    const filename = file.originalname;

    try {
      // 1. Extract text from PDF
      const parsed = await pdfParse(file.buffer);
      const pdfText = parsed.text;

      // 2. Ask Claude to extract structured receipt data
      let receiptData;
      try {
        receiptData = await extractReceiptData(pdfText);
      } catch (aiErr) {
        results.push({ filename, error: `AI extraction failed: ${aiErr.message}` });
        continue;
      }

      const { order_number, order_date, vendor, subtotal, tax, total, items } = receiptData;

      if (!order_number) {
        results.push({ filename, error: 'Could not extract order number from PDF.' });
        continue;
      }

      // 3. Duplicate check
      const dupCheck = await query(
        `SELECT id, status FROM receipts WHERE company_id = $1 AND order_number = $2`,
        [cId, order_number]
      );
      if (dupCheck.rows.length) {
        results.push({ filename, order_number, skipped: true, reason: 'duplicate', existing_status: dupCheck.rows[0].status });
        continue;
      }

      // 4. AI categorization
      let categorized = [];
      if (items?.length && accounts.length) {
        try {
          categorized = await categorizeLineItems(items, accounts, classes, memory, rulesPrompt);
        } catch (catErr) {
          console.error('[receipts] categorization failed:', catErr.message);
          // Continue without AI suggestions — user can categorize manually
          categorized = (items || []).map((it) => ({ ...it, qbo_account_id: null, qbo_class_id: null, confidence: 0, reasoning: '' }));
        }
      } else {
        categorized = (items || []).map((it) => ({ ...it, qbo_account_id: null, qbo_class_id: null, confidence: 0, reasoning: '' }));
      }

      // 5. Apply categorization rules (post-AI override)
      if (rules.length) {
        categorized = categorized.map((item) => {
          const override = applyRules(item, vendor, rules, accounts);
          return { ...item, ...override };
        });
      }

      // 6. Save receipt
      const receiptRes = await query(
        `INSERT INTO receipts (company_id, order_number, order_date, vendor, subtotal, tax, total, pdf_filename)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [cId, order_number, order_date || null, vendor || 'Amazon', subtotal || null, tax || null, total || null, filename]
      );
      const receiptId = receiptRes.rows[0].id;

      // 7. Save PDF to disk for later QBO attachment
      try {
        await fs.promises.writeFile(path.join(UPLOAD_DIR, `${receiptId}.pdf`), file.buffer);
      } catch (fsErr) {
        console.error('[receipts] failed to save PDF to disk:', fsErr.message);
        // Non-fatal — continue without attachment capability
      }

      // 8. Save line items
      for (const item of categorized) {
        await query(
          `INSERT INTO receipt_items (receipt_id, description, quantity, unit_price, total, qbo_account_id, qbo_class_id, ai_confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            receiptId,
            item.description,
            item.quantity ?? 1,
            item.unit_price ?? null,
            item.total ?? null,
            item.qbo_account_id || null,
            item.qbo_class_id || null,
            item.confidence ?? null,
          ]
        );
      }

      results.push({ filename, order_number, order_date, vendor: vendor || 'Amazon', total, items: categorized.length, receipt_id: receiptId });
    } catch (err) {
      console.error('[receipts] error processing', filename, err);
      results.push({ filename, error: err.message });
    }
  }

  res.json({ results });
});

// ── GET /api/receipts ─────────────────────────────────────────────────────────
// List all receipts for this company, newest first.
router.get('/', requireAuth, requireOwner, async (req, res) => {
  try {
    const { status } = req.query;
    const params = [req.companyId];
    const where = status ? `AND r.status = $2` : '';
    if (status) params.push(status);

    const r = await query(
      `SELECT r.id, r.order_number, r.order_date, r.vendor, r.total, r.status,
              r.pdf_filename, r.created_at,
              COUNT(ri.id) AS item_count,
              STRING_AGG(DISTINCT qa.name, ', ') AS accounts_used,
              STRING_AGG(DISTINCT qc.name, ', ') AS classes_used,
              STRING_AGG(ri.description, ' · ' ORDER BY ri.created_at) AS descriptions
       FROM receipts r
       LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
       LEFT JOIN qbo_accounts qa ON qa.company_id = r.company_id AND qa.qbo_id = ri.qbo_account_id
       LEFT JOIN qbo_classes  qc ON qc.company_id = r.company_id AND qc.qbo_id = ri.qbo_class_id
       WHERE r.company_id = $1 ${where}
       GROUP BY r.id
       ORDER BY r.created_at DESC
       LIMIT 200`,
      params
    );
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

// ── POST /api/receipts/rules ──────────────────────────────────────────────────
router.post('/rules', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const {
    name, priority = 100,
    if_description_contains, if_vendor, if_account_type_contains,
    then_account_id, then_class_id, then_clear = false,
    notes, active = true,
  } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Rule name is required.' });

  try {
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

// ── POST /api/receipts/:id/accept-all ────────────────────────────────────────
// Accept all pending items on this receipt and mark it reviewed.
router.post('/:id/accept-all', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { id } = req.params;
  try {
    const rr = await query(`SELECT id FROM receipts WHERE id = $1 AND company_id = $2`, [id, cId]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Receipt not found.' });

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
      query(`SELECT * FROM receipt_items WHERE receipt_id = $1 AND item_status = 'pending'`, [id]),
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
          `UPDATE receipt_items SET qbo_account_id = $2, qbo_class_id = $3 WHERE id = $1`,
          [item.id, override.qbo_account_id, override.qbo_class_id]
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

// ── POST /api/receipts/export/preview ────────────────────────────────────────
// For each reviewed (un-exported) receipt, search QBO for a matching Purchase.
// Body: { payment_account_id }
router.post('/export/preview', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { payment_account_id } = req.body;

  if (!payment_account_id) {
    return res.status(400).json({ error: 'payment_account_id is required.' });
  }

  try {
    // All reviewed receipts not yet exported
    const receiptsRes = await query(
      `SELECT id, order_number, order_date, vendor, total
       FROM receipts
       WHERE company_id = $1 AND status = 'reviewed' AND qbo_transaction_id IS NULL
       ORDER BY order_date DESC`,
      [cId]
    );

    // Seed used IDs with QBO transaction IDs already stored on other receipts
    const usedRes = await query(
      `SELECT qbo_transaction_id FROM receipts
       WHERE company_id = $1 AND qbo_transaction_id IS NOT NULL`,
      [cId]
    );
    const usedQboIds = new Set(usedRes.rows.map((r) => r.qbo_transaction_id));

    const previews = [];

    for (const receipt of receiptsRes.rows) {
      if (!receipt.total || !receipt.order_date) {
        previews.push({ receipt, match: null, confidence: 'none', reason: 'Missing total or date' });
        continue;
      }

      try {
        const matches = await qboFindPurchases(
          cId, payment_account_id, receipt.total, receipt.order_date
        );

        // Skip any QBO transactions already claimed by another receipt in this batch
        // or previously exported — ensures duplicate-amount receipts get distinct matches
        const available = matches.filter((m) => !usedQboIds.has(m.Id));

        if (!available.length) {
          previews.push({ receipt, match: null, confidence: 'none', reason: 'No unused QBO transaction found' });
          continue;
        }

        const best = available[0];
        // Reserve this QBO transaction for this receipt
        usedQboIds.add(best.Id);

        const daysDiff = Math.abs(
          (new Date(best.TxnDate) - new Date(receipt.order_date)) / (1000 * 60 * 60 * 24)
        );

        // Summarise current categorisation
        const currentLines = (best.Line || []).filter(
          (l) => l.DetailType === 'AccountBasedExpenseLineDetail'
        );
        const currentCategories = [...new Set(
          currentLines.map((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.name).filter(Boolean)
        )].join(', ');

        previews.push({
          receipt,
          match: {
            qbo_id:     best.Id,
            txn_date:   best.TxnDate,
            total:      best.TotalAmt,
            vendor:     best.EntityRef?.name || '',
            memo:       best.PrivateNote || '',
            current_categories: currentCategories || 'Uncategorized',
          },
          confidence: daysDiff === 0 ? 'high' : daysDiff <= 2 ? 'medium' : 'low',
          days_diff: daysDiff,
        });
      } catch (err) {
        previews.push({ receipt, match: null, confidence: 'none', reason: err.message });
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
// Multiple receipts pointing to the same qbo_transaction_id are combined.
// Body: { exports: [{ receipt_id, qbo_transaction_id }] }
router.post('/export/confirm', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { exports } = req.body;

  if (!Array.isArray(exports) || !exports.length) {
    return res.status(400).json({ error: 'exports must be a non-empty array.' });
  }

  // Group receipt_ids by qbo_transaction_id so combined receipts update once
  const grouped = {};
  for (const { receipt_id, qbo_transaction_id } of exports) {
    if (!grouped[qbo_transaction_id]) grouped[qbo_transaction_id] = [];
    grouped[qbo_transaction_id].push(receipt_id);
  }

  const results = [];

  for (const [qbo_transaction_id, receipt_ids] of Object.entries(grouped)) {
    try {
      // Load accepted line items from ALL receipts mapping to this QBO transaction
      const placeholders = receipt_ids.map((_, i) => `$${i + 1}`).join(',');
      const itemsRes = await query(
        `SELECT ri.description, ri.total, ri.qbo_account_id, ri.qbo_class_id
         FROM receipt_items ri
         WHERE ri.receipt_id IN (${placeholders})
           AND ri.item_status = 'accepted'
           AND ri.qbo_account_id IS NOT NULL
         ORDER BY ri.receipt_id, ri.created_at`,
        receipt_ids
      );

      if (!itemsRes.rows.length) {
        for (const receipt_id of receipt_ids) {
          results.push({ receipt_id, ok: false, error: 'No accepted items with an account assigned.' });
        }
        continue;
      }

      // GET existing purchase (needs SyncToken)
      const existing = await qboGetPurchase(cId, qbo_transaction_id);

      // Update with combined split lines from all receipts
      await qboUpdatePurchase(cId, existing, itemsRes.rows);

      // Attach PDFs for each receipt (best effort — don't fail export if missing)
      for (const receipt_id of receipt_ids) {
        const pdfPath = path.join(UPLOAD_DIR, `${receipt_id}.pdf`);
        try {
          const pdfBuffer = await fs.promises.readFile(pdfPath);
          // Get the original filename for a friendlier attachment name
          const fnRes = await query(`SELECT pdf_filename, order_number FROM receipts WHERE id = $1`, [receipt_id]);
          const { pdf_filename, order_number } = fnRes.rows[0] || {};
          const attachName = pdf_filename || `${order_number || receipt_id}.pdf`;
          await qboAttachFile(cId, 'Purchase', qbo_transaction_id, attachName, pdfBuffer);
          // Clean up local copy now that it's in QBO
          await fs.promises.unlink(pdfPath).catch(() => {});
        } catch (attachErr) {
          console.error('[export] PDF attach failed for receipt', receipt_id, attachErr.message);
          // Non-fatal
        }
      }

      // Mark all receipts as imported
      for (const receipt_id of receipt_ids) {
        await query(
          `UPDATE receipts
           SET status = 'imported', qbo_transaction_id = $2, exported_at = NOW()
           WHERE id = $1 AND company_id = $3`,
          [receipt_id, qbo_transaction_id, cId]
        );
        results.push({ receipt_id, ok: true });
      }
    } catch (err) {
      console.error('[export] failed for QBO txn', qbo_transaction_id, err.message);
      for (const receipt_id of receipt_ids) {
        results.push({ receipt_id, ok: false, error: err.message });
      }
    }
  }

  res.json({ results });
});

export { router as receiptsRouter };
