import dotenv from 'dotenv'; dotenv.config();
import fs from 'node:fs';
import { query, pool } from './db.js';
import { makeC7Client, c7FetchAll } from './lib/commerce7Client.js';
const APPLY = process.argv.includes('--apply');
const CO='8d2df498-b5c0-4f73-94cd-323956036113';
const integ=(await query(`SELECT c7_tenant_slug,c7_tenant_id,c7_api_base_url,c7_api_key FROM teamtask_hub.company_integrations WHERE company_id=$1`,[CO])).rows[0];
const c7=makeC7Client(integ);

// 1. old SKU per variant, straight off the orders that reference them
const oldByVariant=new Map();
for(let page=1;page<=12;page++){
  const r=await c7.get(`/order?orderPaidDate=btw:2026-06-01|2026-06-30&limit=50&page=${page}`);
  const os=r.orders||[];
  for(const o of os) for(const i of o.items||[]) if(i.productVariantId && i.sku && !oldByVariant.has(i.productVariantId)) oldByVariant.set(i.productVariantId,i.sku);
  if(os.length<50) break;
}
// 2. what needs changing
const all=await c7FetchAll(integ,'/product','products',50);
const work=[];
for(const p of all) for(const v of p.variants||[]){
  const want=oldByVariant.get(v.id);
  if(want && want!==v.sku) work.push({product:p, variantId:v.id, wine:p.title, from:v.sku, to:want});
}
console.log(`${work.length} Commerce7 variants to restore:\n`);
console.table(work.map(w=>({wine:w.wine, from:w.from, to:w.to})));
fs.writeFileSync('/tmp/sku-restore-map.json', JSON.stringify(work.map(w=>({wine:w.wine,variantId:w.variantId,lowercase:w.from,restored:w.to})),null,2));
console.log('\nrollback map saved -> /tmp/sku-restore-map.json');
if(!APPLY){ console.log('\nDRY RUN — nothing written. re-run with --apply'); await pool.end(); process.exit(0); }

// 3. apply, product by product (variants are nested)
const DERIVED=new Set(['productId','hasInventory','inventoryPolicy','inventory']);
const byProduct=new Map();
for(const w of work){ if(!byProduct.has(w.product.id)) byProduct.set(w.product.id,{p:w.product,changes:[]}); byProduct.get(w.product.id).changes.push(w); }
for(const [pid,{p,changes}] of byProduct){
  const fresh=await c7.get(`/product/${pid}`);
  const variants=(fresh.variants||[]).map(cv=>{
    const base=Object.fromEntries(Object.entries(cv).filter(([k])=>!DERIVED.has(k)));
    const ch=changes.find(c=>c.variantId===cv.id);
    return ch ? {...base, sku: ch.to} : base;
  });
  await c7.put(`/product/${pid}`, { variants });
  console.log(`  C7  ${p.title}: ${changes.map(c=>`${c.from} -> ${c.to}`).join(', ')}`);
}
// 4. keep TeamHub in step, or the next save pushes the lowercase back
const c=await pool.connect(); await c.query("SET search_path TO product, teamtask_hub");
for(const w of work){
  const r=await c.query(`UPDATE product.product_variants v SET sku=$1, updated_at=NOW()
      FROM product.c7_variant_data cd WHERE cd.variant_id=v.id AND cd.c7_variant_id=$2 RETURNING v.sku`,[w.to,w.variantId]);
  if(r.rowCount) console.log(`  TH  ${w.wine}: -> ${w.to}`);
}
c.release(); await pool.end();
