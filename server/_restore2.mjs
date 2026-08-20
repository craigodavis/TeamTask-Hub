import dotenv from 'dotenv'; dotenv.config();
import fs from 'node:fs';
import { query, pool } from './db.js';
import { makeC7Client, c7FetchAll } from './lib/commerce7Client.js';
const APPLY=process.argv.includes('--apply');
const CO='8d2df498-b5c0-4f73-94cd-323956036113';
const integ=(await query(`SELECT c7_tenant_slug,c7_tenant_id,c7_api_base_url,c7_api_key FROM teamtask_hub.company_integrations WHERE company_id=$1`,[CO])).rows[0];
const c7=makeC7Client(integ);
const map=JSON.parse(fs.readFileSync('/tmp/sku-restore-map.json','utf8'));
const all=await c7FetchAll(integ,'/product','products',50);
const DERIVED=new Set(['productId','hasInventory','inventoryPolicy','inventory']);
const byProduct=new Map();
for(const m of map){
  const p=all.find(p=>(p.variants||[]).some(v=>v.id===m.variantId));
  if(!p) continue;
  const cur=(p.variants||[]).find(v=>v.id===m.variantId);
  if(cur.sku===m.restored){ console.log(`  = ${m.wine}: already ${m.restored}`); continue; }
  if(!byProduct.has(p.id)) byProduct.set(p.id,{p,changes:[]});
  byProduct.get(p.id).changes.push(m);
}
const done=[], locked=[];
for(const [pid,{p,changes}] of byProduct){
  if(!APPLY){ console.log(`  would set ${p.title}: ${changes.map(c=>c.restored).join(', ')}`); continue; }
  try{
    const fresh=await c7.get(`/product/${pid}`);
    const variants=(fresh.variants||[]).map(cv=>{
      const base=Object.fromEntries(Object.entries(cv).filter(([k])=>!DERIVED.has(k)));
      const ch=changes.find(c=>c.variantId===cv.id);
      return ch?{...base,sku:ch.restored}:base;
    });
    await c7.put(`/product/${pid}`,{variants});
    for(const ch of changes){ done.push(ch); console.log(`  ✔ ${ch.wine}: ${ch.lowercase} -> ${ch.restored}`); }
  }catch(e){
    const why = /club subscription shipments/.test(e.message) ? 'LOCKED by active club shipment' : e.message.slice(0,120);
    for(const ch of changes){ locked.push({...ch,why}); console.log(`  ✖ ${ch.wine}: ${why}`); }
  }
}
if(APPLY){
  const c=await pool.connect(); await c.query("SET search_path TO product, teamtask_hub");
  for(const w of done)
    await c.query(`UPDATE product.product_variants v SET sku=$1, updated_at=NOW()
      FROM product.c7_variant_data cd WHERE cd.variant_id=v.id AND cd.c7_variant_id=$2`,[w.restored,w.variantId]);
  console.log(`\nTeamHub synced for ${done.length} restored variants (left alone for the ${locked.length} that Commerce7 refused).`);
  c.release();
  fs.writeFileSync('/tmp/sku-restore-result.json',JSON.stringify({done,locked},null,2));
}
await pool.end();
