/**
 * Amazon Order History routes
 * POST /api/amazon-orders/upload  — import CSV export from Amazon Business
 * GET  /api/amazon-orders          — list all payments
 * GET  /api/amazon-orders/stats    — summary stats for the UI
 */
import { Router } from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current); current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function cleanValue(v) {
  if (typeof v !== 'string') return v;
  v = v.trim();
  // Strip Excel =" prefix
  if (v.startsWith('="') && v.endsWith('"')) v = v.slice(2, -1);
  return v;
}

/**
 * Parse "MM/DD/YYYY" → "YYYY-MM-DD". Returns null for invalid/N/A.
 */
function parseDate(str) {
  if (!str || str === 'N/A') return null;
  const parts = str.split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts;
  if (!m || !d || !y || y.length !== 4) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return [];
  const headers = parseLine(lines[0]).map(cleanValue);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseLine(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = cleanValue(vals[idx] || ''); });
    rows.push(row);
  }
  return rows;
}

// ── POST /api/amazon-orders/upload ───────────────────────────────────────────
router.post('/upload', requireAuth, requireOwner, upload.single('csv'), async (req, res) => {
  const cId = req.companyId;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  try {
    const text = req.file.buffer.toString('utf-8');
    const rows = parseCSV(text);

    // Group rows by Payment Reference ID
    // Key insight: multiple rows share the same Payment Reference ID when:
    //   - Multiple items from the same order shipped together, OR
    //   - Multiple orders were charged together (rare)
    const paymentsMap = new Map();

    for (const row of rows) {
      const payRef = row['Payment Reference ID'];
      const orderId = row['Order ID'];
      if (!payRef || payRef === 'N/A' || !orderId) continue;

      if (!paymentsMap.has(payRef)) {
        paymentsMap.set(payRef, {
          payment_reference_id: payRef,
          payment_date: parseDate(row['Payment Date']),
          payment_amount: parseFloat(row['Payment Amount']) || null,
          payment_instrument: row['Payment Instrument Type'] || null,
          card_last4: row['Payment Identifier'] || null,
          order_ids: new Set(),
        });
      }
      paymentsMap.get(payRef).order_ids.add(orderId);
    }

    let upserted = 0;
    for (const [, p] of paymentsMap) {
      const orderIds = [...p.order_ids];
      await query(
        `INSERT INTO amazon_payments
           (company_id, payment_reference_id, payment_date, payment_amount,
            payment_instrument, card_last4, order_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, payment_reference_id) DO UPDATE SET
           payment_date       = EXCLUDED.payment_date,
           payment_amount     = EXCLUDED.payment_amount,
           payment_instrument = EXCLUDED.payment_instrument,
           card_last4         = EXCLUDED.card_last4,
           order_ids          = EXCLUDED.order_ids,
           imported_at        = NOW()`,
        [cId, p.payment_reference_id, p.payment_date, p.payment_amount,
         p.payment_instrument, p.card_last4, orderIds]
      );
      upserted++;
    }

    res.json({ ok: true, payments_imported: upserted, rows_parsed: rows.length });
  } catch (err) {
    console.error('[amazon-orders] upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/amazon-orders ────────────────────────────────────────────────────
router.get('/', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  try {
    const result = await query(
      `SELECT id, payment_reference_id, payment_date, payment_amount,
              payment_instrument, card_last4, order_ids,
              array_length(order_ids, 1) AS order_count,
              imported_at
       FROM amazon_payments
       WHERE company_id = $1
       ORDER BY payment_date DESC NULLS LAST, imported_at DESC`,
      [cId]
    );
    res.json({ payments: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/amazon-orders/stats ─────────────────────────────────────────────
// How many receipts have amazon payment data vs. don't.
router.get('/stats', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  try {
    const totalPayments = await query(
      `SELECT COUNT(*) FROM amazon_payments WHERE company_id = $1`, [cId]
    );
    const covered = await query(
      `SELECT COUNT(DISTINCT r.id)
       FROM receipts r
       JOIN amazon_payments ap ON ap.company_id = r.company_id
         AND r.order_number = ANY(ap.order_ids)
       WHERE r.company_id = $1 AND r.status != 'imported'`,
      [cId]
    );
    const total = await query(
      `SELECT COUNT(*) FROM receipts WHERE company_id = $1 AND status != 'imported'`, [cId]
    );
    res.json({
      payments_imported: parseInt(totalPayments.rows[0].count),
      receipts_covered: parseInt(covered.rows[0].count),
      receipts_total: parseInt(total.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as amazonOrdersRouter };
