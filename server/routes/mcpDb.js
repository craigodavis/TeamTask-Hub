// routes/mcp-db.js
//
// Read-only Postgres MCP endpoint for TeamHub.
// Express + ESM + pg, matching the rest of the codebase.
//
// Runs on the same box as Postgres (d16057.usc1.stableserver.net), so it talks
// to localhost directly — no SSH tunnel involved.
//
// ── Install ───────────────────────────────────────────────────────────────
//   npm i @modelcontextprotocol/sdk zod
//
// ── Database role ─────────────────────────────────────────────────────────
// On shared cPanel you likely can't CREATE ROLE. Instead: create a user in
// cPanel > PostgreSQL Databases, add it to kindredv_kindred, then tighten it
// over SSH as the database owner:
//
//   REVOKE ALL ON DATABASE kindredv_kindred FROM kindredv_mcpro;
//   GRANT  CONNECT ON DATABASE kindredv_kindred TO kindredv_mcpro;
//   GRANT  USAGE ON SCHEMA teamtask_hub, team_square, commerce7, product, wine
//          TO kindredv_mcpro;
//   GRANT  SELECT ON ALL TABLES IN SCHEMA teamtask_hub, team_square, commerce7,
//          product, wine TO kindredv_mcpro;
//   ALTER DEFAULT PRIVILEGES IN SCHEMA teamtask_hub
//          GRANT SELECT ON TABLES TO kindredv_mcpro;
//   ALTER ROLE kindredv_mcpro SET statement_timeout = '15s';
//
//   -- Revoke anything you don't want readable, e.g.:
//   -- REVOKE SELECT ON <payment/payroll tables> FROM kindredv_mcpro;
//
// If the grants can't be locked down, BEGIN READ ONLY below still blocks all
// writes and DDL at the server level — but the role is what limits *reach*.
//
// ── Env ───────────────────────────────────────────────────────────────────
//   MCP_DATABASE_URL=postgres://kindredv_mcpro:...@localhost:5432/kindredv_kindred
//   MCP_PATH_SECRET=<32+ random chars>   // unguessable mount path
//   MCP_SCHEMAS=teamtask_hub,team_square,commerce7,product,wine
//
// ── Mount in your app ─────────────────────────────────────────────────────
//   import mcpDb from './routes/mcp-db.js';
//   app.use(`/mcp/${process.env.MCP_PATH_SECRET}`, mcpDb);
//
// ─────────────────────────────────────────────────────────────────────────

import express from 'express';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MAX_ROWS = 200;
const HARD_MAX_ROWS = 1000;

const SCHEMAS = (process.env.MCP_SCHEMAS || 'teamtask_hub,public')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_SCHEMA = SCHEMAS[0];
const quoteIdent = (s) => `"${s.replace(/"/g, '""')}"`;
const SEARCH_PATH = SCHEMAS.map(quoteIdent).join(', ');

const pool = new pg.Pool({
  connectionString: process.env.MCP_DATABASE_URL,
  max: 2, // shared hosting — keep the connection footprint small
  idleTimeoutMillis: 30_000,
  application_name: 'teamhub-mcp',
});

// Belt and braces: every session is read-only, time-boxed, and can resolve
// unqualified table names across the schemas we care about.
pool.on('connect', (client) => {
  client
    .query(
      `SET statement_timeout = '15s';
       SET default_transaction_read_only = on;
       SET search_path = ${SEARCH_PATH};`
    )
    .catch((err) => console.error('[mcp-db] session setup failed:', err.message));
});

pool.on('error', (err) => console.error('[mcp-db] idle client error:', err.message));

const ok = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const fail = (message) => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
});

// ── Query guard ───────────────────────────────────────────────────────────
// The read-only role and BEGIN READ ONLY are the real protection. This is a
// fast, friendly rejection so obvious mistakes never reach the database.
function guardSelect(rawSql) {
  let sql = String(rawSql || '').trim();
  while (sql.endsWith(';')) sql = sql.slice(0, -1).trim();

  if (!sql) throw new Error('Empty query.');
  if (sql.includes(';')) {
    throw new Error('Only a single statement is allowed — remove the semicolon.');
  }
  if (!/^(select|with)\b/i.test(sql)) {
    throw new Error('Only SELECT (or WITH ... SELECT) queries are allowed.');
  }
  return sql;
}

async function runReadOnly(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(sql, params);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already dead */
    }
    throw err;
  } finally {
    client.release();
  }
}

// Resolve the schema filter: a named schema, or all configured schemas.
const schemaFilter = (schema) => (schema ? [schema] : SCHEMAS);

