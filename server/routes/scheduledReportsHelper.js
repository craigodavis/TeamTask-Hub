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
 * Evaluate all params to their display values and return a snapshot array.
 * Stored on the run record so the public report view can show "Report run with:
 * start_date = 4/8/2026, location = Kindred by the Creek".
 *
 * Each item: { name, type, value (raw expression), display (human-readable) }
 *
 * date_expr params: all evaluated in a single SELECT for efficiency.
 * static params:    surrounding single quotes stripped for readability.
 */
export async function resolveParamsSnapshot(params = [], timezone = 'UTC') {
  if (!params || params.length === 0) return [];

  const dateParams = params.filter((p) => p.type === 'date_expr' && p.value);

  // Evaluate all date expressions in one round trip, in the company's timezone
  const resolved = {};
  if (dateParams.length > 0) {
    const dbClient = await pool.connect();
    try {
      await dbClient.query(`SET LOCAL timezone = '${timezone.replace(/'/g, '')}'`);
      const selects = dateParams.map((p, i) => `(${p.value})::text AS v${i}`);
      const result  = await dbClient.query(`SELECT ${selects.join(', ')}`);
      const row     = result.rows[0] || {};
      dateParams.forEach((p, i) => { resolved[p.name] = row[`v${i}`] || ''; });
    } catch {
      // If evaluation fails, fall back to the raw expression string
    } finally {
      dbClient.release();
    }
  }

  return params.map((p) => {
    let display = p.value || '';
    if (p.type === 'date_expr') {
      const raw = resolved[p.name] || p.value || '';
      // Try to format as a date; fall back to raw string
      const d = new Date(raw);
      display = isNaN(d.getTime())
        ? raw
        : `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
    } else {
      // Strip surrounding single quotes for display: 'Kindred' → Kindred
      display = display.replace(/^'(.*)'$/s, '$1');
    }
    return { name: p.name, type: p.type, value: p.value, display };
  });
}

/**
 * Execute a read-only SQL query against the Square DB schema.
 * Params are substituted before execution.
 * Used by both the scheduled report runner and the test endpoint.
 */
export async function executeSqlReadOnly(sql, params = [], timezone = 'UTC') {
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
    await dbClient.query(`SET LOCAL timezone = '${timezone.replace(/'/g, '')}'`);
    const result = await dbClient.query(finalSql);
    return {
      rows: result.rows,
      fields: result.fields.map((f) => f.name),
    };
  } finally {
    dbClient.release();
  }
}
