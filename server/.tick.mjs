import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('.env', import.meta.url).pathname });
const c = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT||5432,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
await c.connect();
await c.query(`SET search_path TO ${process.env.DB_SCHEMA}, public`);
const t = (await c.query(`SELECT square_access_token t FROM company_integrations LIMIT 1`)).rows[0].t;
await c.end();

const LOCS = { ZAFSDKP5FD2PZ:'Kindred Vineyards', LH1DF72NWR23D:'Kindred by the Creek' };
const since = new Date(Date.now() - 3*3600*1000).toISOString();

const r = await fetch('https://connect.squareup.com/v2/orders/search', {
  method:'POST',
  headers:{ Authorization:`Bearer ${t}`, 'Square-Version':'2025-01-23', 'Content-Type':'application/json' },
  body: JSON.stringify({
    location_ids: Object.keys(LOCS),
    query: { filter: { date_time_filter: { created_at: { start_at: since } } },
             sort: { sort_field:'CREATED_AT', sort_order:'DESC' } },
    limit: 50,
  }),
});
const j = await r.json();
if (j.errors) { console.log('ERROR', JSON.stringify(j.errors)); process.exit(1); }
const orders = j.orders || [];
console.log(`Orders at both locations since ${since.slice(11,16)} UTC: ${orders.length}\n`);
for (const o of orders) {
  const paid = !!(o.tenders?.length) || o.state === 'COMPLETED';
  const total = ((o.total_money?.amount||0)/100).toFixed(2);
  const items = (o.line_items||[]).map(li=>`${li.quantity}x ${li.name}`).join(', ').slice(0,60);
  console.log(`  ${o.state.padEnd(9)} ${paid?'PAID   ':'UNPAID ' } $${total.padStart(8)}  ${(o.ticket_name||'—').padEnd(14)} ${LOCS[o.location_id]?.padEnd(22)} ${o.created_at.slice(11,19)}`);
  if (items) console.log(`            ${items}`);
  if (o.customer_id) console.log(`            customer_id: ${o.customer_id}`);
}
const open = orders.filter(o=>!(o.tenders?.length) && o.state!=='COMPLETED');
console.log(`\n=> ${open.length} unpaid/open order(s) visible via the API`);
console.log(open.length ? '   Your account IS on the unified Orders backend — open tickets are readable.'
                        : '   No open tickets surfaced yet.');
