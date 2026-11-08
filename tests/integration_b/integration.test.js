// ============================================================================
//  Tests des routes d'intégration avec l'Application B (node --test, aucune dépendance ajoutée)
//
//  Base LOCALE requise : schéma de production + migration 001 + données fictives, recréée par
//  tests/integration_b/preparer_base.ps1. Variables : DB_HOST, DB_PORT, DB_USER, DB_PASSWORD,
//  DB_DATABASE (base « myiipea_local » par défaut).
//  Lancement : npm run test:integration-b
// ============================================================================

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.DB_DATABASE = process.env.DB_DATABASE || 'myiipea_local';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: autreCle } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.CLE_PUBLIQUE_APPLICATION_B = publicKey.export({ type: 'spki', format: 'pem' });

const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../../config/db.config');
const routeur = require('../../routes/integrationB.routes');
const { codeNiveau } = require('../../services/integrationB/ressources');

const SCOPES = 'referentiel:read etudiants:read affectations:write edt:write notes:write';
let serveur;
let base;

function jeton({ scope = SCOPES, cle = privateKey, kid = 'b-test', jti, ...autres } = {}) {
  const options = { algorithm: 'RS256', expiresIn: '5m', issuer: 'iipea-application-b',
    audience: 'iipea-application-a-integration' };
  if (kid) options.keyid = kid;
  return jwt.sign({ scope, jti: jti || crypto.randomUUID(), ...autres }, cle, options);
}

