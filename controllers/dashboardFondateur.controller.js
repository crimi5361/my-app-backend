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
// `totalInscrits`, déjà calculé ci-dessous pour le reste du dashboard.
//
// ✅ Chantier Statistiques & Dashboards (2026-08-18) : "Étudiants inscrits", "admissions/
// réinscriptions validées", l'évolution quotidienne des inscriptions et celle des recettes
// viennent désormais de services/statistiquesInscriptions.service.js — source unique, réutilisée
// à l'identique par les dashboards Scolarité et Administrateur (ne plus dupliquer ces requêtes ici
// si un nouveau bloc du même type est ajouté).
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const {
  getEmplacementStockPourSite, getSoldesStockParEmplacement, getEtudiantsServis, getEvolutionDistributionsMensuelle,
} = require('../services/stockMoyensGeneraux.service');
const { getDossiersEnAttenteParOrigine } = require('../services/dossiersEnAttente.service');
const {
  getTotalInscrits, getInscriptionsValidees, getInscriptionsValideesPeriodes,
  getEvolutionInscriptionsQuotidienne, getEvolutionRecettesQuotidienne,
} = require('../services/statistiquesInscriptions.service');
const { getStatistiquesKit } = require('../services/kitStatistiques.service');

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

    const caissesParams = ecoleId !== null ? [siteId, ecoleId] : [siteId];

    // Résolu une fois, réutilisé par les 3 appels de service Moyens Généraux ci-dessous — même
    // magasin que le Dashboard Moyens Généraux pour ce site (sous-phase 2).
    const emplacementStockId = await getEmplacementStockPourSite(db, siteId);

    const [
      totalInscrits,
      inscriptionsValidees,
      inscriptionsPeriodes,
      parStatutScolaireResult,
      parCursusResult,
      parEcoleResult,
      parFiliereResult,
      parNiveauResult,
      evolutionInscriptions,
      financeResult,
      evolutionRecettes,
      pecResult,
      caissesResult,
      moyensGenerauxEtudiantsServis,
      moyensGenerauxEtatStock,
      moyensGenerauxEvolution,
      dossiersEnAttente,
      statistiquesKit,
    ] = await Promise.all([
      // ✅ Chantier Statistiques (2026-08-18) : source unique — voir
      // services/statistiquesInscriptions.service.js. Remplace l'ancien COUNT(*) sur
      // vue_position_academique.standing (KPI "Étudiants inscrits") et l'ancien bloc
      // "inscriptions" basé sur etudiant.date_inscription (date de CRÉATION du dossier, jamais la
      // date de finalisation caisse) par historique_inscription.created_at.
      getTotalInscrits(db, { siteId, ecoleId, anneeAcademiqueId }),
      getInscriptionsValidees(db, { siteId, ecoleId, anneeAcademiqueId }),
      getInscriptionsValideesPeriodes(db, { siteId, ecoleId, anneeAcademiqueId }),

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

      // Évolution quotidienne des inscriptions VALIDÉES (admissions + réinscriptions), depuis le
      // 1er jour de l'année académique sélectionnée pour ce site — remplace l'ancienne fenêtre
      // "30 derniers jours" basée sur etudiant.date_inscription (date de création du dossier, pas
      // de finalisation caisse).
      getEvolutionInscriptionsQuotidienne(db, { siteId, ecoleId, anneeAcademiqueId }),

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

      // Graphique principal de la section financière — évolution QUOTIDIENNE des recettes du site
      // sur l'ensemble de l'année académique sélectionnée (remplace l'agrégation mensuelle :
      // demande explicite 2026-08-18, cohérent avec le graphique quotidien déjà utilisé par le
      // Dashboard Comptabilité). Source paiement.date_paiement, inchangée.
      getEvolutionRecettesQuotidienne(db, { siteId, ecoleId, anneeAcademiqueId }),

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

      // Visibilité des dossiers en attente (admissions + réinscriptions), même définition/périmètre
      // que le dashboard Caisse — voir services/dossiersEnAttente.service.js.
      getDossiersEnAttenteParOrigine(db, { siteId, ecoleId, anneeAcademiqueId }),

      // Chantier Kit étudiant — Phase statistiques (2026-08-21) : source unique, voir
      // services/kitStatistiques.service.js — réutilisée à l'identique par les 3 autres dashboards.
      getStatistiquesKit(db, { siteId, anneeAcademiqueId, ecoleId }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        etudiants: {
          total_inscrits: totalInscrits,
          total_en_attente: dossiersEnAttente.admissions.total,
          admissions_validees: inscriptionsValidees.admissions,
          reinscriptions_validees: inscriptionsValidees.reinscriptions,
          par_statut_scolaire: parStatutScolaireResult.rows.map((r) => ({ statut: r.statut, total: parseInt(r.total, 10) })),
        },
        parCursus: parCursusResult.rows.map((r) => ({ cursus: r.cursus, total: parseInt(r.total, 10) })),
        inscriptions: {
          total_annee: inscriptionsPeriodes.total_annee,
          aujourd_hui: inscriptionsPeriodes.aujourd_hui,
          cette_semaine: inscriptionsPeriodes.cette_semaine,
          ce_mois: inscriptionsPeriodes.ce_mois,
        },
        parEcole: parEcoleResult.rows.map((r) => ({ ecole: r.ecole, total: parseInt(r.total, 10) })),
        parFiliere: parFiliereResult.rows.map((r) => ({ filiere: r.filiere, total: parseInt(r.total, 10) })),
        parNiveau: parNiveauResult.rows.map((r) => ({ niveau: r.niveau, total: parseInt(r.total, 10) })),
        // ⚠️ Changement de forme (2026-08-18) : {jour, admissions, reinscriptions, total} par jour
        // depuis le 1er jour de l'année académique, au lieu de {jour, total} sur 30 jours glissants.
        evolutionInscriptions,
        finance: {
          total_scolarite: parseFloat(financeResult.rows[0].total_scolarite),
          total_verse: parseFloat(financeResult.rows[0].total_verse),
          total_restant: parseFloat(financeResult.rows[0].total_restant),
          total_pec: parseFloat(pecResult.rows[0].total),
          nombre_pec: parseInt(pecResult.rows[0].nombre, 10),
          // ⚠️ Changement de forme (2026-08-18) : {jour, total} quotidien au lieu de {mois, total}
          // mensuel — le frontend devra adapter dataKey="mois" → dataKey="jour" (Phase frontend).
          evolution_recettes: evolutionRecettes,
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
        // Ajout — visibilité des dossiers en attente de paiement (admissions + réinscriptions),
        // même définition que le dashboard Caisse, avec répartition par origine (source_inscription).
        dossiersEnAttente,
        // Chantier Kit étudiant — Phase statistiques (2026-08-21) — voir
        // services/kitStatistiques.service.js.
        kit: statistiquesKit,
      },
    });
  } catch (error) {
    console.error('Erreur getDashboardFondateur:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};
