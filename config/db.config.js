const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD, 
  port: process.env.DB_PORT,
});

pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Erreur de connexion à la base de données', err.stack);
  }
  console.log('✅ Connecté à la base de données PostgreSQL');
  release();
});
console.log('DB_USER:', process.env.DB_USER); // doit afficher postgres
console.log('DB_PASSWORD:', process.env.DB_PASSWORD); // doit afficher ange


module.exports = pool;