async function appeler(chemin, { methode = 'GET', corps, entetes = {}, avecJeton = true, ...options } = {}) {
  const reponse = await fetch(`${base}${chemin}`, {
    method: methode,
    headers: {
      ...(avecJeton ? { Authorization: `Bearer ${jeton(options)}` } : {}),
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
      ...entetes,
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await reponse.text();
  return { statut: reponse.status, entetes: reponse.headers, corps: texte ? JSON.parse(texte) : null };
}

async function tout(chemin) {
  const elements = [];
  let suivant = null;
  do {
    const separateur = chemin.includes('?') ? '&' : '?';
    const r = await appeler(`${chemin}${suivant ? `${separateur}curseur=${suivant}` : ''}`);
    assert.equal(r.statut, 200, JSON.stringify(r.corps));
    elements.push(...r.corps.elements);
    suivant = r.corps.curseur_suivant;
  } while (suivant);
  return elements;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/integration/v1', routeur);
  await new Promise((resolve) => { serveur = app.listen(0, resolve); });
  base = `http://127.0.0.1:${serveur.address().port}/api/integration/v1`;
});

after(async () => {
  serveur.close();
  await pool.end();
});

// --- Authentification machine (T1) -----------------------------------------------------------

test('sans jeton : 401 JETON_ABSENT', async () => {
  const r = await appeler('/sante', { avecJeton: false });
  assert.equal(r.statut, 401);
  assert.equal(r.corps.code, 'JETON_ABSENT');
});

test('jeton sans kid, signé par une autre clé ou expiré : 401', async () => {
  for (const options of [{ kid: null }, { cle: autreCle }]) {
    const r = await appeler('/sante', options);
    assert.equal(r.statut, 401);
    assert.equal(r.corps.code, 'JETON_INVALIDE');
  }
  const expire = jwt.sign({ scope: SCOPES, jti: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) - 60 },
    privateKey, { algorithm: 'RS256', keyid: 'b-test', issuer: 'iipea-application-b', audience: 'iipea-application-a-integration' });
  const r = await fetch(`${base}/sante`, { headers: { Authorization: `Bearer ${expire}` } });
  assert.equal(r.status, 401);
});

test('un jeton ne sert qu’une fois (anti-rejeu)', async () => {
  const jti = crypto.randomUUID();
  assert.equal((await appeler('/sante', { jti })).statut, 200);
  const r = await appeler('/sante', { jti });
  assert.equal(r.statut, 401);
  assert.equal(r.corps.code, 'JETON_REJOUE');
});

test('scope insuffisant : 403', async () => {
  const r = await appeler('/etudiants', { scope: 'referentiel:read' });
  assert.equal(r.statut, 403);
  assert.equal(r.corps.code, 'SCOPE_INSUFFISANT');
});

test('santé et route inconnue', async () => {
  const sante = await appeler('/sante');
  assert.equal(sante.statut, 200);
  assert.equal(sante.corps.version_contrat, '0.2.0');
  assert.equal((await appeler('/inconnue')).statut, 404);
});

// --- Lectures --------------------------------------------------------------------------------

test('référentiel : identifiants publics, jamais les SERIAL', async () => {
  const campus = await tout('/campus');
  assert.deepEqual(campus.map((c) => c.libelle).sort(), ['Abobo', 'Cocody', 'Yamoussoukro']);
  for (const c of campus) assert.match(c.id, /^[0-9a-f-]{36}$/);
  const [annee] = await tout('/annees-academiques');
  assert.equal(annee.code, '2026-2027');
  assert.equal(annee.etats_par_campus.length, 3);
  assert.equal(annee.etats_par_campus[0].etat, 'en_cours');
  const semestres = await tout('/semestres');
  assert.deepEqual(semestres.map((s) => s.code_semestre).sort(), ['S1', 'S2']);
});

test('niveaux : code normalisé (Q-09)', async () => {
  const niveaux = await tout('/niveaux');
  assert.deepEqual(niveaux.map((n) => n.code_niveau).sort(), ['L1', 'L2_PRO']);
  assert.equal(codeNiveau('LICENCE 3 PRO'), 'L3_PRO');
  assert.equal(codeNiveau('MASTER 1'), 'M1');
  assert.equal(codeNiveau('BTS 2'), 'BTS2');
  assert.equal(codeNiveau('Prépa'), null);
});

test('filière : univers et type de formation lus dans le type de filière', async () => {
  const [filiere] = await tout('/filieres');
  assert.equal(filiere.code, 'SIC');
  assert.equal(filiere.univers, 'grande_ecole');
  assert.equal(filiere.type_formation, 'initiale');
});

test('étudiants : minimisation, matricule IIPEA obligatoire, statut d’inscription', async () => {
  const etudiants = await tout('/etudiants');
  assert.equal(etudiants.length, 5); // l'étudiant sans matricule IIPEA n'est pas exposé
  for (const e of etudiants) {
    assert.deepEqual(Object.keys(e).sort(),
      ['actif', 'id', 'matricule_iipea', 'modifie_le', 'nom', 'prenoms', 'statut_inscription']);
  }
  const statuts = Object.fromEntries(etudiants.map((e) => [e.matricule_iipea, e.statut_inscription]));
  assert.equal(statuts['DEMO-2026-0001'], 'inscrit');
  assert.equal(statuts['DEMO-2026-0004'], 'en_attente');
});

test('filtre groupe_id sur les étudiants : membres actuels', async () => {
  const groupes = await tout('/groupes');
  const l1a = groupes.find((g) => g.libelle === 'SIC L1-A');
  const membres = await tout(`/etudiants?groupe_id=${l1a.id}`);
  assert.deepEqual(membres.map((e) => e.matricule_iipea).sort(), ['DEMO-2026-0001', 'DEMO-2026-0002']);
  const effectif = await appeler(`/groupes/${l1a.id}/effectif`);
  assert.equal(effectif.corps.effectif, 2);
  assert.equal((await appeler('/groupes/00000000-0000-0000-0000-000000000000/effectif')).statut, 404);
});

test('maquette : versions, UE, modules, jamais de taux horaire (Q-07)', async () => {
  const [maquette] = await tout('/maquettes');
  assert.equal(maquette.ues.length, 1);
  assert.equal(maquette.ues[0].semestre, 'S1');
  assert.equal(maquette.ues[0].modules.length, 2);
  // Aucun champ de taux horaire, et les montants fictifs de la base n'apparaissent nulle part.
  for (const module of maquette.ues[0].modules) {
    assert.ok(Object.keys(module).every((cle) => !cle.includes('taux')), Object.keys(module).join());
  }
  assert.ok(!JSON.stringify(maquette).includes('9999') && !JSON.stringify(maquette).includes('8888'));
  const version = maquette.version;
  await pool.query("UPDATE matiere SET volume_horaire_cm = 24 WHERE code_ecue = 'ECUE-SIC-1011'");
  const [apres] = await tout('/maquettes');
  assert.equal(apres.version, version + 1);
  assert.equal(apres.ues[0].modules.find((m) => m.code === 'ECUE-SIC-1011').volume_cm_heures, 24);
});

test('pagination par curseur : toutes les lignes, sans doublon', async () => {
  const pageUne = await appeler('/campus?limite=2');
  assert.equal(pageUne.corps.elements.length, 2);
  assert.ok(pageUne.corps.curseur_suivant);
  const pageDeux = await appeler(`/campus?limite=2&curseur=${pageUne.corps.curseur_suivant}`);
  assert.equal(pageDeux.corps.elements.length, 1);
  assert.equal(pageDeux.corps.curseur_suivant, null);
  const ids = [...pageUne.corps.elements, ...pageDeux.corps.elements].map((c) => c.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal((await appeler('/campus?curseur=nimportequoi')).statut, 400);
});

test('modifie_depuis : seules les lignes modifiées depuis la date', async () => {
  // Date de référence prise à l'horloge de la base, juste avant la modification.
  const { rows: [{ maintenant }] } = await pool.query('SELECT now() AS maintenant');
  const avant = new Date(maintenant).toISOString();
  await pool.query("UPDATE site SET adresse = 'Abidjan Nord' WHERE nom = 'Abobo'");
  const modifies = await tout(`/campus?modifie_depuis=${encodeURIComponent(avant)}`);
  assert.deepEqual(modifies.map((c) => c.libelle), ['Abobo']);
  assert.equal(modifies[0].ville, 'Abidjan Nord');
  assert.equal((await appeler('/campus?modifie_depuis=hier')).statut, 400);
});

test('ETag : 304 quand la page n’a pas changé', async () => {
  const premiere = await appeler('/ecoles');
  const etag = premiere.entetes.get('etag');
  assert.ok(etag);
  const seconde = await appeler('/ecoles', { entetes: { 'If-None-Match': etag } });
  assert.equal(seconde.statut, 304);
});

test('changement de groupe : historique daté, sans écraser l’ancien (R-05)', async () => {
  await pool.query("UPDATE appartenance_groupe SET date_debut = DATE '2026-09-01'");
  await pool.query("UPDATE etudiant SET groupe_id = 2 WHERE matricule_iipea = 'DEMO-2026-0001'");
  const etudiants = await tout('/etudiants');
  const awa = etudiants.find((e) => e.matricule_iipea === 'DEMO-2026-0001');
  const appartenances = (await tout(`/appartenances?etudiant_id=${awa.id}`))
    .sort((a, b) => a.date_debut.localeCompare(b.date_debut));
  assert.equal(appartenances.length, 2);
  assert.ok(appartenances[0].date_fin);
  assert.equal(appartenances[1].date_fin, null);
  assert.notEqual(appartenances[0].groupe_id, appartenances[1].groupe_id);
});

test('suppression : journalisée et exposée par /suppressions', async () => {
  const groupes = await tout('/groupes');
  const vide = groupes.find((g) => g.libelle === 'SIC L2 PRO-A');
  await pool.query("UPDATE etudiant SET groupe_id = NULL WHERE groupe_id = 3");
  await pool.query('DELETE FROM appartenance_groupe WHERE groupe_id = 3');
  await pool.query('DELETE FROM groupe WHERE id = 3');
  const suppressions = await tout('/suppressions?ressource=groupe');
  assert.ok(suppressions.some((s) => s.id === vide.id && s.supprime_le));
});

// --- Réception des événements -------------------------------------------------------------

const EDT = { type: 'edt_publie', reference: 'edt-demo', version: 1, donnees: { seances: [] } };

test('événement sans clé d’idempotence ou de mauvais type : 400', async () => {
  const sansCle = await appeler('/evenements/edt-publie', { methode: 'POST', corps: EDT });
  assert.equal(sansCle.corps.code, 'CLE_IDEMPOTENCE_ABSENTE');
  const mauvaisType = await appeler('/evenements/edt-publie', {
    methode: 'POST', corps: { ...EDT, type: 'notes_validees' }, entetes: { 'Idempotency-Key': 'cle-type-0001' },
  });
  assert.equal(mauvaisType.statut, 400);
  assert.equal(mauvaisType.corps.code, 'TYPE_INVALIDE');
});

test('événement reçu (202), rejoué sans effet, clé réutilisée autrement (409)', async () => {
  const cle = `cle-${crypto.randomUUID()}`;
  const premier = await appeler('/evenements/edt-publie', { methode: 'POST', corps: EDT, entetes: { 'Idempotency-Key': cle } });
  assert.equal(premier.statut, 202);
  assert.equal(premier.corps.statut, 'recu');
  const rejeu = await appeler('/evenements/edt-publie', { methode: 'POST', corps: EDT, entetes: { 'Idempotency-Key': cle } });
  assert.equal(rejeu.corps.id_reception, premier.corps.id_reception);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM integration_b_evenement WHERE cle_idempotence = $1', [cle]);
  assert.equal(rows[0].n, 1);
  const conflit = await appeler('/evenements/edt-publie', {
    methode: 'POST', corps: { ...EDT, version: 2 }, entetes: { 'Idempotency-Key': cle },
  });
  assert.equal(conflit.statut, 409);
  const accuse = await appeler(`/evenements/${premier.corps.id_reception}`);
  assert.equal(accuse.corps.cle_idempotence, cle);
});

test('événement : scope d’écriture exigé', async () => {
  const r = await appeler('/evenements/supports-publies', {
    methode: 'POST', corps: { type: 'support_publie' }, entetes: { 'Idempotency-Key': 'cle-scope-0001' },
  });
  assert.equal(r.statut, 403);
});
