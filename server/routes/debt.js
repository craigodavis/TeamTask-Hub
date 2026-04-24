import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';

const router = express.Router();
const companyId = (req) => req.companyId;

/** Persist ceiling to company_integrations (null clears). Throws { statusCode: 400 } on bad input. */
async function persistDebtCeiling(cId, raw) {
  let debt_ceiling = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0) {
      const err = new Error('debt_ceiling must be a non-negative number or empty to clear');
      err.statusCode = 400;
      throw err;
    }
    debt_ceiling = n;
  }
  await query(
    `INSERT INTO company_integrations (company_id, debt_ceiling, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (company_id) DO UPDATE SET
       debt_ceiling = EXCLUDED.debt_ceiling,
       updated_at = NOW()`,
    [cId, debt_ceiling]
  );
  return debt_ceiling;
}

/** Chart + table data: 12 months for each of two years (defaults: last year & this year). */
router.get('/report', requireManager, async (req, res) => {
  try {
    const y = new Date().getFullYear();
    let priorYear = parseInt(req.query.prior_year, 10);
    if (Number.isNaN(priorYear)) priorYear = y - 1;
    priorYear = Math.max(1900, Math.min(2100, priorYear));
    let currentYear = parseInt(req.query.current_year, 10);
    if (Number.isNaN(currentYear)) currentYear = y;
    currentYear = Math.max(1900, Math.min(2100, currentYear));
    const cId = companyId(req);
    const r = await query(
      `SELECT year, month, ending_balance::float8 AS ending_balance
       FROM debt_monthly_balances
       WHERE company_id = $1 AND year = ANY($2::int[])
       ORDER BY year, month`,
      [cId, [priorYear, currentYear]]
    );
    const buildSeries = (year) => {
      const arr = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ending_balance: null }));
      for (const row of r.rows) {
        if (Number(row.year) === year) {
          arr[row.month - 1] = { month: row.month, ending_balance: row.ending_balance };
        }
      }
      return arr;
    };
    const ci = await query(
      `SELECT debt_ceiling::float8 AS debt_ceiling FROM company_integrations WHERE company_id = $1`,
      [cId]
    );
    const rawCeiling = ci.rows[0]?.debt_ceiling;
    const debt_ceiling =
      rawCeiling != null && !Number.isNaN(Number(rawCeiling)) ? Number(rawCeiling) : null;
    res.json({
      prior_year: priorYear,
      current_year: currentYear,
      prior: buildSeries(priorYear),
      current: buildSeries(currentYear),
      debt_ceiling,
    });
  } catch (err) {
    console.error('debt report', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Bulk save: balances is [{ year, month, ending_balance }].
 * Omit ending_balance or null to delete that month’s row.
 * Optional debt_ceiling (same rules as PUT /ceiling): set or clear ceiling in the same request.
 */
router.post('/balances/bulk', requireManager, async (req, res) => {
  try {
    const { balances } = req.body;
    if (!Array.isArray(balances)) return res.status(400).json({ error: 'balances array required' });
    const cId = companyId(req);
    for (const b of balances) {
      const year = parseInt(b.year, 10);
      const month = parseInt(b.month, 10);
      if (year < 1900 || year > 2100 || month < 1 || month > 12) {
        return res.status(400).json({ error: 'Invalid year or month in balances' });
      }
      const raw = b.ending_balance;
      if (raw === null || raw === undefined || raw === '') {
        await query(
          `DELETE FROM debt_monthly_balances WHERE company_id = $1 AND year = $2 AND month = $3`,
          [cId, year, month]
        );
        continue;
      }
      const amt = Number(raw);
      if (Number.isNaN(amt)) return res.status(400).json({ error: 'Invalid ending_balance' });
      await query(
        `INSERT INTO debt_monthly_balances (company_id, year, month, ending_balance, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (company_id, year, month)
         DO UPDATE SET ending_balance = EXCLUDED.ending_balance, updated_at = NOW()`,
        [cId, year, month, amt]
      );
    }
    const out = { ok: true };
    if (Object.prototype.hasOwnProperty.call(req.body, 'debt_ceiling')) {
      try {
        out.debt_ceiling = await persistDebtCeiling(cId, req.body.debt_ceiling);
      } catch (e) {
        if (e.statusCode === 400) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    res.json(out);
  } catch (err) {
    console.error('debt bulk', err);
    res.status(500).json({ error: err.message });
  }
});

/** Set or clear debt ceiling (monthly borrowing cap); upserts company_integrations row. */
async function saveDebtCeiling(req, res) {
  try {
    const cId = companyId(req);
    try {
      const debt_ceiling = await persistDebtCeiling(cId, req.body?.debt_ceiling);
      res.json({ ok: true, debt_ceiling });
    } catch (e) {
      if (e.statusCode === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
  } catch (err) {
    console.error('debt ceiling', err);
    res.status(500).json({ error: err.message });
  }
}

// POST avoids PUT being blocked by some Apache / reverse-proxy setups (HTML 403/405 → opaque client errors).
router.post('/ceiling', requireManager, saveDebtCeiling);
router.put('/ceiling', requireManager, saveDebtCeiling);

export { router as debtRouter };
