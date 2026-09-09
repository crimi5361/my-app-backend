// test-reinscriptionRedoublementAnneeCible.js — Correctif "Redoublement sur l'année cible"
// (2026-09-09), suite de l'audit lecture seule validé le même jour sur l'étudiant 971 (KOUAME,
// matricule 26FCGETY790022, AJOURNÉ, FCGE, BTS 2, scolarité soldée).
//
// Bug 1 corrigé : le niveau proposé/soumis en mode redoublement était l'id BRUT
// etudiant.niveau_id (année SOURCE, ex. BTS 2 / FCGE / 2025-2026 = id 4), jamais résolu pour
// l'année CIBLE (BTS 2 / FCGE / 2026-2027 = id 171) — le garde-fou NIVEAU_ANNEE_INCORRECTE
// (légitime, non modifié) rejetait donc systématiquement toute soumission en redoublement.
//
// Bug 2 corrigé (suite, même jour) : une fois le niveau correctement résolu (171 ≠ 4), la
// comparaison `estRedoublement` (basée sur l'id BRUT etudiant.niveau_id) ne matchait plus jamais
// — un redoublement réel se retrouvait donc rejeté avec "Année académique non validée (décision :
// AJOURNÉ)" alors que le redoublement n'exige JAMAIS de validation académique. Comparaison
// remplacée par le LIBELLÉ (niveauRetenuLibelle === niveauActuelLibelle), qui reste valide
// quelle que soit l'année. La pièce ATTESTATION_ADMISSION_L3PRO (obligatoire uniquement pour un
// BTS 2 ADMIS/DÉROGÉ, jamais pour un BTS 2 AJOURNÉ qui ne peut que redoubler) a été corrigée en
// même temps (estBts2VersL3Pro = estBts2Actuel && academiqueValide, au lieu de estBts2Actuel seul).
//
// LECTURE SEULE STRICTE pour les cas basés sur des étudiants réels (971, 769, 209, 1028) — aucune
// écriture. Les cas de soumission réussie utilisent un étudiant TEMPORAIRE dédié, cloné de la
// situation réelle de 971 — JAMAIS 971 lui-même. Nettoyage strict par id exact (jamais une
// suppression par valeur).

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });

const assert = require('assert');
const fs = require('fs');
const db = require('./config/db.config');
const reinscriptionController = require('./controllers/reinscription.controller');

let passed = 0, failed = 0;
async function test(nom, fn) {
  try { await fn(); console.log(`✅ ${nom}`); passed++; }
  catch (err) { console.log(`❌ ${nom}\n   ${err.stack || err.message}`); failed++; }
}

const SITE_ID = 1;
const ANNEE_SOURCE = 1; // 2025-2026
const ANNEE_CIBLE = 3;  // 2026-2027, "en cour" pour le site 1

function mockRes() {
  let body, code;
  return {
    status(c) { code = c; return this; },
    json(b) { body = b; return this; },
    get: () => ({ code, body }),
  };
}

// Sujets réels déjà présents en base (jamais créés par ce fichier), vérifiés avant écriture
// (2026-09-09) :
//  - 971 (KOUAME NASSE LOIC EMMANUEL) : FCGE, BTS 2 (niveau_id=4, 2025-2026), AJOURNÉ, scolarité
//    SOLDE. Niveau cible réel pour 2026-2027 : BTS 2 / FCGE = id 171.
//  - 769 (OUEDRAOGO MARIAM) : GENIE CIVIL OPTION BATIMENT (filiere 12), BTS 1, ADMIS, progression
//    réelle configurée vers BTS 2 / 2026-2027 = id 267 — sert de témoin "progression inchangée".
//  - 209 (KEITA) : GENIE CIVIL OPTION BATIMENT (filiere 3), BTS 1, AJOURNÉ — sert de témoin
//    "généricité" (autre filière/niveau que 971), niveau cible réel BTS 1/2026-2027 = id 177.

const idsANettoyer = { etudiants: [], scolarites: [], reinscriptions: [] };

