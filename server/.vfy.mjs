import { runCatalogSync } from './lib/squareCatalogSync.js';
await runCatalogSync('8d2df498-b5c0-4f73-94cd-323956036113');
import { query } from './db.js';
const sq = (await query(`SELECT civ.sku FROM team_square.catalog_item ci
  JOIN team_square.catalog_item_variation civ ON civ.item_id=ci.id
  JOIN team_square.catalog_category cc ON cc.id=ci.reporting_category_id
  WHERE cc.name='Wine Glass (5oz)' AND ci.is_deleted=false AND ci.is_archived=false
    AND civ.sku LIKE '%-gls'`)).rows;
const th = (await query(`SELECT sku FROM product.product_variants WHERE is_glass=true`)).rows;
console.log('Square glass SKUs now ending -gls :', sq.length);
console.log('TeamHub glass variants (is_glass) :', th.length);
const sqs=new Set(sq.map(x=>x.sku)), ths=new Set(th.map(x=>x.sku));
console.log('present in both, matching exactly :', [...ths].filter(s=>sqs.has(s)).length);
process.exit(0);
