// test-statistiquesAccessoiresNiveau.js — Chantier "Suivi des accessoires par niveau" (dashboard
// Moyens Généraux, 2026-09-08).
//
// LECTURE SEULE STRICTE : aucun test de ce fichier n'insère, ne met à jour, ni ne supprime la
// moindre ligne en base. Tous les cas fonctionnels sont vérifiés sur des DONNÉES RÉELLES déjà
// présentes en base (année 2026-2027, site IIPEA COCODY, id=1) — jamais de données créées pour
// l'occasion. L'exclusion du surplus payant est vérifiée UNIQUEMENT par inspection structurelle du
// code source (aucun risque de dépendre d'un jeu de données réel qui pourrait changer), même
// convention que le test "MG 11" de test-suiviDistributionsEtKits.js.
//
// Les contrôleurs sont appelés directement (mock req/res), sans serveur HTTP — même patron que
// test-suiviDistributionsEtKits.js.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });

const assert = require('assert');
const fs = require('fs');
const db = require('./config/db.config');
const distributionController = require('./controllers/distribution.controller');
const authenticateToken = require('./middleware/auth.middleware');
const authorizeRoles = require('./middleware/authorize.middleware');

let passed = 0, failed = 0;
async function test(nom, fn) {
  try { await fn(); console.log(`✅ ${nom}`); passed++; }
  catch (err) { console.log(`❌ ${nom}\n   ${err.stack || err.message}`); failed++; }
}

const SITE_ID = 1;
const ANNEE_2025_2026 = 1; // aucune règle active (0 ligne regle_distribution_accessoire) — vérifié en base.
const ANNEE_2026_2027 = 3; // 17 règles actives réelles, 6 accessoires distribuables.

// Sujets réels déjà présents en base (jamais créés par ce fichier), vérifiés en base avant écriture
// de ce test (audit read-only préalable, 2026-09-08) :
//  - Règles actives 2026-2027 : CRAVATE/MACARRON/POLO_JAUNE/TISSU dues à BTS 1, LICENCE 1,
//    LICENCE 1 PRO ; POLO_BLEU dû à BTS 2, LICENCE 2, LICENCE 2 PRO ; POLO_BLANC dû à LICENCE 3,
//    LICENCE 3 PRO.
//  - "LICENCE 1" regroupe RÉELLEMENT 2 niveau_id distincts (une par filière) parmi les inscrits
//    2026-2027 — cas réel validant le regroupement par LIBELLÉ (jamais par niveau_id).
//  - BTS 2 (niveau réel d'AMAN 603 et BERTHE 615) : 2 inscrits, 0 récupérateur de POLO_BLEU.
//  - LICENCE 2 (niveau réel d'ABOUBACAR 2196) : 1 inscrit, 1 récupérateur de POLO_BLEU (ABOUBACAR).
//  - LICENCE 3 : POLO_BLANC dû, 0 récupérateur réel (niveau "sans récupération").
//  - site_id=2 (IIPEA ABOBO) : 0 inscrit réel en 2026-2027 — cas "aucun étudiant inscrit".

function mockReqRes(overrides = {}) {
  const req = { query: {}, params: {}, user: null, ...overrides };
  let statusCode, payload;
  const res = {
    status(code) { statusCode = code; return res; },
    json(body) { payload = body; return res; },
    getStatusCode: () => statusCode,
    getPayload: () => payload,
  };
  return { req, res };
}

