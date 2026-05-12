const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT) || 5432, // Convertir en nombre
});

pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Erreur de connexion à la base de données', err.stack);
  }
  console.log('✅ Connecté à la base de données PostgreSQL');
  release();
});
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_PORT:', process.env.DB_PORT);

module.exports = pool;