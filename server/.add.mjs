import pg from 'pg';
import dotenv from 'dotenv';
import crypto from 'crypto';
dotenv.config({ path: new URL('.env', import.meta.url).pathname });
const c = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT||5432,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
await c.connect();
await c.query(`SET search_path TO ${process.env.DB_SCHEMA}, public`);
const t = (await c.query(`SELECT square_access_token t FROM company_integrations LIMIT 1`)).rows[0].t;
await c.end();
const H = { Authorization:`Bearer ${t}`, 'Square-Version':'2025-01-23','Content-Type':'application/json' };
const ORDER='mAKkOYIgVpYIiNykY4fKuPzujxAZY';

// Same catalog item the POS ticket used, so this is like-for-like.
const r = await fetch(`https://connect.squareup.com/v2/orders/${ORDER}`, {
  method:'PUT', headers:H,
  body: JSON.stringify({
    idempotency_key: crypto.randomUUID(),
    order: { location_id:'ZAFSDKP5FD2PZ', version:1,
      line_items:[{ catalog_object_id:'KWXWBO4S2BPKTWXAIMA6D3X7', quantity:'1' }] },
  }),
});
const j = await r.json();
console.log(`[HTTP ${r.status}]`);
if (j.errors) { j.errors.forEach(e=>console.log(`  ${e.code}: ${e.detail||''} ${e.field||''}`)); process.exit(0); }
const o = j.order;
console.log(`  id=${o.id} state=${o.state} ticket_name=${o.ticket_name} version=${o.version}`);
console.log(`  total=$${((o.total_money?.amount||0)/100).toFixed(2)}  source=${JSON.stringify(o.source)}`);
for (const li of o.line_items||[]) console.log(`  item: ${li.quantity}x ${li.name} (${li.variation_name||''})`);
