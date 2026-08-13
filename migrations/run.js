// Exécute un fichier .sql de ce dossier sur la base configurée.
//   node migrations/run.js 2026-08-11_module_enseignants.sql
//
// Le fichier SQL porte lui-même son BEGIN/COMMIT : un échec au milieu ne laisse pas
// la base à moitié migrée.
const fs = require('fs');
const path = require('path');

const envFile = `.env.${process.env.NODE_ENV === 'production' ? 'production' : 'local'}`;
require('dotenv').config({ path: path.resolve(__dirname, '..', envFile) });

const db = require('../config/db.config');

const fichier = process.argv[2];
if (!fichier) {
  console.error('Usage : node migrations/run.js <fichier.sql>');
  process.exit(1);
}

(async () => {
  const chemin = path.resolve(__dirname, fichier);
  const sql = fs.readFileSync(chemin, 'utf8');
  const client = await db.connect();
  try {
    console.log(`▶️  Exécution de ${fichier}...`);
    await client.query(sql);
    console.log('✅ Migration appliquée.');
  } catch (error) {
    console.error('❌ Échec de la migration :', error.message);
    if (error.position) console.error('   position :', error.position);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.end();
  }
})();
