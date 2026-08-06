// Dashboard Moyens Généraux (Chantier 10, 2026-08-02, sous-phase 3) — pilotage du module de
// gestion du stock et de la distribution des accessoires institutionnels.
//
// Conçu pour être utile dès cette sous-phase, avant même que les fonctionnalités métier
// (catalogue, fournisseurs, distribution...) n'existent : les indicateurs académiques (étudiants
// inscrits, répartitions école/filière/niveau) sont des données réelles, disponibles dès
// aujourd'hui. Les indicateurs propres au module (accessoires distribués, état du stock, alertes,
// mouvements récents) sont de VRAIES requêtes contre les tables du Chantier 10 — elles renvoient
// honnêtement 0/vide tant qu'aucune donnée n'a été saisie (aucune valeur inventée), et
// s'activeront automatiquement au fil des sous-phases suivantes sans modification de ce fichier.
//
// Site-scopé (req.user.departement_id) + école-scopé (Chantier 3, cumulatif), comme tous les
// dashboards de l'Étape 2.
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const { getEmplacementStockPourSite, getSoldesStockParEmplacement, getEtudiantsServis } = require('../services/stockMoyensGeneraux.service');

exports.getDashboardMoyensGeneraux = async (req, res) => {
  try {
    const { anneeAcademiqueId } = req.query;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }

    const ecoleCondEtudiant = ecoleId !== null
      ? 'AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3)'
      : '';
    const etudiantParams = ecoleId !== null ? [anneeAcademiqueId, siteId, ecoleId] : [anneeAcademiqueId, siteId];

    // La distribution n'a pas de lien direct vers filiere/departement/ecole — cloisonnement école
    // via l'étudiant, même principe que les paiements (Dashboard Comptabilité/Fondateur).
    const ecoleCondDistribution = ecoleId !== null
      ? 'AND d.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3))'
      : '';

    const emplacementStockId = await getEmplacementStockPourSite(db, siteId);

    const [
      etudiantsResult,
      parEcoleResult,
      parFiliereResult,
      parNiveauResult,
      etudiantsServis,
      repartitionAccessoiresResult,
      mouvementsRecentsResult,
      etatStock,
    ] = await Promise.all([
      db.query(`
        SELECT COUNT(*) AS total FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCondEtudiant}
      `, etudiantParams),

      db.query(`
        SELECT ec.nom AS ecole, COUNT(*) AS total
        FROM vue_position_academique e JOIN filiere f ON f.id = e.id_filiere
        JOIN departement d ON d.id = f.departement_id JOIN ecole ec ON ec.id = d.ecole_id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCondEtudiant}
        GROUP BY ec.nom ORDER BY total DESC
      `, etudiantParams),

      db.query(`
        SELECT f.nom AS filiere, COUNT(*) AS total
        FROM vue_position_academique e JOIN filiere f ON f.id = e.id_filiere
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCondEtudiant}
        GROUP BY f.nom ORDER BY total DESC LIMIT 10
      `, etudiantParams),

      db.query(`
        SELECT n.libelle AS niveau, COUNT(*) AS total
        FROM vue_position_academique e JOIN niveau n ON n.id = e.niveau_id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCondEtudiant}
        GROUP BY n.libelle ORDER BY total DESC
      `, etudiantParams),

      // Partagée avec le Dashboard Fondateur (sous-phase 12) — une seule définition dans
      // stockMoyensGeneraux.service.js, jamais dupliquée.
      getEtudiantsServis(db, { anneeAcademiqueId, emplacementStockId, ecoleId }),

      db.query(`
        SELECT a.nom AS accessoire, COALESCE(SUM(ld.quantite), 0) AS total
        FROM distribution d
        JOIN ligne_distribution ld ON ld.distribution_id = d.id
        JOIN accessoire a ON a.id = ld.accessoire_id
        WHERE d.annee_academique_id = $1 AND d.emplacement_stock_id = $2 ${ecoleCondDistribution}
        GROUP BY a.nom ORDER BY total DESC
      `, ecoleId !== null ? [anneeAcademiqueId, emplacementStockId, ecoleId] : [anneeAcademiqueId, emplacementStockId]),

      db.query(`
        SELECT m.type, m.quantite, m.date_mouvement, a.nom AS accessoire, u.nom AS effectue_par
        FROM mouvement_stock m
        JOIN accessoire a ON a.id = m.accessoire_id
        JOIN utilisateur u ON u.id = m.effectue_par
        WHERE m.emplacement_stock_id = $1
        ORDER BY m.date_mouvement DESC LIMIT 10
      `, [emplacementStockId]),

      getSoldesStockParEmplacement(db, emplacementStockId),
    ]);

    const totalInscrits = parseInt(etudiantsResult.rows[0].total, 10);
    const etudiantsRestants = Math.max(totalInscrits - etudiantsServis, 0);
    const tauxCouverture = totalInscrits > 0 ? Math.round((etudiantsServis / totalInscrits) * 100) : 0;

    res.status(200).json({
      success: true,
      data: {
        etudiants: {
          total_inscrits: totalInscrits,
          par_ecole: parEcoleResult.rows.map((r) => ({ ecole: r.ecole, total: parseInt(r.total, 10) })),
          par_filiere: parFiliereResult.rows.map((r) => ({ filiere: r.filiere, total: parseInt(r.total, 10) })),
          par_niveau: parNiveauResult.rows.map((r) => ({ niveau: r.niveau, total: parseInt(r.total, 10) })),
        },
        distribution: {
          etudiants_servis: etudiantsServis,
          etudiants_restants: etudiantsRestants,
          taux_couverture: tauxCouverture,
          repartition_par_accessoire: repartitionAccessoiresResult.rows.map((r) => ({ accessoire: r.accessoire, total: parseInt(r.total, 10) })),
        },
        stock: {
          etat: etatStock,
          alertes: etatStock.filter((s) => s.en_alerte),
        },
        mouvementsRecents: mouvementsRecentsResult.rows.map((m) => ({
          type: m.type,
          quantite: m.quantite,
          date: m.date_mouvement,
          accessoire: m.accessoire,
          effectue_par: m.effectue_par,
        })),
      },
    });
  } catch (error) {
    console.error('Erreur getDashboardMoyensGeneraux:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};
