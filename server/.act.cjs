const { Client } = require('pg');
require('dotenv').config({ path: __dirname + '/.env' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function req(u,o,t=8){for(let i=0;i<t;i++){try{
  const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(),20000);
  const r=await fetch(u,Object.assign({},o,{signal:ctl.signal})); clearTimeout(to);
  if(r.status===429){await sleep(3000*Math.pow(1.6,i));continue;} return r;
}catch(e){if(i===t-1)throw e;await sleep(1200*(i+1));}}throw new Error('429');}
const TWO_WEEK = '2026-08-21T14:00:00.000Z';   // 21 Aug 8:00am America/Boise, same slot June used
(async () => {
  const c = new Client({host:process.env.DB_HOST,port:process.env.DB_PORT||5432,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,database:process.env.DB_DATABASE}); await c.connect();
  await c.query('SET search_path TO ' + (process.env.DB_SCHEMA||'teamtask_hub') + ', public');
  const i = (await c.query('SELECT c7_api_key ck, c7_tenant_slug ct FROM company_integrations LIMIT 1')).rows[0];
  await c.end();
  const H = {Authorization:'Basic '+Buffer.from('club-pickup-enforcer:'+i.ck).toString('base64'),
             'Content-Type':'application/json', tenant:i.ct};
  let pg=1, all=[];
  while(true){ const j=await (await req('https://api.commerce7.com/v1/club-package?limit=50&page='+pg,{headers:H})).json();
    const a=j.clubPackages||[]; all.push(...a); if(a.length<50||pg>10) break; pg++; await sleep(400); }
  const sept = all.filter(p => /^26 September /.test(p.title || '')).sort((a,b)=>a.title.localeCompare(b.title));
  console.log('packages to activate: ' + sept.length + '\n');
  for (const p of sept) {
    const body = { status: 'Active',
      email: { twoWeekSendDate: TWO_WEEK,
               twoDaySendDate: (p.email && p.email.twoDaySendDate) || null,
               isSendCreditCardDecline: p.email ? p.email.isSendCreditCardDecline !== false : true } };
    const r = await req('https://api.commerce7.com/v1/club-package/'+p.id,{method:'PUT',headers:H,body:JSON.stringify(body)});
    const b = await r.json();
    if (!r.ok) { console.log('FAIL ' + p.title + ': ' + r.status + ' ' + JSON.stringify(b.errors||b).slice(0,200)); continue; }
    console.log(p.title.padEnd(30) + 'status=' + String(b.status).padEnd(10)
      + '2wk=' + String(b.email && b.email.twoWeekSendDate).slice(0,16)
      + '  2day=' + String(b.email && b.email.twoDaySendDate).slice(0,16));
    await sleep(600);
  }
})();
