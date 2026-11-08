// Tests de GET /api/integration/v1/presences (assiduité lue dans les tables d'EduCheck).
// Base locale préparée par preparer_base.ps1 ; ce fichier crée puis retire la copie de test
// des tables d'EduCheck (tables_educheck.sql).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.DB_DATABASE = process.env.DB_DATABASE || 'myiipea_local';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.CLE_PUBLIQUE_APPLICATION_B = publicKey.export({ type: 'spki', format: 'pem' });

const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../../config/db.config');
const routeur = require('../../routes/integrationB.routes');
const { oublierSchema } = require('../../services/integrationB/assiduite');

let serveur;
let base;

async function appeler(chemin, scope = 'assiduite:read referentiel:read etudiants:read') {
  const jeton = jwt.sign({ scope, jti: crypto.randomUUID() }, privateKey, {
    algorithm: 'RS256', expiresIn: '5m', keyid: 'b-test', issuer: 'iipea-application-b',
    audience: 'iipea-application-a-integration',
  });
  const r = await fetch(`${base}${chemin}`, { headers: { Authorization: `Bearer ${jeton}` } });
  return { statut: r.status, corps: await r.json() };
}

async function idGroupe(libelle) {
  const { rows } = await pool.query('SELECT uuid_public FROM groupe WHERE nom = $1', [libelle]);
  return rows[0].uuid_public;
}

before(async () => {
  await pool.query('DROP SCHEMA IF EXISTS appels CASCADE');
  oublierSchema();
  const app = express();
  app.use('/api/integration/v1', routeur);
  await new Promise((resolve) => { serveur = app.listen(0, resolve); });
  base = `http://127.0.0.1:${serveur.address().port}/api/integration/v1`;
});

after(async () => {
  await pool.query('DROP SCHEMA IF EXISTS appels CASCADE');
  serveur.close();
  await pool.end();
});

test('scope assiduite:read exigé', async () => {
  const r = await appeler('/presences?du=2026-10-01&au=2026-10-31&groupe_id=x', 'referentiel:read');
  assert.equal(r.statut, 403);
});

test('paramètres obligatoires et dates valides', async () => {
  assert.equal((await appeler('/presences?du=2026-10-01&au=2026-10-31')).corps.code, 'PARAMETRE_INVALIDE');
  assert.equal((await appeler('/presences?du=hier&au=2026-10-31&groupe_id=x')).statut, 400);
  assert.equal((await appeler('/presences?du=2026-11-01&au=2026-10-01&groupe_id=x')).statut, 400);
});

test('sans les tables d’EduCheck : source indisponible, jamais 0 %', async () => {
  const groupe = await idGroupe('SIC L1-A');
  const r = await appeler(`/presences?du=2026-10-01&au=2026-10-31&groupe_id=${groupe}`);
  assert.equal(r.statut, 200);
  assert.equal(r.corps.source_disponible, false);
  assert.deepEqual(r.corps.elements, []);
});

test('résumé par étudiant : appels soumis seulement, dernier justificatif, pas de retards', async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'tables_educheck.sql'), 'utf8'));
  oublierSchema();
  const groupe = await idGroupe('SIC L1-A');
  const r = await appeler(`/presences?du=2026-10-01&au=2026-10-31&groupe_id=${groupe}`);
  assert.equal(r.statut, 200);
  assert.equal(r.corps.source_disponible, true);
  const parMatricule = Object.fromEntries(r.corps.elements.map((e) => [e.matricule_iipea, e]));
  // L'appel du 26/10 est un brouillon : ignoré.
  assert.deepEqual(
    (({ cours_appeles, presences, absences_justifiees, absences_injustifiees, retards, taux_presence }) =>
      ({ cours_appeles, presences, absences_justifiees, absences_injustifiees, retards, taux_presence }))(parMatricule['DEMO-2026-0001']),
    { cours_appeles: 2, presences: 2, absences_justifiees: 0, absences_injustifiees: 0, retards: null, taux_presence: 100 }
  );
  const koffi = parMatricule['DEMO-2026-0002'];
  assert.equal(koffi.cours_appeles, 2);
  assert.equal(koffi.presences, 1);
  assert.equal(koffi.absences_justifiees, 1); // le dernier justificatif est validé
  assert.equal(koffi.absences_injustifiees, 0);
  assert.equal(koffi.taux_presence, 50);
  assert.equal(koffi.groupe_id, groupe);
});

test('filtre par étudiant et par période', async () => {
  const { rows } = await pool.query("SELECT uuid_public FROM etudiant WHERE matricule_iipea = 'DEMO-2026-0002'");
  const r = await appeler(`/presences?du=2026-10-01&au=2026-10-15&etudiant_id=${rows[0].uuid_public}`);
  assert.equal(r.corps.elements.length, 1);
  assert.equal(r.corps.elements[0].cours_appeles, 1);
  assert.equal(r.corps.elements[0].taux_presence, 100);
});