// Étudiant temporaire pour le CAS 2 uniquement — clone minimal de la situation de 971 (même
// filière FCGE, même niveau source BTS 2/2025-2026, scolarité soldée) mais jamais 971 lui-même.
async function creerEtudiantRedoublementTest() {
  const s = await db.query(
    `INSERT INTO scolarite (montant_scolarite, scolarite_verse, scolarite_restante, statut_etudiant)
     VALUES (150000, 150000, 0, 'SOLDE') RETURNING id`
  );
  idsANettoyer.scolarites.push(s.rows[0].id);
  const codePaiement = `TREDBL-${Date.now()}`;
  const e = await db.query(
    `INSERT INTO etudiant (nom, prenoms, site_id, id_filiere, niveau_id, curcus_id, annee_academique_id, standing, departement_id, code_paiement, scolarite_id, statut_scolaire)
     VALUES ('TEST_REDOUBLEMENT', 'CAS2', $1, 2, 4, 2, $2, 'Inscrit', $1, $3, $4, 'Affecté') RETURNING id`,
    [SITE_ID, ANNEE_SOURCE, codePaiement, s.rows[0].id]
  );
  idsANettoyer.etudiants.push(e.rows[0].id);
  return e.rows[0].id;
}

async function main() {
  await test('CAS 1. AJOURNÉ + REDOUBLEMENT (971, réel) — niveau proposé = BTS 2 / FCGE / 2026-2027 (id 171), jamais 2025-2026 (id 4)', async () => {
    const res = mockRes();
    await reinscriptionController.getDossierReinscription({ params: { id: '971' } }, res);
    const d = res.get().body.data;
    assert.strictEqual(d.situation_academique.decision, 'AJOURNÉ');
    assert.strictEqual(d.niveau_propose, null, 'aucune progression automatique pour un ajourné');
    assert.strictEqual(d.niveau_retenu_propose, 171);
    assert.notStrictEqual(d.niveau_retenu_propose, 4, 'ne doit plus jamais renvoyer l\'id de l\'ancienne année');
    assert.strictEqual(d.redoublement_bloque_message, null);
    const niveauVerif = await db.query('SELECT libelle, filiere_id, anneeacademique_id FROM niveau WHERE id=$1', [d.niveau_retenu_propose]);
    assert.strictEqual(niveauVerif.rows[0].libelle, 'BTS 2');
    assert.strictEqual(niveauVerif.rows[0].filiere_id, 2);
    assert.strictEqual(niveauVerif.rows[0].anneeacademique_id, ANNEE_CIBLE);
  });

  await test('CAS 2. Soumission réelle avec le niveau cible résolu (171) réussit de bout en bout — INSERT reinscription.niveau_retenu_id=171 (étudiant TEMPORAIRE dédié, jamais 971)', async () => {
    const etudiantId = await creerEtudiantRedoublementTest();
    const client = await db.connect();
    try {
      const result = await reinscriptionController.traiterDemandeReinscription(client, {
        etudiantId, niveauRetenuId: 171, idFiliereChoisie: null, curcusId: null,
        nombreVersementsPrevu: 1, modalitePaiement: '1 versement(s)', identiteFields: {},
        photoUrl: null, traitePar: 13, sourceInscription: 'agent', mode: 'creation',
      });
      assert.strictEqual(result.erreur, null, JSON.stringify(result.erreur));
      assert.strictEqual(result.niveauRetenuId, 171);
      assert.strictEqual(result.anneeAcademiqueId, ANNEE_CIBLE);
      // ✅ Règle métier : AJOURNÉ + même niveau (redoublement) = ÉLIGIBLE, sans validation
      // académique (financierConforme && estRedoublement suffit).
      assert.strictEqual(result.eligible, true, 'AJOURNÉ + redoublement doit être éligible');
      assert.strictEqual(result.statutDossier, 'en_attente_paiement');
      assert.strictEqual(result.motifNonEligibilite, null);
      assert.ok(result.codePaiement, 'un code de paiement doit être généré pour un dossier éligible');
      idsANettoyer.reinscriptions.push(result.reinscriptionId);
      const reel = await db.query('SELECT niveau_retenu_id, statut FROM reinscription WHERE id=$1', [result.reinscriptionId]);
      assert.strictEqual(reel.rows[0].niveau_retenu_id, 171);
      assert.strictEqual(reel.rows[0].statut, 'en_attente_paiement');
    } finally {
      client.release();
    }
  });

  await test("CAS 3. Protection intacte — forcer niveau_retenu_id=4 (ancienne année) pour 971 reste TOUJOURS refusé (NIVEAU_ANNEE_INCORRECTE), aucune écriture", async () => {
    const avant = await db.query('SELECT COUNT(*) AS n FROM reinscription WHERE etudiant_id=971');
    const client = await db.connect();
    let result;
    try {
      result = await reinscriptionController.traiterDemandeReinscription(client, {
        etudiantId: 971, niveauRetenuId: 4, idFiliereChoisie: null, curcusId: null,
        nombreVersementsPrevu: null, modalitePaiement: null, identiteFields: {},
        photoUrl: null, traitePar: 13, sourceInscription: 'agent', mode: 'creation',
      });
    } finally {
      client.release();
    }
    assert.ok(result.erreur);
    assert.strictEqual(result.erreur.code, 'NIVEAU_ANNEE_INCORRECTE');
    assert.strictEqual(result.erreur.status, 409);
    const apres = await db.query('SELECT COUNT(*) AS n FROM reinscription WHERE etudiant_id=971');
    assert.strictEqual(apres.rows[0].n, avant.rows[0].n, 'le garde-fou agit avant toute écriture (avant BEGIN) : aucune ligne créée pour 971');
  });

  await test('CAS 4. Progression (ADMIS) inchangée — étudiant réel 769 (OUEDRAOGO), BTS1→BTS2 2026-2027 via niveau_suivant_id/niveau_propose, jamais le chemin redoublement', async () => {
    const res = mockRes();
    await reinscriptionController.getDossierReinscription({ params: { id: '769' } }, res);
    const d = res.get().body.data;
    assert.strictEqual(d.situation_academique.decision, 'ADMIS');
    assert.ok(d.niveau_propose && d.niveau_propose.id, 'une progression doit être proposée');
    assert.strictEqual(d.niveau_propose.libelle, 'BTS 2');
    assert.strictEqual(d.niveau_retenu_propose, d.niveau_propose.id, 'le niveau retenu suggéré doit être EXACTEMENT niveau_propose.id (chemin progression, pas le nouveau calcul redoublement)');
  });

  await test('CAS 5. Généricité — autre étudiant AJOURNÉ réel, autre filière/niveau (209 KEITA, GENIE CIVIL OPTION BATIMENT, BTS 1) résolu correctement, sans aucune référence à 971', async () => {
    const res = mockRes();
    await reinscriptionController.getDossierReinscription({ params: { id: '209' } }, res);
    const d = res.get().body.data;
    assert.strictEqual(d.situation_academique.decision, 'AJOURNÉ');
    assert.strictEqual(d.niveau_retenu_propose, 177);
    const niveauVerif = await db.query('SELECT libelle, filiere_id, anneeacademique_id FROM niveau WHERE id=$1', [d.niveau_retenu_propose]);
    assert.strictEqual(niveauVerif.rows[0].libelle, 'BTS 1');
    assert.strictEqual(niveauVerif.rows[0].anneeacademique_id, ANNEE_CIBLE);
  });

  await test("CAS A/E. AJOURNÉ + REDOUBLEMENT + scolarité soldée = ÉLIGIBLE (règle métier explicite, déjà prouvée par CAS 2 ci-dessus) — vérifie ici l'absence de tout motif d'inéligibilité", async () => {
    const etudiantId = await creerEtudiantRedoublementTest();
    const client = await db.connect();
    try {
      const result = await reinscriptionController.traiterDemandeReinscription(client, {
        etudiantId, niveauRetenuId: 171, idFiliereChoisie: null, curcusId: null,
        nombreVersementsPrevu: 1, modalitePaiement: '1 versement(s)', identiteFields: {},
        photoUrl: null, traitePar: 13, sourceInscription: 'agent', mode: 'creation',
      });
      assert.strictEqual(result.eligible, true);
      assert.strictEqual(result.motifNonEligibilite, null, "aucun motif — ni financier (soldé) ni académique (redoublement dispensé) ne doit bloquer");
      idsANettoyer.reinscriptions.push(result.reinscriptionId);
    } finally {
      client.release();
    }
  });

  await test('CAS B. Décision non validée + niveau DIFFÉRENT du niveau actuel (tentative de progression, pas un redoublement) → reste refusé, motif académique explicite', async () => {
    const etudiantId = await creerEtudiantRedoublementTest();
    // Niveau réel différent (LICENCE 1 PRO / FCGE / 2026-2027, id 172) — autre libellé que BTS 2 :
    // ne peut structurellement pas être détecté comme un redoublement (niveauRetenuLibelle !==
    // niveauActuelLibelle), donc doit rester soumis à la validation académique normale.
    const client = await db.connect();
    try {
      const result = await reinscriptionController.traiterDemandeReinscription(client, {
        etudiantId, niveauRetenuId: 172, idFiliereChoisie: null, curcusId: null,
        nombreVersementsPrevu: 1, modalitePaiement: '1 versement(s)', identiteFields: {},
        photoUrl: null, traitePar: 13, sourceInscription: 'agent', mode: 'creation',
      });
      assert.strictEqual(result.erreur, null, 'le niveau appartient bien à l\'année cible : aucun NIVEAU_ANNEE_INCORRECTE');
      assert.strictEqual(result.eligible, false, 'une tentative de progression sans décision académique validée doit rester refusée');
      assert.ok(/non validée/i.test(result.motifNonEligibilite || ''), `motif attendu explicite, obtenu : ${result.motifNonEligibilite}`);
      idsANettoyer.reinscriptions.push(result.reinscriptionId);
    } finally {
      client.release();
    }
  });

  await test('CAS D (raisonnement structurel). ADMIS + redoublement volontaire reste éligible : eligible = financierConforme && (academiqueValide || estRedoublement) — quand academiqueValide=true, la valeur d\'estRedoublement ne change jamais le résultat (logique OR inchangée par ce correctif)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'controllers/reinscription.controller.js'), 'utf8');
    assert.ok(/const eligible = financierConforme && \(academiqueValide \|\| estRedoublement\) && montantAnnuel !== null;/.test(source), 'la formule OR doit rester exactement celle déjà validée avant ce correctif — seule la définition d\'estRedoublement a changé, jamais cette logique');
  });

  await test("Pièce ATTESTATION_ADMISSION_L3PRO — exclue pour un AJOURNÉ en BTS 2 (971, réel) qui ne peut que redoubler", async () => {
    const res = mockRes();
    await reinscriptionController.getDossierReinscription({ params: { id: '971' } }, res);
    const d = res.get().body.data;
    assert.ok(!d.documents.some((doc) => doc.code === 'ATTESTATION_ADMISSION_L3PRO'), 'ne doit plus apparaître dans la liste pour un AJOURNÉ');
  });

  await test("Pièce ATTESTATION_ADMISSION_L3PRO — TOUJOURS obligatoire pour un ADMIS en BTS 2 réel (1028) : la correction est conditionnelle, jamais une suppression globale", async () => {
    const res = mockRes();
    await reinscriptionController.getDossierReinscription({ params: { id: '1028' } }, res);
    const d = res.get().body.data;
    assert.strictEqual(d.situation_academique.decision, 'ADMIS', 'précondition : ce témoin doit rester ADMIS');
    const doc = d.documents.find((x) => x.code === 'ATTESTATION_ADMISSION_L3PRO');
    assert.ok(doc, 'doit apparaître dans la liste pour un ADMIS en BTS 2 (changement de cycle vers Licence 3 Pro toujours possible)');
    assert.strictEqual(doc.obligatoire, true);
  });

  await test("Non-régression. La résolution du niveau de redoublement ne code en dur aucun id/matricule d'étudiant précis (généricité garantie structurellement)", () => {
    const source = fs.readFileSync(path.join(__dirname, 'controllers/reinscription.controller.js'), 'utf8');
    assert.ok(!/\b971\b/.test(source), "aucune référence à l'id 971 codée en dur");
    assert.ok(!/26FCGETY790022/.test(source), 'aucune référence au matricule codée en dur');
  });

  console.log('\n=== Nettoyage (uniquement les données créées par ce fichier, par id exact) ===');
  for (const id of idsANettoyer.reinscriptions) {
    await db.query('DELETE FROM reinscription WHERE id=$1', [id]);
    console.log('🧹 reinscription supprimée :', id);
  }
  for (const id of idsANettoyer.etudiants) {
    await db.query('DELETE FROM etudiant WHERE id=$1', [id]);
    console.log('🧹 etudiant (test) supprimé :', id);
  }
  for (const id of idsANettoyer.scolarites) {
    await db.query('DELETE FROM scolarite WHERE id=$1', [id]);
    console.log('🧹 scolarite (test) supprimée :', id);
  }

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed > 0) process.exitCode = 1;
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  for (const id of idsANettoyer.reinscriptions) { await db.query('DELETE FROM reinscription WHERE id=$1', [id]).catch(() => {}); }
  for (const id of idsANettoyer.etudiants) { await db.query('DELETE FROM etudiant WHERE id=$1', [id]).catch(() => {}); }
  for (const id of idsANettoyer.scolarites) { await db.query('DELETE FROM scolarite WHERE id=$1', [id]).catch(() => {}); }
  process.exit(1);
});
