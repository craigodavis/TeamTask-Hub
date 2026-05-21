/**
 * Betty comparison routes — read-only audit of human bookkeeper vs AI recommendations.
 * NO changes are written to QuickBooks. All writes go to betty_recommendations only.
 *
 *   GET  /api/betty/transactions?days=30        pull recent QBO transactions (bookkeeper's work)
 *   GET  /api/betty/comparison?days=30&status=  side-by-side comparison report
 *   POST /api/betty/recommendations             Betty submits her recommendations (bulk or single)
 *   PATCH /api/betty/recommendations/:id        human reviewer marks agree/disagree/needs_review
 *   GET  /api/betty/accounts                    QBO chart of accounts (for Betty to reference)
 */

import express from 'express';
import { query } from '../db.js';
import { qboQueryAll, qboRequest } from '../qboClient.js';

const router = express.Router();

function cid(req) { return req.companyId || req.user?.company_id; }

// ── GET /api/betty/accounts ──────────────────────────────────────────────────
// Returns the full chart of accounts so Betty knows what categories exist.
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await qboQueryAll(
      cid(req),
      `SELECT * FROM Account WHERE Active = true`
    );
    res.json({ accounts: accounts.map((a) => ({
      id: a.Id,
      name: a.Name,
      fully_qualified_name: a.FullyQualifiedName,
      type: a.AccountType,
      subtype: a.AccountSubType,
      classification: a.Classification,
      active: a.Active,
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/betty/transactions ──────────────────────────────────────────────
// Pulls recent transactions from QBO showing what the bookkeeper has coded them as.
// This is READ-ONLY — nothing is changed in QBO.
router.get('/transactions', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30'), 365);
  const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  try {
    // Pull purchases (expenses) — most common categorization work
    const purchases = await qboQueryAll(
      cid(req),
      `SELECT * FROM Purchase WHERE TxnDate >= '${startDate}' ORDER BY TxnDate DESC`
    );

    // Pull deposits
    const deposits = await qboQueryAll(
      cid(req),
      `SELECT * FROM Deposit WHERE TxnDate >= '${startDate}' ORDER BY TxnDate DESC`
    );

    // Pull journal entries
    const journals = await qboQueryAll(
      cid(req),
      `SELECT * FROM JournalEntry WHERE TxnDate >= '${startDate}' ORDER BY TxnDate DESC`
    );

    const normalize = (txns, type) => txns.map((t) => {
      const line = t.Line?.[0];
      const detail = line?.AccountBasedExpenseLineDetail || line?.JournalEntryLineDetail || line?.DepositLineDetail || {};
      return {
        qbo_txn_id:   t.Id,
        qbo_txn_type: type,
        txn_date:     t.TxnDate,
        txn_amount:   t.TotalAmt || t.Line?.reduce((s, l) => s + (l.Amount || 0), 0) || 0,
        txn_description: t.PrivateNote || t.Memo || null,
        payee_name:   t.EntityRef?.name || t.PaymentMethodRef?.name || null,
        bookkeeper_account_id:   detail.AccountRef?.value || null,
        bookkeeper_account_name: detail.AccountRef?.name  || null,
        bookkeeper_class_id:     detail.ClassRef?.value   || null,
        bookkeeper_class_name:   detail.ClassRef?.name    || null,
        raw: t,
      };
    });

    const transactions = [
      ...normalize(purchases, 'Purchase'),
      ...normalize(deposits,  'Deposit'),
      ...normalize(journals,  'JournalEntry'),
    ].sort((a, b) => new Date(b.txn_date) - new Date(a.txn_date));

    res.json({ transactions, count: transactions.length, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/betty/recommendations ─────────────────────────────────────────
// Betty calls this to submit her recommendations. Accepts an array.
// DOES NOT touch QuickBooks — writes only to betty_recommendations table.
router.post('/recommendations', async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];

  if (!items.length) return res.status(400).json({ error: 'No recommendations provided' });

  const companyId = cid(req);
  const results = { upserted: 0, errors: [] };

  for (const item of items) {
    const {
      qbo_txn_id, qbo_txn_type, txn_date, txn_amount, txn_description, payee_name,
      bookkeeper_account_id, bookkeeper_account_name,
      bookkeeper_class_id, bookkeeper_class_name,
      betty_account_id, betty_account_name,
      betty_class_id, betty_class_name,
      betty_reasoning, betty_confidence = 'medium',
    } = item;

    if (!qbo_txn_id || !qbo_txn_type || !txn_date) {
      results.errors.push({ qbo_txn_id, error: 'qbo_txn_id, qbo_txn_type, txn_date required' });
      continue;
    }

    try {
      await query(
        `INSERT INTO betty_recommendations
           (company_id, qbo_txn_id, qbo_txn_type, txn_date, txn_amount, txn_description,
            payee_name, bookkeeper_account_id, bookkeeper_account_name,
            bookkeeper_class_id, bookkeeper_class_name,
            betty_account_id, betty_account_name, betty_class_id, betty_class_name,
            betty_reasoning, betty_confidence, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
         ON CONFLICT (company_id, qbo_txn_id, qbo_txn_type) DO UPDATE SET
           txn_amount               = EXCLUDED.txn_amount,
           txn_description          = EXCLUDED.txn_description,
           payee_name               = EXCLUDED.payee_name,
           bookkeeper_account_id    = EXCLUDED.bookkeeper_account_id,
           bookkeeper_account_name  = EXCLUDED.bookkeeper_account_name,
           bookkeeper_class_id      = EXCLUDED.bookkeeper_class_id,
           bookkeeper_class_name    = EXCLUDED.bookkeeper_class_name,
           betty_account_id         = EXCLUDED.betty_account_id,
           betty_account_name       = EXCLUDED.betty_account_name,
           betty_class_id           = EXCLUDED.betty_class_id,
           betty_class_name         = EXCLUDED.betty_class_name,
           betty_reasoning          = EXCLUDED.betty_reasoning,
           betty_confidence         = EXCLUDED.betty_confidence,
           status                   = CASE WHEN betty_recommendations.status = 'pending'
                                           THEN 'pending' ELSE betty_recommendations.status END,
           updated_at               = NOW()`,
        [companyId, qbo_txn_id, qbo_txn_type, txn_date, txn_amount || null,
         txn_description || null, payee_name || null,
         bookkeeper_account_id || null, bookkeeper_account_name || null,
         bookkeeper_class_id || null, bookkeeper_class_name || null,
         betty_account_id || null, betty_account_name || null,
         betty_class_id || null, betty_class_name || null,
         betty_reasoning || null, betty_confidence]
      );
      results.upserted++;
    } catch (err) {
      results.errors.push({ qbo_txn_id, error: err.message });
    }
  }

  res.json({ ok: true, ...results });
});

// ── PATCH /api/betty/recommendations/:id ─────────────────────────────────────
// Human reviewer marks a recommendation as agree / disagree / needs_review
router.patch('/recommendations/:id', async (req, res) => {
  const { status, reviewer_note } = req.body;
  const validStatuses = ['pending', 'agree', 'disagree', 'needs_review'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }
  try {
    const r = await query(
      `UPDATE betty_recommendations
       SET status = $1, reviewer_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [status, reviewer_note || null, req.userId || null, req.params.id, cid(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ recommendation: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/betty/comparison ────────────────────────────────────────────────
// The main report: side-by-side bookkeeper vs Betty, with match/mismatch flag.
router.get('/comparison', async (req, res) => {
  const days   = Math.min(parseInt(req.query.days || '30'), 365);
  const status = req.query.status; // optional filter: pending|agree|disagree|needs_review
  const since  = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  try {
    const params = [cid(req), since];
    const statusClause = status ? `AND status = $${params.push(status)}` : '';

    const r = await query(
      `SELECT *,
         CASE
           WHEN betty_account_id IS NULL THEN 'no_recommendation'
           WHEN bookkeeper_account_id = betty_account_id THEN 'match'
           ELSE 'mismatch'
         END AS agreement
       FROM betty_recommendations
       WHERE company_id = $1 AND txn_date >= $2
       ${statusClause}
       ORDER BY txn_date DESC`,
      params
    );

    const rows = r.rows;
    const summary = {
      total:          rows.length,
      match:          rows.filter((r) => r.agreement === 'match').length,
      mismatch:       rows.filter((r) => r.agreement === 'mismatch').length,
      no_recommendation: rows.filter((r) => r.agreement === 'no_recommendation').length,
      pending:        rows.filter((r) => r.status === 'pending').length,
      agree:          rows.filter((r) => r.status === 'agree').length,
      disagree:       rows.filter((r) => r.status === 'disagree').length,
      needs_review:   rows.filter((r) => r.status === 'needs_review').length,
    };

    res.json({ comparison: rows, summary, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as bettyRouter };
