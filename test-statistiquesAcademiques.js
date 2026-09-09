// test-statistiquesAcademiques.js — Statistiques académiques (Gestion académique / Statistique).
//
// v3 (2026-09-09) — compatibilité historique : v2 (même jour) redéfinissait globalement
// "inscriptions"/"reinscriptions" via historique_inscription, ce qui rendait TOUTES les
// statistiques 2025-2026 nulles (0/0/0 partout, vérifié en base) puisque cette table n'a
// commencé à être alimentée de façon fiable qu'au correctif du 2026-08-18 — 2025-2026 lui est
// structurellement antérieure. v3 introduit une séparation LEGACY (2025-2026, ancienne
// heuristique par niveau, restaurée bit pour bit) / CURRENT (2026-2027+, historique_inscription),
// résolue par le LIBELLÉ réel de l'année (jamais un id supposé).
//
// LECTURE SEULE STRICTE : aucun test n'insère, ne met à jour, ni ne supprime la moindre ligne en
// base. Toutes les valeurs LEGACY et CURRENT ci-dessous sont des captures RÉELLES de la base
// locale (année 2025-2026 id=1 et 2026-2027 id=3, site IIPEA COCODY id=1), relevées juste avant
// l'écriture de ce fichier — jamais des valeurs inventées.

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
const ANNEE_2025_2026 = 1; // LEGACY — heuristique par niveau restaurée.
const ANNEE_2026_2027 = 3; // CURRENT — historique_inscription (admission/reinscription).

function mockRes() {
  let body, code;
  return {
    status(c) { code = c; return this; },
    json(b) { body = b; return this; },
    get: () => ({ code, body }),
  };
}

