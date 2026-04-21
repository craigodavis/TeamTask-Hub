import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const { Pool } = pg;
const schema = process.env.DB_SCHEMA || 'teamtask_hub';

/** Same as clubsteward admin/server/lib/db.js: TLS on by default (matches hostssl / pg_hba on remote servers). */
const useSsl =
  process.env.DB_SSL !== 'false' && process.env.DB_SSL !== '0';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: useSsl
    ? {
        rejectUnauthorized: false,
        require: true,
      }
    : false,
});

// Use this for all DB access so search_path is set per request
export async function query(text, params) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schema}`);
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export { pool };
