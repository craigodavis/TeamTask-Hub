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

// Build C3 to mirror the POS ticket as closely as the API allows.
const r = await fetch('https://connect.squareup.com/v2/orders', {
  method:'POST', headers:H,
  body: JSON.stringify({ idempotency_key: crypto.randomUUID(), order: {
    location_id:'ZAFSDKP5FD2PZ', state:'OPEN', ticket_name:'C4',
    customer_id:'S06645SD2NJS58SETCVC7X33WM',
    created_by_team_member_id:'vYR2fdShje9BjOqNVp-q',
    line_items:[{ catalog_object_id:'KWXWBO4S2BPKTWXAIMA6D3X7', quantity:'1' }],
    taxes:[{ catalog_object_id:'MIVKWVJX6AKP5RFONMNRQ2EZ', scope:'LINE_ITEM' }],
    fulfillments:[{ type:'PICKUP', state:'PROPOSED', pickup_details:{ recipient:{ display_name:'Craig Owen Davis' }, schedule_type:'ASAP' } }],
  }}),
});
const j = await r.json();
console.log(`[HTTP ${r.status}]`);
if (j.errors) { j.errors.forEach(e=>console.log(`  ${e.code}: ${e.detail||''} ${e.field||''}`)); process.exit(0); }
const o = j.order;
console.log(`  id=${o.id} ticket=${o.ticket_name} state=${o.state}`);
console.log(`  source=${JSON.stringify(o.source)}`);
console.log(`  created_by_team_member_id=${o.created_by_team_member_id||'(absent)'}`);
console.log(`  fulfillments=${o.fulfillments? JSON.stringify(o.fulfillments[0]).slice(0,90):'(absent)'}`);
console.log(`  taxes=${o.taxes? o.taxes[0].name+' '+o.taxes[0].percentage+'%':'(absent)'}  total=$${((o.total_money?.amount||0)/100).toFixed(2)}`);
