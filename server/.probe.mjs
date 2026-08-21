import { query } from './db.js';
import { makeC7Client } from './lib/commerce7Client.js';
const { rows } = await query(`SELECT * FROM company_integrations WHERE c7_api_key IS NOT NULL LIMIT 1`);
const c7 = makeC7Client(rows[0]);
const MEM='1660705f-cd40-4530-87e8-d6c7edcf917e';            // Craig, Life Raft Test Club
const PKG='4df34c35-ccbd-4966-b5bd-8b81ba4753d8';            // "test release"
const d = await c7.get(`/club-membership/${MEM}/shipment`);
const ships = d.shipments || [];
console.log(`shipments on the active membership: ${ships.length} (total=${d.total})`);
for (const s of ships) {
  const keys = Object.keys(s);
  console.log(`\n  packageId=${s.clubPackageId}  ${s.clubPackageId===PKG ? '  <-- the "test release"' : ''}`);
  for (const k of ['id','clubShipmentId','status','processDate','orderId','clubPackageTitle'])
    if (s[k]!==undefined) console.log(`     ${k}: ${JSON.stringify(s[k])}`);
  if (!keys.includes('id')) console.log(`     (no id field; keys = ${keys.join(', ')})`);
}
process.exit(0);
