// controllers/dashboardController.js
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

exports.getDashboardStats = async (req, res) => {
  const { anneeAcademiqueId } = req.query;
  const departementId = req.user.departement_id;
  const ecoleId = getEcoleScopeFromUser(req);

  // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site_id existant. Sous forme
  // de sous-requête IN plutôt qu'un JOIN, pour ne pas toucher aux alias/FROM hétérogènes des 13
  // requêtes ci-dessous (certaines n'aliasent pas `etudiant`, d'autres si, une alias déjà
  // `filiere` en `f`). Vue globale (ecoleId === null) : fragments vides, comportement inchangé.
  const ecoleParams = ecoleId !== null ? [ecoleId] : [];
  const ecoleCondAliasE = ecoleId !== null
    ? 'AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3)'
    : '';
  const ecoleCondNoAlias = ecoleId !== null
    ? 'AND id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3)'
    : '';
  const ecoleCondClasse = ecoleId !== null
    ? 'AND c.filiere_id IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3)'
    : '';

  try {
    const results = {};

    // ✅ PERF : les 13 requêtes ci-dessous sont indépendantes (aucune ne lit le résultat d'une
    // autre — toutes filtrent seulement par anneeAcademiqueId/departementId). Elles sont lancées
    // en parallèle via Promise.all au lieu d'être enchaînées séquentiellement, pour ne payer
    // qu'une seule fois la latence réseau vers la base au lieu de 13. Texte SQL, paramètres et
    // assignation à `results` strictement inchangés.
    const [
      nbEtudiants,
      repartitionStatut,
      enAttente,
      scolariteTotale,
      scolariteVersee,
      totalReduction,
      totalRestant,
      nbClasses,
      totalKits,
      nbKits,
      nbPrisesEnCharge,
      repartitionFiliere,
      repartitionCurcus,
      repartitionStanding,
    ] = await Promise.all([
      // 1. Nombre d'étudiants inscrits
      // ✅ vue_position_academique (pas `etudiant` directement) : un étudiant réinscrit vers une
      // année suivante ne doit pas disparaître des effectifs de l'année qu'il vient de quitter —
      // etudiant.annee_academique_id n'est qu'une position COURANTE, écrasée à la réinscription.
      db.query(`
        SELECT COUNT(*) AS total
        FROM vue_position_academique
        WHERE annee_academique_id = $1 AND site_id = $2 AND standing = 'Inscrit' ${ecoleCondNoAlias}
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 2. Répartition par statut scolaire
      db.query(`
        SELECT statut_scolaire, COUNT(*) AS total
        FROM vue_position_academique
        WHERE annee_academique_id = $1 AND site_id = $2 AND standing = 'Inscrit' ${ecoleCondNoAlias}
        GROUP BY statut_scolaire
        ORDER BY statut_scolaire
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 2b. Nombre d'étudiants en attente
      db.query(`
        SELECT COUNT(*) AS total
        FROM vue_position_academique
        WHERE annee_academique_id = $1 AND site_id = $2 AND standing = 'en attente' ${ecoleCondNoAlias}
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 3. Montant total scolarité
      // ✅ vue_position_academique (montant_scolarite déjà correct par branche — live pour l'année
      // courante, figé depuis historique_inscription pour une année déjà quittée) au lieu de
      // etudiant JOIN scolarite : scolarite_id est un pointeur COURANT, réécrit à chaque
      // réinscription, qui ne retrouve plus rien pour une année déjà quittée.
      db.query(`
        SELECT COALESCE(SUM(e.montant_scolarite), 0) AS total
        FROM vue_position_academique e
        WHERE e.annee_academique_id = $1
          AND e.site_id = $2
          AND e.standing = 'Inscrit'
          ${ecoleCondAliasE}
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 4. Montant total réellement versé
      // ✅ Filtre sur p.annee_academique_id (l'année RÉELLE du paiement, jamais modifiée) au lieu
      // de e.annee_academique_id (position courante de l'étudiant) — sans ce correctif, un
      // paiement fait en 2025-2026 par un étudiant depuis réinscrit se comptait dans les totaux de
      // 2026-2027, jamais dans ceux de 2025-2026.
      db.query(`
        SELECT COALESCE(SUM(p.montant), 0) AS total
        FROM paiement p
        JOIN etudiant e ON e.id = p.etudiant_id
        WHERE p.annee_academique_id = $1
          AND e.site_id = $2
          AND e.standing = 'Inscrit'
          ${ecoleCondAliasE}
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 5. Montant total réduction (info statistique seulement)
      // ✅ Filtre sur r.annee_academique_id (capturé à la création de la prise en charge, jamais
      // déduit) au lieu de la position courante de l'étudiant. Les prises en charge antérieures à
      // ce correctif (annee_academique_id NULL) ne sont volontairement rattachées à aucune année —
      // aucune heuristique sur date_demande/date_validation.
      db.query(`
        SELECT COALESCE(SUM(r.montant_reduction), 0) AS total
        FROM prise_en_charge r
        JOIN etudiant e ON r.etudiant_id = e.id
        WHERE r.annee_academique_id = $1
          AND e.site_id = $2
          AND r.statut = 'valide'
          ${ecoleCondAliasE}
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // ✅ 6. Montant restant OFFICIEL (corrigé) — même correctif que la requête 3.
      db.query(`
        SELECT COALESCE(SUM(e.scolarite_restante), 0) AS total
        FROM vue_position_academique e
        WHERE e.annee_academique_id = $1
          AND e.site_id = $2
          AND e.standing = 'Inscrit'
          ${ecoleCondAliasE}
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 7. Nombre de classes
      // Chantier 6 (2026-08-01) : un INNER JOIN groupe excluait toute classe dont aucun étudiant
      // n'a encore de groupe — comptage passé directement par `classe`, avec deux branches
      // (étudiants déjà groupés, inchangé ; étudiants sans groupe correspondant aux critères de
      // la classe, nouveau/additif) — même raisonnement que classes.controller.js.
      // ✅ vue_position_academique dans les deux EXISTS : une classe d'une année déjà quittée par
      // tous ses étudiants (réinscrits vers l'année suivante) ne doit pas disparaître du décompte.
      db.query(`
        SELECT COUNT(DISTINCT c.id) AS total_classes
        FROM classe c
        WHERE c.annee_academique_id = $1
        AND (
          EXISTS (
            SELECT 1 FROM vue_position_academique e
            JOIN groupe g ON g.id = e.groupe_id
            WHERE g.classe_id = c.id AND e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
          )
          OR EXISTS (
            SELECT 1 FROM vue_position_academique e2
            WHERE e2.groupe_id IS NULL
              AND e2.id_filiere = c.filiere_id AND e2.niveau_id = c.niveau_id
              AND e2.annee_academique_id = c.annee_academique_id
              AND e2.curcus_id IS NOT DISTINCT FROM c.curcus_id
              AND e2.site_id = $2 AND e2.standing = 'Inscrit'
          )
        )
        ${ecoleCondClasse}
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 8. Montant total kits perçus
      // ✅ Filtre sur k.annee_academique_id (déjà capturé, immuable, à la création du kit) au lieu
      // de la position courante de l'étudiant. Les kits antérieurs à cette capture (annee_id NULL)
      // restent volontairement hors de tout total par année — aucune déduction par date.
      db.query(`
        SELECT COALESCE(SUM(k.montant), 0) AS total
        FROM kit k
        JOIN etudiant e ON k.etudiant_id = e.id
        WHERE k.annee_academique_id = $1 AND e.site_id = $2 AND k.deposer = true
        ${ecoleCondAliasE}
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 9. Nombre total de kits
      db.query(`
        SELECT COUNT(*) AS total
        FROM kit k
        JOIN etudiant e ON k.etudiant_id = e.id
        WHERE k.annee_academique_id = $1 AND e.site_id = $2 AND k.deposer = true
        ${ecoleCondAliasE}
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 10. Nombre total de prises en charge valides
      db.query(`
        SELECT COUNT(*) AS total
        FROM prise_en_charge r
        JOIN etudiant e ON r.etudiant_id = e.id
        WHERE r.annee_academique_id = $1
          AND e.site_id = $2
          AND r.statut = 'valide'
          ${ecoleCondAliasE}
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 11. Répartition par filière
      db.query(`
        SELECT f.nom AS filiere, COUNT(e.id) AS total
        FROM vue_position_academique e
        JOIN filiere f ON e.id_filiere = f.id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
          ${ecoleCondAliasE}
        GROUP BY f.nom
        ORDER BY f.nom
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 12. Répartition par cursus
      db.query(`
        SELECT c.type_parcours AS curcus, COUNT(e.id) AS total
        FROM vue_position_academique e
        JOIN curcus c ON e.curcus_id = c.id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
          ${ecoleCondAliasE}
        GROUP BY c.type_parcours
        ORDER BY c.type_parcours
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),

      // 13. Répartition par standing
      db.query(`
        SELECT standing, COUNT(*) AS total
        FROM vue_position_academique
        WHERE annee_academique_id = $1 AND site_id = $2 ${ecoleCondNoAlias}
        GROUP BY standing
        ORDER BY standing
      `, [anneeAcademiqueId, departementId, ...ecoleParams]),
    ]);

    results.totalEtudiants = parseInt(nbEtudiants.rows[0].total);
    results.repartitionStatut = repartitionStatut.rows;
    results.totalAffectes = repartitionStatut.rows.find(row => row.statut_scolaire === 'Affecté')?.total || 0;
    results.totalNonAffectes = repartitionStatut.rows.find(row => row.statut_scolaire === 'Non affecté')?.total || 0;
    results.totalEnAttente = parseInt(enAttente.rows[0].total);
    results.totalScolarite = parseFloat(scolariteTotale.rows[0].total);
    results.totalVerse = parseFloat(scolariteVersee.rows[0].total);
    results.totalReduction = parseFloat(totalReduction.rows[0].total);
    results.totalRestant = parseFloat(totalRestant.rows[0].total);
    results.totalClasses = parseInt(nbClasses.rows[0].total_classes);
    results.totalKits = parseFloat(totalKits.rows[0].total);
    results.nbKits = parseInt(nbKits.rows[0].total);
    results.nbPrisesEnCharge = parseInt(nbPrisesEnCharge.rows[0].total);
    results.repartitionFiliere = repartitionFiliere.rows;
    results.repartitionCurcus = repartitionCurcus.rows;
    results.repartitionStanding = repartitionStanding.rows;

    console.log('Statistiques calculées:', results);
    res.json(results);

  } catch (error) {
    console.error('Erreur détaillée:', error);
    res.status(500).json({ 
      message: 'Erreur serveur',
      error: error.message 
    });
  }
};