// ── Tools ─────────────────────────────────────────────────────────────────
function buildServer() {
  const server = new McpServer({
    name: 'teamhub-postgres',
    version: '1.0.0',
  });

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description:
        `List tables and views with approximate row counts. Searches these schemas by default: ${SCHEMAS.join(', ')}. Start here to find out what exists.`,
      inputSchema: {
        schema: z.string().optional().describe('Restrict to one schema.'),
      },
    },
    async ({ schema }) => {
      try {
        const { rows } = await runReadOnly(
          `SELECT n.nspname AS schema,
                  c.relname AS name,
                  CASE c.relkind WHEN 'r' THEN 'table'
                                 WHEN 'v' THEN 'view'
                                 WHEN 'm' THEN 'materialized view'
                                 WHEN 'p' THEN 'partitioned table'
                                 ELSE c.relkind::text END AS kind,
                  GREATEST(c.reltuples, 0)::bigint AS approx_rows
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ANY($1)
              AND c.relkind IN ('r','v','m','p')
            ORDER BY n.nspname, c.relname`,
          [schemaFilter(schema)]
        );
        return ok({ schemas: schemaFilter(schema), count: rows.length, tables: rows });
      } catch (err) {
        return fail(err.message);
      }
    }
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description:
        'Show columns, types, nullability, defaults, primary key and foreign keys for one table. Omit schema to search all configured schemas.',
      inputSchema: {
        table: z.string().describe('Table or view name, unqualified.'),
        schema: z.string().optional().describe(`Schema name. Defaults to searching ${SCHEMAS.join(', ')}.`),
      },
    },
    async ({ table, schema }) => {
      const schemas = schemaFilter(schema);
      try {
        const columns = await runReadOnly(
          `SELECT table_schema, column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema = ANY($1) AND table_name = $2
            ORDER BY table_schema, ordinal_position`,
          [schemas, table]
        );

        if (columns.rows.length === 0) {
          return fail(`No table named "${table}" in ${schemas.join(', ')}. Try list_tables or search_schema.`);
        }

        const found = [...new Set(columns.rows.map((r) => r.table_schema))];

        const keys = await runReadOnly(
          `SELECT tc.table_schema,
                  tc.constraint_type,
                  kcu.column_name,
                  ccu.table_name  AS references_table,
                  ccu.column_name AS references_column
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name
              AND kcu.table_schema   = tc.table_schema
             LEFT JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name
              AND tc.constraint_type  = 'FOREIGN KEY'
            WHERE tc.table_schema = ANY($1)
              AND tc.table_name   = $2
              AND tc.constraint_type IN ('PRIMARY KEY','FOREIGN KEY')`,
          [found, table]
        );

        return ok({
          table,
          found_in_schemas: found,
          columns: columns.rows,
          primary_key: keys.rows
            .filter((r) => r.constraint_type === 'PRIMARY KEY')
            .map((r) => `${r.table_schema}.${r.column_name}`),
          foreign_keys: keys.rows
            .filter((r) => r.constraint_type === 'FOREIGN KEY')
            .map((r) => ({
              column: r.column_name,
              references: `${r.references_table}.${r.references_column}`,
            })),
        });
      } catch (err) {
        return fail(err.message);
      }
    }
  );

  server.registerTool(
    'search_schema',
    {
      title: 'Search schema',
      description:
        'Find tables and columns whose names match a pattern, across all configured schemas. Useful when you know roughly what you are looking for but not where it lives.',
      inputSchema: {
        pattern: z.string().describe('Substring to match, case-insensitive. e.g. "reservation".'),
        schema: z.string().optional().describe('Restrict to one schema.'),
      },
    },
    async ({ pattern, schema }) => {
      try {
        const { rows } = await runReadOnly(
          `SELECT table_schema, table_name, column_name, data_type
             FROM information_schema.columns
            WHERE table_schema = ANY($1)
              AND (table_name ILIKE '%' || $2 || '%' OR column_name ILIKE '%' || $2 || '%')
            ORDER BY table_schema, table_name, ordinal_position
            LIMIT 300`,
          [schemaFilter(schema), pattern]
        );
        return ok({ pattern, matches: rows.length, results: rows });
      } catch (err) {
        return fail(err.message);
      }
    }
  );

  server.registerTool(
    'run_query',
    {
      title: 'Run a read-only query',
      description:
        `Run a single SELECT (or WITH ... SELECT) statement and return the rows. Writes, DDL and multiple statements are rejected. Results are capped. search_path is ${SCHEMAS.join(', ')}, so unqualified table names resolve in that order — qualify explicitly when a name exists in more than one schema.`,
      inputSchema: {
        sql: z.string().describe('A single SELECT statement. No trailing semicolon needed.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(HARD_MAX_ROWS)
          .optional()
          .describe(`Max rows to return. Defaults to ${MAX_ROWS}.`),
      },
    },
    async ({ sql, limit = MAX_ROWS }) => {
      let inner;
      try {
        inner = guardSelect(sql);
      } catch (err) {
        return fail(err.message);
      }

      const cap = Math.min(limit, HARD_MAX_ROWS);
      try {
        const result = await runReadOnly(`SELECT * FROM (${inner}) AS _mcp_q LIMIT ${cap + 1}`);
        const truncated = result.rows.length > cap;
        const rows = truncated ? result.rows.slice(0, cap) : result.rows;

        return ok({
          columns: result.fields.map((f) => f.name),
          row_count: rows.length,
          truncated,
          ...(truncated
            ? { note: `More than ${cap} rows matched. Narrow the query or raise limit.` }
            : {}),
          rows,
        });
      } catch (err) {
        return fail(`${err.message}${err.hint ? ` (hint: ${err.hint})` : ''}`);
      }
    }
  );

  return server;
}

