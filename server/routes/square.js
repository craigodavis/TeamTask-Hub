import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

// GET /api/square/tables — list square schema tables with row estimates
router.get('/tables', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT
          t.table_name,
          GREATEST(c.reltuples::bigint, 0) AS row_count
        FROM information_schema.tables t
        JOIN pg_namespace n ON n.nspname = 'square'
        JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
        WHERE t.table_schema = 'square'
          AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name
      `);
      res.json({ tables: result.rows });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[square] tables error:', err.message);
    res.status(500).json({ error: 'Failed to load Square tables' });
  }
});

export { router as squareRouter };
