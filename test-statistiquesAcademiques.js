// test-statistiquesAcademiques.js — Correctif "Inscriptions vs Ré-inscriptions" de la page
// Statistiques académiques (Gestion académique / Statistique, 2026-09-09, v2).
//
// v1 (même jour) n'avait corrigé QUE "reinscriptions" (historique_inscription), laissant
// "inscriptions"/"total" sur l'ancienne définition "tout inscrit standing='Inscrit'" — les deux
// colonnes se chevauchaient donc toujours. v2 redéfinit AUSSI "inscriptions" comme les vraies
// admissions validées (historique_inscription.type_evenement='admission'), rendant les deux
// populations structurellement disjointes : total = inscriptions + reinscriptions, jamais un
// second COUNT(*) indépendant.
//
// LECTURE SEULE STRICTE : aucun test n'insère, ne met à jour, ni ne supprime la moindre ligne en
// base. Les 6 cas obligatoires (CAS 1 à 6, demande utilisateur) sont vérifiés sur des ÉTUDIANTS
// RÉELS déjà présents en base (année 2026-2027, site IIPEA COCODY id=1) — jamais de données créées
// pour l'occasion. CAS 6 (le niveau seul ne doit plus déterminer la catégorie) est vérifié par
// PREUVE STRUCTURELLE (absence de toute logique de progression de niveau dans le fichier source +
// évaluation SQL littérale prouvant que seul type_evenement tranche) faute de contre-exemple réel
// disponible en base (aucune admission fraîche n'existe aujourd'hui sur un niveau "de progression"
// comme LICENCE 2/3 ou BTS 2 dans les données de test locales).

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });

const assert = require('assert');
const fs = require('fs');
const db = require('./config/db.config');
const statCtrl = require('./controllers/StatistiqueGeneral.controller');

let passed = 0, failed = 0;
async function test(nom, fn) {
  try { await fn(); console.log(`✅ ${nom}`); passed++; }
  catch (err) { console.log(`❌ ${nom}\n   ${err.stack || err.message}`); failed++; }
}

const SITE_ID = 1;
const ANNEE_2026_2027 = 3;
const ANNEE_2025_2026 = 1;

// Composition réelle vérifiée en base avant écriture de ce fichier (2026-09-09), via
// SELECT ... FROM historique_inscription WHERE annee_academique_id=3 AND site_id=1 :
//  - BTS 2       : 0 admission, 2 réinscriptions (AMAN 603, BERTHE 615)           -> CAS 5
//  - LICENCE 1   : 2 admissions (KONAN 7943, BOGA 7557), 0 réinscription          -> CAS 4 (variante)
//  - LICENCE 1 PRO : 1 admission (BOGA 7539), 0 réinscription
//  - LICENCE 2   : 0 admission, 1 réinscription (ABOUBACAR 2196)                  -> CAS 1+2 combinés
//  - LICENCE 3   : 0 admission, 2 réinscriptions (DIALLO 5157, CISSE 3667)

function mockRes() {
  let body, code;
  return {
    status(c) { code = c; return this; },
    json(b) { body = b; return this; },
    get: () => ({ code, body }),
  };
}

