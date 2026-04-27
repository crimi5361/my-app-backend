const { Client } = require('pg');

const client = new Client({
  host: '192.168.1.14',
  port: 5432,
  user: 'postgres',
  password: 'ange',
  database: 'db_iipea1'
});

client.connect()
  .then(() => {
    console.log('✅ Connexion réussie à PostgreSQL depuis machine 2 !');
    return client.end();
  })
  .catch(err => {
    console.error('❌ Erreur de connexion :', err.message);
  });
