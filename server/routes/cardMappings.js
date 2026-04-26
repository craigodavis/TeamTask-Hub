/**
 * Card → QBO payment account mappings.
 * Maps the last 4 digits of a credit/debit card to a QBO payment account,
 * so each receipt is matched against its correct account automatically.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';

const router = Router();

// GET /api/card-mappings — list all mappings with account name
router.get('/', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  try {
    const result = await query(
      `SELECT cm.id, cm.card_last4, cm.card_label, cm.qbo_account_id,
              qa.name AS account_name, qa.fully_qualified_name AS account_full_name,
              cm.created_at, cm.updated_at
       FROM card_account_mappings cm
       LEFT JOIN qbo_accounts qa ON qa.company_id = cm.company_id AND qa.qbo_id = cm.qbo_account_id
       WHERE cm.company_id = $1
       ORDER BY cm.card_last4`,
      [cId]
    );
    res.json({ mappings: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/card-mappings — create or update a mapping (upsert by card_last4)
router.post('/', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  const { card_last4, card_label, qbo_account_id } = req.body;

  if (!card_last4 || !qbo_account_id) {
    return res.status(400).json({ error: 'card_last4 and qbo_account_id are required.' });
  }
  const clean = card_last4.replace(/\D/g, '').slice(-4);
  if (clean.length !== 4) {
    return res.status(400).json({ error: 'card_last4 must be exactly 4 digits.' });
  }

  try {
    const result = await query(
      `INSERT INTO card_account_mappings (company_id, card_last4, card_label, qbo_account_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, card_last4) DO UPDATE SET
         card_label     = EXCLUDED.card_label,
         qbo_account_id = EXCLUDED.qbo_account_id,
         updated_at     = NOW()
       RETURNING *`,
      [cId, clean, card_label?.trim() || null, qbo_account_id]
    );
    res.json({ mapping: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/card-mappings/:id
router.delete('/:id', requireAuth, requireOwner, async (req, res) => {
  const cId = req.companyId;
  try {
    await query(
      `DELETE FROM card_account_mappings WHERE id = $1 AND company_id = $2`,
      [req.params.id, cId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as cardMappingsRouter };
