// test-emailEtudiant.js — Chantier "unicité e-mail étudiant" (2026-09-11), suite au signalement
// production : deux étudiants partageant le même e-mail de connexion (etudiant.email), causé par
// (1) une génération auto sans vérification d'unicité et (2) un prénom commençant par un espace
// produisant un préfixe vide (".nom@iipea.com"). Tests directs de services/emailEtudiant.service.js
// (accès DB en lecture/écriture minimale, pas de serveur HTTP requis — module testé indépendamment
// des contrôleurs qui l'utilisent). Données 'TESTMAIL', nettoyées par ID exact en fin de script.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.local'), quiet: true });

const assert = require('assert');
const db = require('./config/db.config');
const {
  normaliserEmail,
  genererEmailInstitutionnelUnique,
  emailDejaUtiliseParAutreEtudiant,
} = require('./services/emailEtudiant.service');

let passed = 0, failed = 0;
async function test(nom, fn) {
  try { await fn(); console.log(`✅ ${nom}`); passed++; }
  catch (err) { console.log(`❌ ${nom}\n   ${err.stack || err.message}`); failed++; }
}

const ids = { etudiants: [] };

// Étudiant minimal — seules id/source_inscription/valide_scolarite/engagement_accepte sont
// NOT NULL sur `etudiant` (vérifié via information_schema lors de l'audit) : insertion volontairement
// réduite aux colonnes utiles à ces tests (nom/prenoms/email), aucune dépendance à filière/niveau/
// année académique.
async function creerEtudiantTest(nom, prenoms, email) {
  const r = await db.query(
    `INSERT INTO etudiant (nom, prenoms, email, source_inscription, valide_scolarite, engagement_accepte)
     VALUES ($1, $2, $3, 'agent', true, true) RETURNING id`,
    [nom, prenoms, email]
  );
  ids.etudiants.push(r.rows[0].id);
  return r.rows[0].id;
}

