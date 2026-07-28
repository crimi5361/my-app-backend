// controllers/dashboardController.js
const db = require('../config/db.config');

exports.getDashboardStats = async (req, res) => {
  const { anneeAcademiqueId } = req.query;
  const departementId = req.user.departement_id;

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
      db.query(`
        SELECT COUNT(*) AS total
        FROM etudiant
        WHERE annee_academique_id = $1 AND site_id = $2 AND standing = 'Inscrit'
      `, [anneeAcademiqueId, departementId]),

      // 2. Répartition par statut scolaire
      db.query(`
        SELECT statut_scolaire, COUNT(*) AS total
        FROM etudiant
        WHERE annee_academique_id = $1 AND site_id = $2 AND standing = 'Inscrit'
        GROUP BY statut_scolaire
        ORDER BY statut_scolaire
      `, [anneeAcademiqueId, departementId]),

      // 2b. Nombre d'étudiants en attente
      db.query(`
        SELECT COUNT(*) AS total
        FROM etudiant
        WHERE annee_academique_id = $1 AND site_id = $2 AND standing = 'en attente'
      `, [anneeAcademiqueId, departementId]),

      // 3. Montant total scolarité
      db.query(`
        SELECT COALESCE(SUM(s.montant_scolarite), 0) AS total
        FROM etudiant e
        JOIN scolarite s ON s.id = e.scolarite_id
        WHERE e.annee_academique_id = $1
          AND e.site_id = $2
          AND e.standing = 'Inscrit'
      `, [anneeAcademiqueId, departementId]),

      // 4. Montant total réellement versé
      db.query(`
        SELECT COALESCE(SUM(p.montant), 0) AS total
        FROM paiement p
        JOIN etudiant e ON e.id = p.etudiant_id
        WHERE e.annee_academique_id = $1
          AND e.site_id = $2
          AND e.standing = 'Inscrit'
      `, [anneeAcademiqueId, departementId]),

      // 5. Montant total réduction (info statistique seulement)
      db.query(`
        SELECT COALESCE(SUM(r.montant_reduction), 0) AS total
        FROM prise_en_charge r
        JOIN etudiant e ON r.etudiant_id = e.id
        WHERE e.annee_academique_id = $1
          AND e.site_id = $2
          AND e.standing = 'Inscrit'
          AND r.statut = 'valide'
      `, [anneeAcademiqueId, departementId]),

      // ✅ 6. Montant restant OFFICIEL (corrigé)
      db.query(`
        SELECT COALESCE(SUM(s.scolarite_restante), 0) AS total
        FROM etudiant e
        JOIN scolarite s ON s.id = e.scolarite_id
        WHERE e.annee_academique_id = $1
          AND e.site_id = $2
          AND e.standing = 'Inscrit'
      `, [anneeAcademiqueId, departementId]),

      // 7. Nombre de classes
      db.query(`
        SELECT COUNT(DISTINCT c.id) AS total_classes
        FROM etudiant e
        JOIN groupe g ON e.groupe_id = g.id
        JOIN classe c ON g.classe_id = c.id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
      `, [anneeAcademiqueId, departementId]),

      // 8. Montant total kits perçus
      db.query(`
        SELECT COALESCE(SUM(k.montant), 0) AS total
        FROM kit k
        JOIN etudiant e ON k.etudiant_id = e.id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' AND k.deposer = true
      `, [anneeAcademiqueId, departementId]),

      // 9. Nombre total de kits
      db.query(`
        SELECT COUNT(*) AS total
        FROM kit k
        JOIN etudiant e ON k.etudiant_id = e.id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' AND k.deposer = true
      `, [anneeAcademiqueId, departementId]),

      // 10. Nombre total de prises en charge valides
      db.query(`
        SELECT COUNT(*) AS total
        FROM prise_en_charge r
        JOIN etudiant e ON r.etudiant_id = e.id
        WHERE e.annee_academique_id = $1
          AND e.site_id = $2
          AND e.standing = 'Inscrit'
          AND r.statut = 'valide'
      `, [anneeAcademiqueId, departementId]),

      // 11. Répartition par filière
      db.query(`
        SELECT f.nom AS filiere, COUNT(e.id) AS total
        FROM etudiant e
        JOIN filiere f ON e.id_filiere = f.id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
        GROUP BY f.nom
        ORDER BY f.nom
      `, [anneeAcademiqueId, departementId]),

      // 12. Répartition par cursus
      db.query(`
        SELECT c.type_parcours AS curcus, COUNT(e.id) AS total
        FROM etudiant e
        JOIN curcus c ON e.curcus_id = c.id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
        GROUP BY c.type_parcours
        ORDER BY c.type_parcours
      `, [anneeAcademiqueId, departementId]),

      // 13. Répartition par standing
      db.query(`
        SELECT standing, COUNT(*) AS total
        FROM etudiant
        WHERE annee_academique_id = $1 AND site_id = $2
        GROUP BY standing
        ORDER BY standing
      `, [anneeAcademiqueId, departementId]),
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
