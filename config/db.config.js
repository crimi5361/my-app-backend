const { Pool } = require("pg");
const { protegerPool } = require("./poolResilient");
// Le chargement des variables d'environnement (.env.local / .env.production) est fait une
// seule fois, par server.js, avant que ce module ne soit require — pas ici, pour éviter que
// ce module ne retombe sur un éventuel .env générique (obsolète) et écrase le bon fichier.

// Bascule automatique local / Neon : DATABASE_URL présent (.env.production) => Neon (SSL requis),
// sinon les variables DB_HOST/DB_USER/... (.env.local) => PostgreSQL local (pas de SSL).
// ✅ PERF : dimensionnement explicite du pool (au lieu des valeurs par défaut implicites de `pg`).
// max relevé à 20 (marge de montée en charge — l'endpoint Neon utilisé en production est le
// endpoint "-pooler" (PgBouncer), qui absorbe cette hausse côté base). connectionTimeoutMillis
// passe de 0 (attente indéfinie) à 5000 : si le pool est saturé, une requête échoue proprement
// après 5s au lieu de rester bloquée sans limite. idleTimeoutMillis explicité mais inchangé.
// connectionTimeoutMillis : 5 000 était trop court. MESURÉ le 2026-08-21 depuis
// Abidjan, ouvrir une connexion vers l'endpoint Neon prend 2 400 à 3 900 ms — un
// simple pic dépassait donc le délai et faisait échouer la requête. À 20 000 ms
// on couvre aussi le réveil du compute mis en veille par Neon.
// idleTimeoutMillis relevé à 30 000 : recycler une connexion toutes les 10 s
// obligeait à repayer ces ~3 s en permanence.
const poolConfig = {
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
  keepAlive: true,
};

const pool = process.env.DATABASE_URL
  ? new Pool({
      ...poolConfig,
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      ...poolConfig,
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_DATABASE,
      password: process.env.DB_PASSWORD,
      port: parseInt(process.env.DB_PORT) || 5432,
    });


// ⚠️ NE PAS RETIRER — voir config/poolResilient.js. Sans cette ligne, une
// connexion coupée par Neon (mise en veille du compute, redémarrage, réseau)
// fait tomber TOUT le processus backend, quelle que soit la requête en cours.
// Constaté le 2026-08-21 : « server conn crashed? », code 08P01, severity FATAL.
protegerPool(pool, "base");

pool.on("connect", (client) => {
  client.query("SET search_path TO public").catch((err) => {
    console.error("❌ Impossible de définir search_path :", err.message);
  });
});

pool.connect((err, _client, release) => {
  if (err) {
    return console.error("❌ Erreur de connexion à la base de données", err.stack);
  }
  console.log(`✅ Connecté à la base de données PostgreSQL (${process.env.DATABASE_URL ? "Neon" : "locale"})`);
  release();
});

module.exports = pool;