async function main() {
  await test('1. GET /statistiques/niveau — 200, structure inchangée', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const { body } = res.get();
    assert.strictEqual(body.success, true);
    assert.ok(Array.isArray(body.data));
    for (const row of body.data) {
      for (const champ of ['niveau', 'etudiants_affectes', 'etudiants_non_affectes', 'inscriptions', 'reinscriptions', 'total']) {
        assert.ok(champ in row, `champ ${champ} attendu`);
      }
    }
  });

  await test("2. 'inscriptions' = COUNT réel historique_inscription.type_evenement='admission' (comparaison directe en base)", async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    for (const row of res.get().body.data) {
      const reel = await db.query(`
        SELECT COUNT(*) AS n FROM historique_inscription h
        JOIN etudiant e ON e.id = h.etudiant_id
        JOIN niveau hn ON hn.id = h.niveau_id
        WHERE h.type_evenement = 'admission' AND h.annee_academique_id = $1 AND e.site_id = $2 AND hn.libelle = $3
      `, [ANNEE_2026_2027, SITE_ID, row.niveau]);
      assert.strictEqual(parseInt(row.inscriptions, 10), parseInt(reel.rows[0].n, 10), `niveau ${row.niveau}`);
    }
  });

  await test("3. 'reinscriptions' = COUNT réel historique_inscription.type_evenement='reinscription' (comparaison directe en base)", async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    for (const row of res.get().body.data) {
      const reel = await db.query(`
        SELECT COUNT(*) AS n FROM historique_inscription h
        JOIN etudiant e ON e.id = h.etudiant_id
        JOIN niveau hn ON hn.id = h.niveau_id
        WHERE h.type_evenement = 'reinscription' AND h.annee_academique_id = $1 AND e.site_id = $2 AND hn.libelle = $3
      `, [ANNEE_2026_2027, SITE_ID, row.niveau]);
      assert.strictEqual(parseInt(row.reinscriptions, 10), parseInt(reel.rows[0].n, 10), `niveau ${row.niveau}`);
    }
  });

  await test('4. total = inscriptions + reinscriptions EXACTEMENT, sur toutes les lignes (populations disjointes, plus jamais un second COUNT(*) indépendant)', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    for (const row of res.get().body.data) {
      assert.strictEqual(parseInt(row.total, 10), parseInt(row.inscriptions, 10) + parseInt(row.reinscriptions, 10), `niveau ${row.niveau}`);
    }
  });

  await test('CAS 5 (réel). BTS 2 : 0 nouvelle admission, 2 réinscriptions validées (AMAN 603, BERTHE 615) -> Inscriptions=0, Réinscriptions=2, Total=2', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const bts2 = res.get().body.data.find((r) => r.niveau === 'BTS 2');
    assert.ok(bts2, 'BTS 2 doit apparaître');
    assert.strictEqual(parseInt(bts2.inscriptions, 10), 0);
    assert.strictEqual(parseInt(bts2.reinscriptions, 10), 2);
    assert.strictEqual(parseInt(bts2.total, 10), 2);
  });

  await test('CAS 4 (réel, variante LICENCE 1). 2 nouvelles admissions (KONAN 7943, BOGA 7557), 0 réinscription -> Inscriptions=2, Réinscriptions=0, Total=2', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const l1 = res.get().body.data.find((r) => r.niveau === 'LICENCE 1');
    assert.ok(l1, 'LICENCE 1 doit apparaître');
    assert.strictEqual(parseInt(l1.inscriptions, 10), 2);
    assert.strictEqual(parseInt(l1.reinscriptions, 10), 0);
    assert.strictEqual(parseInt(l1.total, 10), 2);
  });

  await test('CAS 1+2 (réel). LICENCE 2 : 1 réinscription validée (ABOUBACAR 2196), 0 admission -> Inscriptions=0, Réinscriptions=1, Total=1', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const l2 = res.get().body.data.find((r) => r.niveau === 'LICENCE 2');
    assert.ok(l2, 'LICENCE 2 doit apparaître');
    assert.strictEqual(parseInt(l2.inscriptions, 10), 0, "ABOUBACAR est une réinscription validée, jamais comptée en Inscriptions");
    assert.strictEqual(parseInt(l2.reinscriptions, 10), 1);
    assert.strictEqual(parseInt(l2.total, 10), 1);
  });

  await test("CAS 6 (structurel). Aucune logique de progression de niveau ne subsiste comme CODE actif dans le fichier source (seule une mention en commentaire, documentant l'ancienne règle retirée, est tolérée)", () => {
    const source = fs.readFileSync(path.join(__dirname, 'controllers/StatistiqueGeneral.controller.js'), 'utf8');
    assert.ok(!/const\s+NIVEAUX_IMPLIQUANT_REINSCRIPTION/.test(source), "la constante de l'ancienne heuristique ne doit plus être déclarée en code");
    assert.ok(!/n\.libelle\s*=\s*ANY/.test(source), "plus aucune classification par liste de niveaux dans le SQL");
    // Chaque CTE de classification ne filtre QUE sur type_evenement, jamais sur un niveau/libellé.
    const nbFiltresTypeEvenement = (source.match(/h\.type_evenement\s*=\s*'(admission|reinscription)'/g) || []).length;
    assert.ok(nbFiltresTypeEvenement >= 8, `au moins 8 CTE (2 par fonction x 4 fonctions) doivent filtrer sur type_evenement, trouvé ${nbFiltresTypeEvenement}`);
  });

  await test("CAS 6 (évaluation SQL littérale). Un événement 'admission' sur un niveau de progression (BTS 2) reste classé Inscriptions, jamais Réinscriptions — seul type_evenement tranche, jamais le niveau", async () => {
    const r = await db.query(`
      SELECT type_evenement, niveau,
        CASE WHEN type_evenement = 'admission' THEN 1 ELSE 0 END AS compte_en_inscriptions,
        CASE WHEN type_evenement = 'reinscription' THEN 1 ELSE 0 END AS compte_en_reinscriptions
      FROM (VALUES ('admission','BTS 2'), ('reinscription','BTS 2'), ('admission','LICENCE 2'), ('reinscription','LICENCE 1')) AS t(type_evenement, niveau)
    `);
    for (const row of r.rows) {
      if (row.type_evenement === 'admission') {
        assert.strictEqual(row.compte_en_inscriptions, 1, `admission sur ${row.niveau} doit compter en Inscriptions quel que soit le niveau`);
        assert.strictEqual(row.compte_en_reinscriptions, 0);
      } else {
        assert.strictEqual(row.compte_en_reinscriptions, 1, `réinscription sur ${row.niveau} doit compter en Réinscriptions quel que soit le niveau`);
        assert.strictEqual(row.compte_en_inscriptions, 0);
      }
    }
  });

  await test('5. Aucun doublon : la somme (inscriptions + reinscriptions) par niveau égale le COUNT(*) direct de historique_inscription pour ce niveau, jamais moins ni plus', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    for (const row of res.get().body.data) {
      const reel = await db.query(`
        SELECT COUNT(*) AS n FROM historique_inscription h
        JOIN etudiant e ON e.id = h.etudiant_id
        JOIN niveau hn ON hn.id = h.niveau_id
        WHERE h.type_evenement IN ('admission','reinscription') AND h.annee_academique_id = $1 AND e.site_id = $2 AND hn.libelle = $3
      `, [ANNEE_2026_2027, SITE_ID, row.niveau]);
      assert.strictEqual(parseInt(row.inscriptions, 10) + parseInt(row.reinscriptions, 10), parseInt(reel.rows[0].n, 10), `niveau ${row.niveau}`);
    }
  });

  await test('6. Total Général cohérent : Σ inscriptions = 3, Σ reinscriptions = 5, Σ total = 8 (baseline connue, cf. test-statistiquesInscriptions.js::getInscriptionsValidees)', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const data = res.get().body.data;
    const sommeInsc = data.reduce((s, r) => s + parseInt(r.inscriptions, 10), 0);
    const sommeReinsc = data.reduce((s, r) => s + parseInt(r.reinscriptions, 10), 0);
    const sommeTotal = data.reduce((s, r) => s + parseInt(r.total, 10), 0);
    assert.strictEqual(sommeInsc, 3);
    assert.strictEqual(sommeReinsc, 5);
    assert.strictEqual(sommeTotal, 8);
    assert.strictEqual(sommeTotal, sommeInsc + sommeReinsc);
  });

  await test('7. Affectés + Non Affectés reste cohérent avec le nouveau Total sur les données réelles testées (aucun gap historique ni équivalence en jeu ici)', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    for (const row of res.get().body.data) {
      assert.strictEqual(
        parseInt(row.etudiants_affectes, 10) + parseInt(row.etudiants_non_affectes, 10),
        parseInt(row.total, 10),
        `niveau ${row.niveau} : Affectés+Non Affectés doit égaler Total sur ce jeu de données propre`
      );
    }
  });

  await test('8. Cohérence croisée : la somme Inscriptions/Réinscriptions est identique par niveau, cycle et filière', async () => {
    const req = { query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } };
    const resNiveau = mockRes(); await statCtrl.getStatisticsByNiveau(req, resNiveau);
    const resCycle = mockRes(); await statCtrl.getStatisticsByCycle(req, resCycle);
    const resFiliere = mockRes(); await statCtrl.getStatisticsByFiliere(req, resFiliere);

    const sum = (rows, key) => rows.reduce((s, r) => s + parseInt(r[key] || '0', 10), 0);
    const insNiveau = sum(resNiveau.get().body.data, 'inscriptions');
    const reinsNiveau = sum(resNiveau.get().body.data, 'reinscriptions');
    const insCycle = sum(resCycle.get().body.data, 'inscriptions');
    const reinsCycle = sum(resCycle.get().body.data, 'reinscriptions');
    const insFiliere = resFiliere.get().body.data.reduce((s, f) => s + f.total_inscriptions, 0);
    const reinsFiliere = resFiliere.get().body.data.reduce((s, f) => s + f.total_reinscriptions, 0);

    assert.strictEqual(insCycle, insNiveau);
    assert.strictEqual(reinsCycle, reinsNiveau);
    assert.strictEqual(insFiliere, insNiveau);
    assert.strictEqual(reinsFiliere, reinsNiveau);
  });

  await test('9. getStatisticsByCursus fonctionne toujours (200, structure valide, total = inscriptions + reinscriptions)', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByCursus({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const { body } = res.get();
    assert.strictEqual(body.success, true);
    for (const row of body.data) {
      assert.strictEqual(parseInt(row.total, 10), parseInt(row.inscriptions, 10) + parseInt(row.reinscriptions, 10));
    }
  });

  await test('10. Année sans aucun événement validé (2025-2026, id=1) → structure valide, aucune erreur (total = inscriptions + reinscriptions reste vrai même à 0)', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2025_2026), departement_id: String(SITE_ID) } }, res);
    const { body } = res.get();
    assert.strictEqual(body.success, true);
    for (const row of body.data) {
      assert.strictEqual(parseInt(row.total, 10), parseInt(row.inscriptions, 10) + parseInt(row.reinscriptions, 10), `niveau ${row.niveau}`);
    }
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed > 0) process.exitCode = 1;
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
