import dotenv from 'dotenv'; dotenv.config();
import { query, pool } from './db.js';
import { makeC7Client } from './lib/commerce7Client.js';
const integ=(await query(`SELECT c7_tenant_slug,c7_tenant_id,c7_api_base_url,c7_api_key FROM teamtask_hub.company_integrations WHERE company_id=$1`,['8d2df498-b5c0-4f73-94cd-323956036113'])).rows[0];
const c7=makeC7Client(integ);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const get=async(p,t=3)=>{for(let i=0;i<t;i++){try{return await c7.get(p);}catch(e){if(i===t-1)throw e;await sleep(1500);}}};
const clubs=(await get('/club')).clubs||[];
const byId=Object.fromEntries(clubs.map(x=>[x.id,x.title]));
let all=[],page=1;
while(page<=10){ const r=await get(`/club-package?limit=50&page=${page}`); const l=r.clubPackages||[]; all.push(...l); if(l.length<50) break; page++; await sleep(400); }
const live=all.filter(p=>p.status!=='Archive');
console.log(`${all.length} packages, ${live.length} not archived\n`);
for(const p of live){
  await sleep(400);
  const f=await get(`/club-package/${p.id}`);
  const items=f.items||[];
  const mixed=items.filter(i=>/[A-Z]/.test(i.sku||''));
  console.log(`"${f.title}" [${f.status}] club=${byId[f.clubId]} process=${String(f.processDate).slice(0,10)} items=${items.length}`);
  console.log(`   mixed-case SKUs: ${mixed.length? mixed.map(i=>i.sku).join(', ') : 'NONE'}`);
  if(mixed.length) for(const i of mixed) console.log(`      ${i.productTitle} -> ${i.sku}`);
}
await pool.end();