async function main() {
  // ═══════════════════════════ SÉCURITÉ / PERMISSIONS (routes) ═══════════════════════════
  await test('Sécurité 1. Les 2 nouvelles routes sont déclarées AVANT /:id, avec authenticateToken+mgOnly+requirePermission(distribution.voir)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'routes/distribution.routes.js'), 'utf8');
    const idxStats = source.indexOf("router.get('/statistiques-par-niveau'");
    const idxNonRecup = source.indexOf("router.get('/non-recuperateurs'");
    const idxParamId = source.indexOf("router.get('/:id'");
    assert.ok(idxStats > -1 && idxNonRecup > -1 && idxParamId > -1, 'les 3 routes doivent exister');
    assert.ok(idxStats < idxParamId, '/statistiques-par-niveau doit être déclarée avant /:id');
    assert.ok(idxNonRecup < idxParamId, '/non-recuperateurs doit être déclarée avant /:id');
    for (const idx of [idxStats, idxNonRecup]) {
      const ligne = source.slice(idx, source.indexOf('\n', idx));
      assert.ok(ligne.includes('authenticateToken'), 'authenticateToken requis');
      assert.ok(ligne.includes('mgOnly'), 'mgOnly (admin/moyens_generaux) requis');
      assert.ok(ligne.includes("requirePermission('distribution.voir')"), "requirePermission('distribution.voir') requis, même permission que /suivi");
    }
  });

  await test("Sécurité 2. authorizeRoles('admin','moyens_generaux') renvoie 403 pour un rôle non autorisé (caissier)", () => {
    const { req, res } = mockReqRes({ user: { role: 'caissier' } });
    let nextAppele = false;
    authorizeRoles('admin', 'moyens_generaux')(req, res, () => { nextAppele = true; });
    assert.strictEqual(res.getStatusCode(), 403);
    assert.strictEqual(nextAppele, false);
  });

  await test('Sécurité 3. authenticateToken renvoie 401 sans token', () => {
    const { req, res } = mockReqRes({ headers: {} });
    authenticateToken(req, res, () => { throw new Error('next() ne doit jamais être appelé sans token'); });
    assert.strictEqual(res.getStatusCode(), 401);
  });

  // ═══════════════════════ STATISTIQUES PAR NIVEAU — validations ═══════════════════════
  await test('Stats 1. GET statistiques-par-niveau — 400 sans anneeAcademiqueId', async () => {
    const { req, res } = mockReqRes({ user: { id: 13, role: 'admin', departement_id: SITE_ID }, query: {} });
    await distributionController.getStatistiquesParNiveau(req, res);
    assert.strictEqual(res.getStatusCode(), 400);
  });

  await test('Stats 2. GET statistiques-par-niveau — 200, structure {accessoires, niveaux}', async () => {
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    assert.strictEqual(res.getStatusCode(), 200);
    const { data } = res.getPayload();
    assert.ok(Array.isArray(data.accessoires));
    assert.ok(Array.isArray(data.niveaux));
    assert.ok(data.niveaux.every((n) => typeof n.niveau === 'string' && typeof n.inscrits === 'number' && typeof n.accessoires === 'object'));
  });

  // ═══════════════════════ RÈGLE DE COMPTAGE (le point critique) ═══════════════════════
  await test('Stats 3. Colonnes accessoires = les 6 accessoires réellement configurés (règles actives 2026-2027), jamais codées en dur', async () => {
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    const noms = res.getPayload().data.accessoires.map((a) => a.nom).sort();
    assert.deepStrictEqual(noms, ['CRAVATE', 'MACARRON', 'POLO_BLANC', 'POLO_BLEU', 'POLO_JAUNE', 'TISSU'].sort());
  });

  await test('Stats 4. BTS 2 : 2 inscrits réels, POLO_BLEU = 0 récupérateur (AMAN 603 + BERTHE 615, aucun n\'a encore reçu)', async () => {
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    const bts2 = res.getPayload().data.niveaux.find((n) => n.niveau === 'BTS 2');
    const accessoires = res.getPayload().data.accessoires;
    const poloBleu = accessoires.find((a) => a.nom === 'POLO_BLEU');
    assert.ok(bts2, 'BTS 2 doit apparaître (regroupé, une seule ligne malgré plusieurs filières possibles)');
    assert.strictEqual(bts2.inscrits, 2);
    assert.strictEqual(bts2.accessoires[poloBleu.id], 0, 'nombre d\'ÉTUDIANTS récupérateurs, pas une quantité d\'unités');
  });

  await test('Stats 5. LICENCE 2 : 1 inscrit, POLO_BLEU = 1 récupérateur (ABOUBACAR 2196)', async () => {
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    const l2 = res.getPayload().data.niveaux.find((n) => n.niveau === 'LICENCE 2');
    const accessoires = res.getPayload().data.accessoires;
    const poloBleu = accessoires.find((a) => a.nom === 'POLO_BLEU');
    assert.ok(l2);
    assert.strictEqual(l2.inscrits, 1);
    assert.strictEqual(l2.accessoires[poloBleu.id], 1);
  });

  await test('Stats 6. LICENCE 1 : regroupée par LIBELLÉ malgré 2 niveau_id réels distincts (une ligne, pas deux)', async () => {
    // Vérifie d'abord en base que le cas réel existe toujours (2 niveau_id distincts pour ce
    // libellé parmi les inscrits 2026-2027) — si ce n'est plus vrai, le test reste valide mais
    // moins probant ; on continue quand même car l'assertion porte sur le résultat de l'API.
    const idsReels = await db.query(`
      SELECT COUNT(DISTINCT e.niveau_id) AS n FROM vue_position_academique e
      JOIN niveau n ON n.id = e.niveau_id
      WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' AND n.libelle = 'LICENCE 1'
    `, [ANNEE_2026_2027, SITE_ID]);
    assert.ok(parseInt(idsReels.rows[0].n, 10) >= 2, 'précondition : LICENCE 1 doit couvrir >= 2 niveau_id réels');

    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    const lignesLicence1 = res.getPayload().data.niveaux.filter((n) => n.niveau === 'LICENCE 1');
    assert.strictEqual(lignesLicence1.length, 1, 'LICENCE 1 ne doit apparaître qu\'UNE seule fois malgré plusieurs filières');
    assert.ok(lignesLicence1[0].inscrits >= 2, 'les inscrits des 2 filières doivent être additionnés');
  });

  await test('Stats 7. Cellule non applicable (accessoire non dû à ce niveau) = null, jamais 0 (BTS 2 / TISSU, dû seulement à BTS 1)', async () => {
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    const bts2 = res.getPayload().data.niveaux.find((n) => n.niveau === 'BTS 2');
    const tissu = res.getPayload().data.accessoires.find((a) => a.nom === 'TISSU');
    assert.strictEqual(bts2.accessoires[tissu.id], null, 'TISSU n\'est pas prévu pour BTS 2 : la cellule doit rester null, jamais 0');
  });

  await test('Stats 8. Niveau/accessoire "dû" mais 0 récupération réelle (LICENCE 3 / POLO_BLANC)', async () => {
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    const l3 = res.getPayload().data.niveaux.find((n) => n.niveau === 'LICENCE 3');
    const poloBlanc = res.getPayload().data.accessoires.find((a) => a.nom === 'POLO_BLANC');
    assert.ok(l3);
    assert.strictEqual(l3.accessoires[poloBlanc.id], 0, 'dû mais 0 récupérateur réel : doit afficher 0 (pas null)');
  });

  await test('Stats 9. Cohérence globale : somme des récupérateurs par accessoire (tous niveaux) = comptage direct en base', async () => {
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    const { accessoires, niveaux } = res.getPayload().data;
    for (const acc of accessoires) {
      const sommeApi = niveaux.reduce((s, n) => s + (n.accessoires[acc.id] ?? 0), 0);
      const reel = await db.query(
        `SELECT COUNT(DISTINCT ld.etudiant_id) AS n FROM ligne_distribution ld
         JOIN vue_position_academique e ON e.id = ld.etudiant_id AND e.annee_academique_id = ld.annee_academique_id
         WHERE ld.annee_academique_id = $1 AND ld.accessoire_id = $2 AND ld.est_supplementaire = false AND e.site_id = $3`,
        [ANNEE_2026_2027, acc.id, SITE_ID]
      );
      assert.strictEqual(sommeApi, parseInt(reel.rows[0].n, 10), `accessoire ${acc.nom} : somme API doit égaler COUNT(DISTINCT etudiant_id) réel`);
    }
  });

  await test('Stats 10. Exclusion du surplus payant — vérifiée structurellement (est_supplementaire = false dans la requête récupérateurs)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'services/statistiquesAccessoiresNiveau.service.js'), 'utf8');
    assert.ok(/ld\.est_supplementaire = false/.test(source), 'la requête récupérateurs doit exclure explicitement le surplus payant');
  });

  await test("Stats 11. Cloisonnement site — site_id=2 (IIPEA ABOBO, 0 inscrit réel) ne renvoie aucun niveau", async () => {
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: 2 },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    assert.strictEqual(res.getStatusCode(), 200);
    assert.deepStrictEqual(res.getPayload().data.niveaux, [], 'aucun inscrit réel sur ce site pour cette année');
  });

  await test('Stats 12. Aucune règle configurée (année 2025-2026, 0 ligne regle_distribution_accessoire active) → accessoires vides, cellules absentes', async () => {
    const reglesReelles = await db.query('SELECT COUNT(*) AS n FROM regle_distribution_accessoire WHERE annee_academique_id = $1 AND actif = true', [ANNEE_2025_2026]);
    assert.strictEqual(parseInt(reglesReelles.rows[0].n, 10), 0, 'précondition : aucune règle active sur 2025-2026');

    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2025_2026) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    const { accessoires, niveaux } = res.getPayload().data;
    assert.deepStrictEqual(accessoires, [], 'aucun accessoire configuré cette année-là');
    assert.ok(niveaux.length > 0, 'les niveaux (inscrits réels) doivent quand même apparaître');
    assert.ok(niveaux.every((n) => Object.keys(n.accessoires).length === 0), 'aucune colonne accessoire à peupler');
  });

  await test('Stats 13. Filtre filiereId restreint les inscrits sans casser la structure de réponse', async () => {
    const filiereReelle = await db.query(`
      SELECT DISTINCT e.id_filiere FROM vue_position_academique e
      WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' AND e.id_filiere IS NOT NULL LIMIT 1
    `, [ANNEE_2026_2027, SITE_ID]);
    const filiereId = filiereReelle.rows[0].id_filiere;
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027), filiereId: String(filiereId) },
    });
    await distributionController.getStatistiquesParNiveau(req, res);
    assert.strictEqual(res.getStatusCode(), 200);
    assert.ok(Array.isArray(res.getPayload().data.niveaux));
  });

  // ═══════════════════════════ NON-RÉCUPÉRATEURS (détail cellule) ═══════════════════════════
  await test('NonRecup 1. 400 si anneeAcademiqueId/niveau/accessoireId manquant', async () => {
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getNonRecuperateurs(req, res);
    assert.strictEqual(res.getStatusCode(), 400);
  });

  await test('NonRecup 2. BTS 2 / POLO_BLEU → AMAN (603) et BERTHE (615), avec les champs attendus', async () => {
    const accResult = await db.query("SELECT id FROM accessoire WHERE nom = 'POLO_BLEU'");
    const accessoireId = accResult.rows[0].id;
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027), niveau: 'BTS 2', accessoireId: String(accessoireId) },
    });
    await distributionController.getNonRecuperateurs(req, res);
    assert.strictEqual(res.getStatusCode(), 200);
    const data = res.getPayload().data;
    assert.strictEqual(data.length, 2);
    const matricules = data.map((r) => r.nom).sort();
    assert.deepStrictEqual(matricules, ['AMAN', 'BERTHE']);
    for (const champ of ['matricule_iipea', 'nom', 'prenoms', 'telephone', 'filiere', 'niveau', 'groupe']) {
      assert.ok(champ in data[0], `le champ ${champ} doit être présent`);
    }
    assert.ok(data.every((r) => r.niveau === 'BTS 2'));
  });

  await test('NonRecup 3. LICENCE 2 / POLO_BLEU → liste vide (ABOUBACAR a déjà récupéré, seul inscrit du niveau)', async () => {
    const accResult = await db.query("SELECT id FROM accessoire WHERE nom = 'POLO_BLEU'");
    const accessoireId = accResult.rows[0].id;
    const { req, res } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027), niveau: 'LICENCE 2', accessoireId: String(accessoireId) },
    });
    await distributionController.getNonRecuperateurs(req, res);
    assert.deepStrictEqual(res.getPayload().data, []);
  });

  await test('NonRecup 4. Cohérence avec le tableau : inscrits - récupérateurs = taille de la liste non-récupérateurs (BTS 2 / POLO_BLEU)', async () => {
    const accResult = await db.query("SELECT id FROM accessoire WHERE nom = 'POLO_BLEU'");
    const accessoireId = accResult.rows[0].id;

    const { req: reqStats, res: resStats } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027) },
    });
    await distributionController.getStatistiquesParNiveau(reqStats, resStats);
    const bts2 = resStats.getPayload().data.niveaux.find((n) => n.niveau === 'BTS 2');

    const { req: reqDetail, res: resDetail } = mockReqRes({
      user: { id: 13, role: 'admin', departement_id: SITE_ID },
      query: { anneeAcademiqueId: String(ANNEE_2026_2027), niveau: 'BTS 2', accessoireId: String(accessoireId) },
    });
    await distributionController.getNonRecuperateurs(reqDetail, resDetail);

    const attendu = bts2.inscrits - bts2.accessoires[accessoireId];
    assert.strictEqual(resDetail.getPayload().data.length, attendu);
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  if (failed > 0) process.exitCode = 1;
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
