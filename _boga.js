require('dotenv').config({ path: __dirname + '/.env.local' });
const { Client } = require('pg');
const fs = require('fs');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const def = async n => (await c.query(`SELECT pg_get_viewdef($1::regclass, true) AS d`, ['assistant.'+n])).rows[0].d.trim().replace(/;$/,'');
  const out = {};
  for (const v of ['v_agents','v_personnes','t_utilisateur']) out[v] = await def(v);
  fs.writeFileSync('_defs.json', JSON.stringify(out), 'utf8');
  for (const [k,v] of Object.entries(out)) {
    console.log(`\n=== ${k} (${v.length} car.) ===`);
    console.log('  exclusion deja presente : ' + (v.includes('agent_exclu') ? 'OUI' : 'NON'));
    console.log('  ' + v.split('\n').slice(-3).join('\n  ').slice(0,300));
  }
  const e = await c.query(`SELECT utilisateur_id, motif FROM assistant.agent_exclu`);
  console.log('\n=== agent_exclu ===');
  e.rows.forEach(r=>console.log('  ',JSON.stringify(r)));
  await c.end();
})().catch(e=>{console.error(e.message);process.exit(1);});
