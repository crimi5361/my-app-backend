// Chantier 10 (2026-08-02) — sous-phases 9 et 10 : distribution des accessoires aux étudiants et
// reçu de remise. Cœur métier du module — cœur de la vigilance anti-fraude (indicateur remis/non
// remis + double blocage : pré-vérification ergonomique ET contrainte UNIQUE en base).
//
// Traçabilité : distribution/ligne_distribution ne stockent QUE des identifiants (etudiant_id,
// accessoire_id, annee_academique_id) — l'enregistrement lui-même ne dépend d'aucune donnée
// mutable et reste donc TOUJOURS accessible (etudiant_id est protégé par une FK sans CASCADE :
// un étudiant ayant déjà reçu ses accessoires ne peut jamais être supprimé, vérifié).
//
// Instantané académique (sous-phase 10) : école/filière/niveau/classe/site SONT en revanche
// supprimables/réaffectables ailleurs dans l'application (ecole/departement/filiere/niveau/site
// ont chacun un endpoint DELETE). Un reçu de remise étant un document officiel, il doit refléter
// la situation de l'étudiant AU MOMENT de la remise, pas sa situation actuelle des années plus
// tard — ces valeurs sont donc figées sur `distribution` à la création, jamais recalculées.
// Seules les données strictement identitaires (nom, matricule, sexe, photo) restent jointes en
// direct depuis `etudiant`, car stables et protégées par la même contrainte FK.
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const { enregistrerMouvementStock, getEmplacementStockPourSite, getSoldeStock } = require('../services/stockMoyensGeneraux.service');

// Chantier Moyens Généraux, Phase 2C (2026-08-19) : la distribution gratuite standard ne laisse
// plus le client fixer la quantité — elle est TOUJOURS celle de la règle applicable
// (quantite_standard), imposée côté backend (cf. getAccessoiresEligibles/creerDistribution
// ci-dessous). Une ligne du corps de requête n'a donc plus besoin de porter de quantité du tout.
function validerLignes(lignes) {
  if (!Array.isArray(lignes) || lignes.length === 0) {
    return 'Sélectionnez au moins un accessoire à remettre.';
  }
  const accessoireIds = [];
  for (const ligne of lignes) {
    if (!Number.isInteger(ligne.accessoire_id)) {
      return 'Chaque ligne doit référencer un accessoire valide.';
    }
    accessoireIds.push(ligne.accessoire_id);
  }
  if (new Set(accessoireIds).size !== accessoireIds.length) {
    return 'Un même accessoire ne peut apparaître qu\'une seule fois.';
  }
  return null;
}

