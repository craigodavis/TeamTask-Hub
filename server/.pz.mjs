import { square } from '/tmp/sq.mjs';
const sq = await square();
const items = await sq.listItems();
console.log('--- LIVE Square: peach / prosciutto ---');
for (const o of items) {
  const n = o.item_data?.name || '';
  if (!/peach|prosciutto/i.test(n)) continue;
  for (const v of o.item_data.variations || []) {
    const d = v.item_variation_data;
    console.log(`  "${n}"  ${d.price_money ? '$'+(d.price_money.amount/100).toFixed(2) : '(variable)'}  sku=${d.sku||'(none)'}`);
  }
}
process.exit(0);