// ── HTTP transport (stateless: one server per request) ────────────────────
// enableJsonResponse avoids SSE, which Passenger/LiteSpeed on cPanel buffers.
const router = express.Router();


// ── Who may reach this endpoint ───────────────────────────────────────────
//
// team.kindredvineyards.com is DNS-only, so requests hit Apache directly and
// a Cloudflare WAF rule never sees them. This is the gate instead.
//
// Getting the client IP right, empirically rather than by assumption:
//   req.ip                     -> 127.0.0.1   (the Passenger socket — useless)
//   req.socket.remoteAddress   -> 127.0.0.1   (same)
//   x-forwarded-for            -> the real chain
//
// Apache APPENDS the address it observed, so the LAST entry is the one it
// vouches for and everything before it is caller-supplied. Verified by
// spoofing: sending "X-Forwarded-For: 160.79.104.5" arrived as
// "160.79.104.5, 86.38.59.254" — the lie kept, the truth appended after it.
// Reading the FIRST entry (the usual convention) would let anyone claim to be
// Anthropic with one header.
//
// Deliberately NOT using Express `trust proxy`: it is app-wide state that also
// changes req.protocol and secure-cookie behaviour for every other route, and
// with one proxy hop it resolves to the same address this does. Parsing the
// header here keeps the blast radius to this router.
//
// CAVEAT: this assumes exactly one proxy in front. Putting the domain behind
// Cloudflare's proxy would make the last entry Cloudflare's edge rather than
// the caller, and this check would then allow everyone. If the orange cloud
// goes on, switch to cf-connecting-ip and re-verify by spoofing it.

const DEFAULT_ALLOWED_IPS = '160.79.104.0/21,2607:6bc0::/48';

/** An address as a big-endian integer, or null if it is not an address. */
export function parseIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return null;
  if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']'));          // [::1]:port
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);       // ::ffff:1.2.3.4
  if (mapped) ip = mapped[1];

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    let v = 0n;
    for (const p of parts) v = (v << 8n) | BigInt(p);
    return { bits: 32, value: v };
  }

  if (ip.includes(':')) {
    if ((ip.match(/::/g) || []).length > 1) return null;
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':').filter(Boolean) : [];
    let groups;
    if (tail === undefined) {
      groups = h;
    } else {
      const t = tail ? tail.split(':').filter(Boolean) : [];
      const fill = 8 - h.length - t.length;
      if (fill < 0) return null;
      groups = [...h, ...Array(fill).fill('0'), ...t];
    }
    if (groups.length !== 8) return null;
    let v = 0n;
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      v = (v << 16n) | BigInt(parseInt(g, 16));
    }
    return { bits: 128, value: v };
  }
  return null;
}

/** "160.79.104.0/21" -> a comparable network, or null. */
export function parseCidr(text) {
  const [addr, lenRaw] = String(text || '').trim().split('/');
  const ip = parseIp(addr);
  if (!ip) return null;
  const len = lenRaw === undefined ? ip.bits : Number(lenRaw);
  if (!Number.isInteger(len) || len < 0 || len > ip.bits) return null;
  const shift = BigInt(ip.bits - len);
  return { bits: ip.bits, shift, network: (ip.value >> shift) << shift };
}

/** Is this address inside that network? Families never match across each other. */
export function ipInCidr(ip, cidr) {
  if (!ip || !cidr || ip.bits !== cidr.bits) return false;
  return ((ip.value >> cidr.shift) << cidr.shift) === cidr.network;
}

/**
 * The address Apache observed: the last x-forwarded-for entry, falling back to
 * the socket when the header is absent (direct connection, e.g. localhost).
 */
export function clientIpOf(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || '';
}

const ALLOWED = (process.env.MCP_ALLOWED_IPS || DEFAULT_ALLOWED_IPS)
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((text) => { const c = parseCidr(text); if (!c) console.warn(`[mcp] ignoring unparseable MCP_ALLOWED_IPS entry: ${text}`); return c; })
  .filter(Boolean);

if (!ALLOWED.length) console.warn('[mcp] MCP_ALLOWED_IPS parsed to nothing — every request will be refused');

router.use((req, res, next) => {
  const raw = clientIpOf(req);
  const ip = parseIp(raw);
  if (ip && ALLOWED.some((c) => ipInCidr(ip, c))) return next();

  // next('router') leaves this router entirely, so the response is whatever a
  // wrong secret would have produced. Answering 403 here would confirm the
  // path exists to anyone who found it.
  console.warn(`[mcp] refused ${raw || 'unknown-ip'} ${req.method} ${(req.originalUrl || '').split('?')[0]}`);
  return next('router');
});


router.post('/', express.json({ limit: '2mb' }), async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp-db] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Stateless mode has no SSE stream and no session to delete.
const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });

router.get('/', methodNotAllowed);
router.delete('/', methodNotAllowed);

//export default router;
export const mcpDbRouter = router;