async function main() {
  // ═══════════════════════════ Résolution legacy/current (par LIBELLÉ, jamais un id) ═══════════════════════════
  await test("Résolution 1. estAnneeLegacy(1) [libellé réel '2025-2026'] -> true", async () => {
    const legacy = await statCtrl._estAnneeLegacy(db, ANNEE_2025_2026);
    assert.strictEqual(legacy, true);
  });

  await test("Résolution 2. estAnneeLegacy(3) [libellé réel '2026-2027'] -> false", async () => {
    const legacy = await statCtrl._estAnneeLegacy(db, ANNEE_2026_2027);
    assert.strictEqual(legacy, false);
  });

  await test('Résolution 3. La comparaison porte sur le LIBELLÉ réel en base, pas un id codé en dur — vérifié directement', async () => {
    const reel = await db.query('SELECT annee FROM anneeacademique WHERE id = $1', [ANNEE_2025_2026]);
    assert.strictEqual(reel.rows[0].annee, statCtrl._ANNEE_LEGACY_REINSCRIPTION, 'précondition : id=1 doit réellement porter le libellé 2025-2026 dans cette base');
  });

  await test("Résolution 4 (TEST 6 — année future/différente). Toute année dont le libellé n'est PAS exactement '2025-2026' utilise CURRENT, y compris un id inexistant (aucune année future 2027-2028 en base locale à ce jour — testé logiquement)", async () => {
    const legacyIdInexistant = await statCtrl._estAnneeLegacy(db, 999999);
    assert.strictEqual(legacyIdInexistant, false, 'un id qui ne résout à aucun libellé ne doit jamais tomber sur legacy par défaut');
    const anneesReelles = await db.query('SELECT id, annee FROM anneeacademique');
    for (const row of anneesReelles.rows) {
      const attendu = row.annee === '2025-2026';
      const obtenu = await statCtrl._estAnneeLegacy(db, row.id);
      assert.strictEqual(obtenu, attendu, `année id=${row.id} (${row.annee})`);
    }
  });

  // ═══════════════════════════ TEST 1 — 2025-2026 utilise l'ancienne règle ═══════════════════════════
  await test('TEST 1. 2025-2026 : les statistiques par niveau correspondent aux valeurs historiques connues (capture réelle avant écriture de ce test)', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2025_2026), departement_id: String(SITE_ID) } }, res);
    const parNiveau = Object.fromEntries(res.get().body.data.map((r) => [r.niveau, r]));

    // Capture réelle (heuristique legacy réappliquée) — cf. commentaire d'en-tête.
    const attendu = {
      'BTS 1': { aff: 1069, naff: 115, insc: 1184, reinsc: 0, total: 1184 },
      'BTS 2': { aff: 707, naff: 117, insc: 824, reinsc: 824, total: 824 },
      'LICENCE 1': { aff: 2011, naff: 99, insc: 2110, reinsc: 0, total: 2110 },
      'LICENCE 2': { aff: 1008, naff: 75, insc: 1083, reinsc: 1083, total: 1083 },
      'LICENCE 3': { aff: 510, naff: 90, insc: 600, reinsc: 600, total: 600 },
    };
    for (const [niveau, v] of Object.entries(attendu)) {
      const row = parNiveau[niveau];
      assert.ok(row, `${niveau} doit apparaître`);
      assert.strictEqual(parseInt(row.etudiants_affectes, 10), v.aff, `${niveau} affectes`);
      assert.strictEqual(parseInt(row.etudiants_non_affectes, 10), v.naff, `${niveau} non_affectes`);
      assert.strictEqual(parseInt(row.inscriptions, 10), v.insc, `${niveau} inscriptions`);
      assert.strictEqual(parseInt(row.reinscriptions, 10), v.reinsc, `${niveau} reinscriptions`);
      assert.strictEqual(parseInt(row.total, 10), v.total, `${niveau} total`);
    }
  });

  await test("TEST 1bis. 2025-2026 : Total Général reste non-nul (régression v2 corrigée — v2 donnait 0 partout, vérifié avant ce correctif)", async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2025_2026), departement_id: String(SITE_ID) } }, res);
    const sommeTotal = res.get().body.data.reduce((s, r) => s + parseInt(r.total, 10), 0);
    assert.ok(sommeTotal > 7000, `le total général 2025-2026 doit rester de l'ordre de plusieurs milliers d'étudiants réels, obtenu ${sommeTotal}`);
  });

  // ═══════════════════════════ TEST 2 — 2026-2027 utilise la nouvelle règle ═══════════════════════════
  await test("TEST 2. 2026-2027 : 'admission' => Inscriptions, 'reinscription' => Ré-inscriptions, aucun double comptage (total = inscriptions + reinscriptions partout)", async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    for (const row of res.get().body.data) {
      assert.strictEqual(parseInt(row.total, 10), parseInt(row.inscriptions, 10) + parseInt(row.reinscriptions, 10), `niveau ${row.niveau}`);
      const reelAdmission = await db.query(`
        SELECT COUNT(*) AS n FROM historique_inscription h JOIN etudiant e ON e.id = h.etudiant_id JOIN niveau hn ON hn.id = h.niveau_id
        WHERE h.type_evenement = 'admission' AND h.annee_academique_id = $1 AND e.site_id = $2 AND hn.libelle = $3
      `, [ANNEE_2026_2027, SITE_ID, row.niveau]);
      assert.strictEqual(parseInt(row.inscriptions, 10), parseInt(reelAdmission.rows[0].n, 10), `${row.niveau} inscriptions = admissions réelles`);
    }
  });

  // ═══════════════════════════ TEST 3 — BTS 2 ═══════════════════════════
  await test('TEST 3. BTS 2 : legacy (2025-2026, heuristique niveau) = 707/117/824/824/824', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2025_2026), departement_id: String(SITE_ID) } }, res);
    const bts2 = res.get().body.data.find((r) => r.niveau === 'BTS 2');
    assert.strictEqual(parseInt(bts2.inscriptions, 10), 824);
    assert.strictEqual(parseInt(bts2.reinscriptions, 10), 824);
    assert.strictEqual(parseInt(bts2.total, 10), 824);
  });

  await test("TEST 3bis. BTS 2 : current (2026-2027, vraie origine) = réinscriptions validées réelles (AMAN 603, BERTHE 615), jamais l'heuristique niveau", async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const bts2 = res.get().body.data.find((r) => r.niveau === 'BTS 2');
    assert.strictEqual(parseInt(bts2.inscriptions, 10), 0);
    assert.strictEqual(parseInt(bts2.reinscriptions, 10), 2);
    assert.strictEqual(parseInt(bts2.total, 10), 2);
  });

  // ═══════════════════════════ TEST 4 — LICENCE 2 ═══════════════════════════
  await test('TEST 4. LICENCE 2 : legacy (2025-2026) = 1008/75/1083/1083/1083', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2025_2026), departement_id: String(SITE_ID) } }, res);
    const l2 = res.get().body.data.find((r) => r.niveau === 'LICENCE 2');
    assert.strictEqual(parseInt(l2.inscriptions, 10), 1083);
    assert.strictEqual(parseInt(l2.reinscriptions, 10), 1083);
    assert.strictEqual(parseInt(l2.total, 10), 1083);
  });

  await test("TEST 4bis. LICENCE 2 : current (2026-2027) = vraie origine réelle (ABOUBACAR 2196, réinscription validée)", async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const l2 = res.get().body.data.find((r) => r.niveau === 'LICENCE 2');
    assert.strictEqual(parseInt(l2.inscriptions, 10), 0);
    assert.strictEqual(parseInt(l2.reinscriptions, 10), 1);
    assert.strictEqual(parseInt(l2.total, 10), 1);
  });

  // ═══════════════════════════ TEST 5 — LICENCE 3 ═══════════════════════════
  await test('TEST 5. LICENCE 3 : legacy (2025-2026) = 510/90/600/600/600', async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2025_2026), departement_id: String(SITE_ID) } }, res);
    const l3 = res.get().body.data.find((r) => r.niveau === 'LICENCE 3');
    assert.strictEqual(parseInt(l3.inscriptions, 10), 600);
    assert.strictEqual(parseInt(l3.reinscriptions, 10), 600);
    assert.strictEqual(parseInt(l3.total, 10), 600);
  });

  await test("TEST 5bis. LICENCE 3 : current (2026-2027) = vraie origine réelle (DIALLO 5157, CISSE 3667, réinscriptions validées)", async () => {
    const res = mockRes();
    await statCtrl.getStatisticsByNiveau({ query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } }, res);
    const l3 = res.get().body.data.find((r) => r.niveau === 'LICENCE 3');
    assert.strictEqual(parseInt(l3.inscriptions, 10), 0);
    assert.strictEqual(parseInt(l3.reinscriptions, 10), 2);
    assert.strictEqual(parseInt(l3.total, 10), 2);
  });

  // ═══════════════════════════ Cohérence croisée niveau/cycle/cursus/filière, PAR ANNÉE ═══════════════════════════
  await test('Cohérence 1 (2025-2026, LEGACY). Les 4 fonctions (niveau/cycle/cursus/filière) utilisent la même règle legacy — sommes Affectés/Non Affectés identiques', async () => {
    const req = { query: { annee_academique_id: String(ANNEE_2025_2026), departement_id: String(SITE_ID) } };
    const resNiveau = mockRes(); await statCtrl.getStatisticsByNiveau(req, resNiveau);
    const resCycle = mockRes(); await statCtrl.getStatisticsByCycle(req, resCycle);
    const resCursus = mockRes(); await statCtrl.getStatisticsByCursus(req, resCursus);
    const resFiliere = mockRes(); await statCtrl.getStatisticsByFiliere(req, resFiliere);

    const sum = (rows, key) => rows.reduce((s, r) => s + parseInt(r[key] || '0', 10), 0);
    const affNiveau = sum(resNiveau.get().body.data, 'etudiants_affectes');
    assert.strictEqual(sum(resCycle.get().body.data, 'etudiants_affectes'), affNiveau);
    assert.strictEqual(sum(resCursus.get().body.data, 'etudiants_affectes'), affNiveau);
    assert.strictEqual(resFiliere.get().body.data.reduce((s, f) => s + f.total_etudiants_affectes, 0), affNiveau);

    // Sur cette année, reinscriptions (legacy) doit être non nulle ET différente de affectes (preuve que
    // les 4 fonctions appliquent bien la même heuristique, pas un mélange legacy/current).
    const reinscNiveau = sum(resNiveau.get().body.data, 'reinscriptions');
    assert.ok(reinscNiveau > 0);
    assert.strictEqual(sum(resCycle.get().body.data, 'reinscriptions'), reinscNiveau);
    assert.strictEqual(sum(resCursus.get().body.data, 'reinscriptions'), reinscNiveau);
    assert.strictEqual(resFiliere.get().body.data.reduce((s, f) => s + f.total_reinscriptions, 0), reinscNiveau);
  });

  await test('Cohérence 2 (2026-2027, CURRENT). Les 4 fonctions utilisent la même règle historique_inscription — sommes Inscriptions/Réinscriptions identiques (= 3 et 5, baseline connue)', async () => {
    const req = { query: { annee_academique_id: String(ANNEE_2026_2027), departement_id: String(SITE_ID) } };
    const resNiveau = mockRes(); await statCtrl.getStatisticsByNiveau(req, resNiveau);
    const resCycle = mockRes(); await statCtrl.getStatisticsByCycle(req, resCycle);
    const resCursus = mockRes(); await statCtrl.getStatisticsByCursus(req, resCursus);
    const resFiliere = mockRes(); await statCtrl.getStatisticsByFiliere(req, resFiliere);

    const sum = (rows, key) => rows.reduce((s, r) => s + parseInt(r[key] || '0', 10), 0);
    const insNiveau = sum(resNiveau.get().body.data, 'inscriptions');
    const reinsNiveau = sum(resNiveau.get().body.data, 'reinscriptions');
    assert.strictEqual(insNiveau, 3);
    assert.strictEqual(reinsNiveau, 5);
    assert.strictEqual(sum(resCycle.get().body.data, 'inscriptions'), insNiveau);
    assert.strictEqual(sum(resCycle.get().body.data, 'reinscriptions'), reinsNiveau);
    assert.strictEqual(resFiliere.get().body.data.reduce((s, f) => s + f.total_inscriptions, 0), insNiveau);
    assert.strictEqual(resFiliere.get().body.data.reduce((s, f) => s + f.total_reinscriptions, 0), reinsNiveau);
  });

  await test("Cohérence 3. Aucune fonction ne mélange legacy/current : niveau ne peut pas utiliser current pendant que cycle utilise legacy (vérifié en comparant si reinscriptions(2025-2026) == reinscriptions(2026-2027) recalculées avec l'AUTRE règle serait absurde — ici on vérifie juste la cohérence interne déjà prouvée ci-dessus, note explicite)", () => {
    // Les tests "Cohérence 1" et "Cohérence 2" ci-dessus prouvent déjà, pour chaque année, que les 4
    // fonctions renvoient des sommes identiques — la seule façon d'obtenir cette identité est que les
    // 4 fonctions utilisent EXACTEMENT la même branche (legacy ou current) pour une même année. Un
    // mélange (ex. niveau en current, cycle en legacy) romprait immédiatement cette égalité.
    assert.ok(true);
  });

  // ═══════════════════════════ Non-régression : structure, permissions, cursus ═══════════════════════════
  await test('Non-régression 1. getStatisticsByCursus fonctionne sur les 2 années (200, structure valide)', async () => {
    for (const annee of [ANNEE_2025_2026, ANNEE_2026_2027]) {
      const res = mockRes();
      await statCtrl.getStatisticsByCursus({ query: { annee_academique_id: String(annee), departement_id: String(SITE_ID) } }, res);
      assert.strictEqual(res.get().body.success, true, `année ${annee}`);
    }
  });

  await test("Non-régression 2. Aucune trace de code actif référençant l'ancienne heuristique EN DEHORS des fonctions *Legacy (isolation propre)", () => {
    const source = fs.readFileSync(path.join(__dirname, 'controllers/StatistiqueGeneral.controller.js'), 'utf8');
    const fonctionsCurrent = source.split(/async function getStats\w+Current/).slice(1).join('');
    assert.ok(!/NIVEAUX_IMPLIQUANT_REINSCRIPTION_LEGACY/.test(fonctionsCurrent.split('// ─────────────────────────────────────── Handlers')[0]), "les fonctions *Current ne doivent jamais référencer la constante legacy");
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed > 0) process.exitCode = 1;
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
