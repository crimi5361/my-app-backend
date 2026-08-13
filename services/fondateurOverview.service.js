// Agrégation "vue d'ensemble" du site du Fondateur — extraite de
// dashboardFondateur.controller.js (Chantier Assistant IA, 2026-08-07) pour être réutilisée à la
// fois par le Dashboard Fondateur (affichage) et par les outils (function calling) de l'Assistant
// Fondateur, sans dupliquer les requêtes ni les règles de cloisonnement (site + école).
//
// Comportement et résultat strictement identiques à l'ancien contenu de
// dashboardFondateur.controller.js — voir ce fichier pour l'historique des décisions
// (re-scoping par site, retrait de la répartition par site, etc.).
const {
  getEmplacementStockPourSite, getSoldesStockParEmplacement, getEtudiantsServis, getEvolutionDistributionsMensuelle,
} = require('./stockMoyensGeneraux.service');

async function getFondateurOverview(db, { anneeAcademiqueId, siteId, ecoleId }) {
  const ecoleCondEtudiant = ecoleId !== null
    ? 'AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3)'
    : '';
  const etudiantParams = ecoleId !== null ? [anneeAcademiqueId, siteId, ecoleId] : [anneeAcademiqueId, siteId];

  const ecoleCondPaiement = ecoleId !== null
    ? 'AND p.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3))'
    : '';
  const paiementParams = ecoleId !== null ? [anneeAcademiqueId, siteId, ecoleId] : [anneeAcademiqueId, siteId];

  const caissesParams = ecoleId !== null ? [siteId, ecoleId] : [siteId];

  const emplacementStockId = await getEmplacementStockPourSite(db, siteId);

  const [
    etudiantsResult,
    inscriptionsResult,
    parStatutScolaireResult,
    parCursusResult,
    parEcoleResult,
    parFiliereResult,
    parNiveauResult,
    evolutionResult,
    financeResult,
    evolutionFinanceResult,
    pecResult,
    caissesResult,
    moyensGenerauxEtudiantsServis,
    moyensGenerauxEtatStock,
    moyensGenerauxEvolution,
  ] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE e.standing = 'Inscrit') AS total_inscrits,
        COUNT(*) FILTER (WHERE e.standing = 'en attente') AS total_en_attente,
        COUNT(*) AS total_general
      FROM vue_position_academique e WHERE e.annee_academique_id = $1 AND e.site_id = $2 ${ecoleCondEtudiant}
    `, etudiantParams),

    db.query(`
      SELECT
        COUNT(*) AS total_annee,
        COUNT(*) FILTER (WHERE e.date_inscription::date = CURRENT_DATE) AS aujourd_hui,
        COUNT(*) FILTER (WHERE e.date_inscription::date >= date_trunc('week', CURRENT_DATE)) AS cette_semaine,
        COUNT(*) FILTER (WHERE e.date_inscription::date >= date_trunc('month', CURRENT_DATE)) AS ce_mois
      FROM vue_position_academique e WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCondEtudiant}
    `, etudiantParams),

    db.query(`
      SELECT COALESCE(e.statut_scolaire, 'Non défini') AS statut, COUNT(*) AS total
      FROM vue_position_academique e
      WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCondEtudiant}
      GROUP BY COALESCE(e.statut_scolaire, 'Non défini')
    `, etudiantParams),

    db.query(`
      SELECT c.type_parcours AS cursus, COUNT(*) AS total
      FROM vue_position_academique e JOIN curcus c ON c.id = e.curcus_id
      WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCondEtudiant}
      GROUP BY c.type_parcours ORDER BY total DESC
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

    db.query(`
      SELECT e.date_inscription::date AS jour, COUNT(*) AS total
      FROM vue_position_academique e
      WHERE e.annee_academique_id = $1 AND e.site_id = $2
        AND e.date_inscription::date BETWEEN CURRENT_DATE - INTERVAL '29 days' AND CURRENT_DATE ${ecoleCondEtudiant}
      GROUP BY e.date_inscription::date ORDER BY jour
    `, etudiantParams),

    db.query(`
      SELECT
        COALESCE(SUM(e.montant_scolarite), 0) AS total_scolarite,
        COALESCE(SUM(e.scolarite_verse), 0) AS total_verse,
        COALESCE(SUM(e.scolarite_restante), 0) AS total_restant
      FROM vue_position_academique e
      WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCondEtudiant}
    `, etudiantParams),

    db.query(`
      SELECT date_trunc('month', p.date_paiement) AS mois, COALESCE(SUM(p.montant), 0) AS total
      FROM paiement p JOIN caisse c ON c.id = p.caisse_id
      WHERE p.annee_academique_id = $1 AND c.site_id = $2 ${ecoleCondPaiement}
      GROUP BY date_trunc('month', p.date_paiement) ORDER BY mois
    `, paiementParams),

    db.query(`
      SELECT COALESCE(SUM(p.montant_reduction), 0) AS total, COUNT(*) AS nombre
      FROM prise_en_charge p JOIN etudiant e ON e.id = p.etudiant_id
      WHERE p.statut = 'valide' AND p.annee_academique_id = $1 AND e.site_id = $2 ${ecoleCondEtudiant}
    `, etudiantParams),

    db.query(`
      SELECT
        (SELECT COUNT(*) FROM caisse c WHERE c.site_id = $1) AS nb_caisses,
        (SELECT COUNT(*) FROM session_caisse sc JOIN caisse c ON c.id = sc.caisse_id
          WHERE c.site_id = $1 AND sc.statut = 'OUVERTE') AS sessions_ouvertes,
        (SELECT COALESCE(SUM(p.montant), 0) FROM paiement p JOIN caisse c ON c.id = p.caisse_id
          WHERE c.site_id = $1 AND p.date_paiement = CURRENT_DATE ${ecoleId !== null ? 'AND p.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $2))' : ''}
        ) AS encaisse_jour,
        (SELECT COALESCE(SUM(p.montant), 0) FROM paiement p JOIN caisse c ON c.id = p.caisse_id
          WHERE c.site_id = $1 AND p.date_paiement >= date_trunc('month', CURRENT_DATE) ${ecoleId !== null ? 'AND p.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $2))' : ''}
        ) AS encaisse_mois
    `, caissesParams),

    getEtudiantsServis(db, { anneeAcademiqueId, emplacementStockId, ecoleId }),
    getSoldesStockParEmplacement(db, emplacementStockId),
    getEvolutionDistributionsMensuelle(db, { anneeAcademiqueId, emplacementStockId, ecoleId }),
  ]);

  const totalInscrits = parseInt(etudiantsResult.rows[0].total_inscrits, 10);
  const etudiantsRestants = Math.max(totalInscrits - moyensGenerauxEtudiantsServis, 0);
  const tauxCouverture = totalInscrits > 0 ? Math.round((moyensGenerauxEtudiantsServis / totalInscrits) * 100) : 0;

  const nbReferences = moyensGenerauxEtatStock.length;
  const nbRupture = moyensGenerauxEtatStock.filter((a) => a.statut === 'rupture').length;
  const nbStockFaible = moyensGenerauxEtatStock.filter((a) => a.statut === 'stock_faible').length;
  const valeurTotaleStock = moyensGenerauxEtatStock.reduce((somme, a) => somme + (a.valeur_estimee ?? 0), 0);

  const alertes = moyensGenerauxEtatStock
    .filter((a) => a.en_alerte)
    .sort((a, b) => a.solde - b.solde)
    .slice(0, 5)
    .map((a) => ({ nom: a.nom, code: a.code, solde: a.solde, seuil_alerte: a.seuil_alerte, statut: a.statut }));

  return {
    etudiants: {
      total_inscrits: totalInscrits,
      total_en_attente: parseInt(etudiantsResult.rows[0].total_en_attente, 10),
      total_general: parseInt(etudiantsResult.rows[0].total_general, 10),
      par_statut_scolaire: parStatutScolaireResult.rows.map((r) => ({ statut: r.statut, total: parseInt(r.total, 10) })),
    },
    parCursus: parCursusResult.rows.map((r) => ({ cursus: r.cursus, total: parseInt(r.total, 10) })),
    inscriptions: {
      total_annee: parseInt(inscriptionsResult.rows[0].total_annee, 10),
      aujourd_hui: parseInt(inscriptionsResult.rows[0].aujourd_hui, 10),
      cette_semaine: parseInt(inscriptionsResult.rows[0].cette_semaine, 10),
      ce_mois: parseInt(inscriptionsResult.rows[0].ce_mois, 10),
    },
    parEcole: parEcoleResult.rows.map((r) => ({ ecole: r.ecole, total: parseInt(r.total, 10) })),
    parFiliere: parFiliereResult.rows.map((r) => ({ filiere: r.filiere, total: parseInt(r.total, 10) })),
    parNiveau: parNiveauResult.rows.map((r) => ({ niveau: r.niveau, total: parseInt(r.total, 10) })),
    evolutionInscriptions: evolutionResult.rows.map((r) => ({ jour: r.jour, total: parseInt(r.total, 10) })),
    finance: {
      total_scolarite: parseFloat(financeResult.rows[0].total_scolarite),
      total_verse: parseFloat(financeResult.rows[0].total_verse),
      total_restant: parseFloat(financeResult.rows[0].total_restant),
      total_pec: parseFloat(pecResult.rows[0].total),
      nombre_pec: parseInt(pecResult.rows[0].nombre, 10),
      evolution_recettes: evolutionFinanceResult.rows.map((r) => ({ mois: r.mois, total: parseFloat(r.total) })),
    },
    caisses: {
      nb_caisses: parseInt(caissesResult.rows[0].nb_caisses, 10),
      sessions_ouvertes: parseInt(caissesResult.rows[0].sessions_ouvertes, 10),
      encaisse_jour: parseFloat(caissesResult.rows[0].encaisse_jour),
      encaisse_mois: parseFloat(caissesResult.rows[0].encaisse_mois),
    },
    moyensGeneraux: {
      distribution: {
        total_inscrits: totalInscrits,
        etudiants_servis: moyensGenerauxEtudiantsServis,
        etudiants_restants: etudiantsRestants,
        taux_couverture: tauxCouverture,
      },
      stock: {
        nb_references: nbReferences,
        nb_rupture: nbRupture,
        nb_stock_faible: nbStockFaible,
        valeur_totale_estimee: Math.round(valeurTotaleStock * 100) / 100,
      },
      alertes,
      evolution_distributions: moyensGenerauxEvolution,
    },
  };
}

module.exports = { getFondateurOverview };
