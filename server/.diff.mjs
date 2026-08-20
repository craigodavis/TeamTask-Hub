import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('.env', import.meta.url).pathname });
const c = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT||5432,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
await c.connect();
await c.query(`SET search_path TO ${process.env.DB_SCHEMA}, public`);
const t = (await c.query(`SELECT square_access_token t FROM company_integrations LIMIT 1`)).rows[0].t;
await c.end();
const H = { Authorization:`Bearer ${t}`, 'Square-Version':'2025-01-23','Content-Type':'application/json' };

const get = async (id) => (await (await fetch(`https://connect.squareup.com/v2/orders/${id}`,{headers:H})).json()).order;
const pos = await get('uSpUMWOYRZWdGGK3csxBETrfiDDZY');   // C1 — made on the POS
const api = await get('mAKkOYIgVpYIiNykY4fKuPzujxAZY');   // C2 — made by us

const keys = [...new Set([...Object.keys(pos), ...Object.keys(api)])].sort();
const show = (v) => v === undefined ? '(absent)' : (typeof v === 'object' ? JSON.stringify(v) : String(v));

console.log('field                       C1 (POS)                                  C2 (API)');
console.log('─'.repeat(115));
for (const k of keys) {
  const a = show(pos[k]), b = show(api[k]);
  const same = a === b;
  if (['id','created_at','updated_at','ticket_name'].includes(k)) continue;   // expected to differ
  const mark = same ? '  ' : '**';
  console.log(`${mark}${k.padEnd(24)} ${a.slice(0,40).padEnd(41)} ${b.slice(0,40)}`);
}
console.log('\n** = differs');
console.log('\n=== line item shape ===');
console.log('C1:', JSON.stringify((pos.line_items||[])[0] || {}).slice(0,300));
console.log('C2:', JSON.stringify((api.line_items||[])[0] || {}).slice(0,300));
