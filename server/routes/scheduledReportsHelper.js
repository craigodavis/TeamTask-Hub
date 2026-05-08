import { pool } from '../db.js';

/**
 * Substitute {param_name} tokens in a SQL string.
 *
 * Each param object: { name, type, value }
 *   type === 'date_expr'  → value is a PG expression; wrap in parens so PG evaluates it
 *   type === 'static'     → value is used as-is (user provides the literal, e.g. "'Kindred'" or '100')
 *
 * Any unbound {token} (no matching param) is left as-is so the SQL error message
 * makes it obvious which param is missing.
 */
export function applyParams(sql, params = []) {
  if (!params || params.length === 0) return sql;
  let result = sql;
  for (const param of params) {
    if (!param.name) continue;
    if (param.value === undefined || param.value === null || param.value === '') continue;
    const placeholder = `{${param.name}}`;
    const value = param.type === 'date_expr' ? `(${param.value})` : param.value;
    result = result.split(placeholder).join(value);
  }
  return result;
}

/**
 * Execute a read-only SQL query against the Square DB schema.
 * Params are substituted before execution.
 * Used by both the scheduled report runner and the test endpoint.
 */
export async function executeSqlReadOnly(sql, params = []) {
  const resolved = applyParams(sql, params);
  const trimmed = resolved.trim().replace(/;\s*$/, '');
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
