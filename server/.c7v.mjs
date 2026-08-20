import pg from 'pg'; import dotenv from 'dotenv';
dotenv.config({ path: new URL('.env', import.meta.url).pathname });
const c = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT||5432,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
await c.connect(); await c.query(`SET search_path TO ${process.env.DB_SCHEMA}, public`);
const r = (await c.query(`SELECT c7_tenant_slug s, c7_api_key k, c7_api_base_url b FROM company_integrations LIMIT 1`)).rows[0];
await c.end();
if (!r?.k) { console.log('no c7 api key in company_integrations'); process.exit(0); }
const base = r.b || 'https://api.commerce7.com/v1';
const H = { Authorization:`Basic ${r.k}`, tenant: r.s, 'Content-Type':'application/json' };
// Ground truth: what does Commerce7 say the SKU is RIGHT NOW?
const res = await fetch(`${base}/product?q=Peacemaker`, { headers: H });
console.log('HTTP', res.status, 'tenant', r.s);
const j = await res.json().catch(()=>({}));
if (j.errors || res.status >= 400) { console.log(JSON.stringify(j).slice(0,300)); process.exit(0); }
for (const p of (j.products||[])) {
  console.log(`\nproduct: ${p.title}  (${p.id})`);
  for (const v of p.variants||[]) console.log(`   variant sku="${v.sku}"  title="${v.title}"  id=${v.id}`);
}
