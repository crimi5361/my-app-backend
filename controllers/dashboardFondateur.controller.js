// Dashboard Fondateur (Chantier 2, 2026-08-02, re-scopé par site le 2026-08-02) — pilotage
// stratégique du site du Fondateur connecté. Cahier des charges validé le 2026-08-02 : vue
// globale étudiants/inscriptions, répartitions école/filière/niveau (répartition par département
// retirée le 2026-08-02, redondante avec école ; répartition par site retirée le 2026-08-02, cf.
// note ci-dessous), évolution des inscriptions, situation financière globale (scolarité/versé/
// restant/PEC uniquement, avec graphique d'évolution des recettes sur l'année académique
// complète), vue globale caisses (sans dupliquer le détail du Dashboard Comptabilité), bloc Moyens
// Généraux (Chantier 10, sous-phase 12, 2026-08-03).
//
// Site-scopé comme tout le reste de l'application (req.user.departement_id) — revirement
// architectural assumé le 2026-08-02 : la version initiale de ce contrôleur agrégeait
// volontairement toutes les données de l'institution, au motif qu'"un Fondateur pilote
// l'institution entière". Le client a corrigé ce postulat : un Fondateur est créé PAR site et ne
// doit voir que les données de son propre site, au même titre que tous les autres rôles. Le bloc
// "répartition par site" est donc retiré (il n'aurait plus de sens une fois la vue elle-même
// limitée à un seul site). Le cloisonnement par école (Chantier 3) reste appliqué, cumulatif,
// car indépendant du site.
//
// Bloc Moyens Généraux : AUCUNE logique métier dupliquée — `getEtudiantsServis`,
// `getSoldesStockParEmplacement` et `getEvolutionDistributionsMensuelle` sont les mêmes fonctions
// de service que celles utilisées par le Dashboard Moyens Généraux (sous-phase 3/8). Le nombre
// total d'inscrits n'est PAS requêté une seconde fois : le bloc réutilise directement
// `etudiantsResult.total_inscrits`, déjà calculé ci-dessous pour le reste du dashboard.
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const {
  getEmplacementStockPourSite, getSoldesStockParEmplacement, getEtudiantsServis, getEvolutionDistributionsMensuelle,
} = require('../services/stockMoyensGeneraux.service');

exports.getDashboardFondateur = async (req, res) => {
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

    const ecoleCondPaiement = ecoleId !== null
      ? 'AND p.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3))'
      : '';
    const paiementParams = ecoleId !== null ? [anneeAcademiqueId, siteId, ecoleId] : [anneeAcademiqueId, siteId];

    const caissesParams = ecoleId !== null ? [siteId, ecoleId] : [siteId];

    // Résolu une fois, réutilisé par les 3 appels de service Moyens Généraux ci-dessous — même
    // magasin que le Dashboard Moyens Généraux pour ce site (sous-phase 2).
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

      // Situation financière globale — uniquement scolarité/versé/restant, aucun autre détail
      // comptable (pas de répartition par méthode, pas de détail par caisse : ça reste le rôle
      // du Dashboard Comptabilité).
      // ✅ vue_position_academique (montants déjà corrects par branche) au lieu de etudiant JOIN
      // scolarite : scolarite_id est un pointeur COURANT, ne retrouve plus rien pour une année déjà
      // quittée (étudiant réinscrit).
      db.query(`
        SELECT
          COALESCE(SUM(e.montant_scolarite), 0) AS total_scolarite,
          COALESCE(SUM(e.scolarite_verse), 0) AS total_verse,
          COALESCE(SUM(e.scolarite_restante), 0) AS total_restant
        FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCondEtudiant}
      `, etudiantParams),

      // Graphique principal de la section financière — évolution des recettes du site sur
      // l'ensemble de l'année académique sélectionnée (agrégation mensuelle), remplace l'ancien
      // graphique "30 derniers jours" jugé trop court pour un pilotage stratégique. Même jointure
      // caisse→site que Dashboard Comptabilité.
      db.query(`
        SELECT date_trunc('month', p.date_paiement) AS mois, COALESCE(SUM(p.montant), 0) AS total
        FROM paiement p JOIN caisse c ON c.id = p.caisse_id
        WHERE p.annee_academique_id = $1 AND c.site_id = $2 ${ecoleCondPaiement}
        GROUP BY date_trunc('month', p.date_paiement) ORDER BY mois
      `, paiementParams),

      // ✅ Filtre sur p.annee_academique_id (capturé à la création de la PEC) au lieu de la
      // position courante de l'étudiant.
      db.query(`
        SELECT COALESCE(SUM(p.montant_reduction), 0) AS total, COUNT(*) AS nombre
        FROM prise_en_charge p JOIN etudiant e ON e.id = p.etudiant_id
        WHERE p.statut = 'valide' AND p.annee_academique_id = $1 AND e.site_id = $2 ${ecoleCondEtudiant}
      `, etudiantParams),

      // Vue globale caisses du site — volontairement minimale (nombre de caisses, encaissements,
      // sessions ouvertes) : le détail par caisse/caissier reste au Dashboard Comptabilité.
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

      // Bloc Moyens Généraux (sous-phase 12) — fonctions de service partagées avec le Dashboard
      // Moyens Généraux, aucune requête réécrite ici.
      getEtudiantsServis(db, { anneeAcademiqueId, emplacementStockId, ecoleId }),
      getSoldesStockParEmplacement(db, emplacementStockId),
      getEvolutionDistributionsMensuelle(db, { anneeAcademiqueId, emplacementStockId, ecoleId }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        etudiants: {
          total_inscrits: parseInt(etudiantsResult.rows[0].total_inscrits, 10),
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
        // Moyens Généraux (sous-phase 12) — indicateurs de pilotage uniquement, aucune action de
        // gestion : cohérent avec la philosophie du reste de ce dashboard.
        moyensGeneraux: (() => {
          const totalInscrits = parseInt(etudiantsResult.rows[0].total_inscrits, 10);
          const etudiantsRestants = Math.max(totalInscrits - moyensGenerauxEtudiantsServis, 0);
          const tauxCouverture = totalInscrits > 0 ? Math.round((moyensGenerauxEtudiantsServis / totalInscrits) * 100) : 0;

          const nbReferences = moyensGenerauxEtatStock.length;
          const nbRupture = moyensGenerauxEtatStock.filter((a) => a.statut === 'rupture').length;
          const nbStockFaible = moyensGenerauxEtatStock.filter((a) => a.statut === 'stock_faible').length;
          const valeurTotaleStock = moyensGenerauxEtatStock.reduce((somme, a) => somme + (a.valeur_estimee ?? 0), 0);

          // Limité à 5 (demande explicite) — un dashboard de pilotage, pas un écran de gestion.
          const alertes = moyensGenerauxEtatStock
            .filter((a) => a.en_alerte)
            .sort((a, b) => a.solde - b.solde)
            .slice(0, 5)
            .map((a) => ({ nom: a.nom, code: a.code, solde: a.solde, seuil_alerte: a.seuil_alerte, statut: a.statut }));

          return {
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
          };
        })(),
      },
    });
  } catch (error) {
    console.error('Erreur getDashboardFondateur:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};