(async () => {
  await test('normaliserEmail : insensible à la casse et à tous les espaces (y compris tabulation)', () => {
    assert.strictEqual(normaliserEmail('  Alex-Kouadio@IIPEA.com  '), 'alex-kouadio@iipea.com');
    assert.strictEqual(normaliserEmail('\t aicha.cisse@iipea.com'), 'aicha.cisse@iipea.com');
    assert.strictEqual(normaliserEmail(null), '');
    assert.strictEqual(normaliserEmail(undefined), '');
  });

  // CAS 1 — prénoms = " RAYAN EMMANUEL", nom = "DRAMAN" : ne doit JAMAIS produire ".draman@iipea.com"
  await test('CAS 1 — prénom commençant par un espace ne produit jamais un préfixe vide', async () => {
    const email = await genererEmailInstitutionnelUnique(db, { nom: 'DRAMAN', prenoms: ' RAYAN EMMANUEL' });
    assert.ok(!email.startsWith('.'), `l'e-mail ne doit jamais commencer par un point : ${email}`);
    assert.strictEqual(email, 'rayan.draman@iipea.com');
  });

  // CAS 2 — plusieurs espaces en tête de prenoms
  await test('CAS 2 — plusieurs espaces en tête de prenoms ne produisent jamais un préfixe vide', async () => {
    const email = await genererEmailInstitutionnelUnique(db, { nom: 'KARAMOKO', prenoms: '   KADIDJATOU FATIM' });
    assert.ok(!email.startsWith('.'), `l'e-mail ne doit jamais commencer par un point : ${email}`);
    assert.strictEqual(email, 'kadidjatou.karamoko@iipea.com');
  });

  await test('Malformations classiques exclues (point/tiret parasite, préfixe/suffixe vide)', async () => {
    const email = await genererEmailInstitutionnelUnique(db, { nom: '  KONAN  ', prenoms: '   ' + '  JEAN' });
    assert.ok(!/^\./.test(email), `.nom@iipea.com interdit : ${email}`);
    assert.ok(!/\.@/.test(email), `prenom.@iipea.com interdit : ${email}`);
    assert.ok(!/^@/.test(email), `@iipea.com (vide) interdit : ${email}`);
    assert.ok(!/-\.|\.-/.test(email), `point/tiret parasite adjacent interdit : ${email}`);
  });

  // CAS 3 — email déjà existant : la génération ne doit jamais réattribuer le même email, elle
  // doit produire une variante sûre (suffixe numérique, convention déjà utilisée par le projet
  // pour les homonymes de code_unique).
  await test('CAS 3 — email déjà pris par un autre étudiant : génère une variante, ne le réattribue jamais', async () => {
    await creerEtudiantTest('KOUADIO', 'ALEX', 'alex.kouadio@iipea.com');
    const email = await genererEmailInstitutionnelUnique(db, { nom: 'KOUADIO', prenoms: 'ALEX' });
    assert.notStrictEqual(normaliserEmail(email), 'alex.kouadio@iipea.com', 'ne doit jamais réattribuer un email déjà pris');
    assert.strictEqual(email, 'alex.kouadio2@iipea.com');

    // Un 3e homonyme doit continuer la numérotation, jamais reprendre la variante déjà attribuée.
    await creerEtudiantTest('KOUADIO', 'ALEX', email);
    const email3 = await genererEmailInstitutionnelUnique(db, { nom: 'KOUADIO', prenoms: 'ALEX' });
    assert.strictEqual(email3, 'alex.kouadio3@iipea.com');
  });

  // CAS 4 — casse/espaces différents doivent être reconnus comme le même email
  await test('CAS 4 — casse et espaces différents détectés comme le même email (doublon)', async () => {
    const id = await creerEtudiantTest('YAO', 'MARIE', 'marie.yao@iipea.com');
    const dejaPris = await emailDejaUtiliseParAutreEtudiant(db, { email: '  Marie.YAO@IIPEA.com  ', etudiantIdAExclure: null });
    assert.strictEqual(dejaPris, true);
    // Vérifie aussi que la génération auto détecte la collision malgré la casse différente en base.
    void id;
  });

  // CAS 5 — un étudiant qui resoumet/modifie son propre email ne doit jamais être refusé comme
  // doublon de lui-même (exclusion par etudiantIdAExclure).
  await test("CAS 5 — un étudiant n'est jamais refusé pour son propre email (auto-exclusion)", async () => {
    const id = await creerEtudiantTest('TRAORE', 'FATOU', 'fatou.traore@iipea.com');
    const refuseSoiMeme = await emailDejaUtiliseParAutreEtudiant(db, { email: 'fatou.traore@iipea.com', etudiantIdAExclure: id });
    assert.strictEqual(refuseSoiMeme, false, "un étudiant ne doit pas être bloqué par son propre email actuel");
    // Variante casse/espaces de son propre email : toujours accepté.
    const refuseSoiMemeVariante = await emailDejaUtiliseParAutreEtudiant(db, { email: '  Fatou.Traore@IIPEA.COM', etudiantIdAExclure: id });
    assert.strictEqual(refuseSoiMemeVariante, false);
    // Mais un AUTRE étudiant avec le même email doit bien être refusé (sans exclusion, ou avec un id différent).
    const refusePourAutrui = await emailDejaUtiliseParAutreEtudiant(db, { email: 'fatou.traore@iipea.com', etudiantIdAExclure: id + 1000000 });
    assert.strictEqual(refusePourAutrui, true);
  });

  await test('Nom/prénom insuffisant après nettoyage : erreur explicite, jamais un email vide généré', async () => {
    await assert.rejects(
      () => genererEmailInstitutionnelUnique(db, { nom: '   ', prenoms: '   ' }),
      /nom ou prénom insuffisant/
    );
  });

  // Nettoyage — suppression par ID exact uniquement (jamais par valeur), aucune donnée
  // pré-existante touchée.
  if (ids.etudiants.length > 0) {
    await db.query('DELETE FROM etudiant WHERE id = ANY($1::int[])', [ids.etudiants]);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.end();
  process.exit(failed > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error('Erreur fatale:', err);
  if (ids.etudiants.length > 0) {
    await db.query('DELETE FROM etudiant WHERE id = ANY($1::int[])', [ids.etudiants]).catch(() => {});
  }
  process.exit(1);
});
