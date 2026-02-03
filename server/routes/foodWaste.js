import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';

const router = express.Router();
const companyId = (req) => req.companyId;

// ---------- Ingredients (manager maintains) ----------
router.get('/ingredients', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, company_id, name, created_at FROM ingredients WHERE company_id = $1 ORDER BY name`,
      [companyId(req)]
    );
    res.json({ ingredients: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingredients', requireManager, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await query(
      `INSERT INTO ingredients (company_id, name) VALUES ($1, $2)
       RETURNING id, company_id, name, created_at`,
      [companyId(req), name.trim()]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/ingredients/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const r = await query(
      `UPDATE ingredients SET name = COALESCE($2, name), updated_at = NOW()
       WHERE id = $1 AND company_id = $3 RETURNING id, company_id, name, updated_at`,
      [id, name, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Ingredient not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/ingredients/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `DELETE FROM ingredients WHERE id = $1 AND company_id = $2 RETURNING id`,
      [id, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Ingredient not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Food waste entries (header: e.g. Food Disposal + date) ----------
router.get('/entries', async (req, res) => {
  try {
    const { from, to } = req.query;
    let q = `SELECT fwe.id, fwe.company_id, fwe.title, fwe.entry_date, fwe.created_by, fwe.created_at,
                    u.display_name as created_by_name
             FROM food_waste_entries fwe
             LEFT JOIN users u ON u.id = fwe.created_by
             WHERE fwe.company_id = $1`;
    const params = [companyId(req)];
    if (from) { q += ` AND fwe.entry_date >= $${params.length + 1}::date`; params.push(from); }
    if (to) { q += ` AND fwe.entry_date <= $${params.length + 1}::date`; params.push(to); }
    q += ` ORDER BY fwe.entry_date DESC, fwe.created_at DESC`;
    const r = await query(q, params);
    res.json({ entries: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/entries', async (req, res) => {
  try {
    const { title, entry_date } = req.body;
    if (!title || !entry_date) return res.status(400).json({ error: 'title and entry_date required' });
    const r = await query(
      `INSERT INTO food_waste_entries (company_id, title, entry_date, created_by)
       VALUES ($1, $2, $3::date, $4)
       RETURNING id, company_id, title, entry_date, created_by, created_at`,
      [companyId(req), title.trim(), entry_date, req.userId]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/entries/:entryId', async (req, res) => {
  try {
    const { entryId } = req.params;
    const { title, entry_date } = req.body;
    const r = await query(
      `UPDATE food_waste_entries SET
         title = COALESCE(NULLIF($2, ''), title),
         entry_date = COALESCE($3::date, entry_date),
         updated_at = NOW()
       WHERE id = $1 AND company_id = $4
       RETURNING id, company_id, title, entry_date, created_by, created_at`,
      [entryId, title, entry_date, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/entries/:entryId', async (req, res) => {
  try {
    const { entryId } = req.params;
    const entryResult = await query(
      `SELECT fwe.id, fwe.company_id, fwe.title, fwe.entry_date, fwe.created_by, fwe.created_at,
              u.display_name as created_by_name
       FROM food_waste_entries fwe
       LEFT JOIN users u ON u.id = fwe.created_by
       WHERE fwe.id = $1 AND fwe.company_id = $2`,
      [entryId, companyId(req)]
    );
    if (entryResult.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    const entry = entryResult.rows[0];
    const itemsResult = await query(
      `SELECT fwei.id, fwei.entry_id, fwei.ingredient_id, fwei.quantity, fwei.unit,
              fwei.discarded_by, fwei.discarded_at, i.name as ingredient_name,
              u.display_name as discarded_by_name
       FROM food_waste_entry_items fwei
       JOIN ingredients i ON i.id = fwei.ingredient_id
       LEFT JOIN users u ON u.id = fwei.discarded_by
       WHERE fwei.entry_id = $1 ORDER BY fwei.discarded_at`,
      [entryId]
    );
    res.json({ ...entry, items: itemsResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add item to entry (user selects ingredient + weight; logs who + when)
router.post('/entries/:entryId/items', async (req, res) => {
  try {
    const { entryId } = req.params;
    const { ingredient_id, quantity, unit } = req.body;
    if (!ingredient_id || quantity == null) return res.status(400).json({ error: 'ingredient_id and quantity required' });
    const r = await query(
      `INSERT INTO food_waste_entry_items (entry_id, ingredient_id, quantity, unit, discarded_by)
       SELECT $1, $2, $3, $4, $5
       FROM food_waste_entries WHERE id = $1 AND company_id = $6
       RETURNING id, entry_id, ingredient_id, quantity, unit, discarded_by, discarded_at`,
      [entryId, ingredient_id, Number(quantity), unit || null, req.userId, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/entries/:entryId/items/:itemId', async (req, res) => {
  try {
    const { entryId, itemId } = req.params;
    const r = await query(
      `DELETE FROM food_waste_entry_items WHERE id = $1 AND entry_id = $2
       AND entry_id IN (SELECT id FROM food_waste_entries WHERE company_id = $3)
       RETURNING id`,
      [itemId, entryId, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as foodWasteRouter };
