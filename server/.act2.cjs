const { Client } = require('pg');
require('dotenv').config({ path: __dirname + '/.env' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function req(u,o,t=8){for(let i=0;i<t;i++){try{
  const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(),20000);
  const r=await fetch(u,Object.assign({},o,{signal:ctl.signal})); clearTimeout(to);
  if(r.status===429){await sleep(3000*Math.pow(1.6,i));continue;} return r;
}catch(e){if(i===t-1)throw e;await sleep(1200*(i+1));}}throw new Error('429');}
const TWO_WEEK = '2026-08-21T14:00:00.000Z';
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
  const sept = all.filter(p => /^26 September /.test(p.title||'')).sort((a,b)=>a.title.localeCompare(b.title));
  // 1. reminder dates
  console.log('--- setting two-week reminder to 21 Aug 8:00am Boise ---');
  for (const p of sept) {
    const r = await req('https://api.commerce7.com/v1/club-package/'+p.id,{method:'PUT',headers:H,
      body: JSON.stringify({ email: { twoWeekSendDate: TWO_WEEK,
        twoDaySendDate: (p.email && p.email.twoDaySendDate) || null,
        isSendCreditCardDecline: p.email ? p.email.isSendCreditCardDecline !== false : true } })});
    const b = await r.json();
    console.log((r.ok?'  OK   ':'  FAIL ') + p.title.padEnd(30)
      + (r.ok ? '2wk=' + String(b.email && b.email.twoWeekSendDate).slice(0,16) : JSON.stringify(b.errors||b).slice(0,140)));
    await sleep(550);
  }
  // 2. find how to activate
  console.log('\n--- probing activation endpoints on ' + sept[0].title + ' ---');
  const id = sept[0].id;
  const probes = [
    ['POST', '/v1/club-package/'+id+'/activate', {}],
    ['PUT',  '/v1/club-package/'+id+'/status', {status:'Active'}],
    ['POST', '/v1/club-package/'+id+'/status', {status:'Active'}],
    ['PUT',  '/v1/club-package/'+id, {autoProcessStatus:'Active'}],
  ];
  for (const [m, path, body] of probes) {
    const r = await req('https://api.commerce7.com'+path,{method:m,headers:H,body:JSON.stringify(body)});
    console.log('  ' + m + ' ' + path.replace(id,'{id}') + ' -> ' + r.status + '  ' + (await r.text()).slice(0,150));
    await sleep(500);
  }
})();
