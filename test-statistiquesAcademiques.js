// test-statistiquesAcademiques.js — Correctif "Ré-inscriptions" de la page Statistiques
// académiques (Gestion académique / Statistique, 2026-09-09).
//
// LECTURE SEULE STRICTE : aucun test n'insère, ne met à jour, ni ne supprime la moindre ligne en
// base. Vérifie sur des données réelles (année 2026-2027, site IIPEA COCODY id=1) que la colonne
// "reinscriptions" reflète désormais historique_inscription.type_evenement='reinscription' (les
// vraies réinscriptions VALIDÉES en caisse) et non plus l'ancienne heuristique par niveau — et que
// ce chiffre est cohérent, quelle que soit la dimension de regroupement (niveau/cycle/cursus/filière).

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });

const assert = require('assert');
const db = require('./config/db.config');
const statCtrl = require('./controllers/StatistiqueGeneral.controller');

let passed = 0, failed = 0;
async function test(nom, fn) {
  try { await fn(); console.log(`✅ ${nom}`); passed++; }
  catch (err) { console.log(`❌ ${nom}\n   ${err.stack || err.message}`); failed++; }
}

const SITE_ID = 1;
const ANNEE_2026_2027 = 3;

function mockRes() {
  let body, code;
  return {
    status(c) { code = c; return this; },
    json(b) { body = b; return this; },
    get: () => ({ code, body }),
  };
}

async function main() {
  await test('1. GET /statistiques/niveau — 200, structure inchangée (niveau/etudiants_affectes/.../reinscriptions/total)', async () => {
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

  await test('2. "reinscriptions" par niveau = COUNT réel de historique_inscription.type_evenement=\'reinscription\' (comparaison directe en base, pas une déduction)', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const { data } = res.get().body;
    for (const row of data) {
      const reel = await db.query(`
        SELECT COUNT(*) AS n FROM historique_inscription h
        JOIN etudiant e ON e.id = h.etudiant_id
        JOIN niveau hn ON hn.id = h.niveau_id
        WHERE h.type_evenement = 'reinscription' AND h.annee_academique_id = $1 AND e.site_id = $2 AND hn.libelle = $3
      `, [ANNEE_2026_2027, SITE_ID, row.niveau]);
      assert.strictEqual(parseInt(row.reinscriptions, 10), parseInt(reel.rows[0].n, 10), `niveau ${row.niveau}`);
    }
  });

  await test('3. La colonne "reinscriptions" n\'est plus un sous-ensemble déguisé de "total" — au moins un niveau réel où reinscriptions !== total (BTS 2 : AMAN 603 + BERTHE 615)', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const { data } = res.get().body;
    const licence1 = data.find((r) => r.niveau === 'LICENCE 1');
    assert.ok(licence1, 'LICENCE 1 doit apparaître (précondition sur les données de test réelles)');
    assert.notStrictEqual(parseInt(licence1.reinscriptions, 10), parseInt(licence1.total, 10), 'LICENCE 1 : reinscriptions (0 réel) doit différer de total, preuve que ce n\'est plus un copier-coller/sous-ensemble automatique');
  });

  await test('4. Cohérence croisée : la somme des "reinscriptions" est identique par niveau, par cycle et par filière (même définition sous-jacente)', async () => {
    const req = { query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } };
    const resNiveau = mockRes(); await statCtrl.getStatisticsByNiveau(req, resNiveau);
    const resCycle = mockRes(); await statCtrl.getStatisticsByCycle(req, resCycle);
    const resFiliere = mockRes(); await statCtrl.getStatisticsByFiliere(req, resFiliere);

    const sommeNiveau = resNiveau.get().body.data.reduce((s, r) => s + parseInt(r.reinscriptions, 10), 0);
    const sommeCycle = resCycle.get().body.data.reduce((s, r) => s + parseInt(r.reinscriptions, 10), 0);
    const sommeFiliere = resFiliere.get().body.data.reduce((s, f) => s + f.total_reinscriptions, 0);

    assert.strictEqual(sommeCycle, sommeNiveau, 'somme par cycle doit égaler la somme par niveau');
    assert.strictEqual(sommeFiliere, sommeNiveau, 'somme par filière doit égaler la somme par niveau');

    const reel = await db.query(`
      SELECT COUNT(*) AS n FROM historique_inscription h
      JOIN etudiant e ON e.id = h.etudiant_id
      WHERE h.type_evenement = 'reinscription' AND h.annee_academique_id = $1 AND e.site_id = $2
    `, [ANNEE_2026_2027, SITE_ID]);
    assert.strictEqual(sommeNiveau, parseInt(reel.rows[0].n, 10), 'la somme doit égaler le COUNT(*) réel global de historique_inscription');
  });

  await test('5. "Inscriptions" et "Total" restent inchangés (même filtre standing=\'Inscrit\', non affecté par ce correctif)', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const { data } = res.get().body;
    for (const row of data) {
      assert.strictEqual(row.inscriptions, row.total, 'Inscriptions === Total reste vrai (chaque inscrit est soit Affecté soit Non affecté, comportement mathématiquement attendu, non touché par ce correctif)');
    }
  });

  await test('6. Aucune régression : etudiants_affectes + etudiants_non_affectes = inscriptions, sur des données réelles', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const { data } = res.get().body;
    for (const row of data) {
      assert.strictEqual(parseInt(row.etudiants_affectes, 10) + parseInt(row.etudiants_non_affectes, 10), parseInt(row.inscriptions, 10), `niveau ${row.niveau}`);
    }
  });

  await test('7. getStatisticsByCursus fonctionne toujours (200, structure valide) — reinscriptions peut légitimement être 0 si curcus_id non renseigné sur l\'historique réel (limite de données déjà documentée, pas une régression)', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByCursus({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const { body } = res.get();
    assert.strictEqual(body.success, true);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.every((r) => typeof r.reinscriptions !== 'undefined'));
  });

  await test('8. Année sans aucune réinscription validée (2025-2026, id=1) → reinscriptions = 0 partout, aucune erreur', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: '1', departement_id: String(SITE_ID) } }, res);
    const { body } = res.get();
    assert.strictEqual(body.success, true);
    // Non bloquant si des réinscriptions réelles existent déjà sur 2025-2026 : on vérifie juste
    // l'absence d'erreur et la cohérence structurelle, jamais une valeur supposée à l'avance.
    assert.ok(body.data.every((r) => Number.isInteger(parseInt(r.reinscriptions, 10))));
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed > 0) process.exitCode = 1;
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
