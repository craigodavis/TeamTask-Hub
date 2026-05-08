import { pool } from '../db.js';

/**
 * Execute a read-only SQL query against the Square DB schema.
 * Used by both the scheduled report runner and the test endpoint.
 */
export async function executeSqlReadOnly(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const upper = trimmed.replace(/\s+/g, ' ').toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    throw new Error('Only SELECT queries are allowed in reports');
  }
  const hasLimit = /\bLIMIT\s+\d+\b/i.test(trimmed);
  const finalSql = hasLimit ? trimmed : `${trimmed} LIMIT 1000`;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('SET statement_timeout = 30000');
    const result = await dbClient.query(finalSql);
    return {
      rows: result.rows,
      fields: result.fields.map((f) => f.name),
    };
  } finally {
    dbClient.release();
  }
}
