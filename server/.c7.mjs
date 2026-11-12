import 'dotenv/config';
import { query } from './db.js';
const t = await query(`SELECT table_name FROM information_schema.tables WHERE table_schema='commerce7' ORDER BY 1`);
for (const x of t.rows) {
  try { const c = await query(`SELECT count(*)::int n FROM commerce7.${x.table_name}`);
    console.log(`  ${x.table_name.padEnd(28)} ${String(c.rows[0].n).padStart(7)} rows`);
  } catch(e){ console.log(`  ${x.table_name}: ${e.message.slice(0,40)}`); }
}
const r = await query(`SELECT min(reservation_date) AS a, max(reservation_date) AS b, max(created_at) AS c FROM commerce7.reservation`);
console.log('\ncommerce7.reservation range:', JSON.stringify(r.rows[0]));
process.exit(0);
