// Crée (ou fait tourner le mot de passe de) le rôle PostgreSQL en lecture seule
// utilisé par l'Assistant Fondateur.
//
//   node migrations/setup-role-assistant.js
//
// Le mot de passe est généré ici et affiché UNE SEULE FOIS : il n'est écrit dans
// aucun fichier versionné. Copiez la ligne affichée dans .env.local et
// .env.production, puis relancez le serveur.
//
// Le rôle porte ses propres garde-fous, appliqués par PostgreSQL à chaque
// connexion, indépendamment de ce que fait le code applicatif :
//   • default_transaction_read_only : toute transaction est en lecture seule
//   • statement_timeout             : une requête trop longue est tuée
//   • idle_in_transaction_session_timeout : pas de transaction laissée ouverte
const path = require('path');
const crypto = require('crypto');

const envFile = `.env.${process.env.NODE_ENV === 'production' ? 'production' : 'local'}`;
require('dotenv').config({ path: path.resolve(__dirname, '..', envFile) });

const db = require('../config/db.config');

const ROLE = 'assistant_ro';

(async () => {
  // base64url : pas de caractère à échapper dans une URL de connexion.
  const motDePasse = crypto.randomBytes(24).toString('base64url');
  const client = await db.connect();

  try {
    const existe = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);

    if (existe.rows.length === 0) {
      await client.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${motDePasse}'`);
      console.log(`✅ Rôle ${ROLE} créé.`);
    } else {
      await client.query(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${motDePasse}'`);
      console.log(`♻️  Rôle ${ROLE} existait déjà — mot de passe renouvelé.`);
    }

    // Garde-fous portés par le rôle lui-même.
    await client.query(`ALTER ROLE ${ROLE} SET default_transaction_read_only = on`);
    await client.query(`ALTER ROLE ${ROLE} SET statement_timeout = '10s'`);
    await client.query(`ALTER ROLE ${ROLE} SET idle_in_transaction_session_timeout = '15s'`);
    // NOSUPERUSER est volontairement absent : il exige d'être superutilisateur
    // (ce que neondb_owner n'est pas sur Neon), et il est redondant — un rôle créé
    // par un non-superutilisateur ne peut pas être superutilisateur.
    await client.query(`ALTER ROLE ${ROLE} NOCREATEDB NOCREATEROLE NOINHERIT`);

    // Aucun droit hors du schéma assistant.
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA assistant TO ${ROLE}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA assistant TO ${ROLE}`);
    await client.query(`GRANT EXECUTE ON FUNCTION assistant.site_courant() TO ${ROLE}`);
    await client.query(`GRANT EXECUTE ON FUNCTION assistant.ecole_courante() TO ${ROLE}`);
    console.log('✅ Privilèges appliqués (SELECT sur le schéma assistant uniquement).');

    // Chaîne de connexion : même hôte/base que DATABASE_URL, autre identité.
    const url = new URL(process.env.DATABASE_URL);
    url.username = ROLE;
    url.password = motDePasse;

    console.log('\n' + '─'.repeat(78));
    console.log("Ajoutez cette ligne à .env.local ET .env.production, puis redémarrez :\n");
    console.log(`ASSISTANT_DATABASE_URL=${url.toString()}`);
    console.log('─'.repeat(78));
    console.log('\n⚠️  Ce mot de passe ne sera plus affiché. Relancez ce script pour en générer un autre.');
  } catch (error) {
    console.error('❌ Échec :', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.end();
  }
})();
