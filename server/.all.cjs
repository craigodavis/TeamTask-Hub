const { Client } = require('pg');
require('dotenv').config({ path: __dirname + '/.env' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function req(u,o,t=4){for(let i=0;i<t;i++){try{return await fetch(u,o);}catch(e){if(i===t-1)throw e;await sleep(900*(i+1));}}}
(async () => {
  const c = new Client({host:process.env.DB_HOST,port:process.env.DB_PORT||5432,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,database:process.env.DB_DATABASE}); await c.connect();
  await c.query('SET search_path TO ' + (process.env.DB_SCHEMA||'teamtask_hub') + ', public');
  const i = (await c.query('SELECT c7_api_key ck, c7_tenant_slug ct FROM company_integrations LIMIT 1')).rows[0];
  await c.end();
  const H = {Authorization:'Basic '+Buffer.from('club-pickup-enforcer:'+i.ck).toString('base64'), tenant:i.ct};
  const cj = await (await req('https://api.commerce7.com/v1/club?limit=50',{headers:H})).json();
  console.log('=== ALL CLUBS ===');
  (cj.clubs||[]).forEach(cl => console.log('  ' + cl.id + '  ' + String(cl.adminStatus||'').padEnd(14) + cl.title));
  let page=1, all=[];
  while(true){ const j = await (await req('https://api.commerce7.com/v1/club-package?limit=50&page='+page,{headers:H})).json();
    const a=j.clubPackages||[]; all.push(...a); if(a.length<50||page>10) break; page++; await sleep(250); }
  console.log('\n=== existing packages dated Sept 2026 ===');
  all.filter(p => String(p.processDate||'').startsWith('2026-09')).forEach(p =>
    console.log('  ' + String(p.status).padEnd(10) + String(p.club&&p.club.title).padEnd(28)
      + '"' + p.title + '"   items=' + (p.items||[]).length + '  id=' + p.id));
  console.log('\n=== what the June RED packages listed (do they include whites?) ===');
  const jr = all.find(p => p.title === '26 June 4 Bottle Red');
  if (jr) (jr.items||[]).forEach(it => console.log('   def=' + String(it.defaultQuantity).padStart(2)
    + ' max=' + String(it.maxQuantity==null?'—':it.maxQuantity).padStart(4) + '  ' + it.productTitle));
})();