// Résout la liste des accessoires éligibles pour CET étudiant précis (son niveau, son année) —
// jamais `SELECT * FROM accessoire` (règle explicite Phase 2C §4). Une règle est applicable si :
//   (a) regle.annee_academique_id = année de l'étudiant
//   (b) regle.niveau_libelle = niveau de l'étudiant OU regle.tous_niveaux = true
//   (c) accessoire.distribuable_etudiant = true ET accessoire.actif = true
// Partagée par getFicheEtudiant (lecture, pour l'écran) ET creerDistribution (réécriture complète
// de la même résolution au moment de la validation — jamais une confiance dans ce que le frontend
// a affiché), pour ne jamais laisser diverger les deux calculs.
async function getAccessoiresEligibles(dbClient, { etudiantId, niveauLibelle, anneeAcademiqueId, emplacementStockId }) {
  const reglesResult = await dbClient.query(
    `SELECT r.id AS regle_id, r.accessoire_id, r.quantite_standard, r.niveau_libelle, r.tous_niveaux,
       a.nom AS accessoire_nom, a.code, a.categorie_id, c.nom AS categorie_nom
     FROM regle_distribution_accessoire r
     JOIN accessoire a ON a.id = r.accessoire_id
     LEFT JOIN categorie_accessoire c ON c.id = a.categorie_id
     WHERE r.annee_academique_id = $1 AND r.actif = true
       AND a.distribuable_etudiant = true AND a.actif = true
       AND (r.tous_niveaux = true OR r.niveau_libelle = $2)
     ORDER BY a.nom`,
    [anneeAcademiqueId, niveauLibelle]
  );

  // Chantier Moyens Généraux, Phase 2D (2026-08-19) : ld.est_supplementaire = false — une remise
  // surplus payante (est_supplementaire = true) ne doit JAMAIS être comptée comme la dotation
  // gratuite déjà consommée, sinon un étudiant ayant acheté un surplus verrait à tort son
  // entitlement gratuit du même accessoire marqué "déjà distribué" alors qu'il ne l'a jamais reçu
  // gratuitement.
  const dejaDistribueResult = await dbClient.query(
    `SELECT ld.accessoire_id, ld.quantite, d.date_remise, d.numero_recu
     FROM ligne_distribution ld
     JOIN distribution d ON d.id = ld.distribution_id
     WHERE ld.etudiant_id = $1 AND ld.annee_academique_id = $2 AND ld.est_supplementaire = false`,
    [etudiantId, anneeAcademiqueId]
  );
  const dejaDistribueParAccessoire = new Map(dejaDistribueResult.rows.map((r) => [r.accessoire_id, r]));

  const accessoires = [];
  for (const regle of reglesResult.rows) {
    const dejaDistribue = dejaDistribueParAccessoire.get(regle.accessoire_id);
    const solde = await getSoldeStock(dbClient, { emplacementStockId, accessoireId: regle.accessoire_id });

    let etat;
    if (dejaDistribue) etat = 'deja_distribue';
    else if (solde < regle.quantite_standard) etat = 'indisponible';
    else etat = 'disponible';

    accessoires.push({
      regle_id: regle.regle_id,
      accessoire_id: regle.accessoire_id,
      accessoire_nom: regle.accessoire_nom,
      code: regle.code,
      categorie_nom: regle.categorie_nom,
      niveau_libelle: regle.tous_niveaux ? 'Tous les niveaux' : regle.niveau_libelle,
      quantite_standard: regle.quantite_standard,
      stock_disponible: solde,
      etat,
      deja_distribue_le: dejaDistribue ? dejaDistribue.date_remise : null,
      deja_distribue_numero_recu: dejaDistribue ? dejaDistribue.numero_recu : null,
    });
  }
  return accessoires;
}

async function getDistributionDetail(dbClient, distributionId, siteId) {
  const header = await dbClient.query(
    `SELECT d.id, d.numero_recu, d.date_remise, d.etudiant_id,
       d.ecole_nom, d.filiere_nom, d.niveau_nom, d.classe_nom, d.site_nom,
       e.nom, e.prenoms, e.matricule, e.matricule_iipea, e.sexe, e.photo_url,
       u.id AS agent_id, u.nom AS agent_nom,
       aa.id AS annee_academique_id, aa.annee AS annee_academique
     FROM distribution d
     JOIN etudiant e ON e.id = d.etudiant_id
     JOIN utilisateur u ON u.id = d.agent_id
     JOIN anneeacademique aa ON aa.id = d.annee_academique_id
     JOIN emplacement_stock es ON es.id = d.emplacement_stock_id
     WHERE d.id = $1 AND es.site_id = $2`,
    [distributionId, siteId]
  );
  if (header.rows.length === 0) return null;

  const lignes = await dbClient.query(
    `SELECT ld.accessoire_id, a.code, a.nom, ld.quantite
     FROM ligne_distribution ld JOIN accessoire a ON a.id = ld.accessoire_id
     WHERE ld.distribution_id = $1 ORDER BY a.nom`,
    [distributionId]
  );

  return { ...header.rows[0], lignes: lignes.rows };
}

