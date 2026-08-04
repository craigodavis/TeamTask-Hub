const { Client } = require('pg');
require('dotenv').config({ path: __dirname + '/.env' });
(async()=>{
  const c=new Client({host:process.env.DB_HOST,port:process.env.DB_PORT||5432,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,database:process.env.DB_DATABASE}); await c.connect();
  console.table((await c.query(`SELECT column_name, data_type, udt_name FROM information_schema.columns
    WHERE table_schema='product' AND table_name='c7_products'
      AND column_name IN ('tags','food_pairings','available_channels')`)).rows);
  await c.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
