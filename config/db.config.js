const { Pool } = require("pg");
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
const poolConfig = {
  max: 20,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
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