// Recherche combinée — deux usages distincts dans une seule requête (validé le 2026-08-02) :
// (a) trouver un étudiant pour une NOUVELLE remise (nom/prénoms/matricule IIPEA) ;
// (b) retrouver une remise DÉJÀ effectuée pour consultation/réimpression (numéro de reçu).
//
// Correctif du 2026-08-03 : (a) est désormais borné à l'année académique sélectionnée, exactement
// comme Scolarité/Comptabilité/Caisse. etudiant.annee_academique_id reflète l'inscription ACTIVE
// de l'étudiant (mise à jour à chaque réinscription, vérifié par introspection : 7205 étudiants
// encore à l'année 2025-2026 faute de réinscription, seulement 11 déjà réinscrits en 2026-2027) —
// un étudiant non réinscrit pour l'année sélectionnée ne doit donc plus apparaître ici. (b) reste
// volontairement NON filtrée par année : un numéro de reçu est un identifiant permanent, un agent
// doit pouvoir retrouver/réimprimer un ancien reçu même en travaillant sur l'année en cours.
exports.rechercher = async (req, res) => {
  try {
    const { q, anneeAcademiqueId } = req.query;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir au moins 2 caractères.' });
    }
    const terme = `%${q.trim()}%`;

    const ecoleCondEtudiant = ecoleId !== null ? 'AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $4)' : '';
    const etudiantParams = ecoleId !== null ? [siteId, anneeAcademiqueId, terme, ecoleId] : [siteId, anneeAcademiqueId, terme];

    const etudiantsResult = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.standing, e.photo_url
       FROM etudiant e JOIN filiere f ON f.id = e.id_filiere
       WHERE e.site_id = $1 AND e.annee_academique_id = $2 AND e.standing = 'Inscrit'
         AND (e.nom ILIKE $3 OR e.prenoms ILIKE $3 OR e.matricule_iipea ILIKE $3 OR (e.nom || ' ' || e.prenoms) ILIKE $3)
         ${ecoleCondEtudiant}
       ORDER BY e.nom, e.prenoms LIMIT 20`,
      etudiantParams
    );

    const ecoleCondDistribution = ecoleId !== null
      ? 'AND d.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3))'
      : '';
    const distributionParams = ecoleId !== null ? [siteId, terme, ecoleId] : [siteId, terme];

    const distributionsResult = await db.query(
      `SELECT d.id, d.numero_recu, d.date_remise, e.id AS etudiant_id, e.nom, e.prenoms, e.matricule_iipea
       FROM distribution d
       JOIN etudiant e ON e.id = d.etudiant_id
       JOIN emplacement_stock es ON es.id = d.emplacement_stock_id
       WHERE es.site_id = $1 AND d.numero_recu ILIKE $2 ${ecoleCondDistribution}
       ORDER BY d.date_remise DESC LIMIT 20`,
      distributionParams
    );

    res.status(200).json({
      success: true,
      data: { etudiants: etudiantsResult.rows, distributions: distributionsResult.rows },
    });
  } catch (error) {
    console.error('Erreur rechercher (distribution):', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Correctif du 2026-08-03 : anneeAcademiqueId est désormais un paramètre obligatoire, pas déduit
// implicitement. La fiche n'est renvoyée que si l'étudiant est réellement inscrit ('Inscrit') pour
// CETTE année précise — un étudiant seulement inscrit une autre année (ex. 2025-2026, non
// réinscrit) est traité comme introuvable, cohérent avec le reste de l'écran de recherche.
exports.getFicheEtudiant = async (req, res) => {
  try {
    const { id } = req.params;
    const { anneeAcademiqueId } = req.query;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }

    const ecoleCond = ecoleId !== null ? 'AND dep.ecole_id = $4' : '';
    const params = ecoleId !== null ? [id, siteId, anneeAcademiqueId, ecoleId] : [id, siteId, anneeAcademiqueId];

    const etudiantResult = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule, e.matricule_iipea, e.sexe, e.photo_url,
         e.standing, e.statut_scolaire, e.annee_academique_id,
         aa.annee AS annee_academique,
         f.nom AS filiere, n.libelle AS niveau, c.nom AS classe,
         ec.nom AS ecole, dep.nom AS departement
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN departement dep ON dep.id = f.departement_id
       JOIN ecole ec ON ec.id = dep.ecole_id
       JOIN niveau n ON n.id = e.niveau_id
       JOIN anneeacademique aa ON aa.id = e.annee_academique_id
       LEFT JOIN groupe g ON g.id = e.groupe_id
       LEFT JOIN classe c ON c.id = g.classe_id
       WHERE e.id = $1 AND e.site_id = $2 AND e.annee_academique_id = $3 AND e.standing = 'Inscrit' ${ecoleCond}`,
      params
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Étudiant introuvable ou non inscrit pour cette année académique." });
    }
    const etudiant = etudiantResult.rows[0];

    // Chantier Moyens Généraux, Phase 2C (2026-08-19) : remplace l'ancien "deja_remis"/"remise"
    // (une seule remise possible par étudiant/année, tout ou rien) par la liste des accessoires
    // réellement éligibles pour ce niveau/cette année, chacun avec son propre état — un étudiant
    // peut désormais avoir certains articles déjà remis et d'autres encore à distribuer.
    const emplacementStockId = await getEmplacementStockPourSite(db, siteId);
    const accessoiresEligibles = await getAccessoiresEligibles(db, {
      etudiantId: etudiant.id,
      niveauLibelle: etudiant.niveau,
      anneeAcademiqueId: etudiant.annee_academique_id,
      emplacementStockId,
    });

    res.status(200).json({
      success: true,
      data: { ...etudiant, accessoires_eligibles: accessoiresEligibles },
    });
  } catch (error) {
    console.error('Erreur getFicheEtudiant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getDistributionById = async (req, res) => {
  try {
    const { id } = req.params;
    const siteId = req.user.departement_id;
    const detail = await getDistributionDetail(db, id, siteId);
    if (!detail) {
      return res.status(404).json({ success: false, message: 'Remise introuvable.' });
    }
    res.status(200).json({ success: true, data: detail });
  } catch (error) {
    console.error('Erreur getDistributionById:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── Reçu de remise CONSOLIDÉ (Chantier Moyens Généraux, Phase 2D — ajustements, 2026-08-19) ───
// Distinct de getDistributionById : celui-ci retourne UNE session précise (un passage), volontairement
// inchangé (continue de servir HistoriqueDistributions.tsx — "que s'est-il passé lors de CE
// passage précis"). Celui-ci agrège, pour un étudiant et une année donnés, TOUTES les sessions —
// gratuites ET surplus — en un document unique reflétant l'état COMPLET des remises à cet étudiant
// (§3/§4 : "le reçu doit représenter l'historique complet", "ne pas remplacer/détruire l'ancien
// historique" — rien n'est supprimé ici, cette vue est un agrégat en lecture seule).
// Jamais confondu avec le reçu d'inscription (Etudiant/Recu_Payement, scolarité) — ce document
// reste exclusivement "REÇU DE REMISE D'ACCESSOIRES", inchangé dans son principe (§1/§5).
exports.getRecuConsolideEtudiant = async (req, res) => {
  try {
    const { id } = req.params;
    const { anneeAcademiqueId } = req.query;
    const siteId = req.user.departement_id;
    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }

    const etudiantResult = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule, e.matricule_iipea, e.sexe, e.photo_url
       FROM etudiant e WHERE e.id = $1 AND e.site_id = $2`,
      [id, siteId]
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];

    // Instantané académique + référence de document : celui de la session la plus récente pour cet
    // étudiant/année — mêmes valeurs figées qu'un reçu de session (§1, jamais recalculées depuis
    // l'état actuel de l'étudiant).
    const snapshotResult = await db.query(
      `SELECT numero_recu, date_remise, ecole_nom, filiere_nom, niveau_nom, classe_nom, site_nom,
         aa.annee AS annee_academique
       FROM distribution d
       JOIN anneeacademique aa ON aa.id = d.annee_academique_id
       WHERE d.etudiant_id = $1 AND d.annee_academique_id = $2
       ORDER BY d.date_remise DESC LIMIT 1`,
      [id, anneeAcademiqueId]
    );
    if (snapshotResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aucune remise enregistrée pour cet étudiant sur cette année académique.' });
    }
    const snapshot = snapshotResult.rows[0];

    const lignesOffertesResult = await db.query(
      `SELECT ld.accessoire_id, a.code, a.nom, ld.quantite
       FROM ligne_distribution ld
       JOIN accessoire a ON a.id = ld.accessoire_id
       JOIN distribution d ON d.id = ld.distribution_id
       WHERE d.etudiant_id = $1 AND d.annee_academique_id = $2 AND ld.est_supplementaire = false
       ORDER BY a.nom`,
      [id, anneeAcademiqueId]
    );

    const lignesSurplusResult = await db.query(
      `SELECT ld.accessoire_id, a.code, a.nom, ld.quantite,
         dsa.reference, dsa.prix_unitaire_vente, dsa.montant_total, dsa.date_distribution,
         pay.methode AS methode_paiement, pay.date_paiement, pr.numero_recu AS paiement_numero_recu,
         ucaiss.nom AS caissier_nom
       FROM ligne_distribution ld
       JOIN accessoire a ON a.id = ld.accessoire_id
       JOIN distribution d ON d.id = ld.distribution_id
       JOIN demande_surplus_accessoire dsa ON dsa.id = ld.demande_surplus_id
       LEFT JOIN paiement pay ON pay.id = dsa.paiement_id
       LEFT JOIN recu pr ON pr.id = pay.recu_id
       LEFT JOIN utilisateur ucaiss ON ucaiss.id::text = pay.effectue_par
       WHERE d.etudiant_id = $1 AND d.annee_academique_id = $2 AND ld.est_supplementaire = true
       ORDER BY dsa.date_distribution`,
      [id, anneeAcademiqueId]
    );

    res.status(200).json({
      success: true,
      data: {
        etudiant,
        annee_academique: snapshot.annee_academique,
        ecole_nom: snapshot.ecole_nom,
        filiere_nom: snapshot.filiere_nom,
        niveau_nom: snapshot.niveau_nom,
        classe_nom: snapshot.classe_nom,
        site_nom: snapshot.site_nom,
        numero_recu_reference: snapshot.numero_recu,
        date_derniere_remise: snapshot.date_remise,
        lignes_offertes: lignesOffertesResult.rows,
        lignes_surplus: lignesSurplusResult.rows,
        total_offerts: lignesOffertesResult.rows.reduce((s, l) => s + l.quantite, 0),
        total_surplus_paye: lignesSurplusResult.rows.reduce((s, l) => s + parseFloat(l.montant_total), 0),
      },
    });
  } catch (error) {
    console.error('Erreur getRecuConsolideEtudiant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Sous-phase 11 — historique des distributions. Toutes les colonnes académiques affichées et
// filtrées (école/filière/niveau) proviennent de l'instantané figé sur `distribution`, jamais des
// tables etudiant/filiere/ecole actuelles — cohérent avec le reçu (sous-phase 10).
//
// etudiant_id/annee_academique_id ajoutés (Chantier Moyens Généraux, Phase 2D — diagnostic reçu,
// 2026-08-19) : nécessaires pour que chaque ligne de l'historique puisse ouvrir directement le reçu
// de remise CONSOLIDÉ (GET /etudiant/:id/recu-consolide) plutôt que l'ancien reçu par session —
// HistoriqueDistributions.tsx ne les avait pas et retombait donc sur l'ancienne route.
exports.getHistorique = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    const whereClauses = ['es.site_id = $1'];
    const params = [siteId];

    // Cloisonnement école (Chantier 3) — porte sur l'affectation ACTUELLE de l'étudiant (qui a
    // le droit de voir cette donnée), indépendant de l'instantané académique affiché (ce qui
    // s'est passé au moment de la remise) : même distinction que partout ailleurs dans le module.
    if (ecoleId !== null) {
      whereClauses.push(`e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $${params.length + 1})`);
      params.push(ecoleId);
    }
    if (req.query.q && req.query.q.trim().length >= 2) {
      const terme = `%${req.query.q.trim()}%`;
      whereClauses.push(`(d.numero_recu ILIKE $${params.length + 1} OR e.matricule_iipea ILIKE $${params.length + 1} OR e.matricule ILIKE $${params.length + 1} OR e.nom ILIKE $${params.length + 1} OR e.prenoms ILIKE $${params.length + 1})`);
      params.push(terme);
    }
    if (req.query.annee_academique_id) {
      whereClauses.push(`d.annee_academique_id = $${params.length + 1}`);
      params.push(parseInt(req.query.annee_academique_id, 10));
    }
    if (req.query.date_debut) {
      whereClauses.push(`d.date_remise >= $${params.length + 1}`);
      params.push(req.query.date_debut);
    }
    if (req.query.date_fin) {
      whereClauses.push(`d.date_remise <= $${params.length + 1}::date + INTERVAL '1 day'`);
      params.push(req.query.date_fin);
    }
    if (req.query.ecole) {
      whereClauses.push(`d.ecole_nom = $${params.length + 1}`);
      params.push(req.query.ecole);
    }
    if (req.query.filiere) {
      whereClauses.push(`d.filiere_nom = $${params.length + 1}`);
      params.push(req.query.filiere);
    }
    if (req.query.niveau) {
      whereClauses.push(`d.niveau_nom = $${params.length + 1}`);
      params.push(req.query.niveau);
    }
    if (req.query.agent_id) {
      whereClauses.push(`d.agent_id = $${params.length + 1}`);
      params.push(parseInt(req.query.agent_id, 10));
    }
    if (req.query.accessoire_id) {
      whereClauses.push(`EXISTS (SELECT 1 FROM ligne_distribution ld WHERE ld.distribution_id = d.id AND ld.accessoire_id = $${params.length + 1})`);
      params.push(parseInt(req.query.accessoire_id, 10));
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const countResult = await db.query(
      `SELECT COUNT(*) FROM distribution d
       JOIN etudiant e ON e.id = d.etudiant_id
       JOIN emplacement_stock es ON es.id = d.emplacement_stock_id
       WHERE ${whereClauses.join(' AND ')}`,
      params
    );

    const dataResult = await db.query(
      `SELECT d.id, d.numero_recu, d.date_remise, d.etudiant_id, d.annee_academique_id,
         d.ecole_nom, d.filiere_nom, d.niveau_nom, d.classe_nom,
         e.nom, e.prenoms, e.matricule, e.matricule_iipea,
         u.nom AS agent_nom,
         aa.annee AS annee_academique,
         (SELECT COALESCE(SUM(ld.quantite), 0) FROM ligne_distribution ld WHERE ld.distribution_id = d.id) AS total_accessoires
       FROM distribution d
       JOIN etudiant e ON e.id = d.etudiant_id
       JOIN utilisateur u ON u.id = d.agent_id
       JOIN anneeacademique aa ON aa.id = d.annee_academique_id
       JOIN emplacement_stock es ON es.id = d.emplacement_stock_id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY d.date_remise DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.status(200).json({
      success: true,
      data: dataResult.rows.map((r) => ({ ...r, total_accessoires: parseInt(r.total_accessoires, 10) })),
      pagination: { page, limit, total: parseInt(countResult.rows[0].count, 10) },
    });
  } catch (error) {
    console.error('Erreur getHistorique:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Valeurs distinctes réellement utilisées dans les remises de ce site (pas le référentiel
// académique complet) — cohérent avec le principe de l'instantané : un filtre ne doit proposer
// que des valeurs qui ont un sens vis-à-vis de ce qui est affiché.
exports.getFiltresHistorique = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    const ecoleCond = ecoleId !== null
      ? 'AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $2)'
      : '';
    const params = ecoleId !== null ? [siteId, ecoleId] : [siteId];

    const result = await db.query(
      `SELECT DISTINCT d.ecole_nom, d.filiere_nom, d.niveau_nom
       FROM distribution d
       JOIN etudiant e ON e.id = d.etudiant_id
       JOIN emplacement_stock es ON es.id = d.emplacement_stock_id
       WHERE es.site_id = $1 ${ecoleCond}`,
      params
    );

    res.status(200).json({
      success: true,
      data: {
        ecoles: [...new Set(result.rows.map((r) => r.ecole_nom).filter(Boolean))].sort(),
        filieres: [...new Set(result.rows.map((r) => r.filiere_nom).filter(Boolean))].sort(),
        niveaux: [...new Set(result.rows.map((r) => r.niveau_nom).filter(Boolean))].sort(),
      },
    });
  } catch (error) {
    console.error('Erreur getFiltresHistorique:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Correctif du 2026-08-03 : anneeAcademiqueId est désormais transmis explicitement par le
// frontend (année sélectionnée à l'écran) et vérifié contre l'inscription réelle de l'étudiant —
// impossible de distribuer à un étudiant qui n'est pas 'Inscrit' pour cette année précise, même si
// son id_etudiant est par ailleurs valide (ex. étudiant resté sur 2025-2026, non réinscrit).
exports.creerDistribution = async (req, res) => {
  const client = await db.connect();
  try {
    const { etudiant_id, annee_academique_id: anneeAcademiqueIdBody, lignes } = req.body;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!Number.isInteger(etudiant_id)) {
      return res.status(400).json({ success: false, message: 'Un étudiant est requis.' });
    }
    if (!Number.isInteger(anneeAcademiqueIdBody)) {
      return res.status(400).json({ success: false, message: "L'année académique est requise." });
    }
    const erreurLignes = validerLignes(lignes);
    if (erreurLignes) {
      return res.status(400).json({ success: false, message: erreurLignes });
    }

    await client.query('BEGIN');

    const ecoleCond = ecoleId !== null ? 'AND dep.ecole_id = $4' : '';
    const etudiantParams = ecoleId !== null
      ? [etudiant_id, siteId, anneeAcademiqueIdBody, ecoleId]
      : [etudiant_id, siteId, anneeAcademiqueIdBody];
    // Récupère aussi l'instantané académique (école/filière/niveau/classe) au passage — évite une
    // seconde requête, et garantit que ce qui sera figé sur le reçu correspond exactement à ce qui
    // a été vérifié pour l'autorisation (même lecture, pas de fenêtre de désynchronisation).
    // e.annee_academique_id = $3 AND e.standing = 'Inscrit' : c'est ICI que la règle « inscription
    // valide pour l'année sélectionnée » est réellement appliquée, pas seulement côté recherche —
    // impossible de contourner le filtre de recherche par un appel direct à cette route.
    const etudiantResult = await client.query(
      `SELECT e.id, e.annee_academique_id,
         ec.nom AS ecole_nom, f.nom AS filiere_nom, n.libelle AS niveau_nom, c.nom AS classe_nom
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN departement dep ON dep.id = f.departement_id
       JOIN ecole ec ON ec.id = dep.ecole_id
       JOIN niveau n ON n.id = e.niveau_id
       LEFT JOIN groupe g ON g.id = e.groupe_id
       LEFT JOIN classe c ON c.id = g.classe_id
       WHERE e.id = $1 AND e.site_id = $2 AND e.annee_academique_id = $3 AND e.standing = 'Inscrit' ${ecoleCond}`,
      etudiantParams
    );
    if (etudiantResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: "Étudiant introuvable ou non inscrit pour cette année académique." });
    }
    const { ecole_nom: ecoleNom, filiere_nom: filiereNom, niveau_nom: niveauNom, classe_nom: classeNom } = etudiantResult.rows[0];
    const anneeAcademiqueId = anneeAcademiqueIdBody;

    const emplacementStockId = await getEmplacementStockPourSite(client, siteId);

    // Chantier Moyens Généraux, Phase 2C (2026-08-19) : revalidation COMPLÈTE des règles au moment
    // de l'écriture — jamais une confiance dans ce que le frontend a affiché (§9/§15 du cahier des
    // charges). Même résolution que getFicheEtudiant, réexécutée ici pour ne jamais diverger.
    // Remplace l'ancien blocage "une seule remise par étudiant/année" par un blocage PAR ARTICLE.
    const accessoiresEligibles = await getAccessoiresEligibles(client, {
      etudiantId: etudiant_id,
      niveauLibelle: niveauNom,
      anneeAcademiqueId,
      emplacementStockId,
    });
    const eligiblesParAccessoire = new Map(accessoiresEligibles.map((a) => [a.accessoire_id, a]));

    for (const ligne of lignes) {
      const eligible = eligiblesParAccessoire.get(ligne.accessoire_id);
      if (!eligible) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `Aucune règle de distribution active ne couvre l'accessoire #${ligne.accessoire_id} pour le niveau de cet étudiant, pour cette année académique.`,
        });
      }
      if (eligible.etat === 'deja_distribue') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          message: `« ${eligible.accessoire_nom} » a déjà été distribué gratuitement à cet étudiant (reçu ${eligible.deja_distribue_numero_recu}).`,
        });
      }
      if (eligible.etat === 'indisponible') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `Stock insuffisant pour « ${eligible.accessoire_nom} » (disponible : ${eligible.stock_disponible}, requis : ${eligible.quantite_standard}).`,
        });
      }
    }

    const siteResult = await client.query('SELECT nom FROM site WHERE id = $1', [siteId]);
    const siteNom = siteResult.rows[0]?.nom ?? null;
    const numeroRecu = `REM-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    let distributionId;
    try {
      const distributionResult = await client.query(
        `INSERT INTO distribution (etudiant_id, annee_academique_id, agent_id, emplacement_stock_id, numero_recu,
           ecole_nom, filiere_nom, niveau_nom, classe_nom, site_nom)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [etudiant_id, anneeAcademiqueId, req.user.id, emplacementStockId, numeroRecu,
          ecoleNom, filiereNom, niveauNom, classeNom, siteNom]
      );
      distributionId = distributionResult.rows[0].id;
    } catch (erreurEcriture) {
      await client.query('ROLLBACK');
      if (erreurEcriture.code === '23505') {
        return res.status(409).json({ success: false, message: 'Conflit lors de la création du reçu — merci de réessayer.' });
      }
      throw erreurEcriture;
    }

    try {
      for (const ligne of lignes) {
        const eligible = eligiblesParAccessoire.get(ligne.accessoire_id);
        // SEUL point d'écriture sur le grand-livre — jamais d'INSERT direct sur mouvement_stock.
        // Le verrou FOR UPDATE posé dans enregistrerMouvementStock (Phase 2C, correction §G5) est
        // le filet de sécurité définitif contre une course concurrente sur le dernier exemplaire —
        // la vérification eligible.etat ci-dessus n'est qu'une pré-validation ergonomique.
        await enregistrerMouvementStock(client, {
          accessoireId: ligne.accessoire_id,
          emplacementStockId,
          type: 'distribution',
          quantite: eligible.quantite_standard,
          referenceType: 'distribution',
          referenceId: distributionId,
          effectuePar: req.user.id,
          motif: `Remise à l'étudiant #${etudiant_id} — reçu ${numeroRecu}`,
        });
        // etudiant_id/annee_academique_id dénormalisés (migration 032) : c'est cette ligne, pas
        // plus l'en-tête distribution, qui porte désormais la garantie "jamais deux fois
        // gratuitement" (index unique ligne_distribution_unique_gratuit — filet de sécurité
        // définitif contre une course concurrente sur le MÊME étudiant/accessoire, cf. handler
        // 23505 ci-dessous).
        await client.query(
          `INSERT INTO ligne_distribution (distribution_id, accessoire_id, quantite, etudiant_id, annee_academique_id, regle_distribution_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [distributionId, ligne.accessoire_id, eligible.quantite_standard, etudiant_id, anneeAcademiqueId, eligible.regle_id]
        );
      }
    } catch (erreurMetier) {
      await client.query('ROLLBACK');
      if (erreurMetier.code === '23505') {
        return res.status(409).json({
          success: false,
          message: 'Un ou plusieurs accessoires sélectionnés viennent d\'être distribués par une autre opération concurrente — veuillez rouvrir la fiche de l\'étudiant.',
        });
      }
      return res.status(400).json({ success: false, message: erreurMetier.message });
    }

    await client.query('COMMIT');
    const detail = await getDistributionDetail(db, distributionId, siteId);
    res.status(201).json({ success: true, data: detail });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur creerDistribution:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};
